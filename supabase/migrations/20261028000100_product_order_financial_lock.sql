-- product_orders: a merchant may move an order through its lifecycle, but may
-- not rewrite what the transaction WAS.
--
-- Found by the 2 Oct 2026 live reconciliation: "business updates its orders"
-- lets the owning business UPDATE any column of its own orders, authenticated
-- holds blanket table-level UPDATE, and the only trigger (tg_zz_lock_order_
-- refund_columns) locks the refund columns. So a merchant could edit
-- total_pence, commission_pence, payment_intent_id, buyer_id and so on straight
-- through the API — falsifying the very records reconciliation relies on.
--
-- This is an ALLOWLIST: a client role may change only the lifecycle fields the
-- apps actually write (status and its timestamps, and the tracking reference).
-- Every other column — including any added in future — is locked by default.
-- Server writes (service_role, SECURITY DEFINER functions, migrations) are
-- unaffected: public.tg_is_server_write() is true unless the session user is
-- authenticated or anon. Refund-state rules in tg_lock_order_refund_columns
-- still apply on top.

create or replace function public.tg_lock_order_financial_columns()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  -- Exactly what updateOrderStatus (mobile) and OrdersInbox (web) write, plus
  -- cancelled_at and the updated_at stamp set by the set_updated_at trigger.
  lifecycle text[] := array[
    'status', 'tracking_ref', 'accepted_at', 'ready_at', 'posted_at',
    'completed_at', 'cancelled_at', 'updated_at'
  ];
begin
  if public.tg_is_server_write() then return new; end if;
  if tg_op <> 'UPDATE' then return new; end if;

  if (to_jsonb(new) - lifecycle) is distinct from (to_jsonb(old) - lifecycle) then
    raise exception 'order payment, amount and ownership fields are server-managed'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists tg_zz_lock_order_financial_columns on public.product_orders;
create trigger tg_zz_lock_order_financial_columns
  before update on public.product_orders
  for each row execute function public.tg_lock_order_financial_columns();
