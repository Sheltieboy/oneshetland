-- OneShetland Launch 50: a limited paid programme (50 places total, one per business).
--   Founding Pro £9/mo and Founding Premium £22/mo for 12 months, then the standard £12 / £29. Monthly billing only.
-- The discount itself is a Stripe coupon applied to an ordinary Pro/Premium subscription (created later, ids in admin_config); THIS migration
-- only decides who may use it and enforces the limit. Nothing here changes any existing subscription, price or listing.
--
-- Places count (permanently) when status is pending_payment / active / ended, or reserved and unexpired. A reservation lasts 30 minutes and then
-- stops counting. Once a Stripe subscription has been created with the discount the place is held (pending_payment) until Stripe says the payment
-- succeeded (-> active) or the subscription never started (-> released). Cancelled/expired memberships become 'ended' and STILL count.
-- Everything is switched off until admin_config launch50.enabled = 'on' AND launch50.opens_at has passed. All writes go through the functions below.

create table if not exists public.launch50_places (
  business_id            uuid primary key references public.local_businesses (id) on delete restrict,
  owner_id               uuid not null references public.profiles (id),
  tier                   text not null check (tier in ('pro', 'premium')),
  status                 text not null check (status in ('reserved', 'pending_payment', 'active', 'ended', 'released')),
  reserved_at            timestamptz not null default now(),
  reservation_expires_at timestamptz,
  stripe_subscription_id text unique,
  activated_at           timestamptz,
  discount_ends_at       timestamptz,
  ended_at               timestamptz,
  showcase_opt_in        boolean not null default false,
  reminder_sent_at       timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (status <> 'reserved' or reservation_expires_at is not null),
  check (status <> 'active' or (stripe_subscription_id is not null and activated_at is not null and discount_ends_at is not null))
);
alter table public.launch50_places enable row level security;
revoke all on public.launch50_places from public, anon, authenticated;
grant select on public.launch50_places to authenticated;
grant all on public.launch50_places to service_role;
create policy launch50_owner_read on public.launch50_places for select to authenticated using (owner_id = auth.uid());

-- ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.launch50_cfg(p_key text) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select value from public.admin_config where key = p_key
$$;
revoke all on function public.launch50_cfg(text) from public, anon, authenticated;

create or replace function public.launch50_used() returns int language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from public.launch50_places
   where status in ('pending_payment', 'active', 'ended') or (status = 'reserved' and reservation_expires_at > now())
$$;
revoke all on function public.launch50_used() from public, anon, authenticated;

-- phase: closed (off / not yet open) | claimed_only (first 14 days) | open
create or replace function public.launch50_phase() returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_on text := public.launch50_cfg('launch50.enabled'); v_open timestamptz;
begin
  if v_on is distinct from 'on' then return 'closed'; end if;
  begin v_open := public.launch50_cfg('launch50.opens_at')::timestamptz; exception when others then return 'closed'; end;
  if v_open is null or now() < v_open then return 'closed'; end if;
  if now() < v_open + interval '14 days' then return 'claimed_only'; end if;
  return 'open';
end $$;
revoke all on function public.launch50_phase() from public, anon, authenticated;

-- ── public summary (no personal data) ───────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.launch50_status() returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_phase text := public.launch50_phase(); v_open timestamptz;
begin
  begin v_open := public.launch50_cfg('launch50.opens_at')::timestamptz; exception when others then v_open := null; end;
  return jsonb_build_object('phase', v_phase, 'places_total', 50, 'places_left', greatest(0, 50 - public.launch50_used()),
    'opens_at', v_open, 'public_opens_at', case when v_open is null then null else v_open + interval '14 days' end);
end $$;
revoke all on function public.launch50_status() from public;
grant execute on function public.launch50_status() to anon, authenticated, service_role;

