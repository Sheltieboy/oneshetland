-- Rollback of 20270104030000_editions_push_notifications. Queued, unsent organiser pushes and the once-only follower-update claims are discarded (email is unaffected).
drop trigger if exists edition_push_from_email on public.edition_email_outbox;
drop function if exists public.edition_push_from_email();
drop function if exists public.edition_push_next(integer);
drop function if exists public.edition_push_mark(bigint, text);
drop function if exists public.edition_update_notify_complete(uuid, integer, integer, integer);
drop function if exists public.edition_update_notify_claim(uuid, uuid);
drop function if exists public.edition_update_notify_authorised(uuid, uuid);
drop table if exists public.edition_push_outbox;
drop table if exists public.edition_update_notifications;
