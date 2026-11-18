#!/usr/bin/env bash
# Proves 20270303000000_editions_launch_switches_and_catalogue.sql against a THROWAWAY PostgreSQL. Touches nothing real.
#
# It extracts the four real objects from the migration file — it never retypes them — and runs them against the smallest schema they need, with
# stubs for the surrounding Editions functions. What it pins:
#
#   * editions_signup_open() fails closed: absent, blank, nonsense and 'false' all mean closed; only 'true' opens it.
#   * admin_set_editions_switch: administrators only; the two launch keys and nothing else; true/false and nothing else; it writes and it audits.
#   * admin_retire_edition_package: administrators only; a reason is required; it takes the row off sale; it cannot be done twice.
#   * edition_ensure_organiser: an EXISTING organiser is returned whatever the switch says; a NEW one is refused while registration is closed,
#     allowed when it is open, and allowed for staff even while it is closed.
#   * The Community Launch row is free, 365 days, inactive, and grants NO promotion days.
#
# Run: bash supabase/tests/editions-launch-switches/run.sh
set -euo pipefail

# Homebrew's `libpq` puts initdb/psql on PATH without a server, so prefer a real PostgreSQL install when one is present.
for d in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@17/bin; do
  [ -x "$d/postgres" ] && PATH="$d:$PATH" && break
done
command -v postgres >/dev/null || { echo "no PostgreSQL server on PATH (brew install postgresql@17)"; exit 1; }
# macOS: without a fixed locale the postmaster becomes multithreaded during startup and refuses to start.
export LC_ALL=C LANG=C

HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../migrations/20270303000000_editions_launch_switches_and_catalogue.sql"
[ -f "$MIG" ] || { echo "migration not found: $MIG"; exit 1; }

export PGDATA="$(mktemp -d)/pg" PGPORT="${PGPORT:-55439}" PGHOST=localhost PGDATABASE=postgres PGUSER=postgres
trap 'pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$PGDATA")"' EXIT

initdb -U postgres -A trust >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PGPORT -c listen_addresses=localhost" -w start >/dev/null
Q() { psql -p "$PGPORT" -v ON_ERROR_STOP=1 -qAt "$@"; }

# ── the smallest world these functions need ─────────────────────────────────────────────────────────────────────────────────────────────────────
Q <<'SQL' >/dev/null
-- Supabase's roles, so the migration's grants and revokes run exactly as written.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema if not exists auth;
create table auth.jwt_claims (uid uuid);
create function auth.uid() returns uuid language sql stable as $$ select uid from auth.jwt_claims limit 1 $$;

create table public.admin_config (key text primary key, value text not null, category text);
create table public.edition_packages (
  id uuid primary key default gen_random_uuid(), code text unique not null, name text not null, description text,
  price_pence integer not null, duration_days integer, features jsonb not null default '[]', max_members integer,
  active boolean not null default false, sort integer not null default 0, audience text not null default 'any',
  kind text not null default 'package', grants jsonb not null default '{}', is_free boolean not null default false,
  retired_at timestamptz, updated_at timestamptz not null default now());
create table public.edition_organisers (
  id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null,
  reserved_name_flag boolean not null default false, created_by uuid, hub_id uuid, business_id uuid,
  status text not null default 'pending', created_at timestamptz not null default now());
create table public.edition_reserved_names (pattern text primary key);
create table public.hubs (id uuid primary key, name text, is_active boolean not null default true);
create table public.local_businesses (id uuid primary key, name text, is_active boolean not null default true, owner_id uuid);
create table public.audit (action text, detail jsonb, at timestamptz default now());

