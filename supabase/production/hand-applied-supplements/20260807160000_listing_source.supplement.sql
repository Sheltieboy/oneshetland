-- HAND-APPLIED SUPPLEMENT — NOT A MIGRATION, NOT run by `supabase db push`.
-- The live local_businesses_source_check allows 'livinglerwick', 'shetlandindex' and 'openstreetmap'. No migration widens it: the DDL below sits at the top
-- of supabase/scripts/seed-openstreetmap.sql (and seed-livinglerwick.sql), which were run by hand in the SQL editor. Recorded so a replay of the
-- migration history reproduces production; replay harnesses apply this file straight after 20260807160000.
alter table public.local_businesses drop constraint if exists local_businesses_source_check;
alter table public.local_businesses add constraint local_businesses_source_check
  check (source = any (array['owner','csv','google','wordpress','livinglerwick','shetlandindex','openstreetmap']));
