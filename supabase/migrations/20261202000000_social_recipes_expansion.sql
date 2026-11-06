-- ============================================================================
-- Social Studio: seven more recipes on the existing composer / queue / publisher.
--
--   notice_update      community & official notices (never funeral / person / sensitive)
--   essential_alert    verified Essential Alerts. ALWAYS needs a human: never autopilot
--   aald_memory        approved historical memories (needs an explicit permission row)
--   business_spotlight claimed local businesses (kind already allowed by the original check)
--   hub_community      active public Hubs (+ a fundraiser only if it can take donations)
--   game_challenge     Guess da Wird & the other games (never a current answer)
--   cruise_visit       upcoming verified cruise visits
--
-- NOTHING HERE POSTS, DRAFTS, APPROVES OR RESCHEDULES ANYTHING. The new recipes are
-- seeded DISABLED with autopilot OFF. Existing recipes, their config, and every
-- existing social_posts row (including the unreviewed backlog) are untouched.
--
-- ADDITIVE: widens one CHECK, adds one CHECK + one trigger + one table + three config rows.
-- ============================================================================

begin;

-- 1. New post kinds (business_spotlight / ship_day were already allowed).
alter table public.social_posts drop constraint if exists social_posts_kind_check;
alter table public.social_posts add constraint social_posts_kind_check
  check (kind = any (array[
    'wird_of_day','whats_on_roundup','event_spotlight',
    'offer_roundup','business_spotlight','ship_day',
    'new_business','almanac_article','jobs_roundup','new_product','custom',
    'notice_update','essential_alert','aald_memory','hub_community','game_challenge','cruise_visit']));

-- 2. Essential alerts can never skip the human. Autopilot writes status 'scheduled'; a person's
--    Approve writes 'approved'. So an essential_alert post may never be 'scheduled'.
--    (NOT VALID is unnecessary: no such rows exist.)
alter table public.social_posts drop constraint if exists social_posts_essential_needs_human;
alter table public.social_posts add constraint social_posts_essential_needs_human
  check (kind <> 'essential_alert' or status <> 'scheduled');

-- ...and its recipe can never be switched to autopilot, from any client.
create or replace function public.tg_social_recipes_essential_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.key = 'essential_alert' and new.autopilot is true then
    raise exception 'Essential alert posts always need explicit administrator approval; autopilot cannot be enabled.'
      using errcode = '23514', hint = 'essential_alert_requires_human';
  end if;
  return new;
end $$;
revoke all on function public.tg_social_recipes_essential_guard() from public, anon, authenticated;
drop trigger if exists social_recipes_essential_guard on public.social_recipes;
create trigger social_recipes_essential_guard
  before insert or update of autopilot, key on public.social_recipes
  for each row execute function public.tg_social_recipes_essential_guard();

-- 3. Promotion permissions: the one place "this may be promoted" / "this must not" is recorded.
--    aald_memory requires allowed = true; business_spotlight skips allowed = false. Admin only.
create table if not exists public.social_promotion_permissions (
  entity_type text not null check (entity_type in ('memory','business','hub')),
  entity_id   text not null,
  allowed     boolean not null,
  note        text,
  granted_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (entity_type, entity_id)
);
alter table public.social_promotion_permissions enable row level security;
drop policy if exists "admins manage social promotion permissions" on public.social_promotion_permissions;
create policy "admins manage social promotion permissions" on public.social_promotion_permissions
  for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
revoke all on public.social_promotion_permissions from anon;
grant select, insert, update, delete on public.social_promotion_permissions to authenticated;   -- rows are gated to admins by the policy above

-- 4. Recipes: DISABLED, autopilot OFF. Weekdays are Europe/London; "hour" is the preferred local hour.
insert into public.social_recipes (key, label, enabled, autopilot, config) values
  ('notice_update',      'Notices & community updates', false, false,
   '{"hour":12,"max_per_run":1,"max_per_week":4,"max_age_days":7,"min_remaining_hours":24,"max_pending":3,"include_person":false,"polish":false,"note":"New public notices, as they appear. Funeral, person and sensitive notices are never used."}'),
  ('essential_alert',    'Essential alerts (always needs approval)', false, false,
   '{"max_per_run":1,"min_hours_between":6,"min_remaining_hours":2,"max_pending":2,"polish":false,"note":"Verified, currently-active alerts only. Every post needs your explicit approval; autopilot is locked off."}'),
  ('aald_memory',        'Aald Memories', false, false,
   '{"hour":19,"weekdays":["Mon","Wed","Sat"],"max_per_run":1,"max_pending":3,"min_body_chars":80,"polish":true,"note":"Mon, Wed, Sat. Only memories you have marked as allowed to promote (social_promotion_permissions)."}'),
  ('business_spotlight', 'Business spotlight', false, false,
   '{"hour":13,"weekdays":["Tue","Fri"],"max_per_run":1,"max_pending":3,"min_description_chars":60,"repeat_after_days":90,"polish":true,"note":"Tue, Fri. Claimed, visible businesses with a description and image; never repeats within 90 days."}'),
  ('hub_community',      'Hubs & community', false, false,
   '{"hour":10,"weekdays":["Wed","Sat"],"max_per_run":1,"max_pending":2,"min_description_chars":40,"repeat_after_days":30,"polish":true,"note":"Wed, Sat. Active public Hubs; a fundraiser is mentioned only while it can take donations."}'),
  ('game_challenge',     'Games & challenges', false, false,
   '{"hour":17,"weekdays":["Thu","Sun"],"max_per_run":1,"max_pending":2,"polish":false,"games":["guess_da_wird","spik_sprint","spik_snap","map_it"],"note":"Thu, Sun. Rotates the games; never shows a current answer."}'),
  ('cruise_visit',       'Cruise & visitor information', false, false,
   '{"hour":8,"max_per_run":1,"lead_days":3,"max_pending":2,"max_verified_age_days":365,"polish":false,"note":"Seasonal: one post per cruise day, up to 3 days ahead, verified visits only."}')
on conflict (key) do nothing;

-- 5. Cross-recipe spacing. The allocator keeps new-recipe posts at least this far apart, inside this window,
--    and never schedules more than the daily cap (counting every queued/posted post that day, old recipes included).
insert into public.admin_config (key, value, category, description, is_secret) values
  ('social.max_posts_per_day',  '3',  'social', 'Most Facebook posts (all recipes) the NEW recipes will allow on one London day.', false),
  ('social.min_gap_minutes',    '120','social', 'Minimum minutes between any two queued posts when the NEW recipes pick a slot.', false),
  ('social.window_hours',       '8-20','social','London hours (start-end) inside which the NEW recipes schedule posts.', false)
on conflict (key) do nothing;

commit;
