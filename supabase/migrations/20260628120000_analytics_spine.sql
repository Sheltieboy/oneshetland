-- ============================================================================
-- Analytics spine (Phase 1a)
--
-- First-party, owned analytics. One append-only event stream + a governed
-- event registry + a safe ingest RPC. Revenue is NEVER read from here — money
-- always comes from the source-of-truth ledgers (event_ticket_orders,
-- book_bookings, hub_donations, local_wallet_transactions, delivery_requests,
-- local_boost_purchases, …). Events here only carry an order_id POINTER.
--
-- Privacy: free-text (search queries) is PII-scrubbed on ingest; the raw table
-- is admin-read-only; sellers/hubs never read it directly (aggregated RPCs come
-- in Phase 1c). Clients write via log_events(); server-side conversion events
-- are inserted by edge functions with the service role.
-- ============================================================================

-- ── 1. Event registry (governance + server-stamped semantics) ───────────────
-- The canonical list of valid events. is_conversion / category are stamped from
-- HERE on ingest, so a client can never mislabel an event as a conversion.
create table if not exists public.analytics_event_defs (
  event_name    text primary key,
  is_conversion boolean not null default false,
  category      text,                         -- transaction|sales_intent|lead|enquiry|referral|engagement|retention|seller_activation|content_interaction
  description   text,
  created_at    timestamptz not null default now()
);

insert into public.analytics_event_defs (event_name, is_conversion, category, description) values
  -- generic primitives
  ('session_started',              false, 'engagement',          'App opened / web session start'),
  ('screen_viewed',                false, 'content_interaction', 'Route/screen view (sampled)'),
  ('content_viewed',               false, 'content_interaction', 'Detail view of any object (object_type/object_id)'),
  ('search_performed',             false, 'content_interaction', 'Search submitted (query PII-scrubbed)'),
  ('filter_applied',               false, 'content_interaction', 'List filter applied'),
  ('item_saved',                   false, 'engagement',          'Saved/bookmarked an object'),
  ('item_unsaved',                 false, 'engagement',          'Removed a save'),
  ('content_shared',               true,  'referral',            'Shared an object'),
  ('contact_clicked',              true,  'lead',                'Tapped phone/email/website/directions on business or hub'),
  ('cta_clicked',                  false, 'content_interaction', 'Funnel-entry CTA tapped'),
  -- engagement / retention
  ('sign_in_completed',            false, 'engagement',          'Signed in'),
  ('business_followed',            false, 'engagement',          'Followed a business'),
  ('business_unfollowed',          false, 'engagement',          'Unfollowed a business'),
  ('loyalty_card_created',         false, 'engagement',          'Joined a loyalty card'),
  ('loyalty_stamp_collected',      false, 'retention',           'Collected a loyalty stamp'),
  ('gift_claimed',                 false, 'retention',           'Claimed a gift'),
  ('game_started',                 false, 'engagement',          'Started a game'),
  ('game_completed',               false, 'engagement',          'Completed a game'),
  ('daily_streak_claimed',         false, 'retention',           'Claimed daily streak'),
  ('spik_suggestion_submitted',    false, 'engagement',          'Suggested a dialect word'),
  ('memory_created',               false, 'engagement',          'Created a memory/story'),
  ('hub_document_downloaded',      false, 'engagement',          'Downloaded a hub document'),
  ('driver_run_created',           false, 'engagement',          'Driver created a run'),
  -- conversions: leads / intent
  ('sign_up_completed',            true,  'engagement',          'Account created (activation)'),
  ('ticket_purchase_started',      true,  'sales_intent',        'Opened ticket checkout'),
  ('ticket_outbound_clicked',      true,  'sales_intent',        'Clicked external ticket link (web)'),
  ('booking_started',              true,  'sales_intent',        'Began a booking'),
  ('booking_confirmed',            true,  'lead',                'Confirmed a (free/request) booking'),
  ('delivery_request_created',     true,  'sales_intent',        'Created a Fetch delivery request'),
  ('job_applied',                  true,  'lead',                'Applied to a job'),
  ('shift_applied',                true,  'lead',                'Applied to a shift'),
  ('hub_membership_started',       true,  'lead',                'Began hub membership join'),
  ('hub_membership_joined',        true,  'lead',                'Joined a hub (free)'),
  ('hub_donation_started',         true,  'sales_intent',        'Began a hub donation'),
  ('offer_redeemed',               true,  'sales_intent',        'Redeemed a local offer'),
  ('loyalty_reward_redeemed',      true,  'retention',           'Redeemed a loyalty reward'),
  -- conversions: transactions (server-fired; amount from ledger)
  ('event_ticket_purchased',       true,  'transaction',         'Paid for event tickets'),
  ('booking_paid',                 true,  'transaction',         'Paid a booking deposit'),
  ('unit_purchase_completed',      true,  'transaction',         'Bought a pass/unit item'),
  ('gift_purchased',               true,  'transaction',         'Bought a gift'),
  ('hub_donation_completed',       true,  'transaction',         'Completed a hub donation'),
  ('hub_membership_paid',          true,  'transaction',         'Paid a hub membership'),
  ('wallet_topup_completed',       true,  'transaction',         'Topped up the wallet'),
  ('wallet_payment_completed',     true,  'transaction',         'Paid a business via wallet'),
  ('delivery_payment_captured',    true,  'transaction',         'Delivery payment captured'),
  ('business_subscription_upgraded',true, 'transaction',         'Upgraded business subscription'),
  ('business_boost_purchased',     true,  'transaction',         'Bought a business boost'),
  ('shift_boost_purchased',        true,  'transaction',         'Bought a shift boost'),
  -- seller activation
  ('business_created',             true,  'seller_activation',   'Created a business'),
  ('business_claim_submitted',     true,  'seller_activation',   'Submitted a business claim'),
  ('business_claimed',             true,  'seller_activation',   'Business claim approved'),
  ('loyalty_program_created',      true,  'seller_activation',   'Set up a loyalty programme'),
  ('offer_created',                true,  'seller_activation',   'Published an offer'),
  ('service_listed',               true,  'seller_activation',   'Listed a bookable service'),
  ('event_created',                true,  'seller_activation',   'Created an event'),
  ('event_published',              true,  'seller_activation',   'Published an event'),
  ('job_posted',                   true,  'seller_activation',   'Posted a job'),
  ('shift_posted',                 true,  'seller_activation',   'Posted a shift'),
  ('hub_created',                  true,  'seller_activation',   'Created a hub'),
  ('campaign_published',           true,  'seller_activation',   'Published a fundraising campaign'),
  ('nfc_tile_requested',           true,  'seller_activation',   'Requested an NFC tile'),
  ('driver_application_submitted', true,  'seller_activation',   'Applied to be a driver'),
  ('driver_approved',              true,  'seller_activation',   'Driver approved'),
  ('driver_bank_connected',        true,  'seller_activation',   'Driver connected bank')
