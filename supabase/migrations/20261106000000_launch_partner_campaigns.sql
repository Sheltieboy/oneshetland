-- ═══════════════════════════════════════════════════════════════════════════
-- Launch-partner campaigns — the admin's working record for one invited business
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An administrator prepares a private Launch Partner Preview (/launch/{slug}) for ONE existing Directory listing, and
-- a private DRAFT of that business's Page V2, long before the owner has seen either. This migration is the place
-- those two pieces of prepared content, the admin's notes and the email draft live, and the single admin screen's
-- read model over them. It adds exactly two private tables and the functions below. It is additive: nothing existing
-- is altered.
--
-- WHAT THIS MIGRATION GUARANTEES (each one is asserted by supabase/tests/launch-partner-campaigns.node.test.ts)
--
--   1. It changes no listing, product, plan, grant, invitation or claim. The only existing data it reads for its own
--      purposes is launch_invites (record_view / preview_config validate a token through the unchanged
--      _launch_invite_find). admin_issue_launch_invite, admin_revoke_launch_invite, submit_launch_partner_claim,
--      admin_grant_launch_plan and the claim functions are untouched.
--   2. No function here sends email or calls out. There is no pg_net / http call anywhere. "Mark as sent" is only an
--      administrator's manual note that THEY sent the invitation; the database sends nothing.
--   3. Drafts live ONLY in launch_partner_campaigns, which has row level security on, NO policy, and no grant to
--      anon / authenticated / public. No view, no PostgREST table route and no existing function reads it, so no
--      public API can expose a draft. The only readers are the functions below, each gated as documented.
--   4. Authorisation for every admin function is public.launch_plan_authorised() and nothing else: an admin session,
--      the service role, or a direct SQL session. Anyone else gets 42501. anon cannot even execute them.
--   5. setup_ready_at and live_at are RESERVED for the later owner "Go live" step. NOTHING in this migration sets
--      them, and the update function's whitelist cannot reach them.
--   6. The audit trail never holds a token or an email body: an update records only the NAMES of the fields it
--      changed; a view records nothing but the fact that it happened.
--
-- THE TOKEN: launch_invite_record_view and launch_invite_preview_config validate the visitor's token with the
-- existing public._launch_invite_find (unchanged, not weakened). The token is never stored, returned or logged here.
-- An invalid token returns false / null, writes nothing, and reveals nothing.

begin;

-- ── 1. Campaigns ────────────────────────────────────────────────────────────
create table if not exists public.launch_partner_campaigns (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null unique references public.local_businesses(id) on delete restrict,
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
  stage            text not null default 'candidate'
                   check (stage in ('candidate', 'preparing', 'ready_to_invite', 'sent', 'archived')),
  is_test          boolean not null default false,
  positioning      text check (positioning is null or char_length(positioning) <= 200),
  -- What /launch/{slug} renders. Served only to a holder of a valid invitation token.
  preview_config   jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(preview_config) = 'object' and octet_length(preview_config::text) <= 262144),
  -- The prepared Business Page V2 DRAFT. Private: admin, or the approved launch-partner owner, via functions only.
  page_config      jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(page_config) = 'object' and octet_length(page_config::text) <= 262144),
  contact_name     text check (contact_name is null or char_length(contact_name) <= 200),
  contact_email    text check (contact_email is null
                               or (char_length(contact_email) <= 254 and contact_email ~ '^[^@\s]+@[^@\s]+$')),
  email_subject    text check (email_subject is null or char_length(email_subject) <= 200),
  email_body       text check (email_body is null or char_length(email_body) <= 8000),
  notes            text check (notes is null or char_length(notes) <= 4000),
  sent_at          timestamptz,
  first_viewed_at  timestamptz,
  last_viewed_at   timestamptz,
  view_count       integer not null default 0 check (view_count >= 0),
  -- RESERVED for the later owner "Go live" step. Nothing in this migration sets either column.
  setup_ready_at   timestamptz,
  live_at          timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.launch_partner_campaigns is
  'Admin working record for one launch-partner business: preview content, private page draft, email draft, notes, view tracking. Private: RLS on, no policy, no client grant. Reachable only through the admin_launch_partner_* / launch_invite_* / launch_partner_page_draft functions.';
