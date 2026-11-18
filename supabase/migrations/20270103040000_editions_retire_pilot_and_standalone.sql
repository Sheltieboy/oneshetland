-- Editions: retire the temporary pilot machinery and the independent-organiser route. CONTRACT migration: apply only AFTER the web build that no longer calls any of these is live.
--
--   * Retired: the pilot switch, per-organiser pilot approvals, 90-day pilot grants, the admin "set up Editions for a Hub" and "link a hub" tools, standalone organiser creation and the
--     separate verification-request form. Their purposes are served by: owner entry from a Business/Hub (edition_ensure_organiser), the Edition review (identity checked with the first approval)
--     and packages (paid, free or Community).
--   * Preserved: every audit row (including any pilot approval, copied into the audit log before its table is dropped), all Edition data, hub verification (admin-only, audited) and the
--     administrator's ordinary entitlement grant, which remains an exception tool.
--   * The "exactly one parent" rule is now enforced for every row (validated here, not just for new rows). The organiser's own name column is no longer editable: it follows its parent.
-- Rollback: supabase/rollbacks/20270103040000_editions_retire_pilot_and_standalone.rollback.sql (recreates the functions and table structure; flag value restored to off)

-- 1. every organiser has exactly one parent (refuse to continue, loudly, if a legacy record was not attached)
do $$ declare v_bad int; begin
  select count(*) into v_bad from public.edition_organisers where num_nonnulls(hub_id, business_id) <> 1;
  if v_bad > 0 then raise exception 'cannot retire standalone organisers: % record(s) have no single Business or Hub parent; attach them first', v_bad using errcode = '23514'; end if;
  alter table public.edition_organisers validate constraint edition_organisers_one_parent;
end $$;

-- 2. keep any pilot approval in the audit log, then retire the pilot
do $$ begin
  if to_regclass('public.edition_pilot_approvals') is not null then
    insert into public.edition_audit_log (actor, organiser_id, edition_id, action, detail)
      select a.approved_by, a.organiser_id, null, 'pilot_approval_retired', jsonb_build_object('approved_at', a.approved_at, 'note', a.note, 'revoked_at', a.revoked_at, 'revoked_reason', a.revoke_reason)
        from public.edition_pilot_approvals a;
  end if;
end $$;
drop function if exists public.admin_set_editions_pilot(boolean, text);
drop function if exists public.admin_approve_edition_pilot(uuid, text);
drop function if exists public.admin_revoke_edition_pilot(uuid, text);
drop function if exists public.admin_grant_edition_pilot_publish(uuid, text, integer);
drop function if exists public.admin_create_edition_organiser_for_hub(uuid, text, text, text);
drop function if exists public.edition_pilot_visible(uuid);
drop table if exists public.edition_pilot_approvals;
drop function if exists public.edition_pilot_approvals_guard();
drop function if exists public.editions_pilot();
delete from public.admin_config where key = 'editions.pilot';

-- 3. no independent organiser, no separate verification request, no manual re-parenting
drop function if exists public.create_edition_organiser(text, text, text, text);
drop function if exists public.create_edition_organiser_for_hub(uuid, text, text);
drop function if exists public.admin_link_edition_organiser_hub(uuid, uuid);
drop function if exists public.request_edition_organiser_verification(uuid, text);

-- 4. the organiser's name follows its parent
revoke update (name) on public.edition_organisers from authenticated;
