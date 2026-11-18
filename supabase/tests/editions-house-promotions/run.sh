#!/usr/bin/env bash
# House promotions, against a THROWAWAY replica of the production schema (schema-only dump, no data).
#
# What this proves: an administrator can run an extended, free official OneShetland promotion, and NOTHING about the
# commercial rules changed for anybody else. Every step runs as `authenticated` with a real auth.uid(), through the
# same RPCs the website calls, so RLS, grants and triggers all apply. Nothing here touches production.
set -uo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
export PGHOST=/tmp/jpg PGPORT=55455 PGUSER=postgres PGDATABASE=postgres LC_ALL=C

ONE=11111111-1111-4111-8111-111111111111     # runs OneShetland's own Hub (the house organiser)
ANN=44444444-4444-4444-8444-444444444444     # an ordinary Shetland organiser
STELLA=22222222-2222-4222-8222-222222222222  # OneShetland administrator
STRANGER=66666666-6666-4666-8666-666666666666
BEA=99999999-9999-4999-8999-999999999999     # a second ordinary organiser, for the capacity test
HUB_ONE=33333333-3333-4333-8333-333333333333
HUB_ANN=88888888-8888-4888-8888-888888888888
HUB_BEA=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
asuser() { psql -qAt -v ON_ERROR_STOP=1 <<SQL 2>&1
begin; set local role authenticated; set local request.jwt.claims = '{"sub":"$1","role":"authenticated"}';
$2
commit;
SQL
}
try()  { local out; out="$(asuser "$2" "$3")"; if echo "$out" | grep -q "ERROR"; then bad "$1 -> $(echo "$out" | grep -o 'ERROR:.*' | head -1 | cut -c1-100)"; else ok "$1"; fi; }
# deny <label> <uid> <sql> [expected hint or message fragment]
deny() { local out; out="$(asuser "$2" "$3")"
  if echo "$out" | grep -q "ERROR"; then
    if [ -n "${4:-}" ] && ! echo "$out" | grep -qi -- "$4"; then bad "$1 — refused, but not for the expected reason: $(echo "$out" | grep -o 'ERROR:.*' | head -1 | cut -c1-90)";
    else ok "$1 (refused: $(echo "$out" | grep -o 'ERROR:.*' | head -1 | cut -c8-80))"; fi
  else bad "$1 — IT WAS ALLOWED"; fi; }
