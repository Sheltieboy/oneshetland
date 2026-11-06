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

const U = (n: number) => `00000000-0000-0000-0000-0000000003${String(n).padStart(2, "0")}`;
const [OWNER, STAFF, F1, F2, F3, OPTOUT_ALL, OPTOUT_EVENTS, QUIET, STRANGER, LATE] = [U(1), U(2), U(3), U(4), U(5), U(6), U(7), U(8), U(9), U(10)];
const [OTHER_OWNER, COMMITTEE, MOD] = [U(11), U(12), U(13)];
const B1 = U(21), B2 = U(22), B_OFF = U(23), HUB_U = U(31), HUB_V = U(32);

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
  dir = mkdtempSync(join(tmpdir(), "am-")); sock = mkdtempSync(join("/tmp", "ams-"));
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
    insert into auth.users(id) select x::uuid from unnest(array['${OWNER}','${STAFF}','${F1}','${F2}','${F3}','${OPTOUT_ALL}','${OPTOUT_EVENTS}','${QUIET}','${STRANGER}','${LATE}','${OTHER_OWNER}','${COMMITTEE}','${MOD}']) x;
    insert into public.profiles values ('${STAFF}','admin'), ('${MOD}','moderator');
    insert into public.local_businesses values ('${B1}','${OWNER}','Test Biz','test-biz',true), ('${B2}','${OTHER_OWNER}','Other Biz','other-biz',true), ('${B_OFF}','${OWNER}','Closed Biz','closed-biz',false);
    insert into public.hub_members values ('${HUB_V}','${COMMITTEE}','committee','active');
    insert into public.hubs values ('${HUB_U}','${OWNER}','Unverified Hub','unverified-hub',true,false), ('${HUB_V}','${OWNER}','Verified Hub','verified-hub',true,true);
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
  for (const f of ["20261208000000_regular_activities.sql", "20261208010000_activity_notifications.sql", "20261209000000_activity_messages.sql"]) run(readFileSync(M(f), "utf8"));
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });
const t = (name: string, fn: () => void | Promise<void>) => test(name, { skip: !have && "postgresql@17 not installed" }, fn);

// ── helpers for this suite
import { randomUUID } from "node:crypto";
const q = (s: string) => `$msg$${s}$msg$`;
const reset = () => run("delete from public.activity_messages; delete from public.notification_log where category = 'events.activity_message'; delete from public.activity_follows where user_id not in ('" + [F1, F2, F3, OPTOUT_ALL, OPTOUT_EVENTS, QUIET, STRANGER, LATE, OWNER, STAFF].join("','") + "') and false");
const mkActAs = (who: string, title: string, over: Record<string, string> = {}) => {
  const cols: Record<string, string> = { title: `'${title}'`, category: "'fitness'", status: "'published'", booking_mode: "'drop_in'", organiser_business_id: `'${B1}'`, ...over };
  return run(`insert into public.regular_activities(${Object.keys(cols).join(",")}) values (${Object.values(cols).join(",")}) returning id`, "authenticated", who);
};
const followers = (act: string, users: string[]) => users.forEach((u) => follow(act, u));
const send = (who: string, act: string, body: string, req = randomUUID()) => JSON.parse(run(`select public.send_activity_message('${act}', ${q(body)}, '${req}')`, "authenticated", who)) as { id: string; followers: number; recipients: number; opted_out: number; duplicate: boolean };
const attempt = (who: string, act: string, body: string, req = randomUUID(), role = "authenticated") => {
  const r = spawnSync(join(BIN, "psql"), base(`set role ${role}; ${who ? `set app.uid='${who}'; ` : ""}select public.send_activity_message('${act}', ${q(body)}, '${req}')`), { env, encoding: "utf8" });
  return { ok: r.status === 0, err: r.stderr, out: r.stdout };
};
const asyncSend = (who: string, act: string, body: string, req = randomUUID(), holdSeconds = 0) => new Promise<{ ok: boolean; err: string; out: string }>((res) => {
  const p = spawn(join(BIN, "psql"), base(`set role authenticated; set app.uid='${who}'; select public.send_activity_message('${act}', ${q(body)}, '${req}')${holdSeconds ? `; select pg_sleep(${holdSeconds})` : ""}`), { env });
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (c) => res({ ok: c === 0, err, out }));
});
const msgCount = (act?: string) => Number(run(`select count(*) from public.activity_messages ${act ? `where activity_id='${act}'` : ""}`));
const rows = (act: string, user?: string) => Number(run(`select count(*) from public.notification_log where category='events.activity_message' and data->>'activity_id'='${act}' ${user ? `and user_id='${user}'` : ""}`));
const age = (act: string, minutes: number) => run(`update public.activity_messages set created_at = created_at - interval '${minutes} minutes' where activity_id='${act}'`);
const problem = (s: string) => run(`select coalesce(public.activity_message_problem(${q(s)}), 'OK')`);

