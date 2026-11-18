#!/usr/bin/env bash
# Linked Edition sessions, against a throwaway replica of the production schema.
#
#   pg_ctl -D <pgdata> -o "-p 55455 -k /tmp/jpg" start
#   supabase/tests/edition-session-links/run.sh
#
# Every step runs as a real signed-in user (role + request.jwt.claims), so row-level security, column grants and
# triggers all apply exactly as they do in production.
set -uo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
export PGHOST=${PGHOST:-/tmp/jpg} PGPORT=${PGPORT:-55455} PGUSER=${PGUSER:-postgres} PGDATABASE=${PGDATABASE:-postgres} LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../migrations/20270307000000_edition_sessions_linked_events.sql"

OWNER=11111111-1111-4111-8111-111111111111
ADMIN=22222222-2222-4222-8222-222222222222
STRANGER=33333333-3333-4333-8333-333333333333
OUTSIDER=44444444-4444-4444-8444-444444444444
ED=cccccccc-0000-4000-8000-000000000001
EV_LIGHTS=eeeeeeee-0000-4000-8000-000000000001
EV_CAROL=eeeeeeee-0000-4000-8000-000000000002
EV_STRANGER=eeeeeeee-0000-4000-8000-000000000003
S_LIGHTS=ffffffff-0000-4000-8000-000000000001
S_CAROL=ffffffff-0000-4000-8000-000000000002
S_OWN=ffffffff-0000-4000-8000-000000000003

pass=0; fail=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); }
no()   { printf "  \033[31m✗\033[0m %s\n     got: %s\n" "$1" "$2"; fail=$((fail+1)); }
is()   { [ "$2" = "$3" ] && ok "$1" || no "$1" "$2  (wanted $3)"; }
has()  { case "$2" in *"$3"*) ok "$1";; *) no "$1" "$2  (wanted to contain '$3')";; esac }
q()    { psql -qAt -c "$1" 2>&1 | tr '\n' '|' | sed 's/|$//'; }
# Run SQL as a signed-in user; prints the last result, or the error message.
as()   { local uid="$1"; shift; psql -qAt 2>&1 <<EOF | tr '\n' '|' | sed 's/|$//'
begin; set local role authenticated; set local request.jwt.claims = '{"sub":"$uid","role":"authenticated"}';
$*
commit;
EOF
}
err()  { as "$@" | grep -o 'ERROR:.*' | head -1 | sed 's/ERROR:  //' | cut -c1-80; }

echo; echo "── fixtures and migration ─────────────────────────────────────────────────────────────"
psql -v ON_ERROR_STOP=1 -qAt -f "$HERE/fixtures.sql" >/tmp/esl-fx.log 2>&1 || { echo "FIXTURES FAILED:"; tail -5 /tmp/esl-fx.log; exit 1; }
psql -v ON_ERROR_STOP=1 -qAt -f "$MIG" >/tmp/esl-mig.log 2>&1 || { echo "MIGRATION FAILED:"; grep ERROR /tmp/esl-mig.log | head -5; exit 1; }
grep -o 'edition sessions linked to their events: [0-9]* (was [0-9]*)' /tmp/esl-mig.log | sed 's/^/  /'
# It must survive being applied twice: a redeploy, or a repair, must not fail.
psql -v ON_ERROR_STOP=1 -qAt -f "$MIG" >/tmp/esl-mig2.log 2>&1
is "the migration can be applied twice" "$?" "0"

echo; echo "── 1. the copies already in the database were adopted ─────────────────────────────────"
is "the two sessions that were copies are now linked" "$(q "select count(*) from edition_sessions where event_id is not null")" "2"
is "the Edition's own item was left independent" "$(q "select event_id is null from edition_sessions where id='$S_OWN'")" "t"
is "nothing was lost: every session is still in the programme" "$(q "select count(*) from edition_sessions")" "6"
is "the linked sessions took the event's place" "$(q "select venue_text from edition_sessions where id='$S_LIGHTS'")" "Market Cross, Lerwick"
is "ordering was preserved" "$(q "select string_agg(position::text, ',' order by position) from edition_sessions")" "10,15,20,40,50,60"
is "an ambiguous match (two events, one title and time) was NOT guessed at" "$(q "select event_id is null from edition_sessions where id='ffffffff-0000-4000-8000-000000000004'")" "t"
is "nor was one event copied into two sessions" "$(q "select count(*) from edition_sessions where position in (50,60) and event_id is null")" "2"
is "and all of those kept their details" "$(q "select count(*) from edition_sessions where title like 'ZZ TEST%' and starts_at is not null")" "6"
is "the Edition's own words were kept, not overwritten" "$(q "select description from edition_sessions where id='$S_LIGHTS'")" "The Edition's own words about the switch-on."

