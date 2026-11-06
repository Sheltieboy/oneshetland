/**
 * regular-activities.node.test.ts — the Regular Activities foundation, proved in a throwaway PostgreSQL that mirrors production's
 * ownership helpers (controls_event_entity, attribution_staff, is_hub_admin), row security and grants. Synthetic data only.
 * Needs postgresql@17 (skipped otherwise). Run:  node --test supabase/tests/regular-activities.node.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = "/opt/homebrew/opt/postgresql@17/bin";
const have = existsSync(join(BIN, "initdb"));
const MIG = join(import.meta.dirname, "..", "migrations", "20261208000000_regular_activities.sql");
let dir = "", sock = "";
const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
const base = (q: string) => ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", q];
/** Run SQL as a role. `who` sets the signed-in user id (auth.uid()). */
const run = (q: string, role = "postgres", who = "") => execFileSync(join(BIN, "psql"), base(role === "postgres" ? q : `set role ${role}; ${who ? `set app.uid='${who}'; ` : ""}${q}`), { env, encoding: "utf8" }).trim().split("\n").pop() ?? "";
const fails = (q: string, role: string, who = "") => spawnSync(join(BIN, "psql"), base(`set role ${role}; ${who ? `set app.uid='${who}'; ` : ""}${q}`), { env, encoding: "utf8" });
const denied = (q: string, role: string, who = "") => fails(q, role, who).status !== 0;

const U = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;
const [BIZ_OWNER, HUB_OWNER, COMMITTEE, STAFF, OTHER, FOLLOWER] = [U(1), U(2), U(3), U(4), U(5), U(6)];
const B1 = U(11), B2 = U(12), B_INACTIVE = U(13), HUB_V = U(21), HUB_U = U(22);
const lastFull = (q: string, role = "postgres", who = "") => execFileSync(join(BIN, "psql"), base(role === "postgres" ? q : `set role ${role}; ${who ? `set app.uid='${who}'; ` : ""}${q}`), { env, encoding: "utf8" }).trim();

