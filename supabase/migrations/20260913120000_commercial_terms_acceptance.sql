-- ═══════════════════════════════════════════════════════════════════════════
-- Accepting the business & selling terms, provably
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A business will soon have to accept the commercial section of the Terms
-- before it can sell, take bookings or accept payments. That gate is NOT built
-- here — this migration only makes the acceptance RECORD trustworthy enough to
-- gate on later.
--
-- ── Why a record alone was not enough ─────────────────────────────────────
--
-- compliance_log's insert policy is `user_id = auth.uid()`, and every existing
-- writer is an authenticated client — there is no service-role writer anywhere
-- in the product. Measured in a rolled-back transaction: a signed-in owner can
-- POST straight to PostgREST and manufacture
--
--     event_type       business.commercial_terms_accepted
--     document_version <the current one>
--     metadata         {"business_id": <a business they own>}
--
-- with no UI and no RPC. A gate reading that row would be satisfied by a row
-- the seller wrote themselves. An acceptance function on its own would not
-- have fixed it; it would have been the polite route past an open door.
--
-- Three things are therefore needed together, and each is useless alone:
--
--   1. the policy refuses ONE event type to clients;
--   2. a SECURITY DEFINER writer is the only thing that can create it;
--   3. a partial unique index makes it idempotent under concurrency, because
--      the writer's check-then-insert has a race window on its own.
--
-- What this cannot do, and does not claim: prove somebody read the document.
-- It proves who accepted, which version, for which business, and when — and
-- that the row was written by the server rather than typed by the client.

-- ── The one canonical version ──────────────────────────────────────────────
--
-- The database is the source of truth. The web and app constants exist only to
-- render the right document, and a test pins them to this value so the three
-- cannot drift apart. "1.0" matches the existing TERMS_VERSION / PRIVACY_VERSION
-- convention.
create or replace function public.commercial_terms_version()
  returns text language sql immutable
as $$ select '1.0'::text $$;

comment on function public.commercial_terms_version() is
  'The current version of the "Businesses & selling on OneShetland" terms. One source of truth: the acceptance writer stamps it, and the clients only display it.';

grant execute on function public.commercial_terms_version() to anon, authenticated, service_role;

-- ── 1. One event type stops being client-writable ─────────────────────────
--
-- Deliberately the narrowest possible change: the rule is still
-- `user_id = auth.uid()`, with a single value carved out. Every one of the
-- fourteen event types the product actually writes — terms.accepted,
-- privacy.accepted, age.confirmed, marketing.*, password.changed,
-- email.verified, driver.terms_accepted, fetch.liability_ack,
-- payment.method_added and the rest — is unaffected, because none of them is
-- this one. Removing authenticated insert altogether would have broken signup.
drop policy if exists "Users insert own compliance records" on public.compliance_log;

create policy "Users insert own compliance records" on public.compliance_log
  for insert to public
  with check (
    user_id = auth.uid()
    and event_type <> 'business.commercial_terms_accepted'
  );

-- There is deliberately no UPDATE or DELETE policy on this table, so a client
-- cannot insert an innocent event and later mutate it into the protected one.
-- That absence is load-bearing; do not add one without re-reading this.

-- ── 2. The only thing that may write it ───────────────────────────────────
--
-- Takes ONE argument. No user id, no event type, no version — a caller cannot
-- supply what does not exist as a parameter. It works despite the policy above
-- because the function owner owns the table and FORCE ROW LEVEL SECURITY is
-- off; that was verified before this was written, not assumed.
create or replace function public.record_commercial_terms_acceptance(p_business_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_version text := public.commercial_terms_version();
  v_email   text;
  v_id      uuid;
begin
  if v_user is null then
    raise exception 'You must be signed in to accept these terms' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'A business is required' using errcode = '22023';
  end if;

  -- Ownership is re-checked here, inside the trusted function, rather than
  -- trusted from whatever screen called it.
  if not exists (
    select 1 from public.local_businesses
     where id = p_business_id and owner_id = v_user
  ) then
    raise exception 'You do not own this business' using errcode = '42501';
  end if;

  select id into v_id from public.compliance_log
   where event_type = 'business.commercial_terms_accepted'
     and user_id = v_user
     and document_version = v_version
     and metadata->>'business_id' = p_business_id::text
   limit 1;
  if found then
    return jsonb_build_object('ok', true, 'already', true, 'version', v_version);
  end if;

  select email into v_email from auth.users where id = v_user;

  begin
    insert into public.compliance_log
      (user_id, user_email, event_type, document_version, description, metadata)
    values
      (v_user, coalesce(v_email, ''), 'business.commercial_terms_accepted', v_version,
       'Accepted the business & selling terms',
       jsonb_build_object('business_id', p_business_id::text, 'screen', 'commercial-terms'));
  exception when unique_violation then
    -- Another call got there first. That is a success for the caller, not a
    -- 500 — the index is what makes concurrent acceptance safe, and this is
    -- what makes it read honestly.
    return jsonb_build_object('ok', true, 'already', true, 'version', v_version);
  end;

  return jsonb_build_object('ok', true, 'already', false, 'version', v_version);
end;
$$;

comment on function public.record_commercial_terms_acceptance(uuid) is
  'The only way a business commercial-terms acceptance can be recorded. Derives the user from auth.uid(), stamps the server-held version, and refuses a business the caller does not own. Idempotent per user + business + version.';

revoke execute on function public.record_commercial_terms_acceptance(uuid) from public, anon;
grant  execute on function public.record_commercial_terms_acceptance(uuid) to authenticated;

-- ── 3. One acceptance per user, business and version ──────────────────────
--
-- The guarantee, not a nicety: the lookup above is a check-then-insert with a
-- race window, and two simultaneous taps would otherwise write two rows. The
-- partial predicate keeps the rest of the table entirely unaffected, and this
-- is also the index the eventual gate will read.
create unique index if not exists compliance_log_commercial_terms_once
  on public.compliance_log (user_id, document_version, (metadata->>'business_id'))
  where event_type = 'business.commercial_terms_accepted';

-- ── 4. Reading the answer ─────────────────────────────────────────────────
--
-- NOT wired to anything. No RLS policy is changed by this migration beyond the
-- compliance_log insert rule above — products, offers, services, units,
-- availability, shipping, loyalty, events and local_businesses are all
-- untouched, and no commercial write is gated yet. This exists so the screens
-- can ask whether to show the acceptance step, and so the later gate has one
-- definition to build on rather than inventing a second.
create or replace function public.has_accepted_commercial_terms(
  p_business_id uuid,
  p_user_id     uuid default null
) returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.compliance_log
     where event_type      = 'business.commercial_terms_accepted'
       and user_id         = coalesce(p_user_id, auth.uid())
       and document_version = public.commercial_terms_version()
       and metadata->>'business_id' = p_business_id::text
  );
$$;

comment on function public.has_accepted_commercial_terms(uuid, uuid) is
  'Has this user accepted the CURRENT commercial terms for this business? Read-only, and deliberately not yet consulted by any policy — the commercial-write gate is a separate piece of work.';

revoke execute on function public.has_accepted_commercial_terms(uuid, uuid) from public, anon;
grant  execute on function public.has_accepted_commercial_terms(uuid, uuid) to authenticated, service_role;
