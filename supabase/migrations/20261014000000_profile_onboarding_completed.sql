-- Mandatory account-level onboarding: display name, resident/visitor, area if
-- resident. NULL = not yet completed, a real timestamp = completed. Nothing
-- infers completion from populated fields — the row says so explicitly, or it
-- doesn't (see app/onboarding.tsx and the routing gate in app/_layout.tsx).
--
-- This is a deliberate departure from web's onboarding (lib/onboarding.ts),
-- which is entirely optional/skippable and therefore derives progress from
-- the data itself. Mobile's fields are mandatory and the gate is binary, so a
-- derived flag can't distinguish "mid-wizard, not yet finished" from "done" —
-- an explicit column can.
alter table public.profiles
  add column onboarding_completed_at timestamptz null;

-- Grandfather every account that already exists at migration time. Deliberately
-- now(), not created_at: created_at would claim they completed onboarding the
-- moment their account was created, which is false — they were never asked.
-- What's true is that the requirement did not exist for them, and is being
-- waived as of right now. Same DDL+DML transaction as the column add, so no
-- signup landing between "column exists" and "backfill runs" can be wrongly
-- grandfathered — every row NULL at this instant is pre-existing by definition.
update public.profiles
  set onboarding_completed_at = now()
  where onboarding_completed_at is null;

comment on column public.profiles.onboarding_completed_at is
  'NULL = mandatory account onboarding (display name, resident/visitor, area if resident) not yet completed. Non-null = completed at that timestamp. Existing accounts were grandfathered at migration time (20261014000000), not backdated to created_at. Written only by app/onboarding.tsx, in the same update as the fields it collects — never inferred from populated columns.';
