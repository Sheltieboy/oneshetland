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
  dir = mkdtempSync(join(tmpdir(), "ac-")); sock = mkdtempSync(join("/tmp", "acs-"));
  execFileSync(join(BIN, "initdb"), ["--locale=en_US.UTF-8", "-D", join(dir, "pg"), "-A", "trust", "-U", "postgres"], { env, stdio: "ignore" });
  execFileSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-o", `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off -c timezone=UTC`, "-l", join(dir, "log"), "-w", "start"], { env });
  execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-X", "-q", "-c", "create database t"], { env });
  run(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create table auth.users(id uuid primary key);
    create table public.profiles(id uuid primary key, role text);
    create table public.local_businesses(id uuid primary key, owner_id uuid, name text, slug text, is_active boolean default true, is_claimed boolean default true);
    create table public.hubs(id uuid primary key, owner_id uuid, name text, slug text, is_active boolean default true, is_verified boolean default false);
    create table public.hub_members(hub_id uuid, user_id uuid, role text, status text);
    create table public.events(id uuid primary key default gen_random_uuid(), title text, status text default 'published', is_hidden boolean default false, organiser_business_id uuid, organiser_hub_id uuid, organiser_user_id uuid);
    create function public.attribution_staff() returns boolean language sql stable security definer as $$ select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator')) $$;
    create function public.is_hub_admin(p_hub uuid, p_user uuid) returns boolean language sql stable security definer as $$ select exists (select 1 from public.hub_members where hub_id = p_hub and user_id = p_user and status = 'active' and role in ('owner','committee')) $$;
    create function public.controls_event_entity(p_business uuid, p_hub uuid) returns boolean language sql stable security definer as $$
      select auth.uid() is not null and ((p_business is not null and exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid()))
        or (p_hub is not null and (public.is_hub_admin(p_hub, auth.uid()) or exists (select 1 from public.hubs h where h.id = p_hub and h.owner_id = auth.uid())))) $$;
    create table public.hidden_entities(entity text, id uuid);
    create function public.is_discovery_hidden(p_entity text, p_id uuid) returns boolean language sql stable security definer as $$ select exists (select 1 from public.hidden_entities h where h.entity = p_entity and h.id = p_id) $$;
    grant execute on function public.is_discovery_hidden(text, uuid) to anon, authenticated, service_role;
    revoke execute on function public.attribution_staff() from public; grant execute on function public.attribution_staff() to authenticated, service_role;
    revoke execute on function public.controls_event_entity(uuid, uuid) from public; grant execute on function public.controls_event_entity(uuid, uuid) to authenticated, service_role;
    alter table public.local_businesses enable row level security; alter table public.hubs enable row level security;
    create policy b_read on public.local_businesses for select using (is_active or owner_id = auth.uid());
    create policy h_read on public.hubs for select using (is_active or owner_id = auth.uid());
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant select on public.local_businesses, public.hubs, public.profiles to anon, authenticated, service_role;
    create view public.local_businesses_public with (security_invoker = true) as select id, name, slug, is_active from public.local_businesses;
    grant select on public.local_businesses_public to anon, authenticated, service_role;
    alter table public.events enable row level security; create policy e_read on public.events for select using ((status = 'published' and not is_hidden) or organiser_user_id = auth.uid());
    grant select on public.events to anon, authenticated, service_role;
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
  for (const f of ["20261208000000_regular_activities.sql", "20261208010000_activity_notifications.sql", "20261210000000_accessible_shetland.sql"]) run(readFileSync(M(f), "utf8"));
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });


import { randomUUID } from "node:crypto";
const J = (o: unknown) => `$pj$${JSON.stringify(o)}$pj$::jsonb`;
const F = (...f: [string, string, string?][]) => f.map(([facility, status, detail]) => ({ facility, status, ...(detail ? { detail } : {}) }));
const save = (who: string, type: string, id: string, publish: boolean, profile: object, facts: object[], confirm = false) =>
  JSON.parse(run(`select public.save_accessibility('${type}', '${id}', ${publish}, ${J(profile)}, ${J(facts)}, ${confirm})`, "authenticated", who));