test.before(() => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "ra-")); sock = mkdtempSync(join("/tmp", "ras-"));
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
    -- production's helpers, as deployed
    create function public.attribution_staff() returns boolean language sql stable security definer as $$ select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','moderator')) $$;
    create function public.is_hub_admin(p_hub uuid, p_user uuid) returns boolean language sql stable security definer as $$
      select exists (select 1 from public.hub_members where hub_id = p_hub and user_id = p_user and status = 'active' and role in ('owner','committee')) $$;
    create function public.controls_event_entity(p_business uuid, p_hub uuid) returns boolean language sql stable security definer as $$
      select auth.uid() is not null and (
        (p_business is not null and exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid()))
        or (p_hub is not null and (public.is_hub_admin(p_hub, auth.uid()) or exists (select 1 from public.hubs h where h.id = p_hub and h.owner_id = auth.uid())))) $$;
    alter table public.local_businesses enable row level security; alter table public.hubs enable row level security;
    create policy b_read on public.local_businesses for select using (is_active or owner_id = auth.uid());
    create policy h_read on public.hubs for select using (is_active or owner_id = auth.uid());
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant select on public.local_businesses, public.hubs, public.profiles to anon, authenticated, service_role;
    grant select on auth.users to service_role;
    insert into auth.users(id) values ('${BIZ_OWNER}'),('${HUB_OWNER}'),('${COMMITTEE}'),('${STAFF}'),('${OTHER}'),('${FOLLOWER}');
    insert into public.profiles values ('${STAFF}','admin'),('${OTHER}','user');
    insert into public.local_businesses values ('${B1}','${BIZ_OWNER}','Northern Lights Fitness','northern-lights-fitness',true),
                                              ('${B2}','${OTHER}','Other Biz','other-biz',true), ('${B_INACTIVE}','${BIZ_OWNER}','Dormant Biz','dormant',false);
    insert into public.hubs values ('${HUB_V}','${HUB_OWNER}','Verified Hub','verified-hub',true,true), ('${HUB_U}','${HUB_OWNER}','Unverified Hub','unverified-hub',true,false);
    insert into public.hub_members values ('${HUB_V}','${COMMITTEE}','committee','active'), ('${HUB_U}','${COMMITTEE}','committee','active');`);
  run(readFileSync(MIG, "utf8"));
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });
const t = (name: string, fn: () => void) => test(name, { skip: !have && "postgresql@17 not installed" }, fn);

// helpers to create fixtures as the right person
const mk = (title: string, owner: { biz?: string; hub?: string }, who: string, over: Record<string, string> = {}) => {
  const cols: Record<string, string> = { title: `'${title}'`, category: "'fitness'", status: "'published'", booking_mode: "'drop_in'",
    [owner.biz ? "organiser_business_id" : "organiser_hub_id"]: `'${owner.biz ?? owner.hub}'`, ...over };
  return run(`insert into public.regular_activities(${Object.keys(cols).join(",")}) values (${Object.values(cols).join(",")}) returning id`, "authenticated", who);
};
const rule = (act: string, dow: number, start: string, end: string, anchor: string, extra = "") =>
  run(`insert into public.activity_schedule_rules(activity_id, day_of_week, start_time, end_time, anchor_date ${extra ? ", " + extra.split("=")[0] : ""}) values ('${act}', ${dow}, '${start}', '${end}', '${anchor}' ${extra ? ", " + extra.split("=")[1] : ""}) returning id`, "postgres");
const sessions = (act: string, from: string, to: string, role = "anon", who = "") =>
  lastFull(`select string_agg(to_char(starts_at at time zone 'UTC','MM-DD HH24:MI')||'~'||to_char(ends_at at time zone 'UTC','HH24:MI')||' '||status, ' | ' order by starts_at) from public.activity_sessions('${from}','${to}','${act}')`, role, who);

// ── ownership and visibility
t("a business owner can create an activity for THEIR business; a stranger cannot; the owner's id and the slug are set by the database", () => {
  const id = mk("Barre", { biz: B1 }, BIZ_OWNER);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(run(`select slug||'|'||created_by from public.regular_activities where id='${id}'`), `barre|${BIZ_OWNER}`);
  assert.ok(denied(`insert into public.regular_activities(title, category, organiser_business_id) values ('Sneaky','other','${B1}')`, "authenticated", OTHER));
  assert.ok(denied(`insert into public.regular_activities(title, category, organiser_business_id) values ('Sneaky','other','${B2}')`, "authenticated", BIZ_OWNER));
  assert.ok(denied(`insert into public.regular_activities(title, category) values ('Ownerless','other')`, "authenticated", BIZ_OWNER), "exactly one owner is required");
  assert.ok(denied(`insert into public.regular_activities(title, category, organiser_business_id, organiser_hub_id) values ('Two','other','${B1}','${HUB_V}')`, "authenticated", HUB_OWNER));
});
t("a hub's owner and its committee can create for the hub; an outsider cannot", () => {
  assert.match(mk("Hub Club", { hub: HUB_V }, HUB_OWNER), /^[0-9a-f-]{36}$/);
  assert.match(mk("Hub Club 2", { hub: HUB_V }, COMMITTEE), /^[0-9a-f-]{36}$/);
  assert.ok(denied(`insert into public.regular_activities(title, category, organiser_hub_id) values ('Nope','other','${HUB_V}')`, "authenticated", OTHER));
});
t("only staff can create platform activities, and clients cannot fake it", () => {
  assert.ok(denied(`insert into public.regular_activities(title, category, is_platform_activity) values ('Fake platform','other', true)`, "authenticated", OTHER));
  assert.match(run(`insert into public.regular_activities(title, category, is_platform_activity, status) values ('Platform Walk','sport', true, 'published') returning id`, "authenticated", STAFF), /^[0-9a-f-]{36}$/);
});
t("slugs are unique and NEVER change when the title does (URLs are forever)", () => {
  const a = mk("Tai Chi", { biz: B1 }, BIZ_OWNER), b = mk("Tai Chi", { biz: B1 }, BIZ_OWNER);
  assert.deepEqual([run(`select slug from public.regular_activities where id='${a}'`), run(`select slug from public.regular_activities where id='${b}'`)], ["tai-chi", "tai-chi-2"]);
  run(`update public.regular_activities set title='Tai Chi for Beginners' where id='${a}'`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select slug from public.regular_activities where id='${a}'`), "tai-chi");
  assert.ok(denied(`update public.regular_activities set slug='hijack' where id='${a}'`, "authenticated", BIZ_OWNER), "slug is not a writable column");
});
t("an owner cannot change an activity's owner, take it over, or edit someone else's", () => {
  const a = mk("Qigong", { biz: B1 }, BIZ_OWNER);
  assert.ok(denied(`update public.regular_activities set organiser_business_id='${B2}' where id='${a}'`, "authenticated", BIZ_OWNER));
  assert.equal(run(`with u as (update public.regular_activities set title='Hijacked' where id='${a}' returning 1) select count(*) from u`, "authenticated", OTHER), "0");
});
t("visibility: drafts and ended listings are private; the organiser still sees them", () => {
  const d = mk("Draft Class", { biz: B1 }, BIZ_OWNER, { status: "'draft'" });
  assert.equal(run(`select count(*) from public.regular_activities where id='${d}'`, "anon"), "0");
  assert.equal(run(`select count(*) from public.regular_activities where id='${d}'`, "authenticated", BIZ_OWNER), "1");
  run(`update public.regular_activities set status='published' where id='${d}'`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select count(*) from public.regular_activities where id='${d}'`, "anon"), "1");
  run(`update public.regular_activities set status='ended' where id='${d}'`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select count(*) from public.regular_activities where id='${d}'`, "anon"), "0");
});
t("hub verification: an unverified hub's activity is NOT public until staff approve it; a verified hub's is; owners cannot self-approve", () => {
  const u = mk("Unverified Hub Group", { hub: HUB_U }, HUB_OWNER), v = mk("Verified Hub Group", { hub: HUB_V }, HUB_OWNER);
  assert.equal(run(`select count(*) from public.regular_activities where id='${u}'`, "anon"), "0");
  assert.equal(run(`select count(*) from public.regular_activities where id='${v}'`, "anon"), "1", "verified hubs are approved automatically");
  run(`update public.regular_activities set calendar_approved = true where id='${u}'`, "authenticated", HUB_OWNER);
  assert.equal(run(`select count(*) from public.regular_activities where id='${u}'`, "anon"), "0", "a hub owner cannot approve their own");
  run(`update public.regular_activities set calendar_approved = true where id='${u}'`, "authenticated", STAFF);
  assert.equal(run(`select count(*) from public.regular_activities where id='${u}'`, "anon"), "1", "staff can approve");
});
t("an inactive business's activities are not public", () => {
  const a = mk("Dormant Class", { biz: B_INACTIVE }, BIZ_OWNER);
  assert.equal(run(`select count(*) from public.regular_activities where id='${a}'`, "anon"), "0");
});
t("staff can pause any listing: it leaves public view, the organiser still sees it WITH the reason, visitors never see the reason, and it is logged", () => {
  const a = mk("Pausable", { biz: B1 }, BIZ_OWNER);
  assert.ok(denied(`select public.admin_set_activity_paused('${a}', true, 'not staff, not allowed')`, "authenticated", BIZ_OWNER));
  assert.ok(denied(`select public.admin_set_activity_paused('${a}', true, '')`, "authenticated", STAFF), "a reason is required");
  run(`select public.admin_set_activity_paused('${a}', true, 'Reported for misleading details')`, "authenticated", STAFF);
  assert.equal(run(`select count(*) from public.regular_activities where id='${a}'`, "anon"), "0");
  assert.equal(run(`select admin_pause_reason from public.regular_activities where id='${a}'`, "authenticated", BIZ_OWNER), "Reported for misleading details");
  assert.ok(denied(`select admin_pause_reason from public.regular_activities`, "anon"));
  assert.ok(denied(`update public.regular_activities set admin_paused=false where id='${a}'`, "authenticated", BIZ_OWNER), "an owner cannot un-pause");
  run(`select public.admin_set_activity_paused('${a}', false)`, "authenticated", STAFF);
  assert.equal(run(`select count(*) from public.regular_activities where id='${a}'`, "anon"), "1");
  assert.equal(run(`select string_agg(kind, ',' order by id) from public.activity_owner_log where activity_id='${a}'`), "pause,resume");
});