on conflict (event_name) do update
  set is_conversion = excluded.is_conversion,
      category      = excluded.category,
      description   = excluded.description;

-- ── 2. The event stream ─────────────────────────────────────────────────────
create table if not exists public.analytics_events (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),   -- client clock
  received_at   timestamptz not null default now(),   -- server clock
  event_name    text not null,
  -- identity (never trust client-supplied user_id; ingest sets it from the JWT)
  user_id       uuid references public.profiles(id) on delete set null,
  anon_id       text,                                  -- device/browser id (pre-auth stitching)
  session_id    text,
  -- context
  platform      text not null default 'app' check (platform in ('app','web')),
  user_type     text,                                  -- visitor|user|seller|admin|driver
  app_version   text,
  -- object / attribution
  object_type   text,                                  -- business|hub|event|job|shift|offer|service|spik_word|vessel|memory|cruise|notice
  object_id     text,                                  -- text: not every id is a uuid
  business_id   uuid references public.local_businesses(id) on delete set null,
  hub_id        uuid references public.hubs(id) on delete set null,
  order_id      uuid,                                  -- POINTER to a ledger row; money lives there, not here
  -- semantics (stamped from the registry on ingest)
  is_conversion boolean not null default false,
  category      text,
  -- freeform context (no $ amounts, no PII)
  props         jsonb not null default '{}'::jsonb,
  consent       boolean
);

create index if not exists analytics_events_occurred_idx    on public.analytics_events (occurred_at desc);
create index if not exists analytics_events_name_time_idx    on public.analytics_events (event_name, occurred_at desc);
create index if not exists analytics_events_business_idx     on public.analytics_events (business_id, occurred_at desc) where business_id is not null;
create index if not exists analytics_events_hub_idx          on public.analytics_events (hub_id, occurred_at desc) where hub_id is not null;
create index if not exists analytics_events_conversion_idx   on public.analytics_events (occurred_at desc) where is_conversion;
create index if not exists analytics_events_object_idx       on public.analytics_events (object_type, object_id);
create index if not exists analytics_events_user_idx         on public.analytics_events (user_id) where user_id is not null;