const tryRun = (sql: string, role: string, who = "") => { const r = spawnSync(join(BIN, "psql"), base(`set role ${role}; ${who ? `set app.uid='${who}'; ` : ""}${sql}`), { env, encoding: "utf8" }); return { ok: r.status === 0, err: r.stderr, out: r.stdout.trim().split("\n").pop() ?? "" }; };
const trySave = (who: string, type: string, id: string, publish: boolean, profile: object, facts: object[]) => tryRun(`select public.save_accessibility('${type}', '${id}', ${publish}, ${J(profile)}, ${J(facts)}, false)`, "authenticated", who);
const visible = (type: string, id: string, role = "anon", who = "") => Number(run(`select count(*) from public.accessibility_profiles where subject_type='${type}' and subject_id='${id}'`, role, who));
const nFacts = (type: string, id: string, role = "anon", who = "") => Number(run(`select count(*) from public.accessibility_facts where subject_type='${type}' and subject_id='${id}'`, role, who));
const clear = () => run("delete from public.accessibility_profiles; delete from public.accessibility_reports; delete from public.accessibility_audit; delete from public.accessibility_sources; delete from public.hidden_entities; delete from public.events; delete from public.regular_activities");
const mkA = (who: string, title: string, over = "") => run(`insert into public.regular_activities(title, category, status, booking_mode, organiser_business_id${over ? ", " + over.split("=")[0] : ""}) values ('${title}', 'fitness', 'published', 'drop_in', '${B1}'${over ? ", " + over.split("=")[1] : ""}) returning id`, "authenticated", who);
const EV = U(91), EV_HID = U(92), BIZ_X = U(93);
const STEP = F(["step_free_entrance", "available", "Level from the car park"], ["hearing_loop", "partial", "Counter only"], ["accessible_toilet", "not_available"]);

test("a business owner saves a DRAFT: nobody else can see it; publishing makes the answers and their wording public to visitors who are not signed in", () => {
  clear();
  const r = save(OWNER, "business", B1, false, { summary: "Ground floor shop." }, STEP);
  assert.equal(r.published, false); assert.equal(r.facilities, 3);
  assert.equal(visible("business", B1), 0, "anon sees no draft"); assert.equal(visible("business", B1, "authenticated", STRANGER), 0); assert.equal(visible("business", B1, "authenticated", OWNER), 1, "the owner sees their own draft");
  save(OWNER, "business", B1, true, { summary: "Ground floor shop.", visit_tips: "Quietest before 11.", access_contact: "Ring the shop and ask for Anna" }, STEP);
  assert.equal(visible("business", B1), 1); assert.equal(nFacts("business", B1), 3);
  assert.equal(run(`select status || '|' || detail from public.accessibility_facts where facility='hearing_loop'`, "anon"), "partial|Counter only");
});
test("FREE FOR EVERYONE and no ratings: nothing in the feature checks a plan or tier, and nothing scores, ranks or labels a place 'accessible'", () => {
  const src = readFileSync(M("20261210000000_accessible_shetland.sql"), "utf8").replace(/--.*$/gm, "").replace(/comment on [^;]*;/g, "");
  assert.doesNotMatch(src, /subscription|tier|meets_tier|\bplan\b|premium/i);
  assert.doesNotMatch(src, /\bscore\b|\brating\b|fully_accessible|is_accessible|accessible_overall/i);
  assert.doesNotMatch(src, /disab|medical|diagnos|condition|impairment/i, "no health or disability data is collected");
});
test("missing information never means 'not accessible': an unanswered facility has no row, and an owner can say 'not known'", () => {
  clear(); save(OWNER, "business", B1, true, {}, F(["lift", "not_known"]));
  assert.equal(nFacts("business", B1), 1); assert.equal(run("select count(*) from public.accessibility_facts where facility = 'ramp'", "anon"), "0");
  assert.equal(run("select count(*) from public.accessibility_facts where status = 'not_available'", "anon"), "0", "nothing is recorded as 'not available' by default");
});

