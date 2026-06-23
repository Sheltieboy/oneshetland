-- 074_notice_campaign_link.sql
-- Let a notice reference a fundraising campaign, so a campaign can post a notice
-- with a donate quick-link + a live progress indicator in the notice card.

alter table public.notices
  add column if not exists campaign_id uuid references public.hub_campaigns(id) on delete cascade;

create index if not exists idx_notices_campaign on public.notices(campaign_id) where campaign_id is not null;
