#!/usr/bin/env bash
# Featuring an Edition from the admin interface, end to end, against a THROWAWAY replica of the production schema.
#
# Needs a replica. Build one read-only:
#   supabase db dump --linked --schema public,auth -f schema.sql     # schema only: no personal data
# then load it into a local PostgreSQL 17 with the Supabase roles pre-created (anon, authenticated, service_role,
# dashboard_user, supabase_admin, supabase_auth_admin, supabase_storage_admin, authenticator) plus pg_trgm.
# macOS needs LC_ALL=C and a SHORT socket dir (-k /tmp/jpg), or the postmaster refuses to start.
#   PGHOST=/tmp/jpg PGPORT=55455 bash run.sh
#
# WHAT IT PROVES. The whole workflow, not the function in isolation: an administrator who belongs to NO organiser
# picks an eligible Edition, features it, and it appears in the homepage strip that app/page.tsx actually reads
# (edition_featured). Then that it can be moved and cancelled, that it leaves the strip, and that every limit still
# holds — capacity, the 90-day fairness cap, the publishing window, and organiser-only booking.
#
# It FAILS when the functionality is broken: remove admin_promo_feature and the workflow checks fail; relax a limit
# and the limit checks fail. Both are mutation-tested in the project notes.
set -uo pipefail
for d in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin; do [ -x "$d/psql" ] && PATH="$d:$PATH" && break; done
export LC_ALL=C LANG=C
export PGHOST="${PGHOST:-/tmp/jpg}" PGPORT="${PGPORT:-55455}" PGUSER="${PGUSER:-postgres}" PGDATABASE="${PGDATABASE:-postgres}"

ADMIN=22222222-2222-4222-8222-222222222222   # OneShetland administrator. Belongs to NO organiser.
OWNER=11111111-1111-4111-8111-111111111111   # runs the Hub that runs the Edition
OTHER=44444444-4444-4444-8444-444444444444   # runs a different Hub
HUB_A=33333333-3333-4333-8333-333333333333
HUB_B=55555555-5555-4555-8555-555555555555

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
q()   { psql -qAt -c "$1" 2>&1; }
as()  { psql -qAt 2>&1 <<SQL
begin; set local role authenticated; set local request.jwt.claims = '{"sub":"$1","role":"authenticated"}';
$2
commit;
SQL
}
# expect success; prints nothing on success
yes_() { local o; o="$(as "$2" "$3")"; if echo "$o" | grep -q "^ERROR"; then bad "$1 -> $(echo "$o" | grep -m1 -o 'ERROR:.*' | cut -c8-90)"; else ok "$1"; fi; }
no_()  { local o; o="$(as "$2" "$3")"; if echo "$o" | grep -q "^ERROR"; then ok "$1 (refused: $(echo "$o" | grep -m1 -o 'ERROR:.*' | cut -c8-70))"; else bad "$1 — IT WAS ALLOWED"; fi; }
eq()   { local g; g="$(q "$2")"; if [ "$g" = "$3" ]; then ok "$1"; else bad "$1 (got '$g', wanted '$3')"; fi; }

echo "═══ a world with one eligible Edition ═══"
psql -qAt -v ON_ERROR_STOP=1 >/dev/null <<SQL
do \$\$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'edition%' loop execute format('truncate table public.%I cascade', t); end loop; end \$\$;
truncate table public.hub_members cascade; delete from public.hubs; delete from public.profiles; delete from auth.users;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',u||'@example.test',now(),now(),now()
from unnest(array['$ADMIN','$OWNER','$OTHER']::uuid[]) u;
insert into public.profiles (id, role) values ('$ADMIN','admin'),('$OWNER','customer'),('$OTHER','customer')
  on conflict (id) do update set role = excluded.role;
insert into public.hubs (id,name,slug,owner_id,is_active) values
 ('$HUB_A','ZZ TEST Simmer Dim','zz-test-simmer-dim','$OWNER',true),
 ('$HUB_B','ZZ TEST Voe Regatta','zz-test-voe-regatta','$OTHER',true);
insert into public.edition_packages (code,name,description,price_pence,duration_days,features,max_members,active,sort,audience,kind,grants,is_free)
values ('community_launch','Community Launch','Free for twelve months.',0,365,
 '["collect_payments","memberships","participation_fees","offline_records","csv_export"]'::jsonb,null,true,5,'any','package','{}'::jsonb,true)