// ── who may edit
test("PERMISSIONS: business owner, Hub owner and committee member, activity manager and event organiser may edit their own; nobody else; staff may edit anything", () => {
  clear(); const act = mkA(OWNER, "Acc Class"); run(`insert into public.events(id, title, organiser_business_id) values ('${EV}', 'Acc Event', '${B1}')`);
  const ok = (who: string, type: string, id: string) => save(who, type, id, false, { summary: "x" }, F(["ramp", "available"])).facilities === 1;
  assert.ok(ok(OWNER, "business", B1)); assert.ok(ok(OWNER, "hub", HUB_V)); assert.ok(ok(COMMITTEE, "hub", HUB_V)); assert.ok(ok(OWNER, "activity", act)); assert.ok(ok(OWNER, "event", EV));
  assert.ok(ok(STAFF, "business", B1)); assert.ok(ok(MOD, "hub", HUB_V));
  for (const [who, type, id, label] of [[STRANGER, "business", B1, "stranger/business"], [OTHER_OWNER, "business", B1, "other business owner"], [COMMITTEE, "business", B1, "committee/business"], [STRANGER, "hub", HUB_V, "stranger/hub"], [OTHER_OWNER, "hub", HUB_V, "business owner/hub"],
    [STRANGER, "activity", act, "stranger/activity"], [OTHER_OWNER, "event", EV, "other owner/event"], [F1, "event", EV, "follower/event"]] as const) {
    const r = trySave(who, type, id, false, { summary: "no" }, F(["ramp", "available"])); assert.equal(r.ok, false, label); assert.match(r.err, /cannot edit/, label);
  }
  assert.equal(tryRun(`select public.save_accessibility('business', '${B1}', false, '{}'::jsonb, '[]'::jsonb, false)`, "anon").ok, false, "visitors cannot");
  assert.equal(tryRun(`select public.save_accessibility('business', '${B1}', false, '{}'::jsonb, '[]'::jsonb, false)`, "authenticated").ok, false, "a signed-in role with no user id (NULL auth.uid) is refused");
  assert.ok(tryRun(`insert into public.accessibility_profiles(subject_type, subject_id, summary) values ('business', '${B2}', 'sneaky')`, "authenticated", OWNER).ok === false, "direct writes are row-secured too");
});
test("validation: unknown facility, bad answer, duplicate, overlong text, too many items and an empty publish are refused; control characters are stripped", () => {
  clear();
  const bad = (facts: object[], profile: object = {}, publish = false) => trySave(OWNER, "business", B1, publish, profile, facts);
  assert.match(bad(F(["jacuzzi", "available"])).err, /Unknown facility/); assert.match(bad([{ facility: "ramp", status: "yes" }]).err, /Yes, Partly, No or Not sure/);
  assert.match(bad(F(["ramp", "available"], ["ramp", "partial"])).err, /once/); assert.match(bad(F(["ramp", "available", "x".repeat(401)])).err, /too long/);
  assert.match(bad([], { summary: "y".repeat(1001) }).err, /too long/); assert.match(bad([], { access_contact: "z".repeat(301) }).err, /too long/);
  assert.match(bad(Array.from({ length: 61 }, () => ({ facility: "ramp", status: "available" }))).err, /Too many/);
  assert.match(bad([], {}, true).err, /at least one detail/); assert.equal(bad([], { summary: "Only a summary" }, true).ok, true, "a summary alone is enough to publish");
  save(OWNER, "business", B1, false, { summary: "A\u0001B\u0007C" }, F(["ramp", "available", "ok\u007f"]));
  assert.equal(run("select summary from public.accessibility_profiles", "authenticated", OWNER), "ABC"); assert.equal(run("select detail from public.accessibility_facts", "authenticated", OWNER), "ok");
});
test("saving replaces the whole set atomically: removing an answer removes it, and a failed save changes nothing", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"], ["lift", "partial"]));
  save(OWNER, "business", B1, true, { summary: "s" }, F(["lift", "available", "Goods lift"]));
  assert.equal(run("select string_agg(facility || ':' || status, ',' order by facility) from public.accessibility_facts", "anon"), "lift:available");
  assert.equal(trySave(OWNER, "business", B1, true, { summary: "changed" }, F(["lift", "available"], ["nonsense", "available"])).ok, false);
  assert.equal(run("select summary from public.accessibility_profiles", "anon"), "s", "the failed save left everything as it was");
});

