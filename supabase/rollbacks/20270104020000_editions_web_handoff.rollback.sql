-- Rollback of 20270104020000_editions_web_handoff. Re-runnable. Codes are short-lived and single-use, so nothing of value is lost; audit rows in edition_audit_log are kept.
drop function if exists public.edition_handoff_redeem(text);
drop function if exists public.edition_handoff_peek(text);
drop function if exists public.edition_handoff_mint(uuid, uuid, text, uuid, text, text);
drop function if exists public.edition_handoff_refusal(uuid, uuid, text);
drop function if exists public.edition_handoff_path(text, uuid, uuid);
drop function if exists public.edition_handoff_as(uuid);
drop table if exists public.edition_web_handoff_codes;
delete from public.rate_limit_policies where action in ('editions_handoff_mint', 'editions_handoff_mint_day', 'editions_handoff_redeem_ip', 'editions_handoff_redeem_code', 'editions_handoff_view_ip');
