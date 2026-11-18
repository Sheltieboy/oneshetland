-- A throwaway replica standing in for production: one Edition whose programme was built by COPYING events, exactly
-- as the Christmas Edition's was, plus an event belonging to somebody else and an item that exists only in the Edition.
set client_min_messages = warning;

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'edition%' loop
    execute format('truncate table public.%I cascade', t); end loop;
end $$;
truncate table public.events cascade;
truncate table public.hub_members cascade;
delete from public.hubs; delete from public.profiles; delete from auth.users;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000','authenticated','authenticated', u||'@example.test', now(), now(), now()
from unnest(array[
  '11111111-1111-4111-8111-111111111111',  -- OWNER: runs the Edition's hub
  '22222222-2222-4222-8222-222222222222',  -- ADMIN: platform staff
  '33333333-3333-4333-8333-333333333333',  -- STRANGER: owns an unrelated event
  '44444444-4444-4444-8444-444444444444'   -- OUTSIDER: nothing at all
]::uuid[]) u;
insert into public.profiles (id, role) values
 ('11111111-1111-4111-8111-111111111111','customer'),
 ('22222222-2222-4222-8222-222222222222','admin'),
 ('33333333-3333-4333-8333-333333333333','customer'),
 ('44444444-4444-4444-8444-444444444444','customer')
on conflict (id) do update set role = excluded.role;

insert into public.hubs (id, name, slug, owner_id, is_active) values
 ('aaaaaaaa-0000-4000-8000-000000000001','ZZ TEST Yule Hub','zz-test-yule-hub','11111111-1111-4111-8111-111111111111', true),
 ('aaaaaaaa-0000-4000-8000-000000000002','ZZ TEST Other Hub','zz-test-other-hub','33333333-3333-4333-8333-333333333333', true);

insert into public.edition_organisers (id, slug, name, status, hub_id, is_test)
values ('bbbbbbbb-0000-4000-8000-000000000001','zz-test-yule','ZZ TEST Yule','verified','aaaaaaaa-0000-4000-8000-000000000001', false);
-- No member row: ownership of the Edition comes from owning the Hub (edition_members_no_owner enforces that).

insert into public.editions (id, organiser_id, slug, title, summary, kind, starts_on, ends_on, timezone, status)
values ('cccccccc-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','zz-test-yule-2026','ZZ TEST Yule 2026',
        'A test Edition.','season','2026-12-01','2026-12-31','Europe/London','draft');

insert into public.edition_venues (id, organiser_id, name, address)
values ('dddddddd-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','ZZ TEST Hall','Lerwick');

-- The events. Two are OneShetland's own (platform), one belongs to the stranger's hub.
insert into public.events (id, title, description, starts_at, ends_at, venue, locality, status, is_hidden, is_platform_event, category, price_text)
values
 ('eeeeeeee-0000-4000-8000-000000000001','ZZ TEST Lights Switch-On','Santa and the lights.','2026-12-05T15:00:00+00','2026-12-05T16:30:00+00','Market Cross','Lerwick','published', false, true,'Festival','Free'),
 ('eeeeeeee-0000-4000-8000-000000000002','ZZ TEST Carol Service','Carols by candlelight.','2026-12-12T19:00:00+00','2026-12-12T20:30:00+00','St Olaf Hall','Scalloway','published', false, true,'Community','Free');
insert into public.events (id, title, description, starts_at, ends_at, venue, locality, status, is_hidden, is_platform_event, organiser_hub_id, hub_visibility, category)
values
 ('eeeeeeee-0000-4000-8000-000000000003','ZZ TEST Stranger''s Ceilidh','Not ours.','2026-12-19T20:00:00+00','2026-12-19T23:00:00+00','Other Hall','Brae','published', false, false,'aaaaaaaa-0000-4000-8000-000000000002','islands','Music');

-- The programme, built the OLD way: flat copies, nothing joining them to the events.
insert into public.edition_sessions (id, edition_id, title, description, starts_at, ends_at, venue_id, kind, price_text, status, position)
values
 ('ffffffff-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','ZZ TEST Lights Switch-On','The Edition''s own words about the switch-on.','2026-12-05T15:00:00+00','2026-12-05T16:30:00+00', null,'event','Free','scheduled', 10),
 ('ffffffff-0000-4000-8000-000000000002','cccccccc-0000-4000-8000-000000000001','ZZ TEST Carol Service', null,'2026-12-12T19:00:00+00','2026-12-12T20:30:00+00', null,'event','Free','scheduled', 20),
 -- Exists only in the Edition. Must keep working untouched: requirement three.
 ('ffffffff-0000-4000-8000-000000000003','cccccccc-0000-4000-8000-000000000001','ZZ TEST Edition-only Workshop','A makkin workshop the Edition runs itself.','2026-12-08T18:00:00+00','2026-12-08T20:00:00+00','dddddddd-0000-4000-8000-000000000001','session','£5','scheduled', 15);

-- Two kinds of ambiguity the backfill must refuse to guess at. Both must come through UNLINKED and intact.
--  * two events share a title and a start time, so a session copying them matches both;
--  * one event, but two sessions in the programme copied from it.
insert into public.events (id, title, starts_at, ends_at, venue, locality, status, is_hidden, is_platform_event, category)
values
 ('eeeeeeee-0000-4000-8000-000000000004','ZZ TEST Twin Concert','2026-12-18T19:00:00+00','2026-12-18T21:00:00+00','Mareel','Lerwick','published', false, true,'Music'),
 ('eeeeeeee-0000-4000-8000-000000000005','ZZ TEST Twin Concert','2026-12-18T19:00:00+00','2026-12-18T21:00:00+00','Clickimin','Lerwick','published', false, true,'Music'),
 ('eeeeeeee-0000-4000-8000-000000000006','ZZ TEST Repeated Item','2026-12-22T11:00:00+00','2026-12-22T12:00:00+00','Hall','Walls','published', false, true,'Community');
insert into public.edition_sessions (id, edition_id, title, starts_at, ends_at, kind, status, position)
values
 ('ffffffff-0000-4000-8000-000000000004','cccccccc-0000-4000-8000-000000000001','ZZ TEST Twin Concert','2026-12-18T19:00:00+00','2026-12-18T21:00:00+00','event','scheduled', 40),
 ('ffffffff-0000-4000-8000-000000000005','cccccccc-0000-4000-8000-000000000001','ZZ TEST Repeated Item','2026-12-22T11:00:00+00','2026-12-22T12:00:00+00','event','scheduled', 50),
 ('ffffffff-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000001','ZZ TEST Repeated Item','2026-12-22T11:00:00+00','2026-12-22T12:00:00+00','event','scheduled', 60);