on conflict (code) do update set active = true;
insert into public.admin_config (key,value,category) values ('editions.enabled','true','editions'),('editions.signup_open','true','editions')
  on conflict (key) do update set value = excluded.value;
SQL

# Build the Edition through the real organiser path, so it is eligible for the same reasons a real one is.
mk() { # $1 uid  $2 hub  $3 title  $4 slug
  as "$1" "select public.edition_ensure_organiser('hub','$2');" >/dev/null
  local org; org="$(q "select id from public.edition_organisers where hub_id='$2'")"
  as "$1" "insert into public.editions (organiser_id,title,slug,summary,kind,starts_on,ends_on)
           values ('$org','$3','$4','A midsummer weekend.','multi_day', current_date + 60, current_date + 62);" >/dev/null
  local ed; ed="$(q "select id from public.editions where slug='$4'")"
  as "$1" "insert into public.edition_pages (edition_id,slug,nav_label,title,body,position,in_nav,is_home) values ('$ed','welcome','Welcome','Welcome','Come along.',1,true,true);" >/dev/null
  as "$1" "select public.edition_submit_for_review('$ed');" >/dev/null
  as "$ADMIN" "select public.admin_review_edition('$ed','approve','Checked.');" >/dev/null
  local pkg; pkg="$(q "select id from public.edition_packages where code='community_launch'")"
  as "$1" "select public.edition_claim_free_package('$org','$ed','$pkg','attempt-$4');" >/dev/null
  as "$1" "select public.edition_set_status('$ed','published');" >/dev/null
  echo "$ed"
}
ED_A="$(mk "$OWNER" "$HUB_A" 'ZZ TEST Simmer Dim Festival' 'zz-simmer-dim')"
ED_B="$(mk "$OTHER" "$HUB_B" 'ZZ TEST Voe Regatta Week' 'zz-voe-regatta')"
echo "  two published, approved, entitled Editions, run by two different Hubs"
eq "the administrator belongs to no organiser" "select count(*) from public.edition_organiser_members where user_id='$ADMIN'" "0"
echo

echo "═══ 1. THE ADMINISTRATOR CAN SEE WHAT IS ELIGIBLE, WITHOUT LEAVING THE SCREEN ═══"
asq() { as "$1" "$2" | tail -1; }
eq2() { local g; g="$(asq "$2" "$3")"; if [ "$g" = "$4" ]; then ok "$1"; else bad "$1 (got '$g', wanted '$4')"; fi; }
eq2 "both Editions are offered as candidates" "$ADMIN" "select count(*) from public.admin_edition_promo_candidates();" "2"
eq2 "each one says who runs it and when its publishing period ends" "$ADMIN" "select count(*) from public.admin_edition_promo_candidates() where organiser_name is not null and entitlement_ends_at is not null;" "2"
no_ "an organiser cannot read the candidate list" "$OWNER" "select count(*) from public.admin_edition_promo_candidates();"
echo

echo "═══ 2. FEATURING IT — ONE ACTION ═══"
no_ "an organiser cannot feature anything" "$OWNER" "select public.admin_promo_feature('$ED_A','homepage', current_date + 7, 7, 'Christmas push');"
no_ "a reason is required" "$ADMIN" "select public.admin_promo_feature('$ED_A','homepage', current_date + 7, 7, 'no');"
no_ "the kind must be real" "$ADMIN" "select public.admin_promo_feature('$ED_A','sidebar', current_date + 7, 7, 'Christmas push');"
yes_ "the administrator features it on the homepage for 7 days" "$ADMIN" \
     "select public.admin_promo_feature('$ED_A','homepage', current_date + 7, 7, 'Flagship festival for the winter season');"
eq "one right and one booking were made together" \
   "select (select count(*) from public.edition_promo_rights where edition_id='$ED_A')||'/'||(select count(*) from public.edition_promo_bookings where edition_id='$ED_A' and status='booked')" "1/1"
eq "the right is recorded as a staff grant, with its reason" \
   "select source||' | '||reason from public.edition_promo_rights where edition_id='$ED_A'" "admin_grant | Flagship festival for the winter season"
eq "and it is in the audit trail" "select count(*) from public.edition_audit_log where action='promo_featured_by_staff'" "1"
echo

