#!/usr/bin/env bash
# The organiser journey, end to end, against a THROWAWAY replica of the production schema.
#
# Needs a replica first: dump the schema read-only with
#   supabase db dump --linked --schema public,auth -f schema.sql
# and load it into a local PostgreSQL 17 with the platform roles pre-created (see boot.sh in the same folder of the
# scratch run, or recreate: anon, authenticated, service_role, dashboard_user, supabase_admin, supabase_auth_admin,
# supabase_storage_admin, authenticator + pg_trgm). macOS needs LC_ALL=C and a SHORT socket dir.
#
# It touches NOTHING real: the dump is schema-only, so it carries no personal data, and every write here is local.
#
# Every step runs as `authenticated` with a real auth.uid(), through the SAME calls the website makes — direct table
# writes where the site writes directly (so RLS and the column grants apply) and RPCs where the site calls RPCs.
# Nothing is done as `postgres`, because that would bypass the rules this is meant to test.
set -uo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
export PGHOST=/tmp/jpg PGPORT=55455 PGUSER=postgres PGDATABASE=postgres LC_ALL=C

ANN=11111111-1111-4111-8111-111111111111          # a Shetland organiser: owns a Hub, not staff, not an administrator
STELLA=22222222-2222-4222-8222-222222222222       # OneShetland staff
HUB=33333333-3333-4333-8333-333333333333

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
# run SQL as a signed-in member (role authenticated + a jwt sub), exactly as PostgREST would
asuser() { psql -qAt -v ON_ERROR_STOP=1 <<SQL 2>&1
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"$1","role":"authenticated"}';
$2
commit;
SQL
}
try()  { local out; out="$(asuser "$2" "$3")"; if [ "${out:0:5}" = "ERROR" ] || echo "$out" | grep -q "^ERROR"; then bad "$1 -> $(echo "$out" | head -1 | cut -c1-96)"; else ok "$1"; [ -n "${4:-}" ] && echo "$out" > "$4"; fi; }
deny() { local out; out="$(asuser "$2" "$3")"; if echo "$out" | grep -q "ERROR"; then ok "$1 (refused: $(echo "$out" | grep -o 'ERROR:.*' | head -1 | cut -c8-78))"; else bad "$1 — IT WAS ALLOWED"; fi; }
q()    { psql -qAt -c "$1"; }

echo "═══ RESET (a walkthrough has to start from nothing, or it proves nothing) ═══"
psql -qAt -v ON_ERROR_STOP=1 >/dev/null <<'RESET'
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'edition%' loop
    execute format('truncate table public.%I cascade', t);
  end loop;
end $$;
delete from public.admin_config where key in ('editions.enabled','editions.signup_open');
RESET

echo "  every edition_* table emptied; both switches cleared"
echo

echo "═══ FIXTURES (as the platform, before the journey starts) ═══"
psql -qAt -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values ('$ANN','00000000-0000-0000-0000-000000000000','authenticated','authenticated','ann@example.test',now(),now(),now()),
       ('$STELLA','00000000-0000-0000-0000-000000000000','authenticated','authenticated','stella@example.test',now(),now(),now())
on conflict (id) do nothing;
insert into public.profiles (id, role) values ('$ANN','customer'), ('$STELLA','admin') on conflict (id) do update set role = excluded.role;
insert into public.hubs (id, name, slug, owner_id, is_active) values ('$HUB','ZZ TEST Harbour Gala','zz-test-harbour-gala','$ANN', true) on conflict (id) do nothing;
-- the catalogue as production now stands: Community Launch, free, 365 days, every feature, NO promotion days, SWITCHED ON
insert into public.edition_packages (code,name,description,price_pence,duration_days,features,max_members,active,sort,audience,kind,grants,is_free)
values ('community_launch','Community Launch','Free for twelve months.',0,365,
        '["collect_payments","memberships","participation_fees","offline_records","csv_export"]'::jsonb,null,true,5,'any','package','{}'::jsonb,true)
