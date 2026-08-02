-- Fetch lane for Shop Shetland orders: a paid order with fulfilment='fetch'
-- spawns a delivery_request (goods already paid; the delivery fee rides the
-- existing Fetch pre-auth/capture rails). These triggers keep the two rows'
-- states in step in BOTH directions:
--
--   order → request : merchant marks "ready" → request.ready_for_collection
--   request → order : driver collects → handed_over; delivers → completed;
--                     request cancelled → order back to accepted (merchant
--                     re-arranges — goods are still paid for).

alter table public.product_orders
  add column if not exists fetch_nudged_at timestamptz;

create or replace function public.sync_order_to_delivery_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready'
     and new.fulfilment = 'fetch' and new.delivery_request_id is not null then
    update delivery_requests set ready_for_collection = true
    where id = new.delivery_request_id and status in ('pending', 'matched');
  end if;
  return new;
end $$;

drop trigger if exists product_orders_sync_fetch on public.product_orders;
create trigger product_orders_sync_fetch
  after update of status on public.product_orders
  for each row execute function public.sync_order_to_delivery_request();

create or replace function public.sync_delivery_request_to_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'collected' then
      update product_orders set status = 'handed_over'
      where delivery_request_id = new.id and status in ('paid', 'accepted', 'ready');
    elsif new.status = 'delivered' then
      update product_orders set status = 'completed', completed_at = now()
      where delivery_request_id = new.id and status in ('paid', 'accepted', 'ready', 'handed_over');
    elsif new.status = 'cancelled' then
      -- Delivery fell through; the goods are still paid — back to the merchant
      -- to re-arrange (collect, post, or a fresh fetch request).
      update product_orders set status = 'accepted', delivery_request_id = null
      where delivery_request_id = new.id and status in ('paid', 'accepted', 'ready');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists delivery_requests_sync_order on public.delivery_requests;
create trigger delivery_requests_sync_order
  after update of status on public.delivery_requests
  for each row execute function public.sync_delivery_request_to_order();
