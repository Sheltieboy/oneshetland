-- get_event_orders: report WHICH RAIL paid for each order, and reconcile Wallet refunds correctly.
--
-- Found 2 Oct 2026: an event ticket paid from the customer's OneShetland Wallet has
-- no PaymentIntent — its payment reference is the synthetic wallet_<ledger id> — so
-- the organiser screen had to treat it exactly like a card order, told the organiser
-- nothing about where a refund would go, and (for admins) could only ever show a
-- Wallet refund as 'unverified' because the card reconciliation table has no row for
-- it. This adds `payment_method` ('wallet' | 'card' | 'free') and gives a refunded
-- Wallet order a verdict from the Wallet ledger itself.
--
-- Same function, same authority (can_scan_event), same grants; only the two fields
-- above are new. Everything else is carried over verbatim from
-- 20261029000000_event_orders_for_organisers.sql.

create or replace function public.get_event_orders(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid        uuid := auth.uid();
  v_admin      boolean;
  v_can_refund boolean;
  v_total      integer;
begin
  if v_uid is null or not public.can_scan_event(p_event_id, v_uid) then
    raise exception 'You are not authorised to view the ticket orders for this event'
      using errcode = '42501';
  end if;

  v_admin := exists (select 1 from public.profiles
                      where id = v_uid and (role = 'admin' or is_platform_owner is true));
  v_can_refund := public.can_refund_event_orders(p_event_id, v_uid);

  select count(*) into v_total
    from public.event_ticket_orders o
   where o.event_id = p_event_id and (o.paid_at is not null or o.refunded_at is not null);

  return jsonb_build_object(
    'can_refund',   v_can_refund,
    'is_admin',     v_admin,
    'total_orders', v_total,
    'orders', coalesce((
      select jsonb_agg(x.j order by x.sort_at desc)
        from (
          select coalesce(o.paid_at, o.refunded_at, o.created_at) as sort_at,
                 jsonb_build_object(
                   'id',                     o.id,
                   'status',                 o.status,
                   'created_at',             o.created_at,
                   'paid_at',                o.paid_at,
                   'refunded_at',            o.refunded_at,
                   'total_pence',            o.total_pence,
                   'booking_fee_pence',      coalesce(o.platform_fee_pence, 0),
                   'ticket_subtotal_pence',  o.total_pence - coalesce(o.platform_fee_pence, 0),
                   'tickets_count',          o.tickets_count,
                   'purchaser', jsonb_build_object(
                     'id',    o.buyer_id,
                     'name',  coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.display_name), '')),
                     'email', u.email
                   ),
                   'tickets', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'id',             t.id,
                              'ticket_type',    tt.name,
                              'status',         t.status,
                              'price_pence',    t.price_pence,
                              'checked_in_at',  t.checked_in_at,
                              'attendee_name',  t.attendee_name,
                              'attendee_email', t.attendee_email
                            ) order by t.created_at)
                       from public.event_tickets t
                       left join public.event_ticket_types tt on tt.id = t.ticket_type_id
                      where t.order_id = o.id
                   ), '[]'::jsonb),
                   'checked_in_count', (select count(*) from public.event_tickets t
                                         where t.order_id = o.id and t.status = 'used'),
                   -- Whether THIS viewer may refund THIS order right now.
                   -- Which rail paid for it: decides where a refund goes (back to the card, or
                   -- back into the customer's OneShetland Wallet).
                   'payment_method', case
                       when o.total_pence <= 0 or o.stripe_payment_intent_id is null then 'free'
                       when o.stripe_payment_intent_id like 'wallet\_%' escape '\' then 'wallet'
                       else 'card' end,
                   'refundable', (v_can_refund
                                  and o.status = 'paid'
                                  and o.stripe_payment_intent_id is not null
                                  and o.total_pence > 0),
                   -- Platform admins only: Stripe reference and reconciliation verdict.
                   'payment_intent_id',     case when v_admin then o.stripe_payment_intent_id end,
                   'reconciliation_state',  case when v_admin and o.status = 'refunded' then
                       case
                         -- Wallet-funded: reconciled only when the ledger holds ONE linked reversal AND
                         -- the organiser's transfer is accounted for (clawed back, or never sent).
                         when o.stripe_payment_intent_id ~ '^wallet_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
                           coalesce((
                             select case when exists (select 1 from public.local_wallet_transactions rv
                                                       where rv.reverses_transaction_id = orig.id)
                                          and coalesce(orig.transfer_state, 'none') in ('reversed', 'none', 'failed')
                                         then 'reconciled' else 'needs_review' end
                               from public.local_wallet_transactions orig
                              where orig.id = substr(o.stripe_payment_intent_id, 8)::uuid
                           ), 'unverified')
                         else coalesce((select r.state from public.refund_reconciliation r
                                         where r.payment_intent_id = o.stripe_payment_intent_id
                                         limit 1), 'unverified')
                       end
                   end
                 ) as j
            from public.event_ticket_orders o
            left join public.profiles p on p.id = o.buyer_id
            left join auth.users u      on u.id = o.buyer_id
           where o.event_id = p_event_id
             and (o.paid_at is not null or o.refunded_at is not null)
           order by coalesce(o.paid_at, o.refunded_at, o.created_at) desc
           limit 500
        ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_event_orders(uuid) from public, anon;
grant execute on function public.get_event_orders(uuid) to authenticated, service_role;
