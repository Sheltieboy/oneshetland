-- OneShetland Editions R5: operations. Transactional email outbox (queue only: nothing is sent by the database), organiser analytics with small-number masking,
-- and invitation naming for people invited to an organiser team.
--
-- The outbox stores WHO (a user id), WHAT (a template key) and the facts a template needs (titles, names). It never stores an email address or a message body:
-- addresses are resolved only at the moment a (not yet deployed) sender function renders and sends, and templates live in code where they can be tested.

create table if not exists public.edition_email_outbox (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind ~ '^[a-z0-9_]{3,60}$'),
  user_id      uuid not null references auth.users (id) on delete cascade,
  dedupe_key   text not null unique,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  attempts     integer not null default 0,
  last_error   text
);
create index if not exists edition_email_outbox_pending_idx on public.edition_email_outbox (created_at) where sent_at is null;
alter table public.edition_email_outbox enable row level security;
revoke all on public.edition_email_outbox from public, anon, authenticated;
revoke all on sequence public.edition_email_outbox_id_seq from public, anon, authenticated;

create or replace function public.edition_enqueue_email(p_kind text, p_user uuid, p_key text, p_payload jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.edition_email_outbox (kind, user_id, dedupe_key, payload) select p_kind, p_user, p_key, coalesce(p_payload, '{}'::jsonb) where p_user is not null on conflict (dedupe_key) do nothing
$$;
-- everyone who can act for an organiser at admin level or above
create or replace function public.edition_org_admin_users(p_org uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id from public.edition_organiser_members m where m.organiser_id = p_org and m.role in ('owner', 'admin')
$$;
-- the user who can answer for a business / event / activity
create or replace function public.edition_subject_controller(p_kind text, p_business uuid, p_event uuid, p_activity uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_kind
    when 'business' then (select b.owner_id from public.local_businesses b where b.id = p_business)
    when 'event' then (select coalesce(b.owner_id, h.owner_id) from public.events e left join public.local_businesses b on b.id = e.organiser_business_id left join public.hubs h on h.id = e.organiser_hub_id where e.id = p_event)
    when 'activity' then (select coalesce(b.owner_id, h.owner_id) from public.regular_activities a left join public.local_businesses b on b.id = a.organiser_business_id left join public.hubs h on h.id = a.organiser_hub_id where a.id = p_activity) end
$$;
create or replace function public.edition_subject_name(p_kind text, p_business uuid, p_event uuid, p_activity uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_kind when 'business' then (select name from public.local_businesses where id = p_business) when 'event' then (select title from public.events where id = p_event) when 'activity' then (select title from public.regular_activities where id = p_activity) end
$$;

-- ── partnerships ────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_links_email() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_name text; v_ctrl uuid; u uuid; v_payload jsonb;
begin
  select * into e from public.editions where id = new.edition_id; select * into o from public.edition_organisers where id = e.organiser_id;
  v_name := public.edition_subject_name(new.kind, new.business_id, new.event_id, new.activity_id);
  v_ctrl := public.edition_subject_controller(new.kind, new.business_id, new.event_id, new.activity_id);
  v_payload := jsonb_build_object('edition_title', e.title, 'organiser_name', o.name, 'subject_kind', new.kind, 'subject_name', v_name, 'link_id', new.id);
  if tg_op = 'INSERT' then
    if new.state = 'pending' and new.initiated_by = 'organiser' then perform public.edition_enqueue_email('partner_invited', v_ctrl, 'pi:' || new.id, v_payload); end if;
    if new.state = 'pending' and new.initiated_by = 'entity' then for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_requested', u, 'pr:' || new.id || ':' || u, v_payload); end loop; end if;
  elsif new.state is distinct from old.state then
    if new.state in ('approved', 'declined') and old.state = 'pending' then
      if new.initiated_by = 'organiser' then for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_answered', u, 'pa:' || new.id || ':' || new.state || ':' || u, v_payload || jsonb_build_object('answer', new.state)); end loop;
      else perform public.edition_enqueue_email('partner_request_answered', v_ctrl, 'pq:' || new.id || ':' || new.state, v_payload || jsonb_build_object('answer', new.state)); end if;
    elsif new.state = 'withdrawn' and new.ended_by = 'entity' then
      for u in select * from public.edition_org_admin_users(e.organiser_id) loop perform public.edition_enqueue_email('partner_withdrew', u, 'pw:' || new.id || ':' || u, v_payload); end loop;
    elsif new.state = 'withdrawn' and new.ended_by = 'organiser' then perform public.edition_enqueue_email('partner_removed', v_ctrl, 'pm:' || new.id, v_payload);
    end if;
  end if;
  return new;
end $$;
create trigger zz_edition_links_email after insert or update of state on public.edition_links for each row execute function public.edition_links_email();

-- ── memberships ─────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.organiser_memberships_email() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_organisers%rowtype; t public.organiser_membership_tiers%rowtype; b public.local_businesses%rowtype; u uuid; v_payload jsonb;
begin
  select * into o from public.edition_organisers where id = new.organiser_id; select * into t from public.organiser_membership_tiers where id = new.tier_id; select * into b from public.local_businesses where id = new.business_id;
  v_payload := jsonb_build_object('organiser_name', o.name, 'tier_name', t.name, 'business_name', b.name, 'membership_id', new.id, 'period_end', new.current_period_end);
  if tg_op = 'INSERT' then
    if new.status = 'invited' then perform public.edition_enqueue_email('membership_invited', b.owner_id, 'mi:' || new.id, v_payload);
    elsif new.status = 'applied' then for u in select * from public.edition_org_admin_users(new.organiser_id) loop perform public.edition_enqueue_email('membership_applied', u, 'ma:' || new.id || ':' || u, v_payload); end loop; end if;
  elsif new.status is distinct from old.status then
    if old.status = 'applied' and new.status in ('pending_payment', 'active') then perform public.edition_enqueue_email('membership_approved', b.owner_id, 'mp:' || new.id, v_payload);
    elsif old.status = 'applied' and new.status = 'declined' then perform public.edition_enqueue_email('membership_declined', b.owner_id, 'md:' || new.id, v_payload);
    elsif new.status = 'active' and old.status = 'pending_payment' then perform public.edition_enqueue_email('membership_welcome', b.owner_id, 'mw:' || new.id || ':' || coalesce(new.current_period_start::text, ''), v_payload);
    elsif new.status = 'past_due' then perform public.edition_enqueue_email('membership_payment_failed', b.owner_id, 'mf:' || new.id || ':' || coalesce(new.past_due_since::text, ''), v_payload);
    elsif new.status = 'expired' then perform public.edition_enqueue_email('membership_expired', b.owner_id, 'mx:' || new.id || ':' || coalesce(new.current_period_end::text, ''), v_payload);
    elsif new.status = 'cancelled' and new.cancel_requested_at is not null and new.decided_by is not null and new.decision_note is not null then perform public.edition_enqueue_email('membership_ended', b.owner_id, 'me:' || new.id || ':' || coalesce(new.updated_at::text, ''), v_payload || jsonb_build_object('note', new.decision_note));
    end if;
  end if;
  return new;
end $$;
create trigger zz_organiser_memberships_email after insert or update of status on public.organiser_memberships for each row execute function public.organiser_memberships_email();

-- ── receipts ────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_payments_email() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_organisers%rowtype; b public.local_businesses%rowtype; v_label text;
begin
  if new.source <> 'stripe' or new.status <> 'succeeded' then return new; end if;
  select * into o from public.edition_organisers where id = new.organiser_id; select * into b from public.local_businesses where id = new.business_id;
  v_label := case new.kind when 'membership' then (select t.name from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id where m.id = new.ref_id)
                         else (select e.title from public.edition_participations x join public.editions e on e.id = x.edition_id where x.id = new.ref_id) end;
  perform public.edition_enqueue_email('payment_receipt', coalesce(new.payer_user_id, b.owner_id), 'rc:' || new.id,
    jsonb_build_object('organiser_name', o.name, 'business_name', b.name, 'label', v_label, 'kind', new.kind, 'charge_pence', new.charge_pence, 'vat_pence', new.vat_pence, 'payment_id', new.id,
      'legal_name', (select a.legal_name from public.edition_payout_accounts a where a.organiser_id = new.organiser_id), 'vat_number', (select a.vat_number from public.edition_payout_accounts a where a.organiser_id = new.organiser_id)));
  return new;
end $$;
create trigger zz_edition_payments_email after insert on public.edition_payments for each row execute function public.edition_payments_email();

-- Reminders for hand-renewed memberships (service role; drives off the reminders already tracked in R4c).
create or replace function public.edition_membership_enqueue_reminders() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0; v_org text; v_tier text; v_biz text; v_owner uuid;
begin
  for r in select * from public.edition_membership_reminders_due() loop
    select o.name, t.name, b.name, b.owner_id into v_org, v_tier, v_biz, v_owner from public.organiser_memberships m join public.edition_organisers o on o.id = m.organiser_id join public.organiser_membership_tiers t on t.id = m.tier_id join public.local_businesses b on b.id = m.business_id where m.id = r.membership_id;
    perform public.edition_enqueue_email('membership_renewal_' || replace(r.kind, 'renewal_', ''), v_owner, 'mr:' || r.membership_id || ':' || r.kind || ':' || r.period_end::text,
      jsonb_build_object('organiser_name', v_org, 'tier_name', v_tier, 'business_name', v_biz, 'period_end', r.period_end, 'membership_id', r.membership_id));
    perform public.edition_membership_reminder_sent(r.membership_id, r.kind, r.period_end);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Sender side (service role): the next unsent messages WITH the address, resolved only now; mark results.
create or replace function public.edition_email_next(p_limit integer default 25) returns table (id bigint, kind text, user_id uuid, email text, payload jsonb, attempts integer)
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select o.id, o.kind, o.user_id, u.email::text, o.payload, o.attempts from public.edition_email_outbox o join auth.users u on u.id = o.user_id
   where o.sent_at is null and o.attempts < 5 and u.email is not null order by o.created_at limit least(greatest(p_limit, 1), 100)
$$;
create or replace function public.edition_email_mark(p_id bigint, p_ok boolean, p_error text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_email_outbox set attempts = attempts + 1, sent_at = case when p_ok then now() end, last_error = case when p_ok then null else left(p_error, 300) end where id = p_id and sent_at is null
$$;

-- ── analytics for organisers: aggregates only, small counts masked ───────────────────────────────────────────────────
-- Counts below 5 are returned as masked (value null), so a tiny audience can never be identified. Saves and plan additions are exact counts of rows, never of people lists.
create or replace function public.edition_org_analytics(p_org uuid, p_edition uuid default null, p_days integer default 30)
returns table (metric text, value integer, masked boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_from timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    with ev as (select e.id from public.editions e where e.organiser_id = p_org and (p_edition is null or e.id = p_edition)),
    raw (metric, n) as (
      select 'page_views', (select count(*) from public.analytics_events a where a.event_name = 'edition_viewed' and a.object_type = 'edition' and a.object_id in (select id::text from ev) and a.occurred_at >= v_from)
      union all select 'programme_views', (select count(*) from public.analytics_events a where a.event_name = 'edition_session_viewed' and a.object_id in (select id::text from ev) and a.occurred_at >= v_from)
      union all select 'ticket_clicks', (select count(*) from public.analytics_events a where a.event_name = 'ticket_outbound_clicked' and a.object_type = 'edition' and a.object_id in (select id::text from ev) and a.occurred_at >= v_from)
      union all select 'calendar_downloads', (select count(*) from public.analytics_events a where a.event_name = 'edition_calendar_exported' and a.object_id in (select id::text from ev) and a.occurred_at >= v_from)
      union all select 'saves', (select count(*) from public.edition_saves s where s.edition_id in (select id from ev))
      union all select 'plan_additions', (select count(*) from public.edition_plan_items p where p.edition_id in (select id from ev))
      union all select 'partners_taking_part', (select count(*) from public.edition_links l where l.edition_id in (select id from ev) and l.state = 'approved' and public.edition_participation_ok(l.id))
      union all select 'partners_waiting', (select count(*) from public.edition_links l where l.edition_id in (select id from ev) and l.state = 'pending')
      union all select 'sessions', (select count(*) from public.edition_sessions s where s.edition_id in (select id from ev)))
    select r.metric, case when r.metric in ('page_views', 'programme_views', 'ticket_clicks', 'calendar_downloads', 'saves', 'plan_additions') and r.n < 5 then null else r.n::int end,
           (r.metric in ('page_views', 'programme_views', 'ticket_clicks', 'calendar_downloads', 'saves', 'plan_additions') and r.n < 5) from raw r;
end $$;

-- ── invitations to an organiser team: show WHO is inviting ──────────────────────────────────────────────────────────
create or replace function public.edition_my_org_invites() returns table (invite_id uuid, organiser_id uuid, organiser_name text, role text, expires_at timestamptz)
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select i.id, i.organiser_id, o.name, i.role, i.expires_at from public.edition_organiser_invites i join public.edition_organisers o on o.id = i.organiser_id
   where auth.uid() is not null and i.status = 'pending' and i.expires_at > now() and i.email = (select lower(u.email) from auth.users u where u.id = auth.uid()) order by i.created_at desc
$$;

do $$ declare f text; begin
  foreach f in array array['edition_enqueue_email(text,uuid,text,jsonb)', 'edition_org_admin_users(uuid)', 'edition_subject_controller(text,uuid,uuid,uuid)', 'edition_subject_name(text,uuid,uuid,uuid)', 'edition_links_email()', 'organiser_memberships_email()', 'edition_payments_email()',
    'edition_membership_enqueue_reminders()', 'edition_email_next(integer)', 'edition_email_mark(bigint,boolean,text)', 'edition_org_analytics(uuid,uuid,integer)', 'edition_my_org_invites()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['edition_membership_enqueue_reminders()', 'edition_email_next(integer)', 'edition_email_mark(bigint,boolean,text)'] loop execute format('grant execute on function public.%s to service_role', f); end loop;
  foreach f in array array['edition_org_analytics(uuid,uuid,integer)', 'edition_my_org_invites()'] loop execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;