// ── delivery, end to end
t("END TO END: a manager's message reaches each follower's Notification Centre once, as unread, deep-linked to the activity; non-followers get nothing", () => {
  reset(); const a = mkActAs(OWNER, "Msg E2E"); followers(a, [F1, F2]);
  const r = send(OWNER, a, "Bring a water bottle this week.");
  assert.deepEqual(Object.keys(r).sort(), ["duplicate", "followers", "id", "opted_out", "recipients"], "the organiser is told counts only");
  assert.equal(r.recipients, 2); assert.equal(r.followers, 2); assert.equal(r.duplicate, false);
  const [title, body, status, category] = run(`select title || ' | ' || body || ' | ' || status || ' | ' || category from public.notification_log where user_id='${F1}' and data->>'activity_id'='${a}'`).split(" | ");
  assert.equal(title, "Msg E2E: message from the organiser"); assert.equal(body, "Bring a water bottle this week."); assert.equal(status, "no_token"); assert.equal(category, "events.activity_message");
  assert.equal(run(`select data->>'activity_slug' || '|' || (data->>'screen') || '|' || (data->>'message_id') from public.notification_log where user_id='${F1}' and data->>'activity_id'='${a}'`), `msg-e2e|regular-activity|${r.id}`);
  assert.equal(run("select public.unread_notification_count()", "authenticated", F1), "1");
  assert.equal(rows(a, STRANGER), 0); assert.equal(rows(a, F3), 0);
  run("select public.mark_notifications_read()", "authenticated", F1);
  assert.equal(run("select public.unread_notification_count()", "authenticated", F1), "0");
});
t("it is IN-APP ONLY: the migration has no push, email, http call, queue or Edge Function", () => {
  const src = readFileSync(M("20261209000000_activity_messages.sql"), "utf8").replace(/--.*$/gm, "");
  assert.doesNotMatch(src, /expo|postmark|send_email|net\.http|http_post|pg_notify|cron\.schedule|email_log|push_tokens/i);
  assert.match(src, /'no_token'/);
});

// ── privacy
t("PRIVACY: organisers see counts and their own history, never who follows or who received it", () => {
  reset(); const a = mkActAs(OWNER, "Msg Privacy"); followers(a, [F1, F2]); const r = send(OWNER, a, "Hello everyone");
  assert.equal(run("select count(*) from public.activity_follows", "authenticated", OWNER), "0", "the follows table is the follower's own");
  assert.equal(run(`select count(*) from public.notification_log where category='events.activity_message'`, "authenticated", OWNER), "0");
  assert.equal(run(`select count(*) from public.activity_messages where id='${r.id}'`, "authenticated", OWNER), "1", "but the manager reads the message and its counts");
  assert.equal(run(`select count(*) from public.activity_messages where id='${r.id}'`, "authenticated", F1), "0", "a follower cannot read the organiser's history");
  assert.equal(run(`select count(*) from public.activity_messages where id='${r.id}'`, "authenticated", STRANGER), "0");
  for (const col of ["author_id", "hidden_by", "hidden_reason", "client_request_id"]) assert.ok(denied(`select ${col} from public.activity_messages`, "authenticated", OWNER), col + " is not readable by a manager");
  const s = JSON.parse(run(`select public.activity_messaging_status('${a}')`, "authenticated", OWNER));
  assert.deepEqual(Object.keys(s).sort(), ["eligible", "follower_cap", "followers", "max_chars", "next_allowed_at", "organiser_sent_last_24h", "reason", "sent_last_24h"]);
  assert.equal(s.followers, 2); assert.equal(s.eligible, true);
});

