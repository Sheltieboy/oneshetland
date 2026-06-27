-- ============================================================================
-- OneShetland — DEMO seed data for testers
-- ----------------------------------------------------------------------------
-- Creates OBVIOUSLY-FAKE "DEMO / TEST" businesses with everything switched on
-- (offers, stamps, points, bookable services, units, gift options,
-- wallet/cashback), plus demo jobs & shifts, two ticketed events, and two hubs
-- (a club + a charity with a fundraiser).
--
-- HOW TO RUN: paste this whole file into Supabase → SQL editor → Run.
-- RE-RUNNABLE (deletes previous demo rows first) and SELF-HEALING: this Supabase
-- project runs an OLDER schema than the code repo, so each section runs in its
-- own savepoint and is SKIPPED WITH A NOTICE if its table/column/constraint
-- isn't deployed here — the seed never aborts. Check the Messages/Notices tab
-- afterwards to see what was skipped.
--
-- ⚠️ Owner: uses the account whose email is `owner_email`; if not found, falls
-- back to your first admin account.  List accounts: select id, email from auth.users;
-- ============================================================================
DO $$
DECLARE
  owner_email text := 'darren@oneshetland.com';
  v_owner uuid;
  v_owner_acct text;
  oh jsonb := '{"mon":"09:00–17:00","tue":"09:00–17:00","wed":"09:00–17:00","thu":"09:00–17:00","fri":"09:00–17:00","sat":"10:00–16:00","sun":"Closed"}';
  b_cafe uuid; b_join uuid; b_spark uuid; b_plumb uuid; b_hair uuid; b_shop uuid;
  s_cut uuid; s_colour uuid;
  h_club uuid; h_trust uuid;
  e_quiz uuid; e_fair uuid;
  biz uuid;
  k text;