echo "═══ 3. IT REACHES THE HOMEPAGE STRIP THE WEBSITE ACTUALLY READS ═══"
echo "    (app/page.tsx -> getFeaturedEditions('home') -> edition_featured('homepage'))"
eq "not on the homepage before its first day" "select count(*) from public.edition_featured('homepage')" "0"
# Bring it forward through the real staff path. A raw UPDATE of starts_on alone is refused by
# edition_promo_bookings_guard, which requires ends_on - starts_on + 1 to equal the right's days — so a test that
# moved it by hand would silently not move it, and then "nothing on the homepage" would look like a product bug.
BK_A="$(q "select id from public.edition_promo_bookings where edition_id='$ED_A' and status='booked'")"
as "$ADMIN" "select public.admin_promo_reschedule('$BK_A', current_date, 'Bring the run forward to start today');" >/dev/null
eq "on the homepage once it starts" "select count(*) from public.edition_featured('homepage')" "1"
eq "and it is the right Edition" "select title from public.edition_featured('homepage')" "ZZ TEST Simmer Dim Festival"
eq "it is NOT in the discovery row (a homepage booking is not a discovery one)" "select count(*) from public.edition_featured('discovery')" "0"
echo

echo "═══ 4. EVERY LIMIT STILL HOLDS ═══"
CAP="$(q "select public.edition_promo_cfg_int('editions.promo.homepage_capacity', 3)")"
echo "    homepage capacity is $CAP a day"
no_ "the same organiser cannot double-book the same kind on overlapping days" "$ADMIN" \
    "select public.admin_promo_feature('$ED_A','homepage', current_date + 1, 3, 'Trying it twice over the same days');"
no_ "a booking cannot run past the Edition's publishing period" "$ADMIN" \
    "select public.admin_promo_feature('$ED_B','homepage', current_date + 300, 90, 'Far beyond the entitlement');"
no_ "the 90-day homepage fairness cap is enforced" "$ADMIN" \
    "select public.admin_promo_feature('$ED_B','homepage', current_date + 20, 100, 'More than any organiser may have');"
yes_ "a different organiser CAN take a free place on the same days" "$ADMIN" \
     "select public.admin_promo_feature('$ED_B','homepage', current_date, 2, 'Second festival, free capacity');"
eq "both now show on the homepage" "select count(*) from public.edition_featured('homepage')" "2"
as "$OTHER" "select public.edition_set_status('$ED_B','draft');" >/dev/null
no_ "an Edition that is not published cannot be featured" "$ADMIN" \
    "select public.admin_promo_feature('$ED_B','homepage', current_date + 40, 1, 'Should be refused while in draft');"
as "$OTHER" "select public.edition_set_status('$ED_B','published');" >/dev/null
echo

echo "═══ 5. VIEW, MOVE AND CANCEL, ALL FROM THE ADMIN SIDE ═══"
B_A="$(q "select id from public.edition_promo_bookings where edition_id='$ED_A' and status='booked'")"
# 7 days booked from today, so the calendar must show it on exactly 7 days in a 14-day window.
eq2 "the calendar shows the booking on each of its 7 days" "$ADMIN" \
   "select count(*) from public.admin_edition_promo_calendar(current_date, current_date + 13) where kind='homepage' and bookings::text like '%Simmer Dim%';" "7"
yes_ "an administrator can move a booking" "$ADMIN" "select public.admin_promo_reschedule('$B_A', current_date + 3, 'Moved to clear the gala weekend');"
eq "it left the homepage once moved into the future" "select count(*) from public.edition_featured('homepage')" "1"
yes_ "and cancel one" "$ADMIN" "select public.admin_promo_cancel('$B_A','Festival postponed');"
eq "the booking is cancelled, not deleted (the trail survives)" "select status from public.edition_promo_bookings where id='$B_A'" "cancelled"
no_ "an organiser cannot cancel another organiser's booking" "$OTHER" "select public.edition_promo_cancel('$B_A');"
echo

echo "═══ 6. THE ORGANISER'S OWN ROUTE IS UNTOUCHED ═══"
ORG_A="$(q "select organiser_id from public.editions where id='$ED_A'")"
R="$(q "insert into public.edition_promo_rights (edition_id, organiser_id, source, kind, days, granted_by, reason) values ('$ED_A','$ORG_A','admin_grant','discovery',5,'$ADMIN','For the organiser to schedule') returning id")"
yes_ "the organiser books their own days as before" "$OWNER" "select public.edition_promo_book('$R', current_date + 10);"
no_  "someone else's organiser still cannot" "$OTHER" "select public.edition_promo_book('$R', current_date + 20);"
echo

echo "─────────────────────────────────────────────"
echo "  $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
