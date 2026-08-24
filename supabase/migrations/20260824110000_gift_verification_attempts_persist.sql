-- The attempt counter has to survive the wrong answer.
--
-- 20260824100000 raised an exception on a wrong code:
--
--     update gift_recipient_verifications set attempts = attempts + 1 ...;
--     raise exception 'verification_invalid';
--
-- The RAISE rolls the whole statement back, INCLUDING the increment. attempts
-- never left 0, `attempts >= 5` never became true, and the lock was decorative
-- — a caller could sit and guess the 8-character code for as long as the
-- 15-minute window lasted. Caught by walking six wrong guesses through it in
-- production and watching the sixth still answer "verification_invalid".
--
-- Countable outcomes are now RETURNED rather than raised, so the transaction
-- commits and the increment sticks. auth_required still raises: it is a
-- caller error, not a failed attempt, and counting it would let a signed-out
-- client burn somebody else's allowance.
--
-- The shape changes from "throws on failure" to "{ ok, error, attempts_left }".
-- No client has shipped against the old shape yet, and attempts_left is what
-- the screen wants to say anyway.

begin;

create or replace function public.confirm_gift_recipient_verification(p_code text, p_token text)
returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  max_attempts constant int := 5;
  v_user uuid := auth.uid();
  v_gift uuid;
  v_row  public.gift_recipient_verifications%rowtype;
begin
  if v_user is null then raise exception 'auth_required'; end if;

  select id into v_gift from public.book_gifts where code = p_code;
  if v_gift is null then
    return jsonb_build_object('ok', false, 'error', 'verification_not_found');
  end if;

  -- Locked: two submissions of the same code cannot both consume it.
  select * into v_row
    from public.gift_recipient_verifications
   where gift_id = v_gift and user_id = v_user and consumed_at is null
   order by created_at desc
   limit 1
   for update;

  -- One answer for "no challenge", "wrong gift" and "already used", so a
  -- caller learns nothing from the difference.
  if not found then
    return jsonb_build_object('ok', false, 'error', 'verification_not_found');
  end if;
  if v_row.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'verification_expired');
  end if;
  if v_row.attempts >= max_attempts then
    return jsonb_build_object('ok', false, 'error', 'verification_locked');
  end if;

  if p_token is null
     or v_row.token_hash <> encode(extensions.digest(upper(btrim(p_token)), 'sha256'), 'hex') then
    update public.gift_recipient_verifications
       set attempts = attempts + 1
     where id = v_row.id;
    return jsonb_build_object(
      'ok', false,
      'error', case when v_row.attempts + 1 >= max_attempts
                    then 'verification_locked' else 'verification_invalid' end,
      'attempts_left', greatest(0, max_attempts - (v_row.attempts + 1))
    );
  end if;

  update public.gift_recipient_verifications
     set consumed_at = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'gift_id', v_gift);
end;
$$;

revoke all on function public.confirm_gift_recipient_verification(text, text) from public, anon;
grant execute on function public.confirm_gift_recipient_verification(text, text) to authenticated, service_role;

comment on function public.confirm_gift_recipient_verification(text, text) is
  'Consumes a one-time recipient-email code, binding the proof to (gift, auth.uid()). Returns { ok, error, attempts_left } rather than raising, so a wrong guess actually increments the attempt counter instead of rolling it back. Five wrong answers lock the challenge.';

commit;
