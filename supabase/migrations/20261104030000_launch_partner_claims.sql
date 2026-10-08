-- ═══════════════════════════════════════════════════════════════════════════
-- Launch Partner invitations and claims
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A private Launch Partner Preview (/launch/{slug}) is shown to the owner of ONE existing Directory listing. This
-- migration lets that person claim THAT listing through the ordinary claim system, and nothing more:
--
--   · the claim is a normal pending row in business_claims, decided by an administrator with the existing
--     approve_business_claim — the invitation never grants ownership, a plan, or any visibility;
--   · the invitation is checked IN THE DATABASE (only a SHA-256 of the token is stored), is bound to exactly one
--     business, can be revoked or expire, and is tied to the first account that submits a claim through it;
--   · the claim is labelled (source / source_ref) so an administrator can recognise it. Only the definer function
--     below can write that label, so it cannot be forged from the client.
--
-- Nothing here publishes anything. Claiming does not touch a listing's public content, create products, offers or
-- rewards, or issue a launch plan (that stays the explicit admin_grant_launch_plan action).

-- ── 1. Label on the claim ──────────────────────────────────────────────────
alter table public.business_claims
  add column if not exists source     text,
  add column if not exists source_ref text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'business_claims_source_check') then
    alter table public.business_claims add constraint business_claims_source_check
      check (source is null or source = 'launch_partner_invitation');
  end if;
end $$;

-- A client may not write the label: it is how an administrator tells an invited claim from an ordinary one, so only
-- the definer function (current_user = its owner) or the service role may set it. SECURITY INVOKER on purpose.
create or replace function public.tg_business_claims_source_guard()
  returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if public.tg_is_server_write() then return new; end if;
  if tg_op = 'INSERT' then
    if new.source is not null or new.source_ref is not null then
      raise exception 'A claim''s source is set by the platform' using errcode = '42501';
    end if;
  elsif new.source is distinct from old.source or new.source_ref is distinct from old.source_ref then
    raise exception 'A claim''s source is set by the platform' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists business_claims_source_guard on public.business_claims;
create trigger business_claims_source_guard
  before insert or update on public.business_claims
  for each row execute function public.tg_business_claims_source_guard();

