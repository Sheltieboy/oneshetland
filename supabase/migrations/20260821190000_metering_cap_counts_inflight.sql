-- ============================================================================
-- The cap has to count work in flight, not just work finished.
--
-- 20260821180000 added the claim, and the two-connection concurrency test found
-- it wrong on the first run:
--
--   worker A claimed 17     worker B claimed 3     overlap 0     total 20
--
-- The advisory lock did its job — neither worker took the same booking — but
-- the cap was still breached by three. The count behind `remaining` only looked
-- at metering_state = 'reported', and A's seventeen claims were sitting in
-- 'reporting'. B looked, saw nothing billed yet, and concluded the whole
-- allowance was still available.
--
-- Serialising the claim is not the same as accounting for it. A booking that is
-- claimed is spoken for, whether or not Stripe has answered.
--
-- So 'reporting' and 'unresolved' now count against the allowance too:
--
--   reported     billed
--   reporting    claimed, Stripe call in flight — will probably be billed
--   unresolved   may already have been billed; counting it is the safe error
--   pending      not spoken for
--   skipped      deliberately never billed, so it must NOT consume allowance
--
-- WHICH CREATES A SECOND PROBLEM, HANDLED HERE TOO
--
-- If claimed rows consume the allowance, a worker that dies mid-flight holds
-- part of the cap for ever and its bookings are never billed. So a claim now
-- records when it was made, and a stale 'reporting' row becomes claimable
-- again.
--
-- Re-claiming keeps the SAME metering_attempt_id, which is the whole reason
-- that column exists: the retry presents Stripe the identity it saw the first
-- time, so if the original call did land, the duplicate is rejected rather than
-- billed twice.
--
-- Fifteen minutes is three reminder-runner cycles — long enough that a slow
-- Stripe call is never mistaken for a dead worker, short enough that a real
-- crash is picked up on the next pass.
-- ============================================================================

alter table public.book_bookings
  add column if not exists metering_claimed_at timestamptz;

-- Existing in-flight rows: none today, but a value is needed for the staleness
-- comparison to mean anything if this ships while one is mid-flight.
update public.book_bookings
   set metering_claimed_at = coalesce(metering_claimed_at, metering_reported_at, created_at)
 where metering_state = 'reporting'
   and metering_claimed_at is null;

create or replace function public.claim_bookings_for_metering(
  p_business_id  uuid,
  p_month_start  timestamptz,
  p_cap          integer,
  p_stale_after  interval default interval '15 minutes'
)
returns table (booking_id uuid, attempt_id uuid, already_reported integer)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_month_end timestamptz := p_month_start + interval '1 month';
  v_spoken_for integer;
  v_remaining  integer;
begin
  if p_business_id is null or p_month_start is null or coalesce(p_cap, 0) < 0 then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_business_id::text || ':' || to_char(p_month_start, 'YYYY-MM'), 0));

  -- Everything already spoken for this month. 'skipped' is excluded on purpose:
  -- a forgiven booking was never billed, so it must not eat the allowance.
  select count(*)::int into v_spoken_for
    from public.book_bookings b
   where b.business_id = p_business_id
     and b.metering_state in ('reported', 'reporting', 'unresolved')
     and b.created_at >= p_month_start and b.created_at < v_month_end
     -- a stale claim is about to be released below, so it is not spoken for
     and not (b.metering_state = 'reporting'
              and coalesce(b.metering_claimed_at, b.created_at) < now() - p_stale_after);

  v_remaining := greatest(0, p_cap - v_spoken_for);
  if v_remaining = 0 then
    return;
  end if;

  return query
  with candidate as (
    select b.id
      from public.book_bookings b
     where b.business_id = p_business_id
       and b.status <> 'cancelled'
       and b.created_at >= p_month_start and b.created_at < v_month_end
       and (b.metering_state = 'pending'
            -- a worker that died mid-flight: reclaimable, same attempt id
            or (b.metering_state = 'reporting'
                and coalesce(b.metering_claimed_at, b.created_at) < now() - p_stale_after))
     order by b.created_at
     limit v_remaining
     for update skip locked
  )
  update public.book_bookings b
     set metering_state      = 'reporting',
         metering_attempt_id = coalesce(b.metering_attempt_id, gen_random_uuid()),
         metering_claimed_at = now(),
         metering_attempts   = b.metering_attempts + 1,
         metering_error      = null
    from candidate c
   where b.id = c.id
  returning b.id, b.metering_attempt_id, v_spoken_for;
end $$;

comment on function public.claim_bookings_for_metering(uuid, timestamptz, integer, interval) is
  'Atomically claims bookings for Stripe metering. The allowance counts reported, reporting and unresolved — anything claimed is spoken for — so concurrent workers cannot together exceed the cap. Stale claims from a dead worker are reclaimed with their original attempt id.';

-- The 3-argument signature is replaced by the 4-argument one above; drop it so
-- there is exactly one claim function and no ambiguity about which runs.
drop function if exists public.claim_bookings_for_metering(uuid, timestamptz, integer);

do $$
declare fn text := 'public.claim_bookings_for_metering(uuid, timestamptz, integer, interval)';
begin
  execute format('revoke all on function %s from public', fn);
  execute format('revoke all on function %s from anon', fn);
  execute format('revoke all on function %s from authenticated', fn);
  execute format('grant execute on function %s to service_role', fn);
end $$;
