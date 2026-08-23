-- A gift link opens for the person holding it, and for nobody else.
--
-- WHAT WAS WRONG
--
-- Both clients call a gift preview BEFORE authentication and say so out loud —
-- app/g/[code].tsx: "Public preview — runs even when not signed in, so the user
-- can see what they're about to claim before being asked to log in." The web
-- page does the same, then offers sign-in with ?next=/g/<code>.
--
-- But book_gifts has no public SELECT policy. Its three policies are purchaser,
-- claimer and business owner, all authenticated. So the preview returned
-- nothing for the one visitor it was written for. Not a Step 8 regression —
-- this never worked.
--
-- The obvious repair, a public SELECT policy on book_gifts, is the wrong one.
-- It would let anyone list every gift, every purchaser name and every private
-- message. The access rule here is possession of the code, and a row policy
-- cannot express that without also permitting `select *`.
--
-- TWO CHANGES, AND THE FIRST IS THE IMPORTANT ONE.
--
-- 1. THE CODE BECOMES A CREDENTIAL RATHER THAN A SHUFFLE
--
-- generate_gift_code() drew 8 characters from a 31-character alphabet using
-- random() — Postgres's non-cryptographic PRNG, the same one that orders a
-- playlist. That is ~39.6 bits, and predictable in principle from observed
-- output. Fine while the code was only ever handled by someone already signed
-- in and authorised. Not fine as the sole thing standing between the internet
-- and a stranger's message.
--
-- Now: 14 characters from the same ambiguity-free alphabet, drawn from pgcrypto
-- with rejection sampling — exactly the pattern generate_ticket_backup_code()
-- already uses here, and qualified as extensions.gen_random_bytes because
-- pgcrypto lives in the extensions schema on Supabase. 31^14 ≈ 5.9e20, or
-- ~69.4 bits. Bytes 248-255 are redrawn rather than folded, because 256 is not
-- a multiple of 31 and folding biases the first eight letters.
--
-- Production holds ZERO gift rows, so there are no legacy short codes to keep
-- working and no reissue to perform. Every code that ever exists will be the
-- strong kind. That is the only reason this is a clean change rather than a
-- migration problem, and it is why it is being done now, before Paygate 3.
--
-- 2. A PREVIEW THAT ANSWERS ONE QUESTION
--
-- get_public_gift_preview(code) returns at most one row, only for a gift that
-- has actually been paid for, and only the fields the two claim screens render.
-- No id, no business_id, no unit_item_id, no service_id, no purchaser_id, no
-- recipient email or name, no payment_intent_id, no price, no claimed_by_user_id.
-- The caller already knows the code, so there is nothing to echo back.
--
-- purchaser_name and message ARE returned. They are the substance of the gift —
-- a preview that cannot say who it is from or what they wrote is not a preview —
-- and the purchaser addressed them to whoever holds this link. Possession of a
-- 69-bit code sent to the recipient's email is the consent boundary, and it is
-- the same boundary that already governs claiming.
--
-- book_gifts itself stays exactly as private as it is today. No policy on that
-- table is added, dropped or altered by this migration.

begin;

-- ── 1. The code ────────────────────────────────────────────────────────────
create or replace function public.generate_gift_code()
returns text
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 chars: no I, L, O, 0, 1
  n        constant int  := 31;
  limit_   constant int  := 248;  -- 8 * 31, the largest unbiased byte range
  len      constant int  := 14;   -- 31^14 ~= 5.9e20, ~69.4 bits
  candidate text;
  b         int;
  tries     int := 0;
begin
  loop
    candidate := '';
    while length(candidate) < len loop
      b := get_byte(extensions.gen_random_bytes(1), 0);
      if b < limit_ then
        candidate := candidate || substr(alphabet, (b % n) + 1, 1);
      end if;
    end loop;

    exit when not exists (select 1 from public.book_gifts where code = candidate);

    tries := tries + 1;
    if tries > 100 then
      raise exception 'generate_gift_code: could not find a free code after % attempts', tries;
    end if;
  end loop;

  return candidate;
end;
$$;

comment on function public.generate_gift_code() is
  'Generates a 14-character gift code from a 31-character ambiguity-free alphabet using pgcrypto with rejection sampling (~69.4 bits). Replaces an 8-character random() generator (~39.6 bits) that was not safe to treat as a bearer token. The code is the only credential guarding get_public_gift_preview.';

-- Only the server issues gift codes. confirm-gift and _shared/fulfilment.ts
-- both call this with the service role; anon and authenticated never did.
revoke all on function public.generate_gift_code() from public, anon, authenticated;
grant execute on function public.generate_gift_code() to service_role;

-- ── 2. The preview ─────────────────────────────────────────────────────────
create or replace function public.get_public_gift_preview(p_code text)
returns table (
  kind           text,
  status         text,
  business_name  text,
  item_name      text,
  purchaser_name text,
  message        text,
  expires_at     timestamptz
)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select
    g.kind,
    g.status,
    coalesce(b.name, 'OneShetland'),
    case when g.kind = 'unit'
         then coalesce(ui.name, 'a pass')
         else coalesce(sv.name, 'a booking') end,
    g.purchaser_name,
    g.message,
    g.expires_at
  from public.book_gifts g
  left join public.local_businesses b  on b.id  = g.business_id
  left join public.book_unit_items  ui on ui.id = g.unit_item_id
  left join public.book_services    sv on sv.id = g.service_id
  -- An exact match on the full code. A short or empty probe matches nothing
  -- rather than returning the first row that happens to prefix-match.
  where p_code is not null
    and length(p_code) >= 8
    and g.code = p_code
    -- A gift whose payment never completed is not a gift yet.
    and g.status <> 'pending_payment'
  limit 1;
$$;

comment on function public.get_public_gift_preview(text) is
  'The signed-out preview behind a /g/<code> link. Possession of the 14-character code is the access rule, so this is deliberately reachable by anon. Returns at most one row and only the fields the claim screens render — never an id, a purchaser/recipient identity, or any payment field. Claiming remains claim_gift(), which requires auth.uid().';

revoke all on function public.get_public_gift_preview(text) from public;
grant execute on function public.get_public_gift_preview(text) to anon, authenticated, service_role;

commit;
