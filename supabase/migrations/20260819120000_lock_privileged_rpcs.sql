-- ============================================================================
-- Six privileged RPCs were callable by anyone holding the public anon key.
--
-- All six are SECURITY DEFINER, so they run as `postgres` and bypass RLS by
-- design. All six were granted to PUBLIC, anon and authenticated. And the four
-- that need to know WHO is acting take that identity as a PARAMETER rather than
-- reading auth.uid() — so the parameter is simply whatever the caller says it
-- is. The authorisation the edge functions perform above them is real, but it
-- was optional: PostgREST publishes every one of these at /rest/v1/rpc/<name>
-- and answers the anon key directly.
--
--   validate_and_checkin_ticket        burn any ticket, read attendee PII,
--   validate_and_checkin_ticket_by_id  and write a forged scanner id into
--   validate_backup_code               event_checkins as the audit trail
--
--   activate_hub_membership            grant a paid hub membership, to anyone,
--                                      for any period, with no payment — which
--                                      also opens every is_hub_member policy
--
--   record_hub_donation                insert donations that never happened,
--                                      inflating a public fundraising total,
--                                      and write Gift Aid declarations (name,
--                                      address, postcode) nobody made
--
--   increment_event_tickets_sold       set any event's public sold counter to
--                                      any value, in either direction
--
-- Every legitimate caller is an edge function holding the service role. There
-- is no client call site for any of the six in either repository — verified
-- across oneshetland-delivers (app/, components/, lib/) and oneshetland-web
-- (app/, components/, lib/). So revoking client execution removes the attack
-- surface without touching a single working flow.
--
-- WHY THIS REVOKES FROM PUBLIC AND NOT JUST FROM anon/authenticated.
-- The live ACL on all six was:
--
--   =X/postgres | postgres=X/postgres | anon=X/postgres
--                | authenticated=X/postgres | service_role=X/postgres
--
-- That leading `=X/postgres` is a grant to PUBLIC — every role, present and
-- future. Revoking anon and authenticated alone leaves it in place and changes
-- nothing: both roles keep EXECUTE by virtue of being members of PUBLIC. This
-- was confirmed against the live database rather than assumed.
--
-- Nothing about the functions' bodies changes here. The ownership check that
-- fails open for hub-organised events (the NULL in `IF NOT owns_event ...`),
-- the non-atomic read-check-write in ticket redemption, and the unscoped
-- backup-code lookup are all still present and are all still wrong. They are
-- separate, deliberately separate, remediation steps. This migration only
-- closes the door that lets the internet reach them at all.
-- ============================================================================

-- ── 1. Ticket validation ────────────────────────────────────────────────────
-- Sole caller: supabase/functions/validate-event-ticket/index.ts, which builds
-- its client from SUPABASE_SERVICE_ROLE_KEY (line 36) and authorises the
-- scanner against the event before calling. validate_and_checkin_ticket_by_id
-- has no direct caller at all — it is reached only from inside
-- validate_backup_code, which executes as its definer (postgres) and therefore
-- keeps EXECUTE through the owner grant below.

revoke all on function public.validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid)
  from public, anon, authenticated;
grant execute on function public.validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid)
  to service_role;

revoke all on function public.validate_and_checkin_ticket_by_id(p_ticket_id uuid, p_event_id uuid, p_scanner_id uuid)
  from public, anon, authenticated;
grant execute on function public.validate_and_checkin_ticket_by_id(p_ticket_id uuid, p_event_id uuid, p_scanner_id uuid)
  to service_role;

revoke all on function public.validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid)
  from public, anon, authenticated;
grant execute on function public.validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid)
  to service_role;

-- ── 2. Paid hub membership ──────────────────────────────────────────────────
-- Callers: confirm-hub-membership (svc, line 38), wallet-checkout (svc, line
-- 35), and _shared/fulfilment.ts, which receives the service-role client from
-- stripe-webhook. All three hold the service role.

revoke all on function public.activate_hub_membership(p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text)
  from public, anon, authenticated;
grant execute on function public.activate_hub_membership(p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text)
  to service_role;

