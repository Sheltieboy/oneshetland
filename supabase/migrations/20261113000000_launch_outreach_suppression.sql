-- ═══════════════════════════════════════════════════════════════════════════
-- Launch-partner OUTREACH SUPPRESSION — a durable do-not-contact state, enforced where the send is reserved
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. The first-contact invitation email is the one thing OneShetland sends to a business that has not asked to hear from it. Anyone
-- who says "please don't contact me again" must be honoured durably, whoever is logged in and whatever page is open.
--
-- WHAT THIS IS. A small, admin-only suppression list, scoped to LAUNCH PARTNER OUTREACH ONLY. There was no suitable existing model:
-- notification_preferences belongs to signed-in users and their in-app notification channels, not to a business contact who has no
-- account. Nothing here is read by any transactional path (password reset, orders, receipts, claim status, notifications).
--
-- THE MODEL: BUSINESS-LEVEL, plus the address that was on file.
--   One row = "stop Launch Partner outreach for this business", recorded with the contact address that was on file at the time.
--   · It blocks the BUSINESS. Changing the contact email later does NOT re-open outreach — that is the loophole an address-only
--     suppression has.
--   · It also blocks that ADDRESS for any other business, so one person who asked not to be contacted is not approached again about a
--     different business.
--   · A suppression is never deleted. Lifting it is a separate, reasoned, audited act and the row stays as history.
--
-- WHO. Only administrators (launch_plan_authorised) can record or lift one, through the two functions below. The table has RLS on, no
-- policy and no client grant: an owner, a visitor or any signed-in user cannot read or change it. The internal note is shown to
-- administrators only (it is part of the admin summary, which only administrators can call) and is never copied into an audit event.
--
-- THE GATE. admin_launch_partner_claim_send — the step that RESERVES the send before the mail provider is called — refuses with
-- reason 'do_not_contact' while the business or its contact address is suppressed. It runs under the campaign's row lock and writes nothing
-- when it refuses. The Edge Function also checks the facts it reads, before reserving, so a refusal is reported plainly.
--
-- AUDIT. The existing launch_partner_events trail: 'outreach_stopped' (reason code, whether an address was recorded, who) and
-- 'outreach_resumed' (the reason for lifting, who).
--
-- WHAT THIS MIGRATION DOES NOT DO: write local_businesses, claims, grants, invitations, products, services, offers or passes; touch any
-- existing campaign (no suppression is created for anyone); delete anything; send an email; call the network.

begin;

-- ── 1. the suppression list ─────────────────────────────────────────────────
create table if not exists public.launch_outreach_suppressions (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.local_businesses(id) on delete restrict,
  -- The contact address on file when it was recorded, lower-cased; null when the campaign had no contact yet.
  contact_email    text check (contact_email is null or (char_length(contact_email) <= 254 and contact_email = lower(btrim(contact_email)) and contact_email ~ '^[^@\s]+@[^@\s]+$')),
  reason           text not null check (reason in ('requested', 'bounced', 'complaint', 'incorrect_contact', 'admin')),
  -- INTERNAL. Never shown to the recipient, never copied into an audit event.
  note             text check (note is null or char_length(note) <= 500),
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  created_by_label text,
  lifted_at        timestamptz,
  lifted_by        uuid,
  lifted_by_label  text,
  lift_reason      text check (lift_reason is null or char_length(lift_reason) between 3 and 500),
  check ((lifted_at is null) = (lift_reason is null))
);

-- At most ONE active suppression per business; lifted rows are history and any number may exist.
create unique index if not exists launch_outreach_suppressions_one_active_uidx
  on public.launch_outreach_suppressions (business_id) where lifted_at is null;
create index if not exists launch_outreach_suppressions_address_idx
  on public.launch_outreach_suppressions (contact_email) where lifted_at is null and contact_email is not null;