// ── who may send
t("PERMISSIONS: a business owner, a hub owner, a hub committee member and staff may send for what they manage; nobody else, and nothing changes when they try", () => {
  reset();
  const biz = mkActAs(OWNER, "Perm Biz"), hub = mkActAs(OWNER, "Perm Hub", { organiser_business_id: "null", organiser_hub_id: `'${HUB_V}'` });
  const plat = mkActAs(STAFF, "Perm Platform", { organiser_business_id: "null", is_platform_activity: "true" });
  for (const x of [biz, hub, plat]) followers(x, [F1]);
  assert.equal(send(OWNER, biz, "ok business").recipients, 1);
  assert.equal(send(OWNER, hub, "ok hub owner").recipients, 1);
  age(hub, 120); assert.equal(send(COMMITTEE, hub, "ok committee").recipients, 1);
  assert.equal(send(STAFF, plat, "ok staff platform").recipients, 1);
  age(plat, 120); assert.equal(send(MOD, plat, "ok moderator platform").recipients, 1);
  const before = msgCount();
  for (const [who, act, label] of [[STRANGER, biz, "stranger/business"], [F1, biz, "follower/business"], [OTHER_OWNER, biz, "other business owner"], [OTHER_OWNER, hub, "business owner/hub"], [COMMITTEE, biz, "committee/business"], [OWNER, plat, "business owner/platform"], [STRANGER, plat, "stranger/platform"], [LATE, hub, "late/hub"]] as const) {
    const r = attempt(who, act, "should not send"); assert.equal(r.ok, false, label); assert.match(r.err, /cannot message followers/, label);
  }
  assert.equal(msgCount(), before, "refused attempts write nothing");
  assert.equal(attempt("", biz, "anon", randomUUID(), "anon").ok, false, "anonymous cannot even execute it");
  assert.equal(attempt("", biz, "no uid", randomUUID(), "authenticated").ok, false, "a signed-in role with no user id (NULL auth.uid) is refused, not waved through");
  assert.ok(denied("insert into public.activity_messages(activity_id, client_request_id, body) values ('" + biz + "', gen_random_uuid(), 'direct')", "authenticated", OWNER), "no direct writes");
  assert.ok(denied("update public.activity_messages set body = 'x'", "authenticated", OWNER)); assert.ok(denied("delete from public.activity_messages", "authenticated", OWNER));
});

// ── only a public activity
t("ELIGIBILITY: draft, ended, paused, unapproved-hub and inactive-business activities cannot message followers, and nothing is spent", () => {
  reset();
  const draft = mkActAs(OWNER, "Elig Draft", { status: "'draft'" });
  const ended = mkActAs(OWNER, "Elig Ended"); run(`update public.regular_activities set status='ended' where id='${ended}'`);
  const paused = mkActAs(OWNER, "Elig Paused"); run(`update public.regular_activities set admin_paused=true where id='${paused}'`);
  const unapproved = mkActAs(OWNER, "Elig Hub", { organiser_business_id: "null", organiser_hub_id: `'${HUB_U}'` });
  const closed = mkActAs(OWNER, "Elig Closed", { organiser_business_id: `'${B_OFF}'` });
  const good = mkActAs(OWNER, "Elig Good");
  for (const x of [draft, ended, paused, unapproved, closed, good]) followers(x, [F1]);
  const why: [string, RegExp][] = [[draft, /Publish this activity/], [ended, /Publish this activity/], [paused, /paused/], [unapproved, /waiting for approval/], [closed, /not public/]];
  for (const [x, re] of why) {
    const r = attempt(OWNER, x, "hello"); assert.equal(r.ok, false); assert.match(r.err, re);
    const st = JSON.parse(run(`select public.activity_messaging_status('${x}')`, "authenticated", OWNER)); assert.equal(st.eligible, false); assert.match(st.reason, re);
  }
  assert.equal(msgCount(), 0); assert.equal(Number(run("select count(*) from public.notification_log where category='events.activity_message'")), 0);
  assert.equal(send(OWNER, good, "hello").recipients, 1, "and an eligible activity still works");
  run(`update public.regular_activities set status='draft' where id='${good}'`); age(good, 120);
  assert.equal(attempt(OWNER, good, "after unpublishing").ok, false, "unpublishing stops it again");
});
t("an activity nobody follows cannot send, and it does not use up an allowance", () => {
  reset(); const a = mkActAs(OWNER, "Nobody Follows");
  const r = attempt(OWNER, a, "anyone?"); assert.equal(r.ok, false); assert.match(r.err, /Nobody follows/);
  assert.equal(msgCount(a), 0); follow(a, F1); assert.equal(send(OWNER, a, "now someone does").recipients, 1);
});

