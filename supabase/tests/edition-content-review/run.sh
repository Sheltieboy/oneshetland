#!/usr/bin/env bash
# Telling an organiser that their own words may have gone stale. Against a throwaway replica.
#   pg_ctl -D <pgdata> -o "-p 55455 -k /tmp/jpg" start
#   supabase/tests/edition-content-review/run.sh
set -uo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
export PGHOST=${PGHOST:-/tmp/jpg} PGPORT=${PGPORT:-55455} PGUSER=${PGUSER:-postgres} PGDATABASE=${PGDATABASE:-postgres} LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd)"
LINKS="$HERE/../edition-session-links"
MIG_LINKS="$HERE/../../migrations/20270307000000_edition_sessions_linked_events.sql"
MIG="$HERE/../../migrations/20270308000000_edition_content_review_notices.sql"

OWNER=11111111-1111-4111-8111-111111111111
ADMIN=22222222-2222-4222-8222-222222222222
OUTSIDER=44444444-4444-4444-8444-444444444444
ED=cccccccc-0000-4000-8000-000000000001
EV=eeeeeeee-0000-4000-8000-000000000001
SESS=ffffffff-0000-4000-8000-000000000001

pass=0; fail=0
ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); }
no() { printf "  \033[31m✗\033[0m %s\n     got: %s\n" "$1" "$2"; fail=$((fail+1)); }
is() { [ "$2" = "$3" ] && ok "$1" || no "$1" "$2  (wanted $3)"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) no "$1" "$2  (wanted to contain '$3')";; esac }
hasnt(){ case "$2" in *"$3"*) no "$1" "$2  (should NOT contain '$3')";; *) ok "$1";; esac }
q()  { psql -qAt -c "$1" 2>&1 | tr '\n' '|' | sed 's/|$//'; }
asf(){ local uid="$1"; local f="$2"; { echo "begin;"; echo "set local role authenticated;"; printf "set local request.jwt.claims = '%s';\n" "{\"sub\":\"$uid\",\"role\":\"authenticated\"}"; cat "$f"; echo "commit;"; } | psql -qAt 2>&1 | tr '\n' '|' | sed 's/|$//'; }
as() { local uid="$1"; shift; printf '%s\n' "$*" > /tmp/ecr-stmt.sql; asf "$uid" /tmp/ecr-stmt.sql; }
err(){ as "$@" | grep -o 'ERROR:.*' | head -1 | sed 's/ERROR:  //' | cut -c1-70; }
review(){ printf "select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from public.edition_content_review('%s') r;\n" "$ED" > /tmp/ecr-rev.sql; asf "$1" /tmp/ecr-rev.sql | sed 's/^|*//'; }

echo; echo "── fixtures and migrations ────────────────────────────────────────────────────────────"
psql -v ON_ERROR_STOP=1 -qAt -f "$LINKS/fixtures.sql" >/tmp/ecr-fx.log 2>&1 || { echo "FIXTURES FAILED"; tail -4 /tmp/ecr-fx.log; exit 1; }
psql -v ON_ERROR_STOP=1 -qAt -f "$MIG_LINKS" >/tmp/ecr-m7.log 2>&1 || { echo "20270307 FAILED"; grep ERROR /tmp/ecr-m7.log|head -3; exit 1; }
psql -v ON_ERROR_STOP=1 -qAt -f "$MIG" >/tmp/ecr-m8.log 2>&1 || { echo "20270308 FAILED"; grep ERROR /tmp/ecr-m8.log|head -3; exit 1; }
psql -v ON_ERROR_STOP=1 -qAt -f "$MIG" >/tmp/ecr-m8b.log 2>&1
is "the migration can be applied twice" "$?" "0"

# Pages an organiser wrote by hand. One mentions the switch-on, one mentions only its day, one mentions neither.
psql -qAt -v ON_ERROR_STOP=1 >/dev/null <<EOF
delete from public.edition_pages where edition_id = '$ED';
insert into public.edition_pages (edition_id, slug, nav_label, title, body, position, in_nav, is_home) values
 ('$ED','welcome','Welcome','Welcome','The lights go on at the Market Cross at 3pm on Saturday 5 December.', 0, true, true),
 ('$ED','family','Family','Family','Santa arrives on 5 December. Panto is later in the month.', 1, true, false),
 ('$ED','food','Food','Food','Cafes are open through December. Nothing about the switch-on here.', 2, true, false);
EOF

echo; echo "── 1. nothing to say until something moves ────────────────────────────────────────────"
is "no notices to begin with" "$(q "select count(*) from edition_content_notices")" "0"
is "and the review is empty"  "$(review "$OWNER")" "[]"
# A change to something a sentence would not state must not raise one.
as "$ADMIN" "update public.events set title='ZZ TEST Lights Switch-On (new name)' where id='$EV';" >/dev/null
is "renaming the event raises nothing" "$(q "select count(*) from edition_content_notices")" "0"
as "$ADMIN" "update public.events set status='postponed' where id='$EV';" >/dev/null
is "nor does a status change"          "$(q "select count(*) from edition_content_notices")" "0"
as "$ADMIN" "update public.events set status='published' where id='$EV';" >/dev/null