alter table public.launch_outreach_suppressions enable row level security;
revoke all on public.launch_outreach_suppressions from public, anon, authenticated;
revoke all on public.launch_outreach_suppressions from service_role;
grant select, insert, update on public.launch_outreach_suppressions to service_role;
-- No policy, deliberately: read and written only through the functions below.
comment on table public.launch_outreach_suppressions is
  'Launch Partner outreach do-not-contact list. Admin-only through functions; RLS on, no policy, no client grant. Rows are never deleted: lifting sets lifted_at + lift_reason. Business-level, with the contact address that was on file. Read by NO transactional path.';

-- Append-only in spirit: no delete, no truncate, and the only permitted update is lifting an active row (lifted_* set once, nothing else changes).
create or replace function public._launch_outreach_suppressions_guard()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if old.lifted_at is null and new.lifted_at is not null
       and new.id = old.id and new.business_id = old.business_id and new.contact_email is not distinct from old.contact_email
       and new.reason = old.reason and new.note is not distinct from old.note and new.created_at = old.created_at
       and new.created_by is not distinct from old.created_by and new.created_by_label is not distinct from old.created_by_label then
      return new;
    end if;
  end if;
  raise exception 'launch_outreach_suppressions is append-only: % is not allowed (a suppression is only ever lifted)', tg_op using errcode = '55000';
end;
$$;
revoke all on function public._launch_outreach_suppressions_guard() from public, anon, authenticated;

drop trigger if exists launch_outreach_suppressions_guard on public.launch_outreach_suppressions;
create trigger launch_outreach_suppressions_guard
  before update or delete on public.launch_outreach_suppressions
  for each row execute function public._launch_outreach_suppressions_guard();
drop trigger if exists launch_outreach_suppressions_no_truncate on public.launch_outreach_suppressions;
create trigger launch_outreach_suppressions_no_truncate
  before truncate on public.launch_outreach_suppressions
  for each statement execute function public._launch_outreach_suppressions_guard();

-- ── 2. is outreach to this business / address stopped? (internal helper) ────
-- The business match wins; otherwise the address match (the same person, asked about another business). NULL = not stopped.
create or replace function public._launch_partner_outreach_block(p_business_id uuid, p_email text)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', s.id, 'scope', case when s.business_id = p_business_id then 'business' else 'address' end,
                            'reason', s.reason, 'note', s.note, 'since', s.created_at, 'by', s.created_by_label,
                            'business_id', s.business_id, 'address_recorded', s.contact_email is not null)
    from public.launch_outreach_suppressions s
   where s.lifted_at is null
     and (s.business_id = p_business_id
          or (s.contact_email is not null and nullif(btrim(coalesce(p_email, '')), '') is not null and s.contact_email = lower(btrim(p_email))))
   order by (s.business_id = p_business_id) desc, s.created_at desc
   limit 1
$$;
revoke all on function public._launch_partner_outreach_block(uuid, text) from public, anon, authenticated;

