-- OneShetland Editions R4a/R4b: commercial core. Admin commercial model, organiser-level entitlements, organiser packages (organiser pays OneShetland),
-- Stripe Connect payout accounts, VAT details and commercial terms, and the append-only payment ledger.
--
-- NOTHING here talks to Stripe. Money enters only through service-role functions called by a verified webhook (not deployed), or through the
-- organiser's own offline-record function. Everything is OFF unless admin_config 'editions.commerce.enabled' = 'true' AND editions.enabled.
-- No table of the existing platform (businesses, plans, hubs, hub_members, wallet) is read for writes or altered.

-- ── configuration (admin_config; every read fails closed) ───────────────────────────────────────────────────────────

create or replace function public.edition_commerce_cfg(p_key text, p_default text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select c.value from public.admin_config c where c.key = p_key), p_default)
$$;

create or replace function public.edition_commerce_enabled() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.editions_enabled() and public.edition_commerce_cfg('editions.commerce.enabled', 'false') = 'true'
$$;

create or replace function public.edition_commerce_terms_version() returns text
language sql stable security definer set search_path = public, pg_temp as $$ select public.edition_commerce_cfg('editions.commerce.terms_version', 'draft-1') $$;

-- Keys an administrator may set, with their validators. Anything else is refused (no arbitrary admin_config writes through this door).
create or replace function public.admin_set_edition_commerce_config(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  v_ok := case
    when p_key = 'editions.commerce.enabled' then p_value in ('true', 'false')
    when p_key in ('editions.commerce.participation.fee_percent', 'editions.commerce.membership.fee_percent') then p_value ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' and p_value::numeric <= 50
    when p_key in ('editions.commerce.participation.fee_fixed_pence', 'editions.commerce.membership.fee_fixed_pence', 'editions.commerce.participation.fee_min_pence', 'editions.commerce.membership.fee_min_pence')
      then p_value ~ '^[0-9]{1,5}$'
    when p_key in ('editions.commerce.participation.fee_cap_pence', 'editions.commerce.membership.fee_cap_pence') then p_value ~ '^[0-9]{1,7}$' or p_value = ''
    when p_key = 'editions.commerce.fee_payer' then p_value in ('organiser', 'business')
    when p_key = 'editions.commerce.grace_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 60
    when p_key = 'editions.commerce.max_charge_pence' then p_value ~ '^[0-9]{3,7}$'
    when p_key = 'editions.commerce.refund_application_fee' then p_value in ('true', 'false')
    when p_key = 'editions.commerce.vat_rate_percent' then p_value ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' and p_value::numeric <= 30
    when p_key = 'editions.commerce.terms_version' then p_value ~ '^[A-Za-z0-9._-]{1,20}$'
    else false end;
  if not coalesce(v_ok, false) then raise exception 'that setting or value is not allowed' using errcode = '22023'; end if;
  insert into public.admin_config (key, value, category) values (p_key, p_value, 'editions') on conflict (key) do update set value = excluded.value;
  perform public.edition_audit(null, null, 'commerce_config_set', jsonb_build_object('key', p_key, 'value', p_value));
end $$;

-- ── per-organiser fee overrides (admin only) ────────────────────────────────────────────────────────────────────────

create table if not exists public.edition_commercial_overrides (
  id              uuid primary key default gen_random_uuid(),
  organiser_id    uuid not null references public.edition_organisers (id) on delete cascade,
  kind            text not null check (kind in ('participation', 'membership')),
  fee_percent     numeric(5, 2) check (fee_percent is null or fee_percent between 0 and 50),
  fee_fixed_pence integer check (fee_fixed_pence is null or fee_fixed_pence between 0 and 100000),
  waived          boolean not null default false,
  reason          text not null check (char_length(btrim(reason)) >= 5),
  set_by          uuid references auth.users (id) on delete set null,
  until           timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists edition_commercial_overrides_org_idx on public.edition_commercial_overrides (organiser_id, kind, created_at desc);

create or replace function public.admin_set_edition_fee_override(p_org uuid, p_kind text, p_percent numeric, p_fixed integer, p_waived boolean, p_reason text, p_until timestamptz default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  insert into public.edition_commercial_overrides (organiser_id, kind, fee_percent, fee_fixed_pence, waived, reason, set_by, until)
  values (p_org, p_kind, p_percent, p_fixed, coalesce(p_waived, false), p_reason, auth.uid(), p_until) returning id into v_id;
  perform public.edition_audit(p_org, null, 'fee_override_set', jsonb_build_object('kind', p_kind, 'percent', p_percent, 'fixed', p_fixed, 'waived', p_waived, 'until', p_until, 'reason', p_reason));
  return v_id;
end $$;

-- ── fee and charge maths (pure given configuration; integer pence; GBP only) ────────────────────────────────────────

-- The platform fee for a price. percent + fixed, floor at min, ceiling at cap, never more than the price; the newest live override wins.
create or replace function public.edition_fee_calc(p_kind text, p_base_pence integer, p_org uuid) returns integer
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o public.edition_commercial_overrides; v_pct numeric; v_fixed integer; v_min integer; v_cap integer; v_fee integer; k text := 'editions.commerce.' || p_kind;
begin
  if p_kind not in ('participation', 'membership') then raise exception 'unknown fee kind' using errcode = '22023'; end if;
  if p_base_pence is null or p_base_pence <= 0 then return 0; end if;
  select * into o from public.edition_commercial_overrides x where x.organiser_id = p_org and x.kind = p_kind and (x.until is null or x.until > now()) order by x.created_at desc limit 1;
  if found and o.waived then return 0; end if;
  v_pct := coalesce(case when found then o.fee_percent end, public.edition_commerce_cfg(k || '.fee_percent', '5')::numeric);
  v_fixed := coalesce(case when found then o.fee_fixed_pence end, public.edition_commerce_cfg(k || '.fee_fixed_pence', '0')::integer);
  v_min := public.edition_commerce_cfg(k || '.fee_min_pence', '0')::integer;
  v_cap := nullif(public.edition_commerce_cfg(k || '.fee_cap_pence', ''), '')::integer;
  v_fee := round(p_base_pence * v_pct / 100.0)::integer + v_fixed;
  v_fee := greatest(v_fee, v_min);
  if v_cap is not null then v_fee := least(v_fee, v_cap); end if;
  return least(v_fee, p_base_pence);
end $$;

-- What a business is charged and what the organiser receives. fee_payer 'organiser' (default): fee comes out of the price. 'business': fee is added on top.
-- VAT: only when the organiser is VAT registered; 'inclusive' keeps the price, 'exclusive' adds VAT on top. Fees are computed on the price incl. VAT.
create or replace function public.edition_charge_breakdown(p_kind text, p_price_pence integer, p_vat_mode text, p_org uuid)
returns table (price_pence integer, vat_pence integer, platform_fee_pence integer, charge_pence integer, net_to_organiser_pence integer, vat_mode text, fee_payer text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rate numeric := public.edition_commerce_cfg('editions.commerce.vat_rate_percent', '20')::numeric; v_reg boolean; v_mode text := coalesce(p_vat_mode, 'none');
        v_vat integer := 0; v_gross integer; v_fee integer; v_payer text := public.edition_commerce_cfg('editions.commerce.fee_payer', 'organiser'); v_charge integer;
begin
  if p_price_pence is null or p_price_pence < 0 then raise exception 'invalid price' using errcode = '22023'; end if;
  select coalesce(a.vat_registered, false) into v_reg from public.edition_payout_accounts a where a.organiser_id = p_org;
  if not coalesce(v_reg, false) then v_mode := 'none'; end if;
  if v_mode = 'inclusive' then v_vat := round(p_price_pence - p_price_pence / (1 + v_rate / 100))::integer; v_gross := p_price_pence;
  elsif v_mode = 'exclusive' then v_vat := round(p_price_pence * v_rate / 100)::integer; v_gross := p_price_pence + v_vat;
  else v_gross := p_price_pence; end if;
  v_fee := public.edition_fee_calc(p_kind, v_gross, p_org);
  v_charge := case when v_payer = 'business' then v_gross + v_fee else v_gross end;
  return query select p_price_pence, v_vat, v_fee, v_charge, (v_charge - v_fee), v_mode, v_payer;
end $$;

-- ── organiser-level entitlements (what an organiser may DO; separate from the per-Edition 'publish' ledger) ─────────

create table if not exists public.edition_organiser_entitlements (
  id            uuid primary key default gen_random_uuid(),
  organiser_id  uuid not null references public.edition_organisers (id) on delete restrict,
  feature       text not null check (feature in ('collect_payments', 'memberships', 'offline_records', 'participation_fees', 'csv_export')),
  max_value     integer check (max_value is null or max_value > 0),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  source        text not null check (source in ('payment', 'admin_grant')),
  order_id      uuid,
  granted_by    uuid references auth.users (id) on delete set null,
  reason        text,
  voided_at     timestamptz,
  void_reason   text,
  created_at    timestamptz not null default now(),
  constraint edition_org_ent_window check (ends_at > starts_at),
  constraint edition_org_ent_grant_audit check (source <> 'admin_grant' or (granted_by is not null and char_length(btrim(coalesce(reason, ''))) >= 5))
);
create index if not exists edition_org_ent_idx on public.edition_organiser_entitlements (organiser_id, feature);

create or replace function public.edition_org_entitled(p_org uuid, p_feature text, p_at timestamptz default now()) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.edition_organiser_entitlements n where n.organiser_id = p_org and n.feature = p_feature and n.voided_at is null and n.starts_at <= p_at and n.ends_at > p_at)
$$;
create or replace function public.edition_org_limit(p_org uuid, p_feature text) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select max(n.max_value) from public.edition_organiser_entitlements n where n.organiser_id = p_org and n.feature = p_feature and n.voided_at is null and n.starts_at <= now() and n.ends_at > now()
$$;

create or replace function public.edition_org_ent_append_only() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'entitlements cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - 'voided_at' - 'void_reason') is distinct from (to_jsonb(old) - 'voided_at' - 'void_reason') then raise exception 'entitlements are append-only (only voiding is allowed)' using errcode = '42501'; end if;
  return new;
end $$;
create trigger edition_org_ent_append_only before update or delete on public.edition_organiser_entitlements for each row execute function public.edition_org_ent_append_only();

create or replace function public.admin_grant_edition_org_entitlement(p_org uuid, p_feature text, p_max integer, p_ends timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_ends is null or p_ends <= now() then raise exception 'a grant needs an end in the future' using errcode = '23514'; end if;
  if p_ends > now() + interval '25 months' then raise exception 'a grant cannot run longer than 24 months from now' using errcode = '23514'; end if;
  insert into public.edition_organiser_entitlements (organiser_id, feature, max_value, starts_at, ends_at, source, granted_by, reason) values (p_org, p_feature, p_max, now(), p_ends, 'admin_grant', auth.uid(), p_reason) returning id into v_id;
  perform public.edition_audit(p_org, null, 'org_entitlement_granted', jsonb_build_object('feature', p_feature, 'max', p_max, 'ends_at', p_ends, 'reason', p_reason));
  return v_id;
end $$;
create or replace function public.admin_void_edition_org_entitlement(p_entitlement uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.edition_organiser_entitlements%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason is required' using errcode = '23514'; end if;
  update public.edition_organiser_entitlements set voided_at = now(), void_reason = p_reason where id = p_entitlement and voided_at is null returning * into n;
  if not found then raise exception 'no live entitlement with that id' using errcode = 'P0002'; end if;
  perform public.edition_audit(n.organiser_id, null, 'org_entitlement_voided', jsonb_build_object('feature', n.feature, 'reason', p_reason));
end $$;

-- ── Connect payout account, VAT details, commercial terms ───────────────────────────────────────────────────────────

create table if not exists public.edition_payout_accounts (
  organiser_id         uuid primary key references public.edition_organisers (id) on delete cascade,
  stripe_account_id    text unique,
  details_submitted    boolean not null default false,
  charges_enabled      boolean not null default false,
  payouts_enabled      boolean not null default false,
  requirements_due     jsonb not null default '[]'::jsonb,
  vat_registered       boolean not null default false,
  vat_number           text check (vat_number is null or vat_number ~ '^(GB)?[0-9]{9}([0-9]{3})?$'),
  legal_name           text check (legal_name is null or char_length(btrim(legal_name)) between 2 and 160),
  collection_suspended boolean not null default false,
  suspended_reason     text,
  updated_at           timestamptz not null default now()
);

create table if not exists public.edition_commerce_terms_acceptances (
  id           uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.edition_organisers (id) on delete cascade,
  version      text not null,
  accepted_by  uuid not null references auth.users (id) on delete restrict,
  accepted_at  timestamptz not null default now(),
  unique (organiser_id, version)
);

-- Organisers set their own VAT and legal details (only they know them); status of the Stripe account is written by the service role only.
create or replace function public.edition_set_vat_details(p_org uuid, p_registered boolean, p_vat_number text, p_legal_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'only an owner can change payment details' using errcode = '42501'; end if;
  if coalesce(p_registered, false) and nullif(btrim(coalesce(p_vat_number, '')), '') is null then raise exception 'a VAT number is needed when VAT registered' using errcode = '23514'; end if;
  insert into public.edition_payout_accounts (organiser_id, vat_registered, vat_number, legal_name)
  values (p_org, coalesce(p_registered, false), upper(replace(nullif(btrim(coalesce(p_vat_number, '')), ''), ' ', '')), nullif(btrim(coalesce(p_legal_name, '')), ''))
  on conflict (organiser_id) do update set vat_registered = excluded.vat_registered, vat_number = excluded.vat_number, legal_name = excluded.legal_name, updated_at = now();
  perform public.edition_audit(p_org, null, 'vat_details_set', jsonb_build_object('registered', coalesce(p_registered, false)));
end $$;

create or replace function public.edition_accept_commerce_terms(p_org uuid, p_version text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'only an owner can accept the terms' using errcode = '42501'; end if;
  if p_version is distinct from public.edition_commerce_cfg('editions.commerce.terms_version', 'draft-1') then raise exception 'those are not the current terms' using errcode = '23514'; end if;
  insert into public.edition_commerce_terms_acceptances (organiser_id, version, accepted_by) values (p_org, p_version, auth.uid()) on conflict do nothing;
  perform public.edition_audit(p_org, null, 'commerce_terms_accepted', jsonb_build_object('version', p_version));
end $$;

-- Service role (verified webhook / onboarding function) only.
create or replace function public.edition_payout_account_sync(p_org uuid, p_account text, p_details boolean, p_charges boolean, p_payouts boolean, p_requirements jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.edition_payout_accounts (organiser_id, stripe_account_id, details_submitted, charges_enabled, payouts_enabled, requirements_due)
  values (p_org, p_account, coalesce(p_details, false), coalesce(p_charges, false), coalesce(p_payouts, false), coalesce(p_requirements, '[]'::jsonb))
  on conflict (organiser_id) do update set stripe_account_id = coalesce(public.edition_payout_accounts.stripe_account_id, excluded.stripe_account_id),
    details_submitted = excluded.details_submitted, charges_enabled = excluded.charges_enabled, payouts_enabled = excluded.payouts_enabled,
    requirements_due = excluded.requirements_due, updated_at = now()
   where public.edition_payout_accounts.stripe_account_id is null or public.edition_payout_accounts.stripe_account_id = excluded.stripe_account_id;
  if not found then raise exception 'a different Stripe account is already linked to this organiser' using errcode = '23514'; end if;
end $$;

create or replace function public.admin_set_edition_collection(p_org uuid, p_suspended boolean, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason is required' using errcode = '23514'; end if;
  insert into public.edition_payout_accounts (organiser_id, collection_suspended, suspended_reason) values (p_org, coalesce(p_suspended, false), p_reason)
  on conflict (organiser_id) do update set collection_suspended = excluded.collection_suspended, suspended_reason = excluded.suspended_reason, updated_at = now();
  perform public.edition_audit(p_org, null, case when p_suspended then 'collection_suspended' else 'collection_resumed' end, jsonb_build_object('reason', p_reason));
end $$;

-- The single gate every money-taking path calls. Returns the reason it is closed, or null when open. (Reasons are shown to organisers in plain words.)
create or replace function public.edition_collect_blocker(p_org uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.edition_payout_accounts%rowtype; o public.edition_organisers%rowtype;
begin
  if not public.edition_commerce_enabled() then return 'payments_off'; end if;
  select * into o from public.edition_organisers where id = p_org;
  if not found or o.status <> 'verified' then return 'organiser_not_verified'; end if;
  if not public.edition_org_entitled(p_org, 'collect_payments') then return 'no_collect_entitlement'; end if;
  if not exists (select 1 from public.edition_commerce_terms_acceptances t where t.organiser_id = p_org and t.version = public.edition_commerce_cfg('editions.commerce.terms_version', 'draft-1')) then return 'terms_not_accepted'; end if;
  select * into a from public.edition_payout_accounts where organiser_id = p_org;
  if not found or a.stripe_account_id is null then return 'no_payout_account'; end if;
  if a.collection_suspended then return 'collection_suspended'; end if;
  if not (a.charges_enabled and a.payouts_enabled) then return 'payout_account_incomplete'; end if;
  return null;
end $$;

-- ── payment ledger (append-only facts; corrections are new rows) ────────────────────────────────────────────────────

create table if not exists public.edition_payments (
  id                       uuid primary key default gen_random_uuid(),
  organiser_id             uuid not null references public.edition_organisers (id) on delete restrict,
  business_id              uuid not null references public.local_businesses (id) on delete restrict,
  payer_user_id            uuid references auth.users (id) on delete set null,
  kind                     text not null check (kind in ('membership', 'participation')),
  ref_id                   uuid not null,
  source                   text not null check (source in ('stripe', 'offline', 'complimentary')),
  status                   text not null check (status in ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'disputed', 'voided')),
  price_pence              integer not null check (price_pence >= 0),
  vat_pence                integer not null default 0 check (vat_pence >= 0),
  vat_mode                 text not null default 'none' check (vat_mode in ('none', 'inclusive', 'exclusive')),
  platform_fee_pence       integer not null default 0 check (platform_fee_pence >= 0),
  charge_pence             integer not null check (charge_pence >= 0),
  stripe_fee_pence         integer check (stripe_fee_pence is null or stripe_fee_pence >= 0),
  net_to_organiser_pence   integer not null,
  currency                 text not null default 'gbp' check (currency = 'gbp'),
  stripe_payment_intent_id text,
  stripe_invoice_id        text,
  stripe_charge_id         text,
  refunded_pence           integer not null default 0 check (refunded_pence >= 0),
  period_start             timestamptz,
  period_end               timestamptz,
  method                   text check (method is null or method in ('cheque', 'bank_transfer', 'cash', 'imported', 'other')),
  recorded_by              uuid references auth.users (id) on delete set null,
  note                     text check (note is null or char_length(note) <= 500),
  attempt_id               text,
  created_at               timestamptz not null default now(),
  constraint edition_payments_refund_cap check (refunded_pence <= charge_pence),
  constraint edition_payments_offline_note check (source = 'stripe' or char_length(btrim(coalesce(note, ''))) >= 3)
);
create unique index if not exists edition_payments_pi_uq on public.edition_payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null and stripe_invoice_id is null;
create unique index if not exists edition_payments_invoice_uq on public.edition_payments (stripe_invoice_id) where stripe_invoice_id is not null;
create index if not exists edition_payments_org_idx on public.edition_payments (organiser_id, created_at desc);
create index if not exists edition_payments_biz_idx on public.edition_payments (business_id, created_at desc);
create index if not exists edition_payments_ref_idx on public.edition_payments (kind, ref_id);

-- Only status and refunded_pence may ever change (a refund or dispute); every other fact is permanent.
create or replace function public.edition_payments_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'payments cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - 'status' - 'refunded_pence' - 'stripe_fee_pence' - 'stripe_charge_id') is distinct from (to_jsonb(old) - 'status' - 'refunded_pence' - 'stripe_fee_pence' - 'stripe_charge_id') then
    raise exception 'payments are append-only (only status, refunds and Stripe fee detail may change)' using errcode = '42501';
  end if;
  if new.refunded_pence < old.refunded_pence then raise exception 'a refund cannot be reduced' using errcode = '23514'; end if;
  return new;
end $$;
create trigger edition_payments_guard before update or delete on public.edition_payments for each row execute function public.edition_payments_guard();

-- ── organiser packages (organiser pays OneShetland; flow A) ─────────────────────────────────────────────────────────

create table if not exists public.edition_packages (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[a-z0-9_]{3,40}$'),
  name          text not null check (char_length(btrim(name)) between 2 and 80),
  description   text check (description is null or char_length(description) <= 600),
  price_pence   integer not null check (price_pence >= 0),
  duration_days integer not null check (duration_days between 1 and 800),
  features      jsonb not null default '[]'::jsonb,
  max_members   integer check (max_members is null or max_members > 0),
  active        boolean not null default false,
  sort          integer not null default 0,
  updated_at    timestamptz not null default now()
);
-- Draft catalogue only: inactive, placeholder prices. An administrator sets real values and switches them on.
insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort) values
  ('publish_single', 'Single Edition (DRAFT)', 'Publish one Edition for a year.', 0, 365, '[]', null, false, 10),
  ('publish_collect', 'Edition + collect payments (DRAFT)', 'Publish and collect memberships and participation fees.', 0, 365, '["collect_payments","memberships","participation_fees","offline_records"]', 200, false, 20),
  ('publish_full', 'Edition + payments + exports (DRAFT)', 'Everything, including CSV exports.', 0, 365, '["collect_payments","memberships","participation_fees","offline_records","csv_export"]', 1000, false, 30)
on conflict (code) do nothing;

create or replace function public.admin_upsert_edition_package(p_code text, p_name text, p_description text, p_price integer, p_days integer, p_features jsonb, p_max_members integer, p_active boolean, p_sort integer) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_features, '[]'::jsonb)) <> 'array' or exists (select 1 from jsonb_array_elements_text(coalesce(p_features, '[]'::jsonb)) f where f not in ('collect_payments', 'memberships', 'offline_records', 'participation_fees', 'csv_export')) then
    raise exception 'unknown feature in package' using errcode = '22023';
  end if;
  insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort) values (p_code, p_name, p_description, p_price, p_days, coalesce(p_features, '[]'::jsonb), p_max_members, coalesce(p_active, false), coalesce(p_sort, 0))
  on conflict (code) do update set name = excluded.name, description = excluded.description, price_pence = excluded.price_pence, duration_days = excluded.duration_days, features = excluded.features,
    max_members = excluded.max_members, active = excluded.active, sort = excluded.sort, updated_at = now() returning id into v_id;
  perform public.edition_audit(null, null, 'package_upserted', jsonb_build_object('code', p_code, 'price', p_price, 'active', p_active));
  return v_id;
end $$;

create table if not exists public.edition_orders (
  id                       uuid primary key default gen_random_uuid(),
  organiser_id             uuid not null references public.edition_organisers (id) on delete restrict,
  edition_id               uuid not null references public.editions (id) on delete restrict,
  package_id               uuid not null references public.edition_packages (id) on delete restrict,
  buyer_id                 uuid not null references auth.users (id) on delete restrict,
  status                   text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  amount_pence             integer not null check (amount_pence >= 0),
  package_snapshot         jsonb not null,
  stripe_payment_intent_id text unique,
  attempt_id               text not null,
  refunded_pence           integer not null default 0 check (refunded_pence >= 0),
  created_at               timestamptz not null default now(),
  paid_at                  timestamptz,
  unique (buyer_id, attempt_id)
);
create index if not exists edition_orders_org_idx on public.edition_orders (organiser_id, created_at desc);

-- Owners create an order at a price read from the database. One attempt id = one order (double submit returns the same order).
create or replace function public.edition_create_order(p_org uuid, p_edition uuid, p_package uuid, p_attempt text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk public.edition_packages%rowtype; v_id uuid; e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'only an owner can buy a package' using errcode = '42501'; end if;
  if not public.edition_commerce_enabled() then raise exception 'payments are not switched on yet' using errcode = '23514', hint = 'payments_off'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  select id into v_id from public.edition_orders where buyer_id = auth.uid() and attempt_id = p_attempt;
  if found then return v_id; end if;
  select * into e from public.editions where id = p_edition and organiser_id = p_org;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  select * into pk from public.edition_packages where id = p_package and active;
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  if pk.price_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), pk.price_pence, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_audit(p_org, p_edition, 'order_created', jsonb_build_object('order', v_id, 'package', pk.code, 'amount', pk.price_pence));
  return v_id;
end $$;

-- Service role: the verified payment succeeded. Idempotent on the PaymentIntent; amount must match the stored order; grants the Edition's publish window
-- (starting after any live window, so buying twice extends rather than overlaps) and the package's organiser-level features for the same period.
create or replace function public.edition_fulfil_order(p_order uuid, p_payment_intent text, p_amount integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_orders%rowtype; v_start timestamptz; v_end timestamptz; f text; pk jsonb;
begin
  select * into o from public.edition_orders where id = p_order for update;
  if not found then raise exception 'unknown order' using errcode = 'P0002'; end if;
  if o.status in ('paid', 'refunded', 'partially_refunded') then return 'already_fulfilled'; end if;
  if p_amount is distinct from o.amount_pence then raise exception 'paid amount does not match the order' using errcode = '23514', hint = 'amount_mismatch'; end if;
  pk := o.package_snapshot;
  select greatest(now(), coalesce(max(n.ends_at), now())) into v_start from public.edition_entitlements n where n.edition_id = o.edition_id and n.feature = 'publish' and n.voided_at is null and n.ends_at > now();
  v_end := v_start + make_interval(days => (pk ->> 'duration_days')::int);
  insert into public.edition_entitlements (organiser_id, edition_id, feature, starts_at, ends_at, source, order_id, stripe_payment_intent_id, amount_pence)
    values (o.organiser_id, o.edition_id, 'publish', v_start, v_end, 'payment', o.id, p_payment_intent, o.amount_pence);
  for f in select jsonb_array_elements_text(coalesce(pk -> 'features', '[]'::jsonb)) loop
    -- the organiser's abilities start NOW (a later Edition window must not delay them) and last as long as what was bought
    insert into public.edition_organiser_entitlements (organiser_id, feature, max_value, starts_at, ends_at, source, order_id)
      values (o.organiser_id, f, nullif(pk ->> 'max_members', '')::int, now(), v_end, 'payment', o.id);
  end loop;
  update public.edition_orders set status = 'paid', paid_at = now(), stripe_payment_intent_id = p_payment_intent where id = o.id;
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_paid', jsonb_build_object('order', o.id, 'amount', o.amount_pence));
  return 'fulfilled';
end $$;

create or replace function public.edition_order_failed(p_order uuid, p_payment_intent text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.edition_orders set status = 'failed', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent) where id = p_order and status = 'pending'
$$;

-- Service role: cumulative refunded amount from the payment provider. Full refund voids what the order granted; partial is recorded. Idempotent.
create or replace function public.edition_refund_order(p_order uuid, p_refunded_total integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.edition_orders%rowtype;
begin
  select * into o from public.edition_orders where id = p_order for update;
  if not found then raise exception 'unknown order' using errcode = 'P0002'; end if;
  if o.status not in ('paid', 'partially_refunded', 'refunded') then return 'not_paid'; end if;
  if p_refunded_total <= o.refunded_pence then return 'no_change'; end if;
  if p_refunded_total > o.amount_pence then raise exception 'refund exceeds the order' using errcode = '23514'; end if;
  update public.edition_orders set refunded_pence = p_refunded_total, status = case when p_refunded_total >= o.amount_pence then 'refunded' else 'partially_refunded' end where id = o.id;
  if p_refunded_total >= o.amount_pence then
    update public.edition_entitlements set voided_at = now(), void_reason = 'order refunded' where order_id = o.id and voided_at is null;
    update public.edition_organiser_entitlements set voided_at = now(), void_reason = 'order refunded' where order_id = o.id and voided_at is null;
  end if;
  perform public.edition_audit(o.organiser_id, o.edition_id, 'order_refunded', jsonb_build_object('order', o.id, 'refunded', p_refunded_total));
  return case when p_refunded_total >= o.amount_pence then 'voided' else 'recorded' end;
end $$;

-- ── offline records (organiser records money or a grant it already holds; no Stripe object) ────────────────────────

create or replace function public.edition_record_payment_row(p_org uuid, p_business uuid, p_kind text, p_ref uuid, p_source text, p_status text, p_price integer, p_vat integer, p_vat_mode text,
  p_fee integer, p_charge integer, p_net integer, p_pi text, p_invoice text, p_charge_id text, p_period_start timestamptz, p_period_end timestamptz, p_method text, p_by uuid, p_payer uuid, p_note text, p_attempt text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into public.edition_payments (organiser_id, business_id, payer_user_id, kind, ref_id, source, status, price_pence, vat_pence, vat_mode, platform_fee_pence, charge_pence, net_to_organiser_pence,
    stripe_payment_intent_id, stripe_invoice_id, stripe_charge_id, period_start, period_end, method, recorded_by, note, attempt_id)
  values (p_org, p_business, p_payer, p_kind, p_ref, p_source, p_status, p_price, p_vat, p_vat_mode, p_fee, p_charge, p_net, p_pi, p_invoice, p_charge_id, p_period_start, p_period_end, p_method, p_by, p_note, p_attempt)
  returning id into v_id;
  return v_id;
end $$;

-- ── lock down ───────────────────────────────────────────────────────────────────────────────────────────────────────

do $$ declare t text; begin
  foreach t in array array['edition_commercial_overrides', 'edition_organiser_entitlements', 'edition_payout_accounts', 'edition_commerce_terms_acceptances', 'edition_payments', 'edition_packages', 'edition_orders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

create policy "edition_overrides admin read" on public.edition_commercial_overrides for select to authenticated using (public.is_admin());
create policy "edition_org_ent read" on public.edition_organiser_entitlements for select to authenticated using (public.edition_org_can(organiser_id, 'admin') or public.is_admin());
create policy "edition_payout read" on public.edition_payout_accounts for select to authenticated using (public.edition_org_can(organiser_id, 'owner') or public.is_admin());
create policy "edition_terms read" on public.edition_commerce_terms_acceptances for select to authenticated using (public.edition_org_can(organiser_id, 'admin') or public.is_admin());
create policy "edition_payments org read" on public.edition_payments for select to authenticated using (public.edition_org_can(organiser_id, 'admin') or public.is_admin());
create policy "edition_payments payer read" on public.edition_payments for select to authenticated
  using (exists (select 1 from public.local_businesses b where b.id = business_id and b.owner_id = auth.uid()));
create policy "edition_packages read" on public.edition_packages for select to authenticated using (active or public.is_admin());
create policy "edition_orders read" on public.edition_orders for select to authenticated using (public.edition_org_can(organiser_id, 'owner') or public.is_admin());
grant select on public.edition_commercial_overrides, public.edition_organiser_entitlements, public.edition_payout_accounts, public.edition_commerce_terms_acceptances,
  public.edition_payments, public.edition_packages, public.edition_orders to authenticated;
-- Never expose the connected-account id to ordinary reads: the policy above lets owners read their row, so withhold the column.
revoke select on public.edition_payout_accounts from authenticated;
grant select (organiser_id, details_submitted, charges_enabled, payouts_enabled, requirements_due, vat_registered, vat_number, legal_name, collection_suspended, suspended_reason, updated_at) on public.edition_payout_accounts to authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'edition_commerce_terms_version()', 'edition_commerce_cfg(text,text)', 'edition_commerce_enabled()', 'admin_set_edition_commerce_config(text,text)',
    'admin_set_edition_fee_override(uuid,text,numeric,integer,boolean,text,timestamptz)', 'edition_fee_calc(text,integer,uuid)', 'edition_charge_breakdown(text,integer,text,uuid)',
    'edition_org_entitled(uuid,text,timestamptz)', 'edition_org_limit(uuid,text)', 'edition_org_ent_append_only()',
    'admin_grant_edition_org_entitlement(uuid,text,integer,timestamptz,text)', 'admin_void_edition_org_entitlement(uuid,text)',
    'edition_set_vat_details(uuid,boolean,text,text)', 'edition_accept_commerce_terms(uuid,text)', 'edition_payout_account_sync(uuid,text,boolean,boolean,boolean,jsonb)',
    'admin_set_edition_collection(uuid,boolean,text)', 'edition_collect_blocker(uuid)', 'edition_payments_guard()',
    'admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer)', 'edition_create_order(uuid,uuid,uuid,text)',
    'edition_fulfil_order(uuid,text,integer)', 'edition_order_failed(uuid,text)', 'edition_refund_order(uuid,integer)',
    'edition_record_payment_row(uuid,uuid,text,uuid,text,text,integer,integer,text,integer,integer,integer,text,text,text,timestamptz,timestamptz,text,uuid,uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- people (signed in): admin and owner actions, read-only helpers, the order creator and the blocker (to show organisers why collection is closed)
  foreach f in array array[
    'edition_commerce_terms_version()', 'edition_commerce_enabled()', 'admin_set_edition_commerce_config(text,text)', 'admin_set_edition_fee_override(uuid,text,numeric,integer,boolean,text,timestamptz)',
    'edition_charge_breakdown(text,integer,text,uuid)', 'edition_org_entitled(uuid,text,timestamptz)', 'edition_org_limit(uuid,text)',
    'admin_grant_edition_org_entitlement(uuid,text,integer,timestamptz,text)', 'admin_void_edition_org_entitlement(uuid,text)', 'edition_set_vat_details(uuid,boolean,text,text)',
    'edition_accept_commerce_terms(uuid,text)', 'admin_set_edition_collection(uuid,boolean,text)', 'edition_collect_blocker(uuid)',
    'admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer)', 'edition_create_order(uuid,uuid,uuid,text)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- money in: service role only (the verified webhook). Never granted to a person.
  foreach f in array array['edition_payout_account_sync(uuid,text,boolean,boolean,boolean,jsonb)', 'edition_fulfil_order(uuid,text,integer)', 'edition_order_failed(uuid,text)', 'edition_refund_order(uuid,integer)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.analytics_event_defs (event_name, is_conversion, category, description) values
  ('edition_membership_applied', true, 'sales_intent', 'A business applied to an organiser membership (no personal data)'),
  ('edition_participation_started', true, 'sales_intent', 'A business started paying for Edition participation')
on conflict (event_name) do nothing;
