-- ═══════════════════════════════════════════════════════════════════════════
-- "Does this person control the account their payment would pay?" — the whole answer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- wallet_destination_self_controlled (20260826200000) is the ONE question every self-payment guard asks. It answered:
-- "does this payer own a business or a hub whose stripe_account_id is this account?". That is not the whole of how a seller is
-- paid. _business_payout_resolve / _event_payout_resolve send a sale to, in this order:
--
--     1. the business's own account        local_businesses.stripe_account_id   (or the parallel business_stripe_account_id)
--     2. otherwise the OWNER'S CENTRAL ACCOUNT   profiles.stripe_account_id, or driver_profiles.stripe_account_id
--
-- and a Fetch delivery pays the DRIVER'S account (driver_profiles). The owner's central account is not necessarily recorded on any
-- business or hub row — production already has one that is not — so for a business that has not been given its own payout account
-- the guard could not see that the buyer, the owner, controls the account: card-funded value could be paid straight to the buyer's own
-- connected account and the guard would say "nothing to see". The same hole applied to a driver buying their own Fetch delivery.
--
-- THIS adds exactly the missing relations, and nothing else:
--
--     · the payer's OWN profile account                       (the owner's central account)
--     · the payer's OWN driver account                        (Fetch driver payouts, and the legacy central account)
--     · a business the payer owns, via business_stripe_account_id  (the parallel column the resolver also honours)
--
-- All still asked of the DESTINATION ACCOUNT, so a second hub or business sharing the account is still caught. Nothing becomes
-- blockable that a buyer does not control: a row only counts if it is the payer's own, or a business/hub the payer owns. A committee
-- member, an employee and a stranger are untouched.
--
-- Same signature, same security definer, same pinned search_path, same grants (service_role only). Replaces the function in place;
-- nothing else in the database changes.

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
       -- a business the payer owns, paid into this account (its own account, or the parallel column the resolver also honours)
       select 1 from public.local_businesses b
        where b.owner_id = p_user
          and (b.stripe_account_id = p_account or b.business_stripe_account_id = p_account)
       union all
       -- a hub the payer owns
       select 1 from public.hubs h
        where h.stripe_account_id = p_account and h.owner_id = p_user
       union all
       -- the payer's own central account: where a business with no account of its own is paid
       select 1 from public.profiles pr
        where pr.id = p_user and pr.stripe_account_id = p_account
       union all
       -- the payer's own driver account: Fetch payouts, and where onboarding once wrote the central account
       select 1 from public.driver_profiles d
        where d.id = p_user and d.stripe_account_id = p_account
     );
$$;

comment on function public.wallet_destination_self_controlled(uuid, text) is
  'Does this person control the Stripe connected account a payment would pay into? Asked of the DESTINATION ACCOUNT, because one account can sit behind several hubs or businesses. Controls = owns a business or hub on that account (either account column), or it is their own central/driver account — which is where a business with no account of its own, and a Fetch delivery, are actually paid.';

revoke all on function public.wallet_destination_self_controlled(uuid, text) from public, anon, authenticated;
grant execute on function public.wallet_destination_self_controlled(uuid, text) to service_role;

-- Self-check: still service_role-only, still pinned, and it now knows the central and driver accounts.
do $check$
begin
  if has_function_privilege('anon', 'public.wallet_destination_self_controlled(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.wallet_destination_self_controlled(uuid, text)', 'EXECUTE') then
    raise exception 'wallet_destination_self_controlled must be service_role only';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.wallet_destination_self_controlled(uuid, text)'::regprocedure
                  and p.prosecdef and p.proconfig::text like '%search_path%'
                  and p.prosrc like '%public.profiles%' and p.prosrc like '%public.driver_profiles%' and p.prosrc like '%business_stripe_account_id%') then
    raise exception 'wallet_destination_self_controlled was not replaced as intended';
  end if;
end
$check$;

commit;
