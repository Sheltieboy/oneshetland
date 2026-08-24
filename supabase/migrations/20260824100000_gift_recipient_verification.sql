-- Proving you are the recipient, without forcing you into a second account.
--
-- THE PROBLEM WITH THE OBVIOUS RULE
--
-- claim_gift() has never checked WHO is claiming. Any signed-in person holding
-- the code could take the gift; the code was the whole boundary. The obvious
-- repair — require auth.users.email = book_gifts.recipient_email — creates a
-- worse problem than it solves. A gift sent to john.work@gmail.com would be
-- unclaimable by John's existing OneShetland account at john@hotmail.com, and
-- the only way through would be signing up again. Duplicate accounts, split
-- history, split wallets.
--
-- TWO SEPARATE FACTS
--
--   the recipient EMAIL  proves control of the address the gift was sent to
--   the OneShetland ACCOUNT decides which account ends up owning it
--
-- They are allowed to differ, and recipient_email never becomes a login.
--
-- SO A GIFT MAY BE CLAIMED WHEN
--
--   auth.uid() is present, AND
--     the caller's CONFIRMED auth email equals recipient_email   (no challenge)
--     OR a live, unconsumed verification row exists for exactly
--        (this gift, this auth.uid())                            (challenge passed)
--
-- Otherwise claim_gift raises gift_recipient_verification_required, and the UI
-- offers "verify the email it was sent to" or "switch account".
--
-- WHAT THE CHALLENGE IS, AND IS NOT
--
-- A one-time 8-character code, generated with pgcrypto, stored only as a
-- SHA-256 hash, valid 15 minutes, 5 attempts, emailed to recipient_email and
-- to nowhere else. It proves control of that address for THAT gift by THAT
-- user. It is deliberately NOT a transferable proof: verifying
-- alice@example.com for gift X does not let you claim gift Y sent to the same
-- address. Verified secondary account emails would be a different feature and
-- are not this one.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD
--
-- No "does this email have an account?" endpoint, and nothing that answers it
-- indirectly. The claimant never needs to know, and account enumeration is a
-- worse leak than the inconvenience it would save. Every refusal below is
-- phrased against the GIFT, never against an account.

begin;

