/**
 * home-pin-migration.node.test.ts — the pinned-card columns, proved in a throwaway PostgreSQL (needs postgresql@17; skipped otherwise).
 * Synthetic data only. Run:  node --test supabase/tests/home-pin-migration.node.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = "/opt/homebrew/opt/postgresql@17/bin";
const have = existsSync(join(BIN, "initdb"));
const MIG = join(import.meta.dirname, "..", "migrations", "20261206000000_home_pin.sql");
let dir = "", sock = "";
const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
const sql = (q: string, role = "postgres") => execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", role === "postgres" ? q : `set role ${role}; ${q}`], { env, encoding: "utf8" }).trim();
const fails = (q: string) => { const r = spawnSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", q], { env, encoding: "utf8" }); return r.status !== 0; };

test.before(() => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "hp-")); sock = mkdtempSync(join("/tmp", "hps-"));
  execFileSync(join(BIN, "initdb"), ["--locale=en_US.UTF-8", "-D", join(dir, "pg"), "-A", "trust", "-U", "postgres"], { env, stdio: "ignore" });
  execFileSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-o", `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off`, "-l", join(dir, "log"), "-w", "start"], { env, stdio: "ignore" });
  execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-X", "-q", "-c", "create database t"], { env });
  sql(`create role anon; create role authenticated;
    create table home_content(id uuid primary key default gen_random_uuid(), welcome_title text, spotlight_title text, updated_at timestamptz not null default now());
    insert into home_content(welcome_title) values ('Welcome');
    alter table home_content enable row level security;
    create function is_admin() returns boolean language sql stable as $$ select current_setting('app.admin', true) = 'yes' $$;
    create policy "home_content public read" on home_content for select to public using (true);
    create policy "home_content admin write" on home_content for all to authenticated using (is_admin()) with check (is_admin());
    grant select on home_content to anon, authenticated; grant insert, update, delete on home_content to authenticated;`);
  sql(readFileSync(MIG, "utf8"));
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });
const t = (name: string, fn: () => void) => test(name, { skip: !have && "postgresql@17 not installed" }, fn);

t("additive: the existing row is untouched and the card is OFF until an admin switches it on", () => {
  assert.equal(sql("select welcome_title || '|' || pin_enabled::text || '|' || coalesce(pin_title,'-') from home_content"), "Welcome|false|-");
});
t("anyone can read the card columns (public wording); only an admin can change them", () => {
  assert.equal(sql("select pin_enabled::text from home_content", "anon"), "false");
  assert.ok(fails("set role anon; update home_content set pin_enabled = false"));
  assert.equal(sql("set role authenticated; update home_content set pin_title = 'x'; select count(*) from home_content where pin_title = 'x'", "postgres").split("\n").pop(), "0");   // not admin: 0 rows changed
  sql("set app.admin = 'yes'; set role authenticated; update home_content set pin_title = 'Hello'");
  assert.equal(sql("select pin_title from home_content"), "Hello"); sql("update home_content set pin_title = null");
});
t("switching it on needs a title, an expiry and a safe link", () => {
  const on = (cols: string) => `update home_content set pin_enabled = true, ${cols}`;
  assert.ok(fails(on("pin_title = '', pin_href = '/x', pin_expires_at = now() + interval '1 day'")), "title");
  assert.ok(fails(on("pin_title = 'T', pin_href = '/x'")), "expiry");
  assert.ok(fails(on("pin_title = 'T', pin_expires_at = now() + interval '1 day'")), "link");
  for (const bad of ["javascript:alert(1)", "http://x.test", "//evil.test", "relative", "/ok path", "https://x y", "/\\\\evil", "data:text/html,1"])
    assert.ok(fails(on(`pin_title = 'T', pin_href = '${bad.replace(/'/g, "''")}', pin_expires_at = now() + interval '1 day'`)), bad);
  for (const good of ["/notices", "/directory?q=a", "https://oneshetland.com/x"]) {
    sql(on(`pin_title = 'T', pin_href = '${good}', pin_expires_at = now() + interval '1 day'`)); sql("update home_content set pin_enabled = false, pin_title = null, pin_href = null, pin_expires_at = null");
  }
});
t("lengths are capped so the card cannot overflow", () => {
  assert.ok(fails(`update home_content set pin_title = '${"x".repeat(61)}'`)); assert.ok(fails(`update home_content set pin_body = '${"x".repeat(141)}'`));
  assert.ok(fails(`update home_content set pin_cta = '${"x".repeat(25)}'`)); sql(`update home_content set pin_title = '${"x".repeat(60)}'`); sql("update home_content set pin_title = null");
});
t("an OFF card may hold draft wording with no expiry (it can be prepared, then switched on)", () => { sql("update home_content set pin_title = 'Draft', pin_href = 'not checked while off'"); sql("update home_content set pin_title = null, pin_href = null"); });
t("re-running the migration is harmless to data (columns are added only if missing)", () => { assert.match(readFileSync(MIG, "utf8"), /add column if not exists pin_enabled/); });
