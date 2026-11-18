-- Editions: push notifications through the EXISTING pipeline (send-push.ts: preferences, quiet hours, fail-closed, notification_log = the notification centre).
-- Nothing here sends anything. It holds the database half of two features, both dark until Editions is on:
--
--   1. FOLLOWERS. People who saved a PUBLISHED, public Edition are told when its organiser posts an update. The edge function notify-edition-update (called by the website right after
--      the update is posted, exactly like notify-event-update) asks this migration (a) whether the caller may notify, and (b) for the ONE-TIME claim that makes a send happen at most once per
--      update (edition_update_notifications.update_id is the primary key) and returns the recipients. The claim refuses an Edition that is not public right now, an update not yet published,
--      an update older than two days, and more than three notified updates for one Edition in 24 hours.
--   2. ORGANISERS. Review decisions (approved, changes requested, rejected) and package activation already queue emails in edition_email_outbox. A trigger on that table queues the SAME people
--      (same dedupe: it only fires for a row the email queue really inserted) in edition_push_outbox; the edge function editions-push-cron drains it with the service-role key. A row is claimed
--      once and never re-claimed (a crash loses a best-effort push, never doubles one); email stays the reliable channel. Rows older than a day, or for someone no longer on the team, are skipped.
-- Expand-only. Rollback: supabase/rollbacks/20270104030000_editions_push_notifications.rollback.sql

-- ── 1. followers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.edition_update_notifications (
  update_id    uuid primary key references public.edition_updates (id) on delete cascade,
  edition_id   uuid not null references public.editions (id) on delete cascade,
  claimed_by   uuid references auth.users (id) on delete set null,
  claimed_at   timestamptz not null default now(),
  recipients   integer not null default 0 check (recipients >= 0),
  sent         integer check (sent >= 0),
  skipped      integer check (skipped >= 0),
  errored      integer check (errored >= 0),
  completed_at timestamptz
);
create index if not exists edition_update_notifications_edition_idx on public.edition_update_notifications (edition_id, claimed_at desc);
alter table public.edition_update_notifications enable row level security;
revoke all on public.edition_update_notifications from public, anon, authenticated;