// ── the text rules
t("TEXT: 1 to 500 characters of plain text; links, web addresses, email addresses and phone numbers are refused; ordinary times, prices and dates are not", () => {
  const bad: [string, RegExp][] = [["", /Write a message/], ["   \n  ", /Write a message/], ["x".repeat(501), /500 characters/],
    ["See https://example.com", /Links/], ["see http://x.y/z", /Links/], ["www.shetland.org has it", /Links|Web addresses/], ["Visit shetland.org for more", /Web addresses/], ["bit.ly/abc", /Web addresses/], ["go to mysite.co.uk", /Web addresses/],
    ["mail me at a@b.com", /Email/], ["tag @shetlandarts", /Email/], ["Call 01595 693322", /Phone/], ["Call 07700 900123 now", /Phone/], ["ring +44 7700 900123", /Phone/], ["call 01595-693-322", /Phone/], ["(01595) 693322", /Phone/], ["text 0770 090 0123", /Phone/], ["0044 1595 693322", /Phone/]];
  for (const [s, re] of bad) assert.match(problem(s), re, JSON.stringify(s));
  const ok = ["x".repeat(500), "Saturday 10.30-11.30 as normal", "Thu 6:30-7:30pm, £6.50 on the door", "Session 12-13 Nov moved to Monday", "Back on 4 January 2027", "Room 12, Anderson High School, Lerwick", "St. Ninian's Hall at 7pm", "Bring 2 friends, 5 minutes early", "Doors 7.00 - 7.30, class 7.30 - 8.30", "Cost: £10 (£8 concessions)", "Line one\nLine two", "Emoji welcome 🎉 see you there", "Dr. Smith leads this week. Free tea after."];
  for (const s of ok) assert.equal(problem(s), "OK", JSON.stringify(s));
});
t("TEXT is cleaned before it is stored: control characters removed, blank lines collapsed, edges trimmed; the cap is exact", () => {
  reset(); const a = mkActAs(OWNER, "Msg Clean"); follow(a, F1);
  const r = send(OWNER, a, "  Hello\u0001\u0007 there\r\n\r\n\r\n\r\nSecond para \u007f  ");
  assert.equal(run(`select replace(body, E'\\n', '|') from public.activity_messages where id='${r.id}'`), "Hello there||Second para");
  age(a, 120); assert.equal(send(OWNER, a, "y".repeat(500)).recipients, 1);
  age(a, 120); assert.equal(attempt(OWNER, a, "y".repeat(501)).ok, false);
});

