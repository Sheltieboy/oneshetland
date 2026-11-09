-- R10 Stage A hardening (one migration). Rollback: supabase/rollbacks/20270102110000_editions_stage_a.rollback.sql
-- 1) Offline and complimentary memberships need the business owner's acceptance (consent). 2) The dark launch is enforced in the database. 3) Signed-in users can no longer read
-- an organiser's private contact email or who authored an update.

-- 1) consent -------------------------------------------------------------------------------------------------------------------------------------------------
alter table public.organiser_memberships add column if not exists offline_method text check (offline_method is null or offline_method in ('cheque', 'bank_transfer', 'cash', 'imported', 'other'));

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
  -- CONSENT: nothing is recorded against a business until its owner accepts. The offer sits as 'invited' (not live, not counted, not public) with the proposed
  -- period, amount and method held aside; the payment row is written only on acceptance (edition_membership_respond).
  insert into public.organiser_memberships (organiser_id, tier_id, business_id, status, billing_interval, source, price_pence, vat_mode, current_period_start, current_period_end, decided_by, decided_at, organiser_note, offline_method, created_by)
  values (p_org, p_tier, p_business, 'invited', p_kind, 'offline_record', coalesce(p_amount, 0), 'none', coalesce(p_start, now()), p_end, auth.uid(), now(), btrim(p_note), case when p_kind = 'offline' then p_method end, auth.uid()) returning id into v_id;
  perform public.edition_mem_event(v_id, 'offline_offered', jsonb_build_object('kind', p_kind, 'amount', p_amount));
  perform public.edition_audit(p_org, null, 'membership_offline_offered', jsonb_build_object('membership', v_id, 'kind', p_kind, 'amount', p_amount));
  return v_id;
end $$;

create or replace function public.edition_membership_respond(p_membership uuid, p_accept boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; t public.organiser_membership_tiers%rowtype; v_to text; v_pay uuid;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or not public.edition_biz_owner(m.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status <> 'invited' then raise exception 'this invitation has already been answered' using errcode = '23514'; end if;
  select * into t from public.organiser_membership_tiers where id = m.tier_id;
  if m.source = 'offline_record' then
    -- an organiser-recorded membership: the owner says yes or no. Accepting writes the record the organiser described; declining leaves no payment and no membership.
    if p_accept and m.current_period_end is not null and m.current_period_end <= now() then raise exception 'this offer has expired; ask the organiser to record it again' using errcode = '23514', hint = 'offer_expired'; end if;
    v_to := case when p_accept then 'active' else 'declined' end;
    update public.organiser_memberships set status = v_to, owner_user_id = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), ''), joined_at = case when p_accept then now() else joined_at end,
      current_period_start = case when p_accept then greatest(coalesce(current_period_start, now()), now() - interval '12 months') else current_period_start end, updated_at = now() where id = m.id;
    if p_accept then
      v_pay := public.edition_record_payment_row(m.organiser_id, m.business_id, 'membership', m.id, case when m.billing_interval = 'offline' then 'offline' else 'complimentary' end, 'succeeded', m.price_pence, 0, 'none', 0, m.price_pence, m.price_pence,
        null, null, null, m.current_period_start, m.current_period_end, case when m.billing_interval = 'offline' then m.offline_method end, m.created_by, null, m.organiser_note, null);
    end if;
    perform public.edition_mem_event(m.id, case when p_accept then 'offline_accepted' else 'offline_declined' end, jsonb_build_object('to', v_to));
    return v_to;
  end if;
  if p_accept and not t.is_free and public.edition_collect_blocker(m.organiser_id) is not null then raise exception 'this organiser cannot take payments right now' using errcode = '23514', hint = 'organiser_cannot_collect'; end if;
  v_to := case when p_accept then public.edition_membership_open_status(t) else 'declined' end;
  update public.organiser_memberships set status = v_to, owner_user_id = auth.uid(), decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), ''), joined_at = case when v_to = 'active' then now() else joined_at end, updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, case when p_accept then 'invitation_accepted' else 'invitation_declined' end, jsonb_build_object('to', v_to));
  return v_to;
end $$;

-- 2) dark launch in the database ----------------------------------------------------------------------------------------------------------------------------
-- While editions.enabled is false, only platform administrators (and the service role / migrations, which have no end-user) may create ORGANISERS. Existing organisers can still draft: the public switch, not
-- this guard, hides their content, and the kill switch must not freeze work in progress.
create or replace function public.edition_dark_launch_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null and not public.editions_enabled() and not public.is_admin() then
    raise exception 'Editions is not open yet' using errcode = '23514', hint = 'editions_dark';
  end if;
  return new;
end $$;
drop trigger if exists edition_organisers_dark_guard on public.edition_organisers;
create trigger edition_organisers_dark_guard before insert on public.edition_organisers for each row execute function public.edition_dark_launch_guard();
revoke execute on function public.edition_dark_launch_guard() from public, anon, authenticated;

-- 3) signed-in read exposure ---------------------------------------------------------------------------------------------------------------------------------
revoke select on public.edition_organisers from authenticated;
grant select (id, slug, name, tagline, description, logo_url, cover_url, cover_focus, brand_color, website, hub_id, status, verified_at, is_test, created_at, updated_at) on public.edition_organisers to authenticated;
revoke select on public.edition_updates from authenticated;
grant select (id, edition_id, title, body, pinned, published_at, image_url, created_at, updated_at) on public.edition_updates to authenticated;
-- the team (only) reads the private contact email
create or replace function public.edition_org_contact_email(p_org uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select o.contact_email from public.edition_organisers o where o.id = p_org and auth.uid() is not null and public.edition_org_role(p_org) is not null
$$;
revoke all on function public.edition_org_contact_email(uuid) from public, anon;
grant execute on function public.edition_org_contact_email(uuid) to authenticated;