-- ── Where a challenge lives ─────────────────────────────────────────────────
create table if not exists public.gift_recipient_verifications (
  id          uuid primary key default gen_random_uuid(),
  gift_id     uuid not null references public.book_gifts(id) on delete cascade,
  -- The account that will own the gift if this succeeds. Bound at issue time.
  user_id     uuid not null,
  -- Snapshot of the address challenged, so a later edit to the gift cannot
  -- retroactively turn a passed challenge into proof of a different address.
  email       text not null,
  token_hash  text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  attempts    integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists gift_recipient_verifications_lookup_idx
  on public.gift_recipient_verifications (gift_id, user_id, consumed_at);

-- RLS on, and NOT ONE POLICY. Nothing reaches this table except the SECURITY
-- DEFINER functions below — no client role can read a hash, an expiry or an
-- attempt count, and none of them needs to.
alter table public.gift_recipient_verifications enable row level security;
revoke all on table public.gift_recipient_verifications from anon, authenticated;

comment on table public.gift_recipient_verifications is
  'One-time proof that a signed-in user controls the email a specific gift was sent to. Hash-only, 15-minute expiry, single use, bound to (gift, user). Never a general proof of address ownership. No client role may read it.';

-- ── Does this caller already satisfy the recipient rule? ────────────────────
-- Split out so claim_gift and the UI-facing eligibility check can never drift.
create or replace function public.gift_recipient_ok(p_gift uuid, p_user uuid)
returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_recipient text;
  v_email     text;
begin
  if p_user is null then return false; end if;

  select lower(btrim(recipient_email)) into v_recipient
    from public.book_gifts where id = p_gift;
  if v_recipient is null or v_recipient = '' then
    -- A gift with no destination address has no recipient rule to satisfy.
    -- Today create-gift-intent always requires one; this is the honest answer
    -- if that ever stops being true, and it fails CLOSED.
    return false;
  end if;

  -- Authoritative identity: the confirmed address on the auth record, never
  -- anything the client sent. An unconfirmed address proves nothing.
  select lower(btrim(u.email)) into v_email
    from auth.users u
   where u.id = p_user and u.email_confirmed_at is not null;

  if v_email is not null and v_email = v_recipient then
    return true;
  end if;

  -- Otherwise: a live challenge passed by THIS user for THIS gift.
  return exists (
    select 1 from public.gift_recipient_verifications v
     where v.gift_id = p_gift
       and v.user_id = p_user
       and v.consumed_at is not null
       and v.email = v_recipient
  );
end;
$$;

revoke all on function public.gift_recipient_ok(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gift_recipient_ok(uuid, uuid) to service_role;

-- ── Issue a challenge ──────────────────────────────────────────────────────
-- service_role ONLY. It returns the PLAINTEXT code, which must go into an
-- email and nowhere else; granting this to authenticated would hand the caller
-- the very secret the challenge exists to test. The edge function derives
-- p_user from a verified JWT, never from the request body.
create or replace function public.issue_gift_recipient_challenge(p_code text, p_user uuid)
returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  n        constant int  := 31;
  limit_   constant int  := 248;
  v_gift   public.book_gifts%rowtype;
  v_token  text := '';
  v_b      int;
  v_expiry timestamptz := now() + interval '15 minutes';
  v_local  text;
  v_domain text;
  v_masked text;
begin
  if p_user is null then raise exception 'auth_required'; end if;

  select * into v_gift from public.book_gifts where code = p_code;
  if not found                           then raise exception 'gift_not_found'; end if;
  if v_gift.status = 'pending_payment'   then raise exception 'gift_not_paid';  end if;
  if v_gift.status = 'cancelled'         then raise exception 'gift_cancelled'; end if;
  if v_gift.expires_at is not null
     and v_gift.expires_at < now()       then raise exception 'gift_expired';   end if;
  if v_gift.claimed_by_user_id is not null
     and v_gift.claimed_by_user_id <> p_user
                                         then raise exception 'gift_already_claimed'; end if;
  if v_gift.recipient_email is null or btrim(v_gift.recipient_email) = ''
                                         then raise exception 'gift_has_no_recipient_email'; end if;

  -- A fresh challenge retires any earlier one for this pair, so an old code in
  -- an older email cannot be used after a new one is requested.
  delete from public.gift_recipient_verifications
   where gift_id = v_gift.id and user_id = p_user and consumed_at is null;

  while length(v_token) < 8 loop
    v_b := get_byte(extensions.gen_random_bytes(1), 0);
    if v_b < limit_ then v_token := v_token || substr(alphabet, (v_b % n) + 1, 1); end if;
  end loop;

  insert into public.gift_recipient_verifications (gift_id, user_id, email, token_hash, expires_at)
  values (
    v_gift.id, p_user, lower(btrim(v_gift.recipient_email)),
    encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expiry
  );

  -- Masked for the UI: enough to recognise your own address, not enough to
  -- learn somebody else's.
  v_local  := split_part(v_gift.recipient_email, '@', 1);
  v_domain := split_part(v_gift.recipient_email, '@', 2);
  v_masked := left(v_local, 1) || repeat('•', greatest(length(v_local) - 1, 1)) || '@' || v_domain;

  return jsonb_build_object(
    'token',           v_token,                       -- for the email only
    'recipient_email', v_gift.recipient_email,        -- for the email only
    'masked_email',    v_masked,
    'gift_id',         v_gift.id,
    'expires_at',      v_expiry
  );
end;
$$;

revoke all on function public.issue_gift_recipient_challenge(text, uuid) from public, anon, authenticated;
grant execute on function public.issue_gift_recipient_challenge(text, uuid) to service_role;

-- ── Confirm a challenge ────────────────────────────────────────────────────
-- Safe to call directly: it consumes a code the caller received by email and
-- binds the result to auth.uid(), which the client cannot forge.
create or replace function public.confirm_gift_recipient_verification(p_code text, p_token text)
returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_gift uuid;
  v_row  public.gift_recipient_verifications%rowtype;
begin
  if v_user is null then raise exception 'auth_required'; end if;
  if p_token is null or btrim(p_token) = '' then raise exception 'verification_invalid'; end if;

  select id into v_gift from public.book_gifts where code = p_code;
  if v_gift is null then raise exception 'gift_not_found'; end if;

  -- Locked: two submissions of the same code cannot both consume it.
  select * into v_row
    from public.gift_recipient_verifications
   where gift_id = v_gift and user_id = v_user and consumed_at is null
   order by created_at desc
   limit 1
   for update;

  if not found                    then raise exception 'verification_not_found'; end if;
  if v_row.expires_at < now()     then raise exception 'verification_expired';   end if;
  if v_row.attempts >= 5          then raise exception 'verification_locked';    end if;

  if v_row.token_hash <> encode(extensions.digest(upper(btrim(p_token)), 'sha256'), 'hex') then
    update public.gift_recipient_verifications set attempts = attempts + 1 where id = v_row.id;
    raise exception 'verification_invalid';
  end if;

  update public.gift_recipient_verifications
     set consumed_at = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'gift_id', v_gift);
end;
$$;

revoke all on function public.confirm_gift_recipient_verification(text, text) from public, anon;
grant execute on function public.confirm_gift_recipient_verification(text, text) to authenticated, service_role;

-- ── What should the screen offer? ──────────────────────────────────────────
-- One call, so the UI never has to reason about identity itself. Says nothing
-- about whether the masked address belongs to an existing account.
create or replace function public.gift_claim_eligibility(p_code text)
returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_gift   public.book_gifts%rowtype;
  v_email  text;
  v_local  text;
  v_domain text;
  v_masked text;
  v_state  text;
begin
  select * into v_gift from public.book_gifts where code = p_code;
  if not found or v_gift.status = 'pending_payment' then
    return jsonb_build_object('state', 'gift_not_found');
  end if;

  if v_gift.recipient_email is not null and btrim(v_gift.recipient_email) <> '' then
    v_local  := split_part(v_gift.recipient_email, '@', 1);
    v_domain := split_part(v_gift.recipient_email, '@', 2);
    v_masked := left(v_local, 1) || repeat('•', greatest(length(v_local) - 1, 1)) || '@' || v_domain;
  end if;

  if v_user is null then
    v_state := 'sign_in_required';
  elsif v_gift.status = 'cancelled' then
    v_state := 'gift_cancelled';
  elsif v_gift.expires_at is not null and v_gift.expires_at < now() then
    v_state := 'gift_expired';
  elsif v_gift.claimed_by_user_id = v_user then
    v_state := 'already_yours';
  elsif v_gift.claimed_by_user_id is not null then
    v_state := 'gift_already_claimed';
  else
    select lower(btrim(u.email)) into v_email
      from auth.users u where u.id = v_user and u.email_confirmed_at is not null;

    if v_email is not null and v_email = lower(btrim(v_gift.recipient_email)) then
      v_state := 'can_claim';
    elsif exists (
      select 1 from public.gift_recipient_verifications v
       where v.gift_id = v_gift.id and v.user_id = v_user and v.consumed_at is not null
    ) then
      v_state := 'can_claim';
    else
      v_state := 'verification_required';
    end if;
  end if;

  return jsonb_build_object('state', v_state, 'masked_email', v_masked);
end;
$$;

revoke all on function public.gift_claim_eligibility(text) from public;
grant execute on function public.gift_claim_eligibility(text) to anon, authenticated, service_role;

-- ── The claim itself ───────────────────────────────────────────────────────
-- Unchanged except for the recipient gate: still auth-required, still
-- SELECT ... FOR UPDATE, still one claimer, still the same state checks, and
-- unit gifts still spawn their purchase idempotently.
create or replace function public.claim_gift(p_code text)
returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
DECLARE
  v_gift      public.book_gifts%ROWTYPE;
  v_item      public.book_unit_items%ROWTYPE;
  v_purchase  public.book_unit_purchases%ROWTYPE;
  v_user_id   UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  SELECT * INTO v_gift FROM public.book_gifts WHERE code = p_code FOR UPDATE;

  IF NOT FOUND                                        THEN RAISE EXCEPTION 'gift_not_found';      END IF;
  IF v_gift.status = 'pending_payment'                THEN RAISE EXCEPTION 'gift_not_paid';       END IF;
  IF v_gift.status = 'cancelled'                      THEN RAISE EXCEPTION 'gift_cancelled';      END IF;
  IF v_gift.expires_at IS NOT NULL
       AND v_gift.expires_at < NOW()                  THEN RAISE EXCEPTION 'gift_expired';        END IF;
  IF v_gift.claimed_by_user_id IS NOT NULL
       AND v_gift.claimed_by_user_id <> v_user_id     THEN RAISE EXCEPTION 'gift_already_claimed';END IF;

  -- Who is allowed to take this gift. Holding the link is not enough: a
  -- forwarded URL reaches the preview and stops there. Re-claiming your own
  -- gift skips the gate, so a retry cannot lock you out of what you already own.
  IF v_gift.claimed_by_user_id IS NULL
       AND NOT public.gift_recipient_ok(v_gift.id, v_user_id) THEN
    RAISE EXCEPTION 'gift_recipient_verification_required';
  END IF;

  -- First-time claim → mark claimed
  IF v_gift.claimed_by_user_id IS NULL THEN
    UPDATE public.book_gifts
       SET claimed_at = NOW(),
           claimed_by_user_id = v_user_id,
           status = 'claimed'
     WHERE id = v_gift.id
    RETURNING * INTO v_gift;
  END IF;

  -- Unit gifts spawn a purchase immediately (idempotent)
  IF v_gift.kind = 'unit' THEN
    SELECT * INTO v_purchase
      FROM public.book_unit_purchases
     WHERE gift_id = v_gift.id;

    IF NOT FOUND THEN
      SELECT * INTO v_item FROM public.book_unit_items WHERE id = v_gift.unit_item_id;

      INSERT INTO public.book_unit_purchases (
        item_id, business_id, owner_id, paid_amount_pence,
        uses_remaining, gift_id, expires_at
      ) VALUES (
        v_item.id, v_item.business_id, v_user_id, v_gift.price_paid_pence,
        v_item.uses_per_purchase, v_gift.id,
        CASE WHEN v_item.valid_days IS NOT NULL
             THEN NOW() + (v_item.valid_days || ' days')::interval
        END
      )
      RETURNING * INTO v_purchase;

      UPDATE public.book_gifts
         SET used_at = NOW(), status = 'used'
       WHERE id = v_gift.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'gift_id',          v_gift.id,
    'kind',             v_gift.kind,
    'business_id',      v_gift.business_id,
    'unit_item_id',     v_gift.unit_item_id,
    'service_id',       v_gift.service_id,
    'unit_purchase_id', v_purchase.id,
    'claimed_at',       v_gift.claimed_at,
    'used_at',          v_gift.used_at
  );
