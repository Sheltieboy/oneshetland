-- ============================================================================
-- The wallet could be topped up by anyone on the internet, for any amount.
--
-- 20260623010000 set out to make wallet_credit and wallet_debit service-role
-- only. Its comment says "we revoke public access and keep service_role", and
-- that is what everyone has believed since June. It did not happen. It revoked
-- the two roles it named and left the one it did not:
--
--   revoke all on function public.wallet_credit(...)  from anon, authenticated;
--
-- A Postgres function ACL carries a leading `=X/owner` — an EXECUTE grant to
-- PUBLIC, which every role belongs to. Stripping `anon` and `authenticated`
-- removed their own entries and changed nothing, because both kept EXECUTE
-- through PUBLIC. The live ACL was still:
--
--   =X/postgres | postgres=X/postgres | service_role=X/postgres
--
-- Confirmed by probing production with the public anon key, not by reading:
--   POST /rest/v1/rpc/wallet_credit  → HTTP 409 (a foreign-key error, i.e. the
--                                      function RAN and got as far as the insert)
--   POST /rest/v1/rpc/wallet_debit   → HTTP 200
--
-- Neither function performs any authorisation. wallet_credit takes a user id
-- and an amount and adds the amount to that user's balance. wallet_debit
-- subtracts p_spend and ADDS p_cashback in the same statement, and its only
-- guard is `balance_pence >= p_spend` — so p_spend = 0 with a large p_cashback
-- makes wallet_debit a second minting primitive, not merely a way to drain
-- someone. Both accept any user id, so a stranger could top up their own
-- balance or empty anybody else's.
--
-- That balance is real stored value: executeWalletPayment debits it and then
-- issues a Stripe Connect transfer of real money to the business. Minted
-- balance therefore converts into money leaving the platform's Stripe account.
--
-- Two maintenance functions go the same way, exposed by the opposite mistake —
-- their historical revoke named PUBLIC but not anon, so the explicit anon and
-- authenticated grants survived:
--
--   purge_old_job_applications()  deletes job_applications older than six
--                                 months. No caller anywhere in either repo;
--                                 it is meant for a scheduled job.
--   _apply_vessel_edit(record)    applies a vessel edit proposal. Private by
--                                 naming convention, called only from
--                                 vote_vessel_edit, which is SECURITY DEFINER
--                                 and so keeps EXECUTE through the owner.
--
-- Every revoke below names PUBLIC, anon AND authenticated. Naming fewer than
-- all three is what produced this bug twice, in both directions.
--
-- WHAT IS DELIBERATELY NOT REVOKED HERE.
-- analytics_emit looks identical to these on paper — privileged write, no
-- authorisation, no client caller — and revoking it would take production
-- down. Ten of the twelve analytics triggers that call it (tg_ae_booking,
-- tg_ae_donation, tg_ae_event_tickets, tg_ae_wallet, …) are SECURITY INVOKER,
-- so they execute as whoever fired them. Tested: with analytics_emit revoked,
-- an invoker-context call raises insufficient_privilege, which would abort the
-- INSERT the trigger hangs off — breaking bookings, donations, ticket sales,
-- gifts, unit purchases and wallet transactions. It stays granted until those
-- triggers are made SECURITY DEFINER, which is a separate change.
--
-- ensure_member_code and ensure_referral_code are also privileged-looking and
-- are called DIRECTLY by both clients (lib/member-card.ts, lib/referrals.ts,
-- and their web counterparts). They are left alone here and reported instead —
-- their problem is that they take p_user as a parameter rather than reading
-- auth.uid(), which is a design fix, not a grant fix.
--
-- No function body changes in this migration.
-- ============================================================================

-- ── Wallet: the money ───────────────────────────────────────────────────────
-- Callers: 8 edge-function sites for wallet_credit and 7 for wallet_debit,
-- every one on a service-role client (wallet-checkout, wallet-pay,
-- create-event-ticket-intent, create-gift-intent, local-wallet-confirm-topup).
-- Zero client call sites in oneshetland-delivers or oneshetland-web.
-- SQL callers tg_referral_qualify and wallet_topup are both SECURITY DEFINER
-- owned by postgres, so they keep EXECUTE via the owner grant.

revoke all on function public.wallet_credit(uuid, integer) from public;
revoke all on function public.wallet_credit(uuid, integer) from anon;
revoke all on function public.wallet_credit(uuid, integer) from authenticated;
grant execute on function public.wallet_credit(uuid, integer) to service_role;

revoke all on function public.wallet_debit(uuid, integer, integer) from public;
revoke all on function public.wallet_debit(uuid, integer, integer) from anon;
revoke all on function public.wallet_debit(uuid, integer, integer) from authenticated;
grant execute on function public.wallet_debit(uuid, integer, integer) to service_role;

-- ── Maintenance / internal ──────────────────────────────────────────────────

revoke all on function public.purge_old_job_applications() from public;
revoke all on function public.purge_old_job_applications() from anon;
revoke all on function public.purge_old_job_applications() from authenticated;
grant execute on function public.purge_old_job_applications() to service_role;

revoke all on function public._apply_vessel_edit(public.vessel_edit_proposals) from public;
revoke all on function public._apply_vessel_edit(public.vessel_edit_proposals) from anon;
revoke all on function public._apply_vessel_edit(public.vessel_edit_proposals) from authenticated;
grant execute on function public._apply_vessel_edit(public.vessel_edit_proposals) to service_role;

-- ── Record the intent on the objects ────────────────────────────────────────

comment on function public.wallet_credit(uuid, integer) is
  'SERVICE ROLE ONLY. Adds p_amount to any user balance with no authorisation of its own — a minting primitive. Call it only from an edge function that has established who is acting and that the money exists.';
comment on function public.wallet_debit(uuid, integer, integer) is
  'SERVICE ROLE ONLY. Subtracts p_spend and adds p_cashback for any user, with no authorisation of its own. Note p_spend = 0 with a positive p_cashback is a credit, so this mints as well as drains.';
comment on function public.purge_old_job_applications() is
  'SERVICE ROLE ONLY. Destructive maintenance — deletes declined/withdrawn job applications older than six months. Intended for a scheduled job.';
comment on function public._apply_vessel_edit(public.vessel_edit_proposals) is
  'SERVICE ROLE ONLY. Internal helper for vote_vessel_edit (SECURITY DEFINER, reaches this via the owner grant). Applies a proposal without checking who asked for it.';
