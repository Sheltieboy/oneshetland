-- ============================================================================
-- Half a basket could be reserved for an order that was never created.
--
-- create-event-ticket-intent reserved capacity one line at a time:
--
--   for (const li of items) {
--     const { data: reserved } = await supabase.rpc('reserve_ticket_slots', …);
--     if (!reserved) return 409;          // <- earlier lines stay reserved
--   }
--
-- Adult x2 succeeds, Child x3 sells out, the request 409s, and Adult's two
-- seats are held forever. Reproduced on production before this migration
-- (rolled back): A delta +2, B delta 0, request failed.
--
-- That is the visible half. The worse half is the ORDER of operations: capacity
-- was reserved BEFORE the order row existed, and expire_stale_ticket_orders
-- releases capacity by counting event_tickets rows joined to a pending order.
-- Anything reserved without an order is therefore invisible to the only thing
-- that gives capacity back. Four separate paths in that function then made it
-- worse by DELETING the order and its tickets on failure —
--
--   ticket insert failed          (index.ts:269)
--   organiser not payout-ready    (index.ts:305)
--   insufficient wallet balance   (index.ts:318)
--   wallet transfer failed        (index.ts:343)
--
-- — each destroying the only evidence that could ever release the seats it had
-- just taken. A shop that turns customers away because three abandoned baskets
-- from last Tuesday are still holding the last three tickets.
--
-- So an atomic basket reservation on its own would not have been enough. It
-- closes the partial-basket case and leaves the crash window between reserving
-- and creating the order. The fix has to make reservation, the pending order,
-- and the ticket rows ONE transaction, so that capacity can only ever be held
-- by an order that exists and can therefore be expired or released.
--
--   reserve_ticket_basket   capacity + order + tickets, atomically
--   release_ticket_order    give the seats back for an abort, idempotently
--
-- Both are service-role only. Steps 1 and 1B established that function grants
-- are where this project's vulnerabilities have actually lived, so every revoke
-- here names PUBLIC, anon AND authenticated — naming fewer is what left the
-- wallet mintable for two months.
--
-- C4 (two concurrent scans of one ticket both returning VALID) is a separate
-- step; validate_and_checkin_ticket is untouched.
-- ============================================================================

-- ── Reserve a whole basket, or none of it ───────────────────────────────────
--
-- p_tickets is the flat list of ticket rows to create, one JSON object per
-- SEAT, in the order the caller wants them back:
--   [{ ticket_type_id, token_hash, attendee_name, attendee_email }, …]
--
-- Quantities are DERIVED by grouping that list, so the count that is checked
-- against capacity and the count that is actually inserted cannot disagree.
-- There is no separate quantity argument to get out of step with the rows.

create or replace function public.reserve_ticket_basket(
  p_event_id           uuid,
  p_buyer_id           uuid,
  p_tickets            jsonb,
  p_total_pence        integer,
  p_platform_fee_pence integer,
  p_snapshot           jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_count      int;
  v_order_id   uuid;
  v_ticket_ids uuid[];
  v_bad        record;
begin
  -- ── Input contract, enforced here as well as in the edge function ────────
  if p_tickets is null or jsonb_typeof(p_tickets) <> 'array' then
    raise exception 'reserve_ticket_basket: tickets must be a JSON array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_tickets);
  if v_count < 1 then
    raise exception 'reserve_ticket_basket: basket is empty' using errcode = '22023';
  end if;
  -- 20 line items x per_order_max 10 today; 500 seats is a generous ceiling
  -- that still bounds the work done while holding row locks.
  if v_count > 500 then
    raise exception 'reserve_ticket_basket: too many tickets in one order' using errcode = '22023';
  end if;
  if p_event_id is null or p_buyer_id is null then
    raise exception 'reserve_ticket_basket: event and buyer are required' using errcode = '22023';
  end if;
  if p_total_pence is null or p_total_pence < 0 or p_platform_fee_pence is null or p_platform_fee_pence < 0 then
    raise exception 'reserve_ticket_basket: invalid amounts' using errcode = '22023';
  end if;

  -- Every seat must name a ticket type and carry its own validation hash.
  if exists (
    select 1 from jsonb_array_elements(p_tickets) t
     where (t->>'ticket_type_id') is null
        or (t->>'token_hash') is null
        or length(t->>'token_hash') < 32
  ) then
    raise exception 'reserve_ticket_basket: every ticket needs a type and a token hash' using errcode = '22023';
  end if;

  -- ── Lock every affected type, in a deterministic order ──────────────────
  -- ORDER BY id so a basket of {A,B} and a concurrent basket of {B,A} take the
  -- locks the same way round and queue instead of deadlocking. The locks are
  -- held for the rest of the transaction, so the checks below read stable rows.
  perform 1
     from public.event_ticket_types tt
    where tt.id in (select distinct (t->>'ticket_type_id')::uuid
                      from jsonb_array_elements(p_tickets) t)
    order by tt.id
      for update;

  -- Every requested type must exist.
  if (select count(distinct (t->>'ticket_type_id')::uuid) from jsonb_array_elements(p_tickets) t)
     <> (select count(*) from public.event_ticket_types
          where id in (select distinct (t->>'ticket_type_id')::uuid
                         from jsonb_array_elements(p_tickets) t)) then
    raise exception 'reserve_ticket_basket: one or more ticket types do not exist' using errcode = '22023';
  end if;

  -- ── Every type must belong to THIS event, be on sale, and have room ──────
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
      -- The ordinary, expected outcome when an event sells out mid-checkout.
      -- Signalled distinctly so the caller can say "sold out" rather than
      -- "something went wrong".
      raise exception 'SOLD_OUT' using errcode = '23514';
    end if;
  end if;

  -- ── Commit the capacity. Every line, or the whole statement rolls back. ──
  update public.event_ticket_types tt
     set quantity_sold = tt.quantity_sold + w.qty
    from (select (t->>'ticket_type_id')::uuid as ticket_type_id, count(*)::int as qty
            from jsonb_array_elements(p_tickets) t group by 1) w
   where tt.id = w.ticket_type_id;

  -- ── The order that justifies the capacity, in the same transaction ───────
  insert into public.event_ticket_orders
    (event_id, buyer_id, status, total_pence, platform_fee_pence, tickets_count)
  values
    (p_event_id, p_buyer_id, 'pending', p_total_pence, p_platform_fee_pence, v_count)
  returning id into v_order_id;

  -- ── The seats themselves, in the caller's order so tokens pair by index ──
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

  return jsonb_build_object('order_id', v_order_id, 'ticket_ids', to_jsonb(v_ticket_ids));
end;
$$;

comment on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb) is
  'Reserves an entire ticket basket, creates the pending order and its ticket rows in ONE transaction. Either every line is reserved or none is, and capacity can never be held without an order that expire_stale_ticket_orders can later release. Locks ticket types in id order so concurrent overlapping baskets queue rather than deadlock. Raises SOLD_OUT (23514) when capacity is the reason.';