-- ── 3. Privacy: PII scrub for free-text ─────────────────────────────────────
create or replace function public.analytics_scrub_pii(p text)
returns text language sql immutable as $$
  select case when p is null then null else
    regexp_replace(
      regexp_replace(p, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
      '(\+?\d[\d ().-]{7,}\d)', '[phone]', 'g'
    )
  end
$$;

-- ── 4. RLS: nobody reads the raw stream except admins; nobody writes directly ─
alter table public.analytics_events     enable row level security;
alter table public.analytics_event_defs enable row level security;

drop policy if exists analytics_events_admin_read on public.analytics_events;
create policy analytics_events_admin_read on public.analytics_events
  for select using (
    exists (select 1 from public.profiles
            where id = auth.uid()
              and (is_platform_owner = true or role = 'admin'))
  );

drop policy if exists analytics_defs_read on public.analytics_event_defs;
create policy analytics_defs_read on public.analytics_event_defs
  for select using (true);   -- registry is non-sensitive (event names only)

-- No INSERT policy on analytics_events → direct client inserts are blocked.
-- Writes happen ONLY through log_events() (definer) or the service role.

-- ── 5. Ingest RPC (clients call this; semantics stamped server-side) ─────────
create or replace function public.log_events(p_events jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e   jsonb;
  def record;
  uid uuid := auth.uid();
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'p_events must be a JSON array';
  end if;

  for e in select value from jsonb_array_elements(p_events) loop
    select is_conversion, category into def
      from public.analytics_event_defs where event_name = e->>'event_name';

    insert into public.analytics_events (
      occurred_at, event_name, user_id, anon_id, session_id, platform, user_type,
      app_version, object_type, object_id, business_id, hub_id, order_id,
      is_conversion, category, props, consent
    ) values (
      coalesce((e->>'occurred_at')::timestamptz, now()),
      e->>'event_name',
      uid,                                   -- from the JWT, not the client payload
      e->>'anon_id',
      e->>'session_id',
      coalesce(e->>'platform','app'),
      e->>'user_type',
      e->>'app_version',
      e->>'object_type',
      e->>'object_id',
      nullif(e->>'business_id','')::uuid,
      nullif(e->>'hub_id','')::uuid,
      nullif(e->>'order_id','')::uuid,
      coalesce(def.is_conversion, false),    -- never trust client for this
      def.category,
      -- scrub the known free-text prop before it ever lands
      case when (e->'props') ? 'query'
        then jsonb_set(coalesce(e->'props','{}'::jsonb), '{query}',
                       to_jsonb(public.analytics_scrub_pii(e->'props'->>'query')))
        else coalesce(e->'props','{}'::jsonb)
      end,
      coalesce((e->>'consent')::boolean, true)
    );
  end loop;
end
$$;

revoke all on function public.log_events(jsonb) from public;
grant execute on function public.log_events(jsonb) to anon, authenticated;

-- ── 6. The £10/mo "analytics" add-on (gate for the seller dashboard) ─────────
alter table public.business_addons drop constraint if exists valid_addon_key;
alter table public.business_addons add constraint valid_addon_key
  check (addon_key = any (array[
    'products','bookings','services','events','membership',
    'offers','stamps','enquiries','payments','featured','jobs','analytics'
  ]));

-- seed the new add-on (disabled) for every existing business
insert into public.business_addons (business_id, addon_key, enabled)
  select id, 'analytics', false from public.local_businesses
on conflict (business_id, addon_key) do nothing;

-- include it in the seed trigger for future businesses
create or replace function public.tg_seed_business_addons() returns trigger
language plpgsql as $$
begin
  insert into public.business_addons (business_id, addon_key, enabled) values
    (new.id, 'products',   false),
    (new.id, 'bookings',   false),
    (new.id, 'services',   false),
    (new.id, 'events',     false),
    (new.id, 'membership', false),
    (new.id, 'offers',     false),
    (new.id, 'stamps',     false),
    (new.id, 'enquiries',  false),
    (new.id, 'payments',   false),
    (new.id, 'featured',   false),
    (new.id, 'jobs',       false),
    (new.id, 'analytics',  false)
  on conflict (business_id, addon_key) do nothing;
  return new;
end
$$;

-- convenience gate used by the (future) seller dashboard RPCs
create or replace function public.business_has_analytics(p_business_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.business_addons
    where business_id = p_business_id and addon_key = 'analytics' and enabled = true
  )
$$;
