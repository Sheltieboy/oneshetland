-- Paygate 8 — one membership fee, one place to change it.
--
-- WHAT WAS WRONG
--
-- The two membership payment routes read DIFFERENT configuration keys:
--
--   card    create-hub-membership-intent  →  getCommissionConfig('membership')
--                                            → fees.membership.fixed_pence
--                                            → UNSET, so the code default, 95p
--
--   wallet  wallet-checkout hubMembership →  fees.hub_membership.flat_pence
--                                            → set to 50
--
-- So the same £10 Junior membership cost £10.95 by card and £10.50 by wallet,
-- and nobody had decided that. The wallet key is a leftover from before the
-- shared commission rails existed; it is the only one of its shape still being
-- read on a payment path.
--
-- The fee is now a single authoritative value on the 'membership' rail, seeded
-- explicitly rather than left to a code default so an admin can see and change
-- it in one place. wallet-checkout moves onto the same getCommissionConfig call
-- the card path already uses, so changing the fee once changes both.

begin;

insert into public.admin_config (key, value, description, category)
values
  ('fees.membership.percent_bps', '0',
   'Hub membership — platform fee percentage in basis points (0 = flat fee only). Applies to BOTH card and wallet.',
   'fees'),
  ('fees.membership.fixed_pence', '95',
   'Hub membership — flat OneShetland fee in pence, added on top of the tier price so the hub receives the full membership price. Applies to BOTH card and wallet.',
   'fees')
on conflict (key) do update
  set value       = excluded.value,
      description = excluded.description,
      category    = excluded.category;

-- The old wallet-only key stays as a row so nothing that merely reads config
-- listings breaks, but no payment path reads it any more. Renamed in its
-- description so the next person does not change it and wonder why nothing
-- happens.
update public.admin_config
   set description = 'DEPRECATED — no longer read by any payment path. Hub membership fees now come from fees.membership.fixed_pence, which both card and wallet use.'
 where key = 'fees.hub_membership.flat_pence';

commit;
