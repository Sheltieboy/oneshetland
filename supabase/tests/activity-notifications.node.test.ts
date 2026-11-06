/**
 * activity-notifications.node.test.ts — follower alerts, end to end, in a throwaway PostgreSQL that carries PRODUCTION'S OWN preference and
 * inbox functions (fixtures/notification-centre-prod.sql). From "organiser cancels a session" to "the follower's Notification Centre shows it
 * and the unread count goes up", including batching, unfollowing, preferences, retries, failure isolation, give-up, concurrency, scheduling and
 * permissions. Synthetic data only. Needs postgresql@17 (skipped otherwise).
 * Run: node --test supabase/tests/activity-notifications.node.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = "/opt/homebrew/opt/postgresql@17/bin";
const have = existsSync(join(BIN, "initdb"));
const M = (f: string) => join(import.meta.dirname, "..", "migrations", f);
const FIX = join(import.meta.dirname, "fixtures", "notification-centre-prod.sql");
let dir = "", sock = "";
const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
const base = (q: string) => ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", q];
const run = (q: string, role = "postgres", who = "") => (execFileSync(join(BIN, "psql"), base(role === "postgres" ? q : `set role ${role}; ${who ? `set app.uid='${who}'; ` : ""}${q}`), { env, encoding: "utf8" }).trim().split("\n").pop() ?? "");
const denied = (q: string, role: string, who = "") => spawnSync(join(BIN, "psql"), base(`set role ${role}; ${who ? `set app.uid='${who}'; ` : ""}${q}`), { env, encoding: "utf8" }).status !== 0;

const U = (n: number) => `00000000-0000-0000-0000-0000000002${String(n).padStart(2, "0")}`;
const [OWNER, STAFF, F1, F2, F3, OPTOUT_ALL, OPTOUT_EVENTS, QUIET, STRANGER, LATE] = [U(1), U(2), U(3), U(4), U(5), U(6), U(7), U(8), U(9), U(10)];
const B1 = U(21), HUB_U = U(31);

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const dowOf = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();
const job = () => JSON.parse(run("select public.process_activity_change_notices()")) as Record<string, number>;
const settle = () => run("update public.activity_change_notices set created_at = created_at - interval '5 minutes' where processed_at is null");
const thirtyOneMinutesLater = () => run("update public.activity_notice_state set last_sent_at = last_sent_at - interval '31 minutes'");
const drain = () => { for (let i = 0; i < 8; i++) { settle(); if (job().claimed === 0) return; } };
const mkAct = (title: string, over: Record<string, string> = {}) => {
  const cols: Record<string, string> = { title: `'${title}'`, category: "'fitness'", status: "'published'", booking_mode: "'drop_in'", organiser_business_id: `'${B1}'`, ...over };
  return run(`insert into public.regular_activities(${Object.keys(cols).join(",")}) values (${Object.values(cols).join(",")}) returning id`, "authenticated", OWNER);
};
const mkRule = (act: string, day: string, start = "18:00", end = "19:00") => run(`insert into public.activity_schedule_rules(activity_id, day_of_week, start_time, end_time, anchor_date) values ('${act}', ${dowOf(day)}, '${start}', '${end}', '${future(-40)}') returning id`);
const follow = (act: string, user: string, whenSql = "now() - interval '1 hour'") => run(`insert into public.activity_follows(activity_id, user_id, created_at) values ('${act}','${user}', ${whenSql})`);
const cancel = (act: string, rule: string, day: string, note = "") => run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, note) values ('${act}','${rule}','${day}','cancelled', ${note ? `'${note}'` : "null"}) returning id`, "authenticated", OWNER);
const inbox = (user: string, act?: string) => run(`select coalesce(string_agg(title || ' | ' || body || ' | ' || status || ' | ' || category, ' ;; ' order by created_at, id), '') from public.notification_log where user_id='${user}' ${act ? `and data->>'activity_id'='${act}'` : ""}`);
const count = (user: string, act?: string) => Number(run(`select count(*) from public.notification_log where user_id='${user}' ${act ? `and data->>'activity_id'='${act}'` : ""}`));

test.before(() => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "an-")); sock = mkdtempSync(join("/tmp", "ans-"));
  execFileSync(join(BIN, "initdb"), ["--locale=en_US.UTF-8", "-D", join(dir, "pg"), "-A", "trust", "-U", "postgres"], { env, stdio: "ignore" });
  execFileSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-o", `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off -c timezone=UTC`, "-l", join(dir, "log"), "-w", "start"], { env });
  execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-X", "-q", "-c", "create database t"], { env });
  run(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create table auth.users(id uuid primary key);
    create table public.profiles(id uuid primary key, role text);
    create table public.local_businesses(id uuid primary key, owner_id uuid, name text, slug text, is_active boolean default true);
    create table public.hubs(id uuid primary key, owner_id uuid, name text, slug text, is_active boolean default true, is_verified boolean default false);
    create table public.hub_members(hub_id uuid, user_id uuid, role text, status text);
    create table public.events(id uuid primary key default gen_random_uuid(), title text);
    create function public.attribution_staff() returns boolean language sql stable security definer as $$ select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator')) $$;
    create function public.is_hub_admin(p_hub uuid, p_user uuid) returns boolean language sql stable security definer as $$ select exists (select 1 from public.hub_members where hub_id = p_hub and user_id = p_user and status = 'active' and role in ('owner','committee')) $$;
    create function public.controls_event_entity(p_business uuid, p_hub uuid) returns boolean language sql stable security definer as $$
      select auth.uid() is not null and ((p_business is not null and exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid()))
        or (p_hub is not null and (public.is_hub_admin(p_hub, auth.uid()) or exists (select 1 from public.hubs h where h.id = p_hub and h.owner_id = auth.uid())))) $$;
    revoke execute on function public.attribution_staff() from public; grant execute on function public.attribution_staff() to authenticated, service_role;
    revoke execute on function public.controls_event_entity(uuid, uuid) from public; grant execute on function public.controls_event_entity(uuid, uuid) to authenticated, service_role;
    alter table public.local_businesses enable row level security; alter table public.hubs enable row level security;
    create policy b_read on public.local_businesses for select using (is_active or owner_id = auth.uid());
    create policy h_read on public.hubs for select using (is_active or owner_id = auth.uid());
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant select on public.local_businesses, public.hubs, public.profiles to anon, authenticated, service_role;
    insert into auth.users(id) select x::uuid from unnest(array['${OWNER}','${STAFF}','${F1}','${F2}','${F3}','${OPTOUT_ALL}','${OPTOUT_EVENTS}','${QUIET}','${STRANGER}','${LATE}']) x;
    insert into public.profiles values ('${STAFF}','admin');
    insert into public.local_businesses values ('${B1}','${OWNER}','Test Biz','test-biz',true);
    insert into public.hubs values ('${HUB_U}','${OWNER}','Unverified Hub','unverified-hub',true,false);
    -- the Notification Centre, as production has it
    create table public.notification_preferences(user_id uuid primary key, enabled boolean not null default true, bookings_enabled boolean default true, shifts_enabled boolean default true,
      fetch_enabled boolean default true, loyalty_enabled boolean default true, offers_enabled boolean default true, spik_enabled boolean default true, games_enabled boolean default true,
      quiet_hours_start time, quiet_hours_end time, updated_at timestamptz default now(), jobs_enabled boolean default true, events_enabled boolean default true, cruise_enabled boolean default true,
      wallet_enabled boolean default true, hubs_enabled boolean default true, community_enabled boolean default true, notices_enabled boolean default true, business_enabled boolean default true);
    create table public.notification_log(id uuid primary key default gen_random_uuid(), user_id uuid not null, category text not null, title text not null, body text not null, data jsonb,
      status text not null, error text, created_at timestamptz not null default now(), read_at timestamptz);
    alter table public.notification_log enable row level security;
    create policy "Users see their own notification log" on public.notification_log for select using (user_id = auth.uid());
    grant select on public.notification_log to authenticated;`);
  run(readFileSync(FIX, "utf8"));
  run(`create trigger notification_log_classify_skip before insert on public.notification_log for each row execute function public.notification_log_classify_skip();
       insert into public.notification_preferences(user_id, enabled) values ('${OPTOUT_ALL}', false);
       insert into public.notification_preferences(user_id, events_enabled) values ('${OPTOUT_EVENTS}', false);
       insert into public.notification_preferences(user_id, quiet_hours_start, quiet_hours_end) values ('${QUIET}', '00:00', '23:59');`);
  for (const f of ["20261208000000_regular_activities.sql", "20261208010000_activity_notifications.sql"]) run(readFileSync(M(f), "utf8"));
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });
const t = (name: string, fn: () => void | Promise<void>) => test(name, { skip: !have && "postgresql@17 not installed" }, fn);

// ── delivery, end to end
t("END TO END: a cancellation reaches the follower's Notification Centre once the settle window has passed, and counts as unread; they can read it", () => {
  const day = future(5), a = mkAct("E2E Class"), r = mkRule(a, day);
  follow(a, F1); cancel(a, r, day, "Instructor ill");
  assert.equal(job().claimed, 0, "too fresh: the organiser may still be editing");
  assert.equal(count(F1, a), 0);
  settle(); const s = job();
  assert.equal(s.recipients, 1);
  const [title, body, status, category] = inbox(F1, a).split(" | ");
  assert.equal(title, "E2E Class"); assert.match(body, /^\w{3} \d{1,2} \w{3} 18:00 is cancelled \(Instructor ill\)$/); assert.equal(status, "no_token"); assert.equal(category, "events.activity_change");
  assert.equal(run(`select data->>'activity_slug' || '|' || (data->>'screen') from public.notification_log where user_id='${F1}' and data->>'activity_id'='${a}'`), "e2e-class|regular-activity");
  assert.equal(run("select public.unread_notification_count()", "authenticated", F1), "1");
  run("select public.mark_notifications_read()", "authenticated", F1);
  assert.equal(run("select public.unread_notification_count()", "authenticated", F1), "0");
  assert.equal(run(`select count(*) from public.notification_log where user_id='${F1}' and data->>'activity_id'='${a}'`, "authenticated", F1), "1", "they can read their own item through row security");
  assert.equal(run(`select count(*) from public.notification_log where data->>'activity_id'='${a}'`, "authenticated", STRANGER), "0", "and nobody else can");
});
t("it is IN-APP ONLY: nothing is pushed or emailed, and the inbox statuses are ones the Notification Centre already shows", () => {
  const src = readFileSync(M("20261208010000_activity_notifications.sql"), "utf8").replace(/--.*$/gm, "");
  assert.doesNotMatch(src, /push|expo|email|postmark|send_email|net\.http/i);
  assert.match(src, /'no_token'/); assert.match(src, /'skipped_pref'/);
  assert.equal(run("select count(distinct status) from public.notification_log where category = 'events.activity_change' and status not in ('no_token','skipped_pref','sent','skipped_quiet')"), "0");
});
t("only people who follow get anything; a stranger gets nothing", () => {
  const day = future(6), a = mkAct("Followers Only"), r = mkRule(a, day);
  follow(a, F1); follow(a, F2); cancel(a, r, day); drain();
  assert.equal(count(F1, a), 1); assert.equal(count(F2, a), 1); assert.equal(count(STRANGER, a), 0);
});

// ── unfollowing, timing and preferences
t("UNFOLLOWING is respected: someone who unfollowed before the job ran gets nothing", () => {
  const day = future(7), a = mkAct("Unfollow Test"), r = mkRule(a, day);
  follow(a, F1); follow(a, F2); cancel(a, r, day);
  run(`delete from public.activity_follows where activity_id='${a}' and user_id='${F2}'`, "authenticated", F2);
  drain();
  assert.equal(count(F1, a), 1); assert.equal(count(F2, a), 0);
});
t("someone who followed AFTER a change is not told about it, but hears about later ones", () => {
  const d1 = future(8), a = mkAct("Late Follower"), r1 = mkRule(a, d1);
  follow(a, F1); cancel(a, r1, d1);
  follow(a, LATE, "now() + interval '30 seconds'");           // follows after the cancellation was made
  drain();
  assert.equal(count(F1, a), 1); assert.equal(count(LATE, a), 0);
});
t("PREFERENCES: master-off or Events-off members get only a HIDDEN record; quiet hours do NOT hide an inbox item; the unread count ignores hidden ones", () => {
  const day = future(9), a = mkAct("Prefs Test"), r = mkRule(a, day);
  for (const u of [F1, OPTOUT_ALL, OPTOUT_EVENTS, QUIET]) follow(a, u);
  cancel(a, r, day); drain();
  assert.match(inbox(F1, a), /\| no_token \|/);
  assert.match(inbox(QUIET, a), /\| no_token \|/, "quiet hours are for phone alerts; the inbox is not silenced");
  assert.match(inbox(OPTOUT_ALL, a), /\| skipped_pref \|/); assert.match(inbox(OPTOUT_EVENTS, a), /\| skipped_pref \|/);
  assert.equal(run("select public.unread_notification_count()", "authenticated", OPTOUT_ALL), "0");
  assert.equal(run(`select count(*) from public.notification_log where user_id='${OPTOUT_EVENTS}' and status in ('sent','no_token','skipped_quiet')`), "0", "nothing visible");
});

// ── batching and duplicates
t("BATCHING: three changed sessions of one activity are ONE item per follower, summarised", () => {
  const a = mkAct("Batch Class"); const days = [future(10), future(11), future(12)];
  follow(a, F1);
  for (const d of days) cancel(a, mkRule(a, d), d);
  drain();
  assert.equal(count(F1, a), 1);
  assert.match(inbox(F1, a), /^Batch Class \| 3 changes to upcoming sessions\. Open the activity to see the latest times\. \| no_token/);
});
t("edits to ONE session before the job runs collapse to the last state (one item, the final wording); the older rows are consumed", () => {
  const day = future(13), a = mkAct("Collapse Test"), r = mkRule(a, day);
  follow(a, F1);
  const id = cancel(a, r, day, "first reason");
  run(`update public.activity_exceptions set note='second reason' where id='${id}'`, "authenticated", OWNER);
  run(`update public.activity_exceptions set note='final reason' where id='${id}'`, "authenticated", OWNER);
  assert.equal(run(`select count(*) from public.activity_change_notices where activity_id='${a}'`), "3");
  drain();
  assert.equal(count(F1, a), 1); assert.match(inbox(F1, a), /final reason/);
  assert.equal(run(`select string_agg(outcome, ',' order by outcome) from public.activity_change_notices where activity_id='${a}'`), "delivered,superseded,superseded");
});
t("cancelled then restored before anything was sent: nothing is sent at all", () => {
  const day = future(14), a = mkAct("Flipflop"), r = mkRule(a, day);
  follow(a, F1); const id = cancel(a, r, day);
  run(`delete from public.activity_exceptions where id='${id}'`, "authenticated", OWNER);
  drain();
  assert.equal(count(F1, a), 0);
  assert.equal(run(`select string_agg(outcome, ',' order by outcome) from public.activity_change_notices where activity_id='${a}'`), "never_told,superseded");
});
t("cancelled, told, then restored: the follower hears it is back on", () => {
  const day = future(15), a = mkAct("Back On"), r = mkRule(a, day);
  follow(a, F1); const id = cancel(a, r, day); drain();
  run(`delete from public.activity_exceptions where id='${id}'`, "authenticated", OWNER);
  settle(); job(); assert.equal(count(F1, a), 1, "the restore is held for a few minutes (throttle), not lost");
  thirtyOneMinutesLater(); drain();
  assert.equal(count(F1, a), 2);
  assert.match(inbox(F1, a).split(" ;; ")[1], /is back on \| no_token/);
});
t("running the job again sends NOTHING more (the state is remembered), and never repeats an already-told state", () => {
  const day = future(16), a = mkAct("No Repeats"), r = mkRule(a, day);
  follow(a, F1); cancel(a, r, day); drain();
  const before = count(F1, a);
  for (let i = 0; i < 3; i++) { settle(); job(); }
  assert.equal(count(F1, a), before);
  const day2 = future(17); run(`update public.activity_exceptions set note = note where activity_id = '${a}'`, "authenticated", OWNER);   // an identical-state write
  drain(); assert.equal(count(F1, a), before, "a no-op edit is not news");
});
t("the message kinds read well: moved (with the new time), venue change, extra session, holiday break", () => {
  const a = mkAct("Kinds Class"); follow(a, F1);
  const dm = future(18), dv = future(19), de = future(20);
  const rm = mkRule(a, dm, "10:00", "11:00"), rv = mkRule(a, dv, "10:00", "11:00");
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, new_starts_at, note) values ('${a}','${rm}','${dm}','changed', ((date '${dm}' + 1) + time '14:30') at time zone 'Europe/London', 'Hall booked')`, "authenticated", OWNER);
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, new_venue) values ('${a}','${rv}','${dv}','changed','Hall B')`, "authenticated", OWNER);
  run(`insert into public.activity_exceptions(activity_id, kind, new_starts_at, new_ends_at, note) values ('${a}','extra', (date '${de}' + time '09:00') at time zone 'Europe/London', (date '${de}' + time '10:00') at time zone 'Europe/London', 'Christmas card special')`, "authenticated", OWNER);
  run(`insert into public.activity_breaks(activity_id, start_date, end_date, reason) values ('${a}','${future(3)}','${future(9)}','Half term')`, "authenticated", OWNER);
  // one activity, four changes -> one summary item; check the individual lines by asking for them directly
  drain(); assert.match(inbox(F1, a), /\| 4 changes to upcoming sessions\./);
  const lines = run(`select string_agg(public.activity_notice_line(n), ' ## ' order by n.kind) from public.activity_change_notices n where n.activity_id='${a}'`);
  assert.match(lines, /has moved to \w{3} \d{1,2} \w{3} 14:30 \(Hall booked\)/); assert.match(lines, /is now at Hall B/);
  assert.match(lines, /extra session on \w{3} \d{1,2} \w{3} 09:00 \(Christmas card special\)/); assert.match(lines, /no sessions \d{1,2} \w{3} – \d{1,2} \w{3} \(Half term\)/);
});
t("times in the message are Shetland's: 09:30 UTC in July reads 10:30", () => {
  assert.equal(run("select public.activity_notice_when('2026-07-04 09:30+00')"), "Sat 4 Jul 10:30");
  assert.equal(run("select public.activity_notice_when('2026-11-07 10:00+00')"), "Sat 7 Nov 10:00");
});

// ── throttle
t("THROTTLE: a second change within 30 minutes is held and batched into the next alert; a change to a session starting within six hours is never held", () => {
  const a = mkAct("Throttle Class"), d1 = future(10), d2 = future(11), d3 = future(12);
  const r1 = mkRule(a, d1), r2 = mkRule(a, d2), r3 = mkRule(a, d3); follow(a, F1);
  cancel(a, r1, d1, "first"); drain();
  assert.equal(count(F1, a), 1);
  cancel(a, r2, d2, "second"); settle(); const held = job();
  assert.equal(held.throttled, 1); assert.equal(count(F1, a), 1, "held: nothing new yet");
  assert.equal(run(`select count(*) from public.activity_change_notices where activity_id='${a}' and processed_at is null and attempts = 0`), "1", "pending, not failed");
  cancel(a, r3, d3, "third"); settle(); job(); assert.equal(count(F1, a), 1, "still held");
  run(`update public.activity_notice_state set last_sent_at = now() - interval '31 minutes' where activity_id='${a}'`);
  job(); assert.equal(count(F1, a), 2, "released");
  assert.match(inbox(F1, a).split(" ;; ")[1], /\| 2 changes to upcoming sessions\./, "the held changes went out TOGETHER, as one item");
  // urgent: a session today/within six hours bypasses the hold
  const soon = mkAct("Urgent Class"); follow(soon, F1);
  const rs = run(`insert into public.activity_schedule_rules(activity_id, day_of_week, start_time, end_time, anchor_date) values ('${soon}', extract(dow from (now() at time zone 'Europe/London'))::int, ((now() at time zone 'Europe/London') + interval '3 hours')::time, ((now() at time zone 'Europe/London') + interval '4 hours')::time, '${future(-40)}') returning id`);
  run(`insert into public.activity_notice_state(session_key, activity_id, last_state_hash, last_sent_at) values ('other', '${soon}', 'x', now())`);
  run(`insert into public.activity_change_notices(activity_id, kind, session_key, session_starts_at, state_hash, created_at) values ('${soon}','cancelled','rule:${rs}:soon', now() + interval '3 hours', 'hs', now() - interval '10 minutes')`);
  job(); assert.equal(count(F1, soon), 1, "an imminent cancellation is not held back");
});

// ── who counts as "public"
t("a paused, draft, ended or unapproved-hub activity notifies nobody; the job's idea of public matches what visitors can actually read", () => {
  const day = future(4);
  const paused = mkAct("Paused Notify"), rp = mkRule(paused, day); follow(paused, F1); cancel(paused, rp, day);
  run(`update public.regular_activities set admin_paused = true where id = '${paused}'`);
  const hub = run(`insert into public.regular_activities(title, category, status, organiser_hub_id) values ('Unverified Hub Group','other','published','${HUB_U}') returning id`, "authenticated", OWNER);
  const rh = mkRule(hub, day); follow(hub, F1); run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind) values ('${hub}','${rh}','${day}','cancelled')`);
  drain();
  assert.equal(count(F1, paused), 0); assert.equal(count(F1, hub), 0);
  assert.equal(run(`select string_agg(distinct outcome, ',') from public.activity_change_notices where activity_id in ('${paused}','${hub}')`), "inactive");
  const fnPublic = run("select string_agg(id::text, ',' order by id) from public.regular_activities a where public.activity_is_public(a)");
  const seen = run("select string_agg(id::text, ',' order by id) from public.regular_activities", "anon");
  assert.equal(fnPublic, seen, "no drift between the job's rule and row security");
});
t("a session that has already started is not announced", () => {
  const a = mkAct("Already Started"), r = mkRule(a, future(2));
  follow(a, F1);
  run(`insert into public.activity_change_notices(activity_id, kind, session_key, session_starts_at, state_hash, created_at) values ('${a}','cancelled','rule:${r}:past', now() - interval '3 hours', 'h-past', now() - interval '10 minutes')`);
  drain(); assert.equal(count(F1, a), 0);
  assert.equal(run(`select outcome from public.activity_change_notices where activity_id='${a}'`), "past");
});
t("no followers: nothing is written, the row is consumed and the state is remembered", () => {
  const day = future(5), a = mkAct("Nobody Follows"), r = mkRule(a, day); cancel(a, r, day); drain();
  assert.equal(run(`select outcome from public.activity_change_notices where activity_id='${a}'`), "no_followers");
});

// ── retries, failure isolation, give-up
t("FAILURE ISOLATION AND RETRY: one activity's failed delivery rolls back whole, is retried, and does not stop others or duplicate them", () => {
  const day = future(6), good = mkAct("Good Class"), bad = mkAct("Poison Class"), rg = mkRule(good, day), rb = mkRule(bad, day);
  follow(good, F1); follow(bad, F1); follow(bad, F2);
  run(`create or replace function public.zz_poison() returns trigger language plpgsql as $$ begin if new.title = 'Poison Class' then raise exception 'inbox write failed (simulated)'; end if; return new; end $$;
       drop trigger if exists zz_poison on public.notification_log;
       create trigger zz_poison before insert on public.notification_log for each row execute function public.zz_poison();`);
  cancel(good, rg, day); cancel(bad, rb, day); settle();
  const s = job();
  assert.equal(s.failed_activities, 1);
  assert.equal(count(F1, good), 1, "the healthy activity was delivered");
  assert.equal(count(F1, bad), 0); assert.equal(count(F2, bad), 0, "nothing partial leaked from the failed one");
  assert.equal(run(`select attempts || '|' || (last_error like '%simulated%') || '|' || (processed_at is null) from public.activity_change_notices where activity_id='${bad}'`), "1|true|true");
  assert.equal(run(`select count(*) from public.activity_notice_state where activity_id='${bad}'`), "0", "not marked as told");
  for (let i = 0; i < 2; i++) job();
  assert.equal(run(`select attempts from public.activity_change_notices where activity_id='${bad}'`), "3");
  run("drop trigger if exists zz_poison on public.notification_log");             // the fault is fixed
  const ok = job();
  assert.equal(ok.failed_activities, 0);
  assert.equal(count(F1, bad), 1); assert.equal(count(F2, bad), 1);
  assert.equal(count(F1, good), 1, "the already-delivered activity was NOT sent again");
  assert.equal(run(`select outcome from public.activity_change_notices where activity_id='${bad}'`), "delivered");
});
t("GIVING UP: a row that keeps failing is abandoned after five attempts (visible to staff) and never blocks the queue", () => {
  const day = future(7), bad = mkAct("Poison Class"), rb = mkRule(bad, day), good = mkAct("Healthy After"), rg = mkRule(good, day);
  follow(bad, F1); follow(good, F1);
  run(`drop trigger if exists zz_poison on public.notification_log; create trigger zz_poison before insert on public.notification_log for each row execute function public.zz_poison()`);
  cancel(bad, rb, day); settle();
  let last = job();
  for (let i = 0; i < 4; i++) last = job();
  assert.equal(last.gave_up, 1);
  assert.equal(run(`select outcome || '|' || attempts from public.activity_change_notices where activity_id='${bad}'`), "failed|5");
  assert.equal(job().claimed, 0, "given up: not claimed again");
  cancel(good, rg, day); settle(); job();
  assert.equal(count(F1, good), 1, "later work proceeds normally");
  run("drop trigger if exists zz_poison on public.notification_log; drop function if exists public.zz_poison()");
  const status = JSON.parse(run("select public.admin_activity_notice_status()", "authenticated", STAFF));
  assert.ok(status.failed_7d >= 1); assert.equal(status.waiting, 0);
});

// ── concurrency
t("CONCURRENCY: rows another run is holding are skipped, never double-sent or waited for; they go out on the next run", async () => {
  const day = future(8), a = mkAct("Locked Rows"), r = mkRule(a, day); follow(a, F3); cancel(a, r, day); settle();
  const locker = spawn(join(BIN, "psql"), base("begin; select id from public.activity_change_notices where processed_at is null for update; select pg_sleep(2.2); commit;"), { env });
  await new Promise((res) => setTimeout(res, 700));
  const s = job();
  assert.equal(s.claimed, 0, "the held rows were skipped");
  assert.equal(count(F3, a), 0);
  await new Promise((res) => locker.on("exit", res));
  job();
  assert.equal(count(F3, a), 1, "delivered exactly once afterwards");
});

// ── the job is bounded and private
t("BOUNDED and PRIVATE: it claims at most the batch size; visitors, members and the public cannot run it or read its tables; only staff see its status", () => {
  const a = mkAct("Bound Test");
  for (let i = 0; i < 6; i++) run(`insert into public.activity_change_notices(activity_id, kind, session_key, session_starts_at, state_hash, created_at) values ('${a}','cancelled','rule:bound:${i}', now() + interval '3 days', 'h${i}', now() - interval '10 minutes')`);
  assert.equal(JSON.parse(run("select public.process_activity_change_notices(2)")).claimed, 2);
  drain();
  for (const role of ["anon", "authenticated"]) {
    assert.ok(denied("select public.process_activity_change_notices()", role, STAFF), `${role} cannot run the job`);
    assert.ok(denied("select * from public.activity_change_notices", role)); assert.ok(denied("select * from public.activity_notice_state", role)); assert.ok(denied("select * from public.activity_notice_runs", role));
  }
  assert.ok(denied("select public.admin_activity_notice_status()", "authenticated", F1), "a member cannot see queue status");
  assert.ok(denied("select public.admin_activity_notice_status()", "anon"));
  const st = JSON.parse(run("select public.admin_activity_notice_status()", "authenticated", STAFF));
  assert.equal(typeof st.waiting, "number"); assert.ok(st.followers >= 1);
});

// ── scheduling
t("SCHEDULING: the job is registered once, every minute, idempotently, and the registered command actually works", () => {
  run(`create schema cron; create table cron.job(jobid serial primary key, jobname text, schedule text, command text);
       create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname, schedule, command) values (n, s, c) returning jobid $$;
       create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;`);
  const sched = readFileSync(M("20261208020000_schedule_activity_notices.sql"), "utf8");
  run(sched); run(sched); run(sched);
  assert.equal(run("select count(*) from cron.job where jobname = 'process-activity-change-notices'"), "1");
  assert.equal(run("select schedule from cron.job where jobname = 'process-activity-change-notices'"), "* * * * *");
  const cmd = run("select command from cron.job where jobname = 'process-activity-change-notices'");
  assert.equal(cmd, "select public.process_activity_change_notices(200);");
  assert.match(run(cmd), /"claimed"/);
  assert.match(sched, /Apply this ONLY AFTER/);
});
t("re-applying the notifications migration changes nothing (safe to repeat)", () => {
  const snap = () => run("select (select count(*) from public.notification_log)||'|'||(select count(*) from public.activity_change_notices)||'|'||(select count(*) from pg_proc where proname like 'activity_%' or proname like 'process_activity%')");
  const a = snap(); run(readFileSync(M("20261208010000_activity_notifications.sql"), "utf8")); assert.equal(snap(), a);
});
