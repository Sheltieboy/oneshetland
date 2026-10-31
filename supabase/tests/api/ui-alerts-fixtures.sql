-- ui-alerts-fixtures.sql — LOCAL-ONLY, FICTIONAL content that demonstrates the complete Notices & Alerts system (migrations 20261129000000-20261129040000).
-- Organisation names carry "(demo)"; nobody here is real. Funeral notices use the invented surname "Demoson" and invented details only. Every row is created
-- through the SAME functions production will use (acting as the right user via request.jwt.claim.sub), so the demonstration also exercises the rules.
-- Runs last (after ui-site-fixtures.sql).

-- ── people ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into profiles (id, role, display_name) values
  ('f0000000-0000-4000-8000-0000000000f1','customer','Pat Fixture (Council demo)'), ('f0000000-0000-4000-8000-0000000000f2','customer','Dee Fixture (Council demo)'),
  ('f0000000-0000-4000-8000-0000000000f3','customer','Nia Fixture (NHS demo)'), ('f0000000-0000-4000-8000-0000000000f4','customer','Fin Fixture (funeral director demo)'),
  ('e0000000-0000-4000-8000-0000000000e2','moderator','Mod Fixture');
create function pg_temp.act(p_user text) returns void language sql as $$ select set_config('request.jwt.claim.sub', p_user, false) $$;

-- ── organisations: the Council is verified and holds the entitlement; the NHS is verified but does NOT; a third is unverified ──────────────────────
select pg_temp.act('e0000000-0000-4000-8000-0000000000e1');
select public.admin_upsert_official_publisher('shetland-islands-council-demo', 'Shetland Islands Council (demo)', 'council', 'https://example.org/council');
select public.admin_upsert_official_publisher('nhs-shetland-demo', 'NHS Shetland (demo)', 'health', 'https://example.org/nhs');
select public.admin_upsert_official_publisher('scottish-water-demo', 'Scottish Water (demo)', 'utility', 'https://example.org/water');
select public.admin_verify_official_publisher(id, 'DEMO: verified by call-back to a published number (fictional)') from official_publishers where slug in ('shetland-islands-council-demo', 'nhs-shetland-demo');
select public.admin_set_official_publisher_member(id, 'f0000000-0000-4000-8000-0000000000f1', 'publisher') from official_publishers where slug = 'shetland-islands-council-demo';
select public.admin_set_official_publisher_member(id, 'f0000000-0000-4000-8000-0000000000f2', 'delegate') from official_publishers where slug = 'shetland-islands-council-demo';
select public.admin_set_official_publisher_member(id, 'f0000000-0000-4000-8000-0000000000f3', 'publisher') from official_publishers where slug = 'nhs-shetland-demo';
select public.admin_grant_essential_alert(id, 'DEMO: the first approved Essential Alert publisher') from official_publishers where slug = 'shetland-islands-council-demo';

-- ── notices (Level 1 essential, Level 2 official, plus a resolved and a scheduled alert) ─────────────────────────────────────────────────────────
create function pg_temp.org(p_slug text) returns uuid language sql as $$ select id from official_publishers where slug = p_slug $$;

select pg_temp.act('f0000000-0000-4000-8000-0000000000f1');
select public.official_publish_notice(pg_temp.org('shetland-islands-council-demo'), 'A970 closed at Voe junction after a landslip',
  'The A970 is closed at the Voe junction following a landslip. Emergency crews are on site. The road is expected to remain closed until the slope has been made safe.',
  'travel_transport', array['voe','brae','delting'], now() + interval '2 days', null, 'https://example.org/council/roads', 'Use the Delting route and allow extra time. Do not enter the closed section.', true, now() + interval '12 hours');
select public.official_publish_notice(pg_temp.org('shetland-islands-council-demo'), 'Power cut affecting Hillswick and Northmavine',
  'A fault on the network has cut power to homes in Hillswick and Northmavine. Engineers are on their way. Check on neighbours who may rely on powered medical equipment.',
  'public_services', array['hillswick','northmavine'], now() + interval '1 day', null, 'https://example.org/council/power', 'Report vulnerable neighbours or equipment problems to the emergency number listed on the page.', true, now() + interval '6 hours');
select public.official_publish_notice(pg_temp.org('shetland-islands-council-demo'), 'Yell Sound ferry crossings suspended',
  'High winds mean all Yell Sound crossings are suspended until further notice. Services will resume when conditions allow.',
  'travel_transport', array['yell_unst_fetlar'], now() + interval '1 day', null, 'https://example.org/council/ferries', 'Check the live ferry status before travelling and do not queue at the terminal.', true, now() + interval '8 hours');
select public.official_publish_notice(pg_temp.org('shetland-islands-council-demo'), 'Planned water supply interruption in Lerwick tomorrow night',
  'Essential maintenance will interrupt the water supply to parts of Lerwick from late tomorrow evening for around four hours.',
  'public_services', array['lerwick'], now() + interval '2 days', now() + interval '6 hours', 'https://example.org/council/water', 'Store drinking water before the interruption starts.', true, now() + interval '1 day 12 hours');