// ── sessions
t("weekly sessions are computed in Europe/London: 10:30 stays 10:30 local across the clock change (BST ends Sun 25 Oct 2026)", () => {
  const a = mk("Sunday Walk", { biz: B1 }, BIZ_OWNER);
  rule(a, 0, "10:30", "12:00", "2026-10-11");
  // 18 Oct is BST (UTC+1) -> 09:30 UTC; 25 Oct 10:30 is already GMT -> 10:30 UTC; 1 Nov GMT.
  assert.equal(sessions(a, "2026-10-17", "2026-11-03"), "10-18 09:30~11:00 scheduled | 10-25 10:30~12:00 scheduled | 11-01 10:30~12:00 scheduled");
});
t("multiple days in one activity (Tue + Thu), and two sessions on the SAME day are two rules that exceptions can tell apart", () => {
  const a = mk("Barre", { biz: B1 }, BIZ_OWNER);
  const tue = rule(a, 2, "18:00", "19:00", "2026-11-03"), thu1 = rule(a, 4, "09:30", "10:30", "2026-11-03"), thu2 = rule(a, 4, "18:30", "19:30", "2026-11-03");
  assert.equal(sessions(a, "2026-11-09", "2026-11-13"), "11-10 18:00~19:00 scheduled | 11-12 09:30~10:30 scheduled | 11-12 18:30~19:30 scheduled");
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, note) values ('${a}','${thu2}','2026-11-12','cancelled','Instructor away')`, "postgres");
  assert.equal(sessions(a, "2026-11-09", "2026-11-13"), "11-10 18:00~19:00 scheduled | 11-12 09:30~10:30 scheduled | 11-12 18:30~19:30 cancelled", "only the evening session on the 12th is cancelled");
  assert.ok(thu1 && tue);
});
t("exceptions must name a REAL scheduled session of THAT activity's rule", () => {
  const a = mk("Yoga", { biz: B1 }, BIZ_OWNER), other = mk("Other Yoga", { biz: B1 }, BIZ_OWNER);
  const r = rule(a, 2, "18:00", "19:00", "2026-11-03"), ro = rule(other, 2, "18:00", "19:00", "2026-11-03");
  assert.ok(denied(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind) values ('${a}','${r}','2026-11-11','cancelled')`, "postgres") === true, "a Wednesday is not a Tuesday session");
  assert.ok(denied(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind) values ('${a}','${ro}','2026-11-10','cancelled')`, "postgres"), "another activity's rule");
  assert.ok(denied(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind) values ('${a}','${r}','2026-10-27','cancelled')`, "postgres"), "before the rule began");
});
t("one exception per session: a second is refused (change the existing one instead)", () => {
  const a = mk("Pilates", { biz: B1 }, BIZ_OWNER), r = rule(a, 2, "18:00", "19:00", "2026-11-03");
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind) values ('${a}','${r}','2026-11-10','cancelled')`, "postgres");
  assert.ok(denied(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, note) values ('${a}','${r}','2026-11-10','changed','dup')`, "postgres"));
});
t("a MOVE (like Bressay Under 5s: Fri 6 Nov 10:30 -> Sat 7 Nov 10:00) shows at the new time, not the old, keeps the duration, and keeps its identity", () => {
  const a = mk("Bressay Under 5s", { biz: B1 }, BIZ_OWNER), r = rule(a, 5, "10:30", "12:30", "2026-11-06");
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, new_starts_at, note) values ('${a}','${r}','2026-11-06','changed','2026-11-07 10:00+00','Moved to Saturday this week')`, "postgres");
  assert.equal(sessions(a, "2026-11-05", "2026-11-14"), "11-07 10:00~12:00 moved | 11-13 10:30~12:30 scheduled", "10:00 start with the original 2h duration");
  assert.equal(run(`select exception_id is not null from public.activity_sessions('2026-11-05','2026-11-08','${a}')`), "t");
});
t("time change, venue change and note on one session; the others keep the default", () => {
  const a = mk("Parkrun Social", { biz: B1 }, BIZ_OWNER, { venue: "'Hall A'" }), r = rule(a, 3, "14:00", "16:00", "2026-11-04");
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, new_starts_at, new_ends_at, new_venue, note) values ('${a}','${r}','2026-11-11','changed','2026-11-11 13:00+00','2026-11-11 15:30+00','Hall B','Earlier today')`, "postgres");
  assert.equal(lastFull(`select string_agg(to_char(starts_at,'MM-DD HH24:MI')||'~'||to_char(ends_at,'HH24:MI')||' '||status||' @'||venue||' ['||coalesce(note,'')||']', ' | ' order by starts_at) from public.activity_sessions('2026-11-09','2026-11-20','${a}')`),
    "11-11 13:00~15:30 changed @Hall B [Earlier today] | 11-18 14:00~16:00 scheduled @Hall A []");
});
t("extra sessions appear (no rule), several can share a date, and they never duplicate a normal session", () => {
  const a = mk("Craft Group", { biz: B1 }, BIZ_OWNER), r = rule(a, 2, "18:00", "19:00", "2026-11-03");
  run(`insert into public.activity_exceptions(activity_id, kind, new_starts_at, new_ends_at, note) values ('${a}','extra','2026-11-10 10:00+00','2026-11-10 11:00+00','Christmas card special'), ('${a}','extra','2026-11-10 13:00+00','2026-11-10 14:00+00',null)`, "postgres");
  assert.equal(sessions(a, "2026-11-09", "2026-11-11"), "11-10 10:00~11:00 extra | 11-10 13:00~14:00 extra | 11-10 18:00~19:00 scheduled");
  assert.ok(r);
});
t("holiday breaks cancel every rule session in the range (labelled 'break'), leave extras alone, and an explicit exception inside a break wins", () => {
  const a = mk("Toddlers", { biz: B1 }, BIZ_OWNER), r = rule(a, 5, "10:30", "12:00", "2026-12-04");
  run(`insert into public.activity_breaks(activity_id, start_date, end_date, reason) values ('${a}','2026-12-18','2027-01-02','Christmas break')`, "postgres");
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, note) values ('${a}','${r}','2026-12-25','changed','Special Christmas Day session')`, "postgres");
  run(`insert into public.activity_exceptions(activity_id, kind, new_starts_at, new_ends_at) values ('${a}','extra','2026-12-22 10:00+00','2026-12-22 11:00+00')`, "postgres");
  assert.equal(sessions(a, "2026-12-10", "2027-01-10"), "12-11 10:30~12:00 scheduled | 12-18 10:30~12:00 break | 12-22 10:00~11:00 extra | 12-25 10:30~12:00 changed | 01-01 10:30~12:00 break | 01-08 10:30~12:00 scheduled");
  assert.equal(run(`select note from public.activity_sessions('2026-12-17','2026-12-19','${a}')`), "Christmas break");
});
t("fortnightly rules alternate weeks from the anchor, and season/rule dates bound the sessions", () => {
  const a = mk("Fortnightly Club", { biz: B1 }, BIZ_OWNER, { active_until: "'2026-12-01'" });
  rule(a, 2, "19:00", "20:00", "2026-11-03", "interval_weeks=2");
  assert.equal(sessions(a, "2026-11-01", "2027-01-30"), "11-03 19:00~20:00 scheduled | 11-17 19:00~20:00 scheduled | 12-01 19:00~20:00 scheduled");
});
t("the window and the row count are bounded", () => {
  const a = mk("Daily", { biz: B1 }, BIZ_OWNER);
  for (let d = 0; d < 7; d++) rule(a, d, "09:00", "10:00", "2026-01-05");
  assert.ok(denied(`select * from public.activity_sessions('2026-11-01','2027-03-01','${a}')`, "anon"), "more than 93 days is refused");
  assert.ok(denied(`select * from public.activity_sessions('2026-11-02','2026-11-01')`, "anon"));
  assert.equal(run(`select count(*) from public.activity_sessions('2026-11-01','2027-01-30','${a}', 25)`, "anon"), "25", "the limit caps the rows");
});
t("visitors only get sessions for PUBLIC activities (drafts and paused ones produce none)", () => {
  const d = mk("Hidden Draft", { biz: B1 }, BIZ_OWNER, { status: "'draft'" }); rule(d, 2, "18:00", "19:00", "2026-11-03");
  assert.equal(sessions(d, "2026-11-09", "2026-11-13", "anon"), "");
  assert.match(sessions(d, "2026-11-09", "2026-11-13", "authenticated", BIZ_OWNER), /11-10 18:00~19:00 scheduled/, "the organiser can preview");
  assert.equal(sessions(d, "2026-11-09", "2026-11-13", "authenticated", OTHER), "", "a stranger cannot");
});

// ── the listing: one card per activity
t("the listing returns ONE row per activity however many sessions it runs, with the next session and up to three upcoming", () => {
  const a = mk("Listing Test Barre", { biz: B1 }, BIZ_OWNER, { locality: "'Lerwick'", price_text: "'£6 drop-in'" });
  rule(a, 2, "18:00", "19:00", "2026-11-03"); rule(a, 4, "18:00", "19:00", "2026-11-03");
  const row = lastFull(`select count(*)||'|'||max(sessions_in_window)||'|'||max(jsonb_array_length(upcoming))||'|'||max(owner_name)||'|'||max(owner_kind) from public.regular_activities_listing('2026-11-09','2026-12-07') where id='${a}'`, "anon");
  assert.equal(row, "1|8|3|Northern Lights Fitness|business");
});
t("listing filters: day of week, category, locality, drop-in, and text", () => {
  const a = mk("Filter Probe Qigong", { biz: B1 }, BIZ_OWNER, { locality: "'Scalloway'", category: "'wellbeing'", audience: "'Over 50s'" }); rule(a, 3, "10:00", "11:00", "2026-11-04");
  const n = (where: string) => run(`select count(*) from public.regular_activities_listing('2026-11-09','2026-11-23', ${where}) where id='${a}'`, "anon");
  assert.equal(n("null"), "1");
  assert.equal(n("array[3]"), "1"); assert.equal(n("array[1,2,5]"), "0");
  assert.equal(n("null, 'wellbeing'"), "1"); assert.equal(n("null, 'sport'"), "0");
  assert.equal(n("null, null, 'scalloway'"), "1"); assert.equal(n("null, null, 'Lerwick'"), "0");
  assert.equal(n("null, null, null, true"), "1"); assert.equal(n("null, null, null, false"), "0");
  assert.equal(n("null, null, null, null, 'over 50'"), "1"); assert.equal(n("null, null, null, null, 'zzz-none'"), "0");
});
t("a window where every session is cancelled still lists the activity (so a cancelled class is visible, not silently missing), after the live ones", () => {
  const a = mk("All Cancelled Wk", { biz: B1 }, BIZ_OWNER), r = rule(a, 2, "18:00", "19:00", "2026-11-03");
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, note) values ('${a}','${r}','2026-11-10','cancelled','No class')`, "postgres");
  assert.equal(run(`select sessions_in_window||'/'||cancelled_in_window||'/'||(next_starts_at is null) from public.regular_activities_listing('2026-11-09','2026-11-12') where id='${a}'`, "anon"), "0/1/true");
});
t("the listing is bounded and public-only: it needs a window, caps its rows, and never returns drafts, paused or unapproved hub activities", () => {
  assert.ok(denied(`select * from public.regular_activities_listing('2026-11-01','2027-06-01')`, "anon"));
  const n = Number(run(`select count(*) from public.regular_activities_listing('2026-11-09','2026-11-23', null, null, null, null, null, 3)`, "anon"));
  assert.ok(n <= 3);
  assert.equal(run(`select count(*) from public.regular_activities_listing('2026-11-09','2026-11-23') where title in ('Hidden Draft','Pausable','Unverified Hub Group','Dormant Class')`, "anon"), "0");
});
t("the events table is untouched: activities never write events rows (the What's On mosaic cannot be cluttered by them)", () => {
  assert.equal(run("select count(*) from public.events"), "0");
});