comment on column public.launch_partner_campaigns.setup_ready_at is 'RESERVED for the later owner "Go live" step. Nothing in the launch_partner_campaigns migration sets it.';
comment on column public.launch_partner_campaigns.live_at is 'RESERVED for the later owner "Go live" step. Nothing in the launch_partner_campaigns migration sets it.';

-- ── 2. Audit trail ──────────────────────────────────────────────────────────
create table if not exists public.launch_partner_events (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.launch_partner_campaigns(id) on delete cascade,
  kind         text not null check (char_length(kind) between 1 and 40),
  -- Never a token, never an email body. For an update: only the names of the fields that changed.
  detail       jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 4096),
  actor        uuid,
  actor_label  text,
  created_at   timestamptz not null default now()
);

create index if not exists launch_partner_events_campaign_idx
  on public.launch_partner_events (campaign_id, created_at desc);

alter table public.launch_partner_campaigns enable row level security;
alter table public.launch_partner_events    enable row level security;
revoke all on public.launch_partner_campaigns from public, anon, authenticated;
revoke all on public.launch_partner_events    from public, anon, authenticated;
grant all on public.launch_partner_campaigns to service_role;
grant all on public.launch_partner_events    to service_role;
-- No policy on either table, deliberately: they are read and written only through the functions below.

-- ── 3. Internal helpers (not callable by any client role) ───────────────────
create or replace function public._launch_partner_event(
  p_campaign_id uuid, p_kind text, p_detail jsonb, p_label text
) returns void
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  insert into public.launch_partner_events (campaign_id, kind, detail, actor, actor_label)
  values (p_campaign_id, p_kind, coalesce(p_detail, '{}'::jsonb), auth.uid(), p_label);
$$;
revoke all on function public._launch_partner_event(uuid, text, jsonb, text) from public, anon, authenticated;

