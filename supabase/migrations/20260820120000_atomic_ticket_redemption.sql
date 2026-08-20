-- ============================================================================
-- Ticket redemption becomes atomic, authorised and event-scoped.
--
-- WHAT WAS WRONG
--
-- 1. THE RACE (C4). validate_and_checkin_ticket read the ticket with a plain
--    SELECT (no FOR UPDATE), decided in plpgsql whether it was redeemable, then
--    issued an UPDATE with no status predicate. Two entrances scanning the same
--    QR both read status='valid' before either wrote, and both then wrote.
--    Reproduced on 2026-08-20 against production: one ticket, two connections,
--    TWO result='valid' rows in event_checkins and two different scanner ids.
--    The attendee was admitted twice and checked_in_by named the loser.
--
-- 2. AUTHORISATION FAILED OPEN. Both redemption functions asked:
--
--        SELECT lb.owner_id = p_scanner_id INTO owns_event
--          FROM events e JOIN local_businesses lb ON lb.id = e.organiser_business_id
--         WHERE e.id = ticket.event_id;
--        IF NOT owns_event ... THEN reject
--
--    For a user-organised or hub-organised event organiser_business_id is NULL,
--    the join matches no row, owns_event stays NULL, and `NOT NULL` is NULL —
--    so the rejection branch never runs and execution falls through to the
--    redemption. 43 of the 53 real tickets in production belong to
--    user-organised events, so this was the majority case, not a corner.
--
-- 3. BACKUP CODES WERE LOOKED UP GLOBALLY. validate_backup_code matched on the
--    code alone across every event, so one event's scanner could resolve — and
--    probe for — another event's codes.
--
-- 4. NOTHING BOUNDED GUESSING. A backup code is 8 characters from a 31-letter
--    alphabet and there was no limit on how many could be tried.
--
-- 5. THE GENERATOR MADE SHORT CODES. The alphabet is 31 characters but the
--    generator drew substr(alphabet, floor(random()*32+1), 1) — index 32
--    returns the empty string, so each position had a 1-in-32 chance of
--    contributing nothing and (31/32)^8 = 77.6% of codes were full length.
--    About 22% were short, exactly as the audit predicted.
--
-- WHAT REPLACES IT
--
-- One authoritative redemption function, redeem_ticket_atomic, is the only
-- thing in the system that may turn a ticket into an admission. The three
-- entry points (raw token, ticket id, backup code) now do nothing but resolve
-- which ticket is meant and hand over. There is one copy of the rule, so the
-- copies cannot drift apart.
--
-- The single-use invariant is owned by PostgreSQL, not by plpgsql control flow:
--
--        UPDATE event_tickets
--           SET status='used', checked_in_at=now(), checked_in_by=<scanner>
--         WHERE id=<ticket> AND event_id=<expected event> AND status='valid'
--        RETURNING ...
--
-- Under READ COMMITTED the second transaction blocks on the first one's row
-- lock and, when it is released, re-evaluates the WHERE clause against the
-- committed new version of the row. status is no longer 'valid', so it matches
-- zero rows. One winner, always, with no advisory lock and no retry loop.
--
-- Zero rows is not an error, it is a question — the function then re-reads the
-- row to say WHY (already used, cancelled, refunded, unpaid, wrong event, no
-- such ticket) rather than collapsing every failure into one answer.
-- ============================================================================


-- ── Who may scan this event ─────────────────────────────────────────────────
--
-- Deliberately written as a ladder of positive grants over an authorised flag
-- that starts false, rather than as a chain of negations. Every branch requires
-- its organiser column to be NOT NULL before it can grant anything, so a NULL
-- organiser cannot satisfy a test, and an event with no organiser at all (there
-- are 51 such imported events in production) is scannable by nobody but a
-- platform admin. No branch can return NULL: the function returns false or true.
--
-- No new role is invented here. These are the four organiser shapes the schema
-- already models, and the hub test is the same rule is_hub_admin already used.
create or replace function public.can_scan_event(
  p_event_id uuid,
  p_user_id  uuid
) returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_event public.events%rowtype;
begin
  if p_event_id is null or p_user_id is null then
    return false;
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    return false;
  end if;

  -- Platform admin. Matches is_admin()'s rule, including is_platform_owner,
  -- which the edge function's own check used to miss.
  if exists (
    select 1 from public.profiles
     where id = p_user_id
       and (role = 'admin' or is_platform_owner is true)
  ) then
    return true;
  end if;

  -- The person who organised it.
  if v_event.organiser_user_id is not null
     and v_event.organiser_user_id = p_user_id then
    return true;
  end if;

  -- The owner of the organising business.
  if v_event.organiser_business_id is not null and exists (
    select 1 from public.local_businesses
     where id = v_event.organiser_business_id
       and owner_id is not null
       and owner_id = p_user_id
  ) then
    return true;
  end if;

  -- An owner or committee member of the organising hub. Ordinary hub members
  -- are NOT scanners: joining a hub must not confer admission control.
  if v_event.organiser_hub_id is not null and exists (
    select 1 from public.hub_members
     where hub_id  = v_event.organiser_hub_id
       and user_id = p_user_id
       and status  = 'active'
       and role in ('owner', 'committee')
  ) then
    return true;
  end if;

  return false;