// ── what the public can see
test("VISIBILITY follows the listing: a hidden fixture, an unpublished activity, a hidden event and a hidden Hub never show their profile; a staff-hidden profile disappears", () => {
  clear(); const act = mkA(OWNER, "Vis Class"); run(`insert into public.events(id, title, organiser_business_id, is_hidden) values ('${EV}', 'Vis Event', '${B1}', false), ('${EV_HID}', 'Hidden Event', '${B1}', false)`);
  for (const [t, i] of [["business", B1], ["hub", HUB_V], ["activity", act], ["event", EV], ["event", EV_HID]] as const) save(OWNER, t, i, true, { summary: "s" }, F(["ramp", "available"]));
  for (const [t, i] of [["business", B1], ["hub", HUB_V], ["activity", act], ["event", EV]] as const) assert.equal(visible(t, i), 1, `${t} visible`);
  run(`update public.events set is_hidden = true where id = '${EV_HID}'`); assert.equal(visible("event", EV_HID), 0, "hidden event");
  run(`insert into public.hidden_entities values ('business', '${B1}')`); assert.equal(visible("business", B1), 0, "hidden fixture business"); run("delete from public.hidden_entities");
  run(`update public.regular_activities set status = 'draft' where id = '${act}'`); assert.equal(visible("activity", act), 0, "unpublished activity"); run(`update public.regular_activities set status = 'published' where id = '${act}'`);
  run(`update public.local_businesses set is_active = false where id = '${B1}'`); assert.equal(visible("business", B1), 0, "inactive business"); run(`update public.local_businesses set is_active = true where id = '${B1}'`);
  run(`select public.admin_hide_accessibility('hub', '${HUB_V}', true, 'Contains a link to something unrelated')`, "authenticated", STAFF);
  assert.equal(visible("hub", HUB_V), 0, "hidden by staff"); assert.equal(nFacts("hub", HUB_V), 0, "and so are its answers");
  assert.equal(run("select hidden_by_staff::text || '|' || hidden_reason from public.accessibility_profiles where subject_type = 'hub'", "authenticated", OWNER), "true|Contains a link to something unrelated", "the owner is told, with the reason");
  assert.equal(tryRun(`update public.accessibility_profiles set hidden_by_staff = false where subject_type = 'hub'`, "authenticated", OWNER).ok, false, "an owner cannot un-hide");
});
test("what anonymous visitors can read is limited to the content and its provenance: no editor ids, no hide details, no draft rows", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"]));
  for (const col of ["updated_by", "created_by", "hidden_by", "hidden_reason", "hidden_by_staff", "verified_by"]) assert.equal(tryRun(`select ${col} from public.accessibility_profiles`, "anon").ok, false, col);
  for (const col of ["subject_id", "summary", "updated_at", "verification", "last_editor_kind"]) assert.equal(tryRun(`select ${col} from public.accessibility_profiles`, "anon").ok, true, col);
  assert.equal(tryRun("insert into public.accessibility_profiles(subject_type, subject_id) values ('business', '" + B1 + "')", "anon").ok, false);
  assert.equal(tryRun("select * from public.accessibility_audit", "anon").ok, false); assert.equal(tryRun("select * from public.accessibility_reports", "anon").ok, false); assert.equal(tryRun("select * from public.accessibility_sources", "anon").ok, false);
});