END;
$$;

-- ── Abuse ceilings for the challenge ───────────────────────────────────────
insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('gift_verify_send', 3600, 6,  'recipient-email challenges a signed-in user may trigger per hour — each one sends mail to somebody else'),
  ('gift_verify_any',  3600, 10, 'aggregate ceiling across gift verification routes')
on conflict (action) do nothing;

-- ── The email that carries the code ────────────────────────────────────────
insert into public.email_templates (key, category, label, description, enabled, subject, body_html, variables, requires_optin, postmark_stream)
values (
  'local.gift_verify_recipient', 'local', 'Gift — verify recipient email',
  'One-time code proving the signed-in user controls the address a gift was sent to',
  true,
  'Your OneShetland gift code: {{token}}',
  '<p>Hi{{recipient_name_suffix}},</p>'
  '<p>Somebody signed in to OneShetland is trying to claim the gift sent to this email address'
  '{{item_clause}}. If that was you, enter this code to add it to your account:</p>'
  '<p style="font-size:28px;font-weight:800;letter-spacing:4px;margin:20px 0">{{token}}</p>'
  '<p>The code expires in 15 minutes and can only be used once.</p>'
  '<p style="color:#6b7280;font-size:13px">If this wasn''t you, you can ignore this email — '
  'the gift stays where it is and nothing has been claimed.</p>',
  array['token', 'recipient_name_suffix', 'item_clause'],
  false, 'outbound'
)
on conflict (key) do nothing;

commit;
