-- ============================================================================
-- Loyalty: points now actually EARN.
--
-- The points programme was configurable but dead — nothing ever credited points.
-- This awards points automatically whenever a customer pays a business through
-- the OneShetland wallet (a 'spend' row in local_wallet_transactions), if that
-- business runs a points programme: points = £ spent × points_per_pound. Runs
-- at the DB level so it's consistent for every payment path (app + web) and
-- can't be missed. Redemption of points already goes through the redemption
-- backbone (kind='points').
-- ============================================================================

create or replace function public.tg_loyalty_earn_points() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  prog   record;
  pts    integer;
  cardid uuid;
begin
  if new.type <> 'spend' or new.business_id is null or coalesce(new.amount_pence, 0) <= 0 then
    return new;
  end if;

  select * into prog from public.local_loyalty_programs
    where business_id = new.business_id and is_active = true and type = 'points'
    limit 1;
  if not found then return new; end if;

  pts := floor((new.amount_pence / 100.0) * coalesce(prog.points_per_pound, 0));
  if pts <= 0 then return new; end if;

  select id into cardid from public.local_loyalty_cards
    where user_id = new.user_id and program_id = prog.id
    limit 1;

  if cardid is null then
    insert into public.local_loyalty_cards (user_id, program_id, business_id, points_balance, last_stamp_at)
    values (new.user_id, prog.id, new.business_id, pts, now())
    returning id into cardid;
  else
    update public.local_loyalty_cards
       set points_balance = coalesce(points_balance, 0) + pts, last_stamp_at = now()
     where id = cardid;
  end if;

  insert into public.local_loyalty_transactions (card_id, user_id, business_id, type, amount, note)
    values (cardid, new.user_id, new.business_id, 'points_earn', pts, 'Earned on spend');

  return new;
end $$;

drop trigger if exists loyalty_earn_points on public.local_wallet_transactions;
create trigger loyalty_earn_points after insert on public.local_wallet_transactions
  for each row execute function public.tg_loyalty_earn_points();
