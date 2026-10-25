-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Fetch v2 — Step 10: admin controls (docs/FETCH_V2_IMPLEMENTATION.md, Step 10).
--
-- The operations console (web /admin/fetch) reads only through the administrator-gated functions here and changes things only through
-- the audited service functions of Steps 3–10 (via the fetch-v2-admin edge function). No browser writes any Fetch table.
--
--   READS (authenticated, is_admin() checked inside):
--     fetch_v2_admin_queues()        what needs attention now: payment problems, cannot-deliver/returns, cancellations, verification
--                                    problems on live jobs, open issues, driver verification, stuck notifications — each item with a
--                                    priority ('action_required' | 'waiting') and reason codes
--     fetch_v2_admin_jobs(filters)   a filtered job list (status, requester, driver, dates, issue/payment/return/cancellation, queue, id)
--     fetch_v2_admin_job(request)    one job: summary, money, immutable timeline, payment state, support record, redaction history,
--                                    matching and notification diagnostics, the parties' restriction state
--     fetch_v2_admin_member(member)  counters and restriction history for a member as requester and as driver
--   ACTIONS (service_role; the edge passes the verified administrator):
--     fetch_v2_redact_description    replace a job's item description; the original is kept in fetch_request_redactions (admin-only)
--     fetch_v2_set_member_restriction restrict / unrestrict a member from Fetch, always with a reason; logged in fetch_member_restriction_log
--
-- Rollback: supabase/rollbacks/20261207000000_fetch_v2_admin_controls.down.sql
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Schema
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.fetch_member_stats add column if not exists restricted_by uuid references public.profiles (id) on delete set null;

-- What a job's description said before an administrator replaced it. Never shown to members; never edited.
create table if not exists public.fetch_request_redactions (
  id            bigserial primary key,
  request_id    uuid not null references public.delivery_requests (id) on delete cascade,
  field         text not null check (field = 'item_description'),
  original_text text not null,
  replacement   text not null,
  admin_id      uuid references public.profiles (id) on delete set null,
  reason        text not null check (char_length(btrim(reason)) between 3 and 500),
  created_at    timestamptz not null default now()
);
create index if not exists fetch_request_redactions_request_idx on public.fetch_request_redactions (request_id, id);

-- Every restriction and its lifting, with who and why.
create table if not exists public.fetch_member_restriction_log (
  id         bigserial primary key,
  member_id  uuid not null references public.profiles (id) on delete cascade,
  action     text not null check (action in ('restricted', 'unrestricted')),
  admin_id   uuid references public.profiles (id) on delete set null,
  reason     text not null check (char_length(btrim(reason)) between 3 and 500),
  created_at timestamptz not null default now()
);
create index if not exists fetch_member_restriction_log_member_idx on public.fetch_member_restriction_log (member_id, id);

create or replace function public.tg_fetch_admin_history_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then return case when tg_op = 'DELETE' then old else new end; end if;   -- account-deletion cascades
  raise exception 'Fetch administrator history is append-only' using errcode = '42501';
end;
$$;
drop trigger if exists fetch_request_redactions_append_only on public.fetch_request_redactions;
create trigger fetch_request_redactions_append_only before update or delete on public.fetch_request_redactions
  for each row execute function public.tg_fetch_admin_history_append_only();
