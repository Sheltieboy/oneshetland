-- Paygate 8 — membership refunds.
--
-- A membership refund already worked in Stripe and did nothing here: the
-- webhook's charge.refunded branch knows about wallet top-ups, deliveries and
-- event tickets, and nothing bound a refund to a membership. So the money went
-- back and the member kept their card, their access and their free-rejoin
-- entitlement.
--
-- Two product decisions shape this:
--   * Only a FULL cumulative refund revokes. A partial refund is recorded and
--     shown, and changes no entitlement at all.
--   * Only a OneShetland platform admin may execute a refund.
--
-- Entitlement is never adjusted by arithmetic on paid_until. It is REPLAYED
-- from the purchases that still stand, using the same period rule activation
-- uses, so the answer is a function of durable facts rather than of the order
-- refund webhooks happened to arrive in.

begin;

-- ── 1. Refund state on the durable purchase fact ────────────────────────────
-- The original purchase is never rewritten. face_pence, fee_pence,
-- total_pence, paid_until_before/after, payment_method, payment_intent_id and
-- occurred_at all stay exactly as they were. Refund is additional state.

alter table public.hub_membership_purchases
  add column if not exists refunded_pence integer not null default 0,
  add column if not exists refund_state   text    not null default 'none',
  add column if not exists refunded_at    timestamptz,
  -- The Connect transfer a WALLET membership created. A card purchase does not
  -- need this (Stripe reverses the transfer from the charge), but a wallet
  -- purchase has no charge, so without this the hub's payout cannot be found
  -- again at refund time.
  add column if not exists stripe_transfer_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hub_membership_purchases_refunded_pence_check') then
    alter table public.hub_membership_purchases
      add constraint hub_membership_purchases_refunded_pence_check check (refunded_pence >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hub_membership_purchases_refund_state_check') then
    alter table public.hub_membership_purchases
      add constraint hub_membership_purchases_refund_state_check
      check (refund_state in ('none', 'partial', 'full'));
  end if;
end $$;

comment on column public.hub_membership_purchases.refunded_pence is
  'Cumulative amount refunded, a high-water mark. Stripe reports amount_refunded as a running total, so this is greatest(existing, reported), never a sum.';
comment on column public.hub_membership_purchases.stripe_transfer_id is
  'Wallet purchases only: the Connect transfer paid to the hub, so a later refund can reverse it. Never exposed to clients.';

-- A platform admin has to be able to find a purchase in order to refund it.
-- Buyers and hub admins already could; this adds only the OneShetland admin.
drop policy if exists "membership purchases admin read" on public.hub_membership_purchases;
create policy "membership purchases admin read" on public.hub_membership_purchases
  for select to authenticated
  using (public.is_admin());

-- ── 2. Fulfilment records the wallet transfer ───────────────────────────────
-- Same function, one more optional argument. Dropped and recreated rather than
-- replaced because the signature changes; the default keeps any edge function
-- still running the previous build resolving during the deploy window.

drop function if exists public.activate_hub_membership(uuid, uuid, uuid, text, integer, text, integer);

create function public.activate_hub_membership(
  p_hub uuid, p_user uuid, p_type uuid, p_period text,
  p_payment_pence integer, p_pi text, p_fee_pence integer default null,
  p_transfer_id text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_existing   public.hub_members%rowtype;
  v_base       timestamptz;
  v_paid_until timestamptz;
  v_member_no  text;
  v_hub_name   text;
  v_tier_name  text;
  v_method     text;
begin
  select * into v_existing from public.hub_members
    where hub_id = p_hub and user_id = p_user
    for update;

  -- Idempotency guard: if this exact payment intent has already been applied
  -- to this membership, do nothing and return the current state. This stops a
  -- double-tap / concurrent retry from granting a second period.
  if p_pi is not null
     and v_existing.user_id is not null
     and v_existing.stripe_payment_intent_id is not distinct from p_pi then
    return jsonb_build_object(
      'member_no',  v_existing.member_no,
      'paid_until', v_existing.paid_until
    );
  end if;

  -- Expiry date
  if p_period = 'once' then
    v_paid_until := null;                                  -- lifetime
  else
    v_base := greatest(now(), coalesce(v_existing.paid_until, now()));
    v_paid_until := case p_period
      when 'year'  then v_base + interval '1 year'
      when 'month' then v_base + interval '1 month'
      else null
    end;
  end if;

  -- Member number: keep existing, else next sequential numeric for this hub.
  if v_existing.member_no is not null then
    v_member_no := v_existing.member_no;
  else
    select (coalesce(max(member_no::int), 0) + 1)::text
      into v_member_no
      from public.hub_members
      where hub_id = p_hub and member_no ~ '^[0-9]+$';
  end if;

  -- Fulfilment is authoritative over the member row. Mark the two statements
  -- that write it so tg_hub_members_guard stands aside: today only service_role
  -- may execute this function (so auth.uid() is already null), but that must
  -- not be the only thing keeping the money columns writable. The marker is
  -- cleared immediately afterwards so it can never cover an unrelated write
  -- later in the same transaction.
  perform set_config('app.fulfilment', 'on', true);

  insert into public.hub_members
    (hub_id, user_id, role, status, membership_type_id, paid_until, last_payment_pence, stripe_payment_intent_id, member_no)
  values
    (p_hub, p_user, 'member', 'active', p_type, v_paid_until, p_payment_pence, p_pi, v_member_no)
  on conflict (hub_id, user_id) do nothing;

  update public.hub_members set
    status                   = 'active',
    ended_at                 = null,
    membership_type_id       = p_type,
    paid_until               = v_paid_until,
    last_payment_pence       = p_payment_pence,
    stripe_payment_intent_id = p_pi,
    member_no                = coalesce(member_no, v_member_no)
  where hub_id = p_hub and user_id = p_user;

  perform set_config('app.fulfilment', 'off', true);

  -- The durable receipt. Names are snapshotted; a later rename or a deleted
  -- tier must not rewrite what the customer was shown at the time.
  select name into v_hub_name  from public.hubs             where id = p_hub;
  select name into v_tier_name from public.hub_membership_types where id = p_type;
  v_method := case when p_pi like 'wallet\_%' then 'wallet' else 'card' end;

  insert into public.hub_membership_purchases (
    hub_id, user_id, membership_type_id, hub_name, tier_name, period,
    face_pence, fee_pence, total_pence, payment_method, payment_intent_id,
    paid_until_before, paid_until_after, source, stripe_transfer_id
  ) values (
    p_hub, p_user, p_type,
    coalesce(v_hub_name, 'Hub'), coalesce(v_tier_name, 'Membership'), p_period,
    coalesce(p_payment_pence, 0), p_fee_pence,
    case when p_fee_pence is null then null else coalesce(p_payment_pence, 0) + p_fee_pence end,
    v_method, p_pi,
    v_existing.paid_until, v_paid_until, 'live', p_transfer_id
  )
  on conflict (payment_intent_id) where payment_intent_id is not null do nothing;

  return jsonb_build_object('member_no', v_member_no, 'paid_until', v_paid_until);
end;
$function$;

revoke all on function public.activate_hub_membership(uuid, uuid, uuid, text, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.activate_hub_membership(uuid, uuid, uuid, text, integer, text, integer, text) to service_role;

-- ── 3. Entitlement replay ───────────────────────────────────────────────────
-- What is this member still paid up until, given the purchases that STAND?
--
-- Not arithmetic on the current expiry. Subtracting "a year" because a year was
-- refunded is wrong whenever renewals overlapped: an early renewal's expiry
-- incorporates the paid time it was stacked on top of, so removing the OLDER
-- purchase must not leave the newer one ending where it did. Replaying is the
-- only method that gets both directions right, and it does not care what order
-- the refunds arrived in — it reads the flags as they are now.
--
-- The rule is deliberately the same one activation uses, with each purchase's
-- recorded occurred_at standing in for now().

create or replace function public.membership_entitlement(p_hub uuid, p_user uuid)
returns table (
  entitled       boolean,      -- is there paid time covering this moment?
  paid_until     timestamptz,  -- null with lifetime = true means never expires
  lifetime       boolean,
  last_face_pence integer,     -- what the surviving entitlement was last paid for
  purchases_left integer       -- purchases still standing (not fully refunded)
)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  r        record;
  v_run    timestamptz := null;
  v_life   boolean := false;
  v_count  integer := 0;
  v_face   integer := null;
begin
  for r in
    select * from public.hub_membership_purchases
     where hub_id = p_hub and user_id = p_user
       and refund_state <> 'full'
     order by occurred_at, created_at, id
  loop
    v_count := v_count + 1;
    v_face  := r.face_pence;
    if r.period = 'once' then
      v_life := true;                       -- a lifetime purchase that stands
    else
      v_run := greatest(r.occurred_at, coalesce(v_run, r.occurred_at))
               + case r.period when 'year' then interval '1 year'
                               when 'month' then interval '1 month'
                               else interval '0' end;
    end if;
  end loop;

  return query select
    case when v_life then true else coalesce(v_run > now(), false) end,
    case when v_life then null else v_run end,
    v_life,
    case when v_count = 0 then null else v_face end,
    v_count;
end;
$function$;

-- ── 4. Applying it to the membership ────────────────────────────────────────
-- The purchase ledger is the financial truth; hub_members carries the CURRENT
-- relationship. This is the one place the second is brought back into line with
-- the first.
--
-- last_payment_pence is set to 0 when nothing paid stands. That is not rewriting
-- history — the history is in hub_membership_purchases and is untouched — it is
-- the member row telling the truth about now, and it is what closes the free
-- rejoin: hub_rejoin and both clients read exactly that field to tell a lifetime
-- membership from a free one.

create or replace function public.apply_membership_entitlement(p_hub uuid, p_user uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_ent record;
  v_row public.hub_members%rowtype;
  v_new_status text;
begin
  select * into v_row from public.hub_members
   where hub_id = p_hub and user_id = p_user for update;
  if v_row.user_id is null then
    return jsonb_build_object('applied', false, 'reason', 'no_membership_row');
  end if;

  select * into v_ent from public.membership_entitlement(p_hub, p_user);

  -- A member who never bought anything is a free member. Refund replay has
  -- nothing to say about them and must not touch their row.
  if v_ent.purchases_left = 0 and coalesce(v_row.last_payment_pence, 0) = 0
     and v_row.paid_until is null then
    return jsonb_build_object('applied', false, 'reason', 'free_membership');
  end if;

  -- Active but no longer paid for: the hub's relationship with them has been
  -- ended by the refund, which is a removal, not a voluntary leave.
  v_new_status := v_row.status;
  if not v_ent.entitled and v_row.status = 'active' then
    v_new_status := 'removed';
  end if;

  perform set_config('app.fulfilment', 'on', true);
  update public.hub_members set
    paid_until         = v_ent.paid_until,
    last_payment_pence = coalesce(v_ent.last_face_pence, 0),
    status             = v_new_status,
    ended_at           = case when v_new_status in ('removed', 'left', 'rejected')
                              then coalesce(ended_at, now()) else ended_at end
  where hub_id = p_hub and user_id = p_user;
  perform set_config('app.fulfilment', 'off', true);

  return jsonb_build_object(
    'applied', true,
    'entitled', v_ent.entitled,
    'paid_until', v_ent.paid_until,
    'lifetime', v_ent.lifetime,
    'status', v_new_status,
    'purchases_left', v_ent.purchases_left
  );
end;
$function$;

-- ── 5. Recording a refund ───────────────────────────────────────────────────
-- The single entry point for BOTH the OneShetland admin flow and a refund
-- someone issued straight from the Stripe Dashboard, because both end at the
-- same charge.refunded webhook. Called twice for one refund, it settles to the
-- same place.
--
-- p_cumulative is Stripe's amount_refunded: a RUNNING TOTAL, not this refund's
-- slice. Taking greatest() of it is what makes a redelivered event, and a
-- partial followed by a larger one, converge to exactly one economic outcome.

create or replace function public.record_membership_refund(p_pi text, p_cumulative integer)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  p        public.hub_membership_purchases%rowtype;
  v_total  integer;
  v_new    integer;
  v_state  text;
  v_ent    jsonb;
begin
  if p_pi is null then
    return jsonb_build_object('matched', false, 'reason', 'no_payment_intent');
  end if;
  if p_cumulative is null or p_cumulative < 0 then
    raise exception 'record_membership_refund: cumulative amount must be non-negative'
      using errcode = '22023';
  end if;

  select * into p from public.hub_membership_purchases
   where payment_intent_id = p_pi for update;
  if not found then
    -- Not a membership payment. Deliveries, tickets, wallet top-ups and every
    -- other rail carry on untouched.
    return jsonb_build_object('matched', false, 'reason', 'not_a_membership');
  end if;

  -- A backfilled row records the face price but not the fee charged alongside
  -- it, because that fee was never written down anywhere. Falling back to
  -- face + fee keeps the comparison honest for every row that has both.
  v_total := coalesce(p.total_pence, p.face_pence + coalesce(p.fee_pence, 0));

  v_new   := least(greatest(p.refunded_pence, p_cumulative), v_total);
  v_state := case
               when v_new <= 0        then 'none'
               when v_new >= v_total  then 'full'
               else                        'partial'
             end;

  update public.hub_membership_purchases set
    refunded_pence = v_new,
    refund_state   = v_state,
    refunded_at    = case when v_new > 0 then coalesce(refunded_at, now()) else null end
  where id = p.id;

  -- Only a full refund touches entitlement. This is the product rule: money
  -- coming back is not by itself a reason to take a membership away.
  if v_state = 'full' then
    v_ent := public.apply_membership_entitlement(p.hub_id, p.user_id);
  end if;

  return jsonb_build_object(
    'matched', true,
    'purchase_id', p.id,
    'hub_id', p.hub_id,
    'user_id', p.user_id,
    'tier_name', p.tier_name,
    'hub_name', p.hub_name,
    'payment_method', p.payment_method,
    'total_pence', v_total,
    'refunded_pence', v_new,
    'refund_state', v_state,
    'changed', v_new <> p.refunded_pence,
    'entitlement', v_ent
  );
end;
$function$;

revoke all on function public.membership_entitlement(uuid, uuid)        from public, anon, authenticated;
revoke all on function public.apply_membership_entitlement(uuid, uuid)  from public, anon, authenticated;
revoke all on function public.record_membership_refund(text, integer)   from public, anon, authenticated;
grant execute on function public.membership_entitlement(uuid, uuid)       to service_role;
grant execute on function public.apply_membership_entitlement(uuid, uuid) to service_role;
grant execute on function public.record_membership_refund(text, integer)  to service_role;

-- ── 6. Rejoining cannot use refunded time ───────────────────────────────────
-- hub_rejoin decided a free restore from hub_members alone. After a full
-- refund apply_membership_entitlement brings that row back into line, so the
-- old test would already give the right answer — but the row is a cache and
-- the ledger is the truth, so the entitlement is asked for directly.
--
-- The old row-based test survives only as a fallback for a membership with no
-- purchase rows at all: memberships paid for before the ledger existed must
-- not be refused a rejoin they are entitled to.

create or replace function public.hub_rejoin(p_hub uuid, p_type uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_row      public.hub_members%rowtype;
  v_ent      record;
  v_paid_ok  boolean;
  v_open     boolean;
  v_free     boolean;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into v_row from public.hub_members
    where hub_id = p_hub and user_id = auth.uid() for update;

  if v_row.user_id is null then
    return jsonb_build_object('rejoined', false, 'reason', 'no_previous_membership');
  end if;
  if v_row.status = 'active' then
    return jsonb_build_object('rejoined', true, 'reason', 'already_active',
                              'paid_until', v_row.paid_until, 'charged', false);
  end if;
  if v_row.status = 'removed' then
    return jsonb_build_object('rejoined', false, 'reason', 'not_permitted');
  end if;
  if v_row.status = 'pending' then
    return jsonb_build_object('rejoined', false, 'reason', 'awaiting_approval');
  end if;

  select * into v_ent from public.membership_entitlement(p_hub, auth.uid());
  if v_ent.purchases_left > 0 then
    v_paid_ok := v_ent.entitled;
  else
    -- No purchase rows: fall back to what the membership row itself says.
    v_paid_ok := coalesce(v_row.paid_until > now(), false)
                 or (v_row.paid_until is null and coalesce(v_row.last_payment_pence, 0) > 0);
  end if;

  select (h.join_mode = 'open') into v_open from public.hubs h where h.id = p_hub;

  -- Paid time still running: same tier, same expiry, nothing to pay. Only for
  -- someone who left of their own accord — a declined request never had any.
  if v_row.status = 'left' and v_paid_ok and (p_type is null or p_type = v_row.membership_type_id) then
    update public.hub_members
       set status = 'active', ended_at = null
     where id = v_row.id;
    return jsonb_build_object('rejoined', true, 'reason', 'paid_time_remaining',
                              'paid_until', v_row.paid_until, 'charged', false);
  end if;

  -- Otherwise only a free tier gets back in without paying: straight in where
  -- the hub is open, back into the queue where it approves people.
  select coalesce(t.price_pence, -1) = 0 into v_free
    from public.hub_membership_types t
    where t.id = coalesce(p_type, v_row.membership_type_id) and t.hub_id = p_hub;

  if coalesce(v_free, p_type is null and v_row.membership_type_id is null) then
    update public.hub_members
       set status             = case when coalesce(v_open, false) then 'active' else 'pending' end,
           membership_type_id = coalesce(p_type, membership_type_id),
           ended_at           = case when coalesce(v_open, false) then null else ended_at end
     where id = v_row.id;
    return jsonb_build_object(
      'rejoined', coalesce(v_open, false),
      'reason', case when coalesce(v_open, false) then 'free_tier' else 'awaiting_approval' end,
      'charged', false);
  end if;

  return jsonb_build_object('rejoined', false, 'reason', 'payment_required');
end;
$function$;

revoke all on function public.hub_rejoin(uuid, uuid) from public, anon;
grant execute on function public.hub_rejoin(uuid, uuid) to authenticated, service_role;

commit;
