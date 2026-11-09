-- Rolls back 20270102110000_editions_stage_a.sql. Any membership left in 'invited' from an offline offer stays invited (decline or delete it by hand first if you want it gone).
drop trigger if exists edition_organisers_dark_guard on public.edition_organisers;
drop function if exists public.edition_dark_launch_guard();
drop function if exists public.edition_org_contact_email(uuid);
grant select (contact_email) on public.edition_organisers to authenticated;
grant select (created_by) on public.edition_updates to authenticated;

create or replace function public.edition_membership_record_offline(p_org uuid, p_tier uuid, p_business uuid, p_kind text, p_start timestamptz, p_end timestamptz, p_amount integer, p_method text, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.organiser_membership_tiers%rowtype; v_id uuid; v_pay uuid;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an organiser admin can record memberships' using errcode = '42501'; end if;
  if not public.edition_org_entitled(p_org, 'offline_records') then raise exception 'recording offline memberships is not included in your package' using errcode = '23514', hint = 'no_offline_entitlement'; end if;
  if p_kind not in ('offline', 'complimentary') then raise exception 'choose offline or complimentary' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'a note is required (for example the receipt reference or why it is free)' using errcode = '23514'; end if;
  if p_end is null or p_end <= coalesce(p_start, now()) or p_end > coalesce(p_start, now()) + interval '13 months' then raise exception 'the period must end after it starts and be at most a year' using errcode = '23514'; end if;
  if p_kind = 'offline' and (p_amount is null or p_amount < 0 or p_amount > 10000000 or p_method not in ('cheque', 'bank_transfer', 'cash', 'imported', 'other')) then raise exception 'record the amount and how it was paid' using errcode = '23514'; end if;
  select * into t from public.organiser_membership_tiers where id = p_tier and organiser_id = p_org and archived_at is null;
  if not found then raise exception 'tier not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.local_businesses b where b.id = p_business and b.is_active) then raise exception 'that business is not in the directory' using errcode = '23514'; end if;
  if exists (select 1 from public.organiser_memberships m where m.organiser_id = p_org and m.business_id = p_business and m.status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end')) then raise exception 'already a member or already has a pending application' using errcode = '23505'; end if;
  if t.max_members is not null and (select count(*) from public.organiser_memberships m where m.tier_id = t.id and m.status in ('pending_payment', 'active', 'past_due', 'cancel_at_period_end')) >= t.max_members then raise exception 'this tier is full' using errcode = '23514'; end if;
  if public.edition_org_limit(p_org, 'memberships') is not null and (select count(*) from public.organiser_memberships m where m.organiser_id = p_org and m.status in ('active', 'past_due', 'cancel_at_period_end')) >= public.edition_org_limit(p_org, 'memberships') then raise exception 'you have reached the member limit of your package' using errcode = '23514'; end if;
  insert into public.organiser_memberships (organiser_id, tier_id, business_id, status, billing_interval, source, price_pence, vat_mode, current_period_start, current_period_end, joined_at, decided_by, decided_at, organiser_note, created_by)
  values (p_org, p_tier, p_business, 'active', p_kind, 'offline_record', coalesce(p_amount, 0), 'none', coalesce(p_start, now()), p_end, now(), auth.uid(), now(), btrim(p_note), auth.uid()) returning id into v_id;
  v_pay := public.edition_record_payment_row(p_org, p_business, 'membership', v_id, case when p_kind = 'offline' then 'offline' else 'complimentary' end, 'succeeded', coalesce(p_amount, 0), 0, 'none', 0, coalesce(p_amount, 0), coalesce(p_amount, 0),
    null, null, null, coalesce(p_start, now()), p_end, case when p_kind = 'offline' then p_method end, auth.uid(), null, btrim(p_note), null);
  perform public.edition_mem_event(v_id, 'recorded_offline', jsonb_build_object('kind', p_kind, 'amount', p_amount));
  perform public.edition_audit(p_org, null, 'membership_recorded_offline', jsonb_build_object('membership', v_id, 'kind', p_kind, 'amount', p_amount));
  return v_id;
end $$;

create or replace function public.edition_membership_respond(p_membership uuid, p_accept boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; t public.organiser_membership_tiers%rowtype; v_to text;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or not public.edition_biz_owner(m.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status <> 'invited' then raise exception 'this invitation has already been answered' using errcode = '23514'; end if;
  select * into t from public.organiser_membership_tiers where id = m.tier_id;
  if p_accept and not t.is_free and public.edition_collect_blocker(m.organiser_id) is not null then raise exception 'this organiser cannot take payments right now' using errcode = '23514', hint = 'organiser_cannot_collect'; end if;
  v_to := case when p_accept then public.edition_membership_open_status(t) else 'declined' end;
  update public.organiser_memberships set status = v_to, owner_user_id = auth.uid(), decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), ''), joined_at = case when v_to = 'active' then now() else joined_at end, updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, case when p_accept then 'invitation_accepted' else 'invitation_declined' end, jsonb_build_object('to', v_to));
  return v_to;
end $$;
