-- Launch partners: an atomic "reserve the send" step, so an invitation email can never be sent twice.
--
-- The invitation email is sent by an Edge Function that calls Postmark. A double click, two open tabs or a retry after a
-- network error must not produce two emails. So the sender RESERVES the send in the database BEFORE it calls Postmark:
--
--   admin_launch_partner_claim_send(p_id)    one transaction, row locked FOR UPDATE; the first caller wins, every other
--                                            caller is told why not. The sender then calls Postmark and either records
--                                            success with the existing admin_launch_partner_mark_sent, or, on a definite
--                                            failure, gives the reservation back with
--   admin_launch_partner_release_send(p_id)  clears the reservation (only while nothing has been sent).
--
-- A reservation older than 30 minutes is treated as abandoned (the sender died between claim and mark_sent) and may be
-- claimed again.
--
--   * ONE new column: launch_partner_campaigns.send_claimed_at (null = nothing reserved). It is NOT in the
--     admin_launch_partner_update whitelist and is not returned by admin_launch_partner_get / list: it can be changed
--     only by these two functions.
--   * Both functions are admin-only through launch_plan_authorised() (42501 otherwise), SECURITY DEFINER, with a pinned
--     search_path. anon cannot execute them; authenticated and service_role can (and are then gated by the function).
--   * They change nothing but send_claimed_at: not sent_at, not stage, no invitation, listing, product, claim or grant.
--     No outbound network call of any kind. A refused claim writes nothing. The audit events ('send_claimed', 'send_released') carry
--     ids only: never the recipient, never any email text.
--
-- Additive and idempotent: safe to apply twice.
begin;

alter table public.launch_partner_campaigns add column if not exists send_claimed_at timestamptz;

comment on column public.launch_partner_campaigns.send_claimed_at is
  'Reservation taken by admin_launch_partner_claim_send just before the invitation email is sent. Null = nothing reserved. Older than 30 minutes = abandoned. Written only by the claim/release functions.';

-- ── claim ───────────────────────────────────────────────────────────────────
create or replace function public.admin_launch_partner_claim_send(p_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via text := public.launch_plan_authorised();
  c     public.launch_partner_campaigns;
begin
  if v_via is null then
    raise exception 'Only an administrator can reserve an invitation send' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  if c.sent_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_sent');
  end if;
  if c.stage <> 'ready_to_invite' then
    return jsonb_build_object('ok', false, 'reason', 'not_ready');
  end if;
  if c.send_claimed_at is not null and c.send_claimed_at > now() - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'send_in_progress');
  end if;

  update public.launch_partner_campaigns set send_claimed_at = now() where id = p_id;
  perform public._launch_partner_event(p_id, 'send_claimed', jsonb_build_object('campaign_id', p_id), v_via);
  return jsonb_build_object('ok', true);
end;
$$;

-- ── release ─────────────────────────────────────────────────────────────────
create or replace function public.admin_launch_partner_release_send(p_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via text := public.launch_plan_authorised();
  c     public.launch_partner_campaigns;
begin
  if v_via is null then
    raise exception 'Only an administrator can release an invitation send' using errcode = '42501';
  end if;
  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  if c.sent_at is not null or c.send_claimed_at is null then
    return false;
  end if;

  update public.launch_partner_campaigns set send_claimed_at = null where id = p_id;
  perform public._launch_partner_event(p_id, 'send_released', jsonb_build_object('campaign_id', p_id), v_via);
  return true;
end;
$$;

revoke all on function
  public.admin_launch_partner_claim_send(uuid),
  public.admin_launch_partner_release_send(uuid)
  from public, anon, authenticated;
grant execute on function
  public.admin_launch_partner_claim_send(uuid),
  public.admin_launch_partner_release_send(uuid)
  to authenticated, service_role;

commit;
