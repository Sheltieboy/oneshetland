-- Paygate 7 — you cannot pay yourself with your own wallet.
--
-- THE PATH THIS CLOSES
--
--   top up £500 by card
--   → donate it from the wallet to a hub you own
--   → £500 lands in YOUR connected Stripe account (wallet donations take no
--     platform fee, so all of it)
--   → charge the original card back
--
-- The refund/dispute recovery added earlier turns that from a silent loss into
-- a recorded, blocking deficit — but the money has already left. This stops it
-- leaving.
--
-- WHY THE RULE IS ABOUT THE ACCOUNT, NOT THE RESOURCE
--
-- The obvious guard is "payer owns the hub/business → refuse". It is not
-- enough, and production already shows why: two hubs share one connected
-- account, and NOTHING enforces uniqueness —
--
--   select count(*), count(distinct stripe_account_id) from public.hubs
--   where stripe_account_id is not null   →   5 resources, 4 accounts
--
-- so a payment to a hub somebody else owns can still land in an account the
-- payer controls. The question that actually matters is not "whose hub is
-- this?" but "who ends up with the money?".
--
-- So: resolve the destination account, then ask whether the payer owns ANY
-- resource pointing at it. That covers hub→hub, business→business and
-- hub↔business aliasing with one rule and no guesswork.
--
-- WHAT THIS DELIBERATELY DOES NOT BLOCK
--
-- Paying the PLATFORM for something of your own is the product, not fraud.
-- A shift boost is £2.99 of platform revenue with no transfer_data and no
-- connected account anywhere in it, so an employer boosting their own shift
-- never reaches this function at all. Blocking on "you own the shift" would
-- have destroyed Paygate 5.
--
-- Ownership is the control relation because ownership is what Stripe onboarding
-- enforces: hub-onboard refuses anyone but hubs.owner_id when creating or
-- linking the Connect account. Committee members can open the payouts screen
-- but cannot change where the money goes, so they are not over-blocked.

begin;

create or replace function public.wallet_destination_self_controlled(
  p_user    uuid,
  p_account text
)
returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $$
  select p_user is not null
     and p_account is not null
     and btrim(p_account) <> ''
     and exists (
       select 1 from public.local_businesses b
        where b.stripe_account_id = p_account and b.owner_id = p_user
       union all
       select 1 from public.hubs h
        where h.stripe_account_id = p_account and h.owner_id = p_user
     );
$$;

comment on function public.wallet_destination_self_controlled(uuid, text) is
  'Does this person control the Stripe connected account a wallet payment would pay into? Asked of the DESTINATION ACCOUNT rather than the hub or business being paid, because a connected account can be attached to more than one resource — production already has two hubs sharing one — so resource ownership alone would miss it. Ownership is the control relation because hub-onboard refuses anyone but the owner when linking the account.';

revoke all on function public.wallet_destination_self_controlled(uuid, text) from public, anon, authenticated;
grant execute on function public.wallet_destination_self_controlled(uuid, text) to service_role;

commit;