echo; echo "── 2. a move raises exactly one notice, and says what it was ──────────────────────────"
as "$ADMIN" "update public.events set starts_at='2026-12-12T19:30:00+00', ends_at='2026-12-12T21:00:00+00', venue='Town Hall', locality='Lerwick' where id='$EV';" >/dev/null
is "one notice"                      "$(q "select count(*) from edition_content_notices where resolved_at is null")" "1"
is "it remembers the old date"       "$(q "select to_char(was_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_content_notices")" "2026-12-05 15:00"
is "and the old place"               "$(q "select was_place from edition_content_notices")" "Market Cross, Lerwick"
is "and where it has moved to"       "$(q "select now_place from edition_content_notices")" "Town Hall, Lerwick"
is "the programme itself already followed" "$(q "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_sessions where id='$SESS'")" "2026-12-12 19:30"

echo; echo "── 3. it names the organiser's own pages, and only the ones that match ────────────────"
R="$(review "$OWNER")"
has "the Welcome page is named"  "$R" '"slug": "welcome"'
has "the Family page is named"   "$R" '"slug": "family"'
hasnt "the page that says nothing about it is left out" "$R" '"slug": "food"'
has "it shows which wording matched" "$R" '"5 December"'
has "including the old place"        "$R" '"Market Cross"'
has "and the old time"               "$R" '"3pm"'

echo; echo "── 4. the weak cue that would have matched everything is gone ─────────────────────────"
is "a bare weekday is not a cue" "$(q "select 'Saturday' = any(public.edition_prose_cues('2026-12-05T15:00:00+00'::timestamptz,'Europe/London',null))")" "f"
is "but the weekday with its day is" "$(q "select 'Saturday 5 December' = any(public.edition_prose_cues('2026-12-05T15:00:00+00'::timestamptz,'Europe/London',null))")" "t"
# 23:30 UTC on 30 June is 00:30 on 1 JULY in Shetland (BST). A server reading its own clock would say 30 June.
is "cues are built in the Edition's timezone, not the server's" \
  "$(q "select '1 July' = any(public.edition_prose_cues('2026-06-30T23:30:00+00'::timestamptz,'Europe/London',null))")" "t"
is "and the server's own date is NOT offered"  \
  "$(q "select '30 June' = any(public.edition_prose_cues('2026-06-30T23:30:00+00'::timestamptz,'Europe/London',null))")" "f"

echo; echo "── 5. a second move keeps the OLDEST wording, because the prose may still carry it ────"
as "$ADMIN" "update public.events set starts_at='2026-12-19T19:30:00+00', ends_at='2026-12-19T21:00:00+00' where id='$EV';" >/dev/null
is "still one notice, not two"  "$(q "select count(*) from edition_content_notices where resolved_at is null")" "1"
is "it still remembers the first wording" "$(q "select to_char(was_at at time zone 'UTC','YYYY-MM-DD') from edition_content_notices where resolved_at is null")" "2026-12-05"
is "and has caught up with where it is now" "$(q "select to_char(now_at at time zone 'UTC','YYYY-MM-DD') from edition_content_notices where resolved_at is null")" "2026-12-19"
has "so the Welcome page is still named" "$(review "$OWNER")" '"slug": "welcome"'

echo; echo "── 6. it is a prompt: it never touches a page, a listing or anything published ────────"
is "the pages are exactly as the organiser left them" \
  "$(q "select body from edition_pages where edition_id='$ED' and slug='welcome'")" "The lights go on at the Market Cross at 3pm on Saturday 5 December."
is "all three pages are still there" "$(q "select count(*) from edition_pages where edition_id='$ED'")" "3"
is "the Edition is not suspended or unpublished" "$(q "select status from editions where id='$ED'")" "draft"
is "the session is still in the programme"       "$(q "select count(*) from edition_sessions where id='$SESS'")" "1"

echo; echo "── 7. marking it checked ──────────────────────────────────────────────────────────────"
N="$(q "select id from edition_content_notices where resolved_at is null")"
has "an outsider cannot mark it checked" "$(err "$OUTSIDER" "select public.edition_content_notice_resolve('$N');")" "not permitted"
is "the organiser can"                  "$(err "$OWNER"    "select public.edition_content_notice_resolve('$N');")" ""
is "and it leaves the review"           "$(review "$OWNER")" "[]"
is "but it is kept, not deleted"        "$(q "select count(*) from edition_content_notices")" "1"
is "with who checked it"                "$(q "select resolved_by = '$OWNER' from edition_content_notices where id='$N'")" "t"
as "$ADMIN" "update public.events set venue='Mareel' where id='$EV';" >/dev/null
is "a later move raises a fresh one"    "$(q "select count(*) from edition_content_notices where resolved_at is null")" "1"
is "and the old one stays checked"      "$(q "select count(*) from edition_content_notices where resolved_at is not null")" "1"

echo; echo "── 8. who may see it ──────────────────────────────────────────────────────────────────"
has "somebody with no part in the Edition is refused" "$(err "$OUTSIDER" "select * from public.edition_content_review('$ED');")" "not permitted"
is "anon cannot read the table"      "$(q "select has_table_privilege('anon','public.edition_content_notices','select')")" "f"
is "nor call the review"             "$(q "select has_function_privilege('anon','public.edition_content_review(uuid)','execute')")" "f"
is "platform staff can look"         "$(err "$ADMIN" "select * from public.edition_content_review('$ED');")" ""

echo; echo "── 9. an unlinked item raises nothing at all ──────────────────────────────────────────"
as "$OWNER" "select public.edition_session_unlink_event('$SESS');" >/dev/null
q "update edition_content_notices set resolved_at = now() where resolved_at is null" >/dev/null
as "$ADMIN" "update public.events set starts_at='2026-12-20T19:30:00+00', ends_at='2026-12-20T21:00:00+00', venue='Somewhere else' where id='$EV';" >/dev/null
is "no notice for an item that does not follow it" "$(q "select count(*) from edition_content_notices where resolved_at is null")" "0"

echo
printf "  \033[1m%d passed, %d failed\033[0m\n\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