-- ── 2. Invitations ─────────────────────────────────────────────────────────
create table if not exists public.launch_invites (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null check (slug ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
  business_id    uuid not null references public.local_businesses(id) on delete cascade,
  token_hash     text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  created_by     uuid,
  created_via    text,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  -- Tied to the first account that submits a claim through it.
  bound_user_id  uuid references public.profiles(id) on delete set null,
  bound_claim_id uuid references public.business_claims(id) on delete set null,
  bound_at       timestamptz
);

create unique index if not exists launch_invites_token_uq on public.launch_invites (token_hash);
-- One LIVE invitation per preview: issuing a new one revokes the old.
create unique index if not exists launch_invites_live_slug_uq on public.launch_invites (slug) where revoked_at is null;
create index if not exists launch_invites_business_idx on public.launch_invites (business_id);

alter table public.launch_invites enable row level security;
revoke all on public.launch_invites from anon, authenticated;
grant all on public.launch_invites to service_role;
-- No client policy at all: invitations are read and written only through the functions below.

-- ── 3. Internal lookup ─────────────────────────────────────────────────────
-- The token is hashed here and compared to the stored hash. A token of the wrong shape, an unknown slug, a revoked
-- or expired invitation all return nothing — identically.
create or replace function public._launch_invite_find(p_slug text, p_token text, p_lock boolean default false)
  returns public.launch_invites
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare r public.launch_invites;
begin
  if p_slug is null or p_token is null or p_token !~ '^[A-Za-z0-9_-]{40,128}$' then
    return null;
  end if;
  if p_lock then
    select * into r from public.launch_invites
     where slug = p_slug and token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')
       and revoked_at is null and (expires_at is null or expires_at > now())
     for update;
  else
    select * into r from public.launch_invites
     where slug = p_slug and token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')
       and revoked_at is null and (expires_at is null or expires_at > now());
  end if;
  if not found then return null; end if;
  return r;
end;
$$;
revoke all on function public._launch_invite_find(text, text, boolean) from public, anon, authenticated;

-- ── 4. Does this token open this preview? (signed out is fine) ─────────────
-- Returns the ONE business the invitation is for, or null. Never anything else.
create or replace function public.launch_invite_resolve(p_slug text, p_token text)
  returns uuid
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare r public.launch_invites;
begin
  r := public._launch_invite_find(p_slug, p_token);
  return r.business_id;      -- null when r is null
end;
$$;

-- ── 5. Where does the CALLER stand? ────────────────────────────────────────
-- A small state word, plus the business id and name the invitation is for. Never another person's claim, name or email.
--   open · pending · rejected · owner · claimed_by_other · invite_used
create or replace function public.launch_invite_claim_state(p_slug text, p_token text)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  r        public.launch_invites;
  b        public.local_businesses;
  v_uid    uuid := auth.uid();
  v_mine   text;
  v_bound  text;
  v_state  text;
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  r := public._launch_invite_find(p_slug, p_token);
  if r.id is null then return null; end if;
  select * into b from public.local_businesses where id = r.business_id;
  if not found then return null; end if;

  select status into v_mine from public.business_claims
   where user_id = v_uid and business_id = r.business_id order by created_at desc limit 1;

  if b.owner_id is not null then
    v_state := case when b.owner_id = v_uid then 'owner' else 'claimed_by_other' end;
  elsif v_mine = 'pending' then
    v_state := 'pending';
  else
    select c.status into v_bound from public.business_claims c where c.id = r.bound_claim_id;
    if r.bound_user_id is not null and r.bound_user_id <> v_uid and v_bound in ('pending', 'approved') then
      v_state := 'invite_used';
    elsif v_mine = 'rejected' then
      v_state := 'rejected';
    else
      v_state := 'open';
    end if;
  end if;
  return jsonb_build_object('state', v_state, 'business_id', b.id, 'business_name', b.name);
end;
$$;

-- ── 6. Submit the claim ────────────────────────────────────────────────────
-- Creates the ordinary pending claim, labelled, bound to the caller. It does not make anyone owner, does not touch
-- the listing, and is idempotent: pressing the button twice, or from two tabs, leaves one pending claim.
create or replace function public.submit_launch_partner_claim(
  p_slug          text,
  p_token         text,
  p_contact_name  text,
  p_contact_email text,
  p_contact_phone text default null,
  p_role          text default null,
  p_evidence      text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  r       public.launch_invites;
  b       public.local_businesses;
  v_name  text := nullif(btrim(coalesce(p_contact_name, '')), '');
  v_email text := nullif(btrim(coalesce(p_contact_email, '')), '');
  v_bound text;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if v_name is null or v_email is null then
    raise exception 'Please give your name and a contact email so we can verify you.' using errcode = '22023';
  end if;
  if char_length(v_name) > 200 or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+$'
     or char_length(coalesce(p_contact_phone, '')) > 50 or char_length(coalesce(p_role, '')) > 100
     or char_length(coalesce(p_evidence, '')) > 2000 then
    raise exception 'Please check the details you entered.' using errcode = '22023';
  end if;

  r := public._launch_invite_find(p_slug, p_token, true);
  if r.id is null then
    raise exception 'This invitation is no longer valid.' using errcode = 'P0002';
  end if;
  select * into b from public.local_businesses where id = r.business_id for update;
  if not found then raise exception 'This invitation is no longer valid.' using errcode = 'P0002'; end if;

  if b.owner_id is not null then
    return jsonb_build_object('state', case when b.owner_id = v_uid then 'owner' else 'claimed_by_other' end);
  end if;

  select c.status into v_bound from public.business_claims c where c.id = r.bound_claim_id;
  if r.bound_user_id is not null and r.bound_user_id <> v_uid and v_bound in ('pending', 'approved') then
    return jsonb_build_object('state', 'invite_used');
  end if;

  if exists (select 1 from public.business_claims where user_id = v_uid and business_id = r.business_id and status = 'pending') then
    select id into v_id from public.business_claims
     where user_id = v_uid and business_id = r.business_id and status = 'pending' limit 1;
  else
    begin
      insert into public.business_claims
        (user_id, business_id, status, contact_name, contact_email, contact_phone, role, evidence, source, source_ref)
      values
        (v_uid, r.business_id, 'pending', v_name, v_email, nullif(btrim(coalesce(p_contact_phone, '')), ''),
         nullif(btrim(coalesce(p_role, '')), ''), nullif(btrim(coalesce(p_evidence, '')), ''),
         'launch_partner_invitation', r.slug)
      returning id into v_id;
    exception when unique_violation then
      select id into v_id from public.business_claims
       where user_id = v_uid and business_id = r.business_id and status = 'pending' limit 1;
    end;
  end if;

  update public.launch_invites
     set bound_user_id = v_uid, bound_claim_id = v_id, bound_at = now()
   where id = r.id;

  return jsonb_build_object('state', 'pending');
end;
$$;

-- ── 7. Administration ──────────────────────────────────────────────────────
-- Same authorisation as the launch-plan grant: an admin session, the service role, or a direct SQL session; fails
-- closed on anything else.
create or replace function public.admin_issue_launch_invite(
  p_slug        text,
  p_business_id uuid,
  p_expires_at  timestamptz default (now() + interval '45 days')
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

create or replace function public.admin_revoke_launch_invite(p_slug text, p_reason text default null)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare n integer;
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can revoke an invitation' using errcode = '42501';
  end if;
  update public.launch_invites
     set revoked_at = now(), revoked_reason = coalesce(nullif(btrim(p_reason), ''), 'revoked by an administrator')
   where slug = p_slug and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.admin_list_launch_invites()
  returns table (
    slug text, business_id uuid, business_name text, created_at timestamptz, expires_at timestamptz,
    revoked_at timestamptz, revoked_reason text, status text,
    claimant_name text, claimant_email text, claim_status text
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can list invitations' using errcode = '42501';
  end if;
  return query
    select i.slug, i.business_id, b.name, i.created_at, i.expires_at, i.revoked_at, i.revoked_reason,
           case when i.revoked_at is not null then 'revoked'
                when i.expires_at is not null and i.expires_at <= now() then 'expired'
                when c.status = 'pending' then 'claim pending'
                when c.status = 'approved' then 'claimed'
                else 'open' end,
           c.contact_name, c.contact_email, c.status
      from public.launch_invites i
      join public.local_businesses b on b.id = i.business_id
      left join public.business_claims c on c.id = i.bound_claim_id
     order by i.created_at desc;
end;
$$;

-- ── 8. Who may call what ───────────────────────────────────────────────────
revoke all on function
  public.launch_invite_resolve(text, text),
  public.launch_invite_claim_state(text, text),
  public.submit_launch_partner_claim(text, text, text, text, text, text, text),
  public.admin_issue_launch_invite(text, uuid, timestamptz),
  public.admin_revoke_launch_invite(text, text),
  public.admin_list_launch_invites()
  from public, anon;
grant execute on function public.launch_invite_resolve(text, text) to anon, authenticated;
grant execute on function
  public.launch_invite_claim_state(text, text),
  public.submit_launch_partner_claim(text, text, text, text, text, text, text)
  to authenticated;
grant execute on function
  public.admin_issue_launch_invite(text, uuid, timestamptz),
  public.admin_revoke_launch_invite(text, text),
  public.admin_list_launch_invites()
  to authenticated, service_role;
