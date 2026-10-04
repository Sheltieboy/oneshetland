-- Known test/acceptance fixtures: out of public DISCOVERY, still fully usable.
--
-- THE PROBLEM
--
-- Three records exist only for the pending Wallet healthy-state acceptance and the Anderson & Co demo seed:
--   ZZ TEST — OneShetland Acceptance Fixture   52f68630-…  (business: 2 passes, 1 service, 1 product)
--   Anderson & Co (csv demo seed)              8e3ff71c-…  (business: 1 DEMO pass, 1 DEMO product)
--   ZZ TEST — Wallet Acceptance Hub            bad36349-…  (hub: 1 campaign, 1 membership tier)
-- They are active and public, so launch visitors see them: the first "Featured" card on Web Home, passes and
-- bookable services on Local, "DEMO — Launch Test Product" in the Shop rails of both apps, and the only hub on the
-- Hubs list. They must not be deleted, archived or altered (the acceptance spends real Wallet money against them).
--
-- THE MECHANISM — an explicit list, not a name pattern
--
-- discovery_fixtures names each fixture by id. is_discovery_hidden(entity, id) is true only for a listed fixture AND
-- only for a caller who is not an administrator. (The fixture's owner keeps access through the owner branches the
-- policies already have.) The public read policies of the tables that
-- feed discovery consult it. Consequences, all deliberate:
--   • the public (signed-out or ordinary signed-in) never receives a fixture from any list, rail, feed, search,
--     Featured shelf or direct lookup;
--   • an administrator -- the Wallet acceptance tester is one -- and the fixture's owner (through the owner
--     branches the policies already carry) see everything exactly as before, so the acceptance can still be run on a phone;
--   • server-side flows (edge functions use the service role, which bypasses these policies) are untouched, so
--     payments, refunds, redemptions and every ledger row are unchanged;
--   • no fixture row is modified. Retiring them later is: delete their rows here (or deactivate them) -- one step.
--
-- This changes READ visibility only. No write policy, trigger, payment or ledger object is touched.
--
-- local_businesses_public is a security_invoker view, so changing the base-table policy covers it, and everything
-- that embeds a business (products, offers, passes, notices) with it.

begin;

create table if not exists public.discovery_fixtures (
  entity     text not null check (entity in ('business', 'hub')),
  entity_id  uuid not null,
  reason     text not null,
  created_at timestamptz not null default now(),
  primary key (entity, entity_id)
);
comment on table public.discovery_fixtures is
  'Test/acceptance fixtures withheld from public discovery (see is_discovery_hidden). Remove a row to make the record public again; delete the record itself separately, after its acceptance is done.';

alter table public.discovery_fixtures enable row level security;
revoke all on public.discovery_fixtures from anon, authenticated;
grant select, insert, update, delete on public.discovery_fixtures to service_role;

insert into public.discovery_fixtures (entity, entity_id, reason) values
  ('business', '52f68630-c6aa-4bbf-9cda-4a63b08e94d4', 'ZZ TEST — OneShetland Acceptance Fixture: Wallet pass/booking acceptance'),
  ('business', '8e3ff71c-1442-405e-84c3-0de4eff64c99', 'Anderson & Co: csv demo seed (DEMO pass, DEMO product); duplicates the real LL Anderson & Co'),
  ('hub',      'bad36349-ed55-4907-ad71-d2a2d5f4108c', 'ZZ TEST — Wallet Acceptance Hub: donation and membership acceptance')
on conflict (entity, entity_id) do nothing;

-- true = hide this record from the CURRENT caller.
create or replace function public.is_discovery_hidden(p_entity text, p_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_id is null then return false; end if;
  -- Cheap exit first: almost every record is not a fixture.
  if not exists (select 1 from public.discovery_fixtures f where f.entity = p_entity and f.entity_id = p_id) then
    return false;
  end if;
  if coalesce(public.is_admin(), false) then return false; end if;
  return true;
end;
$$;

revoke execute on function public.is_discovery_hidden(text, uuid) from public;
grant  execute on function public.is_discovery_hidden(text, uuid) to anon, authenticated, service_role;

-- ── The public read policies that feed discovery ────────────────────────────
-- Each keeps its existing rule, its owner/admin escape hatches and its roles; only the public branch gains the test.

alter policy "Anyone can read active businesses" on public.local_businesses
  using (((is_active = true) and not public.is_discovery_hidden('business', id)) or (owner_id = auth.uid()));

alter policy "public reads live products" on public.products
  using (is_active and is_business_active(business_id) and business_meets_tier(business_id, 'premium'::text)
         and not public.is_discovery_hidden('business', business_id));

alter policy "Anyone can read active unit items" on public.book_unit_items
  using ((((is_active = true) and business_meets_tier(business_id, 'premium'::text)
           and not public.is_discovery_hidden('business', business_id))
          or is_business_owner(business_id, auth.uid())));

alter policy "Anyone can read active services" on public.book_services
  using ((((is_active = true) and not public.is_discovery_hidden('business', business_id))
          or is_business_owner(business_id, auth.uid())));

alter policy "Anyone can read active offers" on public.local_offers
  using ((((is_active = true) and business_meets_tier(business_id, 'pro'::text)
           and not public.is_discovery_hidden('business', business_id))
          or is_business_owner(business_id, auth.uid())));

alter policy "hubs read" on public.hubs
  using (((is_active = true) and not public.is_discovery_hidden('hub', id)) or (owner_id = auth.uid()));

alter policy "hub_campaigns read" on public.hub_campaigns
  using (not public.is_discovery_hidden('hub', hub_id));

alter policy "hub_membership_types read" on public.hub_membership_types
  using (((is_active and not public.is_discovery_hidden('hub', hub_id)) or is_hub_admin(hub_id, auth.uid())));

commit;
