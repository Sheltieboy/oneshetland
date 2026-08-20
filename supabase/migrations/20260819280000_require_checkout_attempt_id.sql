-- ============================================================================
-- The checkout attempt id stops being optional.
--
-- 20260819260000 added it and deliberately left it nullable, because the live
-- website did not send it yet and a mandatory server contract would have broken
-- the deployed bundle. That rollout is finished: oneshetland.com now ships a
-- build whose ticket call carries client_request_id, verified by reading the
-- live JavaScript rather than the repository. The mobile app is unpublished and
-- will ship with it from its first build. There is therefore no legitimate
-- client left that needs the optional path.
--
-- WHAT CHANGES
-- The parameter loses its default and the function refuses a null or blank one.
-- Both directions fail closed:
--
--   caller omits the argument   → PostgREST finds no matching signature
--   caller passes null/blank    → the function raises before anything is read
--
-- WHAT DOES NOT CHANGE
-- No table-wide NOT NULL on event_ticket_orders.client_request_id. The 24
-- historical orders predate the column and cannot satisfy it; adding the
-- constraint would fail, and backfilling invented ids onto real past purchases
-- would be worse than leaving them honestly null. The invariant that matters is
-- about NEW orders, and the only path that creates one is this function — so
-- this function is where the invariant belongs.
--
-- The partial unique index from 20260819260000 stays partial for the same
-- reason: the historical nulls must not collide with each other.
-- ============================================================================

-- CREATE OR REPLACE cannot remove a parameter default (42P13), so the old
-- signature is dropped first. That discards its ACL, which is why the grants
-- are restated at the bottom rather than assumed — and why this whole migration
-- runs in one transaction, so a caller blocks rather than finding no function.
drop function if exists public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb, text);

create function public.reserve_ticket_basket(
  p_event_id           uuid,
  p_buyer_id           uuid,
  p_tickets            jsonb,
  p_total_pence        integer,
  p_platform_fee_pence integer,
  p_snapshot           jsonb,
  p_client_request_id  text                       -- no default: it is required
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
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
$$;

comment on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb, text) is
  'Reserves a ticket basket, creates the pending order and its ticket rows in ONE transaction, exactly once per client_request_id — which is now REQUIRED. A retry returns the original order and reserves nothing; a concurrent duplicate loses the claim before any counter moves. Raises IDEMPOTENCY_CONFLICT for a reused id with different contents, CHECKOUT_EXPIRED for a cancelled order, SOLD_OUT when capacity is the reason.';

-- CREATE OR REPLACE keeps the existing ACL, but Steps 1 and 1B were both caused
-- by a grant nobody re-checked, so state it rather than assume it.
revoke all on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb, text) from public;
revoke all on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb, text) from anon;
revoke all on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb, text) from authenticated;
grant execute on function public.reserve_ticket_basket(uuid, uuid, jsonb, integer, integer, jsonb, text) to service_role;
