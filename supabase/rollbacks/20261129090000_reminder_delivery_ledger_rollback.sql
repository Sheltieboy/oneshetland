-- Rollback for 20261129090000_reminder_delivery_ledger.sql. The deployed reminder-runner needs the ledger: roll the function back first.
drop function if exists public.reminder_purge(interval, timestamptz);
drop function if exists public.reminder_finish_many(text, text, jsonb, timestamptz);
drop function if exists public.reminder_mark_dispatching(text, text, uuid, uuid, integer, timestamptz);
drop function if exists public.reminder_claim_many(text, text, uuid[], integer, timestamptz, integer, interval, timestamptz);
drop table if exists public.reminder_deliveries;