-- ── 3. Hub donations ────────────────────────────────────────────────────────
-- Callers: confirm-hub-donation (svc, line 33), wallet-checkout (svc, line 35),
-- _shared/fulfilment.ts via stripe-webhook. All hold the service role.

revoke all on function public.record_hub_donation(p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer, p_message text, p_anon boolean, p_pi text, p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text)
  from public, anon, authenticated;
grant execute on function public.record_hub_donation(p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer, p_message text, p_anon boolean, p_pi text, p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text)
  to service_role;

-- ── 4. Event sold counter ───────────────────────────────────────────────────
-- Callers: create-event-ticket-intent (supabase, line 72), confirm-event-tickets
-- (supabase, line 36), _shared/fulfilment.ts via stripe-webhook. All service role.

revoke all on function public.increment_event_tickets_sold(p_event_id uuid, p_count integer)
  from public, anon, authenticated;
grant execute on function public.increment_event_tickets_sold(p_event_id uuid, p_count integer)
  to service_role;

-- ── 5. Forward-looking default, and an honest note on its limits ────────────
--
-- New functions created by `postgres` in `public` currently inherit:
--
--   =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--
-- i.e. every function is reachable by the open internet the moment it exists.
-- Verified empirically by creating a probe function inside a rolled-back
-- transaction on the live database.
--
-- The statement below removes anon and authenticated from that inherited set.
-- It is safe: it cannot break a legitimate flow, because it only affects
-- objects created AFTER it runs, and because PUBLIC still carries EXECUTE.
--
-- ⚠️  IT IS ALSO NOT SUFFICIENT, and must not be mistaken for a fix.
-- `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` has
-- NO EFFECT here: Postgres re-merges the built-in PUBLIC EXECUTE default when
-- the object is created. Tested both ways on the live database —
-- has_function_privilege('anon', <new fn>, 'execute') returns TRUE with the
-- default-privilege revoke in place, and only returns FALSE once an explicit
-- per-object REVOKE ... FROM PUBLIC is issued.
--
-- So the rule for every future privileged function is unchanged and unavoidable:
--
--     revoke all on function public.<name>(<exact signature>)
--       from public, anon, authenticated;
--     grant execute on function public.<name>(<exact signature>) to service_role;
--
-- What actually enforces that going forward is the regression test added
-- alongside this migration, not this statement. The statement is kept because
-- it halves the residual grant surface at zero risk, not because it closes it.

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- Note: the equivalent default ACL owned by `supabase_admin` is deliberately
-- left alone — `postgres` is not a member of `supabase_admin`, so altering it
-- would fail. It applies only to objects created BY supabase_admin, which our
-- migrations never do (they run as postgres; every function in public is
-- owned by postgres).

-- ── 6. Record the intent on the objects themselves ──────────────────────────

comment on function public.validate_and_checkin_ticket(text, uuid, uuid) is
  'SERVICE ROLE ONLY. Takes p_scanner_id as a parameter and does not read auth.uid(), so it must never be client-callable. Reach it through the validate-event-ticket edge function, which authorises the scanner first.';
comment on function public.validate_and_checkin_ticket_by_id(uuid, uuid, uuid) is
  'SERVICE ROLE ONLY. Same caller-supplied-identity problem as validate_and_checkin_ticket. Called internally by validate_backup_code, which runs as its definer.';
comment on function public.validate_backup_code(text, uuid, uuid) is
  'SERVICE ROLE ONLY. Looks a ticket up by backup code across ALL events and takes p_scanner_id from the caller.';
comment on function public.activate_hub_membership(uuid, uuid, uuid, text, integer, text) is
  'SERVICE ROLE ONLY. Grants a paid hub membership and performs no authorisation of its own — call it only after payment is confirmed server-side.';
comment on function public.record_hub_donation(uuid, uuid, uuid, integer, integer, text, boolean, text, boolean, text, text, text, text, text) is
  'SERVICE ROLE ONLY. Writes a donation and Gift Aid declaration with no authorisation of its own — call it only after payment is confirmed server-side.';
comment on function public.increment_event_tickets_sold(uuid, integer) is
  'SERVICE ROLE ONLY. Unbounded counter mutation with no authorisation of its own.';
