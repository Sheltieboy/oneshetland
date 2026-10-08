-- ═══════════════════════════════════════════════════════════════════════════
-- Launch invitations: ONE canonical default lifetime — 30 days
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The audit found three layers that disagreed about how long a private invitation lasts: the Admin screen and its server action defaulted to 30 days, this
-- function's own default was 45, and the invitation email said nothing at all. The real production invitation was issued for 30 days, 30 is what
-- Darren is shown, and it is what the email now states — so 30 is the policy, and this function now agrees.
--
-- THIS CHANGES ONE THING: the DEFAULT of p_expires_at (used only when a caller does not pass an expiry — the web always does). The body is an
-- exact copy of the function in 20261104030000: the same administrator check, the same 1-hour to 120-day bounds, the same rule that issuing a
-- new invitation revokes the previous one ('superseded by a new invitation'), the same 244-bit token stored only as a hash, the same grants.
-- Nothing about how a token is looked up, validated, expired or revoked is touched, and no existing invitation is changed.

begin;

create or replace function public.admin_issue_launch_invite(
  p_slug        text,
  p_business_id uuid,
  p_expires_at  timestamptz default (now() + interval '30 days')
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via   text := public.launch_plan_authorised();
  v_token text;
begin
  if v_via is null then raise exception 'Only an administrator can issue an invitation' using errcode = '42501'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{2,60}$' then raise exception 'Invalid preview name' using errcode = '22023'; end if;
  if not exists (select 1 from public.local_businesses where id = p_business_id) then
    raise exception 'No such business' using errcode = 'P0002';
  end if;
  if p_expires_at is null or p_expires_at < now() + interval '1 hour' or p_expires_at > now() + interval '120 days' then
    raise exception 'An invitation must expire between an hour and 120 days from now' using errcode = '22023';
  end if;

  update public.launch_invites
     set revoked_at = now(), revoked_reason = 'superseded by a new invitation'
   where slug = p_slug and revoked_at is null;

  -- 244 random bits from the database's CSPRNG, as 64 hex characters. Returned ONCE; only its hash is stored.
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.launch_invites (slug, business_id, token_hash, created_by, created_via, expires_at)
  values (p_slug, p_business_id, encode(sha256(convert_to(v_token, 'utf8')), 'hex'), auth.uid(), v_via, p_expires_at);

  return jsonb_build_object('slug', p_slug, 'business_id', p_business_id, 'token', v_token, 'expires_at', p_expires_at);
end;
$$;

revoke all on function public.admin_issue_launch_invite(text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_issue_launch_invite(text, uuid, timestamptz) to authenticated, service_role;

commit;
