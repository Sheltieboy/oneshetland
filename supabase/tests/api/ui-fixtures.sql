-- ui-fixtures.sql — LOCAL-ONLY fixtures for looking at notice publisher attribution in a browser / simulator. Never run against a hosted project.
-- Covers every publisher kind plus awkward data: very long names / titles / labels, missing logos, an import without a link, urgent notices, event- and
-- fundraiser-generated notices, and every kind of non-public notice (which must never appear).
insert into profiles (id, role, display_name) values
  ('a0000000-0000-4000-8000-0000000000a1','customer','Ann Jamieson'), ('a0000000-0000-4000-8000-0000000000a2','customer',null),
  ('d0000000-0000-4000-8000-0000000000d1','customer','Hal'), ('c0000000-0000-4000-8000-0000000000c1','customer','Vic'), ('e0000000-0000-4000-8000-0000000000e1','admin','Staff');
insert into local_businesses (id, owner_id, name, slug, can_publish_urgent, logo_url, brand_color) values
  ('bb000000-0000-4000-8000-0000000000bb','c0000000-0000-4000-8000-0000000000c1','Bea Bakery','bea-bakery', true,
   'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQElEQVR4nO3OQQ0AIAwAsZnEJCrnguPRpAI698xX+oGQkJBQPRASEhKqB0JCQkL1QEhISKgeCAkJCdUDISGhxxbh5vd5Dq+yLgAAAABJRU5ErkJggg==', '#aa5500'),
  ('bb000000-0000-4000-8000-0000000000b2','c0000000-0000-4000-8000-0000000000c1','The Very Long Named Shetland Knitwear, Textiles and Gifts Company Limited','long-biz', true, null, null);
alter table hubs disable trigger tg_zz_lock_hub_columns;
insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled, logo_url, brand_color) values
  ('dd000000-0000-4000-8000-0000000000ee','e0000000-0000-4000-8000-0000000000e1','OneShetland','oneshetland', true, false, null, null),
  ('dd000000-0000-4000-8000-0000000000dd','d0000000-0000-4000-8000-0000000000d1','Voe & Aith Community Hall and Heritage Centre Association (Registered Charity)','voe-hall', true, true,
   'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQklEQVR4nO3OQQ0AIAwAsXnCE55wiwuOR5MK6Kx9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF0cOwpcE73DqAAAAAElFTkSuQmCC', '#336699');
alter table hubs enable trigger tg_zz_lock_hub_columns;
insert into hub_campaigns (id, hub_id, title, raised_pence, goal_pence, donor_count, status) values ('ca000000-0000-4000-8000-0000000000ca','dd000000-0000-4000-8000-0000000000dd','Hall roof fund', 250000, 1000000, 31, 'active');
-- hub_visibility 'islands' on a verified hub's event => the database trigger calendar-approves it, so its notice joins the islands-wide feeds
insert into events (id, title, starts_at, status, organiser_hub_id, hub_visibility) values
  ('e1000000-0000-4000-8000-000000000001','Burns Supper', now() + interval '10 day', 'published', 'dd000000-0000-4000-8000-0000000000dd', 'islands');

-- ELIGIBLE (public)
insert into notices (id, publisher_hub_id, severity, title, body, published_at, created_at) values
  ('f0000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-0000000000ee','info','OneShetland is getting ready to launch',
   'We’re putting the final touches to OneShetland and adding local businesses, events and useful information. Thanks for taking an early look.','2026-10-04 11:20:42+00','2026-10-04 11:20:42+00'),
  ('f0000000-0000-4000-8000-000000000002','dd000000-0000-4000-8000-0000000000dd','community','Hall closed on Saturday 14 November for the annual deep clean, floor re-varnishing, boiler service and the long-awaited replacement of the stage curtains',
   E'The hall will be closed all day Saturday 14 November.\n\nAll bookings for that day have been moved to Sunday 15 November; please check the booking sheet in the porch. The kitchen will also be unavailable, so the soup and sandwich lunch moves to the Church Hall. Thank you for your patience – we will reopen on Monday morning.', now() - interval '3 day', now() - interval '3 day'),
  ('f0000000-0000-4000-8000-000000000003','dd000000-0000-4000-8000-0000000000dd','urgent','Road closed at Voe junction',
   'The A970 is closed at the Voe junction following a landslip. Use the Delting route. Updates will follow.', now() - interval '1 day', now() - interval '1 day'),
  ('f0000000-0000-4000-8000-000000000008','dd000000-0000-4000-8000-0000000000dd','community','Burns Supper tickets now on sale','Join us for haggis, neeps and tatties.', now() - interval '5 day', now() - interval '5 day'),
  ('f0000000-0000-4000-8000-000000000009','dd000000-0000-4000-8000-0000000000dd','community','Help us re-roof the hall','Every pound counts towards the new roof.', now() - interval '6 day', now() - interval '6 day');
