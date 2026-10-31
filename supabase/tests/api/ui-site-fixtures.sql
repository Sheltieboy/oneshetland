-- ui-site-fixtures.sql — LOCAL-ONLY, FICTIONAL demonstration content so the website's pages look populated. Every business, person, job, offer and
-- event below is invented (the ".example" domains are reserved and never resolve); none is copied from production. Images are the demonstration assets in
-- supabase/tests/api/demo-assets, served by ui-proxy.mjs; :base is that proxy's origin (set by ui-fixture-env.sh). Business categories use the real
-- taxonomy (food_drink / retail / services / accommodation) so the homepage's curated "Open for business" filter accepts them.
-- Runs after ui-fixtures.sql (which owns the notice publishers: Bea Bakery, the long-named knitwear business, the Voe & Aith hub and OneShetland).

alter table events disable trigger commercial_terms_guard;
alter table hubs disable trigger tg_zz_lock_hub_columns;

-- ── the two notice-fixture businesses get the real taxonomy and enough detail to be listed ──────────────────────────────────────────────────────
update local_businesses set category = 'food_drink', description = 'Fresh bannocks, bread and cakes baked every morning in Lerwick.', address = 'Commercial Street, Lerwick',
  is_claimed = true, is_verified = true, subscription_tier = 'pro', cover_url = :'base' || '/demo-assets/cafe.jpg', phone = '01595 555 0101', website = 'https://bea-bakery.example',
  lat = 60.1545, lng = -1.1456 where slug = 'bea-bakery';
update local_businesses set category = 'retail', description = 'Shetland knitwear and gifts, made and sold in Hillswick.', address = 'Hillswick, Shetland',
  is_claimed = true, is_verified = false, subscription_tier = 'free', cover_url = :'base' || '/demo-assets/shopping.jpg', phone = '01806 555 0102' where slug = 'long-biz';

-- ── businesses (all fictional) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into local_businesses (id, owner_id, name, slug, category, description, address, phone, website, cover_url, is_active, is_claimed, is_verified, subscription_tier, subscription_until, brand_color, created_at) values
  ('b1000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-0000000000c1','Peerie Voe Café','peerie-voe-cafe','food_drink','A small harbourside café serving soup, toasties and home baking, with a woodburner and the best window seat in Lerwick.','Esplanade, Lerwick','01595 555 0103','https://peerie-voe-cafe.example', :'base' || '/demo-assets/cafe.jpg', true, true, true,'pro', now() + interval '300 day','#8a4b14', now() - interval '60 day'),
  ('b1000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-0000000000c1','Skerry Fish Bar','skerry-fish-bar','food_drink','Fish suppers made with the day''s landings, a short walk from the Scalloway harbour front.','Main Street, Scalloway','01595 555 0104',null, :'base' || '/demo-assets/local-street.jpg', true, true, false,'free', null,'#0e6ea6', now() - interval '45 day'),
  ('b1000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-0000000000c1','Brae Hardware & Garden','brae-hardware','retail','Tools, paint, fixings and everything for a Shetland garden, with friendly advice at the counter.','Brae, Shetland','01806 555 0105','https://brae-hardware.example', :'base' || '/demo-assets/shopping.jpg', true, true, true,'free', null,'#2f6b3b', now() - interval '90 day'),
  ('b1000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-0000000000c1','Hamefarin Weaving Studio','hamefarin-weaving','retail','A one-loom studio weaving scarves, blankets and cushions from local wool, open by appointment and on market days.','Whiteness, Shetland','01595 555 0106','https://hamefarin-weaving.example', :'base' || '/demo-assets/jarlshof2.jpg', true, true, true,'premium', now() + interval '200 day','#7a2e5a', now() - interval '120 day'),
  ('b1000000-0000-4000-8000-000000000005','c0000000-0000-4000-8000-0000000000c1','Sound View Guesthouse','sound-view-guesthouse','accommodation','Four comfortable rooms and a big breakfast overlooking Yell Sound, ideal for walkers and birdwatchers.','Mid Yell, Shetland','01957 555 0107','https://sound-view-guesthouse.example', :'base' || '/demo-assets/lighthouse.jpg', true, true, true,'pro', now() + interval '150 day','#1e3a8a', now() - interval '75 day'),
  ('b1000000-0000-4000-8000-000000000006','c0000000-0000-4000-8000-0000000000c1','Papa Stour Cottages','papa-stour-cottages','accommodation','Two self-catering cottages beside the voe on Papa Stour, with peat stoves and sea views.','Papa Stour, Shetland','01595 555 0108',null, :'base' || '/demo-assets/scatness.jpg', true, true, false,'free', null,'#4b5563', now() - interval '30 day'),
  ('b1000000-0000-4000-8000-000000000007','c0000000-0000-4000-8000-0000000000c1','Lerwick Bike Workshop','lerwick-bike-workshop','services','Repairs, servicing and second-hand bikes. Walk-ins welcome; same-day punctures.','North Road, Lerwick','01595 555 0109',null, :'base' || '/demo-assets/local-street.jpg', true, true, false,'free', null,'#c2410c', now() - interval '20 day'),
  ('b1000000-0000-4000-8000-000000000008','c0000000-0000-4000-8000-0000000000c1','Whalsay Bookkeeping & Accounts','whalsay-bookkeeping','services','Bookkeeping, VAT returns and year-end accounts for small island businesses and crofts.','Symbister, Whalsay','01806 555 0110','https://whalsay-bookkeeping.example', null, true, true, true,'free', null,'#374151', now() - interval '150 day');