// ── following
t("following is opt-in and private: you can follow public activities, see/delete only your own, and organisers get a count but never names", () => {
  const a = mk("Followable", { biz: B1 }, BIZ_OWNER), d = mk("Followable Draft", { biz: B1 }, BIZ_OWNER, { status: "'draft'" });
  run(`insert into public.activity_follows(activity_id, user_id) values ('${a}','${FOLLOWER}')`, "authenticated", FOLLOWER);
  assert.ok(denied(`insert into public.activity_follows(activity_id, user_id) values ('${a}','${OTHER}')`, "authenticated", FOLLOWER), "cannot follow as someone else");
  assert.ok(denied(`insert into public.activity_follows(activity_id, user_id) values ('${d}','${FOLLOWER}')`, "authenticated", FOLLOWER), "cannot follow a draft");
  assert.equal(run(`select count(*) from public.activity_follows`, "authenticated", OTHER), "0");
  assert.equal(run(`select count(*) from public.activity_follows`, "authenticated", FOLLOWER), "1");
  assert.ok(denied(`select * from public.activity_follows`, "anon"));
  assert.equal(run(`select public.activity_follower_count('${a}')`, "authenticated", BIZ_OWNER), "1");
  assert.equal(run(`select coalesce(public.activity_follower_count('${a}')::text, 'none')`, "authenticated", OTHER), "none");
  run(`delete from public.activity_follows where activity_id='${a}'`, "authenticated", FOLLOWER);
  assert.equal(run(`select count(*) from public.activity_follows`), "0");
});

