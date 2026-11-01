-- ============================================================================
-- A hub cannot publish a donation campaign it cannot be paid for.
--
-- THE GAP
-- hub_campaigns is written straight from the client by a hub admin (policy
-- "hub_campaigns manage": is_hub_admin and nothing else) and a new row defaults
-- to status 'active', so creating a campaign IS publishing it. Nothing asked
-- whether the hub could receive money. Both donation routes do — card
-- (create-hub-donation-intent) and wallet (wallet-checkout) refuse a hub with no
-- connected account or payouts disabled — so a campaign could go live that every
-- donor was then turned away from ("has not finished setting up payouts").
--
-- THE RULE (one definition, reused)
-- hub_payout_ready(hub): the hub's OWN connected account, payouts enabled — the
-- same condition the two donation routes apply, and the one the membership
-- screens already ask. Not redefined here.
--
-- WHAT IS ENFORCED
--  * INSERT of an 'active' campaign             -> hub must be payout-ready.
--  * UPDATE that makes a campaign 'active' (reopening a closed one, or moving it
--    to another hub)                            -> hub must be payout-ready.
--  * Everything else is untouched: a campaign inserted 'closed', edits to the
--    title/story/goal/cover/end date, closing a campaign, and the raised/donor
--    counters that record_hub_donation bumps. A campaign already live when a hub
--    loses payout readiness keeps its row, its history and its donations; the
--    donation routes continue to refuse new money until the hub is ready again.
--
-- campaign_payout_ready(campaign) is a boolean for the PUBLIC campaign page so it
-- can say "Donations temporarily unavailable" and hide the Donate action. It is
-- callable signed-out (campaign pages are public) and returns nothing else — no
-- account id, no hub detail. It is display only: the money paths keep their own
-- server-side checks, which this migration does not touch.
--
-- ADDITIVE: no row is changed; the campaign eligibility function and both
-- donation Edge Functions are untouched.
-- ============================================================================

begin;

create or replace function public.hub_campaigns_require_payout_ready()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active' or old.hub_id is distinct from new.hub_id)
     and not public.hub_payout_ready(new.hub_id) then
    raise exception 'Finish setting up payouts before publishing a campaign.'
      using errcode = '23514', hint = 'hub_payout_not_ready';
  end if;
  return new;
end;
$$;

revoke all on function public.hub_campaigns_require_payout_ready() from public, anon, authenticated;

drop trigger if exists hub_campaigns_payout_ready on public.hub_campaigns;
create trigger hub_campaigns_payout_ready
  before insert or update of status, hub_id on public.hub_campaigns
  for each row execute function public.hub_campaigns_require_payout_ready();

create or replace function public.campaign_payout_ready(p_campaign uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
           (select public.hub_payout_ready(c.hub_id) from public.hub_campaigns c where c.id = p_campaign),
           false);
$$;

comment on function public.campaign_payout_ready(uuid) is
  'Can this campaign''s hub currently be paid? hub_payout_ready() of the campaign''s hub, as a boolean, for the public campaign page (signed-out included). Display only: card and wallet donations keep their own server-side checks.';

revoke all on function public.campaign_payout_ready(uuid) from public;
grant execute on function public.campaign_payout_ready(uuid) to anon, authenticated, service_role;

commit;