// ── provenance and trust
test("PROVENANCE: it starts as owner-provided and records who edited; owners cannot raise or fake the verification level", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"]));
  assert.equal(run("select verification || '|' || last_editor_kind from public.accessibility_profiles", "anon"), "owner_provided|owner");
  for (const col of ["verification", "verification_note", "verified_on", "verified_by", "last_editor_kind", "updated_by", "hidden_by_staff"]) assert.equal(tryRun(`update public.accessibility_profiles set ${col} = ${col}`, "authenticated", OWNER).ok, false, `owners cannot write ${col}`);
  save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"]), true);
  assert.equal(run("select (last_confirmed_at is not null)::text from public.accessibility_profiles", "anon"), "true", "the owner can confirm it is still right");
});
test("STAFF VERIFICATION: 'independently checked' needs a note saying who checked and a date that is not in the future; only staff can set it; an owner's later edit ends it", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"]));
  const v = (who: string, level: string, note: string, on: string) => tryRun(`select public.admin_set_accessibility_verification('business', '${B1}', '${level}', ${note === "" ? "null" : `'${note}'`}, ${on === "" ? "null" : `'${on}'`})`, "authenticated", who);
  assert.equal(v(OWNER, "independently_checked", "Visited by Anna on the day", "2026-11-01").ok, false, "an owner cannot"); assert.equal(v(STRANGER, "official_source", "From the council page", "2026-11-01").ok, false);
  assert.match(v(STAFF, "independently_checked", "", "2026-11-01").err, /Say who checked/); assert.match(v(STAFF, "independently_checked", "short", "2026-11-01").err, /Say who checked/);
  assert.match(v(STAFF, "independently_checked", "Visited by Anna on the day", "").err, /Say who checked/); assert.match(v(STAFF, "independently_checked", "Visited by Anna on the day", "2999-01-01").err, /future/);
  assert.equal(v(STAFF, "independently_checked", "Visited by Anna on the day", "2026-11-01").ok, true);
  assert.equal(run("select verification || '|' || verification_note || '|' || verified_on from public.accessibility_profiles", "anon"), "independently_checked|Visited by Anna on the day|2026-11-01");
  assert.equal(tryRun(`update public.accessibility_profiles set verification='independently_checked', verification_note=null where subject_type='business'`, "postgres").ok, false, "the database itself refuses an unexplained verification");
  save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "partial"]));                      // the owner changes an answer
  assert.equal(run("select verification from public.accessibility_profiles", "anon"), "owner_provided", "a check of the earlier version no longer applies");
  v(STAFF, "official_source", "Council accessibility page, reviewed", "2026-11-02"); save(OWNER, "business", B1, true, { summary: "changed text" }, F(["ramp", "partial"]));
  assert.equal(run("select verification from public.accessibility_profiles", "anon"), "owner_provided", "so does a change to the text");
});
test("a staff edit is labelled as staff, an owner edit as owner, and a staff verification or hide does not re-stamp the author", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"]));
  const stamp = () => run("select updated_by || '|' || last_editor_kind from public.accessibility_profiles");
  const before = stamp(); run(`select public.admin_set_accessibility_verification('business', '${B1}', 'official_source', 'Council page reviewed', '2026-11-02')`, "authenticated", STAFF); assert.equal(stamp(), before);
  save(STAFF, "business", B1, true, { summary: "Added from the council page" }, F(["ramp", "available"])); assert.equal(stamp(), `${STAFF}|staff`);
  assert.equal(run("select verification from public.accessibility_profiles", "anon"), "official_source", "staff edits do not downgrade a staff verification");
});

