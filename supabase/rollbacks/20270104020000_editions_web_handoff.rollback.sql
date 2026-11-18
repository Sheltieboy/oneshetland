-- Rollback of 20270104020000_editions_web_handoff. Re-runnable. Codes are short-lived and single-use, so nothing of value is lost; audit rows in edition_audit_log are kept.
drop function if exists public.edition_handoff_finish(text, boolean, text);
drop function if exists public.edition_handoff_redeem(text, text);
drop function if exists public.edition_handoff_peek(text);
drop function if exists public.edition_handoff_mint(uuid, uuid, text, uuid, text, text, text);
drop function if exists public.edition_handoff_refusal(uuid, uuid, text);
drop function if exists public.edition_handoff_path(text, uuid, uuid);
drop function if exists public.edition_handoff_as(uuid);
drop trigger if exists edition_organisers_slug_not_a_route on public.edition_organisers;
drop trigger if exists editions_slug_not_a_route on public.editions;
drop function if exists public.edition_slug_not_a_route();
drop function if exists public.edition_route_slugs();
-- (edition_ensure_organiser keeps its longer reserved list: it is only stricter, and restating the function here would risk undoing later changes to it)
drop table if exists public.edition_web_handoff_codes;
delete from public.rate_limit_policies where action in ('editions_handoff_mint', 'editions_handoff_mint_day', 'editions_handoff_redeem_ip', 'editions_handoff_redeem_code', 'editions_handoff_view_ip', 'editions_handoff_view_code', 'editions_handoff_secret_fail');
