-- Editions: every Edition is reviewed and approved by OneShetland before it can be public, enforced in the database.
--
-- Lifecycle (owner's view): Draft -> In review -> (Changes requested -> In review) -> Approved -> Live. `status` (draft/published/archived/suspended) is untouched; a new review_state rides beside it:
--   not_submitted | submitted | changes_requested | approved | rejected
--   * Only the SECURITY DEFINER functions below can change review_state (clients have no column grant), and every transition is written to the append-only edition_reviews history.
--   * An Edition is public only when it is published AND approved AND entitled AND its organiser is verified AND its parent Business/Hub is live AND Editions is open. That single rule
--     (edition_is_public) drives every public table, view and function, so a URL, an API call or a direct table read cannot show an unapproved Edition.
--   * Publishing (status -> published) is refused by the existing publish-gate trigger unless the Edition is approved and the parent is live (plus the existing verified-organiser, package and
--     summary rules). The owner chooses when to publish.
--   * Material changes to an approved Edition (title, kind, dates) send it back to review and it is hidden until re-approved; the change is recorded with before/after values.
--   * Approving the first Edition also records the organiser's identity check, in the same transaction, so there is no separate "verify" step for an administrator.
-- The pilot clause is no longer part of the public rule. Expand-only. Rollback: supabase/rollbacks/20270103020000_editions_review.rollback.sql

alter table public.editions
  add column if not exists review_state text not null default 'not_submitted',
  add column if not exists submitted_at timestamptz,
  add column if not exists approved_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'editions_review_state_check') then
    alter table public.editions add constraint editions_review_state_check check (review_state in ('not_submitted', 'submitted', 'changes_requested', 'approved', 'rejected'));
  end if;
end $$;
-- Editions already published keep working: they are grandfathered as approved (none is public in production today).
update public.editions set review_state = 'approved', approved_at = coalesce(published_at, now()) where status = 'published' and review_state = 'not_submitted';

