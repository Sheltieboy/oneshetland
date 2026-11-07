-- Business taxonomy: add four categories to local_businesses.category and reclassify a handful of clear "Other" listings.
-- Add-only: the six existing values stay valid, so no existing row, URL, owner or subscription changes meaning.
--   health_wellbeing     "Health & Wellbeing"   (a directory grouping only; it does not mean OneShetland has verified or endorsed any treatment or qualification)
--   arts_creative        "Arts & Creative"
--   sport_fitness        "Sport & Fitness"
--   community_voluntary  "Community & Voluntary"

alter table public.local_businesses drop constraint if exists local_businesses_category_check;
alter table public.local_businesses add constraint local_businesses_category_check
  check (category = any (array['food_drink','retail','services','tourism','accommodation','other',
                               'health_wellbeing','arts_creative','sport_fitness','community_voluntary']::text[]));

-- Reclassification: ONLY rows still in 'other' (so an owner who has already chosen is never overridden, and a re-run is a no-op),
-- and ONLY where the listing's own name/description is unambiguous. Owners can change it again from their business settings.
update public.local_businesses set category = 'health_wellbeing'
 where category = 'other' and id in ('2924acfc-6904-4784-a2fe-5b059ef8b0f6',   -- GG Massage Therapy ("independent massage and wellness studio")
                                     '8eac478b-88be-4204-937d-abf2e8e12253');  -- Lighthouse Counselling Shetland (counselling service)
update public.local_businesses set category = 'sport_fitness'
 where category = 'other' and id = '7cce5d19-5a57-4830-bea6-9fe57a68bbff';      -- Ruth Archer Fitness ("fitness and exercise classes")
update public.local_businesses set category = 'arts_creative'
 where category = 'other' and id in ('c5173de1-155d-4c33-b5b5-7e7de4a7ecf5',   -- Ruth Brownlee ("Artist painter")
                                     'f7475646-cbe6-4eb8-8917-04e4275550d8');  -- Vaila Fine Art
update public.local_businesses set category = 'community_voluntary'
 where category = 'other' and id = 'b52657fc-90a0-428a-a8ee-961488abf856';      -- Voluntary Action Shetland (third sector interface)