update notices set event_id = 'e1000000-0000-4000-8000-000000000001' where id = 'f0000000-0000-4000-8000-000000000008';
update notices set campaign_id = 'ca000000-0000-4000-8000-0000000000ca' where id = 'f0000000-0000-4000-8000-000000000009';
insert into notices (id, publisher_business_id, severity, title, body, published_at, created_at) values
  ('f0000000-0000-4000-8000-000000000004','bb000000-0000-4000-8000-0000000000bb','community','Fresh bannocks every morning from 7am','Come early – they sell out by ten.', now() - interval '2 day', now() - interval '2 day'),
  ('f0000000-0000-4000-8000-000000000005','bb000000-0000-4000-8000-0000000000b2','urgent','Shop closed today due to a power cut at the Hillswick substation and will reopen as soon as supply is restored',
   'We are very sorry for the inconvenience.', now() - interval '4 hour', now() - interval '4 hour');
insert into notices (id, is_person_notice, publisher_user_id, severity, title, body, status, published_at, created_at) values
  ('f0000000-0000-4000-8000-000000000006', true, 'a0000000-0000-4000-8000-0000000000a1','community','Lost: tabby cat near the Lerwick harbour','Answers to “Biscuit”. Please call if seen.','published', now() - interval '7 hour', now() - interval '7 hour'),
  ('f0000000-0000-4000-8000-000000000007', true, 'a0000000-0000-4000-8000-0000000000a2','community','Found: set of keys outside the library','Handed in at the Lerwick Library desk.','published', now() - interval '8 hour', now() - interval '8 hour'),
  ('f0000000-0000-4000-8000-00000000000a', true, null,'community','Old community notice from someone no longer on OneShetland','Still relevant.','published', now() - interval '9 hour', now() - interval '9 hour');
insert into notices (id, is_platform_notice, severity, title, body, published_at, created_at) values
  ('f0000000-0000-4000-8000-00000000000b', true,'info','Welcome to OneShetland','Local news, events, businesses and community notices, all in one place.', now() - interval '10 hour', now() - interval '10 hour');
insert into notices (id, is_platform_notice, severity, title, body, source, source_reference, source_label, source_url, source_published_at, expires_at, published_at, created_at) values
  ('f0000000-0000-4000-8000-00000000000c', true,'urgent','Prescription request system unavailable','The online repeat prescription system is unavailable. Please phone your practice instead.','nhs_shetland','r-100','NHS Shetland','https://www.nhsshetland.scot.nhs.uk/', now() - interval '3 hour', now() + interval '3 day', now() - interval '3 hour', now() - interval '3 hour'),
  ('f0000000-0000-4000-8000-00000000000d', true,'urgent','Waste collection suspended in the North Isles until further notice owing to severe weather and ferry cancellations','Collections will resume once conditions allow.','sic','r-200','Shetland Islands Council — Environmental Health, Trading Standards and Licensing Services (Official Notices)', null, now() - interval '2 hour', now() + interval '2 day', now() - interval '2 hour', now() - interval '2 hour');

-- NEVER PUBLIC (none of these may ever be shown)
insert into notices (id, publisher_hub_id, title, body, status, starts_at, is_hidden, expires_at) values
  ('f0000000-0000-4000-8000-0000000000a1','dd000000-0000-4000-8000-0000000000dd','NEVER-SHOWN pending','x','pending',null,false,null),
  ('f0000000-0000-4000-8000-0000000000a2','dd000000-0000-4000-8000-0000000000dd','NEVER-SHOWN withdrawn','x','withdrawn',null,false,null),
  ('f0000000-0000-4000-8000-0000000000a3','dd000000-0000-4000-8000-0000000000dd','NEVER-SHOWN resolved','x','resolved',null,false,null),
  ('f0000000-0000-4000-8000-0000000000a4','dd000000-0000-4000-8000-0000000000dd','NEVER-SHOWN scheduled','x','published', now() + interval '2 day', false, null),
  ('f0000000-0000-4000-8000-0000000000a5','dd000000-0000-4000-8000-0000000000dd','NEVER-SHOWN hidden','x','published', null, true, null),
  ('f0000000-0000-4000-8000-0000000000a6','dd000000-0000-4000-8000-0000000000dd','NEVER-SHOWN expired','x','published', null, false, now() - interval '1 day');
insert into notices (id, is_person_notice, publisher_user_id, title, body, status) values
  ('f0000000-0000-4000-8000-0000000000a7', true, 'a0000000-0000-4000-8000-0000000000a1','NEVER-SHOWN person pending (named Ann Jamieson)','x','pending');

-- business detail fixtures (what the detail screen shows when a business notice is tapped)
update local_businesses set category = 'Bakery', description = 'Fresh bannocks, bread and cakes baked every morning in Lerwick.', address = 'Commercial Street, Lerwick', lat = 60.1545, lng = -1.1456, is_active = true, is_verified = true where slug = 'bea-bakery';
update local_businesses set category = 'Knitwear', description = 'Shetland knitwear and gifts.', address = 'Hillswick, Shetland', is_active = true where slug = 'long-biz';