-- ── history ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.edition_reviews (
  id           uuid primary key default gen_random_uuid(),
  edition_id   uuid not null references public.editions (id) on delete cascade,
  organiser_id uuid not null references public.edition_organisers (id) on delete restrict,
  action       text not null check (action in ('submitted', 'withdrawn', 'approved', 'changes_requested', 'rejected', 'material_change', 'identity_verified')),
  actor        uuid references auth.users (id) on delete set null,
  note         text check (note is null or char_length(note) <= 1000),
  checks       jsonb,
  changes      jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists edition_reviews_edition_idx on public.edition_reviews (edition_id, created_at desc);
alter table public.edition_reviews enable row level security;
drop policy if exists "edition_reviews read" on public.edition_reviews;
create policy "edition_reviews read" on public.edition_reviews for select to authenticated using (public.edition_org_can(organiser_id, 'editor') or public.edition_staff());
revoke all on public.edition_reviews from public, anon, authenticated;
grant select on public.edition_reviews to authenticated;
create or replace function public.edition_reviews_append_only() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'review history is append-only' using errcode = '42501'; end $$;
drop trigger if exists edition_reviews_no_update on public.edition_reviews;
create trigger edition_reviews_no_update before update on public.edition_reviews for each row execute function public.edition_reviews_append_only();

-- ── readiness (what the owner sees, and what must be true to submit) ─────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_readiness_items(p_edition uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_pages int; v_sessions int; v_dupe int;
begin
  select * into e from public.editions where id = p_edition;
  if not found then return '[]'::jsonb; end if;
  select * into o from public.edition_organisers where id = e.organiser_id;
  select count(*) into v_pages from public.edition_pages where edition_id = p_edition;
  select count(*) into v_sessions from public.edition_sessions where edition_id = p_edition;
  select count(*) into v_dupe from public.editions x where x.organiser_id = e.organiser_id and x.id <> e.id and x.status <> 'archived' and lower(btrim(x.title)) = lower(btrim(e.title)) and x.starts_on <= e.ends_on and x.ends_on >= e.starts_on;
  return jsonb_build_array(
    jsonb_build_object('key', 'summary',   'label', 'Summary written',        'required', true,  'ok', coalesce(btrim(e.summary), '') <> '', 'hint', 'One or two sentences that appear in lists and search.'),
    jsonb_build_object('key', 'page',      'label', 'At least one page',      'required', true,  'ok', v_pages > 0, 'hint', 'A welcome page gives visitors somewhere to start.'),
    jsonb_build_object('key', 'dates',     'label', 'Dates still ahead',      'required', true,  'ok', e.ends_on >= current_date, 'hint', 'An Edition that has already finished cannot be submitted.'),
    jsonb_build_object('key', 'parent',    'label', 'Your Business or Hub is active', 'required', true, 'ok', public.edition_parent_live(e.organiser_id), 'hint', 'The Business or Hub that runs Editions must be active.'),
    jsonb_build_object('key', 'standing',  'label', 'Your Editions profile is in good standing', 'required', true, 'ok', o.status in ('pending', 'verified'), 'hint', 'Contact OneShetland support about your Editions profile.'),
    jsonb_build_object('key', 'cover',     'label', 'Cover image added',      'required', false, 'ok', coalesce(btrim(e.cover_url), '') <> '', 'hint', 'Recommended; it makes the Edition easier to recognise.'),
    jsonb_build_object('key', 'programme', 'label', 'Programme started',      'required', false, 'ok', v_sessions > 0, 'hint', 'Add at least one session so people can plan.'),
    jsonb_build_object('key', 'duplicate', 'label', 'Not a duplicate',        'required', false, 'ok', v_dupe = 0, 'hint', 'Another Edition of yours has the same title on overlapping dates.'));
end $$;

create or replace function public.edition_readiness(p_edition uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_can(p_edition, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return public.edition_readiness_items(p_edition);
end $$;

-- ── owner actions ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_submit_for_review(p_edition uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; v_items jsonb; v_missing text; v_recent int;
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'admin') then raise exception 'organiser admins only' using errcode = '42501'; end if;
  select * into e from public.editions where id = p_edition for update;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.status in ('suspended', 'archived') then raise exception 'this Edition cannot be submitted while it is %', e.status using errcode = '23514', hint = 'bad_status'; end if;
  if e.review_state = 'submitted' then raise exception 'already submitted for review' using errcode = '23514', hint = 'already_submitted'; end if;
  if e.review_state = 'approved' then raise exception 'already approved' using errcode = '23514', hint = 'already_approved'; end if;
  select count(*) into v_recent from public.edition_reviews r where r.edition_id = p_edition and r.action = 'submitted' and r.created_at > now() - interval '24 hours';
  if v_recent >= 5 then raise exception 'too many submissions today; wait before submitting again' using errcode = '53400', hint = 'submit_limit'; end if;
  v_items := public.edition_readiness_items(p_edition);
  select string_agg(i ->> 'label', ', ') into v_missing from jsonb_array_elements(v_items) i where (i ->> 'required')::boolean and not (i ->> 'ok')::boolean;
  if v_missing is not null then raise exception 'finish these first: %', v_missing using errcode = '23514', hint = 'not_ready'; end if;
  update public.editions set review_state = 'submitted', submitted_at = now() where id = p_edition;
  insert into public.edition_reviews (edition_id, organiser_id, action, actor, checks) values (p_edition, e.organiser_id, 'submitted', auth.uid(), v_items);
  perform public.edition_audit(e.organiser_id, p_edition, 'edition_submitted', jsonb_build_object('title', e.title));
end $$;

create or replace function public.edition_withdraw_submission(p_edition uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_can(p_edition, 'admin') then raise exception 'organiser admins only' using errcode = '42501'; end if;
  select * into e from public.editions where id = p_edition for update;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.review_state <> 'submitted' then raise exception 'this Edition is not waiting for review' using errcode = '23514', hint = 'not_submitted'; end if;
  -- an approved Edition that was sent back for a material change returns to approved-state only by an administrator; withdrawing is for a first submission or a resubmission
  update public.editions set review_state = 'not_submitted', submitted_at = null where id = p_edition;
  insert into public.edition_reviews (edition_id, organiser_id, action, actor) values (p_edition, e.organiser_id, 'withdrawn', auth.uid());
  perform public.edition_audit(e.organiser_id, p_edition, 'edition_submission_withdrawn', '{}'::jsonb);
end $$;

-- the owner's view of where the review stands, including the reviewer's last message
create or replace function public.edition_review_status(p_edition uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; r public.edition_reviews%rowtype;
begin
  if auth.uid() is null or not (public.edition_can(p_edition, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  select * into r from public.edition_reviews x where x.edition_id = p_edition and x.action in ('approved', 'changes_requested', 'rejected', 'material_change') order by x.created_at desc limit 1;
  return jsonb_build_object('state', e.review_state, 'submitted_at', e.submitted_at, 'approved_at', e.approved_at,
    'last_decision', r.action, 'last_note', case when r.action in ('changes_requested', 'rejected', 'approved') then r.note end, 'last_at', r.created_at,
    'material', coalesce((select (x.action = 'material_change') from public.edition_reviews x where x.edition_id = p_edition order by x.created_at desc limit 1), false),
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', h.action, 'at', h.created_at, 'note', case when h.action in ('changes_requested', 'rejected', 'approved') then h.note end) order by h.created_at desc)
                           from (select * from public.edition_reviews x where x.edition_id = p_edition order by x.created_at desc limit 20) h), '[]'::jsonb));
end $$;

-- ── the administrator's decision (identity check included) ───────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_review_edition(p_edition uuid, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_items jsonb; v_rev uuid; v_kind text; v_to uuid; v_subject text;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_decision not in ('approve', 'changes', 'reject') then raise exception 'bad decision' using errcode = '22023'; end if;
  select * into e from public.editions where id = p_edition for update;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.review_state <> 'submitted' then raise exception 'this Edition is not waiting for review' using errcode = '23514', hint = 'not_submitted'; end if;
  select * into o from public.edition_organisers where id = e.organiser_id for update;
  if p_decision in ('changes', 'reject') and char_length(coalesce(v_note, '')) < 5 then raise exception 'tell the organiser why (at least 5 characters)' using errcode = '23514', hint = 'note_required'; end if;
  v_items := public.edition_readiness_items(p_edition);
  if p_decision = 'approve' then
    if not public.edition_parent_live(o.id) then raise exception 'the Business or Hub is not active' using errcode = '23514', hint = 'parent_not_live'; end if;
    if o.status in ('suspended', 'rejected') then raise exception 'the organiser is % ; reinstate it first', o.status using errcode = '23514', hint = 'organiser_standing'; end if;
    if o.is_test then raise exception 'a test organiser cannot be approved for the public' using errcode = '23514', hint = 'test_organiser'; end if;
    if o.status = 'pending' then
      if o.reserved_name_flag and char_length(coalesce(v_note, '')) < 10 then raise exception 'this name matches a reserved list: write a note of at least 10 characters saying how you checked' using errcode = '23514', hint = 'reserved_note_required'; end if;
      update public.edition_organisers set status = 'verified', verified_at = now(), verified_by = auth.uid(), verification_note = 'Verified with the first Edition approval' || coalesce(': ' || v_note, '') where id = o.id;
      insert into public.edition_reviews (edition_id, organiser_id, action, actor, note) values (p_edition, o.id, 'identity_verified', auth.uid(), v_note);
    end if;
    update public.editions set review_state = 'approved', approved_at = now() where id = p_edition;
  else
    update public.editions set review_state = case p_decision when 'changes' then 'changes_requested' else 'rejected' end where id = p_edition;
  end if;
  insert into public.edition_reviews (edition_id, organiser_id, action, actor, note, checks)
    values (p_edition, o.id, case p_decision when 'approve' then 'approved' when 'changes' then 'changes_requested' else 'rejected' end, auth.uid(), v_note, v_items) returning id into v_rev;
  perform public.edition_audit(o.id, p_edition, 'edition_review_' || p_decision, jsonb_build_object('title', e.title));
  v_kind := case p_decision when 'approve' then 'edition_approved' when 'changes' then 'edition_changes_requested' else 'edition_rejected' end;
  v_subject := case when o.hub_id is not null then 'hub' else 'business' end;
  for v_to in select * from public.edition_org_admin_users(o.id) loop
    perform public.edition_enqueue_email(v_kind, v_to, 'edrev:' || v_rev || ':' || v_to, jsonb_build_object('edition_title', e.title, 'edition_slug', e.slug, 'organiser_slug', o.slug, 'organiser_name', o.name, 'note', case when p_decision = 'approve' then null else v_note end, 'subject_kind', v_subject));
  end loop;
end $$;

-- ── material changes send an approved Edition back to review (and hide it until re-approved) ────────────────────────────────────────────────────
create or replace function public.edition_material_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_changes jsonb := '{}'::jsonb;
begin
  if old.review_state = 'approved' and new.review_state = 'approved' then
    if new.title is distinct from old.title then v_changes := v_changes || jsonb_build_object('title', jsonb_build_object('from', old.title, 'to', new.title)); end if;
    if new.kind is distinct from old.kind then v_changes := v_changes || jsonb_build_object('kind', jsonb_build_object('from', old.kind, 'to', new.kind)); end if;
    if new.starts_on is distinct from old.starts_on then v_changes := v_changes || jsonb_build_object('starts_on', jsonb_build_object('from', old.starts_on, 'to', new.starts_on)); end if;
    if new.ends_on is distinct from old.ends_on then v_changes := v_changes || jsonb_build_object('ends_on', jsonb_build_object('from', old.ends_on, 'to', new.ends_on)); end if;
    if v_changes <> '{}'::jsonb then
      new.review_state := 'submitted'; new.submitted_at := now();
      insert into public.edition_reviews (edition_id, organiser_id, action, actor, changes) values (new.id, new.organiser_id, 'material_change', auth.uid(), v_changes);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ac_editions_material_change on public.editions;
create trigger ac_editions_material_change before update of title, kind, starts_on, ends_on on public.editions for each row execute function public.edition_material_change();

-- ── the publish gate: approval and a live parent join the existing rules ────────────────────────────────────────────────────────────────────────
create or replace function public.editions_publish_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_organisers%rowtype;
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    select * into o from public.edition_organisers where id = new.organiser_id;
    if o.status <> 'verified' then raise exception 'organiser is not verified' using errcode = '42501'; end if;
    if new.review_state is distinct from 'approved' then raise exception 'this Edition has not been approved by OneShetland yet' using errcode = '42501', hint = 'not_approved'; end if;
    if not public.edition_parent_live(o.id) then raise exception 'the Business or Hub is not active' using errcode = '42501', hint = 'parent_not_live'; end if;
    if not public.edition_entitled(new.id, 'publish') then raise exception 'no live publish entitlement for this edition' using errcode = '42501'; end if;
    if coalesce(btrim(new.summary), '') = '' then raise exception 'a summary is required before publishing' using errcode = '23514'; end if;
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end $$;

-- ── the one public rule ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edition_is_public(p_edition uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.editions e join public.edition_organisers o on o.id = e.organiser_id
     where e.id = p_edition and e.status = 'published' and e.review_state = 'approved' and not e.is_test and not o.is_test and o.status = 'verified'
       and public.editions_enabled() and public.edition_parent_live(o.id) and public.edition_entitled(e.id, 'publish'))
$$;
drop policy if exists "edition_organisers public read" on public.edition_organisers;
create policy "edition_organisers public read" on public.edition_organisers for select to anon, authenticated
  using (public.editions_enabled() and status = 'verified' and not is_test and public.edition_parent_live(id));

-- ── the administrator's queue and review screen ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_edition_review_queue(p_tab text default 'waiting') returns table (
  edition_id uuid, title text, slug text, kind text, starts_on date, ends_on date, organiser_id uuid, organiser_name text, parent_kind text, parent_name text,
  review_state text, status text, submitted_at timestamptz, decided_at timestamptz, waiting_days integer, material boolean, reserved boolean, first_edition boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  return query
  select e.id, e.title, e.slug, e.kind, e.starts_on, e.ends_on, o.id, o.name, case when o.hub_id is not null then 'hub' else 'business' end,
         coalesce(h.name, b.name), e.review_state, e.status, e.submitted_at, lr.created_at, greatest(0, (current_date - e.submitted_at::date))::int,
         coalesce((select x.action = 'material_change' from public.edition_reviews x where x.edition_id = e.id order by x.created_at desc limit 1), false),
         o.reserved_name_flag, (o.status = 'pending')
    from public.editions e join public.edition_organisers o on o.id = e.organiser_id
    left join public.hubs h on h.id = o.hub_id left join public.local_businesses b on b.id = o.business_id
    left join lateral (select x.created_at from public.edition_reviews x where x.edition_id = e.id and x.action in ('approved', 'changes_requested', 'rejected') order by x.created_at desc limit 1) lr on true
   where not e.is_test and not o.is_test and case p_tab
           when 'waiting' then e.review_state = 'submitted'
           when 'changes' then e.review_state = 'changes_requested'
           when 'decided' then lr.created_at > now() - interval '30 days' and e.review_state in ('approved', 'rejected', 'changes_requested')
           when 'edited' then e.review_state = 'approved' and e.status = 'published' and e.updated_at > e.approved_at + interval '10 minutes' and e.updated_at > now() - interval '30 days'
           else false end
   order by case p_tab when 'waiting' then e.submitted_at end asc nulls last, lr.created_at desc nulls last, e.updated_at desc;
end $$;

create or replace function public.admin_edition_review_counts() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then return jsonb_build_object('waiting', 0, 'changes', 0); end if;
  return jsonb_build_object(
    'waiting', (select count(*) from public.editions e join public.edition_organisers o on o.id = e.organiser_id where e.review_state = 'submitted' and not e.is_test and not o.is_test),
    'changes', (select count(*) from public.editions e join public.edition_organisers o on o.id = e.organiser_id where e.review_state = 'changes_requested' and not e.is_test and not o.is_test));
end $$;

create or replace function public.admin_edition_review_detail(p_edition uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_parent jsonb; v_prior int; v_staff_items jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  select * into e from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  select * into o from public.edition_organisers where id = e.organiser_id;
  if o.hub_id is not null then
    select jsonb_build_object('kind', 'hub', 'id', h.id, 'name', h.name, 'slug', h.slug, 'active', h.is_active, 'verified', coalesce(h.is_verified, false), 'created_at', h.created_at,
      'owner', (select coalesce(p.full_name, 'Unnamed') from public.profiles p where p.id = h.owner_id),
      'committee', coalesce((select jsonb_agg(coalesce(p.full_name, 'Unnamed') order by p.full_name) from public.hub_members m left join public.profiles p on p.id = m.user_id where m.hub_id = h.id and m.status = 'active' and m.role in ('owner', 'committee')), '[]'::jsonb),
      'members', (select count(*) from public.hub_members m where m.hub_id = h.id and m.status = 'active')) into v_parent from public.hubs h where h.id = o.hub_id;
  else
    select jsonb_build_object('kind', 'business', 'id', b.id, 'name', b.name, 'active', b.is_active, 'verified', coalesce(b.is_verified, false), 'created_at', b.created_at, 'tier', b.subscription_tier,
      'owner', (select coalesce(p.full_name, 'Unnamed') from public.profiles p where p.id = b.owner_id),
      'claim_approved_at', (select max(c.reviewed_at) from public.business_claims c where c.business_id = b.id and c.status = 'approved')) into v_parent from public.local_businesses b where b.id = o.business_id;
  end if;
  select count(*) into v_prior from public.edition_audit_log a where a.organiser_id = o.id and a.action = 'edition_status' and a.detail ->> 'to' = 'suspended';
  v_staff_items := jsonb_build_array(
    jsonb_build_object('key', 'reserved', 'label', 'Name is not on the reserved list', 'required', false, 'ok', not o.reserved_name_flag, 'hint', 'The organiser''s name matches a reserved list of real organisations.'),
    jsonb_build_object('key', 'history', 'label', 'No earlier suspensions', 'required', false, 'ok', v_prior = 0, 'hint', v_prior || ' earlier suspension(s) for this organiser.'),
    jsonb_build_object('key', 'first', 'label', 'Identity already checked', 'required', false, 'ok', o.status = 'verified', 'hint', 'Approving this Edition also records the identity check.'));
  return jsonb_build_object(
    'edition', jsonb_build_object('id', e.id, 'title', e.title, 'slug', e.slug, 'kind', e.kind, 'summary', e.summary, 'starts_on', e.starts_on, 'ends_on', e.ends_on, 'status', e.status, 'review_state', e.review_state,
      'submitted_at', e.submitted_at, 'cover_url', e.cover_url, 'pages', (select count(*) from public.edition_pages where edition_id = e.id), 'sessions', (select count(*) from public.edition_sessions where edition_id = e.id)),
    'organiser', jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status, 'reserved_name_flag', o.reserved_name_flag, 'created_at', o.created_at),
    'parent', v_parent,
    'checks', public.edition_readiness_items(p_edition) || v_staff_items,
    'package', jsonb_build_object('entitled', public.edition_entitled(e.id, 'publish'),
      'orders', coalesce((select jsonb_agg(jsonb_build_object('status', x.status, 'amount_pence', x.amount_pence, 'package', x.package_snapshot ->> 'name') order by x.created_at desc) from public.edition_orders x where x.edition_id = e.id), '[]'::jsonb)),
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', h.action, 'at', h.created_at, 'note', h.note, 'changes', h.changes, 'by', (select p.full_name from public.profiles p where p.id = h.actor)) order by h.created_at desc)
                           from (select * from public.edition_reviews x where x.edition_id = e.id order by x.created_at desc limit 30) h), '[]'::jsonb));
end $$;

-- the caller's Businesses and where each stands with Editions (the Business twin of edition_my_hubs)
create or replace function public.edition_my_businesses() returns table (business_id uuid, business_name text, organiser_id uuid, organiser_slug text, organiser_status text, edition_count integer, in_review integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.name, o.id, o.slug, o.status, (select count(*)::int from public.editions e where e.organiser_id = o.id),
         (select count(*)::int from public.editions e where e.organiser_id = o.id and e.review_state = 'submitted')
    from public.local_businesses b
    left join lateral (select * from public.edition_organisers x where x.business_id = b.id and x.status <> 'rejected' order by x.created_at limit 1) o on true
   where auth.uid() is not null and b.is_active and b.owner_id = auth.uid()
   order by b.name
$$;


-- ── privileges ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array['edition_readiness_items(uuid)', 'edition_readiness(uuid)', 'edition_submit_for_review(uuid)', 'edition_withdraw_submission(uuid)', 'edition_review_status(uuid)',
    'admin_review_edition(uuid,text,text)', 'edition_material_change()', 'edition_reviews_append_only()', 'admin_edition_review_queue(text)', 'admin_edition_review_counts()', 'admin_edition_review_detail(uuid)', 'edition_my_businesses()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['edition_readiness(uuid)', 'edition_submit_for_review(uuid)', 'edition_withdraw_submission(uuid)', 'edition_review_status(uuid)', 'admin_review_edition(uuid,text,text)',
    'admin_edition_review_queue(text)', 'admin_edition_review_counts()', 'admin_edition_review_detail(uuid)', 'edition_my_businesses()'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
