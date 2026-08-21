-- ============================================================================
-- Client roles stop being able to empty a table.
--
-- WHAT WAS WRONG
--
-- Every table in `public` carried the same grant:
--
--   anon=arwdDxtm/postgres | authenticated=arwdDxtm/postgres
--
-- The `D` is TRUNCATE. 122 of the 127 tables handed it to both client roles.
-- The five exceptions are only the ones revoked by hand in Steps 5 and 6.
--
-- TRUNCATE is not filtered by RLS. Row policies decide which rows a statement
-- may see; TRUNCATE does not read rows, so there is nothing for a policy to
-- filter. A role holding it empties the entire table however careful the
-- policies are.
--
-- Proven against production before this was written, on a throwaway table
-- inside a rolled-back transaction:
--
--   authenticated    TRUNCATE SUCCEEDED    rows_left=0
--   anon             TRUNCATE SUCCEEDED    rows_left=0
--
-- HOW REACHABLE IT IS TODAY — STATED PRECISELY, NOT INFLATED
--
-- It is NOT reachable through the public API as it currently stands:
--
--   * PostgREST answers `TRUNCATE /rest/v1/<table>` with 501 Not Implemented.
--     No HTTP verb reaches it.
--   * No client-callable function runs TRUNCATE. The only two functions in
--     `public` that build dynamic SQL are `_apply_vessel_edit` (service_role
--     only) and `approve_spik_suggestion` (is_admin()-gated, column name
--     whitelisted against a fixed array, `%I`-quoted, values passed as bind
--     parameters).
--
-- So this is not a live hole, and is not being presented as one. It is a
-- loaded privilege with no trigger attached: one SECURITY INVOKER helper
-- taking a table name, one direct-connection credential, one PostgREST
-- feature, and the blast radius is an entire table. It is removed because
-- nothing uses it, so removing it costs nothing.
--
-- NOTHING USES IT
--
-- Both repositories were searched: no TRUNCATE anywhere, except the revokes
-- written in Step 6 and one comment. The app and website reach the database
-- through PostgREST, which cannot emit it. Real deletion goes through DELETE,
-- which RLS does filter.
--
-- WHAT THIS CHANGES, AND ONLY THIS
--
-- TRUNCATE, for `anon` and `authenticated`, in `public`. SELECT, INSERT,
-- UPDATE, DELETE, REFERENCES and TRIGGER are untouched: the ACL reads
-- `arwdxtm` where it read `arwdDxtm`, one letter apart. `service_role` is not
-- named and keeps `arwdDxtm` — nothing is granted to it to compensate.
--
-- FUTURE TABLES
--
-- The grant was never written by anybody. It comes from pg_default_acl:
-- `public` carries a default handing arwdDxtm to both client roles on every
-- table created there. Revoking today's 122 without touching that default
-- would mean table 128 arrives holding TRUNCATE again.
--
-- Steps 1 and 1B established that the equivalent move for FUNCTIONS is a
-- silent no-op — Postgres re-merges the built-in `EXECUTE TO PUBLIC` default
-- at CREATE time and undoes the revoke. That lesson is exactly why the table
-- case was tested rather than assumed, on a real newly created table:
--
--   with the default revoked, a freshly created table came out
--     anon=arwdxtm | authenticated=arwdxtm | service_role=arwdDxtm
--
-- It holds. Tables differ from functions for a specific reason: there is no
-- built-in grant of anything to client roles on a new table. The whole grant
-- lives in pg_default_acl, so removing it there genuinely removes it.
--
-- ONE GAP, NAMED RATHER THAN GLOSSED
--
-- `public` has a SECOND default-privileges entry whose grantor is
-- `supabase_admin`, applying to tables that role creates. This connection is
-- `postgres`, which is not a superuser and not a member of `supabase_admin`,
-- so it cannot be altered from here:
--
--   ERROR 42501: permission denied to change default privileges
--
-- All 127 tables in `public` are owned by `postgres`, so nothing in this
-- project creates tables by that path today. But the gap cannot be closed
-- from this connection, so it is covered the other way: the regression test
-- in supabase/tests/truncate-privileges.node.test.ts enumerates public tables
-- live and fails if ANY of them grants TRUNCATE to a client role, whoever
-- created it. The gap is not sealed. It is alarmed.
-- ============================================================================


-- ── Today's tables ──────────────────────────────────────────────────────────
--
-- ALL TABLES rather than a list of 122: revoking a privilege a role does not
-- hold is a no-op, so this also covers the five already done by hand and any
-- table added between writing this and applying it. TRUNCATE is the only
-- privilege named.
revoke truncate on all tables in schema public from anon;
revoke truncate on all tables in schema public from authenticated;


-- ── Tomorrow's tables ───────────────────────────────────────────────────────
--
-- Keyed to `postgres` because that is the role that actually creates tables
-- here: every existing table is owned by it, migrations run as it, and the
-- create-table probe above confirmed `current_user = postgres`. Guessing the
-- owner was not necessary — it was read from production.
alter default privileges for role postgres in schema public
  revoke truncate on tables from anon;
alter default privileges for role postgres in schema public
  revoke truncate on tables from authenticated;


-- ── Prove it in the same transaction that did it ────────────────────────────
--
-- has_table_privilege is the authoritative check: it accounts for grants
-- reached through role membership, which reading relacl by eye does not. If
-- anything still holds TRUNCATE, the migration fails instead of reporting
-- success it did not achieve.
do $$
declare
  v_bad int;
  v_names text;
begin
  select count(*), string_agg(c.relname, ', ' order by c.relname)
    into v_bad, v_names
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and (has_table_privilege('anon',          c.oid, 'TRUNCATE')
       or has_table_privilege('authenticated', c.oid, 'TRUNCATE'));

  if v_bad > 0 then
    raise exception 'TRUNCATE still held by a client role on % table(s): %', v_bad, left(v_names, 300);
  end if;
end $$;