// ── handover
t("platform -> hub handover is staff-only, audited, requires a reason, gives the hub control and removes it from platform; an unverified hub still needs approval", () => {
  const p = run(`insert into public.regular_activities(title, category, is_platform_activity, status) values ('Bressay Test Group','kids_family', true, 'published') returning id`, "authenticated", STAFF);
  assert.ok(denied(`insert into public.regular_activities(title, category, organiser_hub_id) values ('x','other','${HUB_U}')`, "authenticated", OTHER));
  assert.equal(run(`with u as (update public.regular_activities set title='Hub grab' where id='${p}' returning 1) select count(*) from u`, "authenticated", HUB_OWNER), "0", "a hub cannot edit a platform activity");
  assert.ok(denied(`select public.admin_assign_activity_owner('${p}', null, '${HUB_V}', 'trying it on')`, "authenticated", HUB_OWNER), "not staff");
  assert.ok(denied(`select public.admin_assign_activity_owner('${p}', null, '${HUB_V}', 'short')`, "authenticated", STAFF), "reason too short");
  assert.ok(denied(`select public.admin_assign_activity_owner('${p}', '${B1}', '${HUB_V}', 'both set is invalid')`, "authenticated", STAFF), "exactly one new owner");
  run(`select public.admin_assign_activity_owner('${p}', null, '${HUB_U}', 'Bressay hub now runs this group')`, "authenticated", STAFF);
  assert.equal(run(`select is_platform_activity::text||'|'||organiser_hub_id from public.regular_activities where id='${p}'`), `false|${HUB_U}`);
  assert.equal(run(`select count(*) from public.regular_activities where id='${p}'`, "anon"), "0", "unverified hub: not public until approved");
  assert.equal(run(`with u as (update public.regular_activities set title='Hub edited' where id='${p}' returning 1) select count(*) from u`, "authenticated", HUB_OWNER), "1", "the hub now controls it");
  assert.equal(run(`select to_owner||'|'||from_owner||'|'||actor from public.activity_owner_log where activity_id='${p}' and kind='handover'`), `hub:${HUB_U}|platform|${STAFF}`);
  run(`select public.admin_assign_activity_owner('${p}', null, '${HUB_V}', 'Moved to the verified hub')`, "authenticated", STAFF);
  assert.equal(run(`select count(*) from public.regular_activities where id='${p}'`, "anon"), "1", "a verified hub's activity is public straight away");
});