-- who may notify followers about an update: a platform administrator, anyone on the organiser's team (helpers of any role), or the Hub / Business people who can act for it
create or replace function public.edition_update_notify_authorised(p_update uuid, p_user uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  if p_update is null or p_user is null then return false; end if;
  select e.organiser_id into v_org from public.edition_updates u join public.editions e on e.id = u.edition_id where u.id = p_update;
  if v_org is null then return false; end if;
  if exists (select 1 from public.profiles where id = p_user and (role = 'admin' or is_platform_owner is true)) then return true; end if;
  if exists (select 1 from public.edition_organiser_members m where m.organiser_id = v_org and m.user_id = p_user) then return true; end if;
  return exists (select 1 from public.edition_org_admin_users(v_org) x(uid) where x.uid = p_user);
end $$;

-- the one-time claim. Never raises for an ordinary refusal: it answers with a status the function can log.
create or replace function public.edition_update_notify_claim(p_update uuid, p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.edition_updates%rowtype; e public.editions%rowtype; v_n integer; v_rec uuid[];
begin
  select * into u from public.edition_updates where id = p_update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into e from public.editions where id = u.edition_id;
  if not public.edition_is_public(e.id) then return jsonb_build_object('status', 'not_public'); end if;
  if u.published_at is null or u.published_at > now() then return jsonb_build_object('status', 'not_published'); end if;
  if u.published_at < now() - interval '2 days' then return jsonb_build_object('status', 'stale'); end if;
  if (select count(*) from public.edition_update_notifications n where n.edition_id = e.id and n.claimed_at > now() - interval '24 hours') >= 3 then
    return jsonb_build_object('status', 'too_many');
  end if;
  insert into public.edition_update_notifications (update_id, edition_id, claimed_by) values (u.id, e.id, p_actor) on conflict (update_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('status', 'already'); end if;
  select coalesce(array_agg(s.user_id), '{}') into v_rec
    from (select user_id from public.edition_saves where edition_id = e.id and user_id is distinct from p_actor order by created_at limit 5000) s;
  update public.edition_update_notifications set recipients = coalesce(array_length(v_rec, 1), 0) where update_id = u.id;
  return jsonb_build_object('status', 'claimed', 'edition_id', e.id, 'edition_slug', e.slug, 'edition_title', e.title, 'update_title', u.title, 'recipients', to_jsonb(v_rec));
end $$;

create or replace function public.edition_update_notify_complete(p_update uuid, p_sent integer, p_skipped integer, p_errored integer) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_update_notifications set sent = greatest(p_sent, 0), skipped = greatest(p_skipped, 0), errored = greatest(p_errored, 0), completed_at = now() where update_id = p_update and completed_at is null
$$;

-- ── 2. organisers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.edition_push_outbox (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('edition_approved', 'edition_changes_requested', 'edition_rejected', 'package_active')),
  user_id      uuid not null references auth.users (id) on delete cascade,
  organiser_id uuid not null references public.edition_organisers (id) on delete cascade,
  edition_id   uuid not null references public.editions (id) on delete cascade,
  dedupe_key   text not null unique,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  done_at      timestamptz,
  outcome      text
);
create index if not exists edition_push_outbox_pending_idx on public.edition_push_outbox (id) where claimed_at is null;
alter table public.edition_push_outbox enable row level security;
revoke all on public.edition_push_outbox from public, anon, authenticated;
revoke all on sequence public.edition_push_outbox_id_seq from public, anon, authenticated;

-- queue a push for exactly the rows the email queue accepted (its dedupe key already made them once-only). Holds ids only: no title, no note, no address.
create or replace function public.edition_push_from_email() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ed uuid; v_org uuid;
begin
  if new.kind not in ('edition_approved', 'edition_changes_requested', 'edition_rejected', 'package_active') or new.user_id is null then return new; end if;
  select e.id, e.organiser_id into v_ed, v_org from public.editions e where e.slug = new.payload ->> 'edition_slug';
  if v_ed is null then return new; end if;
  insert into public.edition_push_outbox (kind, user_id, organiser_id, edition_id, dedupe_key) values (new.kind, new.user_id, v_org, v_ed, new.dedupe_key) on conflict (dedupe_key) do nothing;
  return new;
end $$;
drop trigger if exists edition_push_from_email on public.edition_email_outbox;
create trigger edition_push_from_email after insert on public.edition_email_outbox for each row execute function public.edition_push_from_email();

-- the next pushes to send. Does nothing while Editions is off. Each row is claimed once; a row that is stale or whose person is no longer on the team is closed without a send.
create or replace function public.edition_push_next(p_limit integer default 25)
returns table (id bigint, kind text, user_id uuid, edition_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  if not public.editions_enabled() then return; end if;
  for r in
    with c as (
      update public.edition_push_outbox o set claimed_at = now()
       where o.id in (select x.id from public.edition_push_outbox x where x.claimed_at is null order by x.id limit least(greatest(p_limit, 1), 100) for update skip locked)
      returning o.id as oid, o.kind as okind, o.user_id as ouser, o.organiser_id as oorg, o.edition_id as oed, o.created_at as ocreated)
    select * from c order by oid
  loop
    if r.ocreated < now() - interval '1 day' then
      update public.edition_push_outbox set done_at = now(), outcome = 'skipped_stale' where edition_push_outbox.id = r.oid;
    elsif not exists (select 1 from public.edition_org_admin_users(r.oorg) a(uid) where a.uid = r.ouser) then
      update public.edition_push_outbox set done_at = now(), outcome = 'skipped_not_on_team' where edition_push_outbox.id = r.oid;
    else
      id := r.oid; kind := r.okind; user_id := r.ouser; edition_id := r.oed; return next;
    end if;
  end loop;
end $$;

create or replace function public.edition_push_mark(p_id bigint, p_outcome text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_push_outbox set done_at = now(), outcome = left(coalesce(p_outcome, 'unknown'), 40) where id = p_id and done_at is null
$$;

-- ── privileges: only the service role (the two edge functions) may call any of this ───────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array['edition_update_notify_authorised(uuid,uuid)', 'edition_update_notify_claim(uuid,uuid)', 'edition_update_notify_complete(uuid,integer,integer,integer)',
    'edition_push_from_email()', 'edition_push_next(integer)', 'edition_push_mark(bigint,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['edition_update_notify_authorised(uuid,uuid)', 'edition_update_notify_claim(uuid,uuid)', 'edition_update_notify_complete(uuid,integer,integer,integer)',
      'edition_push_next(integer)', 'edition_push_mark(bigint,text)'] loop
      execute format('grant execute on function public.%s to service_role', f);
    end loop;
  end if;
end $$;