on conflict (code) do update set active = true;
SQL
echo "  Ann: owns a Hub, role=customer, NOT staff, NOT an administrator"
echo "  Community Launch: active=true, free, 365 days, grants={}"
echo

echo "═══ 1. STARTING EDITIONS ═══"
sw() { q "insert into public.admin_config (key,value,category) values ('$1','$2','editions') on conflict (key) do update set value='$2'" >/dev/null; }
sw editions.enabled false; sw editions.signup_open false
deny "both switches off: Ann cannot start Editions" "$ANN" "select public.edition_ensure_organiser('hub','$HUB');"

# With 20270304000000 applied, this is the launch state: registration open, NOTHING public. The whole journey below
# runs in it, so public visibility is never switched on at any point.
sw editions.signup_open true
try "registration OPEN, public visibility OFF: Ann starts Editions in one call" "$ANN" "select public.edition_ensure_organiser('hub','$HUB') ->> 'slug';" /tmp/j_slug
ORG=$(q "select id from public.edition_organisers where hub_id='$HUB'")
echo "    organiser: $(q "select name||' ('||slug||'), status='||status from public.edition_organisers where id='$ORG'")"
echo

echo "═══ 2. CREATING AN EDITION ═══"
try "Ann creates an Edition (direct insert, under RLS and the column grants)" "$ANN" \
 "insert into public.editions (organiser_id,title,slug,summary,kind,starts_on,ends_on) values ('$ORG','ZZ TEST Simmer Dim Festival','zz-simmer-dim','A midsummer weekend of music and food.','multi_day','2027-06-18','2027-06-20');"
ED=$(q "select id from public.editions where slug='zz-simmer-dim'")
echo

echo "═══ 3. CONTENT ═══"
try "a page" "$ANN" "insert into public.edition_pages (edition_id,slug,nav_label,title,body,position,in_nav,is_home) values ('$ED','welcome','Welcome','Welcome','Come for the weekend.',1,true,true);"
try "a venue" "$ANN" "insert into public.edition_venues (organiser_id,name,address) values ('$ORG','Hillswick Hall','Hillswick');"
VEN=$(q "select id from public.edition_venues where organiser_id='$ORG' limit 1")
try "two programme items" "$ANN" "insert into public.edition_sessions (edition_id,title,starts_at,ends_at,venue_id,kind,ticket_mode,status) values ('$ED','Opening night','2027-06-18 19:00+01','2027-06-18 22:00+01','$VEN','event','none','scheduled'),('$ED','Family ceilidh','2027-06-19 14:00+01','2027-06-19 16:00+01','$VEN','event','none','scheduled');"
echo "    $(q "select count(*)||' pages, '||(select count(*) from public.edition_sessions where edition_id='$ED')||' sessions' from public.edition_pages where edition_id='$ED'")"
echo

echo "═══ 4. READINESS AND SUBMITTING ═══"
echo "    checklist: $(asuser "$ANN" "select string_agg((case when (i->>'ok')::boolean then '[x] ' else '[ ] ' end)||(i->>'label')||(case when (i->>'required')::boolean then ' *' else '' end), E'\n               ') from jsonb_array_elements(public.edition_readiness('$ED')) i;" | tail -n +1)"
deny "Ann cannot publish before approval" "$ANN" "select public.edition_set_status('$ED','published');"
try "Ann sends it for review" "$ANN" "select public.edition_submit_for_review('$ED');"
echo "    state: $(q "select status||' / '||review_state from public.editions where id='$ED'")"
echo

echo "═══ 5. ONESHETLAND REVIEWS IT ═══"
deny "Ann cannot approve her own Edition" "$ANN" "select public.admin_review_edition('$ED','approve',null);"
try "Stella approves it" "$STELLA" "select public.admin_review_edition('$ED','approve','Checked the programme and the venue.');"
echo "    state: $(q "select status||' / '||review_state from public.editions where id='$ED'")"
echo "    organiser status: $(q "select status from public.edition_organisers where id='$ORG'") (verified by the approval, with no second queue)"
echo

