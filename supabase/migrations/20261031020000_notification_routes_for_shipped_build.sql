-- Make every notification openable by the app build that is ALREADY in users' hands (iOS build 144).
--
-- Build 144's tap router (lib/notifications.ts, unchanged since 7 Aug) looks the payload's `screen` up in a
-- fixed table, then falls through to id keys (shift_id, hub_id, business_id, ...). Three `screen` values our
-- senders use are not in that table, which left 9 of the 45 payload shapes in production broken:
--
--   employer-applications  → the table maps it to /employer-applications, a screen that does not exist: NOT FOUND
--   local-business-dashboard (booking, sale, payment received, plan ended): not in the table, and no id → the tap does nothing
--   my-posted-shifts (worker checked in/out): not in the table, and no id → the tap does nothing
--
-- The fixes that make the app handle these directly are committed but not shipped, so the payloads are made
-- compatible on the server instead, with no app change. Done at the one place every notification passes through,
-- because the merchant notices come from shared payment code that about fifteen functions bundle and that is
-- deliberately not redeployed for a routing detail.
--
--   merchant notices  keep `screen` (a newer app will open the dashboard directly) and gain a `business_id`, which
--                     build 144 opens as that business's own page, where the owner has a "Manage business" button.
--                     Only added when it is certain: the booking's own business if it belongs to the recipient, else
--                     the recipient's only business. An owner of several businesses with no precise id gets nothing
--                     added (a tap does nothing) rather than being sent to the wrong business.
--   employer notices  lose the broken `screen`. With a shift_id the app opens that shift (the employer sees the owner
--                     hub); without one they get the Shifts tab, a real parent screen.

create or replace function public.notification_log_route_compat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  scr text := new.data ->> 'screen';
  biz uuid;
  owned int;
begin
  if new.data is null or scr is null then return new; end if;

  if scr = 'local-business-dashboard' and not (new.data ? 'business_id') then
    if (new.data ->> 'booking_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select bb.business_id into biz
        from public.book_bookings bb
        join public.local_businesses lb on lb.id = bb.business_id
       where bb.id = (new.data ->> 'booking_id')::uuid and lb.owner_id = new.user_id;
    end if;
    if biz is null then
      select count(*), (array_agg(id))[1] into owned, biz from public.local_businesses where owner_id = new.user_id;
      if owned <> 1 then biz := null; end if;
    end if;
    if biz is not null then
      new.data := new.data || jsonb_build_object('business_id', biz);
    end if;

  elsif scr in ('employer-applications', 'my-posted-shifts') then
    if new.data ? 'shift_id' then
      new.data := new.data - 'screen';
    else
      new.data := jsonb_set(new.data, '{screen}', '"shifts"');
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.notification_log_route_compat() from public, anon, authenticated;

drop trigger if exists notification_log_route_compat on public.notification_log;
create trigger notification_log_route_compat
  before insert on public.notification_log
  for each row execute function public.notification_log_route_compat();

-- Existing inbox items get the same treatment, so what is already there opens too.
update public.notification_log n
   set data = n.data || jsonb_build_object('business_id', bb.business_id)
  from public.book_bookings bb
  join public.local_businesses lb on lb.id = bb.business_id
 where n.data ->> 'screen' = 'local-business-dashboard' and not (n.data ? 'business_id')
   and (n.data ->> 'booking_id') = bb.id::text and lb.owner_id = n.user_id;

update public.notification_log n
   set data = n.data || jsonb_build_object('business_id', o.id)
  from (select owner_id, (array_agg(id))[1] as id from public.local_businesses
         where owner_id is not null group by owner_id having count(*) = 1) o
 where n.data ->> 'screen' = 'local-business-dashboard' and not (n.data ? 'business_id') and o.owner_id = n.user_id;

update public.notification_log
   set data = data - 'screen'
 where data ->> 'screen' in ('employer-applications', 'my-posted-shifts') and data ? 'shift_id';

update public.notification_log
   set data = jsonb_set(data, '{screen}', '"shifts"')
 where data ->> 'screen' in ('employer-applications', 'my-posted-shifts') and not (data ? 'shift_id');
