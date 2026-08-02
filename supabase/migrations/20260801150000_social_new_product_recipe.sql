-- Shop Shetland marketing loop: every new product can become a social post.
-- Adds the new_product kind + its recipe row (enabled, human-approved like all
-- Phase-1 recipes).

alter table public.social_posts drop constraint if exists social_posts_kind_check;
alter table public.social_posts add constraint social_posts_kind_check
  check (kind = any (array[
    'wird_of_day','whats_on_roundup','event_spotlight',
    'offer_roundup','business_spotlight','ship_day',
    'new_business','almanac_article','jobs_roundup','new_product','custom']));

insert into public.social_recipes (key, label, config) values
  ('new_product', 'New product spotlights', '{"hour": 11, "max_per_run": 2}')
on conflict (key) do nothing;
