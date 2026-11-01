-- Removes the seven recipes and their guards. Existing rows of the OLD kinds are untouched; any rows of the NEW kinds are deleted first
-- (the original kind CHECK cannot hold them). Run only if nothing of value was composed.
begin;
delete from public.social_posts where kind in ('notice_update','essential_alert','aald_memory','hub_community','game_challenge','cruise_visit');
delete from public.social_recipes where key in ('notice_update','essential_alert','aald_memory','business_spotlight','hub_community','game_challenge','cruise_visit');
drop trigger if exists social_recipes_essential_guard on public.social_recipes;
drop function if exists public.tg_social_recipes_essential_guard();
alter table public.social_posts drop constraint if exists social_posts_essential_needs_human;
alter table public.social_posts drop constraint if exists social_posts_kind_check;
alter table public.social_posts add constraint social_posts_kind_check
  check (kind = any (array['wird_of_day','whats_on_roundup','event_spotlight','offer_roundup','business_spotlight','ship_day','new_business','almanac_article','jobs_roundup','new_product','custom']));
drop table if exists public.social_promotion_permissions;
delete from public.admin_config where key in ('social.max_posts_per_day','social.min_gap_minutes','social.window_hours');
commit;
