-- ═══════════════════════════════════════════════════════════════════════════
-- Launch-partner TAKEDOWN — an administrator can take a published page offline, audited, reversible, destructive of nothing
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. Go-live (20261111) published a version but left no way to un-publish one. A page an owner published that turns out to be wrong,
-- disputed, inappropriate or accidental could be removed only by hand SQL. This migration adds the supported, audited way.
--
-- WHAT "OFFLINE" IS HERE
--   Taking a page offline UNPUBLISHES it. The business record, owner, claim, Launch Partner grant, campaign and EVERY version are untouched.
--
--   admin_launch_partner_take_offline(p_id, p_reason) -> jsonb          ADMINISTRATORS only (launch_plan_authorised), never the owner, never anon
--     · a reason is required (3–500 characters)
--     · inserts ONE append-only 'unpublished' version (parent = the version that was public, profile = that same profile)
--     · published_version_id := NULL        → the public reader returns nothing, so /directory/{id} shows the ordinary listing again
--     · offline_at := now()                 → the takedown "hold" (below)
--     · live_at and setup_ready_at are KEPT: the campaign did go live once, and that fact is history, not something to un-say
--     · one audit event 'went_offline' holding the reason, the actor (events carry auth.uid(); the name is copied in so history reads well) and version ids; the reason is visible to
--       administrators only — the owner reads versions and the hold flag, never events
--     · IDEMPOTENT: a repeat on an already-offline page writes nothing and answers {already_offline:true}
--
--   THE HOLD. While offline_at is set the owner's go-live is refused ("Your page is currently offline. Please contact OneShetland.").
--   Otherwise an owner could press Go live again and undo an administrator's takedown at once.
--
--   admin_launch_partner_allow_republish(p_id) -> jsonb                 ADMINISTRATORS only
--     · lifts the hold (offline_at := NULL) and records 'republish_allowed'. It publishes NOTHING: the owner still goes live through
--       the normal controlled step, which writes a new 'published' version and a new 'went_live' event. Nothing is restored silently.
--     · IDEMPOTENT
--
--   launch_partner_publication_hold(p_business_id) -> jsonb             administrator or the approved owner: {held, offline_at}; no reason
--
-- ALSO (additive): the admin summary gains is_published and offline_at; launch_partner_owner_go_live gains the hold gate and its
-- 'republish' flag now means "this business has gone live before" (it was "a published version exists right now").
--
-- WHAT THIS MIGRATION DOES NOT DO, AND MUST NOT: write local_businesses, products, services, offers, passes, claims, invitations or
-- grants; delete or edit any version or event; send an email; call the network.

begin;

-- ── 1. a new kind of version, and the hold column ───────────────────────────
alter table public.launch_partner_page_versions drop constraint if exists launch_partner_page_versions_kind_check;
alter table public.launch_partner_page_versions
  add constraint launch_partner_page_versions_kind_check check (kind in ('prepared', 'owner_edit', 'approved', 'published', 'unpublished'));
comment on column public.launch_partner_page_versions.kind is
  'prepared = recorded from page_config by an admin; owner_edit = saved by the owner; approved = the owner approved a snapshot; published = the owner went live with the approved snapshot; unpublished = an administrator took the published page offline (same profile as the published row it follows; the reason lives in the audit event, never here).';

alter table public.launch_partner_campaigns add column if not exists offline_at timestamptz;
comment on column public.launch_partner_campaigns.offline_at is
  'Set by admin_launch_partner_take_offline, cleared by admin_launch_partner_allow_republish. While set, the owner cannot go live. Never writable through admin_launch_partner_update.';

-- ── 2. the admin summary: two more fields ───────────────────────────────────
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
    'is_published', c.published_version_id is not null, 'offline_at', c.offline_at,
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
                              c.setup_ready_at, c.live_at, c.offline_at, v_i_at, v_c_at, v_g_at, v_imp_at, v_ev_at)
  );
end;
$$;