// ── limits
t("LIMITS: 1 per activity per hour, 3 per activity per 24 hours; a refused attempt spends nothing; the window rolls", () => {
  reset(); const a = mkActAs(OWNER, "Msg Limits"); follow(a, F1);
  send(OWNER, a, "one");
  let r = attempt(OWNER, a, "two too soon"); assert.equal(r.ok, false); assert.match(r.err, /one message an hour/); assert.match(r.err, /next after \d\d:\d\d/);
  assert.equal(msgCount(a), 1, "the refused attempt wrote nothing");
  age(a, 61); send(OWNER, a, "two"); age(a, 61); send(OWNER, a, "three");
  assert.equal(msgCount(a), 3);
  age(a, 61); r = attempt(OWNER, a, "four"); assert.equal(r.ok, false); assert.match(r.err, /3 messages in any 24 hours/);
  const st = JSON.parse(run(`select public.activity_messaging_status('${a}')`, "authenticated", OWNER)); assert.ok(st.next_allowed_at, "the composer is told when the next slot opens"); assert.equal(st.sent_last_24h, 3);
  age(a, 24 * 60); assert.equal(send(OWNER, a, "tomorrow").recipients, 1);
  assert.equal(rows(a, F1), 4);
});
t("LIMITS: the allowance belongs to the ACTIVITY and the ORGANISER, not the person: a second manager cannot start another one", () => {
  reset(); const a = mkActAs(OWNER, "Msg Hub Limits", { organiser_business_id: "null", organiser_hub_id: `'${HUB_V}'` }); follow(a, F1);
  send(OWNER, a, "from the owner");
  assert.equal(attempt(COMMITTEE, a, "from committee").ok, false, "same hour: the committee member shares the owner's allowance");
  age(a, 61); send(COMMITTEE, a, "committee two"); age(a, 61); send(OWNER, a, "owner three");
  age(a, 61); assert.equal(attempt(COMMITTEE, a, "fourth").ok, false, "three in 24 hours across both people");
});
t("LIMITS: 10 per organiser per 24 hours across ALL its activities; another organiser is unaffected; hidden messages still count", () => {
  reset(); const acts: string[] = [];
  for (let i = 0; i < 11; i++) { const a = mkActAs(OWNER, `Org Cap ${i}`); follow(a, F1); acts.push(a); }
  const other = mkActAs(OTHER_OWNER, "Org Cap Other", { organiser_business_id: `'${B2}'` }); follow(other, F1);
  for (let i = 0; i < 10; i++) send(OWNER, acts[i], `message ${i}`);
  const r = attempt(OWNER, acts[10], "the eleventh"); assert.equal(r.ok, false); assert.match(r.err, /10 messages in any 24 hours across all its activities/);
  assert.equal(send(OTHER_OWNER, other, "unaffected").recipients, 1);
  run(`select public.admin_hide_activity_message((select id from public.activity_messages order by created_at limit 1), 'test')`, "authenticated", STAFF);
  assert.equal(attempt(OWNER, acts[10], "still counts when hidden").ok, false);
  age(acts[0], 24 * 60); assert.equal(send(OWNER, acts[10], "a slot opened").recipients, 1);
});

// ── preferences
t("PREFERENCES: switched-off members get a hidden record only; quiet hours do not hide an inbox item; counts reflect it", () => {
  reset(); const a = mkActAs(OWNER, "Msg Prefs"); followers(a, [F1, OPTOUT_ALL, OPTOUT_EVENTS, QUIET]);
  const r = send(OWNER, a, "Prefs check");
  assert.equal(r.recipients, 2); assert.equal(r.opted_out, 2); assert.equal(r.followers, 4);
  const st = (u: string) => run(`select status from public.notification_log where user_id='${u}' and data->>'message_id'='${r.id}'`);
  assert.equal(st(F1), "no_token"); assert.equal(st(QUIET), "no_token", "quiet hours only delay pushes; an inbox item is never hidden by them");
  assert.equal(st(OPTOUT_ALL), "skipped_pref"); assert.equal(st(OPTOUT_EVENTS), "skipped_pref");
  assert.equal(run("select public.unread_notification_count()", "authenticated", OPTOUT_ALL), "0");
});