// ── corrections and contributions
test("CONTRIBUTIONS: a signed-in member can suggest a correction on a public listing; visitors cannot; unknown, hidden or draft listings are refused; the reporter's identity never reaches the owner", () => {
  clear(); const rep = (who: string, type: string, id: string, msg: string, role = "authenticated") => tryRun(`insert into public.accessibility_reports(subject_type, subject_id, kind, message) values ('${type}', '${id}', 'incorrect', $m$${msg}$m$)`, role, who);
  assert.equal(rep(F1, "business", B1, "The step at the door is higher than the page says").ok, true);
  assert.equal(rep("", "business", B1, "Anonymous attempt here please", "anon").ok, false);
  assert.equal(rep(F1, "business", randomUUID(), "A listing that does not exist at all").ok, false); run(`insert into public.hidden_entities values ('business', '${B1}')`);
  assert.equal(rep(F2, "business", B1, "Hidden fixtures cannot be reported on").ok, false); run("delete from public.hidden_entities");
  assert.match(rep(F2, "business", B1, "short").err, /more detail|violates/); assert.equal(rep(F2, "business", B1, "x".repeat(1001)).ok, false);
  assert.equal(run("select count(*) from public.accessibility_reports", "authenticated", OWNER), "1", "the owner sees suggestions about their listing");
  for (const col of ["reporter_id", "staff_note", "reviewed_by"]) assert.equal(tryRun(`select ${col} from public.accessibility_reports`, "authenticated", OWNER).ok, false, `${col} is not visible to the owner`);
  assert.equal(run("select count(*) from public.accessibility_reports", "authenticated", STRANGER), "0"); assert.equal(run("select count(*) from public.accessibility_reports", "authenticated", OTHER_OWNER), "0");
  assert.equal(run("select count(*) from public.accessibility_reports", "authenticated", F1), "1", "the reporter sees their own");
  assert.equal(tryRun("update public.accessibility_reports set status = 'applied'", "authenticated", F1).ok, false, "a reporter cannot approve their own");
  assert.equal(tryRun("update public.accessibility_reports set status = 'applied'", "authenticated", OWNER).ok, false, "nor can the owner");
});
test("SPAM LIMITS: at most 8 suggestions a day per person, 2 waiting per listing, no repeats of the same text", () => {
  clear(); const rep = (type: string, id: string, msg: string) => tryRun(`insert into public.accessibility_reports(subject_type, subject_id, kind, message) values ('${type}', '${id}', 'add', $m$${msg}$m$)`, "authenticated", F3);
  assert.equal(rep("business", B1, "First useful suggestion here").ok, true); assert.equal(rep("business", B1, "Second useful suggestion here").ok, true);
  assert.match(rep("business", B1, "Third on the same listing").err, /waiting for this listing/);
  assert.match(rep("business", B1, "First useful suggestion here").err, /waiting|already have/);
  run(`update public.accessibility_reports set status = 'rejected'`);
  assert.match(rep("business", B1, "FIRST USEFUL SUGGESTION HERE").err, /already have that/);
  for (let i = 0; i < 6; i++) { const r = rep("hub", HUB_V, `Another suggestion number ${i} about this hub`); if (i % 2 === 1) run(`update public.accessibility_reports set status = 'rejected'`); assert.equal(r.ok, true, String(i)); }
  assert.match(rep("hub", HUB_V, "One too many for today please").err, /several suggestions today/);
});
test("MODERATION: staff list, accept, reject and mark applied, with a note; a suggestion never changes the public details by itself; everything is audited", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"]));
  run(`insert into public.accessibility_reports(subject_type, subject_id, kind, message) values ('business', '${B1}', 'incorrect', 'The ramp is closed for repairs until spring')`, "authenticated", F1);
  assert.equal(run("select count(*) from public.admin_accessibility_reports('new')", "authenticated", STAFF), "1"); assert.equal(tryRun("select * from public.admin_accessibility_reports()", "authenticated", OWNER).ok, false); assert.equal(tryRun("select * from public.admin_accessibility_reports()", "anon").ok, false);
  assert.equal(run("select subject_label from public.admin_accessibility_reports()", "authenticated", MOD), "Test Biz", "moderators too");
  const id = run("select id from public.accessibility_reports");
  assert.equal(tryRun(`select public.admin_review_accessibility_report('${id}', 'accepted', 'Thanks, passed to the owner')`, "authenticated", OWNER).ok, false);
  run(`select public.admin_review_accessibility_report('${id}', 'accepted', 'Thanks, passed to the owner')`, "authenticated", STAFF);
  assert.equal(run("select status || '|' || staff_note from public.admin_accessibility_reports()", "authenticated", STAFF), "accepted|Thanks, passed to the owner");
  assert.equal(run("select status from public.accessibility_facts where facility = 'ramp'", "anon"), "available", "the public detail is unchanged until someone edits it");
  assert.ok(Number(run("select count(*) from public.accessibility_audit where action like 'report_%'", "authenticated", STAFF)) >= 2);
});
test("AUDIT: profile, fact, report and staff actions are all recorded; only staff can read it; nobody can write or change it", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"]));
  run(`select public.admin_hide_accessibility('business', '${B1}', true, 'Testing the audit trail')`, "authenticated", STAFF);
  const actions = run("select string_agg(distinct action, ',' order by action) from public.accessibility_audit", "authenticated", STAFF);
  for (const a of ["profile_insert", "fact_insert", "profile_update"]) assert.ok(actions.includes(a), a);
  assert.equal(run("select count(*) from public.accessibility_audit where actor is not null", "authenticated", STAFF) !== "0", true);
  assert.equal(run("select count(*) from public.accessibility_audit", "authenticated", OWNER), "0", "owners cannot read it");
  for (const q of ["insert into public.accessibility_audit(action) values ('x')", "update public.accessibility_audit set action = 'x'", "delete from public.accessibility_audit"]) assert.equal(tryRun(q, "authenticated", STAFF).ok, false, q);
});
test("SOURCES REGISTER: staff only; https only; 'imported' needs permitted reuse and a review date", () => {
  clear(); const add = (who: string, sql: string) => tryRun(`insert into public.accessibility_sources(name, url${sql ? ", " + sql.split("|")[0] : ""}) values ('Council page', 'https://example.org/access'${sql ? ", " + sql.split("|")[1] : ""})`, "authenticated", who);
  assert.equal(add(STAFF, "").ok, true); assert.equal(add(OWNER, "").ok, false); assert.equal(tryRun("select * from public.accessibility_sources", "authenticated", OWNER).out, "", "owners see nothing");
  assert.equal(tryRun("insert into public.accessibility_sources(name, url) values ('Bad', 'http://example.org')", "authenticated", STAFF).ok, false, "http refused");
  assert.equal(add(STAFF, "status|'imported'").ok, false, "cannot be 'imported' without permission");
  assert.equal(add(STAFF, "status, licence_status|'imported', 'link_only'").ok, false);
  assert.equal(add(STAFF, "status, licence_status, reviewed_on|'imported', 'permitted', '2026-11-07'").ok, true, "permitted + reviewed");
});
test("COVERAGE for staff: counts and names only, never sent anywhere; staff only", () => {
  clear(); save(OWNER, "business", B1, true, { summary: "s" }, F(["ramp", "available"])); run(`insert into public.local_businesses values ('${BIZ_X}', '${OTHER_OWNER}', 'No Details Cafe', 'ndc', true, true)`);
  const c = JSON.parse(run("select public.admin_accessibility_coverage()", "authenticated", STAFF));
  assert.equal(c.profiles_published, 1); assert.ok(c.claimed_businesses >= 2); assert.ok(c.claimed_without_profile.some((b: { name: string }) => b.name === "No Details Cafe")); assert.ok(!c.claimed_without_profile.some((b: { name: string }) => b.name === "Test Biz"));
  assert.equal(tryRun("select public.admin_accessibility_coverage()", "authenticated", OWNER).ok, false); assert.equal(tryRun("select public.admin_accessibility_coverage()", "anon").ok, false);
});
test("GRANTS and hygiene: staff functions are not executable by visitors, every function pins its search_path, and the migration sends nothing", () => {
  for (const f of ["admin_set_accessibility_verification('business', gen_random_uuid(), 'official_source', 'x', current_date)", "admin_hide_accessibility('business', gen_random_uuid(), true, 'x')", "admin_review_accessibility_report(gen_random_uuid(), 'accepted', 'x')", "save_accessibility('business', gen_random_uuid(), false, '{}', '[]', false)"]) assert.equal(tryRun(`select public.${f}`, "anon").ok, false, f);
  assert.equal(run("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'accessibility\\_%' or proname like '%accessibility%') and not (proconfig::text like '%search_path%')"), "0");
  assert.doesNotMatch(readFileSync(M("20261210000000_accessible_shetland.sql"), "utf8").replace(/--.*$/gm, ""), /notification_log|net\.http|send_email|expo|postmark|pg_notify/i, "no notifications, emails or calls");
});
test("CONCURRENCY: two owners saving the same listing at once both finish and leave a consistent set", async () => {
  clear(); const go = (who: string, facts: object[]) => new Promise<boolean>((res) => { const p = spawn(join(BIN, "psql"), base(`set role authenticated; set app.uid='${who}'; select public.save_accessibility('hub', '${HUB_V}', true, '{"summary":"s"}'::jsonb, ${J(facts)}, false)`), { env }); p.on("close", (c) => res(c === 0)); });
  const [a, b] = await Promise.all([go(OWNER, F(["ramp", "available"])), go(COMMITTEE, F(["lift", "partial"]))]);
  assert.ok(a && b); const keys = run("select string_agg(facility, ',') from public.accessibility_facts where subject_type = 'hub'", "anon"); assert.ok(keys === "ramp" || keys === "lift", `one complete set, not a mixture: ${keys}`);
});
