-- 075_donor_wall_giftaid.sql
-- Add Gift Aid status (and an explicit anonymous flag) to the public donor wall.
-- Still NEVER exposes the Gift Aid name/address — only whether Gift Aid applies.

drop function if exists public.get_campaign_donors(uuid);

create or replace function public.get_campaign_donors(p_campaign uuid)
returns table(
  name         text,
  amount_pence int,
  message      text,
  gift_aid     boolean,
  is_anonymous boolean,
  created_at   timestamptz
)
language sql
security definer
set search_path = public
as $$
  select case when d.is_anonymous then 'Anonymous'
              else coalesce(p.display_name, p.full_name, 'Supporter') end,
         d.amount_pence,
         d.message,
         d.gift_aid,
         d.is_anonymous,
         d.created_at
  from public.hub_donations d
  left join public.profiles p on p.id = d.donor_user_id
  where d.campaign_id = p_campaign
  order by d.created_at desc
  limit 50;
$$;

grant execute on function public.get_campaign_donors(uuid) to authenticated, anon;