-- ── 3. record "do not contact" ──────────────────────────────────────────────
create or replace function public.admin_launch_partner_stop_outreach(p_id uuid, p_reason text, p_note text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via    text := public.launch_plan_authorised();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_name   text;
  c        public.launch_partner_campaigns;
  v_addr   text;
  v_id     uuid;
begin
  if v_via is null then
    raise exception 'Only an administrator can stop Launch Partner outreach' using errcode = '42501';
  end if;
  if v_reason is null or v_reason not in ('requested', 'bounced', 'complaint', 'incorrect_contact', 'admin') then
    raise exception 'Choose why outreach is being stopped' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'The note is limited to 500 characters' using errcode = '22023';
  end if;

  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  select s.id into v_id from public.launch_outreach_suppressions s where s.business_id = c.business_id and s.lifted_at is null;
  if found then
    return jsonb_build_object('already_stopped', true, 'id', v_id);                         -- a repeat: nothing is written
  end if;

  v_addr := nullif(lower(btrim(coalesce(c.contact_email, ''))), '');
  if v_addr is not null and v_addr !~ '^[^@\s]+@[^@\s]+$' then v_addr := null; end if;
  v_name := (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid());

  insert into public.launch_outreach_suppressions (business_id, contact_email, reason, note, created_by_label)
  values (c.business_id, v_addr, v_reason, v_note, coalesce(v_name, v_via))
  returning id into v_id;

  -- The audit event carries the reason CODE, never the internal note and never the address.
  perform public._launch_partner_event(c.id, 'outreach_stopped',
    jsonb_build_object('suppression_id', v_id, 'reason', v_reason, 'address_recorded', v_addr is not null, 'actor_name', v_name), v_via);
  return jsonb_build_object('already_stopped', false, 'id', v_id);
end;
$$;

-- ── 4. lift it (deliberate: a reason is required) ───────────────────────────
create or replace function public.admin_launch_partner_resume_outreach(p_id uuid, p_reason text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_via    text := public.launch_plan_authorised();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_name   text;
  c        public.launch_partner_campaigns;
  v_id     uuid;
begin
  if v_via is null then
    raise exception 'Only an administrator can resume Launch Partner outreach' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Give a reason for removing the suppression' using errcode = '22023';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'The reason is limited to 500 characters' using errcode = '22023';
  end if;

  select * into c from public.launch_partner_campaigns where id = p_id for update;
  if not found then raise exception 'No such launch-partner record' using errcode = 'P0002'; end if;

  select s.id into v_id from public.launch_outreach_suppressions s where s.business_id = c.business_id and s.lifted_at is null for update;
  if not found then
    return jsonb_build_object('not_stopped', true);                                          -- nothing to lift: nothing is written
  end if;
  v_name := (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = auth.uid());
  update public.launch_outreach_suppressions
     set lifted_at = now(), lifted_by = auth.uid(), lifted_by_label = coalesce(v_name, v_via), lift_reason = v_reason
   where id = v_id;
  perform public._launch_partner_event(c.id, 'outreach_resumed',
    jsonb_build_object('suppression_id', v_id, 'reason', v_reason, 'actor_name', v_name), v_via);
  return jsonb_build_object('not_stopped', false, 'id', v_id);
end;
$$;

-- ── 5. the admin summary: one more field ────────────────────────────────────
create or replace function public._launch_partner_summary(p_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  c        public.launch_partner_campaigns;
  b        public.local_businesses;
  v_inv    boolean := false;
  v_i_at   timestamptz; v_i_exp timestamptz; v_i_rev timestamptz; v_i_bound text; v_i_status text;
  v_c_st   text; v_c_at timestamptz;
  v_g_tier text; v_g_exp timestamptz; v_g_at timestamptz;
  v_prod   integer; v_prod_act integer;
  v_imp    integer; v_imp_at timestamptz;
  v_ev_at  timestamptz;
  v_owner_name text;
begin
  select * into c from public.launch_partner_campaigns where id = p_id;
  if not found then return null; end if;
  select * into b from public.local_businesses where id = c.business_id;

  select true, i.created_at, i.expires_at, i.revoked_at, cl.status
    into v_inv, v_i_at, v_i_exp, v_i_rev, v_i_bound
    from public.launch_invites i
    left join public.business_claims cl on cl.id = i.bound_claim_id
   where i.slug = c.slug
   order by i.created_at desc limit 1;
  v_inv := coalesce(v_inv, false);
  v_i_status := case when not v_inv then 'none'
                     when v_i_rev is not null then 'revoked'
                     when v_i_exp is not null and v_i_exp <= now() then 'expired'
                     when v_i_bound = 'pending' then 'claim pending'
                     when v_i_bound = 'approved' then 'claimed'
                     else 'open' end;

  select x.status, x.created_at into v_c_st, v_c_at
    from public.business_claims x
   where x.business_id = c.business_id and x.source = 'launch_partner_invitation'
   order by x.created_at desc limit 1;

  select g.tier, g.expires_at, g.created_at into v_g_tier, v_g_exp, v_g_at
    from public.launch_plan_grants g
   where g.business_id = c.business_id and g.revoked_at is null and g.superseded_at is null and g.expires_at > now()
   order by g.created_at desc limit 1;

  select count(*), count(*) filter (where p.is_active) into v_prod, v_prod_act
    from public.products p where p.business_id = c.business_id;
  select count(*), max(ib.created_at) into v_imp, v_imp_at
    from public.import_batches ib where ib.business_id = c.business_id;
  select max(e.created_at) into v_ev_at from public.launch_partner_events e where e.campaign_id = c.id;

  return jsonb_build_object(
    'id', c.id, 'business_id', c.business_id, 'slug', c.slug, 'stage', c.stage, 'is_test', c.is_test,
    'positioning', c.positioning, 'contact_name', c.contact_name,
    'has_contact_email', c.contact_email is not null,
    'has_email_draft', (nullif(btrim(coalesce(c.email_subject, '')), '') is not null
                        or nullif(btrim(coalesce(c.email_body, '')), '') is not null),
    'has_preview', c.preview_config <> '{}'::jsonb,
    'has_page_draft', c.page_config <> '{}'::jsonb,
    'sent_at', c.sent_at, 'first_viewed_at', c.first_viewed_at, 'last_viewed_at', c.last_viewed_at,
    'view_count', c.view_count, 'setup_ready_at', c.setup_ready_at, 'live_at', c.live_at,
    'is_published', c.published_version_id is not null, 'offline_at', c.offline_at,
    'outreach', public._launch_partner_outreach_block(c.business_id, c.contact_email),
    'created_at', c.created_at, 'updated_at', c.updated_at,
    'business', jsonb_build_object(
      'name', b.name, 'category', b.category, 'locality', public.business_locality(b.address),
      'is_active', coalesce(b.is_active, false), 'is_claimed', coalesce(b.is_claimed, false),
      'has_owner', b.owner_id is not null),
    'tier', b.subscription_tier,
    'plan_live', public.business_meets_tier(b.id, 'pro'),
    'grant', case when v_g_tier is null then null
                  else jsonb_build_object('tier', v_g_tier, 'expires_at', v_g_exp) end,
    'invitation', jsonb_build_object('status', v_i_status, 'created_at', v_i_at, 'expires_at', v_i_exp),
    'claim', case when v_c_st is null then null
                  else jsonb_build_object('status', v_c_st, 'created_at', v_c_at) end,
    'product_count', v_prod, 'active_product_count', v_prod_act,
    'import_batch_count', v_imp,
    'last_activity', greatest(c.created_at, c.updated_at, c.sent_at, c.first_viewed_at, c.last_viewed_at,
                              c.setup_ready_at, c.live_at, c.offline_at, v_i_at, v_c_at, v_g_at, v_imp_at, v_ev_at)
  );
end;
$$;

-- ── 6. the send reservation: the do-not-contact gate ────────────────────────
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

  -- THE SERVER-SIDE DO-NOT-CONTACT GATE. It runs under the campaign's row lock, before anything is reserved, so a stale page, a second
  -- tab or a direct call cannot get an invitation out for a business (or an address) that asked not to be contacted. Nothing is written.
  if public._launch_partner_outreach_block(c.business_id, c.contact_email) is not null then
    return jsonb_build_object('ok', false, 'reason', 'do_not_contact');
  end if;

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

-- ── 7. who may call what ────────────────────────────────────────────────────
revoke all on function
  public._launch_partner_summary(uuid),
  public.admin_launch_partner_claim_send(uuid),
  public.admin_launch_partner_stop_outreach(uuid, text, text),
  public.admin_launch_partner_resume_outreach(uuid, text)
  from public, anon, authenticated;
-- Self-gated on launch_plan_authorised(): anon cannot even execute them.
grant execute on function
  public.admin_launch_partner_claim_send(uuid),
  public.admin_launch_partner_stop_outreach(uuid, text, text),
  public.admin_launch_partner_resume_outreach(uuid, text)
  to authenticated, service_role;

commit;
