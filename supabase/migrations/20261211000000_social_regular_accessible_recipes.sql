-- ============================================================================
-- Social Studio: two more recipes on the existing composer / queue / publisher.
--
--   regular_roundup   Regular Activities: weekly roundup (Sundays, about 18:00 UK time, for the coming Monday-Sunday)
--   accessible_info   Accessible Shetland: fortnightly information & discovery (awareness / resource spotlight / business access information)
--
-- NOTHING HERE POSTS, DRAFTS, APPROVES OR RESCHEDULES ANYTHING. Both recipes are seeded DISABLED with autopilot OFF, so no real post can result until
-- an administrator switches a recipe on. Existing recipes, their config, every existing social_posts row and the shared limits are untouched.
--
-- ADDITIVE: widens one CHECK, adds one nullable column (alt text for the image) and two config rows.
-- ============================================================================

begin;

alter table public.social_posts add column if not exists image_alt text;

alter table public.social_posts drop constraint if exists social_posts_kind_check;
alter table public.social_posts add constraint social_posts_kind_check
  check (kind = any (array[
    'wird_of_day','whats_on_roundup','event_spotlight',
    'offer_roundup','business_spotlight','ship_day',
    'new_business','almanac_article','jobs_roundup','new_product','custom',
    'notice_update','essential_alert','aald_memory','hub_community','game_challenge','cruise_visit',
    'regular_roundup','accessible_info']));

insert into public.social_recipes (key, label, enabled, autopilot, config) values
  ('regular_roundup', 'Regular Activities: weekly roundup', false, false,
   '{"hour":18,"weekdays":["Sat","Sun"],"post_day":"Sun","max_per_run":1,"max_pending":2,"max_items":6,"max_per_organiser":2,"lookback_weeks":8,"max_regenerations":2,"polish":false,"note":"Posts on Sundays about 18:00 (UK time) for the coming Monday to Sunday. Real published activities with a live session that week; cancelled sessions and breaks are never advertised. Picks up to 6, varied by organiser, category and place, rotating week by week. Checked again just before it posts."}'),
  ('accessible_info', 'Accessible Shetland: information & discovery', false, false,
   '{"hour":14,"weekdays":["Wed"],"post_day":"Wed, fortnightly","min_days_between":13,"max_per_run":1,"max_pending":2,"business_requires_review":true,"min_facts":3,"repeat_business_days":90,"repeat_resource_days":120,"max_resource_age_days":180,"approved_resources":[],"polish":false,"note":"Fortnightly, Wednesdays about 14:00. Rotates awareness, a verified resource spotlight, and business access information the business chose to publish. Business posts always wait for your approval. A resource posts automatically only once its slug is in approved_resources."}')
on conflict (key) do nothing;

commit;
