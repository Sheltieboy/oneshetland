-- ═══════════════════════════════════════════════════════════════════════════
-- Launch-partner GO LIVE — the owner publishes the exact setup they approved
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This is the function that the profile-versions migration (20261107) described as a design contract and deliberately left out
-- until a public-page switch existed. It now exists (the public business page renders the PUBLISHED profile — web repo).
--
-- WHAT "GO LIVE" IS HERE
--   It PUBLISHES A VERSION. It does not copy anything into the business record. The profile layer (tagline, story, information
--   sections, gallery, layout…) has no columns on local_businesses, and the fields that do exist (name, contact, hours, address,
--   logo, plan, products…) are already read live from the real record, so owner edits to those keep working after launch.
--
--   launch_partner_owner_go_live(p_business_id, p_version_id) -> jsonb       the OWNER only (not admins)
--     · p_version_id must be the campaign's CURRENT approved version (approved_version_id). A newer, unapproved edit can never go
--       live; an older approved version can never go live; an admin's prepared draft can never go live.
--     · inserts ONE append-only 'published' version (parent = the approved version, profile = that version's profile, verbatim)
--     · sets published_version_id, and live_at / setup_ready_at the FIRST time only
--     · writes one audit event ('went_live') holding version ids only
--     · IDEMPOTENT: asking again for a version that is already published returns {already_live:true} and writes nothing
--     · REPUBLISH: after the owner approves a newer version, calling it again publishes that one (live_at is kept)
--     · all or nothing: one transaction under the campaign row lock
--
--   launch_partner_published_profile(p_business_id) -> jsonb                  ANYONE (anon included)
--     · the profile of the currently published version, or NULL. It returns only what the owner approved for the public: the
--       profile layer. Never notes, never commerce, never admin drafts. NULL for a business that is not publicly visible.
--
-- GATES (a failed gate changes nothing and raises 55000 with a plain sentence):
--   owner of THIS business through an approved launch-partner claim · an approved version exists and is the one named ·
--   the business is listed (active) · the business currently has Pro or better (a launch grant or a subscription).
--   NOT gates, on purpose: products, services, offers, passes, bookings, a map pin.
--
-- WHAT THIS MIGRATION DOES NOT DO, AND MUST NOT:
--   · It never writes local_businesses, products, book_services, local_offers, book_unit_items, claims, invitations or grants.
--   · No email, no network call. admin_launch_partner_update's whitelist is untouched (an admin cannot set live_at).
--   · UN-publish is not built; when it is, it must be its own audited row, never an edit of these.

begin;

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
    jsonb_build_object('version_id', v_id, 'approved_version_id', a.id, 'republish', c.published_version_id is not null), 'owner');
  return jsonb_build_object('already_live', false, 'published_version_id', v_id, 'live_at', coalesce(c.live_at, v_now));
end;
$$;

-- What the PUBLIC page may show: the published profile, only for a publicly visible business. Same predicate the Directory uses.
create or replace function public.launch_partner_published_profile(p_business_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object('version_id', v.id, 'published_at', v.created_at, 'profile', v.profile)
    from public.launch_partner_campaigns c
    join public.launch_partner_page_versions v on v.id = c.published_version_id and v.campaign_id = c.id and v.kind = 'published'
    join public.local_businesses b on b.id = c.business_id
   where c.business_id = p_business_id
     and coalesce(b.is_active, false) is true
     and not public.is_discovery_hidden('business', b.id)
$$;

revoke all on function public.launch_partner_owner_go_live(uuid, uuid), public.launch_partner_published_profile(uuid) from public, anon, authenticated;
-- The owner function self-gates on the owner predicate; anon cannot even execute it.
grant execute on function public.launch_partner_owner_go_live(uuid, uuid) to authenticated, service_role;
-- The public reader is deliberately callable signed out: it returns only what the owner approved for the public.
grant execute on function public.launch_partner_published_profile(uuid) to anon, authenticated, service_role;

commit;
