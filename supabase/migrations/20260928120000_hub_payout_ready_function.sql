-- ============================================================================
-- Part one of the hub column-privacy fix: the safe way to ask the question,
-- landed BEFORE anything is taken away.
--
-- WHAT IS WRONG
--
-- public.hubs grants table-wide SELECT to anon and authenticated, and its RLS
-- policy ("hubs read": is_active = true OR owner_id = auth.uid()) filters ROWS
-- only. Verified against production with the anon key: a signed-out caller can
-- select stripe_account_id for any active hub. It returns null today only
-- because no hub has completed Connect onboarding. The first hub that connects
-- publishes its live Stripe Connect account id to the internet.
--
-- local_businesses had exactly this defect and it was fixed in 20260820220000 /
-- 20260820230000. This is the same remediation, in the same two parts, for the
-- same reason: part two takes a privilege away, and taking a privilege away
-- breaks any client still asking for `select *`.
--
-- WHY A FUNCTION
--
-- Column privileges cannot express "the owner may see this". `authenticated` is
-- every signed-in person. And the honest answer an admin screen needs is not
-- the account id at all — it is a boolean: can this hub be paid? So the id
-- never has to leave the database, and after part two it cannot.
--
-- The same shape as event_payout_ready(uuid) from 20260822120000: one boolean,
-- no identifiers, so the button and the charge cannot disagree.
--
-- ADDITIVE ONLY. No grant is removed here. Safe to apply immediately.
-- ============================================================================

begin;

create or replace function public.hub_payout_ready(p_hub_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
           (select h.payout_enabled and h.stripe_account_id is not null
              from public.hubs h
             where h.id = p_hub_id),
           false);
$$;

comment on function public.hub_payout_ready(uuid) is
  'Can this hub be paid for a membership? The same condition create-hub-membership-intent applies (the hub''s OWN connected account, payouts enabled), returned as a boolean so hubs.stripe_account_id never reaches a client. Does NOT consider the owner''s central account: hubs do not inherit it.';

-- Postgres grants EXECUTE to PUBLIC at CREATE time, so the revoke has to be
-- explicit before the grants mean anything.
revoke all on function public.hub_payout_ready(uuid) from public;
revoke all on function public.hub_payout_ready(uuid) from anon;
grant execute on function public.hub_payout_ready(uuid) to authenticated;
grant execute on function public.hub_payout_ready(uuid) to service_role;

commit;