-- ── offers (valid now) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into local_offers (business_id, title, description, image_url, discount_type, discount_value, valid_from, valid_until, is_active, created_at) values
  ('b1000000-0000-4000-8000-000000000001','10% off your first hot drink','Show this offer at the counter on your first visit.', :'base' || '/demo-assets/cafe.jpg','percent',10, now() - interval '3 day', now() + interval '40 day', true, now() - interval '3 day'),
  ('b1000000-0000-4000-8000-000000000002','£2 off a fish supper on Tuesdays','Valid on Tuesdays only, eat in or take away.', :'base' || '/demo-assets/local-street.jpg','amount',200, now() - interval '5 day', now() + interval '30 day', true, now() - interval '5 day'),
  ('b1000000-0000-4000-8000-000000000003','15% off winter garden care','Frost cloth, bulbs and winter feed.', :'base' || '/demo-assets/shopping.jpg','percent',15, now() - interval '2 day', now() + interval '35 day', true, now() - interval '2 day'),
  ('b1000000-0000-4000-8000-000000000005','£15 off a midweek stay','Sunday to Thursday, subject to availability.', :'base' || '/demo-assets/lighthouse.jpg','amount',1500, now() - interval '1 day', now() + interval '60 day', true, now() - interval '1 day'),
  ('b1000000-0000-4000-8000-000000000004','10% off hand-woven scarves','Until stocks of the winter range run out.', :'base' || '/demo-assets/jarlshof2.jpg','percent',10, now() - interval '4 day', now() + interval '25 day', true, now() - interval '4 day');

-- ── products (the Shop shelf; each needs a photo) ────────────────────────────────────────────────────────────────────────────────────────────────
insert into products (business_id, title, description, price_pence, photos, category, created_at) values
  ('b1000000-0000-4000-8000-000000000004','Hand-woven wool scarf','Soft, warm and woven on the island from Shetland wool.', 4200, array[:'base' || '/demo-assets/jarlshof2.jpg'], 'clothing', now() - interval '1 day'),
  ('b1000000-0000-4000-8000-000000000004','Woven wool cushion cover','Natural undyed fleece tones, 45cm square.', 3400, array[:'base' || '/demo-assets/scatness.jpg'], 'home', now() - interval '2 day'),
  ('bb000000-0000-4000-8000-0000000000b2','Fair Isle-pattern knitted hat','Hand-finished with a lined headband.', 2800, array[:'base' || '/demo-assets/shopping.jpg'], 'clothing', now() - interval '3 day'),
  ('bb000000-0000-4000-8000-0000000000bb','Box of six bannocks','Baked this morning; collect in Lerwick.', 750, array[:'base' || '/demo-assets/cafe.jpg'], 'food', now() - interval '4 day'),
  ('b1000000-0000-4000-8000-000000000001','Peerie Voe house blend coffee, 250g','Medium roast, whole bean.', 695, array[:'base' || '/demo-assets/cafe.jpg'], 'food', now() - interval '5 day'),
  ('b1000000-0000-4000-8000-000000000003','Winter-lined garden gloves','Waterproof, sizes M–XL.', 1250, array[:'base' || '/demo-assets/local-street.jpg'], 'home', now() - interval '6 day');

