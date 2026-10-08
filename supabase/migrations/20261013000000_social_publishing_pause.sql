-- Global pause for the Peerie Press social publisher.
--
-- social_recipes.autopilot already existed but was never read by anything —
-- social-composer now uses it to decide draft vs scheduled at compose time.
-- This migration adds the one new piece of state that composer change alone
-- doesn't cover: a single admin-flippable switch that stops social-publisher
-- from ever reaching Meta, regardless of how many posts are approved/
-- scheduled and regardless of any recipe's autopilot setting. Nothing is
-- deleted or reshaped — this is purely a new admin_config row, read with the
-- existing getConfig() helper the same way every other feature flag/price id
-- already is.

insert into public.admin_config (key, value, category, description, is_secret)
values (
  'social.publishing_paused',
  'false',
  'social',
  'Global kill switch for social-publisher. "true" stops ALL outbound Facebook/Instagram posting immediately — queued drafts/approved/scheduled posts are left untouched, and the composer keeps queueing normally. Flip back to "false" to resume; the existing 48h stale-post guard still applies on wake-up.',
  false
)
on conflict (key) do nothing;
