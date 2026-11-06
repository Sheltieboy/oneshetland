-- 20261129090000_reminder_delivery_ledger.sql
-- reminder-runner coordination: ONE row per (reminder family, subject, recipient) is the atomic claim AND the record of what happened to that recipient.
--
-- WHY. reminder-runner used to select "reminders not yet stamped", send, then stamp the parent row. Two overlapping executions both selected the same row and both
-- sent (demonstrated), and a bulk reminder was stamped complete when ONE recipient's preference check failed temporarily, so that recipient was never retried.
--
-- HOW. reminder_claim_many() takes the claim with INSERT ... ON CONFLICT DO UPDATE ... WHERE. PostgreSQL serialises concurrent writers to the same key on the row
-- lock and re-evaluates the WHERE against the committed row, so exactly one caller can ever receive a claim token for a recipient, across independent workers.
--   claimed       -> a worker holds a LEASE (default 10 minutes) and has NOT contacted the provider
--   dispatching   -> the worker is about to contact / has contacted the provider (written immediately before the first byte is sent)
--   sent          -> the provider ACCEPTED it (not proof the handset received it)
--   opted_out | quiet_hours | no_device | provider_error -> FINAL (existing policy: no catch-up, no retry)
--   check_failed  -> the preference check could not be read: the ONLY retryable outcome (bounded by attempts and by the reminder's own deadline)
--   uncertain     -> a worker died after "dispatching" with no outcome: the provider MAY have accepted it. NEVER resent (duplicate prevention beats delivery here).
-- A crash BEFORE "dispatching" leaves a plain expired lease, which is safely reclaimed (nothing was sent). A worker that wakes after its lease was reclaimed cannot
-- mark dispatching (its token no longer matches) so it sends nothing.
-- Service role only. Rows hold ids and an outcome, no content; reminder_purge() removes finished rows after 14 days.
-- Every function takes an optional p_now (default now()) so the lease / deadline arithmetic can be tested against a controlled clock; the runner never passes it.
-- Additive. Rollback: supabase/rollbacks/20261129090000_reminder_delivery_ledger_rollback.sql

create table if not exists public.reminder_deliveries (
  family      text not null check (family ~ '^[a-z0-9_]{1,40}$'),
  subject_id  text not null check (length(subject_id) between 1 and 80),
  user_id     uuid not null,
  status      text not null check (status in ('claimed','dispatching','sent','opted_out','quiet_hours','no_device','provider_error','check_failed','uncertain')),
  attempts    integer not null default 1,
  claim_token uuid,
  lease_until timestamptz,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (family, subject_id, user_id)
);
alter table public.reminder_deliveries enable row level security;           -- no policies: no client role can read or write it
revoke all on public.reminder_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.reminder_deliveries to service_role;
create index if not exists reminder_deliveries_updated_idx on public.reminder_deliveries (updated_at);

-- claim: returns one row per requested recipient. state = 'claimed' (you hold p_token) or why you do not:
--   in_progress (another worker holds a live lease / is dispatching) | retryable | exhausted (check_failed, attempts used up) | expired (past the deadline)
--   | sent | opted_out | quiet_hours | no_device | provider_error | uncertain   (all final)
create or replace function public.reminder_claim_many(p_family text, p_subject text, p_users uuid[], p_lease_seconds integer default 600, p_deadline timestamptz default null,
  p_max_attempts integer default 12, p_reuse_after interval default null, p_now timestamptz default null)
returns table (r_user uuid, r_token uuid, r_state text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 600), 30), 3600)); v_now timestamptz := coalesce(p_now, now());
        v_past boolean; v_mine uuid[]; v_tok uuid[];