-- ── hubs and fundraisers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled, brand_color, description, type, area, cover_url, created_at) values
  ('dd000000-0000-4000-8000-0000000000f1','d0000000-0000-4000-8000-0000000000d1','Lerwick Community Choir','lerwick-choir', true, false,'#7c3aed','A friendly mixed choir that meets every Wednesday evening in Lerwick. No auditions.','community','Lerwick', :'base' || '/demo-assets/concert.jpg', now() - interval '200 day'),
  ('dd000000-0000-4000-8000-0000000000f2','d0000000-0000-4000-8000-0000000000d1','Whalsay Heritage Group','whalsay-heritage', true, false,'#0f766e','Looking after the stories, boats and buildings of Whalsay.','community','Whalsay', :'base' || '/demo-assets/scatness.jpg', now() - interval '300 day'),
  ('dd000000-0000-4000-8000-0000000000f3','d0000000-0000-4000-8000-0000000000d1','Shetland Fiddle & Accordion Society','fiddle-society', true, false,'#b45309','Weekly sessions, summer workshops and an annual winter concert.','community','Shetland', :'base' || '/demo-assets/jarlshof.jpg', now() - interval '400 day');
update hubs set cover_url = :'base' || '/demo-assets/events.jpg' where slug = 'voe-hall';
insert into hub_campaigns (id, hub_id, title, raised_pence, goal_pence, donor_count, status, description, created_at) values
  ('ca000000-0000-4000-8000-0000000000c2','dd000000-0000-4000-8000-0000000000f2','Restore the Whalsay heritage boat', 642000, 1500000, 87, 'active','Help us restore a 1930s sixareen to sail again.', now() - interval '10 day'),
  ('ca000000-0000-4000-8000-0000000000c3','dd000000-0000-4000-8000-0000000000f1','Hire a hall for the winter concert', 38000, 120000, 24, 'active','Hall hire, lighting and refreshments for our winter concert.', now() - interval '3 day');
update hub_campaigns set created_at = now() - interval '6 day' where id = 'ca000000-0000-4000-8000-0000000000ca';

insert into hub_members (hub_id, user_id, role) values
  ('dd000000-0000-4000-8000-0000000000f1','a0000000-0000-4000-8000-0000000000a1','member'), ('dd000000-0000-4000-8000-0000000000f1','c0000000-0000-4000-8000-0000000000c1','member'),
  ('dd000000-0000-4000-8000-0000000000f2','a0000000-0000-4000-8000-0000000000a1','member'),
  ('dd000000-0000-4000-8000-0000000000f3','a0000000-0000-4000-8000-0000000000a1','member'), ('dd000000-0000-4000-8000-0000000000f3','c0000000-0000-4000-8000-0000000000c1','member'),
  ('dd000000-0000-4000-8000-0000000000dd','a0000000-0000-4000-8000-0000000000a1','member')
  on conflict do nothing;