revoke all on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb) from public;
revoke all on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb) from anon;
revoke all on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb) from authenticated;
grant execute on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb) to service_role;

-- ── Give the seats back when a checkout aborts ──────────────────────────────
--
-- Replaces the four `delete the order and hope` paths. Same release semantics
-- as expire_stale_ticket_orders — count the pending tickets, hand that many
-- back, void them, cancel the order — so the two cannot drift. Idempotent: it
-- only acts on an order that is still 'pending', and the cancel happens in the
-- same transaction as the release, so a second call finds nothing to do.

create or replace function public.release_ticket_order(p_order_id uuid)
returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_released int := 0;
begin
  if p_order_id is null then return false; end if;

  -- Claim the order first. If it is not pending any more — paid, cancelled, or
  -- another caller got here — there is nothing to release.
  perform 1 from public.event_ticket_orders
   where id = p_order_id and status = 'pending'
     for update;
  if not found then return false; end if;

  update public.event_ticket_types tt
     set quantity_sold = greatest(0, tt.quantity_sold - f.qty)
    from (select t.ticket_type_id, count(*)::int as qty
            from public.event_tickets t
           where t.order_id = p_order_id and t.status = 'pending_payment'
           group by t.ticket_type_id) f
   where tt.id = f.ticket_type_id;
  get diagnostics v_released = row_count;

  update public.event_tickets
     set status = 'cancelled'
   where order_id = p_order_id and status = 'pending_payment';

  update public.event_ticket_orders
     set status = 'cancelled', cancelled_at = now()
   where id = p_order_id and status = 'pending';

  return true;
end;
$$;

comment on function public.release_ticket_order(uuid) is
  'Cancels a still-pending ticket order and returns its held capacity. Idempotent — only acts while the order is pending, and cancels it in the same transaction as the release, so it cannot double-decrement. Used by create-event-ticket-intent when a checkout aborts after reservation.';

revoke all on function public.release_ticket_order(uuid) from public;
revoke all on function public.release_ticket_order(uuid) from anon;
revoke all on function public.release_ticket_order(uuid) from authenticated;
grant execute on function public.release_ticket_order(uuid) to service_role;

-- ── Retire the single-line reservation ──────────────────────────────────────
-- reserve_ticket_basket is now the only caller path. reserve_ticket_slots is
-- kept rather than dropped so a rollback of this migration has something to
-- fall back to, but it loses its client grants: it is a bare capacity mutation
-- with no order behind it, and Step 1B's lesson was not to leave one of those
-- reachable merely because RLS happens to neutralise it today.

revoke all on function public.reserve_ticket_slots(uuid, integer) from public;
revoke all on function public.reserve_ticket_slots(uuid, integer) from anon;
revoke all on function public.reserve_ticket_slots(uuid, integer) from authenticated;
grant execute on function public.reserve_ticket_slots(uuid, integer) to service_role;

comment on function public.reserve_ticket_slots(uuid, integer) is
  'SUPERSEDED by reserve_ticket_basket. Reserves one ticket type in isolation, which is what allowed half a basket to be held for an order that was never created. Retained for rollback only; no caller should use it.';
