-- Rolls back 20270102120000_editions_session_pages.sql (drops the stored session photographs, presenters and business names).
drop function if exists public.edition_session_set_businesses(uuid, uuid[]);
drop table if exists public.edition_session_businesses;
alter table public.edition_sessions drop column if exists image_url, drop column if exists presenters;