BEGIN
  -- ── Resolve owner ────────────────────────────────────────────────────────
  SELECT id INTO v_owner FROM auth.users WHERE lower(email) = lower(owner_email) LIMIT 1;
  IF v_owner IS NULL THEN
    SELECT id INTO v_owner FROM public.profiles WHERE role = 'admin' LIMIT 1;
  END IF;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'No user matched % and no admin profile was found. Run:  select id, email from auth.users order by created_at;  then set owner_email.', owner_email;
  END IF;

  -- Find a Stripe Connect account to make demo payments work, then copy it onto
  -- every demo business + hub at the end (so tickets/gifts/donations/memberships
  -- can take money in test mode). Read it BEFORE the cleanup delete so it
  -- SURVIVES re-seeds: prefer one already on a demo business (from when you
  -- connected its bank), else the owner's own connected (driver) account.
  -- => Connect a bank for ANY one demo business once, then it propagates here.
  SELECT stripe_account_id INTO v_owner_acct
    FROM public.local_businesses WHERE slug LIKE 'demo-%' AND stripe_account_id IS NOT NULL LIMIT 1;
  IF v_owner_acct IS NULL THEN
    BEGIN
      SELECT stripe_account_id INTO v_owner_acct
        FROM public.driver_profiles WHERE id = v_owner AND stripe_account_id IS NOT NULL;
    EXCEPTION WHEN OTHERS THEN v_owner_acct := NULL; END;
  END IF;

  -- ── Clean out previous demo rows (guarded; children before parents) ───────
  IF to_regclass('public.event_tickets') IS NOT NULL AND to_regclass('public.events') IS NOT NULL THEN
    DELETE FROM public.event_tickets WHERE event_id IN (SELECT id FROM public.events WHERE title LIKE 'DEMO —%');
  END IF;
  IF to_regclass('public.event_ticket_orders') IS NOT NULL AND to_regclass('public.events') IS NOT NULL THEN
    DELETE FROM public.event_ticket_orders WHERE event_id IN (SELECT id FROM public.events WHERE title LIKE 'DEMO —%');
  END IF;
  IF to_regclass('public.shift_applications') IS NOT NULL AND to_regclass('public.shifts') IS NOT NULL THEN
    DELETE FROM public.shift_applications WHERE shift_id IN (SELECT id FROM public.shifts WHERE title LIKE 'DEMO —%');
  END IF;
  -- event_checkins → events FK does not cascade; clear demo check-ins first.
  IF to_regclass('public.event_checkins') IS NOT NULL AND to_regclass('public.events') IS NOT NULL THEN
    DELETE FROM public.event_checkins WHERE event_id IN (SELECT id FROM public.events WHERE title LIKE 'DEMO —%');
  END IF;
  -- local_wallet_transactions.business_id is the ONE FK to local_businesses that
  -- doesn't cascade, so a tester's wallet payment to a demo business blocks the
  -- delete below. Clear those demo transactions first.
  IF to_regclass('public.local_wallet_transactions') IS NOT NULL THEN
    DELETE FROM public.local_wallet_transactions WHERE business_id IN (SELECT id FROM public.local_businesses WHERE slug LIKE 'demo-%');
  END IF;
  IF to_regclass('public.local_businesses') IS NOT NULL THEN DELETE FROM public.local_businesses WHERE slug LIKE 'demo-%'; END IF;
  IF to_regclass('public.hubs')             IS NOT NULL THEN DELETE FROM public.hubs             WHERE slug LIKE 'demo-%'; END IF;
  IF to_regclass('public.events')           IS NOT NULL THEN DELETE FROM public.events           WHERE title LIKE 'DEMO —%'; END IF;
  IF to_regclass('public.jobs')             IS NOT NULL THEN DELETE FROM public.jobs             WHERE title LIKE 'DEMO —%'; END IF;
  IF to_regclass('public.shifts')           IS NOT NULL THEN DELETE FROM public.shifts           WHERE title LIKE 'DEMO —%'; END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- BUSINESSES (6 demo, all clearly fake) — core; if this fails the whole seed
  -- can't proceed, so it's intentionally not wrapped.
  -- ════════════════════════════════════════════════════════════════════════
  INSERT INTO public.local_businesses
    (owner_id, name, slug, category, description, address, lat, lng, tags, phone, website, email,
     opening_hours, is_verified, is_active, is_claimed, accepts_wallet, cashback_percent,
     accepts_bookings, subscription_tier, brand_color, source)
  VALUES
    (v_owner, 'DEMO — Da Peerie Café (TEST)', 'demo-da-peerie-cafe', 'food_drink',
     'A made-up demo café for testing OneShetland. Stamps, offers and wallet all switched on.',
     'Commercial Street, Lerwick', 60.1551, -1.1448,
     ARRAY['Café','Coffee','Bakery','Takeaway'], '01595 000001', 'https://example.com', 'demo-cafe@example.com',
     oh, true, true, true, true, 5.00, true, 'premium', '#0E6E8C', 'owner')
    RETURNING id INTO b_cafe;
  INSERT INTO public.local_businesses
    (owner_id, name, slug, category, description, address, lat, lng, tags, phone, website, email,
     opening_hours, is_verified, is_active, is_claimed, accepts_wallet, cashback_percent,
     accepts_bookings, subscription_tier, brand_color, source)
  VALUES
    (v_owner, 'DEMO — Shetland Joinery & Building (TEST)', 'demo-joinery-building', 'services',
     'Demo joiner / builder for testing search and enquiries. Not a real business.',
     'Gremista, Lerwick', 60.1620, -1.1520,
     ARRAY['Joinery','Joiner','Carpentry','Building','Builder','Flooring','Kitchens'],
     '01595 000002', 'https://example.com', 'demo-joinery@example.com',
     oh, true, true, true, false, 0, false, 'pro', '#B9831F', 'owner')
    RETURNING id INTO b_join;
  INSERT INTO public.local_businesses
    (owner_id, name, slug, category, description, address, lat, lng, tags, phone, website, email,
     opening_hours, is_verified, is_active, is_claimed, accepts_wallet, cashback_percent,
     accepts_bookings, subscription_tier, brand_color, source)
  VALUES
    (v_owner, 'DEMO — Test Sparks Electrical (DEMO)', 'demo-electrical', 'services',
     'Demo electrician for testing search for "electrician" / "sparky". Not real.',
     'Scalloway', 60.1330, -1.2770,
     ARRAY['Electrical','Electrician','Sparky','PAT Testing','Rewiring'],
     '01595 000003', 'https://example.com', 'demo-electrical@example.com',
     oh, false, true, true, false, 0, false, 'free', '#1A8F7A', 'owner')
    RETURNING id INTO b_spark;
  INSERT INTO public.local_businesses
    (owner_id, name, slug, category, description, address, lat, lng, tags, phone, website, email,
     opening_hours, is_verified, is_active, is_claimed, accepts_wallet, cashback_percent,
     accepts_bookings, subscription_tier, brand_color, source)
  VALUES
    (v_owner, 'DEMO — Demo Plumbing & Heating (TEST)', 'demo-plumbing-heating', 'services',
     'Demo plumber for testing search for "plumber" / "boiler". Not real.',
     'Brae', 60.3950, -1.3520,
     ARRAY['Plumbing','Plumber','Heating','Gas','Boiler','Bathrooms'],
     '01806 000004', 'https://example.com', 'demo-plumbing@example.com',
     oh, true, true, true, false, 0, false, 'free', '#CF5F37', 'owner')
    RETURNING id INTO b_plumb;
  INSERT INTO public.local_businesses
    (owner_id, name, slug, category, description, address, lat, lng, tags, phone, website, email,
     opening_hours, is_verified, is_active, is_claimed, accepts_wallet, cashback_percent,
     accepts_bookings, subscription_tier, brand_color, source)
  VALUES
    (v_owner, 'DEMO — Da Demo Hair & Beauty (TEST)', 'demo-hair-beauty', 'services',
     'Demo salon for testing bookings, gift cards and points. Book a slot — no deposit needed.',
     'Esplanade, Lerwick', 60.1540, -1.1430,
     ARRAY['Hair & Beauty','Hairdresser','Barber','Massage & Therapy','Nails'],
     '01595 000005', 'https://example.com', 'demo-hair@example.com',
     oh, true, true, true, true, 3.00, true, 'premium', '#8E5BB5', 'owner')
    RETURNING id INTO b_hair;
  INSERT INTO public.local_businesses
    (owner_id, name, slug, category, description, address, lat, lng, tags, phone, website, email,
     opening_hours, is_verified, is_active, is_claimed, accepts_wallet, cashback_percent,
     accepts_bookings, subscription_tier, brand_color, source)
  VALUES
    (v_owner, 'DEMO — Da Demo Shop (TEST)', 'demo-shop', 'retail',
     'Demo gift & craft shop for testing offers, wallet and units. Not a real shop.',
     'Hamnavoe, Burra', 60.1010, -1.3330,
     ARRAY['Gifts & Crafts','Clothing','Hardware','Knitwear','Souvenirs'],
     '01595 000006', 'https://example.com', 'demo-shop@example.com',
     oh, false, true, true, true, 5.00, false, 'pro', '#C0392B', 'owner')
    RETURNING id INTO b_shop;

  -- An UNCLAIMED listing (no owner, is_claimed = false) so testers can try the
  -- "Claim this business" flow — every other demo business is already owned by
  -- the demo account, so the claim option never showed.
  INSERT INTO public.local_businesses
    (owner_id, name, slug, category, description, address, lat, lng, tags, phone, website, email,
     opening_hours, is_verified, is_active, is_claimed, accepts_wallet, cashback_percent,
     accepts_bookings, subscription_tier, brand_color, source)
  VALUES
    (NULL, 'DEMO — Unclaimed Croft Shop (TEST)', 'demo-unclaimed-croft-shop', 'retail',
     'A demo listing with no owner — use this to test claiming a business.',
     'Voe, Shetland', 60.3540, -1.2480,
     ARRAY['Farm shop','Local produce']::text[],
     '01806 000007', 'https://example.com', 'demo-unclaimed@example.com',
     oh, false, true, false, false, 0, false, 'free', '#6366F1', 'csv');

  -- ── Feature add-ons ON (per-key skip — older schemas allow fewer keys) ────
  BEGIN
    FOREACH biz IN ARRAY ARRAY[b_cafe, b_join, b_spark, b_plumb, b_hair, b_shop] LOOP
      FOREACH k IN ARRAY ARRAY['products','bookings','services','events','membership','offers','stamps','enquiries','payments','featured','jobs'] LOOP
        BEGIN
          INSERT INTO public.business_addons (business_id, addon_key, enabled)
          VALUES (biz, k, true)
          ON CONFLICT (business_id, addon_key) DO UPDATE SET enabled = true;
        EXCEPTION WHEN OTHERS THEN NULL;  -- key not supported in this schema; skip it
        END;
      END LOOP;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped business_addons: %', SQLERRM;
  END;

  -- ── Loyalty (one program per business) ───────────────────────────────────
  BEGIN
    INSERT INTO public.local_loyalty_programs (business_id, type, stamps_required, stamp_reward, is_active)
      VALUES (b_cafe, 'stamps', 9, 'A free hot drink of your choice', true);
    INSERT INTO public.local_loyalty_programs (business_id, type, points_per_pound, points_for_pound, is_active)
      VALUES (b_hair, 'points', 10, 100, true);
    INSERT INTO public.local_loyalty_programs (business_id, type, points_per_pound, points_for_pound, is_active)
      VALUES (b_shop, 'points', 5, 100, true);
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped loyalty: %', SQLERRM;
  END;

  -- ── Offers / deals ───────────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.local_offers (business_id, title, description, discount_type, discount_value, valid_from, valid_until, terms, is_active)
    VALUES
      (b_cafe,  '20% off all hot drinks', 'Show this in the demo café to test redeeming an offer.', 'percent', 20, now(), now() + interval '30 days', 'Demo offer. One per customer.', true),
      (b_shop,  'Buy one get one free on cards', 'Test a buy-one-get-one offer.', 'bogo', 0, now(), now() + interval '30 days', 'Demo offer.', true),
      (b_join,  '£50 off your first job', 'Test a fixed-amount offer.', 'fixed', 5000, now(), now() + interval '30 days', 'Demo offer.', true),
      (b_spark, 'Free safety check with any callout', 'Test a freebie offer.', 'freebie', 0, now(), now() + interval '30 days', 'Demo offer.', true),
      (b_hair,  '10% off your first appointment', 'Test an offer on a bookable business.', 'percent', 10, now(), now() + interval '30 days', 'Demo offer.', true);
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped offers: %', SQLERRM;
  END;

  -- ── Bookable services + availability (no deposit → bookable without paying) ─
  BEGIN
    INSERT INTO public.book_services (business_id, name, description, duration_minutes, price_pence, deposit_pence, requires_deposit, category, is_active, capacity, display_order)
      VALUES (b_hair, 'Cut & blow-dry', 'Demo bookable service — book a slot to test bookings.', 45, 3500, 0, false, 'haircut', true, 1, 1)
      RETURNING id INTO s_cut;
    INSERT INTO public.book_services (business_id, name, description, duration_minutes, price_pence, deposit_pence, requires_deposit, category, is_active, capacity, display_order)
      VALUES (b_hair, 'Full colour', 'Demo bookable service with a longer slot.', 120, 8500, 0, false, 'colour', true, 1, 2)
      RETURNING id INTO s_colour;
    INSERT INTO public.book_services (business_id, name, description, duration_minutes, price_pence, deposit_pence, requires_deposit, category, is_active, capacity, display_order)
      VALUES (b_cafe, 'Coffee & cake tasting', 'Demo bookable tasting session.', 60, 1200, 0, false, 'tasting', true, 6, 1);
    INSERT INTO public.book_availability_rules (business_id, service_id, day_of_week, start_time, end_time, slot_interval_minutes, is_active)
    SELECT b_hair, NULL, d, time '09:00', time '17:00', 30, true FROM generate_series(1,6) d;
    INSERT INTO public.book_availability_rules (business_id, service_id, day_of_week, start_time, end_time, slot_interval_minutes, is_active)
    SELECT b_cafe, NULL, d, time '10:00', time '16:00', 60, true FROM generate_series(1,6) d;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped bookable services: %', SQLERRM;
  END;

  -- ── Units (passes / cards) — also drive the gift flow ────────────────────
  BEGIN
    INSERT INTO public.book_unit_items (business_id, name, description, price_pence, stock, valid_days, uses_per_purchase, category, is_active, display_order)
    VALUES
      (b_cafe, '10-coffee loyalty card', 'Demo unit — buy once, redeem 10 times. Also giftable.', 2000, NULL, 180, 10, 'card', true, 1),
      (b_hair, '5-class wellbeing pass',  'Demo class pass — giftable.', 4000, NULL, 365, 5, 'pass', true, 1),
      (b_shop, 'Demo gift voucher (£10)', 'Demo voucher unit — buy and gift to someone.', 1000, NULL, 365, 1, 'voucher', true, 1);
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped units: %', SQLERRM;
  END;

  -- ── Jobs ─────────────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.jobs (employer_id, posted_as_business_id, title, description, category, location, locality, contract_type, pay_text, is_featured, is_hidden, expires_at)
    VALUES
      (v_owner, b_cafe,  'DEMO — Café Assistant', 'Demo job listing for testing. Friendly café in Lerwick looking for help.', 'Hospitality', 'Lerwick', 'lerwick', 'part-time', '£12.50/hr', true,  false, now() + interval '60 days'),
      (v_owner, b_join,  'DEMO — Apprentice Joiner', 'Demo job listing for testing. Learn the trade with a demo firm.', 'Trade', 'Lerwick', 'lerwick', 'apprenticeship', '£18,000/yr', false, false, now() + interval '60 days'),
      (v_owner, b_spark, 'DEMO — Qualified Electrician', 'Demo job listing for testing.', 'Trade', 'Scalloway', 'scalloway', 'full-time', '£32,000–38,000', true, false, now() + interval '60 days'),
      (v_owner, b_hair,  'DEMO — Hair Stylist', 'Demo job listing for testing.', 'Hair & Beauty', 'Lerwick', 'lerwick', 'full-time', 'Negotiable', false, false, now() + interval '60 days'),
      (v_owner, b_shop,  'DEMO — Weekend Shop Assistant', 'Demo job listing for testing.', 'Retail', 'Burra', 'west mainland', 'casual', '£11.44/hr', false, false, now() + interval '60 days');
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped jobs (Jobs board not deployed here): %', SQLERRM;
  END;

  -- ── Shifts ───────────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.shift_employer_profiles (id, business_name, is_verified, logo_url)
    VALUES (v_owner, 'OneShetland Demo', true, NULL)
    ON CONFLICT (id) DO UPDATE SET business_name = EXCLUDED.business_name;
    INSERT INTO public.shifts (employer_id, posted_as_business_id, title, description, category, location_text, start_at, end_at, pay_type, pay_amount, positions_total, requirements, urgency, status)
    VALUES
      (v_owner, b_cafe, 'DEMO — Evening café cover', 'Demo shift for testing. Help over a busy evening.', 'Hospitality', 'Lerwick',
         date_trunc('day', now() + interval '3 days') + interval '17 hours', date_trunc('day', now() + interval '3 days') + interval '22 hours', 'hourly', 13.00, 2, ARRAY['Friendly']::text[], 'this_week', 'open'),
      (v_owner, b_shop, 'DEMO — Saturday shop help', 'Demo shift for testing.', 'Retail', 'Burra',
         date_trunc('day', now() + interval '5 days') + interval '10 hours', date_trunc('day', now() + interval '5 days') + interval '16 hours', 'hourly', 11.44, 1, ARRAY[]::text[], 'this_week', 'open'),
      (v_owner, b_hair, 'DEMO — Cover stylist (one day)', 'Demo shift for testing.', 'Hair & Beauty', 'Lerwick',
         date_trunc('day', now() + interval '7 days') + interval '9 hours', date_trunc('day', now() + interval '7 days') + interval '17 hours', 'fixed', 120.00, 1, ARRAY['Qualified']::text[], 'planned', 'open'),
      (v_owner, b_cafe, 'DEMO — Event bar staff (ASAP)', 'Demo urgent shift for testing.', 'Hospitality', 'Lerwick',
         date_trunc('day', now() + interval '1 day') + interval '18 hours', date_trunc('day', now() + interval '1 day') + interval '23 hours 30 minutes', 'hourly', 14.50, 3, ARRAY['Over 18']::text[], 'asap', 'open');
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped shifts: %', SQLERRM;
  END;

  -- ── Events with tickets ──────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.events (organiser_user_id, organiser_business_id, title, description, category, venue, locality, lat, lng, starts_at, ends_at, status, has_tickets, capacity)
      VALUES (v_owner, b_cafe, 'DEMO — Da Peerie Quiz Night', 'A demo ticketed event for testing the tickets journey.', 'Social', 'Da Peerie Café, Lerwick', 'lerwick', 60.1551, -1.1448,
         date_trunc('day', now() + interval '10 days') + interval '19 hours 30 minutes', date_trunc('day', now() + interval '10 days') + interval '22 hours', 'published', true, 60)
      RETURNING id INTO e_quiz;
    INSERT INTO public.events (organiser_user_id, organiser_business_id, title, description, category, venue, locality, lat, lng, starts_at, ends_at, status, has_tickets, capacity)
      VALUES (v_owner, b_shop, 'DEMO — Craft & Makers Fair', 'A demo ticketed event for testing tickets and a family option.', 'Market', 'Burra Hall', 'west mainland', 60.1010, -1.3330,
         date_trunc('day', now() + interval '20 days') + interval '11 hours', date_trunc('day', now() + interval '20 days') + interval '16 hours', 'published', true, 200)
      RETURNING id INTO e_fair;
    INSERT INTO public.event_ticket_types (event_id, name, description, price_pence, quantity_available, per_order_max, is_active, display_order)
    VALUES
      (e_quiz, 'Team of 4', 'Demo ticket type.', 2000, 15, 4, true, 1),
      (e_quiz, 'Single entry', 'Demo ticket type.', 600, 60, 8, true, 2),
      (e_fair, 'Adult', 'Demo ticket type.', 300, 200, 10, true, 1),
      (e_fair, 'Family (2+2)', 'Demo ticket type.', 800, 100, 5, true, 2),
      (e_fair, 'Under 5s', 'Free demo ticket type.', 0, 200, 10, true, 3);
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped events: %', SQLERRM;
  END;

  -- ── Hubs (club + charity with a fundraiser) ──────────────────────────────
  BEGIN
    INSERT INTO public.hubs (owner_id, name, slug, type, description, area, join_mode, is_active, is_verified, contact_email)
      VALUES (v_owner, 'DEMO — Lerwick Rowing Club (TEST)', 'demo-rowing-club', 'sports',
         'A made-up demo club for testing memberships.', 'lerwick', 'approval', true, true, 'demo-club@example.com')
      RETURNING id INTO h_club;
    -- Charity hub: try with the Gift-Aid columns; fall back if they're not deployed.
    BEGIN
      INSERT INTO public.hubs (owner_id, name, slug, type, description, area, join_mode, is_active, is_verified, contact_email, is_charity, charity_number)
        VALUES (v_owner, 'DEMO — Shetland Community Trust (TEST)', 'demo-community-trust', 'charity',
           'A made-up demo charity for testing donations and Gift Aid.', 'all-shetland', 'open', true, true, 'demo-trust@example.com', true, 'SC012345')
        RETURNING id INTO h_trust;
    EXCEPTION WHEN undefined_column THEN
      INSERT INTO public.hubs (owner_id, name, slug, type, description, area, join_mode, is_active, is_verified, contact_email)
        VALUES (v_owner, 'DEMO — Shetland Community Trust (TEST)', 'demo-community-trust', 'charity',
           'A made-up demo charity for testing donations.', 'all-shetland', 'open', true, true, 'demo-trust@example.com')
        RETURNING id INTO h_trust;
    END;

    BEGIN
      INSERT INTO public.hub_members (hub_id, user_id, role, status) VALUES
        (h_club, v_owner, 'owner', 'active'), (h_trust, v_owner, 'owner', 'active');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped hub_members: %', SQLERRM; END;

    BEGIN
      INSERT INTO public.hub_membership_types (hub_id, name, description, price_pence, period, benefits, is_active, sort_order)
      VALUES
        (h_club,  'Supporter', 'Free supporter tier (demo).', 0,    'year', 'Newsletter and updates', true, 0),
        (h_club,  'Adult',     'Demo paid tier.',             2000, 'year', 'Full membership + voting', true, 1),
        (h_club,  'Junior',    'Demo paid tier.',             1000, 'year', 'Under-18 membership',      true, 2),
        (h_club,  'Family',    'Demo paid tier.',             3500, 'year', 'Up to 2 adults + children', true, 3),
        (h_trust, 'Free Supporter', 'Free supporter tier (demo).', 0, 'year', 'Updates from the Trust', true, 0);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped membership types: %', SQLERRM; END;

    BEGIN
      INSERT INTO public.hub_campaigns (hub_id, title, story, goal_pence, raised_pence, donor_count, status, ends_at, created_by)
      VALUES (h_trust, 'DEMO — New Minibus Appeal',
        'A demo fundraising campaign for testing donations and Gift Aid. No real money is involved in test mode.',
        500000, 125000, 18, 'active', now() + interval '45 days', v_owner);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped campaign: %', SQLERRM; END;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped hubs: %', SQLERRM;
  END;

  -- ── Make every demo business + hub payout-ready (test mode) ───────────────
  -- Copies the owner's connected Stripe account onto the demo entities so demo
  -- tickets / gifts / donations / paid memberships can actually take money.
  -- Skips quietly if the owner hasn't connected a bank yet.
  -- Always flip payout_enabled on demo entities so the UI lets you reach
  -- tickets/gifts/donations/memberships. If a real Connect account is known it's
  -- used as the destination; otherwise the edge functions detect the demo
  -- business/hub (slug 'demo-%') and charge the platform in TEST mode — so no
  -- real payout account is needed to test the demo purchase flows.
  BEGIN
    UPDATE public.local_businesses
      SET payout_enabled = true, stripe_account_id = COALESCE(v_owner_acct, stripe_account_id)
      WHERE slug LIKE 'demo-%';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped business payout setup: %', SQLERRM; END;
  BEGIN
    UPDATE public.hubs
      SET payout_enabled = true, stripe_account_id = COALESCE(v_owner_acct, stripe_account_id)
      WHERE slug LIKE 'demo-%';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Skipped hub payout setup: %', SQLERRM; END;
  RAISE NOTICE 'Demo businesses + hubs marked payout-ready for testing (destination: %).', COALESCE(v_owner_acct, 'platform/test');

  RAISE NOTICE 'Demo seed complete. Anything your project does not support was skipped (see notices above).';
END $$;
