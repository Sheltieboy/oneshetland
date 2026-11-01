-- Removes the payout-readiness gate on hub campaigns. No data is touched.
begin;
drop trigger if exists hub_campaigns_payout_ready on public.hub_campaigns;
drop function if exists public.hub_campaigns_require_payout_ready();
drop function if exists public.campaign_payout_ready(uuid);
commit;