end;
$$;

comment on function public.can_scan_event(uuid, uuid) is
  'True only if this user is genuinely entitled to scan tickets for this event: platform admin, the organiser_user, the owner of the organiser_business, or an active owner/committee member of the organiser_hub. Fails closed — a NULL organiser column can never authorise anyone, and an event with no organiser is scannable only by a platform admin.';


-- ── A bound on backup-code guessing ─────────────────────────────────────────
--
-- QR tokens are SHA-256 hashes of high-entropy secrets and are not guessable,
-- so the token path is deliberately NOT throttled: a busy entrance may scan
-- hundreds of genuine tickets in a few minutes and must never be turned away.
-- Backup codes are eight characters typed by hand, so the manual path is where
-- guessing is even theoretically possible, and that is what this bounds.
--
-- The counter reads event_checkins, which already records every failed scan —
-- no new table, and the limit is per (scanner, event) so one door's mistyping
-- cannot lock out another door. A rate-limited attempt is deliberately NOT
-- logged: an attacker must not be able to inflate the very table that measures
-- them. A burst shows up as a run of not_found rows, which is the signal to
-- look at.
create or replace function public.scan_attempt_limit_exceeded(
  p_scanner_id uuid,
  p_event_id   uuid,
  p_window     interval default interval '10 minutes',
  p_max_misses integer  default 20
) returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select count(*) >= p_max_misses
    from public.event_checkins
   where scanner_id = p_scanner_id
     and event_id   = p_event_id
     and result     = 'not_found'
     and scanned_at > now() - p_window;
$$;

comment on function public.scan_attempt_limit_exceeded(uuid, uuid, interval, integer) is
  'True when this scanner has already produced p_max_misses not_found results for this event inside p_window. Applied to the hand-typed backup-code path only; QR tokens are unguessable and are not throttled so a busy entrance is never blocked.';

-- Supports the window count above without scanning the whole audit table.
create index if not exists idx_checkins_scanner_event_time
  on public.event_checkins (scanner_id, event_id, scanned_at desc)
  where result = 'not_found';


-- ── One successful redemption, one audit row ────────────────────────────────
--
-- Belt and braces behind the atomic UPDATE. If any future code path ever tries
-- to log a second admission for a ticket, the insert raises and takes its whole
-- transaction — including the ticket update — down with it. Failing a scan is
-- recoverable; admitting one person twice is not.
--
-- Partial, so the many legitimate already_used / wrong_event / not_found rows
-- are unaffected. Verified against production before creating: 5 used tickets,
-- 5 valid check-ins, zero duplicates.
create unique index if not exists event_checkins_one_valid_per_ticket
  on public.event_checkins (ticket_id)
  where result = 'valid' and ticket_id is not null;


