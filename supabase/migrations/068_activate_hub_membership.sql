-- 068_activate_hub_membership.sql
-- Atomically activate (or renew) a paid hub membership after payment.
--
-- Called by the confirm-hub-membership edge function (service role). Handles:
--   • member number assignment (sequential per hub, kept across renewals)
--   • expiry: 'year'/'month' extend from the later of now / current expiry;
--     'once' = lifetime (no expiry)
--   • forcing status='active' even in approval-mode hubs (payment IS approval) —
--     done via a follow-up UPDATE so the BEFORE-INSERT join-status trigger can't
--     downgrade a paying member to 'pending'.

create or replace function public.activate_hub_membership(
  p_hub           uuid,
  p_user          uuid,
  p_type          uuid,
  p_period        text,
  p_payment_pence int,
  p_pi            text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing   public.hub_members%rowtype;
  v_base       timestamptz;
  v_paid_until timestamptz;
  v_member_no  text;
begin
  select * into v_existing from public.hub_members
    where hub_id = p_hub and user_id = p_user
    for update;

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
  -- final paid state in a follow-up UPDATE the trigger can't touch.
  insert into public.hub_members
    (hub_id, user_id, role, status, membership_type_id, paid_until, last_payment_pence, stripe_payment_intent_id, member_no)
  values
    (p_hub, p_user, 'member', 'active', p_type, v_paid_until, p_payment_pence, p_pi, v_member_no)
  on conflict (hub_id, user_id) do nothing;

  update public.hub_members set
    status                   = 'active',
    membership_type_id       = p_type,
    paid_until               = v_paid_until,
    last_payment_pence       = p_payment_pence,
    stripe_payment_intent_id = p_pi,
    member_no                = coalesce(member_no, v_member_no)
  where hub_id = p_hub and user_id = p_user;

  return jsonb_build_object('member_no', v_member_no, 'paid_until', v_paid_until);
end;
$$;

grant execute on function public.activate_hub_membership(uuid, uuid, uuid, text, int, text) to service_role;
