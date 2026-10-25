-- ═══════════════════════════════════════════════════════════════════════════
-- event_ticket_orders: written ONLY by the server, never by a browser or the app
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
--
-- The baseline gave the table an INSERT policy for every signed-in user:
--
--     CREATE POLICY ticket_orders_buyer_insert ON public.event_ticket_orders
--       FOR INSERT WITH CHECK ((buyer_id = auth.uid()));
--
-- and `GRANT ALL ... TO authenticated`. The only condition was "you are the buyer", so a signed-in user could insert a row
-- they had written entirely themselves — status 'paid', any total, any event, any id, and any stripe_payment_intent_id that
-- was not already on another order. There was no trigger on INSERT, and the status CHECK allows 'paid'.
--
-- Nothing in the product needs it. The website and the app only READ this table. Every real order is created by
-- reserve_ticket_basket(), which is service_role-only, called from create-event-ticket-intent; every state change after that
-- is made by service_role (create-event-ticket-intent, confirm-event-tickets, the Stripe webhook) or by SECURITY DEFINER
-- functions (release_ticket_order, expire_stale_ticket_orders, refund_event_tickets_for_payment).
--
-- WHY IT MATTERED (money, not just data)
--
-- refund-payment, given { event_order_id }, authorised the caller by who organised the event, then took the payment id from
-- the ORDER ROW and refunded it with reverse_transfer. Any signed-in user can create a business and an event in their own
-- name, so they could forge a paid order against their own event, point it at a payment of theirs that no ticket order held
-- (a wallet top-up, a pass, a donation), and have the platform refund it — then keep whatever the payment had bought.
-- refund-payment now independently proves the payment belongs to the order (see _shared/ticket-payment-binding.ts); this
-- migration removes the way to forge the order in the first place.
--
-- WHAT THIS DOES — and nothing else
--
--   1. Drops ticket_orders_buyer_insert.
--   2. anon: no privilege on the table. authenticated: SELECT only (the buyer reads their own orders and the organiser reads
--      theirs through the existing ticket_orders_buyer_read policy, which is untouched). service_role is untouched.
--   3. A BEFORE INSERT/UPDATE/DELETE trigger that refuses any write from a client role (tg_is_server_write(), the same helper
--      the product-order and pass locks use, with no administrator exemption). It makes the table safe even if a later
--      migration re-grants client privileges, which is how this class of hole has re-opened before.
--
-- NOT TOUCHED: any other table, any row, RLS enablement, the read policy, service_role, the SECURITY DEFINER functions.
--
-- THE MIGRATION PROVES ITSELF: it aborts (and rolls back) if afterwards a client role could still write the table.

begin;

set local lock_timeout = '5s';

-- 1. the policy that let a buyer write their own order ─────────────────────────
drop policy if exists ticket_orders_buyer_insert on public.event_ticket_orders;

-- 2. privileges ────────────────────────────────────────────────────────────────
revoke all on table public.event_ticket_orders from public, anon;
revoke insert, update, delete, truncate, references, trigger on table public.event_ticket_orders from authenticated;

-- 3. belt and braces: refuse a client-role write whatever the grants say ─────────
create or replace function public.tg_event_ticket_orders_server_only()
returns trigger
language plpgsql
-- SECURITY INVOKER on purpose: current_user must stay the role that is actually writing (see tg_is_server_write()).
set search_path to 'public'
as $$
begin
  if public.tg_is_server_write() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'ticket orders are created and settled by the server only'
    using errcode = '42501';
end;
$$;

comment on function public.tg_event_ticket_orders_server_only() is
  'Refuses any INSERT/UPDATE/DELETE on event_ticket_orders made directly by anon or authenticated. Orders are created by reserve_ticket_basket() and settled by service_role / SECURITY DEFINER code only.';

drop trigger if exists tg_zz_event_ticket_orders_server_only on public.event_ticket_orders;
create trigger tg_zz_event_ticket_orders_server_only
  before insert or update or delete on public.event_ticket_orders
  for each row execute function public.tg_event_ticket_orders_server_only();

-- 4. self-check: refuse to commit anything that leaves a way in ───────────────
do $check$
declare
  v_bad text;
  v_role text;
  v_priv text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.event_ticket_orders'::regclass) then
    raise exception 'event_ticket_orders: RLS is not enabled';
  end if;

  select string_agg(p.policyname || ' (' || p.cmd || ')', ', ') into v_bad
    from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'event_ticket_orders'
     and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v_bad is not null then raise exception 'event_ticket_orders still has a client write policy: %', v_bad; end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(v_role, 'public.event_ticket_orders', v_priv) then
        raise exception 'event_ticket_orders: % still holds % ', v_role, v_priv;
      end if;
    end loop;
  end loop;
  if has_table_privilege('anon', 'public.event_ticket_orders', 'SELECT') then
    raise exception 'event_ticket_orders: anon can still SELECT';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.event_ticket_orders'::regclass
                    and tgname = 'tg_zz_event_ticket_orders_server_only' and tgenabled = 'O') then
    raise exception 'event_ticket_orders: the server-only trigger is missing or disabled';
  end if;
end
$check$;

commit;
