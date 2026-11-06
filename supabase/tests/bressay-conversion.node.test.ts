/**
 * bressay-conversion.node.test.ts — the prepared Bressay Under 5s conversion, proved on a copy of the real rows in a throwaway PostgreSQL.
 * Preview changes nothing; step 1 makes an invisible draft; step 2 refuses if the activity would not reproduce the live events EXACTLY,
 * touches only the seven named events, and is undone by step 3. Needs postgresql@17 (skipped otherwise).
 * Run: node --test supabase/tests/bressay-conversion.node.test.ts
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
const SC = (f: string) => join(import.meta.dirname, "..", "scripts", "regular-activities", f);
let dir = "", sock = "";
const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
const args = (extra: string[]) => ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...extra];
const sql = (q: string, role = "postgres") => execFileSync(join(BIN, "psql"), args(["-c", role === "postgres" ? q : `set role ${role}; ${q}`]), { env, encoding: "utf8" }).trim();
const file = (f: string) => spawnSync(join(BIN, "psql"), args(["-f", SC(f)]), { env, encoding: "utf8" });

const EV: [string, string, string][] = [
  ["631c1981-5ddc-834d-9456-1e62a30ce691", "2026-11-07 10:00+00", "2026-11-07 12:30+00"],   // the moved session
  ["28a12d8c-c8be-7398-884a-c0f56842a890", "2026-11-13 10:30+00", "2026-11-13 12:30+00"],
  ["82b66785-b681-99b2-16d9-c8643feaaf2e", "2026-11-20 10:30+00", "2026-11-20 12:30+00"],
  ["03d78c64-c673-b340-8785-b5e2db410511", "2026-11-27 10:30+00", "2026-11-27 12:30+00"],
  ["45d1ba64-f991-6414-4e41-d61318ee8144", "2026-12-04 10:30+00", "2026-12-04 12:30+00"],
  ["00c6df8c-41cc-62d0-6204-a2d91de09229", "2026-12-11 10:30+00", "2026-12-11 12:30+00"],
  ["a2e870ef-c163-bc6b-fb4a-7daf1bbde8c5", "2026-12-18 10:30+00", "2026-12-18 12:30+00"],
];
const DECOY = "99999999-9999-9999-9999-999999999991", WED = "99999999-9999-9999-9999-999999999992";
let eventsBefore = "", previewOut = "";

test.before(() => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "bc-")); sock = mkdtempSync(join("/tmp", "bcs-"));
  execFileSync(join(BIN, "initdb"), ["--locale=en_US.UTF-8", "-D", join(dir, "pg"), "-A", "trust", "-U", "postgres"], { env, stdio: "ignore" });
  execFileSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-o", `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off -c timezone=UTC`, "-l", join(dir, "log"), "-w", "start"], { env });
  execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-X", "-q", "-c", "create database t"], { env });
  sql(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create table auth.users(id uuid primary key);
    create table public.profiles(id uuid primary key, role text);
    create table public.local_businesses(id uuid primary key, owner_id uuid, name text, slug text, is_active boolean default true);
    create table public.hubs(id uuid primary key, owner_id uuid, name text, slug text, is_active boolean default true, is_verified boolean default false);
    create table public.hub_members(hub_id uuid, user_id uuid, role text, status text);
    create table public.events(id uuid primary key, title text, description text, category text, venue text, locality text, lat numeric, lng numeric,
      cover_url text, price_text text, starts_at timestamptz, ends_at timestamptz, status text default 'published', is_platform_event boolean default true);
    create function public.attribution_staff() returns boolean language sql stable as $$ select false $$;
    create function public.controls_event_entity(a uuid, b uuid) returns boolean language sql stable as $$ select false $$;
    revoke execute on function public.attribution_staff() from public; grant execute on function public.attribution_staff() to authenticated, service_role;
    revoke execute on function public.controls_event_entity(uuid, uuid) from public; grant execute on function public.controls_event_entity(uuid, uuid) to authenticated, service_role;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant select on public.local_businesses, public.hubs, public.profiles, public.events to anon, authenticated, service_role;`);
  const row = (id: string, title: string, s: string, e: string) => `('${id}', '${title}', 'A friendly weekly babies and bairns group for families, held on Fridays in the nursery at Speldiburn.', 'Family', 'Speldiburn', 'Bressay', 60.151345, -1.111956, 'https://example.test/c.jpg', 'Small donation', '${s}', '${e}', 'published', true)`;
  sql(`insert into public.events values ${[...EV.map(([id, s, e]) => row(id, "Bressay Under 5s", s, e)), row(DECOY, "Bressay Under 5s", "2026-12-25 10:30+00", "2026-12-25 12:30+00"), row(WED, "Bressay Wednesday Social Afternoon", "2026-11-11 14:00+00", "2026-11-11 16:00+00")].join(",")}`);
  eventsBefore = sql("select md5(string_agg(to_jsonb(e)::text, '|' order by id)) from public.events e");
  const p = file("bressay-under-5s-0-preview.sql"); assert.equal(p.status, 0, p.stderr); previewOut = p.stdout.trim();
  assert.equal(sql("select md5(string_agg(to_jsonb(e)::text, '|' order by id)) from public.events e"), eventsBefore, "the preview wrote nothing");
  sql(readFileSync(MIG, "utf8"));
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });
const t = (name: string, fn: () => void) => test(name, { skip: !have && "postgresql@17 not installed" }, fn);
const evHash = () => sql("select md5(string_agg(to_jsonb(e)::text, '|' order by id)) from public.events e");
const sessionsPub = () => sql(`select string_agg(to_char(starts_at,'MM-DD HH24:MI')||'~'||to_char(ends_at,'HH24:MI')||' '||status, ' | ' order by starts_at) from public.activity_sessions('2026-11-01','2027-01-15', (select id from public.regular_activities where slug='bressay-under-5s'))`, "anon");

t("the preview is read-only and names the seven events: six regular Fridays and ONE exception (the moved 6 Nov session)", () => {
  const lines = previewOut.split("\n");
  assert.equal(lines.length, 7);
  assert.match(lines[0], /Sat 07 Nov 2026 10:00.*EXCEPTION: scheduled Fri 06 Nov 10:30, moved to Sat 07 Nov 10:00/);
  for (const l of lines.slice(1)) assert.match(l, /regular Friday session/);
  assert.ok(!previewOut.includes(DECOY) && !previewOut.includes(WED), "decoys are never listed");
});
t("step 1 creates an invisible DRAFT with one rule and one exception, and changes no event", () => {
  const r = file("bressay-under-5s-1-prepare.sql"); assert.equal(r.status, 0, r.stderr);
  assert.equal(sql("select status||'|'||is_platform_activity||'|'||slug||'|'||category||'|'||price_text from public.regular_activities"), "draft|true|bressay-under-5s|kids_family|Small donation");
  assert.equal(sql("select count(*) from public.regular_activities", "anon"), "0", "the public sees nothing");
  assert.equal(sql("select count(*) from public.activity_schedule_rules"), "1");
  assert.equal(sql("select kind||'|'||occurrence_date||'|'||note from public.activity_exceptions"), "changed|2026-11-06|Moved to Saturday this week");
  assert.equal(evHash(), eventsBefore, "no event row was read for writing, edited or hidden");
  assert.equal(sql("select count(*) from public.activity_legacy_events"), "0", "no URL changes yet");
  assert.equal(sql("select description from public.regular_activities"), sql("select description from public.events where id='28a12d8c-c8be-7398-884a-c0f56842a890'"), "text copied, not retyped");
});
t("step 1 cannot be run twice", () => { assert.notEqual(file("bressay-under-5s-1-prepare.sql").status, 0); });
t("the draft already reproduces the live events exactly (so step 2 will pass)", () => {
  assert.equal(sql(`select string_agg(to_char(starts_at,'MM-DD HH24:MI')||'~'||to_char(ends_at,'HH24:MI')||' '||status, ' | ' order by starts_at) from public.activity_sessions('2026-11-01','2027-01-15', (select id from public.regular_activities))`),
    "11-07 10:00~12:30 moved | 11-13 10:30~12:30 scheduled | 11-20 10:30~12:30 scheduled | 11-27 10:30~12:30 scheduled | 12-04 10:30~12:30 scheduled | 12-11 10:30~12:30 scheduled | 12-18 10:30~12:30 scheduled");
});
t("step 2 REFUSES, and changes nothing, if a live event no longer matches (someone edited a time after the preview)", () => {
  sql("update public.events set starts_at = '2026-11-20 11:00+00' where id = '82b66785-b681-99b2-16d9-c8643feaaf2e'");
  const drifted = evHash();
  const r = file("bressay-under-5s-2-go-live.sql");
  assert.notEqual(r.status, 0); assert.match(r.stderr, /does not reproduce the live events exactly/);
  assert.equal(evHash(), drifted, "no event was archived");
  assert.equal(sql("select status from public.regular_activities"), "draft");
  assert.equal(sql("select count(*) from public.activity_legacy_events"), "0");
  sql("update public.events set starts_at = '2026-11-20 10:30+00' where id = '82b66785-b681-99b2-16d9-c8643feaaf2e'");
  assert.equal(evHash(), eventsBefore);
});
t("step 2 goes live: publishes the activity, maps every old URL, archives ONLY the seven named events, leaves the decoy and other series alone", () => {
  const r = file("bressay-under-5s-2-go-live.sql"); assert.equal(r.status, 0, r.stderr);
  assert.equal(sql("select status from public.regular_activities"), "published");
  assert.equal(sql("select string_agg(status, ',' order by id) from public.events where id in ('" + EV.map((e) => e[0]).join("','") + "')"), Array(7).fill("archived").join(","));
  assert.equal(sql(`select status from public.events where id='${DECOY}'`), "published", "a recurring-looking row that was not named is untouched");
  assert.equal(sql(`select status from public.events where id='${WED}'`), "published", "another series is untouched");
  assert.equal(sql("select count(*) from public.events where status='archived'"), "7");
  assert.equal(sql("select count(*) from public.activity_legacy_events"), "7");
  assert.equal(sql("select occurrence_date from public.activity_legacy_events where event_id='631c1981-5ddc-834d-9456-1e62a30ce691'"), "2026-11-06", "the moved event maps to the session that was moved");
});
t("after go-live visitors see ONE listing whose sessions are exactly what the seven events showed, including the moved Saturday", () => {
  assert.equal(sql("select count(*) from public.regular_activities", "anon"), "1");
  assert.equal(sessionsPub(), "11-07 10:00~12:30 moved | 11-13 10:30~12:30 scheduled | 11-20 10:30~12:30 scheduled | 11-27 10:30~12:30 scheduled | 12-04 10:30~12:30 scheduled | 12-11 10:30~12:30 scheduled | 12-18 10:30~12:30 scheduled");
  assert.equal(sql("select count(*) from public.regular_activities_listing('2026-11-02','2026-11-30') where slug='bressay-under-5s'", "anon"), "1");
});
t("old event URLs are readable by visitors so each can redirect to the activity", () => {
  assert.equal(sql("select count(*) from public.activity_legacy_events", "anon"), "7");
});
t("step 3 undoes step 2: events published again, redirects gone, activity back to draft", () => {
  const r = file("bressay-under-5s-3-revert.sql"); assert.equal(r.status, 0, r.stderr);
  assert.equal(evHash(), eventsBefore, "the events are exactly as they were before any step");
  assert.equal(sql("select count(*) from public.activity_legacy_events"), "0");
  assert.equal(sql("select status from public.regular_activities"), "draft");
});
t("no script matches events by title for writing: every UPDATE of events names the seven ids", () => {
  for (const f of ["bressay-under-5s-2-go-live.sql", "bressay-under-5s-3-revert.sql"]) {
    const src = readFileSync(SC(f), "utf8").replace(/--.*$/gm, "");
    const updates = [...src.matchAll(/update public\.events[\s\S]*?;/gi)].map((m) => m[0]);
    assert.ok(updates.length >= 1, f);
    for (const u of updates) assert.match(u, /where id (= any \(ids\)|in \()/i, `${f}: ${u.slice(0, 60)}`);
    assert.doesNotMatch(updates.join(" "), /title\s*(=|ilike|like)/i);
  }
});
