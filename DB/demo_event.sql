-- demo_event.sql
-- Inserts ONE fully-populated event (every field the single-event page renders)
-- plus three ticket tiers, so you can see the detail page completely filled out
-- on both devices. Re-runnable: it deletes the previous demo first.
--
-- Title is prefixed "DEMO —" so it's easy to spot and delete later:
--   delete from public.events where title like 'DEMO —%';

delete from public.events where title like 'DEMO —%';

with ev as (
  insert into public.events (
    organiser_business_id,
    title, description, category,
    venue, locality, formatted_address, lat, lng,
    starts_at, ends_at, doors_open_at,
    cover_url, gallery_urls, video_url,
    price_text, ticket_url, has_tickets, capacity,
    accessibility_info, age_restriction, refund_policy, contact_info, event_notes,
    is_featured, status
  ) values (
    '9c0cebc8-741c-4458-8d8d-5924c9392f65',  -- organiser: The Hood Wink (change/remove if you like)
    'DEMO — Simmer Dim Sessions',
    E'A midsummer night of live music under Shetland''s never-quite-dark sky.\n\n'
      || E'Three acts across two stages, with local makers, street food and a late bar. '
      || E'Doors at 7pm, first act 7.30pm, headliner at 10. Bring a layer — it''s bonnie but breezy.\n\n'
      || E'All proceeds support the Mareel youth music programme.',
    'Festivals & Celebrations',
    'Mareel', 'Lerwick',
    'Mareel, North Ness, Lerwick, Shetland ZE1 0WQ',
    60.1556, -1.1437,
    timestamp '2026-06-21 19:30:00' at time zone 'Europe/London',
    timestamp '2026-06-21 23:30:00' at time zone 'Europe/London',
    timestamp '2026-06-21 19:00:00' at time zone 'Europe/London',
    'https://oneshetland.com/wp-content/uploads/2026/03/shetland-folk-festival.webp',
    array[
      'https://oneshetland.com/wp-content/uploads/2026/03/neil-cowley-trio.webp',
      'https://oneshetland.com/wp-content/uploads/2026/03/mama-terra.webp',
      'https://oneshetland.com/wp-content/uploads/2026/03/kris-drever-with-special-guest-annie-dressner.jpg',
      'https://oneshetland.com/wp-content/uploads/2026/03/absolute-elvis-johnny-lee-memphis.webp'
    ],
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'From £10',
    'https://mareel.org',
    true,
    320,
    E'Step-free access throughout. Accessible toilets and a hearing loop in the main auditorium. Assistance dogs welcome — please let the box office know in advance.',
    '18+ after 9pm · under-18s welcome with an adult before then',
    E'Full refunds up to 48 hours before the event. No refunds thereafter unless the event is cancelled or rescheduled.',
    E'Box office: boxoffice@mareel.org · 01595 745500',
    E'Bar open from 7pm. Cloakroom available. Limited parking — car-share or walk if you can. Photo ID required for the late session.',
    true,
    'published'
  )
  returning id
)
insert into public.event_ticket_types
  (event_id, name, description, price_pence, quantity_available, per_order_max, display_order, is_active)
select id, 'General Admission', 'Standing, all stages, all night.',          1500, 200, 8, 0, true from ev
union all
select id, 'Concession',        'Students, over-65s and under-18s.',         1000, 100, 8, 1, true from ev
union all
select id, 'Family (2 + 2)',    'Two adults and two under-18s.',             4000,  40, 4, 2, true from ev;
