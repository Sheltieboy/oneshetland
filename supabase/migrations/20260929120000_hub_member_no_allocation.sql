-- ============================================================================
-- Two people join a hub at the same moment and both become member 1.
--
-- WHAT IS WRONG
--
-- activate_hub_membership allocates a member number with
--
--     select coalesce(max(member_no::int), 0) + 1 from public.hub_members
--      where hub_id = p_hub and member_no ~ '^[0-9]+$';
--
-- The `select ... for update` earlier in the function locks the CALLER'S OWN
-- member row. A first-time joiner does not have one, so it locks nothing, and
-- the aggregate above takes no lock at all. Two concurrent first-time
-- activations for different users in the same hub read the same max and are
-- issued the same number. Reproduced in an isolated PostgreSQL 17 cluster
-- against this exact function: two members, both numbered 1.
--
-- Nobody's money or access is wrong. But a committee handing two people
-- "Member 41" notices, and a membership number is the one thing a club expects
-- to be able to trust.
--
-- THE FIX, IN TWO PARTS
--
-- 1. An advisory lock keyed on the hub, taken only when a number is being
--    allocated. Competing joiners queue, and each reads a max that includes the
--    one before it. Both still succeed — which a unique constraint ALONE would
--    not have given: the loser would have failed its activation after a
--    payment had already been taken.
--
-- 2. A partial unique index, as the hard backstop. The lock is the correctness;
--    the index is the guarantee that survives some future code path allocating
--    without it. Verified read-only against production first: 0 duplicate
--    (hub_id, member_no) pairs across 14 member rows, 3 of which carry a
--    number, all numeric — so it can be created without renumbering anything.
--
-- WHAT IS DELIBERATELY UNCHANGED
--
-- Existing numbers are never renumbered. A renewal, a leave and a rejoin all
-- keep the number the member already has: the `if v_existing.member_no is not
-- null` branch is untouched. Nothing nulls a member_no anywhere in the schema,
-- so a refunded or ended membership does not release its number for reuse.
-- Different hubs allocate independently and may both have a member 1.
-- ============================================================================

begin;

-- Part 1: allocation serialised per hub. Body otherwise identical to
-- 20260828120000 — only the lock is added.
create or replace function public.activate_hub_membership(
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
    -- Serialise allocation for THIS hub. The `for update` above locks the
    -- caller's own member row, and a first-time joiner has none, so it locked
    -- nothing; the aggregate below then took no lock either. Two people joining
    -- the same hub at the same moment both read the same max and both became
    -- member 1. Keyed on the hub, because that is the scope the number is
    -- unique within. Released at commit.
    perform pg_advisory_xact_lock(hashtextextended('hub_member_no:' || p_hub::text, 0));

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

-- Part 2: the hard backstop. Partial, because member_no is null for members who
-- never received one (pending requests, and free joins before numbering).
create unique index if not exists uq_hub_members_hub_member_no
  on public.hub_members (hub_id, member_no)
  where member_no is not null;

comment on index public.uq_hub_members_hub_member_no is
  'A member number is unique within its hub. Allocation is serialised by an advisory lock in activate_hub_membership; this index is the guarantee that holds even if something else ever allocates one.';

-- Grants unchanged: service_role only, as before.
revoke all on function public.activate_hub_membership(uuid, uuid, uuid, text, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.activate_hub_membership(uuid, uuid, uuid, text, integer, text, integer, text) to service_role;

commit;
