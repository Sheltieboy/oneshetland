-- import_hubs.sql
-- Demo OneShetland Hubs + a few notices, for testing the Hubs feature.
--
-- Owner: defaults to the account with the email below; falls back to the first
-- profile if that email isn't found. EDIT the email to your account.
--
-- Idempotent: hubs upsert on slug (ON CONFLICT DO NOTHING), and notices only
-- attach to hubs that were *newly* inserted — so re-running adds nothing.
-- The hub owner is added as an 'owner' member automatically by a trigger.

with owner as (
  select coalesce(
    (select id from auth.users where lower(email) = lower('darren@darrenfullerton.com')),
    (select id from public.profiles limit 1)
  ) as id
),
new_hubs as (
  insert into public.hubs
    (owner_id, name, slug, type, description, brand_color, area, join_mode, is_verified, is_active)
  select o.id, v.name, v.slug, v.type, v.description, v.brand_color, v.area, v.join_mode, v.is_verified, true
  from owner o,
  (values
    ('Burra Youth Club',          'burra-youth-club',        'youth',
     'A friendly youth club for P5–S4 in West Burra. Games, crafts, sport and trips through the school terms. New faces always welcome.',
     '#6B47BF', 'Burra', 'approval', true),

    ('Shetland Rugby Club',       'shetland-rugby-club',     'sports',
     'Senior and youth rugby played at Clickimin. Training Tuesdays and Thursdays, matches most Saturdays. All abilities welcome — boots and a smile is all you need.',
     '#2A8B5C', 'Lerwick', 'open', true),

    ('Hillswick Hall Committee',  'hillswick-hall-committee','hall',
     'The volunteer committee that runs Hillswick Public Hall — bookings, events, fundraising and upkeep for the Northmavine community.',
     '#0E7490', 'Northmavine', 'approval', false),

    ('Shetland Befriending Scheme','shetland-befriending',   'charity',
     'A local charity matching volunteers with people who would value some company and support. Always looking for new befrienders across the isles.',
     '#9F1239', 'all-shetland', 'approval', true),

    ('Da Voar Redd Up Crew',      'voar-redd-up-crew',       'volunteer',
     'Community volunteers for Shetland''s annual spring clean and beach cleans through the year. Join a tidy-up near you.',
     '#C2410C', 'all-shetland', 'open', false)
  ) as v(name, slug, type, description, brand_color, area, join_mode, is_verified)
  on conflict (slug) do nothing
  returning id, slug
)
insert into public.notices
  (publisher_hub_id, severity, visibility, title, body, expires_at)
select h.id, 'community', n.visibility, n.title, n.body, now() + (n.days || ' days')::interval
from new_hubs h
join (values
  ('burra-youth-club',        'public',  'No club this Friday',
   'Hall is double-booked this week so there''s no youth club this Friday. Back to normal next week — see you then!', 10),
  ('burra-youth-club',        'members', 'Summer trip — sign-up sheet',
   'We''re planning the end-of-term trip to Lerwick. Members only: reply to let us know if your bairn is coming so we can sort transport.', 21),

  ('shetland-rugby-club',     'public',  'Pre-season training starts',
   'Pre-season is back! Tuesdays & Thursdays 7pm at Clickimin from next week. New players very welcome — come along and give it a go.', 30),

  ('hillswick-hall-committee','public',  'Hall AGM — all welcome',
   'The hall committee AGM is on the last Thursday of the month, 7:30pm in the hall. Come and hear what we''ve been up to and have your say.', 25),

  ('shetland-befriending',    'public',  'Volunteer befrienders needed',
   'Could you spare an hour a week to visit someone who''d value the company? We provide training and support. Get in touch to find out more.', 45),

  ('voar-redd-up-crew',       'public',  'Beach clean this Saturday',
   'Join us for a beach clean at the Sands of Sound this Saturday, 10am–12pm. Bags and gloves provided. Bring a flask!', 7)
) as n(slug, visibility, title, body, days) on n.slug = h.slug;