-- stubs, switchable from the tests
create table public.stubs (is_admin boolean default false, is_staff boolean default false, controls boolean default true);
insert into public.stubs default values;
create function public.is_admin() returns boolean language sql stable as $$ select is_admin from public.stubs limit 1 $$;
create function public.edition_staff() returns boolean language sql stable as $$ select is_staff from public.stubs limit 1 $$;
create function public.edition_controls_hub(uuid) returns boolean language sql stable as $$ select controls from public.stubs limit 1 $$;
create function public.edition_controls_business(uuid) returns boolean language sql stable as $$ select controls from public.stubs limit 1 $$;
create function public.edition_audit(a uuid, b uuid, c text, d jsonb) returns void language sql as $$ insert into public.audit (action, detail) values (c, d) $$;
create function public.edition_slugify(s text) returns text language sql immutable as $$ select regexp_replace(lower(s), '[^a-z0-9]+', '-', 'g') $$;
create function public.edition_normalise_name(s text) returns text language sql immutable as $$ select lower(s) $$;

-- the three functions the migration's post-check requires to exist
create function public.edition_fulfil_order(uuid, text, integer) returns text language sql as $$ select 'stub' $$;
create function public.edition_claim_free_package(uuid, uuid, uuid, text) returns uuid language sql as $$ select gen_random_uuid() $$;
create function public.edition_is_public(uuid) returns boolean language sql as $$ select false $$;
SQL

# ── the migration itself, verbatim ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
Q -f "$MIG" >/dev/null
echo "migration applied (its own post-checks passed)"

