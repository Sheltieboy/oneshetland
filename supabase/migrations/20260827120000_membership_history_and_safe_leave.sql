-- Paygate 8 — durable membership purchase history + safe leave / rejoin.
--
-- Two defects, one cause.
--
-- (1) Leaving a hub ran a hard DELETE on hub_members. That row is the ONLY
--     place a paid membership lived: paid_until, last_payment_pence and
--     stripe_payment_intent_id are all columns on it. So "Leave hub" destroyed
--     the customer's receipt, their remaining paid time, AND the idempotency
--     key that stops a replayed webhook granting a second period.
--
-- (2) There was no financial record of a membership purchase anywhere else.
--     hub_members only ever holds the LAST payment, so a renewal overwrote the
--     previous one and a leave erased every trace.
--
-- This migration adds the missing durable fact (hub_membership_purchases),
-- turns leaving into a status transition, and lets a member who still has paid
-- time restore that exact membership for nothing.

begin;

-- ── 1. The durable financial fact ───────────────────────────────────────────
-- One row per completed membership payment. Never updated, never deleted by a
-- client. Hub/tier names are snapshotted so history survives a renamed hub or
-- a deleted tier, exactly as hub_donations does.

create table if not exists public.hub_membership_purchases (
  id                  uuid primary key default gen_random_uuid(),
  hub_id              uuid references public.hubs(id) on delete set null,
  user_id             uuid references auth.users(id) on delete set null,
  membership_type_id  uuid references public.hub_membership_types(id) on delete set null,
  hub_name            text        not null,
  tier_name           text        not null,
  period              text        not null,
  face_pence          integer     not null check (face_pence >= 0),
  fee_pence           integer              check (fee_pence  >= 0),
  total_pence         integer              check (total_pence >= 0),
  payment_method      text        not null default 'card'
                                  check (payment_method in ('card', 'wallet', 'unknown')),
  payment_intent_id   text,
  paid_until_before   timestamptz,
  paid_until_after    timestamptz,
  -- 'live'     — written by activate_hub_membership at fulfilment time.
  -- 'backfill' — reconstructed from the surviving hub_members row. The payment
  --              is real (it carries the Stripe payment intent id) but the fee
  --              and the exact instant are not known, so they are left null.
  source              text        not null default 'live'
                                  check (source in ('live', 'backfill')),
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

comment on table public.hub_membership_purchases is
  'Completed hub membership payments. Survives leaving, renewing and tier deletion.';

-- Exactly-once: a replayed webhook cannot write a second receipt.
create unique index if not exists uq_hub_membership_purchases_pi
  on public.hub_membership_purchases (payment_intent_id)
  where payment_intent_id is not null;

create index if not exists idx_hub_membership_purchases_user
  on public.hub_membership_purchases (user_id, occurred_at desc);
create index if not exists idx_hub_membership_purchases_hub
  on public.hub_membership_purchases (hub_id, occurred_at desc);

alter table public.hub_membership_purchases enable row level security;

-- Readable by the buyer and by the hub's admins. No client may write: every
-- row comes from activate_hub_membership, which is SECURITY DEFINER.
drop policy if exists "membership purchases read" on public.hub_membership_purchases;
create policy "membership purchases read" on public.hub_membership_purchases
  for select to authenticated
  using (user_id = auth.uid() or public.is_hub_admin(hub_id, auth.uid()));

grant select on public.hub_membership_purchases to authenticated;
grant all    on public.hub_membership_purchases to service_role;

-- ── 2. Membership can end without being erased ──────────────────────────────

alter table public.hub_members add column if not exists ended_at timestamptz;
comment on column public.hub_members.ended_at is
  'When the membership stopped being active. Set for status left/removed/rejected.';

-- 'left'    — the member chose to leave.
-- 'removed' — a hub admin ended it.
-- 'rejected'— a join request was refused (pre-existing meaning, unchanged).
alter table public.hub_members drop constraint if exists hub_members_status_check;
alter table public.hub_members add constraint hub_members_status_check
  check (status in ('pending', 'active', 'rejected', 'left', 'removed'));

-- ── 3. Fulfilment writes the receipt ────────────────────────────────────────
-- Same single choke point every payment path already funnels through
-- (confirm-hub-membership, wallet-checkout, the webhook's fulfilHubMembership),
-- so the receipt is written under the same row lock and the same idempotency
-- guard as the entitlement itself. Gains p_fee_pence so the fee actually
-- charged is recorded rather than re-derived from today's config later.
--
-- The old 6-argument version is dropped and recreated with a default so that
-- edge functions still running the previous build keep resolving during the
-- deploy window.

drop function if exists public.activate_hub_membership(uuid, uuid, uuid, text, integer, text);

create function public.activate_hub_membership(
  p_hub uuid, p_user uuid, p_type uuid, p_period text,
  p_payment_pence integer, p_pi text, p_fee_pence integer default null
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

  -- Create the row if new (status set by the join trigger here), then force the
  -- final paid state in a follow-up UPDATE the trigger can't touch. Paying also
  -- ends any 'left' state: buying a membership rejoins the hub.
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
    paid_until_before, paid_until_after, source
  ) values (
    p_hub, p_user, p_type,
    coalesce(v_hub_name, 'Hub'), coalesce(v_tier_name, 'Membership'), p_period,
    coalesce(p_payment_pence, 0), p_fee_pence,
    case when p_fee_pence is null then null else coalesce(p_payment_pence, 0) + p_fee_pence end,
    v_method, p_pi,
    v_existing.paid_until, v_paid_until, 'live'
  )
  on conflict (payment_intent_id) where payment_intent_id is not null do nothing;

  return jsonb_build_object('member_no', v_member_no, 'paid_until', v_paid_until);
end;
$function$;

revoke all on function public.activate_hub_membership(uuid, uuid, uuid, text, integer, text, integer) from public, anon, authenticated;
grant execute on function public.activate_hub_membership(uuid, uuid, uuid, text, integer, text, integer) to service_role;

-- ── 4. The guard: what a member may do to their own row ─────────────────────
-- Previously this trigger stopped self-promotion and self-approval but left the
-- financial columns wide open: the UPDATE policy is
-- (is_hub_admin OR user_id = auth.uid()) with no WITH CHECK, so a member could
-- have set their own paid_until to 2099 and held a free membership for life.
-- It also had no notion of leaving or rejoining.

create or replace function public.tg_hub_members_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_is_owner    boolean;
  v_is_admin    boolean;
  v_is_platform boolean;
  v_paid_ok     boolean;
  v_open        boolean;
  v_type_free   boolean;
begin
  -- Service role / server context: no user JWT → trust it.
  if auth.uid() is null then
    return new;
  end if;

  -- Inside activate_hub_membership. Transaction-local, set only by that
  -- SECURITY DEFINER function, which no client role may execute.
  if coalesce(current_setting('app.fulfilment', true), '') = 'on' then
    return new;
  end if;

  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    into v_is_platform;
  if v_is_platform then
    return new;
  end if;

  select coalesce(bool_or(h.owner_id = auth.uid()), false) into v_is_owner
    from public.hubs h where h.id = new.hub_id;
  v_is_admin := public.is_hub_admin(new.hub_id, auth.uid());

  -- Role changes are owner-only.
  if new.role is distinct from old.role and not v_is_owner then
    new.role := old.role;
  end if;

  -- Money is written by fulfilment only. No JWT holder — not the member, not
  -- even a hub admin — may edit what was paid or until when.
  new.paid_until               := old.paid_until;
  new.last_payment_pence       := old.last_payment_pence;
  new.stripe_payment_intent_id := old.stripe_payment_intent_id;
  new.member_no                := old.member_no;

  -- A member may change their own tier only to a free one in the same hub;
  -- a paid tier has to be bought. Admins may re-tier a member.
  if new.membership_type_id is distinct from old.membership_type_id and not v_is_admin then
    select coalesce(t.price_pence, -1) = 0 into v_type_free
      from public.hub_membership_types t
      where t.id = new.membership_type_id and t.hub_id = new.hub_id;
    if not coalesce(v_type_free, false) then
      new.membership_type_id := old.membership_type_id;
    end if;
  end if;

  if new.status is distinct from old.status then
    -- Does this member still hold paid time? Lifetime memberships carry a null
    -- paid_until, so they are told apart from free ones by having paid.
    v_paid_ok := (old.paid_until > now())
                 or (old.paid_until is null and coalesce(old.last_payment_pence, 0) > 0);
    select (h.join_mode = 'open') into v_open from public.hubs h where h.id = new.hub_id;

    if v_is_admin and new.user_id <> auth.uid() then
      -- Admins approve, refuse and remove other people. Ending someone else's
      -- membership is a removal, never a voluntary leave.
      if new.status = 'left' then new.status := 'removed'; end if;
    elsif v_is_admin then
      null;                      -- an admin acting on their own row: as below
    elsif new.status = 'active' then
      -- Self-restore after leaving: allowed while the paid time they already
      -- bought is still running, or where anyone may walk into the hub anyway.
      -- Anything else (a pending request self-approving, a removed member
      -- reinstating themselves) is refused.
      if not (old.status = 'left' and (coalesce(v_paid_ok, false) or coalesce(v_open, false))) then
        new.status := old.status;
      end if;
    elsif new.status = 'left' then
      null;                      -- anyone may leave at any time
    elsif new.status = 'pending' and old.status = 'left' then
      null;                      -- rejoining an approval hub raises a fresh request
    else
      -- A member cannot mark themselves removed or rejected, and cannot send
      -- themselves back to pending from an active membership.
      new.status := old.status;
    end if;
  end if;

  -- Keep the end date honest whichever path set the status.
  if new.status in ('left', 'removed', 'rejected') and new.status is distinct from old.status then
    new.ended_at := now();
  elsif new.status = 'active' then
    new.ended_at := null;
  end if;

  return new;
end;
$function$;

-- ── 5. A paid membership row can no longer be deleted by a client ───────────
-- Belt and braces behind the RPCs below: even a hand-crafted PostgREST DELETE
-- cannot remove a row that carries a payment.

drop policy if exists "hub_members delete" on public.hub_members;
create policy "hub_members delete" on public.hub_members
  for delete to authenticated
  using (
    (public.is_hub_admin(hub_id, auth.uid()) or user_id = auth.uid())
    and paid_until is null
    and last_payment_pence is null
    and stripe_payment_intent_id is null
  );

-- ── 6. Leaving ──────────────────────────────────────────────────────────────
-- Ends the membership without erasing it. Paid time, member number, tier and
-- the Stripe payment intent all stay on the row, so the receipt survives and a
-- replayed webhook still recognises a payment it has already applied.

create or replace function public.hub_leave(p_hub uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_row public.hub_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into v_row from public.hub_members
    where hub_id = p_hub and user_id = auth.uid() for update;

  if v_row.user_id is null then
    return jsonb_build_object('left', false, 'reason', 'not_a_member');
  end if;

  update public.hub_members
     set status = 'left', ended_at = now()
   where id = v_row.id;

  return jsonb_build_object(
    'left', true,
    -- What they can come back to for nothing, if anything.
    'paid_until', v_row.paid_until,
    'retains_paid_time',
      coalesce(v_row.paid_until > now(), false)
      or (v_row.paid_until is null and coalesce(v_row.last_payment_pence, 0) > 0)
  );
end;
$function$;

-- ── 7. Coming back ──────────────────────────────────────────────────────────
-- Restores a membership the member left. Paid time they already bought is
-- honoured to its original expiry — no new payment intent, no wallet debit and
-- no extension of the period. Once that time has run out, or for a paid tier
-- they never bought, this refuses and the normal checkout has to run.

create or replace function public.hub_rejoin(p_hub uuid, p_type uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_row      public.hub_members%rowtype;
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
  if v_row.status in ('removed', 'rejected') then
    return jsonb_build_object('rejoined', false, 'reason', 'not_permitted');
  end if;
  if v_row.status = 'pending' then
    return jsonb_build_object('rejoined', false, 'reason', 'awaiting_approval');
  end if;

  v_paid_ok := coalesce(v_row.paid_until > now(), false)
               or (v_row.paid_until is null and coalesce(v_row.last_payment_pence, 0) > 0);
  select (h.join_mode = 'open') into v_open from public.hubs h where h.id = p_hub;

  -- Paid time still running: same tier, same expiry, nothing to pay.
  if v_paid_ok and (p_type is null or p_type = v_row.membership_type_id) then
    update public.hub_members
       set status = 'active', ended_at = null
     where id = v_row.id;
    return jsonb_build_object('rejoined', true, 'reason', 'paid_time_remaining',
                              'paid_until', v_row.paid_until, 'charged', false);
  end if;

  -- Otherwise only a free tier can be rejoined without paying.
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

revoke all on function public.hub_leave(uuid)         from public, anon;
revoke all on function public.hub_rejoin(uuid, uuid)  from public, anon;
grant execute on function public.hub_leave(uuid)        to authenticated, service_role;
grant execute on function public.hub_rejoin(uuid, uuid) to authenticated, service_role;

-- ── 8. Backfill ─────────────────────────────────────────────────────────────
-- Only from rows that carry their own proof. A hub_members row holding a
-- Stripe payment intent id and an amount IS the receipt for that payment, so
-- it can be restated as one. Everything not evidenced is left null rather than
-- guessed: the fee charged at the time is not recorded anywhere, and the exact
-- instant is only inferable where paid_until is exactly one period after
-- joined_at. Nothing is invented for memberships whose row was already deleted
-- — those payments exist only in Stripe and are reported, not fabricated.

insert into public.hub_membership_purchases (
  hub_id, user_id, membership_type_id, hub_name, tier_name, period,
  face_pence, fee_pence, total_pence, payment_method, payment_intent_id,
  paid_until_before, paid_until_after, source, occurred_at
)
select
  m.hub_id, m.user_id, m.membership_type_id,
  coalesce(h.name, 'Hub'), coalesce(t.name, 'Membership'), coalesce(t.period, 'year'),
  m.last_payment_pence, null, null,
  case when m.stripe_payment_intent_id like 'wallet\_%' then 'wallet' else 'card' end,
  m.stripe_payment_intent_id,
  null, m.paid_until, 'backfill', m.joined_at
from public.hub_members m
left join public.hubs                 h on h.id = m.hub_id
left join public.hub_membership_types t on t.id = m.membership_type_id
where m.stripe_payment_intent_id is not null
  and m.last_payment_pence is not null
on conflict (payment_intent_id) where payment_intent_id is not null do nothing;

commit;
