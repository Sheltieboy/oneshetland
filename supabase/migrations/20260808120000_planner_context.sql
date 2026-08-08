-- Planner context: what a place actually is, for the visitor day planner.
--
-- The planner had to infer things it has no business inferring. Dwell time was
-- a constant per category, so Jarlshof got the same 75 minutes as a roadside
-- viewpoint and every arrival time after the first stop inherited the error.
-- Nothing separated a knitwear shop from a flooring merchant — both `retail`.
-- Nothing knew which places are outdoors, on an island where that decides the
-- day. No prompt tuning fixes missing data.
--
-- NOTE ON visitor_ready: nullable with NO default, deliberately. The design
-- said `default false`, which would have made all 534 existing listings
-- invisible to the planner the moment this ran. Three states are what's needed:
--   NULL  = nobody has said (behaves exactly as today — included)
--   true  = yes, send visitors (and score it higher)
--   false = no (a trade counter, a village hall) — never planned for
-- So this migration changes nothing until something is filled in.

alter table public.local_businesses
  add column if not exists planner_visitor_ready boolean,
  add column if not exists planner_dwell_minutes integer
    check (planner_dwell_minutes is null or planner_dwell_minutes between 5 and 480),
  add column if not exists planner_setting text
    check (planner_setting is null or planner_setting in ('indoor', 'outdoor', 'both')),
  add column if not exists planner_good_for text[],
  add column if not exists planner_booking text
    check (planner_booking is null or planner_booking in ('none', 'advised', 'required')),
  -- Capped in the database as well as the form. The limit is the point: asked
  -- for a paragraph every business writes an advert, and an advert is exactly
  -- what a planner cannot reason over.
  add column if not exists planner_note text
    check (planner_note is null or length(planner_note) <= 140);

comment on column public.local_businesses.planner_visitor_ready is
  'Three-state: null = not said (planner includes it), true = send visitors, false = never plan for it.';
comment on column public.local_businesses.planner_dwell_minutes is
  'How long folk actually spend. Replaces the planner''s per-category guess.';
comment on column public.local_businesses.planner_setting is
  'indoor | outdoor | both — lets a wet day reshuffle the running order.';
comment on column public.local_businesses.planner_good_for is
  'Fixed chips (families, wet day, quick stop, proper visit…). Chips can be reasoned over; adjectives cannot.';
comment on column public.local_businesses.planner_note is
  'One plain line on what a visitor actually does here. Read by the planner, not an advert. 140 chars.';

-- The planner asks for "visitor-ready places with coordinates" on every run.
create index if not exists local_businesses_planner_idx
  on public.local_businesses (planner_visitor_ready)
  where is_active = true;