-- ── events (published; no tickets, so there is nothing to buy) ───────────────────────────────────────────────────────────────────────────────────
insert into events (id, title, description, category, venue, locality, starts_at, ends_at, cover_url, price_text, is_featured, status, organiser_business_id, organiser_hub_id, hub_visibility, has_tickets, is_platform_event) values
  ('e1000000-0000-4000-8000-000000000011','Lerwick Winter Market','Local makers, baking, knitwear and hot drinks beside the harbour.','Market','Market Cross, Lerwick','Lerwick', date_trunc('day', now()) + interval '5 day 10 hour', date_trunc('day', now()) + interval '5 day 16 hour', :'base' || '/demo-assets/local-street.jpg','Free entry', true,'published', null, null, null, false, true),
  ('e1000000-0000-4000-8000-000000000012','Fiddle & Accordion Night','An evening of traditional tunes with the Fiddle & Accordion Society. All welcome to sit in.','Music','Peerie Voe Café, Lerwick','Lerwick', date_trunc('day', now()) + interval '3 day 19 hour 30 minute', date_trunc('day', now()) + interval '3 day 22 hour 30 minute', :'base' || '/demo-assets/concert.jpg','£8 on the door', false,'published','b1000000-0000-4000-8000-000000000001', null, null, false, false),
  ('e1000000-0000-4000-8000-000000000013','Guided walk: Scatness Broch and Iron Age Village','A gentle two-and-a-half-hour guided walk with a local archaeologist. Wear sturdy shoes.','Outdoors','Scatness, Sumburgh','Sumburgh', date_trunc('day', now()) + interval '6 day 11 hour', date_trunc('day', now()) + interval '6 day 13 hour 30 minute', :'base' || '/demo-assets/scatness.jpg','£5 per person', false,'published', null, null, null, false, true),
  ('e1000000-0000-4000-8000-000000000014','Open lighthouse afternoon','Climb the tower, see the lamp room and hear the lighthouse keepers'' stories.','Arts & Culture','Sumburgh Head','Sumburgh', date_trunc('day', now()) + interval '9 day 13 hour', date_trunc('day', now()) + interval '9 day 16 hour', :'base' || '/demo-assets/lighthouse.jpg','Free', false,'published', null, null, null, false, true),
  ('e1000000-0000-4000-8000-000000000015','Peerie bakers: kids'' bannock workshop','Children (6+) bake and decorate their own bannocks. Parents welcome to watch.','Family','Bea Bakery, Commercial Street','Lerwick', date_trunc('day', now()) + interval '12 day 10 hour', date_trunc('day', now()) + interval '12 day 12 hour', :'base' || '/demo-assets/cafe.jpg','£6 per child', false,'published','bb000000-0000-4000-8000-0000000000bb', null, null, false, false),
  ('e1000000-0000-4000-8000-000000000016','Winter talk: Viking Shetland at Jarlshof','An illustrated talk on 4,000 years of settlement at Jarlshof, with time for questions.','Arts & Culture','Mareel, Lerwick','Lerwick', date_trunc('day', now()) + interval '14 day 18 hour', date_trunc('day', now()) + interval '14 day 19 hour 30 minute', :'base' || '/demo-assets/jarlshof.jpg','£4', false,'published', null, null, null, false, true),
  ('e1000000-0000-4000-8000-000000000017','Community soup lunch','Soup, bread and a blether at the hall; all proceeds to the roof fund.','Community','Voe Hall, Voe','Voe', date_trunc('day', now()) + interval '4 day 12 hour', date_trunc('day', now()) + interval '4 day 14 hour', :'base' || '/demo-assets/events.jpg','Donations', false,'published', null,'dd000000-0000-4000-8000-0000000000dd','islands', false, false),
  ('e1000000-0000-4000-8000-000000000018','Shetland Textile Showcase','A month-long exhibition of weaving, knitting and dyeing from island makers.','Arts & Culture','Shetland Museum and Archives, Lerwick','Lerwick', date_trunc('day', now()) - interval '3 day' + interval '10 hour', date_trunc('day', now()) + interval '20 day 17 hour', :'base' || '/demo-assets/jarlshof2.jpg','Free', false,'published', 'b1000000-0000-4000-8000-000000000004', null, null, false, false);
update events set cover_url = :'base' || '/demo-assets/concert.jpg', venue = 'Voe Hall, Voe', description = 'Haggis, neeps and tatties, then a ceilidh.', category = 'Community', price_text = 'Donations' where id = 'e1000000-0000-4000-8000-000000000001';

