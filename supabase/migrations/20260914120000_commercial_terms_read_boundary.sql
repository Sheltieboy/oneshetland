-- ═══════════════════════════════════════════════════════════════════════════
-- The acceptance question is only ever asked about yourself
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260913120000 added has_accepted_commercial_terms(business, user) so the
-- screens could tell whether to show the acceptance step, and granted it to
-- `authenticated`. That was wrong, and it was mine.
--
-- The function is SECURITY DEFINER, so it reads compliance_log past the RLS
-- policy that otherwise restricts a user to their own rows — and it takes the
-- user as an ARGUMENT with no check on who is asking. Measured:
--
--     signed in as A, asking about B and B's business  →  true
--
-- A truthful answer about somebody else's compliance state. Only a boolean, and
-- it needs both uuids to be known, but it is exactly the disclosure the RLS
-- policy on that table exists to prevent.
--
-- ── The shape it should have had ─────────────────────────────────────────
--
-- Two different callers want two different things, and they were conflated:
--
--   the future write gate  — needs to ask about a SPECIFIED user, because an
--                            RLS predicate hands it auth.uid() explicitly. It
--                            runs inside a trusted function, so it does not
--                            need a client grant at all.
--   a screen               — only ever asks about the person using it, and
--                            should not be able to name anybody else.
--
-- So the two-argument function becomes internal, and a wrapper is added that
-- takes one business id and derives the user from auth.uid(). A caller cannot
-- ask about someone else because there is no parameter for it — the same
-- reasoning as the acceptance writer.
--
-- Nothing about the writer, the policy, the index or the Terms changes here,
-- and no commercial write is gated by any of it yet.

-- ── 1. The two-argument form stops being client-callable ──────────────────
--
-- service_role keeps it for server-side work, and a SECURITY DEFINER caller
-- (which is how the future gate will reach it) executes as the owner, so this
-- revoke does not stand in W3H's way.
revoke execute on function public.has_accepted_commercial_terms(uuid, uuid) from authenticated;

comment on function public.has_accepted_commercial_terms(uuid, uuid) is
  'INTERNAL. Has this user accepted the CURRENT commercial terms for this business? Not granted to authenticated: it is SECURITY DEFINER and takes the user as an argument, so a client holding it could read somebody else''s acceptance state. Screens use my_commercial_terms_status(); the future write gate calls this from inside a trusted function.';

-- ── 2. What a screen may ask ──────────────────────────────────────────────
--
-- One business id. The user is auth.uid() and there is no argument to override
-- it. Ownership is re-checked so this cannot be used to enumerate businesses
-- either, matching record_commercial_terms_acceptance.
create or replace function public.my_commercial_terms_status(p_business_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'A business is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.local_businesses
     where id = p_business_id and owner_id = v_user
  ) then
    raise exception 'You do not own this business' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'accepted', public.has_accepted_commercial_terms(p_business_id, v_user),
    'version',  public.commercial_terms_version()
  );
end;
$$;

comment on function public.my_commercial_terms_status(uuid) is
  'Whether the CALLER has accepted the current commercial terms for a business they own, and which version is current. Derives the user from auth.uid(); there is no parameter for asking about anybody else.';

revoke execute on function public.my_commercial_terms_status(uuid) from public, anon;
grant  execute on function public.my_commercial_terms_status(uuid) to authenticated;