// ── the change outbox
const future = (days: number) => { const d = new Date(Date.now() + days * 86_400_000); return d.toISOString().slice(0, 10); };
const dowOf = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();
t("cancelling a session in the next three weeks writes ONE outbox row; the same state again is not repeated; a different change is a new row; far-future and draft changes write none", () => {
  const a = mk("Outbox Class", { biz: B1 }, BIZ_OWNER), day = future(5), far = future(40);
  const r = rule(a, dowOf(day), "18:00", "19:00", future(-30)), rFar = rule(a, dowOf(far), "20:00", "21:00", future(-30));
  const ex = (rid: string, d: string, kind: string, note: string) => run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind, note) values ('${a}','${rid}','${d}','${kind}', ${note ? `'${note}'` : "null"}) returning id`, "authenticated", BIZ_OWNER);
  const id = ex(r, day, "cancelled", "Instructor ill");
  assert.equal(run(`select count(*) from public.activity_change_notices where activity_id='${a}'`), "1");
  run(`update public.activity_exceptions set note = 'Instructor ill' where id='${id}'`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select count(*) from public.activity_change_notices where activity_id='${a}'`), "1", "an identical state is never queued twice");
  run(`update public.activity_exceptions set note = 'Instructor ill - back next week' where id='${id}'`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select count(*) from public.activity_change_notices where activity_id='${a}'`), "2", "a changed state is a new notice");
  ex(rFar, far, "cancelled", "far away");
  assert.equal(run(`select count(*) from public.activity_change_notices where activity_id='${a}'`), "2", "a session 40 days out is not worth a message yet");
  run(`delete from public.activity_exceptions where id='${id}'`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select kind from public.activity_change_notices where activity_id='${a}' order by created_at desc, id limit 1`), "restored");
  const dr = mk("Outbox Draft", { biz: B1 }, BIZ_OWNER, { status: "'draft'" }), rd = rule(dr, dowOf(day), "18:00", "19:00", future(-30));
  run(`insert into public.activity_exceptions(activity_id, rule_id, occurrence_date, kind) values ('${dr}','${rd}','${day}','cancelled')`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select count(*) from public.activity_change_notices where activity_id='${dr}'`), "0", "a draft has no followers and no outbox");
});
t("a break and an extra session also queue one notice each; the outbox is invisible to every client role", () => {
  const a = mk("Outbox Break", { biz: B1 }, BIZ_OWNER);
  run(`insert into public.activity_breaks(activity_id, start_date, end_date, reason) values ('${a}','${future(3)}','${future(12)}','Half term')`, "authenticated", BIZ_OWNER);
  run(`insert into public.activity_exceptions(activity_id, kind, new_starts_at, new_ends_at) values ('${a}','extra','${future(6)} 10:00+00','${future(6)} 11:00+00')`, "authenticated", BIZ_OWNER);
  assert.equal(run(`select string_agg(kind, ',' order by kind) from public.activity_change_notices where activity_id='${a}'`), "break,extra");
  for (const role of ["anon", "authenticated"]) {
    assert.ok(denied(`select * from public.activity_change_notices`, role));
    assert.ok(denied(`select * from public.activity_notice_state`, role));
    assert.ok(denied(`select * from public.activity_owner_log`, role));
  }
});
t("privacy: visitors cannot read who created an activity, who paused it, or an exception's author", () => {
  assert.ok(denied(`select created_by from public.regular_activities`, "anon"));
  assert.ok(denied(`select created_by from public.activity_exceptions`, "anon"));
  assert.ok(denied(`select admin_paused_by from public.regular_activities`, "authenticated", OTHER));
});
t("legacy event URLs: the map is readable (so an old event page can redirect) and only staff/service can write it", () => {
  assert.equal(run(`select count(*) from public.activity_legacy_events`, "anon"), "0");
  assert.ok(denied(`insert into public.activity_legacy_events(event_id, activity_id) values (gen_random_uuid(), gen_random_uuid())`, "authenticated", OTHER));
});
t("idempotent: applying the migration a second time changes nothing", () => {
  const snap = () => run("select (select count(*) from public.regular_activities)||'|'||(select count(*) from pg_policy where polrelid::regclass::text like 'public.%activit%')||'|'||(select count(*) from pg_trigger where tgrelid::regclass::text like 'public.%activit%' and not tgisinternal)");
  const a = snap(); run(readFileSync(MIG, "utf8")); assert.equal(snap(), a);
});