-- ── reserve (owner) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.launch50_reserve(p_business uuid, p_tier text, p_showcase boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_phase text := public.launch50_phase(); b public.local_businesses; p public.launch50_places; v_open timestamptz;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if p_tier not in ('pro', 'premium') then raise exception 'Choose Pro or Premium.' using errcode = '22023'; end if;
  if v_phase = 'closed' then raise exception 'OneShetland Launch 50 is not open.' using errcode = 'P0001', hint = 'closed'; end if;
  select * into b from public.local_businesses where id = p_business;
  if not found or b.owner_id is distinct from v_uid then raise exception 'You can only reserve a place for a business you manage.' using errcode = '42501'; end if;
  if exists (select 1 from public.discovery_fixtures f where f.entity = 'business' and f.entity_id = b.id) or coalesce(b.is_active, false) = false then
    raise exception 'This listing is not eligible.' using errcode = 'P0001', hint = 'not_eligible'; end if;
  if b.stripe_subscription_id is not null then raise exception 'This business already has a paid subscription.' using errcode = 'P0001', hint = 'has_subscription'; end if;
  if v_phase = 'claimed_only' then
    v_open := public.launch50_cfg('launch50.opens_at')::timestamptz;
    if b.owner_activated_at is null or b.owner_activated_at >= v_open then
      raise exception 'For the first 14 days, places are for businesses that already had a claimed listing.' using errcode = 'P0001', hint = 'claimed_only'; end if;
  end if;

  perform pg_advisory_xact_lock(50505050);                                            -- one reservation decision at a time: the limit cannot be oversubscribed
  select * into p from public.launch50_places where business_id = p_business for update;
  if found then
    if p.status in ('active', 'ended', 'pending_payment') then raise exception 'This business already has a Launch 50 place.' using errcode = 'P0001', hint = 'already_has_place'; end if;
    if p.status = 'reserved' and p.reservation_expires_at > now() then
      update public.launch50_places set tier = p_tier, showcase_opt_in = coalesce(p_showcase, false), reservation_expires_at = now() + interval '30 minutes', updated_at = now() where business_id = p_business;
      return jsonb_build_object('status', 'reserved', 'tier', p_tier, 'expires_at', now() + interval '30 minutes');
    end if;
  end if;
  if public.launch50_used() >= 50 then raise exception 'All 50 places are taken.' using errcode = 'P0001', hint = 'full'; end if;
  insert into public.launch50_places (business_id, owner_id, tier, status, reserved_at, reservation_expires_at, showcase_opt_in)
  values (p_business, v_uid, p_tier, 'reserved', now(), now() + interval '30 minutes', coalesce(p_showcase, false))
  on conflict (business_id) do update set owner_id = excluded.owner_id, tier = excluded.tier, status = 'reserved', reserved_at = now(),
    reservation_expires_at = excluded.reservation_expires_at, showcase_opt_in = excluded.showcase_opt_in, stripe_subscription_id = null, updated_at = now();
  return jsonb_build_object('status', 'reserved', 'tier', p_tier, 'expires_at', now() + interval '30 minutes');
end $$;
revoke all on function public.launch50_reserve(uuid, text, boolean) from public, anon;
grant execute on function public.launch50_reserve(uuid, text, boolean) to authenticated;

create or replace function public.launch50_release(p_business uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.launch50_places set status = 'released', reservation_expires_at = null, updated_at = now()
   where business_id = p_business and owner_id = auth.uid() and status = 'reserved';
end $$;
revoke all on function public.launch50_release(uuid) from public, anon;
grant execute on function public.launch50_release(uuid) to authenticated;

create or replace function public.launch50_set_showcase(p_business uuid, p_opt_in boolean) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.launch50_places set showcase_opt_in = coalesce(p_opt_in, false), updated_at = now()
   where business_id = p_business and owner_id = auth.uid() and status in ('reserved', 'pending_payment', 'active');
  if not found then raise exception 'No Launch 50 place for this business.' using errcode = 'P0001'; end if;
end $$;
revoke all on function public.launch50_set_showcase(uuid, boolean) from public, anon;
grant execute on function public.launch50_set_showcase(uuid, boolean) to authenticated;

-- ── server-side only (checkout function and webhook use the service role) ─────────────────────────────────────────────────────
-- Called by the subscription function just BEFORE it creates the discounted subscription: converts a live reservation into a held place.
create or replace function public.launch50_begin_checkout(p_business uuid, p_tier text, p_owner uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.launch50_places;
begin
  perform pg_advisory_xact_lock(50505050);
  select * into p from public.launch50_places where business_id = p_business for update;
  if not found or p.owner_id is distinct from p_owner or p.tier is distinct from p_tier then return jsonb_build_object('ok', false, 'reason', 'no_reservation'); end if;
  if p.status = 'pending_payment' then return jsonb_build_object('ok', true, 'resumed', true); end if;       -- a retried attempt resumes; never a second place
  if p.status <> 'reserved' or p.reservation_expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  update public.launch50_places set status = 'pending_payment', reservation_expires_at = null, updated_at = now() where business_id = p_business;
  return jsonb_build_object('ok', true, 'resumed', false);
end $$;

-- The discounted subscription could not be created: give the place back.
create or replace function public.launch50_abort_checkout(p_business uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.launch50_places set status = 'released', stripe_subscription_id = null, updated_at = now()
   where business_id = p_business and status = 'pending_payment' and stripe_subscription_id is null;
end $$;

create or replace function public.launch50_attach_subscription(p_business uuid, p_subscription_id text) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.launch50_places set stripe_subscription_id = p_subscription_id, updated_at = now()
   where business_id = p_business and status = 'pending_payment' and (stripe_subscription_id is null or stripe_subscription_id = p_subscription_id);
end $$;

-- Webhook: the discounted subscription is paid and live. Idempotent: replays and retries change nothing.
create or replace function public.launch50_activate(p_business uuid, p_subscription_id text, p_tier text, p_discount_ends_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.launch50_places;
begin
  perform pg_advisory_xact_lock(50505050);
  select * into p from public.launch50_places where business_id = p_business for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_place'); end if;
  if p.status = 'active' then
    return jsonb_build_object('ok', p.stripe_subscription_id = p_subscription_id, 'reason', case when p.stripe_subscription_id = p_subscription_id then 'already_active' else 'different_subscription' end);
  end if;
  if p.tier is distinct from p_tier then return jsonb_build_object('ok', false, 'reason', 'tier_mismatch'); end if;
  if p.status = 'ended' then return jsonb_build_object('ok', false, 'reason', 'already_ended'); end if;
  if p.status = 'released' and public.launch50_used() >= 50 then return jsonb_build_object('ok', false, 'reason', 'over_capacity'); end if;   -- never exceed 50: flagged for the owner of the programme
  update public.launch50_places set status = 'active', stripe_subscription_id = p_subscription_id, activated_at = now(), discount_ends_at = p_discount_ends_at,
         reservation_expires_at = null, updated_at = now() where business_id = p_business;
  return jsonb_build_object('ok', true, 'reason', 'activated');
end $$;

-- Webhook: the subscription ended (cancelled, unpaid or expired). Paid memberships keep counting; one that never started frees its place.
create or replace function public.launch50_subscription_ended(p_subscription_id text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.launch50_places;
begin
  perform pg_advisory_xact_lock(50505050);
  select * into p from public.launch50_places where stripe_subscription_id = p_subscription_id for update;
  if not found then return jsonb_build_object('ok', true, 'reason', 'unknown_subscription'); end if;
  if p.status = 'active' then update public.launch50_places set status = 'ended', ended_at = now(), updated_at = now() where business_id = p.business_id; return jsonb_build_object('ok', true, 'reason', 'ended'); end if;
  if p.status = 'pending_payment' then update public.launch50_places set status = 'released', stripe_subscription_id = null, updated_at = now() where business_id = p.business_id; return jsonb_build_object('ok', true, 'reason', 'released'); end if;
  return jsonb_build_object('ok', true, 'reason', 'no_change');
end $$;

-- Plan changes are deferred for Launch 50 subscriptions (the discount must keep its original end date).
create or replace function public.launch50_blocks_plan_change(p_business uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.launch50_places where business_id = p_business and status in ('pending_payment', 'active'))
$$;

-- Reminder: active members whose founding price ends within 30 days and who are not already cancelling.
create or replace function public.launch50_due_reminders() returns table (business_id uuid, owner_id uuid, tier text, discount_ends_at timestamptz, business_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.business_id, p.owner_id, p.tier, p.discount_ends_at, b.name
    from public.launch50_places p join public.local_businesses b on b.id = p.business_id
   where p.status = 'active' and p.reminder_sent_at is null and p.discount_ends_at <= now() + interval '30 days' and p.discount_ends_at > now()
     and coalesce(b.subscription_cancel_at_period_end, false) = false
$$;
create or replace function public.launch50_mark_reminded(p_business uuid) returns void language sql security definer set search_path = public, pg_temp as $$
  update public.launch50_places set reminder_sent_at = now(), updated_at = now() where business_id = p_business and reminder_sent_at is null
$$;
revoke all on function public.launch50_begin_checkout(uuid, text, uuid), public.launch50_abort_checkout(uuid), public.launch50_attach_subscription(uuid, text),
  public.launch50_activate(uuid, text, text, timestamptz), public.launch50_subscription_ended(text), public.launch50_blocks_plan_change(uuid),
  public.launch50_due_reminders(), public.launch50_mark_reminded(uuid) from public, anon, authenticated;
grant execute on function public.launch50_begin_checkout(uuid, text, uuid), public.launch50_abort_checkout(uuid), public.launch50_attach_subscription(uuid, text),
  public.launch50_activate(uuid, text, text, timestamptz), public.launch50_subscription_ended(text), public.launch50_blocks_plan_change(uuid),
  public.launch50_due_reminders(), public.launch50_mark_reminded(uuid) to service_role;

-- ── public showcase: opted-in, active members only; same card for Pro and Premium (tier is not exposed); neutral daily shuffle, no ranking ──
create or replace function public.launch50_showcase() returns table (id uuid, name text, slug text, category text, description text, logo_url text, cover_url text, website text, address text)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.name, b.slug, b.category, b.description, b.logo_url, b.cover_url, b.website, b.address
    from public.launch50_places p join public.local_businesses b on b.id = p.business_id
   where public.launch50_phase() <> 'closed' and p.status = 'active' and p.showcase_opt_in and b.is_active
   order by md5(b.id::text || current_date::text)
$$;
revoke all on function public.launch50_showcase() from public;
grant execute on function public.launch50_showcase() to anon, authenticated, service_role;

-- ── reminder email template (data row) ───────────────────────────────────────────────────────────────────────────────────────────
insert into public.email_templates (key, category, label, description, enabled, subject, body_html, variables, requires_optin, postmark_stream)
values ('launch50.price_returns', 'billing', 'Launch 50: standard price returns soon', 'Sent once, about 30 days before a Launch 50 member''s founding price ends.', true,
 '{{business_name}}: your OneShetland Launch 50 price ends on {{ends_on}}',
 '<h2>Your founding price ends soon</h2><p>{{business_name}} has been on OneShetland {{tier_label}} for {{founding_price}} a month as part of OneShetland Launch 50. That price runs until {{ends_on}}. After that, the standard {{standard_price}} a month applies, and nothing else changes.</p><p>You don''t need to do anything to keep your plan. To review or cancel, open <a href="{{billing_url}}">your billing page</a>.</p>',
 array['business_name','tier_label','founding_price','standard_price','ends_on','billing_url'], false, 'outbound')
on conflict (key) do nothing;
