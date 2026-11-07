-- Restores create_brief_matches without the entitlement gate (previous definition from 20261230050000).
create or replace function public.create_brief_matches(p_brief uuid, p_business_ids uuid[]) returns uuid[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); b public.trade_briefs; v_ids uuid[];
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into b from public.trade_briefs where id = p_brief and author_id = v_uid and status = 'open' and expires_at > now();
  if not found then raise exception 'No such open job' using errcode = 'P0002'; end if;
  if p_business_ids is null or cardinality(p_business_ids) = 0 then return '{}'; end if;
  with cand as (
    select lb.id, array_position(p_business_ids, lb.id) as pos from public.local_businesses lb
    where lb.id = any (p_business_ids) and lb.is_active and lb.owner_id is not null and lb.owner_id <> v_uid
      and lb.trade_categories && b.trades and coalesce(lb.trade_availability, '') <> 'booked_up'
    order by pos limit 8
  ), ins as (
    insert into public.trade_brief_matches (brief_id, business_id, status) select b.id, cand.id, 'sent' from cand
    on conflict (brief_id, business_id) do nothing returning business_id
  )
  select coalesce(array_agg(business_id), '{}') into v_ids from ins;
  return v_ids;
end $$;
delete from public.email_templates where key in ('trade.lead_waiting','trade.interest_received','trade.details_shared');
-- the three added match columns are kept (harmless).