-- ── 3. the owner's go-live: the hold gate ───────────────────────────────────
create or replace function public.launch_partner_owner_go_live(p_business_id uuid, p_version_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  c     public.launch_partner_campaigns;
  a     public.launch_partner_page_versions;
  cur   public.launch_partner_page_versions;
  b     public.local_businesses;
  v_id  uuid;
  v_now timestamptz := now();
begin
  if not public._launch_partner_is_owner(p_business_id) then
    raise exception 'Only the approved owner of this launch-partner business can go live' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where business_id = p_business_id for update;
  if not found then
    raise exception 'Only the approved owner of this launch-partner business can go live' using errcode = '42501';
  end if;

  -- An administrator took this page offline and has not yet allowed it to go live again: the owner cannot undo that themselves.
  if c.offline_at is not null then
    raise exception 'Your page is currently offline. Please contact OneShetland.' using errcode = '55000';
  end if;

  -- The exact version the owner approved — nothing older, nothing newer, nothing the admin prepared.
  if p_version_id is null or c.approved_version_id is null or c.approved_version_id is distinct from p_version_id then
    raise exception 'Only the setup you approved can go live. Approve your latest setup first.' using errcode = '55000';
  end if;
  select * into a from public.launch_partner_page_versions where id = p_version_id and campaign_id = c.id and kind = 'approved';
  if not found then
    raise exception 'Only the setup you approved can go live. Approve your latest setup first.' using errcode = '55000';
  end if;

  -- Already published from this very approval: a repeat click, a retry or a second tab. Nothing is written.
  if c.published_version_id is not null then
    select * into cur from public.launch_partner_page_versions where id = c.published_version_id;
    if found and cur.parent_id = a.id then
      return jsonb_build_object('already_live', true, 'published_version_id', cur.id, 'live_at', c.live_at);
    end if;
  end if;

  select * into b from public.local_businesses where id = p_business_id for share;
  if not found or coalesce(b.is_active, false) is not true then
    raise exception 'Your business needs to be listed in the Directory before it can go live.' using errcode = '55000';
  end if;
  if not public.business_meets_tier(p_business_id, 'pro') then
    raise exception 'Your Launch Partner access is not active, so your setup cannot go live right now.' using errcode = '55000';
  end if;

  insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile, parent_id, actor, actor_role)
  values (c.id, c.business_id, 'published', a.profile, a.id, auth.uid(), 'owner')
  returning id into v_id;

  -- Only these three columns. approved_* is not touched, and nothing on the business record is.
  update public.launch_partner_campaigns
     set published_version_id = v_id,
         live_at              = coalesce(c.live_at, v_now),
         setup_ready_at       = coalesce(c.setup_ready_at, v_now),
         updated_at           = v_now
   where id = c.id;

  perform public._launch_partner_event(c.id, 'went_live',
    jsonb_build_object('version_id', v_id, 'approved_version_id', a.id, 'republish', c.live_at is not null), 'owner');
  return jsonb_build_object('already_live', false, 'published_version_id', v_id, 'live_at', coalesce(c.live_at, v_now));
end;
$$;


-- ── 4. take a page offline ──────────────────────────────────────────────────
create or replace function public.admin_launch_partner_take_offline(p_id uuid, p_reason text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via    text := public.launch_plan_authorised();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  c        public.launch_partner_campaigns;
  cur      public.launch_partner_page_versions;
  v_id     uuid;
  v_at     timestamptz := now();
begin
  if v_via is null then
    raise exception 'Only an administrator can take a launch-partner page offline' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Give a reason for taking the page offline' using errcode = '22023';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'The reason is limited to 500 characters' using errcode = '22023';
  end if;

  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  if c.published_version_id is null then
    if c.offline_at is not null then
      return jsonb_build_object('already_offline', true, 'offline_at', c.offline_at);      -- a repeat: nothing is written
    end if;
    raise exception 'This page is not live, so there is nothing to take offline.' using errcode = '55000';
  end if;

  select * into cur from public.launch_partner_page_versions where id = c.published_version_id;
  insert into public.launch_partner_page_versions (campaign_id, business_id, kind, profile, parent_id, actor, actor_role)
  values (c.id, c.business_id, 'unpublished', cur.profile, cur.id, auth.uid(), 'admin')
  returning id into v_id;

  -- live_at and setup_ready_at are history and stay. approved_* is untouched, so nothing the owner approved is lost.
  update public.launch_partner_campaigns
     set published_version_id = null, offline_at = v_at, updated_at = v_at
   where id = c.id;

  perform public._launch_partner_event(c.id, 'went_offline',
    jsonb_build_object('reason', v_reason, 'version_id', v_id, 'unpublished_version_id', cur.id,
                       'actor_name', (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid())), v_via);
  return jsonb_build_object('already_offline', false, 'offline_at', v_at, 'version_id', v_id);
end;
$$;

-- ── 5. allow the owner to go live again (publishes nothing) ─────────────────
create or replace function public.admin_launch_partner_allow_republish(p_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via text := public.launch_plan_authorised();
  c     public.launch_partner_campaigns;
begin
  if v_via is null then
    raise exception 'Only an administrator can allow a launch-partner page to go live again' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;
  if c.offline_at is null then
    return jsonb_build_object('already_allowed', true);                                        -- nothing to lift: nothing is written
  end if;
  update public.launch_partner_campaigns set offline_at = null, updated_at = now() where id = c.id;
  perform public._launch_partner_event(c.id, 'republish_allowed', jsonb_build_object('was_offline_since', c.offline_at,
                       'actor_name', (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid())), v_via);
  return jsonb_build_object('already_allowed', false);
end;
$$;

-- ── 6. the hold, readable by the owner (no reason) ──────────────────────────
create or replace function public.launch_partner_publication_hold(p_business_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare c public.launch_partner_campaigns;
begin
  if p_business_id is null or not public._launch_partner_can_read(p_business_id) then return null; end if;
  select * into c from public.launch_partner_campaigns where business_id = p_business_id;
  if not found then return null; end if;
  return jsonb_build_object('held', c.offline_at is not null, 'offline_at', c.offline_at);
end;
$$;

-- ── 7. who may call what ────────────────────────────────────────────────────
revoke all on function
  public._launch_partner_summary(uuid),
  public.launch_partner_owner_go_live(uuid, uuid),
  public.admin_launch_partner_take_offline(uuid, text),
  public.admin_launch_partner_allow_republish(uuid),
  public.launch_partner_publication_hold(uuid)
  from public, anon, authenticated;
-- The admin functions and the owner functions self-gate; anon cannot even execute them.
grant execute on function
  public.launch_partner_owner_go_live(uuid, uuid),
  public.admin_launch_partner_take_offline(uuid, text),
  public.admin_launch_partner_allow_republish(uuid),
  public.launch_partner_publication_hold(uuid)
  to authenticated, service_role;

commit;
