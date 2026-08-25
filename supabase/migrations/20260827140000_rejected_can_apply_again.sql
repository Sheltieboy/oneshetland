-- A declined join request is not a ban.
--
-- The old web joinHub deleted any 'left' or 'rejected' row and inserted a fresh
-- one, so someone whose request had been declined could simply ask again. Now
-- that the row survives, hub_rejoin has to offer that same second chance
-- explicitly, or declining a request would silently become permanent.
--
-- 'removed' is deliberately NOT included. No code path produces it yet, and
-- when one does, an admin ending someone's membership should not be undone by
-- that person re-applying — that needs its own decision, not this default.

begin;

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
  if v_row.status = 'removed' then
    return jsonb_build_object('rejoined', false, 'reason', 'not_permitted');
  end if;
  if v_row.status = 'pending' then
    return jsonb_build_object('rejoined', false, 'reason', 'awaiting_approval');
  end if;

  v_paid_ok := coalesce(v_row.paid_until > now(), false)
               or (v_row.paid_until is null and coalesce(v_row.last_payment_pence, 0) > 0);
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

-- The guard has to permit the transitions hub_rejoin makes on the caller's
-- own row: asking again after being declined, and walking back into an open
-- hub they had left or been declined by.
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
      null;                      -- an admin acting on their own row
    elsif new.status = 'active' then
      -- Getting back in without an admin saying so: allowed while the paid
      -- time they already bought is still running, or where anyone may walk
      -- into the hub anyway. A pending request cannot approve itself and a
      -- removed member cannot reinstate themselves.
      if not ((old.status = 'left' and coalesce(v_paid_ok, false))
              or (old.status in ('left', 'rejected') and coalesce(v_open, false))) then
        new.status := old.status;
      end if;
    elsif new.status = 'left' then
      null;                      -- anyone may leave at any time
    elsif new.status = 'pending' and old.status in ('left', 'rejected') then
      null;                      -- asking to join again raises a fresh request
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

commit;
