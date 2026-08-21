-- ============================================================================
-- A booking gets billed once, or not at all — never twice, never silently lost.
--
-- WHAT WAS WRONG, ON BOTH STRIPE PATHS
--
-- meter-bookings reports usage to Stripe and then stamps metered_at. Between
-- those two steps there was nothing durable, so two overlapping reminder-runner
-- passes could both read the same unmetered bookings and both report them.
--
-- Step 10 recorded the Billing Meter path as "appears retry-safe" because it
-- sends a deterministic identifier. Re-checking that against Stripe's own
-- documentation shows it is not:
--
--   "identifier ... Stripe enforces uniqueness within a rolling period of at
--    least 24 hours."
--
-- Two consequences the old identifier walked straight into. It was
-- `bk-{business}-{month}-{already_billed}`, where already_billed only moves
-- once stamping succeeds:
--
--   * Quantity drift. Report 5 units, crash before stamping, two more bookings
--     arrive, retry. already_billed is still 0, so the identifier is the SAME —
--     but the payload now says 7. Stripe rejects the duplicate identifier, and
--     the code stamps all 7 anyway. Two bookings billed to nobody. SILENT LOST
--     BILLING.
--   * The window ends. Past ~24 hours the same identifier is accepted again, so
--     a long-delayed retry bills a second time. DOUBLE BILLING.
--
-- The legacy usage-record path had no protection at all: a bare `increment`
-- with no idempotency key.
--
-- WHY THE DATABASE IS THE CONTROL, NOT STRIPE
--
-- Stripe's guarantees are real but time-boxed — 24 hours for meter-event
-- identifiers, and idempotency keys are "removed from the system automatically
-- after they're at least 24 hours old". A billing boundary should not depend on
-- a retry happening soon enough.
--
-- So the claim lives here, and Stripe idempotency becomes the second net rather
-- than the only one. This is the shape Step 6B established for wallet attempts:
-- atomic claim, stable external identity, terminal states that never reopen,
-- and an explicit unresolved state that is never mistaken for success.
--
-- ONE BOOKING IS ONE BILLABLE EVENT
--
-- The old code reported a whole month's backlog as a single event whose
-- quantity could change between attempts. Per-booking removes that entire class
-- of bug: the quantity is always 1, so the payload cannot drift, and the
-- identity is the booking's own attempt id — generated here, never chosen by a
-- caller, never regenerated on retry.
--
-- The meter aggregates by Sum, so seventeen events of 1 bill exactly as one
-- event of 17. Nothing about what a business pays changes.
--
-- THE OTHER HOLE, WHICH WAS WORSE
--
-- anon and authenticated held UPDATE on book_bookings — including metered_at.
-- RLS filters rows, never columns, and the UPDATE policy lets a business owner
-- update every booking of their own business. So a Pro business could stamp its
-- own bookings as already metered and never be billed for any of them. Verified
-- against production before this migration: as the booking's own customer, the
-- UPDATE succeeded.
--
-- Column privileges are the fix, as in Step 8: table-wide INSERT and UPDATE are
-- revoked and only the columns a client legitimately writes are granted back.
-- The metering columns are in no grant, so they are unwritable by any client —
-- and a metering column added later is private by default rather than exposed.
-- ============================================================================


-- ── Durable metering state ──────────────────────────────────────────────────
--
--   pending     never reported; eligible to be claimed
--   reporting   claimed by a worker, Stripe call in flight
--   reported    Stripe confirmed. TERMINAL — never re-billed
--   unresolved  the Stripe call ended ambiguously. NOT success, NOT retryable
--               past the dedupe window without a human deciding
--   skipped     deliberately never billed (Premium, or forgiven at the cap).
--               TERMINAL, which is what stops a tier change billing it later
alter table public.book_bookings
  add column if not exists metering_state       text        not null default 'pending',
  add column if not exists metering_attempt_id  uuid,
  add column if not exists metering_reported_at timestamptz,
  add column if not exists metering_error       text,
  add column if not exists metering_attempts    integer     not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'book_bookings_metering_state_check') then
    alter table public.book_bookings add constraint book_bookings_metering_state_check
      check (metering_state in ('pending','reporting','reported','unresolved','skipped'));
  end if;
end $$;