q()  { psql -qAt -c "$1"; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected '$3', got '$2'"; fi; }
sw() { q "insert into public.admin_config (key,value,category) values ('$1','$2','editions') on conflict (key) do update set value='$2'" >/dev/null; }

echo "═══ RESET ═══"
psql -qAt -v ON_ERROR_STOP=1 >/dev/null <<'RESET'
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'edition%' loop
    execute format('truncate table public.%I cascade', t); end loop; end $$;
truncate table public.hub_members cascade;
delete from public.hubs; delete from public.profiles; delete from auth.users;
delete from public.admin_config where key like 'editions.%';
RESET

psql -qAt -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000','authenticated','authenticated', u||'@example.test', now(), now(), now()
from unnest(array['$ONE','$ANN','$STELLA','$STRANGER','$BEA']::uuid[]) u;
insert into public.profiles (id, role) values ('$ONE','customer'),('$ANN','customer'),('$STELLA','admin'),('$STRANGER','customer'),('$BEA','customer')
on conflict (id) do update set role = excluded.role;
insert into public.hubs (id,name,slug,owner_id,is_active) values
 ('$HUB_ONE','ZZ TEST OneShetland','zz-test-oneshetland','$ONE',true),
 ('$HUB_ANN','ZZ TEST Harbour Gala','zz-test-harbour-gala','$ANN',true),
 ('$HUB_BEA','ZZ TEST Voar Festival','zz-test-voar-festival','$BEA',true);
insert into public.edition_packages (code,name,description,price_pence,duration_days,features,max_members,active,sort,audience,kind,grants,is_free)
values ('community_launch','Community Launch','Free for twelve months.',0,365,
 '["collect_payments","memberships","participation_fees","offline_records","csv_export"]'::jsonb,null,true,5,'any','package','{}'::jsonb,true)
on conflict (code) do update set active = true;
SQL
sw editions.signup_open true

# Two live Editions, built through the real organiser journey so every gate is genuinely satisfied.
live_edition() { # <uid> <hub> <slug> <title>
  local uid=$1 hub=$2 slug=$3 title=$4 org ed pkg
  asuser "$uid" "select public.edition_ensure_organiser('hub','$hub');" >/dev/null
  org=$(q "select id from public.edition_organisers where hub_id='$hub'")
  asuser "$uid" "insert into public.editions (organiser_id,title,slug,summary,kind,starts_on,ends_on) values ('$org','$title','$slug','A real summary, long enough to pass the gate.','season',current_date,current_date + 60);" >/dev/null
  ed=$(q "select id from public.editions where slug='$slug'")
  asuser "$uid" "insert into public.edition_pages (edition_id,slug,nav_label,title,body,position,in_nav,is_home) values ('$ed','welcome','Welcome','Welcome','What is on, and where.',1,true,true);" >/dev/null
  asuser "$uid" "select public.edition_submit_for_review('$ed');" >/dev/null
  asuser "$STELLA" "select public.admin_review_edition('$ed','approve','Checked.');" >/dev/null
  pkg=$(q "select id from public.edition_packages where code='community_launch'")
  asuser "$uid" "select public.edition_claim_free_package('$org','$ed','$pkg','attempt-$slug');" >/dev/null
  asuser "$uid" "select public.edition_set_status('$ed','published');" >/dev/null
  if [ "$(q "select status||'/'||review_state from public.editions where id='$ed'")" != "published/approved" ]; then
    echo "  FIXTURE FAILED for $slug: $(q "select status||'/'||review_state from public.editions where id='$ed'")" >&2
    asuser "$uid" "select public.edition_set_status('$ed','published');" >&2
    exit 1
  fi
  echo "$org $ed"
}
read -r ORG_ONE ED_ONE <<< "$(live_edition "$ONE" "$HUB_ONE" zz-yule "ZZ TEST Yule in Shetland")"
read -r ORG_ANN ED_ANN <<< "$(live_edition "$ANN" "$HUB_ANN" zz-gala "ZZ TEST Harbour Gala")"
echo "  OneShetland's Edition: $(q "select status||'/'||review_state from public.editions where id='$ED_ONE'")   ordinary organiser's: $(q "select status||'/'||review_state from public.editions where id='$ED_ANN'")"
T=$(q "select public.edition_promo_today()")
echo "  today (Europe/London): $T"
echo

echo "═══ 1. WHO MAY SAY WHAT IS ONESHETLAND'S OWN ═══"
deny "an ordinary organiser cannot mark an organiser as OneShetland's own" "$ANN" "select public.admin_set_edition_organiser_house('$ORG_ONE',true,'trying it on');" "admins only"
deny "a signed-out-style stranger cannot either" "$STRANGER" "select public.admin_set_edition_organiser_house('$ORG_ONE',true,'trying it on');" "admins only"
deny "an administrator needs a reason" "$STELLA" "select public.admin_set_edition_organiser_house('$ORG_ONE',true,'x');" "reason_required\|at least 5"
q "update public.edition_organisers set status='pending' where id='$ORG_ONE'" >/dev/null
deny "an unverified organiser cannot be marked as OneShetland's own" "$STELLA" "select public.admin_set_edition_organiser_house('$ORG_ONE',true,'official platform campaigns');" "verified"
q "update public.edition_organisers set status='verified' where id='$ORG_ONE'" >/dev/null
try "an administrator marks OneShetland's own organiser" "$STELLA" "select public.admin_set_edition_organiser_house('$ORG_ONE',true,'OneShetland runs this Hub itself');"
eq "it is recorded in the audit trail with the reason" \
   "$(q "select count(*) from public.edition_audit_log where action='organiser_house_set' and organiser_id='$ORG_ONE' and actor='$STELLA' and detail->>'reason'='OneShetland runs this Hub itself' and (detail->>'is_house')::boolean")" 1
echo

echo "═══ 2. THE COMMERCIAL RULE STILL BITES — INCLUDING FOR ADMINISTRATORS ═══"
deny "a 49-day homepage run through the ORDINARY admin route is refused" "$STELLA" "select public.admin_promo_feature('$ED_ONE','homepage','$T',49,'Christmas season');" "more than 14 homepage days"
deny "a house promotion is refused for an organiser that is not OneShetland's own" "$STELLA" "select public.admin_promo_feature_house('$ED_ANN','homepage','$T',49,'Christmas season');" "not_house\|runs itself"
deny "an ordinary organiser cannot create a house promotion" "$ANN" "select public.admin_promo_feature_house('$ED_ONE','homepage','$T',49,'Christmas season');" "admins only"
deny "a house promotion still cannot run past the publishing period" "$STELLA" "select public.admin_promo_feature_house('$ED_ONE','homepage','$T',400,'too long');" "outside_publish_window\|publishing period"
deny "400 days is the house ceiling" "$STELLA" "select public.admin_promo_feature_house('$ED_ONE','homepage','$T',401,'too long');" "1 to 400"
echo

echo "═══ 3. THE 49-DAY OFFICIAL CAMPAIGN ═══"
try "an administrator features OneShetland's own Edition for 49 days" "$STELLA" "select * from public.admin_promo_feature_house('$ED_ONE','homepage','$T',49,'Christmas and New Year in Shetland: official OneShetland campaign');"
eq "one booking, 49 days long" "$(q "select (ends_on - starts_on + 1)::text from public.edition_promo_bookings where edition_id='$ED_ONE' and status='booked'")" 49
eq "the right is stamped as a house promotion, granted by the administrator, with no order" \
   "$(q "select (is_house::text||'/'||source||'/'||(granted_by='$STELLA')::text||'/'||(order_id is null)::text) from public.edition_promo_rights where edition_id='$ED_ONE'")" "true/admin_grant/true/true"
eq "it is audited with its dates and reason" \
   "$(q "select count(*) from public.edition_audit_log where action='promo_house_featured' and actor='$STELLA' and detail->>'starts_on'='$T' and (detail->>'days')::int=49 and detail->>'reason' like 'Christmas and New Year%'")" 1
# edition_featured returns nothing at all while the public switch is off, so the switch is turned on just long
# enough to prove the booking reaches the strip, then turned off again.
sw editions.enabled true
eq "it is on the homepage strip from its first day" "$(q "select count(*) from public.edition_featured('homepage') where edition_id='$ED_ONE'")" 1
sw editions.enabled false
eq "with the public switch off the strip is empty again" "$(q "select count(*) from public.edition_featured('homepage')")" 0
echo

echo "═══ 4. NOTHING LEAKED INTO THE COMMERCIAL ALLOWANCE ═══"
# The house run occupies the next 49 days. A commercial 14-day booking straight afterwards sits inside the same
# rolling 90 days: it is allowed only because house days are left OUT of the fairness count.
try "OneShetland can still book its 14 commercial homepage days inside the same 90 days" "$STELLA" "select * from public.admin_promo_feature('$ED_ONE','homepage','$(q "select '$T'::date + 49")',14,'ordinary commercial booking');"
deny "but one day more than the limit is still refused" "$STELLA" "select * from public.admin_promo_feature('$ED_ONE','homepage','$(q "select '$T'::date + 64")',1,'one over');" "more than 14 homepage days"
try "an ordinary organiser can still book its full 14 days" "$STELLA" "select * from public.admin_promo_feature('$ED_ANN','homepage','$T',14,'ordinary organiser booking');"
deny "and is still refused the 15th" "$STELLA" "select * from public.admin_promo_feature('$ED_ANN','homepage','$(q "select '$T'::date + 14")',1,'one over');" "more than 14 homepage days"
eq "the fairness limit itself is unchanged" "$(q "select public.edition_promo_cfg_int('editions.promo.homepage_days_per_90', 14)")" 14
eq "the homepage capacity is unchanged" "$(q "select public.edition_promo_cfg_int('editions.promo.homepage_capacity', 3)")" 3
echo

echo "═══ 5. CAPACITY IS NOT WAIVED ═══"
# Three places a day is the real constraint on the strip, and a house promotion takes one of them like anything
# else. With the capacity set to 2, the two bookings above already fill today, so a third Edition — marked as
# OneShetland's own, so nothing else can be the reason — must still be refused.
read -r ORG_BEA ED_BEA <<< "$(live_edition "$BEA" "$HUB_BEA" zz-voar "ZZ TEST Voar Festival")"
asuser "$STELLA" "select public.admin_set_edition_organiser_house('$ORG_BEA',true,'temporarily official, for the capacity test');" >/dev/null
sw editions.promo.homepage_capacity 2
deny "a house promotion is refused on a day that has no free place" "$STELLA" "select public.admin_promo_feature_house('$ED_BEA','homepage','$T',1,'should be refused: today is full');" "no place is free"
sw editions.promo.homepage_capacity 3
try "with the third place free again, the same house promotion goes through" "$STELLA" "select public.admin_promo_feature_house('$ED_BEA','homepage','$T',1,'now there is room');"
try "an administrator can unmark an organiser" "$STELLA" "select public.admin_set_edition_organiser_house('$ORG_BEA',false,'the capacity test is over');"
deny "and then it cannot have a house promotion any more" "$STELLA" "select public.admin_promo_feature_house('$ED_BEA','homepage','$(q "select '$T'::date + 1")',1,'should be refused now');" "not_house\|runs itself"
echo

echo "═══ 6. WHAT THE ADMIN SCREEN SEES ═══"
# Voar was unmarked at the end of section 5, so exactly one of the three is OneShetland's own.
eq "the candidate list marks OneShetland's own Edition, and only that one" \
   "$(asuser "$STELLA" "select string_agg(title||'='||is_house::text, ', ' order by title) from public.admin_edition_promo_candidates();")" \
   "ZZ TEST Harbour Gala=false, ZZ TEST Voar Festival=false, ZZ TEST Yule in Shetland=true"
deny "a non-administrator is refused the candidate list outright, not handed an empty one" "$ANN" "select * from public.admin_edition_promo_candidates();" "admins only"
echo
echo "───────────────────────────────────────────────"
echo "  $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