drop trigger if exists fetch_member_restriction_log_append_only on public.fetch_member_restriction_log;
create trigger fetch_member_restriction_log_append_only before update or delete on public.fetch_member_restriction_log
  for each row execute function public.tg_fetch_admin_history_append_only();

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Audited actions
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_redact_description(p_admin uuid, p_request uuid, p_replacement text, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r        public.delivery_requests;
  v_new    text := coalesce(nullif(btrim(coalesce(p_replacement, ''), E' \t\r\n'), ''), 'Description removed by OneShetland');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then return public.fetch_v2_refuse('reason_required'); end if;
  if char_length(v_new) < 3 or char_length(v_new) > 140 then return public.fetch_v2_refuse('invalid_request'); end if;
  r := public.fetch_v2_lock(p_request);
  if r.item_description is not distinct from v_new then return jsonb_build_object('ok', true, 'already', true); end if;
  insert into public.fetch_request_redactions (request_id, field, original_text, replacement, admin_id, reason)
  values (r.id, 'item_description', coalesce(r.item_description, ''), v_new, p_admin, v_reason);
  update public.delivery_requests set item_description = v_new where id = r.id;
  perform public.fetch_v2_log(r.id, p_admin, 'admin', 'description_redacted', null, null, v_reason, null, jsonb_build_object('field', 'item_description'));
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- Takes effect at once through the existing gates (fetch_v2_member_problem: create, claim, runs, board, matching). Jobs already in
-- progress are left for an administrator to handle with the job actions.
create or replace function public.fetch_v2_set_member_restriction(p_admin uuid, p_member uuid, p_restrict boolean, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  s        public.fetch_member_stats;
  v_live   integer;
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then return public.fetch_v2_refuse('reason_required'); end if;
  if p_member is null or not exists (select 1 from public.profiles where id = p_member) then return public.fetch_v2_refuse('not_found'); end if;
  if p_member = p_admin then return public.fetch_v2_refuse('cannot_restrict_self'); end if;
  insert into public.fetch_member_stats (user_id) values (p_member) on conflict (user_id) do nothing;
  select * into s from public.fetch_member_stats where user_id = p_member for update;
  if p_restrict = (s.restricted_at is not null) then return jsonb_build_object('ok', true, 'already', true, 'restricted', p_restrict); end if;
  if p_restrict then
    update public.fetch_member_stats set restricted_at = now(), restricted_reason = v_reason, restricted_by = p_admin, updated_at = now()
     where user_id = p_member;
  else
    update public.fetch_member_stats set restricted_at = null, restricted_reason = null, restricted_by = null, updated_at = now()
     where user_id = p_member;
  end if;
  insert into public.fetch_member_restriction_log (member_id, action, admin_id, reason)
  values (p_member, case when p_restrict then 'restricted' else 'unrestricted' end, p_admin, v_reason);
  select count(*) into v_live from public.delivery_requests
   where fetch_version = 2 and status in ('pending', 'matched', 'collected', 'undeliverable') and (customer_id = p_member or driver_id = p_member);
  return jsonb_build_object('ok', true, 'already', false, 'restricted', p_restrict, 'live_jobs', v_live);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Queue membership (one definition each; the landing page, the job list and the tests all use these)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_q_payments()
  returns table (request_id uuid, priority text, reasons text[])
  language sql stable security definer set search_path = public, pg_temp
as $$
  with j as (
    select d.id, d.status, d.payment_status, d.resolution_capture_pence, a.status as a_status, a.capture_state, a.stripe_payment_intent_id,
           a.authorisation_expires_at,
           exists (select 1 from public.fetch_issues i where i.request_id = d.id and i.kind = 'payment' and i.status = 'open') as pay_issue
      from public.delivery_requests d left join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id
     where d.fetch_version = 2),
  r as (
    select j.id, array_remove(array[
      case when j.pay_issue then 'payment_issue_open' end,
      case when j.capture_state = 'failed' then 'capture_failed' end,
      case when j.capture_state = 'unresolved' then 'capture_unresolved' end,
      case when j.status in ('collected', 'undeliverable') and coalesce(j.a_status, '') <> 'captured'
            and (j.payment_status = 'expired' or j.authorisation_expires_at < now() + make_interval(secs => public.fetch_v2_timeout_secs('hold_expiry_margin_secs')))
           then 'hold_expiring_after_collection' end,
      case when j.status = 'returned' and j.a_status = 'authorised' and coalesce(j.resolution_capture_pence, 0) > 0 then 'return_capture_pending' end,
      case when j.status in ('pending', 'cancelled', 'expired') and j.stripe_payment_intent_id is not null
            and coalesce(j.a_status, '') not in ('terminal', 'captured') then 'void_pending' end], null) as reasons
      from j)
  select r.id, case when r.reasons && array['payment_issue_open', 'capture_failed', 'capture_unresolved', 'hold_expiring_after_collection']
                    then 'action_required' else 'waiting' end, r.reasons
    from r where cardinality(r.reasons) > 0;
$$;

create or replace function public.fetch_v2_q_cancellations()
  returns table (request_id uuid, priority text, reasons text[], requested_at timestamptz, respond_by timestamptz)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select d.id,
         case when x.overdue or x.declined or x.escalated then 'action_required' else 'waiting' end,
         array_remove(array[case when x.overdue then 'driver_did_not_respond' end, case when x.declined then 'driver_declined' end,
                            case when x.escalated then 'awaiting_admin_decision' end,
                            case when not (x.overdue or x.declined or x.escalated) then 'awaiting_driver' end], null),
         d.cancel_requested_at, x.respond_by
    from public.delivery_requests d
    cross join lateral (select d.cancel_requested_at + make_interval(secs => public.fetch_v2_timeout_secs('cancel_request_secs')) as respond_by) t
    cross join lateral (select t.respond_by, now() > t.respond_by as overdue,
      exists (select 1 from public.fetch_request_events e where e.request_id = d.id and e.event = 'cancellation_declined' and e.created_at >= d.cancel_requested_at) as declined,
      exists (select 1 from public.fetch_issues i where i.request_id = d.id and i.kind = 'cancellation' and i.status = 'open') as escalated) x
   where d.fetch_version = 2 and d.status = 'matched' and d.cancel_requested_at is not null;
$$;

create or replace function public.fetch_v2_q_returns()
  returns table (request_id uuid, priority text, reasons text[])
  language sql stable security definer set search_path = public, pg_temp
as $$
  select d.id, 'action_required',
         array_remove(array['cannot_deliver',
           case when exists (select 1 from public.fetch_request_events e where e.request_id = d.id and e.event = 'return_reported') then 'return_reported'
                else 'awaiting_return_report' end,
           case when public.fetch_v2_has_evidence(d.id, 'return') then 'return_photo' end], null)
    from public.delivery_requests d
   where d.fetch_version = 2 and d.status = 'undeliverable';
$$;

create or replace function public.fetch_v2_q_verification_jobs()
  returns table (request_id uuid, priority text, reasons text[])
  language sql stable security definer set search_path = public, pg_temp
as $$
  select d.id, 'action_required',
         array_remove(array[p.problem, case when d.status = 'matched' then 'collection_blocked' else 'already_collected' end,
           case when exists (select 1 from public.driver_verification_items i where i.driver_id = d.driver_id and i.status = 'submitted')
                then 'new_evidence_waiting' end], null)
    from public.delivery_requests d
    cross join lateral (select public.fetch_v2_driver_problem(d.driver_id) as problem) p
   where d.fetch_version = 2 and d.status in ('matched', 'collected', 'undeliverable') and d.driver_id is not null
     and p.problem in ('driver_verification_expired', 'driver_verification_incomplete', 'driver_suspended', 'driver_not_approved');
$$;

create or replace function public.fetch_v2_admin_name(p_user uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce(nullif(btrim(full_name), ''), 'Member ' || left(id::text, 8)) from public.profiles where id = p_user; $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. The landing page: what needs attention now
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_admin_queues() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  q_pay jsonb; q_can jsonb; q_ret jsonb; q_ver jsonb; q_iss jsonb; q_drv jsonb; q_ntf jsonb;
  job_row text := $j$jsonb_build_object('request_id', d.id, 'status', d.status, 'payment_status', d.payment_status,
      'route', coalesce(pr.name, '?') || ' → ' || coalesce(dr.name, '?'), 'driver', public.fetch_v2_admin_name(d.driver_id),
      'requester', public.fetch_v2_admin_name(d.customer_id), 'updated', greatest(d.created_at, d.claimed_at, d.collected_at, d.undeliverable_at))$j$;
begin
  if not public.is_admin() then raise exception 'Only an administrator can do that' using errcode = '42501'; end if;

  execute format($s$select coalesce(jsonb_agg(%s || jsonb_build_object('priority', q.priority, 'reasons', to_jsonb(q.reasons))
                    order by q.priority, d.created_at), '[]') from public.fetch_v2_q_payments() q join public.delivery_requests d on d.id = q.request_id
                    left join public.regions pr on pr.id = d.pickup_region_id left join public.regions dr on dr.id = d.destination_region_id$s$, job_row) into q_pay;
  execute format($s$select coalesce(jsonb_agg(%s || jsonb_build_object('priority', q.priority, 'reasons', to_jsonb(q.reasons),
                    'requested_at', q.requested_at, 'respond_by', q.respond_by) order by q.priority, q.respond_by), '[]')
                    from public.fetch_v2_q_cancellations() q join public.delivery_requests d on d.id = q.request_id
                    left join public.regions pr on pr.id = d.pickup_region_id left join public.regions dr on dr.id = d.destination_region_id$s$, job_row) into q_can;
  execute format($s$select coalesce(jsonb_agg(%s || jsonb_build_object('priority', q.priority, 'reasons', to_jsonb(q.reasons),
                    'undeliverable_at', d.undeliverable_at, 'undeliverable_reason', d.undeliverable_reason) order by d.undeliverable_at), '[]')
                    from public.fetch_v2_q_returns() q join public.delivery_requests d on d.id = q.request_id
                    left join public.regions pr on pr.id = d.pickup_region_id left join public.regions dr on dr.id = d.destination_region_id$s$, job_row) into q_ret;
  execute format($s$select coalesce(jsonb_agg(%s || jsonb_build_object('priority', q.priority, 'reasons', to_jsonb(q.reasons), 'driver_id', d.driver_id)
                    order by d.claimed_at), '[]') from public.fetch_v2_q_verification_jobs() q join public.delivery_requests d on d.id = q.request_id
                    left join public.regions pr on pr.id = d.pickup_region_id left join public.regions dr on dr.id = d.destination_region_id$s$, job_row) into q_ver;

  -- Open issues: never the reporter's text in a list (it may hold personal details) — open the job for that.
  select coalesce(jsonb_agg(jsonb_build_object('issue_id', i.id, 'request_id', i.request_id, 'kind', i.kind, 'reporter_role', i.reporter_role,
      'opened_at', i.created_at, 'job_status', d.status,
      'has_evidence', exists (select 1 from public.fetch_request_photos ph where ph.issue_id = i.id and ph.removed_at is null),
      'affects_payment', i.kind in ('payment', 'not_delivered', 'damaged', 'wrong_item', 'return') or d.status in ('undeliverable', 'returned'),
      'priority', case when i.kind in ('safety', 'payment', 'not_delivered', 'driver_verification', 'return', 'cancellation') then 'action_required' else 'waiting' end)
    order by i.created_at), '[]') into q_iss
    from public.fetch_issues i join public.delivery_requests d on d.id = i.request_id and d.fetch_version = 2 where i.status = 'open';

  q_drv := public.fetch_v2_verification_queue(v_uid);

  select coalesce(jsonb_agg(jsonb_build_object('notification_id', n.id, 'kind', n.kind, 'request_id', n.request_id, 'recipient', public.fetch_v2_admin_name(n.recipient_id),
      'recipient_id', n.recipient_id, 'state', n.state, 'push', n.push_result, 'attempts', n.attempts, 'last_error', left(n.last_error, 120),
      'created_at', n.created_at,
      'problem', case when n.state = 'pending' then 'not_written_to_inbox'
                      when n.state = 'inbox_created' then 'push_retrying'
                      when n.state = 'failed' then 'failed'
                      else coalesce(n.push_result, 'unknown') end,
      'priority', case when n.state in ('pending', 'failed') or n.time_critical then 'action_required' else 'waiting' end) order by n.id desc), '[]') into q_ntf
    from (select * from public.fetch_notifications n
           where (n.state = 'pending' and n.created_at < now() - interval '10 minutes')
              or (n.state = 'inbox_created' and n.attempts >= 2)
              or n.state = 'failed'
              or (n.state = 'completed' and n.push_result in ('provider_error', 'invalid_token', 'push_unavailable') and n.completed_at > now() - interval '7 days')
           order by n.id desc limit 200) n;

  return jsonb_build_object('ok', true, 'generated_at', now(),
    'queues', jsonb_build_object(
      'payments', q_pay, 'returns', q_ret, 'verification_jobs', q_ver, 'cancellations', q_can, 'issues', q_iss,
      'driver_verification', jsonb_build_object('awaiting_review', q_drv -> 'awaiting_review', 'pending_applications', q_drv -> 'pending_applications'),
      'notifications', q_ntf),
    'counts', jsonb_build_object(
      'payments', jsonb_array_length(q_pay), 'returns', jsonb_array_length(q_ret), 'verification_jobs', jsonb_array_length(q_ver),
      'cancellations', jsonb_array_length(q_can), 'issues', jsonb_array_length(q_iss),
      'driver_verification', jsonb_array_length(q_drv -> 'awaiting_review') + jsonb_array_length(q_drv -> 'pending_applications'),
      'notifications', jsonb_array_length(q_ntf)),
    'action_required', jsonb_build_object(
      'payments', (select count(*) from jsonb_array_elements(q_pay) x where x ->> 'priority' = 'action_required'),
      'returns', jsonb_array_length(q_ret), 'verification_jobs', jsonb_array_length(q_ver),
      'cancellations', (select count(*) from jsonb_array_elements(q_can) x where x ->> 'priority' = 'action_required'),
      'issues', (select count(*) from jsonb_array_elements(q_iss) x where x ->> 'priority' = 'action_required'),
      'driver_verification', 0,
      'notifications', (select count(*) from jsonb_array_elements(q_ntf) x where x ->> 'priority' = 'action_required')));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Job list
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_admin_jobs(p_filters jsonb default '{}') returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  f      jsonb := coalesce(p_filters, '{}');
  v_q    text := lower(nullif(btrim(coalesce(f ->> 'q', '')), ''));
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if not public.is_admin() then raise exception 'Only an administrator can do that' using errcode = '42501'; end if;
  if v_q is not null and v_q !~ '^[0-9a-f-]{4,36}$' then return jsonb_build_object('ok', true, 'jobs', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'jobs', coalesce((
    select jsonb_agg(row order by created_at desc) from (
      select jsonb_build_object('request_id', d.id, 'created_at', d.created_at, 'status', d.status, 'payment_status', d.payment_status,
               'route', coalesce(pr.name, '?') || ' → ' || coalesce(dr.name, '?'), 'size_class', d.size_class,
               'requester_id', d.customer_id, 'requester', public.fetch_v2_admin_name(d.customer_id),
               'driver_id', d.driver_id, 'driver', public.fetch_v2_admin_name(d.driver_id),
               'open_issues', (select count(*) from public.fetch_issues i where i.request_id = d.id and i.status = 'open'),
               'cancellation_requested', d.cancel_requested_at is not null) as row, d.created_at
        from public.delivery_requests d
        left join public.regions pr on pr.id = d.pickup_region_id left join public.regions dr on dr.id = d.destination_region_id
       where d.fetch_version = 2
         and (f ->> 'status' is null or d.status = f ->> 'status')
         and (f ->> 'requester' is null or (f ->> 'requester' ~ v_uuid and d.customer_id = (f ->> 'requester')::uuid))
         and (f ->> 'driver' is null or (f ->> 'driver' ~ v_uuid and d.driver_id = (f ->> 'driver')::uuid))
         and (f ->> 'from' is null or (f ->> 'from' ~ '^\d{4}-\d{2}-\d{2}$' and d.created_at >= (f ->> 'from')::date))
         and (f ->> 'to' is null or (f ->> 'to' ~ '^\d{4}-\d{2}-\d{2}$' and d.created_at < (f ->> 'to')::date + 1))
         and (coalesce((f ->> 'open_issue')::boolean, false) = false
              or exists (select 1 from public.fetch_issues i where i.request_id = d.id and i.status = 'open'))
         and (coalesce((f ->> 'payment_problem')::boolean, false) = false or d.id in (select request_id from public.fetch_v2_q_payments()))
         and (coalesce((f ->> 'return_state')::boolean, false) = false or d.status in ('undeliverable', 'returned'))
         and (coalesce((f ->> 'cancellation')::boolean, false) = false or d.cancel_requested_at is not null)
         and (f ->> 'queue' is null or d.id in (
               select request_id from public.fetch_v2_q_payments() where f ->> 'queue' = 'payments'
               union all select request_id from public.fetch_v2_q_returns() where f ->> 'queue' = 'returns'
               union all select request_id from public.fetch_v2_q_cancellations() where f ->> 'queue' = 'cancellations'
               union all select request_id from public.fetch_v2_q_verification_jobs() where f ->> 'queue' = 'verification_jobs'
               union all select request_id from public.fetch_issues where status = 'open' and f ->> 'queue' = 'issues'))
         and (v_q is null or d.id::text = v_q or d.id::text like v_q || '%')
       order by d.created_at desc limit 100) x), '[]'));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. One job, everything an administrator needs (no card data exists in Fetch; only Stripe's intent state)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_admin_job(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  r     public.delivery_requests;
  t     public.fetch_v2_terms;
  a     public.fetch_authorisation_attempts;
  v_cap jsonb;
begin
  if not public.is_admin() then raise exception 'Only an administrator can do that' using errcode = '42501'; end if;
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  if r.id is null then return public.fetch_v2_refuse('not_found'); end if;
  select * into t from public.fetch_v2_terms where request_id = r.id;
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = r.id;
  v_cap := public.fetch_v2_capture_amount(r.id);

  return jsonb_build_object('ok', true,
    'summary', jsonb_build_object('request_id', r.id, 'status', r.status, 'created_at', r.created_at, 'claimed_at', r.claimed_at,
      'collected_at', r.collected_at, 'delivered_at', r.delivered_at, 'undeliverable_at', r.undeliverable_at, 'returned_at', r.returned_at,
      'cancelled_at', r.cancelled_at, 'expires_at', r.expires_at, 'cancel_requested_at', r.cancel_requested_at,
      'requester_id', r.customer_id, 'requester', public.fetch_v2_admin_name(r.customer_id),
      'driver_id', r.driver_id, 'driver', public.fetch_v2_admin_name(r.driver_id),
      'item_description', r.item_description, 'size_class', r.size_class, 'category', r.category_slug, 'handling_flags', to_jsonb(r.handling_flags),
      'route', coalesce((select name from public.regions where id = r.pickup_region_id), '?') || ' → ' || coalesce((select name from public.regions where id = r.destination_region_id), '?'),
      'ferry_required', r.ferry_required, 'scheduling_mode', r.scheduling_mode,
      'undeliverable_reason', r.undeliverable_reason, 'return_outcome', r.return_outcome, 'fault_party', r.fault_party),
    'money', jsonb_build_object('expected_total_pence', t.total_pence, 'max_hold_pence', t.max_hold_pence, 'service_fee_pence', t.service_fee_pence,
      'delivery_fee_pence', t.delivery_fee_pence, 'ferry_supplement_pence', r.ferry_supplement_pence, 'waiting_fee_pence', r.waiting_fee_pence,
      'return_fee_pence', r.return_fee_pence, 'resolution_capture_pence', r.resolution_capture_pence,
      'capture_now_pence', (v_cap ->> 'amount_pence')::integer, 'oneshetland_fee_pence', (v_cap ->> 'application_fee_pence')::integer,
      'driver_entitlement_pence', (v_cap ->> 'driver_pence')::integer),
    'payment', jsonb_build_object('payment_status', r.payment_status, 'intent_state', a.stripe_status, 'payment_intent_id', a.stripe_payment_intent_id,
      'attempt_status', a.status, 'hold_state', a.hold_state, 'generation', a.authorisation_generation, 'hold_pence', a.amount_pence,
      'capturable_pence', a.amount_capturable_pence, 'capture_deadline', a.authorisation_expires_at, 'hold_checked_at', a.hold_checked_at,
      'capture_state', a.capture_state, 'captured_pence', a.capture_amount_pence,
      'retired_generations', (select count(*) from public.fetch_authorisation_generations g where g.delivery_request_id = r.id),
      'payment_problem', (select jsonb_build_object('priority', q.priority, 'reasons', to_jsonb(q.reasons)) from public.fetch_v2_q_payments() q where q.request_id = r.id)),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.created_at, 'event', e.event, 'actor_role', e.actor_role,
        'actor_id', e.actor_id, 'actor', public.fetch_v2_admin_name(e.actor_id), 'from', e.from_status, 'to', e.to_status, 'reason', e.reason,
        'fault', e.fault_party, 'metadata', e.metadata) order by e.id) from public.fetch_request_events e where e.request_id = r.id), '[]'),
    'support', public.fetch_v2_support_record(v_uid, r.id),
    'redactions', coalesce((select jsonb_agg(jsonb_build_object('at', x.created_at, 'admin', public.fetch_v2_admin_name(x.admin_id), 'reason', x.reason,
        'original', x.original_text, 'replacement', x.replacement) order by x.id) from public.fetch_request_redactions x where x.request_id = r.id), '[]'),
    'notifications', public.fetch_v2_notification_diagnostics(r.id, null),
    'matching', case when r.driver_id is not null then public.fetch_v2_match_diagnostics(r.id, r.driver_id) end,
    'parties', jsonb_build_object(
      'requester_restricted', exists (select 1 from public.fetch_member_stats s where s.user_id = r.customer_id and s.restricted_at is not null),
      'driver_restricted', exists (select 1 from public.fetch_member_stats s where s.user_id = r.driver_id and s.restricted_at is not null),
      'driver_problem', case when r.driver_id is not null then public.fetch_v2_driver_problem(r.driver_id) end),
    'queues', jsonb_build_object(
      'payments', exists (select 1 from public.fetch_v2_q_payments() q where q.request_id = r.id),
      'returns', exists (select 1 from public.fetch_v2_q_returns() q where q.request_id = r.id),
      'cancellations', (select jsonb_build_object('priority', q.priority, 'reasons', to_jsonb(q.reasons), 'respond_by', q.respond_by)
                          from public.fetch_v2_q_cancellations() q where q.request_id = r.id),
      'verification_jobs', exists (select 1 from public.fetch_v2_q_verification_jobs() q where q.request_id = r.id)));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. A member: counters as requester and as driver, restriction state and history (read-only diagnostics, not a public score)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_admin_member(p_member uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  s  public.fetch_member_stats;
  dp public.driver_profiles;
begin
  if not public.is_admin() then raise exception 'Only an administrator can do that' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = p_member) then return public.fetch_v2_refuse('not_found'); end if;
  select * into s from public.fetch_member_stats where user_id = p_member;
  select * into dp from public.driver_profiles where id = p_member;
  return jsonb_build_object('ok', true, 'member_id', p_member, 'name', public.fetch_v2_admin_name(p_member),
    'restriction', jsonb_build_object('restricted', s.restricted_at is not null, 'since', s.restricted_at, 'reason', s.restricted_reason,
      'by', public.fetch_v2_admin_name(s.restricted_by), 'adult_confirmed', s.adult_confirmed_at is not null),
    'restriction_history', coalesce((select jsonb_agg(jsonb_build_object('at', l.created_at, 'action', l.action, 'admin', public.fetch_v2_admin_name(l.admin_id),
        'reason', l.reason) order by l.id desc) from public.fetch_member_restriction_log l where l.member_id = p_member), '[]'),
    'as_requester', jsonb_build_object(
      'requests_created', coalesce(s.requests_created, 0),
      'delivered', (select count(*) from public.delivery_requests d where d.fetch_version = 2 and d.customer_id = p_member and d.status = 'delivered'),
      'cancelled_before_accept', coalesce(s.cancels_before_accept, 0),
      'cancel_requests_after_accept', coalesce(s.cancel_requests_after_accept, 0),
      'requester_fault_returns', coalesce(s.fault_returns_requester_side, 0),
      'open_issues_on_their_jobs', (select count(*) from public.fetch_issues i join public.delivery_requests d on d.id = i.request_id
                                      where d.customer_id = p_member and i.status = 'open')),
    'as_driver', case when dp.id is null then null else jsonb_build_object(
      'driver_status', dp.driver_status, 'vehicle_class', dp.vehicle_class, 'max_size_class', dp.max_size_class,
      'verification_problem', public.fetch_v2_driver_problem(p_member), 'verified_until', dp.verification_ok_until,
      'jobs_claimed', (select count(*) from public.fetch_request_events e where e.actor_id = p_member and e.event = 'claimed'),
      'delivered', (select count(*) from public.delivery_requests d where d.fetch_version = 2 and d.driver_id = p_member and d.status = 'delivered'),
      'releases', dp.release_count, 'last_release_at', dp.last_release_at, 'driver_fault_returns', dp.fault_return_count,
      'open_issues_on_their_jobs', (select count(*) from public.fetch_issues i join public.delivery_requests d on d.id = i.request_id
                                      where d.driver_id = p_member and i.status = 'open')) end,
    'recent_jobs', coalesce((select jsonb_agg(jsonb_build_object('request_id', d.id, 'status', d.status, 'created_at', d.created_at,
        'role', case when d.customer_id = p_member then 'requester' else 'driver' end) order by d.created_at desc)
      from (select * from public.delivery_requests d where d.fetch_version = 2 and (d.customer_id = p_member or d.driver_id = p_member)
             order by d.created_at desc limit 20) d), '[]'));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. Access
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.fetch_request_redactions enable row level security;
alter table public.fetch_member_restriction_log enable row level security;
revoke all on public.fetch_request_redactions, public.fetch_member_restriction_log from public, anon, authenticated;
grant select on public.fetch_request_redactions, public.fetch_member_restriction_log to authenticated;
grant all on public.fetch_request_redactions, public.fetch_member_restriction_log to service_role;
grant usage on sequence public.fetch_request_redactions_id_seq, public.fetch_member_restriction_log_id_seq to service_role;
drop policy if exists "Fetch redactions: administrators" on public.fetch_request_redactions;
create policy "Fetch redactions: administrators" on public.fetch_request_redactions for select to authenticated using (public.is_admin());
drop policy if exists "Fetch restriction log: administrators" on public.fetch_member_restriction_log;
create policy "Fetch restriction log: administrators" on public.fetch_member_restriction_log for select to authenticated using (public.is_admin());

