-- A refund now gives its seats back — and the sold counters can no longer stay wrong.
--
-- THE DEFECT (found 2 Oct 2026 on the live Wallet-funded event refund)
--   A refunded ticket kept its seat. refund_event_tickets_for_payment voided the
--   tickets but, by a documented earlier policy, never touched
--   event_ticket_types.quantity_sold — the counter reserve_ticket_basket gates
--   every sale on — nor events.tickets_sold. On a capacity-limited event a
--   customer who had been refunded in full still held a seat, and the next
--   customer was turned away. Live: "TEST — Paid Entry" read 1 of 2 sold with no
--   live ticket at all; two events showed 3 sold against 2 live tickets.
--
-- THE FIX, in four parts
--   1. ticket_type_held(): the one definition of "a seat is held" — a ticket in
--      pending_payment (a reservation), valid, or used (checked in). Refunded,
--      cancelled and anything else holds none.
--   2. refund_event_tickets_for_payment() releases the voided seats in the same
--      transaction, by recount (see the function). Card and Wallet refunds both
--      call it, so they behave identically; a retry or duplicate webhook is a
--      no-op; a checked-in ticket keeps its seat.
--   3. reserve_ticket_basket() makes the counter true under its existing type
--      lock before it trusts it, so the capacity check judges the real number and
--      cannot be fooled by a stale one. Its pinned statements are unchanged.
--   4. refresh_event_ticket_counters() recomputes both counters from the ticket
--      rows, and runs every 15 minutes. increment_event_tickets_sold() (called,
--      best-effort, by checkout and fulfilment after the tickets are valid) now
--      recounts instead of adding, so it can neither double count nor drift.
--
-- No client-visible contract changes: the same columns, the same functions, the
-- same grants (service_role only).

