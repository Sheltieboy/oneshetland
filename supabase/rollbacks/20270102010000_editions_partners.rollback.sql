-- Rollback for 20270102010000_editions_partners.sql. Removes the R2 partnership layer only; R1 (organisers, editions, programme) is untouched.
-- Destroys all partnership links, notes and chosen offers. Nothing here touches businesses, offers, events or activities.
begin;
drop view if exists public.edition_public_businesses, public.edition_public_offers, public.edition_public_events, public.edition_public_activities;
drop function if exists public.edition_joinable();
drop function if exists public.edition_my_pending_count();
drop function if exists public.edition_partner_rows(uuid);
drop function if exists public.edition_my_partnerships();
drop function if exists public.edition_set_link_offers(uuid, uuid[]);
drop function if exists public.edition_offer_options(uuid);
drop function if exists public.edition_link_set_display(uuid, text, integer);
drop function if exists public.edition_link_act(uuid, text, text);
drop function if exists public.edition_request_to_join(uuid, text, uuid, text);
drop function if exists public.edition_invite_partner(uuid, text, uuid, text, text);
drop function if exists public.edition_link_precheck(uuid, text, uuid);
drop function if exists public.edition_find_activities(uuid, text);
drop function if exists public.edition_find_businesses(uuid, text);
drop function if exists public.edition_like_escape(text);
drop table if exists public.edition_link_offers;
drop table if exists public.edition_link_notes;
drop table if exists public.edition_links;
drop function if exists public.edition_link_offers_guard();
drop function if exists public.edition_links_clear_offers();
drop function if exists public.edition_links_transition();
drop function if exists public.edition_links_immutable();
drop function if exists public.edition_link_controls(uuid);
drop function if exists public.edition_controls_subject(text, uuid, uuid, uuid);
drop function if exists public.edition_participation_ok(uuid);
commit;