revoke all on function
  public.tg_fetch_admin_history_append_only(), public.fetch_v2_redact_description(uuid, uuid, text, text),
  public.fetch_v2_set_member_restriction(uuid, uuid, boolean, text), public.fetch_v2_q_payments(), public.fetch_v2_q_cancellations(),
  public.fetch_v2_q_returns(), public.fetch_v2_q_verification_jobs(), public.fetch_v2_admin_name(uuid), public.fetch_v2_admin_queues(),
  public.fetch_v2_admin_jobs(jsonb), public.fetch_v2_admin_job(uuid), public.fetch_v2_admin_member(uuid)
  from public, anon, authenticated;
grant execute on function public.fetch_v2_redact_description(uuid, uuid, text, text), public.fetch_v2_set_member_restriction(uuid, uuid, boolean, text),
  public.fetch_v2_q_payments(), public.fetch_v2_q_cancellations(), public.fetch_v2_q_returns(), public.fetch_v2_q_verification_jobs(),
  public.fetch_v2_admin_name(uuid) to service_role;
grant execute on function public.fetch_v2_admin_queues(), public.fetch_v2_admin_jobs(jsonb), public.fetch_v2_admin_job(uuid), public.fetch_v2_admin_member(uuid)
  to authenticated, service_role;

do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_redact_description(uuid, uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_set_member_restriction(uuid, uuid, boolean, text)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_admin_queues()', 'execute')
     or has_table_privilege('authenticated', 'public.fetch_request_redactions', 'insert')
     or has_table_privilege('authenticated', 'public.fetch_member_restriction_log', 'insert') then
    raise exception 'a Fetch administrator function or table is reachable by the wrong role';
  end if;
end $$;

commit;