-- Existing rows: metered_at already set means "processed, do not process again",
-- which is exactly what 'reported' guarantees. No Stripe usage is created for
-- them and no existing metered_at is altered — this only teaches the new state
-- machine about work that already happened.
update public.book_bookings
   set metering_state = 'reported',
       metering_reported_at = coalesce(metering_reported_at, metered_at)
 where metered_at is not null
   and metering_state = 'pending';

create index if not exists book_bookings_metering_claim_idx
  on public.book_bookings (business_id, metering_state, created_at)
  where metering_state in ('pending','reporting','unresolved');


-- ── Claiming, atomically, with the cap enforced in the same breath ──────────
--
-- The cap and the claim cannot be separate steps. Two workers that each read
-- "16 already billed" would each believe they may bill one more. An advisory
-- lock keyed on (business, booking month) serialises the pair, and it is a
-- transaction-scoped lock so it is released whatever happens next.
--
-- SKIP LOCKED is not enough on its own here: it prevents two workers taking the
-- same ROW, not two workers each taking a different row past the cap.
create or replace function public.claim_bookings_for_metering(
  p_business_id  uuid,
  p_month_start  timestamptz,
  p_cap          integer
)
returns table (booking_id uuid, attempt_id uuid, already_reported integer)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_month_end   timestamptz := p_month_start + interval '1 month';
  v_reported    integer;
  v_remaining   integer;
begin
  if p_business_id is null or p_month_start is null or coalesce(p_cap, 0) < 0 then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_business_id::text || ':' || to_char(p_month_start, 'YYYY-MM'), 0));

  select count(*)::int into v_reported
    from public.book_bookings b
   where b.business_id = p_business_id
     and b.metering_state = 'reported'
     and b.created_at >= p_month_start and b.created_at < v_month_end;

  v_remaining := greatest(0, p_cap - v_reported);
  if v_remaining = 0 then
    return;
  end if;

  return query
  with candidate as (
    select b.id
      from public.book_bookings b
     where b.business_id = p_business_id
       and b.status <> 'cancelled'
       and b.metering_state = 'pending'
       and b.created_at >= p_month_start and b.created_at < v_month_end
     order by b.created_at
     limit v_remaining
     for update skip locked
  )
  update public.book_bookings b
     set metering_state      = 'reporting',
         -- Assigned once and never regenerated: a retry must present the SAME
         -- identity to Stripe, or its idempotency cannot help us.
         metering_attempt_id = coalesce(b.metering_attempt_id, gen_random_uuid()),
         metering_attempts   = b.metering_attempts + 1,
         metering_error      = null
    from candidate c
   where b.id = c.id
  returning b.id, b.metering_attempt_id, v_reported;
end $$;

comment on function public.claim_bookings_for_metering(uuid, timestamptz, integer) is
  'Atomically claims up to the remaining monthly allowance of bookings for Stripe metering. The advisory lock makes the cap check and the claim one operation, so two workers cannot both spend the last unit.';


-- ── Settling a claim ────────────────────────────────────────────────────────
--
-- Every settle names the attempt id it is settling. A worker whose claim was
-- superseded cannot overwrite the outcome of the one that replaced it.
create or replace function public.settle_booking_metering(
  p_booking_id uuid,
  p_attempt_id uuid,
  p_outcome    text,
  p_error      text default null
)
returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_outcome not in ('reported','failed','unresolved') then
    raise exception 'unknown metering outcome %', p_outcome using errcode = '22023';
  end if;

  update public.book_bookings b
     set metering_state = case p_outcome
                            when 'reported'   then 'reported'
                            -- A definite failure returns it to the queue. The
                            -- attempt id is deliberately KEPT, so the retry is
                            -- the same logical billing event, not a new one.
                            when 'failed'     then 'pending'
                            else                   'unresolved'
                          end,
         metered_at           = case when p_outcome = 'reported' then coalesce(b.metered_at, now()) else b.metered_at end,
         metering_reported_at = case when p_outcome = 'reported' then now() else b.metering_reported_at end,
         metering_error       = case when p_outcome = 'reported' then null else left(p_error, 500) end
   where b.id = p_booking_id
     and b.metering_attempt_id = p_attempt_id
     -- 'reported' and 'skipped' are terminal. Nothing reopens them.
     and b.metering_state in ('reporting','unresolved');

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

comment on function public.settle_booking_metering(uuid, uuid, text, text) is
  'Settles one claimed booking. reported is terminal; failed returns it to pending KEEPING its attempt id so the retry is the same billing event; unresolved is never treated as success.';


