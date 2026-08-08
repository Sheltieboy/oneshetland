-- Where a listing's planner context came from.
--
-- Three things depend on knowing this:
--
--   1. An OWNER'S answer must never be overwritten. Once someone has said how
--      long folk spend in their shop, no rule and no model gets to change it.
--   2. A guess must never be presented as the owner's words. The business page
--      can say "here's what we're telling visitors about you — is that right?"
--      only if it knows the difference.
--   3. Inferred context can be regenerated wholesale when the prompt or the
--      rules improve, without touching anything a human wrote.
--
--   owner    — the business filled it in
--   reviewed — a human at OneShetland checked it (the amended CSV)
--   rules    — derived from category alone, no invention
--   inferred — Peerie Bot read the description
--   seeded   — defaults by kind, for places nobody owns

alter table public.local_businesses
  add column if not exists planner_context_source text
    check (planner_context_source is null
           or planner_context_source in ('owner', 'reviewed', 'rules', 'inferred', 'seeded'));

comment on column public.local_businesses.planner_context_source is
  'owner | reviewed | rules | inferred | seeded. An owner''s context is never overwritten by rules or inference.';

-- Everything filled in so far was either the seeded defaults or the hand-written
-- flagship list; both are ours rather than the owner's.
update public.local_businesses
   set planner_context_source = 'seeded'
 where planner_context_source is null
   and planner_visitor_ready is not null;