FAIL=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; FAIL=1; }
# expect a statement to succeed
yes_() { if Q -c "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
# expect a statement to be refused
no_()  { if Q -c "$2" >/dev/null 2>&1; then bad "$1 (it was ALLOWED)"; else ok "$1"; fi; }
# A statement that is REFUSED where a value was expected must be reported as a failure, not kill the run: under `set -e` plus
# ON_ERROR_STOP that would abort the script, and a real regression would then look like a crash rather than a named failure.
eq()   { local got; if ! got="$(Q -c "$2" 2>/dev/null)"; then bad "$1 (the statement was REFUSED)"; return 0; fi;
         if [ "$got" = "$3" ]; then ok "$1"; else bad "$1 (got '$got', wanted '$3')"; fi; }

admin()  { Q -c "update public.stubs set is_admin = $1" >/dev/null; }
staff()  { Q -c "update public.stubs set is_staff = $1" >/dev/null; }
signin() { Q -c "delete from auth.jwt_claims; insert into auth.jwt_claims values ($1)" >/dev/null; }
switch() { Q -c "delete from public.admin_config where key='editions.signup_open'; insert into public.admin_config (key,value) values ('editions.signup_open','$1')" >/dev/null; }

echo
echo "editions_signup_open() fails closed"
eq "absent means closed"           "select public.editions_signup_open()" "f"
switch 'false';  eq "'false' is closed"     "select public.editions_signup_open()" "f"
switch '';       eq "blank is closed"       "select public.editions_signup_open()" "f"
switch 'yes';    eq "nonsense is closed"    "select public.editions_signup_open()" "f"
switch 'TRUE';   eq "'TRUE' opens it (case and spacing tolerated)" "select public.editions_signup_open()" "t"
Q -c "delete from public.admin_config where key='editions.signup_open'" >/dev/null

echo
echo "admin_set_editions_switch"
signin "'11111111-1111-1111-1111-111111111111'"; admin false
no_  "a signed-in non-administrator cannot set a switch" "select public.admin_set_editions_switch('editions.enabled','true')"
admin true
no_  "an unknown key is refused"                  "select public.admin_set_editions_switch('editions.commerce.enabled','true')"
no_  "a non-boolean value is refused"             "select public.admin_set_editions_switch('editions.enabled','on')"
no_  "an empty value is refused"                  "select public.admin_set_editions_switch('editions.enabled','')"
yes_ "an administrator can open public visibility" "select public.admin_set_editions_switch('editions.enabled','true')"
yes_ "and new organiser access, separately"        "select public.admin_set_editions_switch('editions.signup_open','true')"
eq   "both are stored under the editions category" "select count(*) from public.admin_config where key in ('editions.enabled','editions.signup_open') and category='editions'" "2"
eq   "every change is audited"                     "select count(*) from public.audit where action='editions_switch_set'" "2"
yes_ "and they can be closed again"                "select public.admin_set_editions_switch('editions.enabled','false')"
eq   "the two switches are genuinely independent"  "select (select value from public.admin_config where key='editions.enabled') || '/' || (select value from public.admin_config where key='editions.signup_open')" "false/true"

echo
echo "admin_retire_edition_package"
admin false
no_  "a non-administrator cannot retire a package"  "select public.admin_retire_edition_package('community_launch','no longer offered')"
admin true
no_  "a reason is required"                         "select public.admin_retire_edition_package('community_launch','x')"
no_  "an unknown package is refused"                "select public.admin_retire_edition_package('nope','no longer offered')"
yes_ "an administrator can retire a package"        "select public.admin_retire_edition_package('community_launch','replaced by the 2027 rate card')"
eq   "it is off sale and stamped"                   "select active::text || '/' || (retired_at is not null)::text from public.edition_packages where code='community_launch'" "false/true"
no_  "it cannot be retired twice"                   "select public.admin_retire_edition_package('community_launch','again')"
eq   "the retirement is audited with its reason"    "select count(*) from public.audit where action='package_retired' and detail->>'reason'='replaced by the 2027 rate card'" "1"

echo
echo "the Community Launch package"
Q -c "update public.edition_packages set retired_at=null where code='community_launch'" >/dev/null   # undo the retirement test
eq "free, £0"                       "select (is_free and price_pence=0)::text from public.edition_packages where code='community_launch'" "true"
eq "twelve months"                  "select duration_days::text from public.edition_packages where code='community_launch'" "365"
eq "every core feature, no cap"     "select (jsonb_array_length(features)=5 and max_members is null)::text from public.edition_packages where code='community_launch'" "true"
eq "NO promotion days whatsoever"   "select (grants='{}'::jsonb)::text from public.edition_packages where code='community_launch'" "true"
eq "and it arrives switched off"    "select active::text from public.edition_packages where code='community_launch'" "false"

echo
echo "edition_ensure_organiser: the switch governs NEW organisers only"
Q -c "insert into public.hubs (id,name) values ('22222222-2222-2222-2222-222222222222','Lerwick Gala Committee'),('33333333-3333-3333-3333-333333333333','Scalloway Fire Festival')" >/dev/null
signin "'11111111-1111-1111-1111-111111111111'"; admin false; staff false

switch 'false'
no_ "a new organiser is refused while registration is closed" \
    "select public.edition_ensure_organiser('hub','22222222-2222-2222-2222-222222222222')"
eq  "and nothing was created"  "select count(*) from public.edition_organisers" "0"

staff true
yes_ "staff may still set one up while it is closed" \
     "select public.edition_ensure_organiser('hub','22222222-2222-2222-2222-222222222222')"
staff false

eq "asking again returns the SAME organiser even though registration is closed" \
   "select (public.edition_ensure_organiser('hub','22222222-2222-2222-2222-222222222222') ->> 'created')" "false"
eq "...and it is the one that exists"  "select count(*) from public.edition_organisers" "1"

switch 'true'
yes_ "with registration open, a new organiser is created" \
     "select public.edition_ensure_organiser('hub','33333333-3333-3333-3333-333333333333')"
eq "two organisers now"  "select count(*) from public.edition_organisers" "2"

switch 'false'
eq "closing registration again does not disturb either of them" \
   "select count(*) from public.edition_organisers" "2"
eq "and the existing one is still reachable" \
   "select (public.edition_ensure_organiser('hub','33333333-3333-3333-3333-333333333333') ->> 'created')" "false"

echo
echo "the person must still control the parent — the switch does not widen anything"
switch 'true'
Q -c "update public.stubs set controls = false" >/dev/null
no_ "someone who does not run the Hub is refused even with registration open" \
    "select public.edition_ensure_organiser('hub','22222222-2222-2222-2222-222222222222')"
Q -c "update public.stubs set controls = true" >/dev/null
signin "null"
no_ "a signed-out caller is refused" "select public.edition_ensure_organiser('hub','22222222-2222-2222-2222-222222222222')"

echo
if [ "$FAIL" = "0" ]; then echo "ALL CHECKS PASSED"; else echo "THERE WERE FAILURES"; exit 1; fi