-- ── work: jobs and shifts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into jobs (title, locality, location, description, contract_type, pay_text, status, is_hidden, is_featured, posted_as_business_id, external_employer_name, posted_at, listed_at, expires_at) values
  ('Café assistant (part-time)','Lerwick','Esplanade, Lerwick','Serve customers, make coffee and help in the kitchen. Training provided.','part-time','£12.60 per hour','open', false, true,'b1000000-0000-4000-8000-000000000001', null, now() - interval '2 day', now() - interval '2 day', now() + interval '25 day'),
  ('Fish bar assistant','Scalloway','Main Street, Scalloway','Frying, serving and cleaning. Evenings and weekends.','part-time','£12.21 per hour','open', false, false,'b1000000-0000-4000-8000-000000000002', null, now() - interval '4 day', now() - interval '4 day', now() + interval '20 day'),
  ('Housekeeper (seasonal)','Mid Yell','Sound View Guesthouse','Room changeovers and breakfast set-up, April to September.','temporary','£12.60 per hour','open', false, false,'b1000000-0000-4000-8000-000000000005', null, now() - interval '6 day', now() - interval '6 day', now() + interval '60 day'),
  ('Part-time bookkeeper','Whalsay','Symbister, Whalsay','Prepare VAT returns and monthly accounts for island clients; working from home is possible.','part-time','£18–£24 per hour','open', false, false,'b1000000-0000-4000-8000-000000000008', null, now() - interval '9 day', now() - interval '9 day', now() + interval '30 day'),
  ('Home care assistant','Lerwick','Lerwick and surrounding area','Support people to live well at home. Driving licence required; full training and mileage paid.','full-time','£14.10 per hour','open', false, false, null,'Northern Isles Care Trust (example)', now() - interval '1 day', now() - interval '1 day', now() + interval '28 day');
insert into shift_employer_profiles (id, business_name, is_verified) values
  ('5e000000-0000-4000-8000-000000000001','Voe Hall Events Committee', true), ('5e000000-0000-4000-8000-000000000002','Lerwick Winter Market', false);
insert into shifts (employer_id, posted_as_business_id, title, description, category, location_text, start_at, end_at, pay_type, pay_amount, positions_total, positions_filled, urgency, status) values
  ('5e000000-0000-4000-8000-000000000002', null,'Market stall helper','Help set up, serve and pack down at the winter market.','events','Market Cross, Lerwick', date_trunc('day', now()) + interval '5 day 8 hour', date_trunc('day', now()) + interval '5 day 17 hour','hourly', 12.60, 3, 1,'this_week','open'),
  ('5e000000-0000-4000-8000-000000000001', null,'Soup lunch kitchen helper','Prepare and serve soup and bread for around 60 people.','hospitality','Voe Hall, Voe', date_trunc('day', now()) + interval '4 day 10 hour', date_trunc('day', now()) + interval '4 day 15 hour','volunteer', null, 4, 2,'this_week','open'),
  ('5e000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001','Café cover shift','Cover the counter for a busy Saturday.','hospitality','Esplanade, Lerwick', date_trunc('day', now()) + interval '6 day 9 hour', date_trunc('day', now()) + interval '6 day 15 hour','hourly', 12.60, 1, 0,'planned','open');

-- ── alerts, home content, word of the day ────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into partner_alerts (business_name, message, type, is_active, expires_at) values
  ('Peerie Voe Café','The café closes at 3pm today for a private function; normal hours from tomorrow.','info', true, now() + interval '2 day');
insert into home_content (welcome_title, welcome_body, welcome_cta, welcome_href, feature_title, feature_image, feature_href, spotlight_title, spotlight_body, spotlight_image, spotlight_href, spotlight_cta) values
  ('Welcome to OneShetland (demonstration)','Local events, businesses, jobs and community notices in one place.','See what''s on','/whats-on','Winter Market this Saturday', :'base' || '/demo-assets/local-street.jpg','/whats-on','Meet a local maker','Hamefarin Weaving Studio weaves scarves and blankets from local wool.', :'base' || '/demo-assets/jarlshof2.jpg','/directory/hamefarin-weaving','Visit the studio');
insert into spik_dictionary (word, short_meaning, example_sentence, slug, part_of_speech, pronunciation, first_letter) values
  ('peerie','small, little','Da peerie boy wis playin’ ida sand.','peerie','adjective','PEE-ree','p');
update profiles set full_name = 'Vic Cheyne (fictional)' where id = 'c0000000-0000-4000-8000-0000000000c1';
update hub_campaigns set story = description where story is null;
insert into event_updates (event_id, title, body, kind, is_urgent) values
  ('e1000000-0000-4000-8000-000000000011','Stalls confirmed','Twenty-two local makers are now confirmed for the market.','update', false);

alter table events enable trigger commercial_terms_guard;
alter table hubs enable trigger tg_zz_lock_hub_columns;
