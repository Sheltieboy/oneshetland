-- Put the six reclassified listings back to 'other', then restore the six-value constraint (any listing an owner has since moved
-- into a new category must be moved first, or the constraint will refuse).
update public.local_businesses set category = 'other'
 where id in ('2924acfc-6904-4784-a2fe-5b059ef8b0f6','8eac478b-88be-4204-937d-abf2e8e12253','7cce5d19-5a57-4830-bea6-9fe57a68bbff',
              'c5173de1-155d-4c33-b5b5-7e7de4a7ecf5','f7475646-cbe6-4eb8-8917-04e4275550d8','b52657fc-90a0-428a-a8ee-961488abf856')
   and category in ('health_wellbeing','arts_creative','sport_fitness','community_voluntary');
alter table public.local_businesses drop constraint if exists local_businesses_category_check;
alter table public.local_businesses add constraint local_businesses_category_check
  check (category = any (array['food_drink','retail','services','tourism','accommodation','other']::text[]));
