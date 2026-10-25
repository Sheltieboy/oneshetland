-- HAND-APPLIED SUPPLEMENT — NOT A MIGRATION, NOT run by `supabase db push`.
-- The text of 20260903120000_subscription_same_second_reconcile.sql was later edited to end with the statement below. Production did not record
-- it with the migration, but the live database no longer has the 3-argument overload, so it was run by hand. Replay harnesses apply this file
-- straight after 20260903120000.
drop function if exists public.claim_subscription_event(text, bigint, text);