begin
  v_past := p_deadline is not null and v_now >= p_deadline;
  if p_users is null or cardinality(p_users) = 0 then return; end if;
  if cardinality(p_users) > 50000 then raise exception 'Too many recipients' using errcode = '22023'; end if;
  -- a send that began and whose lease ran out with no outcome may have reached the provider: final, never resent
  update public.reminder_deliveries d set status = 'uncertain', last_error = 'interrupted after dispatch began', updated_at = v_now
   where d.family = p_family and d.subject_id = p_subject and d.user_id = any (p_users) and d.status = 'dispatching' and d.lease_until < v_now;
  -- (1) take the claims. (2) report state in a SECOND statement: it takes a fresh snapshot, so a caller that lost the race (and waited on the winner's row lock) sees the
  --     winner's committed row as 'in_progress' instead of a stale 'no row'.
  with mine as (
    insert into public.reminder_deliveries as d (family, subject_id, user_id, status, attempts, claim_token, lease_until, created_at, updated_at)
    select p_family, p_subject, u, 'claimed', 1, gen_random_uuid(), v_now + v_lease, v_now, v_now from (select distinct unnest(p_users) as u) x where not v_past
    on conflict (family, subject_id, user_id) do update
      set status = 'claimed', claim_token = excluded.claim_token, lease_until = excluded.lease_until, updated_at = v_now,
          attempts = case when d.status in ('check_failed', 'claimed') then d.attempts + 1 else 1 end
      where (d.status = 'check_failed' and d.attempts < p_max_attempts)
         or (d.status = 'claimed' and d.lease_until < v_now)
         or (p_reuse_after is not null and d.status in ('sent','opted_out','quiet_hours','no_device','provider_error','uncertain') and d.updated_at < v_now - p_reuse_after)
    returning d.user_id as uid, d.claim_token as tok
  )
  select coalesce(array_agg(uid), '{}'), coalesce(array_agg(tok), '{}') into v_mine, v_tok from mine;
  return query
  select x.u, m.tok,
         case when m.tok is not null then 'claimed'
              when e.status in ('sent','opted_out','quiet_hours','no_device','provider_error','uncertain') then e.status
              when v_past then 'expired'
              when e.status = 'check_failed' and e.attempts >= p_max_attempts then 'exhausted'
              when e.status = 'check_failed' then 'retryable'
              when e.status in ('claimed','dispatching') then 'in_progress'
              else 'expired' end
    from (select distinct unnest(p_users) as u) x
    left join (select * from unnest(v_mine, v_tok) as t(uid, tok)) m on m.uid = x.u
    left join public.reminder_deliveries e on e.family = p_family and e.subject_id = p_subject and e.user_id = x.u;
end $$;

-- the worker is about to contact the provider: only the current holder of the claim may proceed
create or replace function public.reminder_mark_dispatching(p_family text, p_subject text, p_user uuid, p_token uuid, p_lease_seconds integer default 600, p_now timestamptz default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.reminder_deliveries set status = 'dispatching', lease_until = coalesce(p_now, now()) + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 600), 30), 3600)), updated_at = coalesce(p_now, now())
   where family = p_family and subject_id = p_subject and user_id = p_user and claim_token = p_token and status = 'claimed';
  get diagnostics n = row_count; return n = 1;
end $$;

-- record outcomes: p_results = [{ "user": uuid, "token": uuid, "status": "...", "error": "..." }]; only the holder of a live claim token can record
create or replace function public.reminder_finish_many(p_family text, p_subject text, p_results jsonb, p_now timestamptz default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then raise exception 'p_results must be an array' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_results) r where coalesce(r->>'status', '') not in ('sent','opted_out','quiet_hours','no_device','provider_error','check_failed')) then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  update public.reminder_deliveries d set status = r.status, last_error = left(r.error, 200), lease_until = null, updated_at = coalesce(p_now, now())
    from (select (x->>'user')::uuid as u, (x->>'token')::uuid as tok, x->>'status' as status, x->>'error' as error from jsonb_array_elements(p_results) x) r
   where d.family = p_family and d.subject_id = p_subject and d.user_id = r.u and d.claim_token = r.tok and d.status in ('claimed', 'dispatching');
  get diagnostics n = row_count; return n;
end $$;

create or replace function public.reminder_purge(p_older_than interval default interval '14 days', p_now timestamptz default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.reminder_deliveries where updated_at < coalesce(p_now, now()) - greatest(p_older_than, interval '2 days') and status not in ('claimed', 'dispatching');
  get diagnostics n = row_count; return n;
end $$;

revoke all on function public.reminder_claim_many(text, text, uuid[], integer, timestamptz, integer, interval, timestamptz), public.reminder_mark_dispatching(text, text, uuid, uuid, integer, timestamptz),
  public.reminder_finish_many(text, text, jsonb, timestamptz), public.reminder_purge(interval, timestamptz) from public, anon, authenticated;
grant execute on function public.reminder_claim_many(text, text, uuid[], integer, timestamptz, integer, interval, timestamptz), public.reminder_mark_dispatching(text, text, uuid, uuid, integer, timestamptz),
  public.reminder_finish_many(text, text, jsonb, timestamptz), public.reminder_purge(interval, timestamptz) to service_role;