create or replace function public.ticket_type_held(p_type_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select count(*)::int
    from public.event_tickets
   where ticket_type_id = p_type_id
     and status in ('pending_payment', 'valid', 'used');
$$;
comment on function public.ticket_type_held(uuid) is
  'How many seats of this ticket type are held: tickets pending_payment (a reservation), valid, or used (checked in). The definition event_ticket_types.quantity_sold caches. service_role only.';
revoke all on function public.ticket_type_held(uuid) from public, anon, authenticated;
grant execute on function public.ticket_type_held(uuid) to service_role;

create or replace function public.refresh_event_ticket_counters(p_event_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_types  int := 0;
  v_events int := 0;
begin
  -- Lock the types first, in id order — the order every other writer uses — so a
  -- reservation or refund in flight finishes before the recount and one that
  -- starts waits for it. The recount therefore never races a sale.
  perform 1
     from public.event_ticket_types tt
    where p_event_id is null or tt.event_id = p_event_id
    order by tt.id
      for update;

  update public.event_ticket_types tt
     set quantity_sold = public.ticket_type_held(tt.id)
   where (p_event_id is null or tt.event_id = p_event_id)
     and tt.quantity_sold is distinct from public.ticket_type_held(tt.id);
  get diagnostics v_types = row_count;

  -- events.tickets_sold = tickets that are valid or used. Only events that have
  -- ticket types are touched; nothing else about an event is.
  update public.events e
     set tickets_sold = (select count(*)::int from public.event_tickets t
                          where t.event_id = e.id and t.status in ('valid', 'used'))
   where (p_event_id is null or e.id = p_event_id)
     and exists (select 1 from public.event_ticket_types tt where tt.event_id = e.id)
     and coalesce(e.tickets_sold, 0) is distinct from (select count(*)::int from public.event_tickets t
                                                        where t.event_id = e.id and t.status in ('valid', 'used'));
  get diagnostics v_events = row_count;

  return jsonb_build_object('types_corrected', v_types, 'events_corrected', v_events);
end;
$$;
comment on function public.refresh_event_ticket_counters(uuid) is
  'Recomputes event_ticket_types.quantity_sold and events.tickets_sold from the ticket rows (deterministic, idempotent). Only rows whose counter is wrong are written. service_role / cron only.';
revoke all on function public.refresh_event_ticket_counters(uuid) from public, anon, authenticated;
grant execute on function public.refresh_event_ticket_counters(uuid) to service_role;

-- Same name, signature and grants — the edge functions that call it after tickets
-- go valid are not redeployed. p_count is intentionally ignored: adding to a
-- counter is how it drifted; recounting cannot.
create or replace function public.increment_event_tickets_sold(p_event_id uuid, p_count integer)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.events e
     set tickets_sold = (select count(*)::int from public.event_tickets t
                          where t.event_id = e.id and t.status in ('valid', 'used'))
   where e.id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION public.reserve_ticket_basket(p_event_id uuid, p_buyer_id uuid, p_tickets jsonb, p_total_pence integer, p_platform_fee_pence integer, p_snapshot jsonb, p_client_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count      int;
  v_order      public.event_ticket_orders%rowtype;
  v_order_id   uuid;
  v_ticket_ids uuid[];
  v_bad        record;
  v_mismatch   boolean;
begin
  -- ── Input contract, enforced here as well as in the edge function ────────
  if p_tickets is null or jsonb_typeof(p_tickets) <> 'array' then
    raise exception 'reserve_ticket_basket: tickets must be a JSON array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_tickets);
  if v_count < 1 then
    raise exception 'reserve_ticket_basket: basket is empty' using errcode = '22023';
  end if;
  if v_count > 500 then
    raise exception 'reserve_ticket_basket: too many tickets in one order' using errcode = '22023';
  end if;
  if p_event_id is null or p_buyer_id is null then
    raise exception 'reserve_ticket_basket: event and buyer are required' using errcode = '22023';
  end if;
  if p_total_pence is null or p_total_pence < 0 or p_platform_fee_pence is null or p_platform_fee_pence < 0 then
    raise exception 'reserve_ticket_basket: invalid amounts' using errcode = '22023';
  end if;

  -- Required. Without it there is nothing tying a retry to its original order,
  -- and the whole idempotency guarantee is off.
  if p_client_request_id is null or btrim(p_client_request_id) = '' then
    raise exception 'reserve_ticket_basket: a checkout reference is required' using errcode = '22023';
  end if;
  if length(p_client_request_id) < 8 or length(p_client_request_id) > 100 then
    raise exception 'reserve_ticket_basket: client_request_id must be 8-100 characters' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_tickets) t
     where (t->>'ticket_type_id') is null
        or (t->>'token_hash') is null
        or length(t->>'token_hash') < 32
  ) then
    raise exception 'reserve_ticket_basket: every ticket needs a type and a token hash' using errcode = '22023';
  end if;

  -- ── Is this a retry of an attempt we already handled? ────────────────────
  select * into v_order from public.event_ticket_orders
    where buyer_id = p_buyer_id and client_request_id = p_client_request_id
    for update;

  if found then
    if v_order.event_id is distinct from p_event_id then
      raise exception 'IDEMPOTENCY_CONFLICT: this checkout reference belongs to a different event'
        using errcode = '22023';
    end if;
    select exists (
      select 1 from (
        select (t->>'ticket_type_id')::uuid tt, count(*)::int qty
          from jsonb_array_elements(p_tickets) t group by 1
      ) want
      full outer join (
        select ticket_type_id tt, count(*)::int qty
          from public.event_tickets where order_id = v_order.id group by 1
      ) had on had.tt = want.tt
      where want.tt is null or had.tt is null or want.qty <> had.qty
    ) into v_mismatch;
    if v_mismatch then
      raise exception 'IDEMPOTENCY_CONFLICT: this checkout reference was used for a different basket'
        using errcode = '22023';
    end if;

    if v_order.status in ('cancelled', 'refunded') then
      raise exception 'CHECKOUT_EXPIRED: this checkout has expired — start a new one'
        using errcode = '22023';
    end if;

    -- Still pending: nobody holds the raw tokens from the lost response, so
    -- give this call's hashes to the existing tickets. Paid: the buyer may
    -- already hold working tickets, so leave them alone.
    if v_order.status = 'pending' then
      with numbered as (
        select id, row_number() over (order by created_at, id) rn
          from public.event_tickets where order_id = v_order.id
      ), fresh as (
        select (t->>'token_hash') hash, ord rn
          from jsonb_array_elements(p_tickets) with ordinality as e(t, ord)
      )
      update public.event_tickets tk
         set validation_token_hash = fresh.hash
        from numbered n join fresh on fresh.rn = n.rn
       where tk.id = n.id;
    end if;

    select array_agg(id order by created_at, id) into v_ticket_ids
      from public.event_tickets where order_id = v_order.id;

    return jsonb_build_object(
      'order_id',   v_order.id,
      'ticket_ids', to_jsonb(coalesce(v_ticket_ids, '{}'::uuid[])),
      'already',    true,
      'status',     v_order.status,
      'stripe_payment_intent_id', v_order.stripe_payment_intent_id
    );
  end if;

  -- ── Lock every affected type, in a deterministic order ──────────────────
  perform 1
     from public.event_ticket_types tt
    where tt.id in (select distinct (t->>'ticket_type_id')::uuid
                      from jsonb_array_elements(p_tickets) t)
    order by tt.id
      for update;

  if (select count(distinct (t->>'ticket_type_id')::uuid) from jsonb_array_elements(p_tickets) t)
     <> (select count(*) from public.event_ticket_types
          where id in (select distinct (t->>'ticket_type_id')::uuid
                         from jsonb_array_elements(p_tickets) t)) then
    raise exception 'reserve_ticket_basket: one or more ticket types do not exist' using errcode = '22023';
  end if;

  -- ── Make the sold counter TRUE before trusting it ───────────────────────
  -- The type rows are locked above, so nothing can reserve or release a seat
  -- while this runs. quantity_sold is a cache of the ticket rows that hold a
  -- seat; if anything ever left it wrong (a refund that used to keep its seat,
  -- a hand edit, a crashed writer) it is put right HERE, so the capacity check
  -- below always judges the real number and a stale counter can never refuse a
  -- sale it should accept, or accept one it should refuse.
  update public.event_ticket_types tt
     set quantity_sold = public.ticket_type_held(tt.id)
   where tt.id in (select distinct (t->>'ticket_type_id')::uuid
                     from jsonb_array_elements(p_tickets) t)
     and tt.quantity_sold is distinct from public.ticket_type_held(tt.id);

  select w.ticket_type_id, l.name, l.event_id, l.is_active,
         l.quantity_available, l.quantity_sold, l.per_order_max, w.qty
    into v_bad
    from (select (t->>'ticket_type_id')::uuid as ticket_type_id, count(*)::int as qty
            from jsonb_array_elements(p_tickets) t group by 1) w
    join public.event_ticket_types l on l.id = w.ticket_type_id
   where l.event_id is distinct from p_event_id
      or l.is_active is not true
      or w.qty > l.per_order_max
      or (l.quantity_available is not null and (l.quantity_available - l.quantity_sold) < w.qty)
   limit 1;

  if found then
    if v_bad.event_id is distinct from p_event_id then
      raise exception 'reserve_ticket_basket: ticket type does not belong to this event' using errcode = '22023';
    elsif v_bad.is_active is not true then
      raise exception 'reserve_ticket_basket: ticket type is not on sale' using errcode = '22023';
    elsif v_bad.qty > v_bad.per_order_max then
      raise exception 'reserve_ticket_basket: more than % allowed per order', v_bad.per_order_max using errcode = '22023';
    else
      raise exception 'SOLD_OUT' using errcode = '23514';
    end if;
  end if;

  -- ── Claim the attempt BEFORE any counter moves ──────────────────────────
  insert into public.event_ticket_orders
    (event_id, buyer_id, status, total_pence, platform_fee_pence, tickets_count, client_request_id)
  values
    (p_event_id, p_buyer_id, 'pending', p_total_pence, p_platform_fee_pence, v_count, p_client_request_id)
  on conflict (buyer_id, client_request_id) where client_request_id is not null
  do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select * into v_order from public.event_ticket_orders
      where buyer_id = p_buyer_id and client_request_id = p_client_request_id;
    if not found then
      raise exception 'reserve_ticket_basket: could not claim this checkout' using errcode = '40001';
    end if;
    select array_agg(id order by created_at, id) into v_ticket_ids
      from public.event_tickets where order_id = v_order.id;
    return jsonb_build_object(
      'order_id',   v_order.id,
      'ticket_ids', to_jsonb(coalesce(v_ticket_ids, '{}'::uuid[])),
      'already',    true,
      'status',     v_order.status,
      'stripe_payment_intent_id', v_order.stripe_payment_intent_id
    );
  end if;

  -- ── Now, and only now, commit the capacity ──────────────────────────────
  update public.event_ticket_types tt
     set quantity_sold = tt.quantity_sold + w.qty
    from (select (t->>'ticket_type_id')::uuid as ticket_type_id, count(*)::int as qty
            from jsonb_array_elements(p_tickets) t group by 1) w
   where tt.id = w.ticket_type_id;

  with ins as (
    insert into public.event_tickets
      (order_id, event_id, ticket_type_id, holder_id, validation_token_hash,
       backup_code, status, attendee_name, attendee_email, price_pence, event_snapshot)
    select v_order_id,
           p_event_id,
           (t->>'ticket_type_id')::uuid,
           p_buyer_id,
           t->>'token_hash',
           public.generate_ticket_backup_code(),
           'pending_payment',
           nullif(t->>'attendee_name',''),
           nullif(t->>'attendee_email',''),
           l.price_pence,
           coalesce(p_snapshot, '{}'::jsonb)
      from jsonb_array_elements(p_tickets) with ordinality as e(t, ord)
      join public.event_ticket_types l on l.id = (t->>'ticket_type_id')::uuid
     order by e.ord
    returning id
  )
  select array_agg(id) into v_ticket_ids from ins;

  return jsonb_build_object(
    'order_id',   v_order_id,
    'ticket_ids', to_jsonb(v_ticket_ids),
    'already',    false,
    'status',     'pending',
    'stripe_payment_intent_id', null
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_event_tickets_for_payment(p_payment_intent_id text, p_fully_refunded boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order    public.event_ticket_orders%rowtype;
  v_claimed  uuid;
  v_voided   int := 0;
  v_kept     int := 0;
begin
  if p_payment_intent_id is null or btrim(p_payment_intent_id) = '' then
    return jsonb_build_object('matched', false, 'reason', 'no payment intent');
  end if;

  -- The ONLY mapping used. stripe_payment_intent_id is UNIQUE on this table and
  -- is written by the checkout that created the order, so it is authoritative.
  -- Nothing here trusts an order id, a user id or any other value carried in
  -- webhook metadata.
  select * into v_order
    from public.event_ticket_orders
   where stripe_payment_intent_id = p_payment_intent_id;

  if not found then
    -- Almost every refund is for something else entirely (a delivery, a
    -- product). Not matching is the normal case, not an error.
    return jsonb_build_object('matched', false, 'reason', 'not a ticket order');
  end if;

  -- ── Partial refunds are deliberately NOT mapped ──────────────────────────
  -- Nothing in the schema says which of an order's tickets a partial refund
  -- paid back. Voiding all of them would turn away attendees who are still
  -- owed entry, and voiding an arbitrary subset would be worse. So this
  -- records the ambiguity and changes nothing, rather than inventing a rule.
  if p_fully_refunded is not true then
    return jsonb_build_object(
      'matched',   true,
      'order_id',  v_order.id,
      'action',    'partial_refund_not_mapped',
      'message',   'Partial refund on a ticket order — no ticket was voided because the schema cannot say which tickets it covers. Needs a human.'
    );
  end if;

  -- ── Claim the order ─────────────────────────────────────────────────────
  -- Conditional on status='paid', so a second delivery of the same refund
  -- matches zero rows and every effect below is skipped. This is the domain
  -- layer of idempotency; the event ledger is the other.
  update public.event_ticket_orders
     set status = 'refunded', refunded_at = now()
   where id = v_order.id
     and status = 'paid'
  returning id into v_claimed;

  if v_claimed is null then
    return jsonb_build_object(
      'matched',  true,
      'order_id', v_order.id,
      'action',   'already_refunded',
      'status',   (select status from public.event_ticket_orders where id = v_order.id)
    );
  end if;

  -- ── Void the tickets that can still be used ─────────────────────────────
  -- Only 'valid' rows. The predicate is what makes this safe against the door:
  -- a scan racing this refund is the same single-row contention Step 4 built —
  -- whichever statement takes the row lock first wins, and the loser matches
  -- nothing. There is no ordering in which a ticket is both admitted here and
  -- voided there.
  --
  -- The ticket types are locked FIRST, in id order — the order reserve_ticket_basket
  -- uses — so a refund and a sale can never wait on each other.
  perform 1
     from public.event_ticket_types tt
    where tt.id in (select t.ticket_type_id from public.event_tickets t where t.order_id = v_order.id)
    order by tt.id
      for update;

  update public.event_tickets
     set status = 'refunded'
   where order_id = v_order.id
     and status   = 'valid';
  get diagnostics v_voided = row_count;

  -- Tickets already spent stay 'used'. Somebody walked through the door, and
  -- overwriting that with 'refunded' would replace a fact with a falsehood.
  -- They are already unusable — Step 4 only admits status='valid' — so nothing
  -- is gained by rewriting them, and the attendance record survives intact
  -- alongside its event_checkins rows.
  select count(*) into v_kept
    from public.event_tickets
   where order_id = v_order.id and status = 'used';

  -- ── The seat goes back, exactly once ────────────────────────────────────
  -- Capacity used to be deliberately kept on a refund ("whether a refunded seat
  -- goes back on sale is a business decision"). It is now decided: a FULL refund
  -- releases its seats — on the card rail and the Wallet rail alike, because both
  -- reach this one function — otherwise a capacity-limited event stays sold out
  -- to a customer who was given their money back.
  --
  -- It is released by RECOMPUTING from the ticket rows, not by subtracting:
  --   · a duplicate or retried refund never reaches here (the claim above matches
  --     nothing the second time), and even if it did, a recount cannot subtract twice;
  --   · the counter can never go negative — a count is never below zero;
  --   · a ticket that was CHECKED IN is 'used' and still holds its seat, because
  --     the person attended and the sale stands; only tickets this call actually
  --     voided (valid → refunded) stop holding one;
  --   · it heals any drift the counter already had, which is the point.
  update public.event_ticket_types tt
     set quantity_sold = public.ticket_type_held(tt.id)
   where tt.id in (select t.ticket_type_id from public.event_tickets t where t.order_id = v_order.id)
     and tt.quantity_sold is distinct from public.ticket_type_held(tt.id);

  update public.events e
     set tickets_sold = (select count(*)::int from public.event_tickets t
                          where t.event_id = e.id and t.status in ('valid', 'used'))
   where e.id = v_order.event_id
     and e.tickets_sold is distinct from (select count(*)::int from public.event_tickets t
                                           where t.event_id = e.id and t.status in ('valid', 'used'));

  return jsonb_build_object(
    'matched',          true,
    'order_id',         v_order.id,
    'event_id',         v_order.event_id,
    'action',           'refunded',
    'tickets_voided',   v_voided,
    'tickets_kept_used', v_kept,
    'capacity_changed', v_voided > 0,
    'capacity_released', v_voided
  );
end;
$function$
;

-- Self-heal. In-database, no secret: pg_cron runs the recount directly.
select cron.schedule(
  'ticket-counter-selfheal',
  '*/15 * * * *',
  $cron$ select public.refresh_event_ticket_counters(); $cron$
);

-- Correct what has already drifted. On 2 Oct 2026 this is exactly four counters,
-- each one refunded ticket too high: both ZZ TEST fixtures' event totals and
-- their ticket-type totals. It writes nothing else.
select public.refresh_event_ticket_counters();