-- ── The only thing that may admit an attendee ───────────────────────────────
create or replace function public.redeem_ticket_atomic(
  p_ticket_id  uuid,
  p_event_id   uuid,
  p_scanner_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_ticket public.event_tickets%rowtype;
  v_seen   public.event_tickets%rowtype;
begin
  -- Re-checked here even though every caller has already checked. This is the
  -- choke point; it must not depend on its callers being correct.
  if not public.can_scan_event(p_event_id, p_scanner_id) then
    return jsonb_build_object(
      'result',  'not_authorised',
      'message', 'You are not authorised to scan tickets for this event.'
    );
  end if;

  if p_ticket_id is null then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (null, p_event_id, p_scanner_id, 'not_found');
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── The whole single-use invariant, in one statement ─────────────────────
  -- A concurrent scan blocks here and, on release, re-tests status against the
  -- committed row. The loser matches zero rows. There is no window between the
  -- test and the write because they are the same operation.
  update public.event_tickets
     set status        = 'used',
         checked_in_at = now(),
         checked_in_by = p_scanner_id
   where id       = p_ticket_id
     and event_id = p_event_id          -- Event A's ticket cannot pass at Event B
     and status   = 'valid'             -- and only a live ticket may be spent
  returning * into v_ticket;

  if found then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (v_ticket.id, p_event_id, p_scanner_id, 'valid');

    return jsonb_build_object(
      'result',         'valid',
      'ticket_id',      v_ticket.id,
      'attendee_name',  v_ticket.attendee_name,
      'ticket_type_id', v_ticket.ticket_type_id,
      'price_pence',    v_ticket.price_pence,
      'event_snapshot', v_ticket.event_snapshot
    );
  end if;

  -- ── Zero rows. Find out why, and say so precisely. ───────────────────────
  select * into v_seen from public.event_tickets where id = p_ticket_id;

  if not found then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (null, p_event_id, p_scanner_id, 'not_found');
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_seen.event_id is distinct from p_event_id then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (v_seen.id, p_event_id, p_scanner_id, 'wrong_event');
    return jsonb_build_object(
      'result',  'wrong_event',
      'message', 'This ticket is not for this event.'
    );
  end if;

  if v_seen.status = 'used' then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (v_seen.id, p_event_id, p_scanner_id, 'already_used');
    -- checked_in_at is what the door needs to resolve a dispute. The winning
    -- scanner's identity is deliberately not returned: it is in the audit
    -- trail for the organiser, not on a handset at the entrance.
    return jsonb_build_object(
      'result',        'already_used',
      'ticket_id',     v_seen.id,
      'checked_in_at', v_seen.checked_in_at,
      'attendee_name', v_seen.attendee_name
    );
  end if;

  if v_seen.status = 'pending_payment' then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (v_seen.id, p_event_id, p_scanner_id, 'payment_incomplete');
    return jsonb_build_object('result', 'payment_incomplete');
  end if;

  if v_seen.status in ('cancelled', 'refunded') then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (v_seen.id, p_event_id, p_scanner_id, v_seen.status);
    return jsonb_build_object('result', v_seen.status);
  end if;

  -- Unreachable against the current status CHECK constraint. If a new status
  -- is ever added, this refuses rather than guessing — a ticket in a state
  -- nobody taught this function about must not open a door.
  insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
  values (v_seen.id, p_event_id, p_scanner_id, 'invalid_token');
  return jsonb_build_object('result', 'invalid_token', 'message', 'This ticket cannot be admitted.');
end;
$$;

comment on function public.redeem_ticket_atomic(uuid, uuid, uuid) is
  'The single authoritative ticket redemption. Authorises the scanner for the event, then spends the ticket with one conditional UPDATE gated on (id, event_id, status=valid) so exactly one of any number of concurrent scans can win. Writes exactly one result=valid audit row for the winner and a precise failure row for everyone else. service_role only.';


-- ── Entry point: a scanned QR token ─────────────────────────────────────────
--
-- The token is a SHA-256 hash of an unguessable secret, so the lookup stays
-- global on purpose: that is what lets a genuine organiser who opened the wrong
-- door be told "wrong event" instead of the useless "no such ticket". Event
-- equality is still enforced, but by the atomic UPDATE, where it belongs.
create or replace function public.validate_and_checkin_ticket(
  p_raw_token  text,
  p_event_id   uuid,
  p_scanner_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_ticket_id uuid;
begin
  -- Authorise before touching anything, so an unauthorised caller cannot use
  -- this as an oracle for which tokens exist, nor write rows into the audit log.
  if not public.can_scan_event(p_event_id, p_scanner_id) then
    return jsonb_build_object(
      'result',  'not_authorised',
      'message', 'You are not authorised to scan tickets for this event.'
    );
  end if;

  if p_raw_token is null or btrim(p_raw_token) = '' then
    return jsonb_build_object('result', 'invalid_token');
  end if;

  select id into v_ticket_id
    from public.event_tickets
   where validation_token_hash = encode(sha256(p_raw_token::bytea), 'hex');

  if not found then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (null, p_event_id, p_scanner_id, 'not_found');
    return jsonb_build_object('result', 'not_found');
  end if;

  return public.redeem_ticket_atomic(v_ticket_id, p_event_id, p_scanner_id);
end;
$$;

comment on function public.validate_and_checkin_ticket(text, uuid, uuid) is
  'Resolves a scanned QR token to a ticket and redeems it through redeem_ticket_atomic. Authorises the scanner first. service_role only.';


-- ── Entry point: a ticket id ────────────────────────────────────────────────
--
-- This exists only as an internal helper — it is how backup-code redemption
-- reached the redemption logic. No client in either repository calls it, and it
-- must stay that way: exposing it would let anyone holding a ticket UUID be
-- admitted without possessing the token or the code. Kept as a thin wrapper so
-- anything that does call it cannot get a second, divergent implementation.
create or replace function public.validate_and_checkin_ticket_by_id(
  p_ticket_id  uuid,
  p_event_id   uuid,
  p_scanner_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  return public.redeem_ticket_atomic(p_ticket_id, p_event_id, p_scanner_id);
end;
$$;

comment on function public.validate_and_checkin_ticket_by_id(uuid, uuid, uuid) is
  'INTERNAL. Redeems a ticket by id through redeem_ticket_atomic. Never expose to clients: possession of a ticket UUID is not evidence of holding the ticket. service_role only.';


-- ── Entry point: a hand-typed backup code ───────────────────────────────────
--
-- The lookup now requires the event. A code belonging to another event does not
-- resolve at all, so this path cannot be used to discover, confirm or spend
-- codes outside the event being scanned — and the answer is a flat not_found,
-- which tells a prober nothing about whether the code exists elsewhere.
create or replace function public.validate_backup_code(
  p_backup_code text,
  p_event_id    uuid,
  p_scanner_id  uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_ticket_id uuid;
  v_norm      text;
begin
  if not public.can_scan_event(p_event_id, p_scanner_id) then
    return jsonb_build_object(
      'result',  'not_authorised',
      'message', 'You are not authorised to scan tickets for this event.'
    );
  end if;

  if p_backup_code is null or btrim(p_backup_code) = '' then
    return jsonb_build_object('result', 'invalid_token');
  end if;

  -- This is the guessable credential, so this is the path that is bounded.
  if public.scan_attempt_limit_exceeded(p_scanner_id, p_event_id) then
    return jsonb_build_object(
      'result',  'rate_limited',
      'message', 'Too many unrecognised codes. Wait a few minutes and try again.'
    );
  end if;

  -- Stored codes look like "VN27-ZVVQ"; scanners send them de-dashed. Normalise
  -- both sides, and require the event.
  v_norm := regexp_replace(upper(p_backup_code), '[^A-Z0-9]', '', 'g');

  select id into v_ticket_id
    from public.event_tickets
   where event_id = p_event_id
     and regexp_replace(upper(backup_code), '[^A-Z0-9]', '', 'g') = v_norm;

  if not found then
    insert into public.event_checkins (ticket_id, event_id, scanner_id, result)
    values (null, p_event_id, p_scanner_id, 'not_found');
    return jsonb_build_object('result', 'not_found');
  end if;

  return public.redeem_ticket_atomic(v_ticket_id, p_event_id, p_scanner_id);
end;
$$;

comment on function public.validate_backup_code(text, uuid, uuid) is
  'Resolves a hand-typed backup code WITHIN the event being scanned and redeems it through redeem_ticket_atomic. Cross-event lookup is impossible by construction. Rate-limited per scanner per event. service_role only.';


-- ── Backup codes stop coming out short ──────────────────────────────────────
--
-- The alphabet is 31 characters; the old generator drew indices 1..32 and
-- substr() returned '' for 32, so ~22% of issued codes were shorter than the
-- eight characters the format promises. Selection also came from random(),
-- which is a session-seeded PRNG rather than a CSPRNG — acceptable for a
-- shuffle, not for a credential that opens a door.
--
-- Now: indices are drawn from pgcrypto and land in 1..31, always. Bytes 248-255
-- are redrawn rather than folded, because 256 is not a multiple of 31 and
-- folding them would quietly bias the first eight letters of the alphabet.
--
-- BACKWARD COMPATIBLE. Only generation changes. The alphabet, the XXXX-XXXX
-- shape and the length are unchanged, existing codes are not touched, and every
-- code already issued — including the short ones — still redeems exactly as it
-- did. Nothing is reissued.
create or replace function public.generate_ticket_backup_code()
returns text
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 chars: no I, L, O, 0, 1
  n        constant int  := 31;
  limit_   constant int  := 248;   -- 8 * 31, the largest unbiased byte range
  code  text;
  part  text;
  b     int;
  tries int := 0;
begin
  loop
    part := '';
    while length(part) < 8 loop
      -- pgcrypto lives in the extensions schema on Supabase, and search_path is
      -- pinned to public, so this has to be qualified or it will not resolve.
      b := get_byte(extensions.gen_random_bytes(1), 0);
      if b < limit_ then
        part := part || substr(alphabet, (b % n) + 1, 1);
      end if;
    end loop;

    code := substr(part, 1, 4) || '-' || substr(part, 5, 4);
    exit when not exists (select 1 from public.event_tickets where backup_code = code);

    tries := tries + 1;
    if tries > 100 then
      raise exception 'generate_ticket_backup_code: could not find a free code after % attempts', tries;
    end if;
  end loop;

  return code;
end;
$$;

comment on function public.generate_ticket_backup_code() is
  'Generates an XXXX-XXXX backup code from a 31-character ambiguity-free alphabet using pgcrypto with rejection sampling, so every code is exactly 8 characters and uniformly distributed. Replaces a generator that indexed 1..32 into 31 characters and produced a short code about 22% of the time. Existing codes are unaffected and remain redeemable.';


-- ── Scanner statistics stop being public ────────────────────────────────────
--
-- Found while tracing this surface: get_event_scanner_stats is SECURITY DEFINER
-- with EXECUTE granted to PUBLIC and anon, takes an arbitrary event id and
-- performs no authorisation. Confirmed against production — the public anon key
-- returned live ticket_sold counts for a real event over HTTPS. It also read
-- event_tickets unqualified with no pinned search_path.
--
-- It stays callable by signed-in organisers, because the scanner UI in both
-- clients calls it directly, but it now answers only to someone who could scan
-- the event anyway. auth.uid() is the right identity here: unlike the
-- redemption RPCs this one is called by the client, not by the edge function.
create or replace function public.get_event_scanner_stats(p_event_id uuid)
returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
begin
  if not public.can_scan_event(p_event_id, auth.uid()) then
    raise exception 'You are not authorised to view scanner statistics for this event'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'tickets_sold',    coalesce((select count(*) from public.event_tickets where event_id = p_event_id and status in ('valid','used')), 0),
    'checked_in',      coalesce((select count(*) from public.event_tickets where event_id = p_event_id and status = 'used'), 0),
    'pending_payment', coalesce((select count(*) from public.event_tickets where event_id = p_event_id and status = 'pending_payment'), 0)
  );
end;
$$;

comment on function public.get_event_scanner_stats(uuid) is
  'Live sold / checked-in / pending counts for an event, for the people entitled to scan it. Previously answered anyone holding the public anon key.';


-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- Steps 1 and 1B were both caused by a grant nobody restated. CREATE OR REPLACE
-- preserves the existing ACL, and Postgres re-grants EXECUTE to PUBLIC at CREATE
-- time for anything newly created, so every one of these is spelled out. A
-- revoke that names fewer than {public, anon, authenticated} is a no-op in one
-- direction or the other, so all three are always named.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.can_scan_event(uuid, uuid)',
    'public.scan_attempt_limit_exceeded(uuid, uuid, interval, integer)',
    'public.redeem_ticket_atomic(uuid, uuid, uuid)',
    'public.validate_and_checkin_ticket(text, uuid, uuid)',
    'public.validate_and_checkin_ticket_by_id(uuid, uuid, uuid)',
    'public.validate_backup_code(text, uuid, uuid)',
    'public.generate_ticket_backup_code()'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

-- The one exception: the stats reader is called by the signed-in scanner UI in
-- both clients, so authenticated keeps EXECUTE. It is no longer an open door —
-- the function authorises auth.uid() itself. PUBLIC and anon lose it.
revoke all on function public.get_event_scanner_stats(uuid) from public;
revoke all on function public.get_event_scanner_stats(uuid) from anon;
grant execute on function public.get_event_scanner_stats(uuid) to authenticated;
grant execute on function public.get_event_scanner_stats(uuid) to service_role;