-- One campaign's scalar fields plus the facts joined from existing tables. No big JSON blobs, no contact_email.
create or replace function public._launch_partner_summary(p_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  c        public.launch_partner_campaigns;
  b        public.local_businesses;
  v_inv    boolean := false;
  v_i_at   timestamptz; v_i_exp timestamptz; v_i_rev timestamptz; v_i_bound text; v_i_status text;
  v_c_st   text; v_c_at timestamptz;
  v_g_tier text; v_g_exp timestamptz; v_g_at timestamptz;
  v_prod   integer; v_prod_act integer;
  v_imp    integer; v_imp_at timestamptz;
  v_ev_at  timestamptz;
  v_owner_name text;
begin
  select * into c from public.launch_partner_campaigns where id = p_id;
  if not found then return null; end if;
  select * into b from public.local_businesses where id = c.business_id;

  select true, i.created_at, i.expires_at, i.revoked_at, cl.status
    into v_inv, v_i_at, v_i_exp, v_i_rev, v_i_bound
    from public.launch_invites i
    left join public.business_claims cl on cl.id = i.bound_claim_id
   where i.slug = c.slug
   order by i.created_at desc limit 1;
  v_inv := coalesce(v_inv, false);
  v_i_status := case when not v_inv then 'none'
                     when v_i_rev is not null then 'revoked'
                     when v_i_exp is not null and v_i_exp <= now() then 'expired'
                     when v_i_bound = 'pending' then 'claim pending'
                     when v_i_bound = 'approved' then 'claimed'
                     else 'open' end;

  select x.status, x.created_at into v_c_st, v_c_at
    from public.business_claims x
   where x.business_id = c.business_id and x.source = 'launch_partner_invitation'
   order by x.created_at desc limit 1;

  select g.tier, g.expires_at, g.created_at into v_g_tier, v_g_exp, v_g_at
    from public.launch_plan_grants g
   where g.business_id = c.business_id and g.revoked_at is null and g.superseded_at is null and g.expires_at > now()
   order by g.created_at desc limit 1;

  select count(*), count(*) filter (where p.is_active) into v_prod, v_prod_act
    from public.products p where p.business_id = c.business_id;
  select count(*), max(ib.created_at) into v_imp, v_imp_at
    from public.import_batches ib where ib.business_id = c.business_id;
  select max(e.created_at) into v_ev_at from public.launch_partner_events e where e.campaign_id = c.id;

  return jsonb_build_object(
    'id', c.id, 'business_id', c.business_id, 'slug', c.slug, 'stage', c.stage, 'is_test', c.is_test,
    'positioning', c.positioning, 'contact_name', c.contact_name,
    'has_contact_email', c.contact_email is not null,
    'has_email_draft', (nullif(btrim(coalesce(c.email_subject, '')), '') is not null
                        or nullif(btrim(coalesce(c.email_body, '')), '') is not null),
    'has_preview', c.preview_config <> '{}'::jsonb,
    'has_page_draft', c.page_config <> '{}'::jsonb,
    'sent_at', c.sent_at, 'first_viewed_at', c.first_viewed_at, 'last_viewed_at', c.last_viewed_at,
    'view_count', c.view_count, 'setup_ready_at', c.setup_ready_at, 'live_at', c.live_at,
    'created_at', c.created_at, 'updated_at', c.updated_at,
    'business', jsonb_build_object(
      'name', b.name, 'category', b.category, 'locality', public.business_locality(b.address),
      'is_active', coalesce(b.is_active, false), 'is_claimed', coalesce(b.is_claimed, false),
      'has_owner', b.owner_id is not null),
    'tier', b.subscription_tier,
    'plan_live', public.business_meets_tier(b.id, 'pro'),
    'grant', case when v_g_tier is null then null
                  else jsonb_build_object('tier', v_g_tier, 'expires_at', v_g_exp) end,
    'invitation', jsonb_build_object('status', v_i_status, 'created_at', v_i_at, 'expires_at', v_i_exp),
    'claim', case when v_c_st is null then null
                  else jsonb_build_object('status', v_c_st, 'created_at', v_c_at) end,
    'product_count', v_prod, 'active_product_count', v_prod_act,
    'import_batch_count', v_imp,
    'last_activity', greatest(c.created_at, c.updated_at, c.sent_at, c.first_viewed_at, c.last_viewed_at,
                              c.setup_ready_at, c.live_at, v_i_at, v_c_at, v_g_at, v_imp_at, v_ev_at)
  );
end;
$$;
revoke all on function public._launch_partner_summary(uuid) from public, anon, authenticated;

-- ── 4. Find a business to start a campaign for ─────────────────────────────
create or replace function public.admin_launch_partner_candidates(p_query text)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  q       text := nullif(btrim(coalesce(p_query, '')), '');
  v_by_id boolean;
  v_out   jsonb;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can look up launch-partner candidates' using errcode = '42501';
  end if;
  if q is null or char_length(q) < 3 then
    raise exception 'Type at least 3 letters of the name, or paste a business id' using errcode = '22023';
  end if;
  v_by_id := q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  select coalesce(jsonb_agg(row_to_json_obj order by srt_active desc, srt_name), '[]'::jsonb) into v_out
  from (
    select coalesce(b.is_active, false) as srt_active, b.name as srt_name,
           jsonb_build_object(
             'business_id', b.id, 'name', b.name, 'category', b.category,
             'locality', public.business_locality(b.address),
             'is_active', coalesce(b.is_active, false), 'is_claimed', coalesce(b.is_claimed, false),
             'has_owner', b.owner_id is not null,
             'owner_name', (select p.full_name from public.profiles p where p.id = b.owner_id),
             'tier', b.subscription_tier, 'plan_until', b.subscription_until,
             'plan_live', public.business_meets_tier(b.id, 'pro'),
             'premium_live', public.business_meets_tier(b.id, 'premium'),
             'product_count', (select count(*) from public.products x where x.business_id = b.id),
             'service_count', (select count(*) from public.book_services x where x.business_id = b.id),
             'offer_count',   (select count(*) from public.local_offers x where x.business_id = b.id),
             'pass_count',    (select count(*) from public.book_unit_items x where x.business_id = b.id),
             'has_campaign', k.id is not null,
             'campaign_id', k.id, 'campaign_slug', k.slug, 'campaign_stage', k.stage
           ) as row_to_json_obj
      from public.local_businesses b
      left join public.launch_partner_campaigns k on k.business_id = b.id
     where case when v_by_id then b.id = q::uuid
                else b.name ilike '%' || regexp_replace(q, '([\\%_])', '\\\1', 'g') || '%' end
     order by coalesce(b.is_active, false) desc, b.name
     limit 15
  ) s;
  return v_out;
end;
$$;

-- ── 5. Create ───────────────────────────────────────────────────────────────
create or replace function public.admin_launch_partner_create(
  p_business_id uuid,
  p_slug        text,
  p_positioning text    default null,
  p_preview     jsonb   default '{}'::jsonb,
  p_page        jsonb   default '{}'::jsonb,
  p_is_test     boolean default false,
  p_stage       text    default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via   text := public.launch_plan_authorised();
  v_pos   text := nullif(btrim(coalesce(p_positioning, '')), '');
  v_prev  jsonb := coalesce(p_preview, '{}'::jsonb);
  v_page  jsonb := coalesce(p_page, '{}'::jsonb);
  v_stage text;
  v_id    uuid;
begin
  if v_via is null then
    raise exception 'Only an administrator can create a launch-partner record' using errcode = '42501';
  end if;
  if not exists (select 1 from public.local_businesses where id = p_business_id) then
    raise exception 'No such business' using errcode = 'P0002';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{2,60}$' then
    raise exception 'Invalid preview name' using errcode = '22023';
  end if;
  if v_pos is not null and char_length(v_pos) > 200 then
    raise exception 'The positioning line is limited to 200 characters' using errcode = '22023';
  end if;
  if jsonb_typeof(v_prev) <> 'object' or jsonb_typeof(v_page) <> 'object' then
    raise exception 'The preview and page content must be JSON objects' using errcode = '22023';
  end if;
  if octet_length(v_prev::text) > 262144 or octet_length(v_page::text) > 262144 then
    raise exception 'The preview or page content is too large' using errcode = '22023';
  end if;
  if p_stage is not null and p_stage not in ('candidate', 'preparing', 'ready_to_invite') then
    raise exception 'A new record can start as candidate, preparing or ready_to_invite' using errcode = '22023';
  end if;
  v_stage := coalesce(p_stage, case when v_prev <> '{}'::jsonb then 'preparing' else 'candidate' end);
  if v_stage = 'ready_to_invite' and v_prev = '{}'::jsonb then
    raise exception 'Prepare the preview before it can be ready to invite' using errcode = '22023';
  end if;

  if exists (select 1 from public.launch_partner_campaigns where business_id = p_business_id) then
    raise exception 'This business already has a launch-partner record' using errcode = '23505';
  end if;
  if exists (select 1 from public.launch_partner_campaigns where slug = p_slug) then
    raise exception 'That preview name is already used' using errcode = '23505';
  end if;

  begin
    insert into public.launch_partner_campaigns
      (business_id, slug, stage, is_test, positioning, preview_config, page_config, created_by)
    values
      (p_business_id, p_slug, v_stage, coalesce(p_is_test, false), v_pos, v_prev, v_page, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    -- a concurrent create got there between the check and the insert
    if exists (select 1 from public.launch_partner_campaigns where business_id = p_business_id) then
      raise exception 'This business already has a launch-partner record' using errcode = '23505';
    end if;
    raise exception 'That preview name is already used' using errcode = '23505';
  end;

  perform public._launch_partner_event(v_id, 'created',
    jsonb_build_object('stage', v_stage, 'is_test', coalesce(p_is_test, false),
                       'has_preview', v_prev <> '{}'::jsonb, 'has_page_draft', v_page <> '{}'::jsonb), v_via);
  return v_id;
end;
$$;

-- ── 6. Update (whitelisted fields only) ─────────────────────────────────────
create or replace function public.admin_launch_partner_update(p_id uuid, p_patch jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via     text := public.launch_plan_authorised();
  c         public.launch_partner_campaigns;
  k         text;
  v         jsonb;
  s         text;
  v_changed text[] := '{}';
  n         public.launch_partner_campaigns;
begin
  if v_via is null then
    raise exception 'Only an administrator can edit a launch-partner record' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'The patch must be a JSON object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('positioning', 'preview_config', 'page_config', 'contact_name', 'contact_email',
                 'email_subject', 'email_body', 'notes') then
      raise exception 'Field "%" cannot be changed here', k using errcode = '22023';
    end if;
  end loop;

  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  if c.stage = 'archived' then
    for k in select jsonb_object_keys(p_patch) loop
      if k <> 'notes' then
        raise exception 'An archived record can only have its notes changed' using errcode = '55000';
      end if;
    end loop;
  end if;

  n := c;
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('preview_config', 'page_config') then
      if jsonb_typeof(v) <> 'object' then
        raise exception '% must be a JSON object', k using errcode = '22023';
      end if;
      if octet_length(v::text) > 262144 then
        raise exception '% is too large (limit 256 KB)', k using errcode = '22023';
      end if;
      if k = 'preview_config' then n.preview_config := v; else n.page_config := v; end if;
    else
      if jsonb_typeof(v) not in ('string', 'null') then
        raise exception '% must be text', k using errcode = '22023';
      end if;
      s := nullif(btrim(coalesce(v #>> '{}', '')), '');
      if k = 'positioning' then
        if char_length(coalesce(s, '')) > 200 then raise exception 'positioning is limited to 200 characters' using errcode = '22023'; end if;
        n.positioning := s;
      elsif k = 'contact_name' then
        if char_length(coalesce(s, '')) > 200 then raise exception 'contact_name is limited to 200 characters' using errcode = '22023'; end if;
        n.contact_name := s;
      elsif k = 'contact_email' then
        if s is not null and (char_length(s) > 254 or s !~ '^[^@\s]+@[^@\s]+$') then
          raise exception 'contact_email is not a valid email address' using errcode = '22023';
        end if;
        n.contact_email := s;
      elsif k = 'email_subject' then
        if char_length(coalesce(s, '')) > 200 then raise exception 'email_subject is limited to 200 characters' using errcode = '22023'; end if;
        n.email_subject := s;
      elsif k = 'email_body' then
        if char_length(coalesce(s, '')) > 8000 then raise exception 'email_body is limited to 8000 characters' using errcode = '22023'; end if;
        n.email_body := s;
      elsif k = 'notes' then
        if char_length(coalesce(s, '')) > 4000 then raise exception 'notes is limited to 4000 characters' using errcode = '22023'; end if;
        n.notes := s;
      end if;
    end if;
  end loop;

  -- A preview that is ready, or already sent, must not be emptied underneath the invitation.
  if n.preview_config = '{}'::jsonb and c.stage in ('ready_to_invite', 'sent') then
    raise exception 'Move the record back to preparing before clearing its preview' using errcode = '55000';
  end if;

  if n.positioning     is distinct from c.positioning     then v_changed := array_append(v_changed, 'positioning'); end if;
  if n.preview_config  is distinct from c.preview_config  then v_changed := array_append(v_changed, 'preview_config'); end if;
  if n.page_config     is distinct from c.page_config     then v_changed := array_append(v_changed, 'page_config'); end if;
  if n.contact_name    is distinct from c.contact_name    then v_changed := array_append(v_changed, 'contact_name'); end if;
  if n.contact_email   is distinct from c.contact_email   then v_changed := array_append(v_changed, 'contact_email'); end if;
  if n.email_subject   is distinct from c.email_subject   then v_changed := array_append(v_changed, 'email_subject'); end if;
  if n.email_body      is distinct from c.email_body      then v_changed := array_append(v_changed, 'email_body'); end if;
  if n.notes           is distinct from c.notes           then v_changed := array_append(v_changed, 'notes'); end if;

  if cardinality(v_changed) > 0 then
    update public.launch_partner_campaigns set
      positioning = n.positioning, preview_config = n.preview_config, page_config = n.page_config,
      contact_name = n.contact_name, contact_email = n.contact_email, email_subject = n.email_subject,
      email_body = n.email_body, notes = n.notes, updated_at = now()
     where id = p_id;
    -- Field NAMES only: never the values (an email address, a draft body, a page).
    perform public._launch_partner_event(p_id, 'updated', jsonb_build_object('fields', to_jsonb(v_changed)), v_via);
  end if;
  return public._launch_partner_summary(p_id);
end;
$$;

-- ── 7. Stage ────────────────────────────────────────────────────────────────
create or replace function public.admin_launch_partner_set_stage(p_id uuid, p_stage text, p_note text default null)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via  text := public.launch_plan_authorised();
  c      public.launch_partner_campaigns;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_via is null then
    raise exception 'Only an administrator can change a launch-partner stage' using errcode = '42501';
  end if;
  if p_stage = 'sent' then
    raise exception 'A record becomes "sent" only when you mark the invitation as sent' using errcode = '22023';
  end if;
  if p_stage is null or p_stage not in ('candidate', 'preparing', 'ready_to_invite', 'archived') then
    raise exception 'Stage must be candidate, preparing, ready_to_invite or archived' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'The note is limited to 500 characters' using errcode = '22023';
  end if;

  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  if c.stage = p_stage then return; end if;
  if c.stage = 'sent' and p_stage <> 'archived' then
    raise exception 'An invitation has been sent; the record can only be archived now' using errcode = '22023';
  end if;
  if p_stage = 'ready_to_invite' and c.preview_config = '{}'::jsonb then
    raise exception 'Prepare the preview before it can be ready to invite' using errcode = '22023';
  end if;

  update public.launch_partner_campaigns set stage = p_stage, updated_at = now() where id = p_id;
  perform public._launch_partner_event(p_id, 'stage',
    jsonb_build_object('from', c.stage, 'to', p_stage, 'note', v_note), v_via);
end;
$$;

-- ── 8. Mark sent (a manual record; the database sends nothing) ──────────────
create or replace function public.admin_launch_partner_mark_sent(p_id uuid, p_note text default null)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via  text := public.launch_plan_authorised();
  c      public.launch_partner_campaigns;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_via is null then
    raise exception 'Only an administrator can mark an invitation as sent' using errcode = '42501';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'The note is limited to 500 characters' using errcode = '22023';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;
  if c.stage <> 'ready_to_invite' then
    raise exception 'Only a record that is ready to invite can be marked as sent' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.launch_invites i
     where i.slug = c.slug and i.business_id = c.business_id and i.revoked_at is null
       and (i.expires_at is null or i.expires_at > now())
  ) then
    raise exception 'Issue a live invitation for this preview first' using errcode = '55000';
  end if;

  update public.launch_partner_campaigns
     set stage = 'sent', sent_at = now(), updated_at = now() where id = p_id;
  perform public._launch_partner_event(p_id, 'marked_sent', jsonb_build_object('note', v_note), v_via);
end;
$$;

-- ── 9. Read: list and get ───────────────────────────────────────────────────
create or replace function public.admin_launch_partner_list()
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare v_out jsonb;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can list launch-partner records' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(s.j order by (s.j ->> 'last_activity')::timestamptz desc nulls last, s.j ->> 'slug'), '[]'::jsonb)
    into v_out
    from (select public._launch_partner_summary(k.id) as j from public.launch_partner_campaigns k) s;
  return v_out;
end;
$$;

create or replace function public.admin_launch_partner_get(p_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  c        public.launch_partner_campaigns;
  v_events jsonb;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can read a launch-partner record' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'detail', e.detail,
                                               'actor', e.actor, 'actor_label', e.actor_label,
                                               'created_at', e.created_at) order by e.created_at desc, e.id), '[]'::jsonb)
    into v_events
    from (select * from public.launch_partner_events where campaign_id = p_id
           order by created_at desc, id limit 50) e;
  return public._launch_partner_summary(p_id) || jsonb_build_object(
    'preview_config', c.preview_config, 'page_config', c.page_config,
    'contact_email', c.contact_email, 'email_subject', c.email_subject, 'email_body', c.email_body,
    'notes', c.notes, 'events', v_events);
end;
$$;

-- ── 10. The visitor's side: count a view, serve the preview ─────────────────
-- Both validate the token through the existing _launch_invite_find. An invalid token is indistinguishable from a
-- missing campaign: false / null, nothing written, nothing revealed. The token is never stored or returned.
create or replace function public.launch_invite_record_view(p_slug text, p_token text)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  r        public.launch_invites;
  c        public.launch_partner_campaigns;
  v_first  boolean;
  v_count  boolean;
begin
  r := public._launch_invite_find(p_slug, p_token);
  if r.id is null then return false; end if;
  select * into c from public.launch_partner_campaigns
   where slug = r.slug and business_id = r.business_id and stage <> 'archived'
   for update;
  if not found then return false; end if;

  v_first := c.first_viewed_at is null;
  v_count := c.last_viewed_at is null or c.last_viewed_at < now() - interval '30 minutes';

  update public.launch_partner_campaigns
     set first_viewed_at = coalesce(first_viewed_at, now()),
         last_viewed_at  = case when v_count then now() else last_viewed_at end,
         view_count      = case when v_count then view_count + 1 else view_count end
   where id = c.id;
  if v_first then
    perform public._launch_partner_event(c.id, 'first_viewed', '{}'::jsonb, 'invitation');
  end if;
  return v_count;
end;
$$;

create or replace function public.launch_invite_preview_config(p_slug text, p_token text)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  r public.launch_invites;
  v jsonb;
begin
  r := public._launch_invite_find(p_slug, p_token);
  if r.id is null then return null; end if;
  select c.preview_config into v from public.launch_partner_campaigns c
   where c.slug = r.slug and c.business_id = r.business_id and c.stage <> 'archived'
     and c.preview_config <> '{}'::jsonb;
  return v;      -- null when there is no such campaign / nothing prepared
end;
$$;

-- ── 11. The prepared Page V2 draft ──────────────────────────────────────────
-- Returns the draft to an administrator, or to the OWNER of that business who got there through an APPROVED
-- launch-partner claim. In every other case NULL — never an error, so nobody can tell whether a draft exists.
create or replace function public.launch_partner_page_draft(p_business_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  c     public.launch_partner_campaigns;
  v_ok  boolean := false;
begin
  if p_business_id is null then return null; end if;
  select * into c from public.launch_partner_campaigns where business_id = p_business_id;
  if not found then return null; end if;

  if public.launch_plan_authorised() is not null then
    v_ok := true;
  elsif v_uid is not null then
    v_ok := exists (select 1 from public.local_businesses b where b.id = p_business_id and b.owner_id = v_uid)
        and exists (select 1 from public.business_claims cl
                     where cl.business_id = p_business_id and cl.user_id = v_uid
                       and cl.source = 'launch_partner_invitation' and cl.status = 'approved');
  end if;
  if not v_ok then return null; end if;
  return jsonb_build_object('campaign_id', c.id, 'slug', c.slug, 'stage', c.stage, 'page_config', c.page_config);
end;
$$;

-- ── 12. Who may call what ───────────────────────────────────────────────────
revoke all on function
  public.admin_launch_partner_candidates(text),
  public.admin_launch_partner_create(uuid, text, text, jsonb, jsonb, boolean, text),
  public.admin_launch_partner_update(uuid, jsonb),
  public.admin_launch_partner_set_stage(uuid, text, text),
  public.admin_launch_partner_mark_sent(uuid, text),
  public.admin_launch_partner_list(),
  public.admin_launch_partner_get(uuid),
  public.launch_invite_record_view(text, text),
  public.launch_invite_preview_config(text, text),
  public.launch_partner_page_draft(uuid)
  from public, anon, authenticated;

-- Admin functions self-gate on launch_plan_authorised(); anon cannot even execute them.
grant execute on function
  public.admin_launch_partner_candidates(text),
  public.admin_launch_partner_create(uuid, text, text, jsonb, jsonb, boolean, text),
  public.admin_launch_partner_update(uuid, jsonb),
  public.admin_launch_partner_set_stage(uuid, text, text),
  public.admin_launch_partner_mark_sent(uuid, text),
  public.admin_launch_partner_list(),
  public.admin_launch_partner_get(uuid)
  to authenticated, service_role;
-- The visitor's two functions: callable signed out (the invited owner has no account yet).
grant execute on function
  public.launch_invite_record_view(text, text),
  public.launch_invite_preview_config(text, text)
  to anon, authenticated, service_role;
grant execute on function public.launch_partner_page_draft(uuid) to authenticated, service_role;

commit;
