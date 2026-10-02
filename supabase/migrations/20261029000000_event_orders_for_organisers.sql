-- Organiser ticket-order management: who bought tickets, and who may refund them.
--
-- Gap found 2 Oct 2026: an organiser could see Sold / Checked in / Capacity on the
-- event screen but had no way to see who bought tickets, inspect an order, or
-- refund one. The pieces mostly existed (organiser read RLS on orders and
-- tickets, refund-payment, refund_event_tickets_for_payment) but nothing joined
-- them to an organiser screen, and refund-payment treated tickets as
-- "platform-admin only".
--
-- Two functions, one authority model each:
--
--   get_event_orders(event)     VIEW   — same people who may scan the event
--                                        (can_scan_event: admin, organiser, the
--                                        organising business's owner, hub
--                                        owner/committee). Returns purchaser
--                                        name and email, which is why it is a
--                                        SECURITY DEFINER function that refuses
--                                        everyone else, not a table grant.
--   can_refund_event_orders()   REFUND — narrower, and the SINGLE place the rule
--                                        lives. Refunds follow the money (as
--                                        refund-payment already says for hub
--                                        memberships): a platform admin, the
--                                        owner of the organising BUSINESS, or the
--                                        OWNER of the organising HUB — the people
--                                        who control the connected account the
--                                        ticket money was paid to. Committee
--                                        members and a bare organiser_user_id can
--                                        view and scan but cannot move money.
--                                        refund-payment calls this; so does the
--                                        screen's "can refund" flag, so the two can
--                                        never disagree.
--
-- Stripe identifiers and reconciliation state are returned to admins only.

create or replace function public.can_refund_event_orders(p_event_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_event public.events%rowtype;
begin
  if p_event_id is null or p_user_id is null then return false; end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then return false; end if;

  if exists (select 1 from public.profiles
              where id = p_user_id and (role = 'admin' or is_platform_owner is true)) then
    return true;
  end if;

  if v_event.organiser_business_id is not null and exists (
    select 1 from public.local_businesses
     where id = v_event.organiser_business_id
       and owner_id is not null and owner_id = p_user_id
  ) then
    return true;
  end if;

  if v_event.organiser_hub_id is not null and exists (
    select 1 from public.hubs
     where id = v_event.organiser_hub_id
       and owner_id is not null and owner_id = p_user_id
  ) then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public.can_refund_event_orders(uuid, uuid) from public, anon, authenticated;
grant execute on function public.can_refund_event_orders(uuid, uuid) to service_role;

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
                   'refundable', (v_can_refund
                                  and o.status = 'paid'
                                  and o.stripe_payment_intent_id is not null
                                  and o.total_pence > 0),
                   -- Platform admins only: Stripe reference and reconciliation verdict.
                   'payment_intent_id',     case when v_admin then o.stripe_payment_intent_id end,
                   'reconciliation_state',  case when v_admin and o.status = 'refunded'
                                                 then coalesce((select r.state from public.refund_reconciliation r
                                                                 where r.payment_intent_id = o.stripe_payment_intent_id
                                                                 limit 1), 'unverified')
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