echo; echo "── 2. an event change reaches the Edition on its own ──────────────────────────────────"
as "$ADMIN" "update public.events set starts_at='2026-12-06T14:00:00+00', ends_at='2026-12-06T15:30:00+00', title='ZZ TEST Lights Switch-On (moved)', venue='Victoria Pier', locality='Lerwick' where id='$EV_LIGHTS';" >/dev/null
is "the date followed"   "$(q "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_sessions where id='$S_LIGHTS'")" "2026-12-06 14:00"
is "the end time followed" "$(q "select to_char(ends_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_sessions where id='$S_LIGHTS'")" "2026-12-06 15:30"
is "the title followed"  "$(q "select title from edition_sessions where id='$S_LIGHTS'")" "ZZ TEST Lights Switch-On (moved)"
is "the place followed"  "$(q "select venue_text from edition_sessions where id='$S_LIGHTS'")" "Victoria Pier, Lerwick"
is "and the Edition's own description did NOT change" "$(q "select description from edition_sessions where id='$S_LIGHTS'")" "The Edition's own words about the switch-on."
is "the independent session was not touched" "$(q "select title from edition_sessions where id='$S_OWN'")" "ZZ TEST Edition-only Workshop"

echo; echo "── 3. the owner of an event needs no rights over the Edition ──────────────────────────"
# The stranger's own event, approved as a partner of this Edition, then put in the programme.
q "insert into edition_links (id, edition_id, kind, event_id, initiated_by, state) values ('99999999-0000-4000-8000-000000000001','$ED','event','$EV_STRANGER','entity','approved') on conflict do nothing" >/dev/null
q "insert into edition_sessions (id, edition_id, title, starts_at, kind, position) values ('ffffffff-0000-4000-8000-000000000009','$ED','ZZ TEST Stranger''s Ceilidh','2026-12-19T20:00:00+00','event', 30) on conflict do nothing" >/dev/null
S_STR=ffffffff-0000-4000-8000-000000000009
is "the Edition may link a partner's approved event" "$(err "$OWNER" "select public.edition_session_link_event('$S_STR','$EV_STRANGER');")" ""
is "the stranger is not on the Edition team" "$(as "$STRANGER" "select public.edition_can('$ED','editor');")" "f"
as "$STRANGER" "update public.events set starts_at='2026-12-20T20:00:00+00', ends_at='2026-12-20T23:00:00+00', venue='New Hall' where id='$EV_STRANGER';" >/dev/null
is "yet their change reached the Edition" "$(q "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI')||' / '||venue_text from edition_sessions where id='$S_STR'")" "2026-12-20 20:00 / New Hall, Brae"

echo; echo "── 4. a linked session cannot be edited out of step ───────────────────────────────────"
as "$OWNER" "update public.edition_sessions set title='Something else entirely', starts_at='2026-12-12T09:00:00+00', ends_at='2026-12-12T10:00:00+00' where id='$S_CAROL';" >/dev/null
is "a hand edit of the title is overruled by the event" "$(q "select title from edition_sessions where id='$S_CAROL'")" "ZZ TEST Carol Service"
is "and so is a hand edit of the time" "$(q "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_sessions where id='$S_CAROL'")" "2026-12-12 19:00"
is "and of the end time"                "$(q "select to_char(ends_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_sessions where id='$S_CAROL'")" "2026-12-12 20:30"
as "$OWNER" "update public.edition_sessions set description='Mulled wine afterwards in the hall.', price_text='Donations', position=99 where id='$S_CAROL';" >/dev/null
is "but the Edition's own words still save" "$(q "select description from edition_sessions where id='$S_CAROL'")" "Mulled wine afterwards in the hall."
is "and so does its price note"             "$(q "select price_text from edition_sessions where id='$S_CAROL'")" "Donations"
is "and its place in the running order"     "$(q "select position from edition_sessions where id='$S_CAROL'")" "99"

echo; echo "── 5. sessions that are only the Edition's keep working ───────────────────────────────"
as "$OWNER" "update public.edition_sessions set title='ZZ TEST Makkin Workshop', starts_at='2026-12-09T18:00:00+00', ends_at='2026-12-09T20:00:00+00', description='Bring your own wool.' where id='$S_OWN';" >/dev/null
is "an independent session edits freely"  "$(q "select title from edition_sessions where id='$S_OWN'")" "ZZ TEST Makkin Workshop"
is "including its date"                   "$(q "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_sessions where id='$S_OWN'")" "2026-12-09 18:00"
has "and it is still held to the Edition's dates" "$(err "$OWNER" "update public.edition_sessions set starts_at='2027-06-01T18:00:00+00' where id='$S_OWN';")" "outside the edition dates"
is "a brand new independent session can still be added" \
  "$(err "$OWNER" "insert into public.edition_sessions (edition_id, title, starts_at, kind) values ('$ED','ZZ TEST Added By Hand','2026-12-15T11:00:00+00','session');")" ""

echo; echo "── 6. a cancelled event says so, and stays ────────────────────────────────────────────"
as "$ADMIN" "update public.events set status='cancelled' where id='$EV_CAROL';" >/dev/null
is "the session reads as cancelled"        "$(q "select status from edition_sessions where id='$S_CAROL'")" "cancelled"
is "it is still in the programme"          "$(q "select count(*) from edition_sessions where id='$S_CAROL'")" "1"
is "its details are still there"           "$(q "select title from edition_sessions where id='$S_CAROL'")" "ZZ TEST Carol Service"
as "$ADMIN" "update public.events set status='postponed' where id='$EV_CAROL';" >/dev/null
is "a postponed event reads as changed"    "$(q "select status from edition_sessions where id='$S_CAROL'")" "changed"
as "$ADMIN" "update public.events set status='published' where id='$EV_CAROL';" >/dev/null
is "and reinstating the event reinstates the session" "$(q "select status from edition_sessions where id='$S_CAROL'")" "scheduled"
# The organiser's own decision is remembered separately from the event's.
as "$OWNER" "update public.edition_sessions set status='cancelled' where id='$S_CAROL';" >/dev/null
is "the organiser may cancel it themselves" "$(q "select status from edition_sessions where id='$S_CAROL'")" "cancelled"
as "$ADMIN" "update public.events set status='cancelled' where id='$EV_CAROL';" >/dev/null
as "$ADMIN" "update public.events set status='published' where id='$EV_CAROL';" >/dev/null
is "and the event reinstating itself does not undo that" "$(q "select status from edition_sessions where id='$S_CAROL'")" "cancelled"
as "$OWNER" "update public.edition_sessions set status='scheduled' where id='$S_CAROL';" >/dev/null
is "the organiser can put it back"          "$(q "select status from edition_sessions where id='$S_CAROL'")" "scheduled"

echo; echo "── 7. a deleted event detaches; the programme keeps the listing ───────────────────────"
as "$ADMIN" "delete from public.events where id='$EV_LIGHTS';" >/dev/null
is "the session is still in the programme"  "$(q "select count(*) from edition_sessions where id='$S_LIGHTS'")" "1"
is "with the last details it was given"     "$(q "select title from edition_sessions where id='$S_LIGHTS'")" "ZZ TEST Lights Switch-On (moved)"
is "its date was not blanked"               "$(q "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from edition_sessions where id='$S_LIGHTS'")" "2026-12-06 14:00"
is "it is marked as detached"               "$(q "select event_detached_at is not null from edition_sessions where id='$S_LIGHTS'")" "t"
is "and it no longer names an event"        "$(q "select event_id is null from edition_sessions where id='$S_LIGHTS'")" "t"
as "$OWNER" "update public.edition_sessions set title='ZZ TEST Lights Switch-On (our copy)' where id='$S_LIGHTS';" >/dev/null
is "a detached session is editable again"   "$(q "select title from edition_sessions where id='$S_LIGHTS'")" "ZZ TEST Lights Switch-On (our copy)"

echo; echo "── 8. linking is not a way into somebody else's event ─────────────────────────────────"
q "delete from edition_links where event_id='$EV_STRANGER'" >/dev/null
q "update edition_sessions set event_id=null, linked_at=null where id='$S_STR'" >/dev/null
has "without an approved partnership the Edition cannot link it" \
  "$(err "$OWNER" "select public.edition_session_link_event('$S_STR','$EV_STRANGER');")" "belongs to somebody else"
has "somebody with no part in the Edition cannot link anything" \
  "$(err "$OUTSIDER" "select public.edition_session_link_event('$S_STR','$EV_STRANGER');")" "not permitted"
is "the event's own owner may link it to an Edition they edit" "$(as "$STRANGER" "select public.edition_session_may_link('$ED','$EV_STRANGER');")" "t"
is "platform staff may link one of OneShetland's own events"   "$(as "$ADMIN" "select public.edition_session_may_link('$ED','$EV_CAROL');")" "t"
is "the Edition's owner may NOT link a platform event they do not run" "$(as "$OWNER" "select public.edition_session_may_link('$ED','$EV_CAROL');")" "f"
is "anon cannot reach the linking functions" \
  "$(q "select has_function_privilege('anon','public.edition_session_link_event(uuid,uuid)','execute')")" "f"

echo; echo "── 9. the Edition's dates are checked when the link is made, not afterwards ───────────"
q "insert into events (id,title,starts_at,status,is_hidden,is_platform_event,organiser_hub_id,hub_visibility) values ('eeeeeeee-0000-4000-8000-000000000009','ZZ TEST Far Away','2027-07-01T12:00:00+00','published',false,false,'aaaaaaaa-0000-4000-8000-000000000001','islands') on conflict do nothing" >/dev/null
q "insert into edition_sessions (id,edition_id,title,starts_at,kind) values ('ffffffff-0000-4000-8000-00000000000a','$ED','ZZ TEST Placeholder','2026-12-15T12:00:00+00','session') on conflict do nothing" >/dev/null
has "an event outside the Edition cannot be linked in" \
  "$(err "$OWNER" "select public.edition_session_link_event('ffffffff-0000-4000-8000-00000000000a','eeeeeeee-0000-4000-8000-000000000009');")" "not inside this Edition"
# ...but once linked, the event owner must never be blocked by somebody else's programme.
is "a linked event may later move outside, and is not refused" \
  "$(err "$ADMIN" "update public.events set starts_at='2027-03-01T19:00:00+00', ends_at='2027-03-01T20:30:00+00' where id='$EV_CAROL';")" ""
is "and the session followed it rather than vanishing" \
  "$(q "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD') from edition_sessions where id='$S_CAROL'")" "2027-03-01"
is "the session is still in the programme"  "$(q "select count(*) from edition_sessions where id='$S_CAROL'")" "1"

echo; echo "── 10. unlinking keeps what it was showing ────────────────────────────────────────────"
is "unlink succeeds"                        "$(err "$OWNER" "select public.edition_session_unlink_event('$S_CAROL');")" ""
is "it keeps the details it had"            "$(q "select title from edition_sessions where id='$S_CAROL'")" "ZZ TEST Carol Service"
is "and stops following the event"          "$(q "select event_id is null from edition_sessions where id='$S_CAROL'")" "t"
as "$ADMIN" "update public.events set title='ZZ TEST Carol Service (renamed after unlink)' where id='$EV_CAROL';" >/dev/null
is "a later event change no longer reaches it" "$(q "select title from edition_sessions where id='$S_CAROL'")" "ZZ TEST Carol Service"

echo; echo "── 11. cost ───────────────────────────────────────────────────────────────────────────"
has "the mirror finds its sessions by index, not by scanning" \
  "$(q "explain (costs off) update edition_sessions set updated_at=now() where event_id='$EV_CAROL'" )" "Index"
is "an event edit that touches nothing shared does no work at all" \
  "$(q "select count(*) from pg_trigger t where t.tgrelid='public.events'::regclass and t.tgname='events_sync_edition_sessions' and pg_get_triggerdef(t.oid) like '%WHEN%'")" "1"
is "no linked session anywhere disagrees with its event" \
  "$(q "select count(*) from edition_sessions s join events e on e.id=s.event_id where s.title is distinct from e.title or s.starts_at is distinct from e.starts_at or s.ends_at is distinct from e.ends_at or s.event_status is distinct from e.status")" "0"

echo
printf "  \033[1m%d passed, %d failed\033[0m\n\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