-- ── Bookings that are processed but never billed ────────────────────────────
--
-- Premium includes bookings, and a month past its cap is forgiven. Both are
-- marked 'skipped' rather than left pending, because a pending booking would be
-- picked up the moment the business moved to Pro — billing them for bookings
-- taken while their plan included them.
create or replace function public.skip_bookings_for_metering(
  p_business_id uuid,
  p_month_start timestamptz default null
)
returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.book_bookings b
     set metering_state = 'skipped',
         metered_at     = coalesce(b.metered_at, now())
   where b.business_id = p_business_id
     and b.status <> 'cancelled'
     and b.metering_state = 'pending'
     and (p_month_start is null
          or (b.created_at >= p_month_start and b.created_at < p_month_start + interval '1 month'));
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

comment on function public.skip_bookings_for_metering(uuid, timestamptz) is
  'Marks bookings processed-but-not-billed (Premium, or forgiven past the monthly cap). Terminal, so a later tier change cannot turn them into a bill.';


-- ── Re-claiming an ambiguous attempt ────────────────────────────────────────
--
-- An unresolved booking may be retried only while Stripe would still recognise
-- its identifier as a duplicate. Stripe promises "at least 24 hours"; 12 is
-- comfortably inside that, so a retry cannot produce a second charge.
--
-- Past the window the honest answer is that we do not know, so it is left for a
-- person and surfaced by metering_backlog_health() rather than gambled on.
create or replace function public.reclaim_unresolved_metering(
  p_business_id uuid,
  p_within      interval default interval '12 hours'
)
returns table (booking_id uuid, attempt_id uuid)
  language sql
  security definer
  set search_path = public
as $$
  update public.book_bookings b
     set metering_state    = 'reporting',
         metering_attempts = b.metering_attempts + 1
   where b.id in (
           select b2.id from public.book_bookings b2
            where b2.business_id = p_business_id
              and b2.metering_state = 'unresolved'
              and b2.metering_attempt_id is not null
              and coalesce(b2.metering_reported_at, b2.created_at) > now() - p_within
            for update skip locked)
  returning b.id, b.metering_attempt_id;
$$;

comment on function public.reclaim_unresolved_metering(uuid, interval) is
  'Re-claims ambiguous attempts only inside Stripe''s idempotency window, reusing the same attempt id. Older ones stay unresolved for human reconciliation.';


-- ── Privileges ──────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.claim_bookings_for_metering(uuid, timestamptz, integer)',
    'public.settle_booking_metering(uuid, uuid, text, text)',
    'public.skip_bookings_for_metering(uuid, timestamptz)',
    'public.reclaim_unresolved_metering(uuid, interval)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;


-- ── Clients stop being able to write their own billing state ────────────────
--
-- RLS decides which ROWS; only column privileges decide which COLUMNS. The
-- whitelist is the point: metering columns appear in no grant, so they are
-- unwritable, and so is any metering column added later.
revoke insert, update on public.book_bookings from anon;
revoke insert, update on public.book_bookings from authenticated;

-- Exactly what lib/book-api.ts writes when a customer books.
grant insert (business_id, service_id, customer_id, starts_at, ends_at,
              price_pence, deposit_pence, notes, status, gift_id)
  on public.book_bookings to authenticated;

-- Exactly what cancelBooking() and updateBookingStatus() write.
grant update (status, cancelled_at, cancelled_by)
  on public.book_bookings to authenticated;

-- anon is granted nothing: booking requires a signed-in customer, and the
-- INSERT policy already demands customer_id = auth.uid().


-- ── Prove it in the transaction that did it ─────────────────────────────────
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from (values ('anon'),('authenticated')) r(rolname)
   where has_column_privilege(r.rolname, 'public.book_bookings', 'metered_at', 'UPDATE')
      or has_column_privilege(r.rolname, 'public.book_bookings', 'metering_state', 'UPDATE')
      or has_column_privilege(r.rolname, 'public.book_bookings', 'metering_attempt_id', 'UPDATE');
  if v_bad > 0 then
    raise exception 'a client role can still write booking metering columns';
  end if;

  if not has_column_privilege('authenticated', 'public.book_bookings', 'status', 'UPDATE') then
    raise exception 'authenticated lost UPDATE on status — cancelling a booking would break';
  end if;
  if not has_column_privilege('authenticated', 'public.book_bookings', 'starts_at', 'INSERT') then
    raise exception 'authenticated lost INSERT on starts_at — creating a booking would break';
  end if;
end $$;