select public.official_publish_notice(pg_temp.org('shetland-islands-council-demo'), 'B9071 closure resolved: road reopened',
  'The B9071 has reopened to all traffic following earlier repairs. Thank you for your patience.',
  'travel_transport', array['shetland_south'], now() + interval '1 day', null, 'https://example.org/council/roads', 'No action needed; normal journey times apply.', true, now() + interval '6 hours');
select public.official_publish_notice(pg_temp.org('shetland-islands-council-demo'), 'Bin collections move by a day over the holiday period',
  'Household collections move by one day for the week of the holiday. Please put your bins out the night before.',
  'public_services', array['shetland_wide'], now() + interval '10 days');
select pg_temp.act('f0000000-0000-4000-8000-0000000000f3');
select public.official_publish_notice(pg_temp.org('nhs-shetland-demo'), 'Flu vaccination clinics this month',
  'Flu vaccination clinics run at health centres across the isles this month. Please book through your practice; clinics are for eligible groups.',
  'health', array['shetland_wide'], now() + interval '25 days', null, 'https://example.org/nhs/flu');
select pg_temp.act('f0000000-0000-4000-8000-0000000000f1');
select public.official_set_notice_status(id, 'resolved') from notices where title = 'B9071 closure resolved: road reopened';

-- ── imports (disabled sources shown in the administrator's status view; the notices themselves are the earlier import fixtures) ──────────────────
select pg_temp.act('e0000000-0000-4000-8000-0000000000e1');
select public.admin_upsert_import_source('sic_council', 'Shetland Islands Council (Official Notices)', 'rss', 'https://example.org/council/rss', array['example.org'], 'public_services');
select public.admin_upsert_import_source('nhs_shetland', 'NHS Shetland', 'rss', 'https://example.org/nhs/rss', array['example.org'], 'health');

-- ── funeral notices (fictional "Demoson"; submitted by family, verified and approved by staff) ───────────────────────────────────────────────────
select pg_temp.act('a0000000-0000-4000-8000-0000000000a1');
select public.submit_funeral_notice('{"full_name":"Isobel Demoson","preferred_name":"Isa","born_on":"1941-02-14","died_on":"2026-10-27","announcement":"Died peacefully at home, with her family around her. Dearly loved mother, grandmother and friend to many.","service_public":true,"service_kind":"funeral","service_venue":"Voe Kirk (demo)","service_at":"2026-11-05T11:00:00Z","service_notes":"Family flowers only; all welcome to join the family for tea in the hall afterwards.","family_requests":"Donations in lieu of flowers, if desired.","donation_info":"Donations to the Voe Hall roof fund (demo) via the fundraiser page.","area_id":"voe","announce_in_notifications":true,"submitter_name":"Ann Demoson","submitter_relationship":"Daughter","submitter_phone":"01595 000111","family_authorised":true}'::jsonb);
select pg_temp.act('d0000000-0000-4000-8000-0000000000d1');
select public.submit_funeral_notice('{"full_name":"Robert Demoson","born_on":"1950-06-03","died_on":"2026-10-29","announcement":"Peacefully, after a short illness. A much-loved husband, father and neighbour.","service_public":true,"service_kind":"cremation","service_venue":"Crematorium chapel (demo)","service_at":"2026-11-06T14:00:00Z","area_id":"lerwick","submitter_name":"Hal Demoson","submitter_relationship":"Son","submitter_email":"hal@example.org","family_authorised":true}'::jsonb);
select pg_temp.act('a0000000-0000-4000-8000-0000000000a2');
select public.submit_funeral_notice('{"full_name":"Jessie Demoson","died_on":"2026-10-30","announcement":"Suddenly at home.","service_public":false,"service_kind":"private","area_id":"scalloway","submitter_name":"A. Demoson","submitter_phone":"01595 000222","family_authorised":true}'::jsonb);
select pg_temp.act('c0000000-0000-4000-8000-0000000000c1');
select public.submit_funeral_notice('{"full_name":"William Demoson","died_on":"2026-10-30","announcement":"Awaiting details from the family.","area_id":"hillswick","submitter_name":"V. Demoson","submitter_phone":"01595 000333","family_authorised":true}'::jsonb);
select pg_temp.act('e0000000-0000-4000-8000-0000000000e2');
select public.admin_funeral_review(id, 'approve', 'DEMO: called the submitter back on the number given and confirmed details with the (fictional) funeral director', 'phone_callback')
  from funeral_notices where full_name in ('Isobel Demoson', 'Robert Demoson', 'Jessie Demoson');
select public.admin_funeral_review(id, 'request_info', 'DEMO: please confirm the date and time of the service.') from funeral_notices where full_name = 'William Demoson';
select pg_temp.act('d0000000-0000-4000-8000-0000000000d1');
select public.submit_funeral_notice('{"full_name":"Awaiting Review Demoson","announcement":"Submitted today; not yet reviewed.","area_id":"brae","submitter_name":"B. Demoson","submitter_phone":"01595 000444","family_authorised":true}'::jsonb);

-- ── a member with areas and preferences (to show the choices in the preferences screens) ───────────────────────────────────────────────────────
select pg_temp.act('a0000000-0000-4000-8000-0000000000a1');
select public.set_my_notice_areas(array['voe','brae']);
select public.set_my_notice_prefs(p_essential => true, p_official => true, p_community => false, p_funeral => false);
select set_config('request.jwt.claim.sub', '', false);