// ── nobody is told twice
t("NO DUPLICATES: the same request id (a retry or double click) sends once; a follower has exactly one inbox item", () => {
  reset(); const a = mkActAs(OWNER, "Msg Dupes"); followers(a, [F1, F2]); const req = randomUUID();
  const first = send(OWNER, a, "once only", req), again = send(OWNER, a, "once only", req), changedText = send(OWNER, a, "different text, same request", req);
  assert.equal(first.duplicate, false); assert.equal(again.duplicate, true); assert.equal(again.id, first.id); assert.equal(changedText.id, first.id);
  assert.equal(msgCount(a), 1); assert.equal(rows(a, F1), 1); assert.equal(rows(a, F2), 1);
  assert.equal(run(`select body from public.activity_messages where id='${first.id}'`), "once only");
});
t("NO DUPLICATES (backstop): the database itself refuses a second inbox row for the same message and member, for this category only", () => {
  reset(); const m = randomUUID();
  const ins = (cat: string, user: string) => run(`insert into public.notification_log(user_id, category, title, body, data, status) values ('${user}','${cat}','t','b','{"message_id":"${m}"}','no_token')`);
  ins("events.activity_message", F1);
  assert.ok(spawnSync(join(BIN, "psql"), base(`insert into public.notification_log(user_id, category, title, body, data, status) values ('${F1}','events.activity_message','t','b','{"message_id":"${m}"}','no_token')`), { env }).status !== 0);
  ins("events.activity_message", F2);                       // a different member: fine
  ins("events.activity_change", F1); ins("events.activity_change", F1); ins("events.update", F1); ins("hubs.broadcast", F1);   // every other type may repeat anything
  run(`insert into public.notification_log(user_id, category, title, body, data, status) values ('${F1}','events.update','t','b',null,'sent'), ('${F1}','events.update','t','b',null,'sent'), ('${F1}','events.activity_message','t','b','{}','sent'), ('${F1}','events.activity_message','t','b','{}','sent')`);
  const def = run("select indexdef from pg_indexes where indexname = 'notification_log_activity_message_once'");
  assert.match(def, /UNIQUE/); assert.match(def, /WHERE \(category = 'events\.activity_message'/);
});
t("CONCURRENCY: two managers sending at the same instant get ONE message between them, and each follower gets one item", async () => {
  reset(); const a = mkActAs(OWNER, "Msg Race", { organiser_business_id: "null", organiser_hub_id: `'${HUB_V}'` }); followers(a, [F1, F2, F3]);
  const res = await Promise.all([asyncSend(OWNER, a, "from owner"), asyncSend(COMMITTEE, a, "from committee")]);
  assert.equal(res.filter((r) => r.ok).length, 1); assert.match(res.find((r) => !r.ok)!.err, /one message an hour/);
  assert.equal(msgCount(a), 1); assert.equal(rows(a), 3);
});
t("CONCURRENCY: the same request id fired twice at once (a double click) is one send", async () => {
  reset(); const a = mkActAs(OWNER, "Msg Dbl"); followers(a, [F1, F2]); const req = randomUUID();
  const res = await Promise.all([asyncSend(OWNER, a, "double", req), asyncSend(OWNER, a, "double", req), asyncSend(OWNER, a, "double", req)]);
  assert.equal(res.filter((r) => r.ok).length, 3, "none of them errors");
  assert.equal(msgCount(a), 1); assert.equal(rows(a), 2); assert.equal(res.filter((r) => /"duplicate": true/.test(r.out)).length, 2);
});
t("CONCURRENCY: twelve activities of one organiser all sending at once: exactly ten get through", async () => {
  reset(); const acts: string[] = [];
  for (let i = 0; i < 12; i++) { const a = mkActAs(OWNER, `Race Org ${i}`); follow(a, F1); acts.push(a); }
  const res = await Promise.all(acts.map((a, i) => asyncSend(OWNER, a, `race ${i}`)));
  assert.equal(res.filter((r) => r.ok).length, 10); assert.equal(res.filter((r) => !r.ok && /10 messages in any 24 hours/.test(r.err)).length, 2);
  assert.equal(msgCount(), 10); assert.equal(rows(acts[0]) + acts.slice(1).reduce((n, a) => n + rows(a), 0), 10);
});

t("CONCURRENCY (forced overlap): a send that is still in flight holds the others back, so the limits cannot be raced past", async () => {
  reset(); const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // same activity, two managers: B starts while A has not committed yet
  const a = mkActAs(OWNER, "Msg Slow", { organiser_business_id: "null", organiser_hub_id: `'${HUB_V}'` }); followers(a, [F1, F2]);
  const A = asyncSend(OWNER, a, "slow A", randomUUID(), 1.5); await wait(400); const B = asyncSend(COMMITTEE, a, "fast B");
  const [ra, rb] = await Promise.all([A, B]);
  assert.equal([ra, rb].filter((r) => r.ok).length, 1, "exactly one gets through"); assert.equal(msgCount(a), 1); assert.equal(rows(a), 2);
  // same request id: B waits for A and gets A's answer
  reset(); const c = mkActAs(OWNER, "Msg Slow2"); followers(c, [F1]); const req = randomUUID();
  const C = asyncSend(OWNER, c, "same", req, 1.5); await wait(400); const D = asyncSend(OWNER, c, "same", req);
  const [rc, rd] = await Promise.all([C, D]); assert.ok(rc.ok && rd.ok); assert.match(rd.out, /"duplicate": true/); assert.equal(msgCount(c), 1); assert.equal(rows(c), 1);
  // two DIFFERENT activities of one organiser with one slot left under the 10-a-day cap
  reset(); const acts: string[] = []; for (let i = 0; i < 11; i++) { const x = mkActAs(OWNER, `Slow Org ${i}`); follow(x, F1); acts.push(x); }
  for (let i = 0; i < 9; i++) send(OWNER, acts[i], `pre ${i}`);
  const E = asyncSend(OWNER, acts[9], "slow E", randomUUID(), 1.5); await wait(400); const F = asyncSend(OWNER, acts[10], "fast F");
  const [re, rf] = await Promise.all([E, F]); assert.equal([re, rf].filter((r) => r.ok).length, 1); assert.equal(msgCount(), 10);
});

// ── atomic
t("ATOMIC: if delivery fails part-way, nothing is kept: no message, no inbox items for anyone, and the allowance is not spent", () => {
  reset(); const a = mkActAs(OWNER, "Msg Atomic"); followers(a, [F1, F2, F3]);
  run(`create function public.zz_fail() returns trigger language plpgsql as $$ begin if new.user_id = '${F3}' and new.category = 'events.activity_message' then raise exception 'simulated delivery failure'; end if; return new; end $$;
       create trigger zz_fail before insert on public.notification_log for each row execute function public.zz_fail();`);
  const r = attempt(OWNER, a, "will fail halfway"); assert.equal(r.ok, false); assert.match(r.err, /simulated delivery failure/);
  assert.equal(msgCount(a), 0); assert.equal(rows(a), 0, "F1 and F2 were processed before F3 and are rolled back too");
  run("drop trigger zz_fail on public.notification_log; drop function public.zz_fail()");
  assert.equal(send(OWNER, a, "works once the fault is gone").recipients, 3, "no hourly allowance was consumed by the failure");
});

// ── the 5,000 cap
t("CAP: 5,000 followers are all reached in one go; 5,001 is refused before anything is written (never a partial send)", () => {
  reset(); const a = mkActAs(OWNER, "Msg Cap"); const ts = Date.now();
  run(`create temp table zz as select gen_random_uuid() id from generate_series(1, 5001); `);
  run("create table public.zz_users as select gen_random_uuid() id from generate_series(1, 5001); insert into auth.users select id from public.zz_users");
  run(`insert into public.activity_follows(activity_id, user_id, created_at) select '${a}', id, now() - interval '1 hour' from public.zz_users`);
  const r = attempt(OWNER, a, "too many"); assert.equal(r.ok, false); assert.match(r.err, /more followers than one message can reach/);
  assert.equal(msgCount(a), 0); assert.equal(rows(a), 0);
  run(`delete from public.activity_follows where user_id = (select id from public.zz_users limit 1) and activity_id='${a}'`);
  const ok = send(OWNER, a, "exactly at the cap");
  assert.equal(ok.followers, 5000); assert.equal(ok.recipients, 5000); assert.equal(rows(a), 5000);
  assert.ok(Date.now() - ts < 30_000, "one set-based statement, not a loop");
  run("delete from public.activity_follows where user_id in (select id from public.zz_users); delete from auth.users where id in (select id from public.zz_users); drop table public.zz_users");
});
t("the follower list is a snapshot at send time: someone who follows afterwards is not told, and an unfollower before sending is not", () => {
  reset(); const a = mkActAs(OWNER, "Msg Snapshot"); followers(a, [F1, F2]);
  run(`delete from public.activity_follows where activity_id='${a}' and user_id='${F2}'`);
  const r = send(OWNER, a, "snapshot"); follow(a, LATE, "now()");
  assert.equal(r.recipients, 1); assert.equal(rows(a, F2), 0); assert.equal(rows(a, LATE), 0);
});

// ── moderation
t("STAFF can hide a message from every inbox and restore it; the message, its text and who hid it stay as the record", () => {
  reset(); const a = mkActAs(OWNER, "Msg Mod"); followers(a, [F1, F2, OPTOUT_ALL]); const r = send(OWNER, a, "Something unsuitable");
  const unreadMsg = (u: string) => run(`select count(*) from public.notification_log where user_id='${u}' and data->>'message_id'='${r.id}' and read_at is null and status in ('sent','no_token','skipped_quiet')`);
  assert.equal(unreadMsg(F1), "1");
  assert.ok(denied(`select public.admin_hide_activity_message('${r.id}', 'x')`, "authenticated", OWNER), "the organiser cannot hide their own");
  assert.ok(denied(`select public.admin_hide_activity_message('${r.id}', 'x')`, "authenticated", F1));
  assert.ok(denied(`select public.admin_hide_activity_message('${r.id}', '  ')`, "authenticated", STAFF), "a reason is required");
  assert.equal(run(`select public.admin_hide_activity_message('${r.id}', 'Not appropriate')`, "authenticated", STAFF), "2", "the two delivered items are hidden; the opted-out record is untouched");
  assert.equal(unreadMsg(F1), "0");
  assert.equal(run(`select count(*) from public.notification_log where user_id='${F1}' and data->>'message_id'='${r.id}' and status in ('sent','no_token','skipped_quiet')`), "0", "not in the inbox's visible statuses");
  assert.equal(run(`select count(*) from public.notification_log where data->>'message_id'='${r.id}'`), "3", "nothing was deleted");
  assert.equal(run(`select body || '|' || (hidden_at is not null) || '|' || hidden_reason || '|' || (hidden_by = '${STAFF}') from public.activity_messages where id='${r.id}'`), "Something unsuitable|true|Not appropriate|true");
  assert.equal(run(`select hidden_at is not null from public.activity_messages where id='${r.id}'`, "authenticated", OWNER), "t", "the organiser sees that it was removed, not why or by whom");
  assert.equal(run(`select count(*) from public.admin_activity_messages('${a}')`, "authenticated", MOD), "1", "moderators see the staff list too");
  assert.ok(denied("select * from public.admin_activity_messages()", "authenticated", OWNER));
  assert.equal(run(`select public.admin_hide_activity_message('${r.id}', 'again')`, "authenticated", STAFF), "0", "hiding twice changes nothing");
  assert.equal(run(`select public.admin_restore_activity_message('${r.id}')`, "authenticated", STAFF), "2");
  assert.equal(unreadMsg(F1), "1");
  assert.equal(run(`select status from public.notification_log where user_id='${OPTOUT_ALL}' and data->>'message_id'='${r.id}'`), "skipped_pref", "the opted-out record stays hidden");
  assert.equal(run(`select hidden_at is null from public.activity_messages where id='${r.id}'`), "t");
});

// ── the rest of the system is unchanged
t("schedule-change alerts still work and are untouched by the new index and table", () => {
  const day = future(7), a = mkAct("Msg Regression"), r = mkRule(a, day); follow(a, F1); cancel(a, r, day, "Ill"); drain();
  assert.equal(count(F1, a), 1); assert.match(inbox(F1, a), /is cancelled \(Ill\) \| no_token \| events\.activity_change$/);
});
t("GRANTS: visitors cannot run any of it; signed-in people cannot write the table; functions pin their search_path", () => {
  for (const f of ["send_activity_message('" + randomUUID() + "','x','" + randomUUID() + "')", "activity_messaging_status('" + randomUUID() + "')", "admin_activity_messages()", "admin_hide_activity_message('" + randomUUID() + "','x')", "admin_restore_activity_message('" + randomUUID() + "')"]) assert.ok(denied(`select public.${f}`, "anon"), f);
  assert.ok(denied("select * from public.activity_messages", "anon"));
  assert.equal(run("select count(*) from pg_proc where proname in ('send_activity_message','activity_messaging_status','admin_hide_activity_message','admin_restore_activity_message','admin_activity_messages') and not (proconfig::text like '%search_path%')"), "0");
});
