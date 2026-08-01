-- Add the jobs_roundup recipe (Wednesdays: newest open roles + total count),
-- and clear the not-yet-approved What's On draft so the composer regenerates
-- it with the sparse-week widening (a thin week now shows 14 days instead of
-- a near-empty 7-day card).

insert into public.social_recipes (key, label, config) values
  ('jobs_roundup', 'Jobs roundup', '{"weekday": 3, "hour": 9, "max_jobs": 6}')
on conflict (key) do nothing;

delete from public.social_posts where status = 'draft' and kind = 'whats_on_roundup';
