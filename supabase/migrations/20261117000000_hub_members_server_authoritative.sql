-- ═══════════════════════════════════════════════════════════════════════════
-- hub_members: a person may join FREE; paid time and tier are written by the server
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
--
-- The UPDATE side of hub_members was guarded (tg_hub_members_guard locks the money columns, member_no and role, lets a member
-- change tier only to a free one, and stops a pending request approving itself). The INSERT side was not:
--
--     CREATE POLICY "hub_members join" ON public.hub_members FOR INSERT
--       WITH CHECK ((user_id = auth.uid()) AND (role = 'member'));
--
-- and the only BEFORE INSERT trigger (tg_hub_member_join_status) sets `status` and nothing else. So a signed-in user could
-- write, as their OWN membership row, any membership_type_id (a paid tier), paid_until, last_payment_pence,
-- stripe_payment_intent_id and member_no, without paying:
--
--   · a paid tier with paid_until NULL reads as a LIFETIME membership (is_hub_member treats NULL as "no expiry"), and the
--     app/website decide "paid, lifetime" from last_payment_pence > 0 — all of it supplied by the joiner;
--   · analytics_revenue sums hub_members.last_payment_pence, so forged rows inflate a hub's reported revenue;
--   · the DELETE policy refuses to remove a row that carries money fields, so a forged row cannot be removed by its owner;
--   · member_no is a per-hub number: a forged '99999999999' makes `max(member_no::int)` in activate_hub_membership overflow,
--     which would make EVERY later paid join to that hub fail after the buyer had paid.
--
-- The UPDATE policy also has no WITH CHECK and the guard never looked at hub_id or user_id, so a member could re-point their own
-- row at another hub (keeping status 'active', skipping that hub's approval) or at another person.
--
-- Nothing legitimate needs any of this. Paid and privileged state is written only by activate_hub_membership (service_role,
-- after a confirmed payment), apply_membership_entitlement (refund replay) and the hub_rejoin / hub_leave definer functions.
-- Both clients' "free join" inserts exactly { hub_id, user_id, role: 'member', membership_type_id } — a free tier or NULL.
--
-- WHAT THIS DOES — and nothing else
--
--   1. BEFORE INSERT guard (tg_hub_members_insert_guard). For a DIRECT client write only (tg_is_server_write(), the same test the
--      product-order and event-order locks use), it refuses: a membership for anyone but the caller, any role but 'member', any
--      payment / entitlement field (paid_until, last_payment_pence, stripe_payment_intent_id, member_no, ended_at), a tier that is
--      not a FREE tier of THIS hub, and a hub that is not active. joined_at is stamped by the server. service_role,
--      activate_hub_membership and the hub-owner trigger are untouched (they are not direct client writes).
--   2. BEFORE UPDATE identity lock (tg_hub_members_identity_lock). A direct client write may not change id, hub_id or user_id, and
--      cannot rewrite joined_at. Everything else about UPDATE stays exactly as tg_hub_members_guard already governs it.
--   3. anon loses INSERT / UPDATE / DELETE / REFERENCES / TRIGGER on hub_members. (SELECT stays: removing it would turn an empty
--      result on any public page that embeds this table into a 42501 error.)
--
-- NOT TOUCHED: the policies, tg_hub_members_guard, activate_hub_membership, hub_rejoin, hub_leave, payments, any row, any
-- other table. A hub owner or committee member can still approve, reject and re-tier their own members through the existing
-- UPDATE path (comping a tier is a hub decision, not a payment), and a member can still leave and, for a free tier, rejoin.
--
-- THE MIGRATION PROVES ITSELF: it aborts (and rolls back) if the triggers are missing or anon can still write the table.

begin;

set local lock_timeout = '5s';

-- 1. one read-only fact the guard needs, answered with the definer's rights ────────
-- (hubs and hub_membership_types are RLS-filtered for the caller; "is this tier free, is this hub open" must not depend on
-- whether the joiner happens to be allowed to SEE a hidden hub's tiers.)
create or replace function public.hub_free_join_problem(p_hub uuid, p_type uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when not exists (select 1 from public.hubs h where h.id = p_hub and h.is_active) then 'hub_unavailable'
    when p_type is not null and not exists (
           select 1 from public.hub_membership_types t
            where t.id = p_type and t.hub_id = p_hub and t.price_pence = 0) then 'paid_tier'
  end;
$$;

revoke all on function public.hub_free_join_problem(uuid, uuid) from public, anon;
grant execute on function public.hub_free_join_problem(uuid, uuid) to authenticated, service_role;

-- 2. INSERT guard ────────────────────────────────────────────────────────────────
create or replace function public.tg_hub_members_insert_guard()
returns trigger
language plpgsql
-- SECURITY INVOKER on purpose: current_user must stay the role that is actually writing (see tg_is_server_write()).
set search_path to 'public'
as $$
declare
  v_problem text;
begin
  -- service_role, SECURITY DEFINER functions (activate_hub_membership, the hub-owner trigger) and migrations are not direct
  -- client writes.
  if public.tg_is_server_write() then return new; end if;

  if new.user_id is distinct from auth.uid() then
    raise exception 'you can only join a hub as yourself' using errcode = '42501';
  end if;
  if new.role is distinct from 'member' then
    raise exception 'new members join as members' using errcode = '42501';
  end if;
  if new.paid_until is not null or new.last_payment_pence is not null
     or new.stripe_payment_intent_id is not null or new.member_no is not null or new.ended_at is not null then
    raise exception 'payment and membership-number fields are set by the server' using errcode = '42501';
  end if;

  v_problem := public.hub_free_join_problem(new.hub_id, new.membership_type_id);
  if v_problem = 'paid_tier' then
    raise exception 'a paid membership has to be bought, not chosen' using errcode = '42501';
  elsif v_problem is not null then
    raise exception 'this hub is not open to new members' using errcode = '42501';
  end if;

  new.joined_at := now();
  return new;
end;
$$;

comment on function public.tg_hub_members_insert_guard() is
  'Direct client INSERTs into hub_members may create only the caller''s own plain member row on a FREE tier (or none), with no payment or entitlement field. Paid membership is written by activate_hub_membership after a confirmed payment.';

drop trigger if exists trg_hub_members_insert_guard on public.hub_members;
create trigger trg_hub_members_insert_guard
  before insert on public.hub_members
  for each row execute function public.tg_hub_members_insert_guard();

-- 3. UPDATE identity lock ───────────────────────────────────────────────────────────
create or replace function public.tg_hub_members_identity_lock()
returns trigger
language plpgsql
-- SECURITY INVOKER on purpose, as above.
set search_path to 'public'
as $$
begin
  if public.tg_is_server_write() then return new; end if;

  if new.id is distinct from old.id or new.hub_id is distinct from old.hub_id or new.user_id is distinct from old.user_id then
    raise exception 'a membership cannot be moved to another hub or another person' using errcode = '42501';
  end if;
  new.joined_at := old.joined_at;
  return new;
end;
$$;

comment on function public.tg_hub_members_identity_lock() is
  'Direct client UPDATEs of hub_members cannot change id, hub_id, user_id or joined_at. Everything else is governed by tg_hub_members_guard.';

drop trigger if exists trg_hub_members_identity_lock on public.hub_members;
create trigger trg_hub_members_identity_lock
  before update on public.hub_members
  for each row execute function public.tg_hub_members_identity_lock();

-- 4. anon never writes memberships ────────────────────────────────────────────────
revoke insert, update, delete, references, trigger on table public.hub_members from anon;

-- 5. self-check: refuse to commit if the protection is not actually in place ────────
do $check$
declare
  v_priv text;
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.hub_members'::regclass
                  and tgname = 'trg_hub_members_insert_guard' and tgenabled = 'O') then
    raise exception 'hub_members: the INSERT guard is missing or disabled';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.hub_members'::regclass
                  and tgname = 'trg_hub_members_identity_lock' and tgenabled = 'O') then
    raise exception 'hub_members: the identity lock is missing or disabled';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.hub_members'::regclass
                  and tgname = 'trg_hub_members_guard' and tgenabled = 'O') then
    raise exception 'hub_members: the existing UPDATE guard is missing or disabled';
  end if;
  foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('anon', 'public.hub_members', v_priv) then
      raise exception 'hub_members: anon still holds %', v_priv;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.hub_members'::regclass) then
    raise exception 'hub_members: RLS is not enabled';
  end if;
end
$check$;

commit;