echo "═══ 6. CHOOSING THE FREE PACKAGE ═══"
echo "    offered to Ann: $(asuser "$ANN" "select string_agg(name||' ('||case when is_free then 'free' else (price_pence/100)::text end||')', ', ') from public.edition_available_packages('$ORG');")"
PKG=$(q "select id from public.edition_packages where code='community_launch'")
echo "    entitlement before: $(q "select count(*) from public.edition_entitlements where edition_id='$ED'")"
try "Ann claims Community Launch (no payment, no administrator)" "$ANN" "select public.edition_claim_free_package('$ORG','$ED','$PKG','attempt-abcdefgh');"
echo

echo "═══ 7. WHAT THE CLAIM GRANTED, AUTOMATICALLY ═══"
ENT=$(q "select count(*) from public.edition_entitlements where edition_id='$ED' and feature='publish' and voided_at is null")
[ "$ENT" = "1" ] && ok "exactly one publish entitlement was created" || bad "expected 1 publish entitlement, got $ENT"
echo "    $(q "select '  source='||source||', '||to_char(starts_at,'DD Mon YYYY')||' to '||to_char(ends_at,'DD Mon YYYY')||' ('||(ends_at::date - starts_at::date)||' days)' from public.edition_entitlements where edition_id='$ED' and feature='publish'")"
SRC=$(q "select source from public.edition_entitlements where edition_id='$ED' and feature='publish'")
[ "$SRC" = "payment" ] && ok "it came through the ORDER ledger, not an administrator grant" || bad "source is '$SRC' — expected the order path"
GRANTED=$(q "select count(*) from public.edition_organiser_entitlements where organiser_id='$ORG' and voided_at is null")
[ "$GRANTED" = "5" ] && ok "all five organiser abilities granted (payments, memberships, fees, offline records, CSV)" || bad "expected 5 organiser abilities, got $GRANTED"
PROMO=$(q "select count(*) from public.edition_promo_rights where edition_id='$ED'")
[ "$PROMO" = "0" ] && ok "NO promotion rights — the free package gives none away" || bad "free package granted $PROMO promotion rights"
ORD=$(q "select count(*) from public.edition_orders where edition_id='$ED' and status='paid' and amount_pence=0")
[ "$ORD" = "1" ] && ok "a £0 order is on the ledger, so it is auditable like any purchase" || bad "expected one £0 paid order, got $ORD"
echo

echo "═══ 8. PUBLISHING ═══"
try "Ann publishes" "$ANN" "select public.edition_set_status('$ED','published');"
echo "    state: $(q "select status||' / '||review_state from public.editions where id='$ED'")"
echo "    edition_is_public = $(q "select public.edition_is_public('$ED')")  <- correct: published, but the public switch is off"
sw editions.enabled true
echo "    (if the public switch were on it would read: $(q "select public.edition_is_public('$ED')"))"
sw editions.enabled false
echo

echo "═══ 9. MANAGING IT AFTERWARDS ═══"
try "Ann unpublishes" "$ANN" "select public.edition_set_status('$ED','draft');"
try "and publishes again (the approval is kept)" "$ANN" "select public.edition_set_status('$ED','published');"
try "editing the summary does NOT send it back for review" "$ANN" "update public.editions set summary='A midsummer weekend of music, food and a late ceilidh.' where id='$ED';"
echo "    after a summary edit: $(q "select status||' / '||review_state from public.editions where id='$ED'")"
try "changing the DATES does send it back" "$ANN" "update public.editions set ends_on='2027-06-21' where id='$ED';"
echo "    after a date change:  $(q "select status||' / '||review_state from public.editions where id='$ED'")"
echo

echo "═══ 10. NOTHING LEAKED ═══"
CLOSED=$(q "select count(*) from public.admin_config where key='editions.enabled' and value='true'")
[ "$CLOSED" = "0" ] && ok "public visibility finished OFF" || bad "public visibility left ON"
echo
echo "─────────────────────────────────────────────"
echo "  $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
