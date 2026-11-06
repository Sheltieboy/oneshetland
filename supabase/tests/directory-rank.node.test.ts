/**
 * directory-rank.node.test.ts — the Directory tiers (0 featured, 1 owner-managed, 2 unclaimed), proved in a throwaway
 * PostgreSQL that mirrors the production shape: a security_invoker view over local_businesses, column-level grants
 * (anon cannot read owner_id), RLS that hides inactive and discovery-hidden rows. Synthetic data only.
 * Needs postgresql@17 (skipped otherwise). Run:  node --test supabase/tests/directory-rank.node.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = "/opt/homebrew/opt/postgresql@17/bin";
const have = existsSync(join(BIN, "initdb"));
const MIG = join(import.meta.dirname, "..", "migrations", "20261207000000_directory_rank.sql");
let dir = "", sock = "";
const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
const psql = (q: string, role = "postgres") => execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", role === "postgres" ? q : `set role ${role}; ${q}`], { env, encoding: "utf8" }).trim();
const denied = (q: string, role: string) => spawnSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `set role ${role}; ${q}`], { env, encoding: "utf8" }).status !== 0;

// The view as it is today, rebuilt from the migration itself minus the new column, so the "before" shape cannot drift from the real one.
const migration = readFileSync(MIG, "utf8");
const viewSql = migration.slice(migration.indexOf("create or replace view"), migration.indexOf("comment on column")).trim().replace(/;$/, "").replace(/^create or replace view public\.local_businesses_public\s+with \(security_invoker = true\) as\s*/i, "");
const oldView = viewSql.replace(/,\s*CASE[\s\S]*?END AS directory_rank/, "");
let columnsBefore = "";
const cols = [...oldView.matchAll(/^\s{4}([a-z_]+),?$/gm)].map((m) => m[1]);
const typeOf = (c: string) => c === "is_claimed" || c === "is_active" || c === "accepts_wallet" || c === "is_verified" ? "boolean" : c === "subscription_until" ? "timestamptz" : "text";

const F = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const OWNER = "11111111-1111-1111-1111-111111111111";

test.before(() => {
  if (!have) return;
  assert.ok(cols.includes("subscription_tier") && cols.includes("trade_credentials"), "parsed the production column list");
  dir = mkdtempSync(join(tmpdir(), "dr-")); sock = mkdtempSync(join("/tmp", "drs-"));
  execFileSync(join(BIN, "initdb"), ["--locale=en_US.UTF-8", "-D", join(dir, "pg"), "-A", "trust", "-U", "postgres"], { env, stdio: "ignore" });
  execFileSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-o", `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off`, "-l", join(dir, "log"), "-w", "start"], { env });
  execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-X", "-q", "-c", "create database t"], { env });
  const tableCols = ["id uuid primary key", "owner_id uuid", ...cols.filter((c) => c !== "id" && c !== "wallet_live" && c !== "locality").map((c) => `${c} ${typeOf(c)}`)].join(", ");
  psql(`create role anon; create role authenticated; create role service_role;
    create table local_businesses(${tableCols});
    create function auth_uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create table hidden_ids(id uuid);
    create function is_discovery_hidden(k text, i uuid) returns boolean language sql stable security definer as $$ select exists(select 1 from hidden_ids where id = i) $$;
    create function business_meets_tier(i uuid, t text) returns boolean language sql stable as $$ select false $$;
    create function business_locality(a text) returns text language sql immutable as $$ select a $$;
    alter table local_businesses enable row level security;
    create policy read_active on local_businesses for select using ((is_active = true and not is_discovery_hidden('business', id)) or owner_id = auth_uid());
    -- production grants: column-level SELECT, owner_id NOT among them
    grant select (id, ${cols.filter((c) => !["wallet_live", "locality"].includes(c)).join(", ")}) on local_businesses to anon, authenticated;
    grant select on hidden_ids to anon, authenticated;
    create view local_businesses_public with (security_invoker = true) as ${oldView};
    grant select on local_businesses_public to anon, authenticated;`);
  // name, tier, until, claimed, owner, active  → expected rank
  const rows: Array<[number, string, string, string, string, boolean, boolean]> = [
    [1, "A featured pro (unowned)", "pro", "now() + interval '30 days'", "false", false, true],
    [2, "B featured premium, no end date (claimed+owned)", "premium", "null", "true", true, true],
    [3, "C lapsed pro but owner-managed", "pro", "now() - interval '1 day'", "true", true, true],
    [4, "D approved claim (is_claimed + owner)", "free", "null", "true", true, true],
    [5, "E created by owner, web route (is_claimed true)", "free", "null", "true", true, true],
    [6, "F created by owner, other route (owner set, is_claimed false)", "free", "null", "false", true, true],
    [7, "G unclaimed import", "free", "null", "false", false, true],
    [8, "H unclaimed import 2", "free", "null", "false", false, true],
    [9, "I owner-managed but INACTIVE", "free", "null", "true", true, false],
    [10, "J featured but INACTIVE", "pro", "now() + interval '30 days'", "false", true, false],
    [11, "K owner-managed but discovery-HIDDEN", "free", "null", "true", true, true],
  ];
  for (const [n, name, tier, until, claimed, owned, active] of rows) {
    psql(`insert into local_businesses(id, owner_id, name, subscription_tier, subscription_until, is_claimed, is_active, is_verified, address)
          values ('${F(n)}', ${owned ? `'${OWNER}'` : "null"}, '${name}', '${tier}', ${until}, ${claimed}, ${active}, 'false', 'Lerwick')`);
  }
  psql(`insert into hidden_ids values ('${F(11)}')`);
  columnsBefore = psql("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='local_businesses_public'");
  psql(migration);
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });
const t = (name: string, fn: () => void) => test(name, { skip: !have && "postgresql@17 not installed" }, fn);
const rank = (n: number, role = "anon") => psql(`select directory_rank from local_businesses_public where id='${F(n)}'`, role);

t("tier 0: featured = active pro/premium that has not lapsed (same test as the Featured row), owned or not, no end date allowed", () => {
  assert.equal(rank(1), "0");   // unowned, paying
  assert.equal(rank(2), "0");   // premium, no end date
});
t("tier 0 does not outlive the subscription: a lapsed plan falls to the ownership tier, not to featured", () => {
  assert.equal(rank(3), "1");
});
t("tier 1, route A: an approved claim (is_claimed + owner) is owner-managed", () => assert.equal(rank(4), "1"));
t("tier 1, route B: a listing created by its owner is owner-managed, whichever way is_claimed was set", () => {
  assert.equal(rank(5), "1");   // web create form sets is_claimed true
  assert.equal(rank(6), "1");   // owner_id set, is_claimed false: ownership data decides, not the flag alone
});
t("tier 2: unclaimed imports with no owner", () => { assert.equal(rank(7), "2"); assert.equal(rank(8), "2"); });

t("the Directory order is tier, then the EXISTING order (verified first, then name) within each tier", () => {
  psql("update local_businesses set is_verified = true where id in ('" + F(6) + "','" + F(8) + "')");
  const order = psql(`select string_agg(left(name,1), '' order by directory_rank, is_verified desc, name) from local_businesses_public where is_active = true`, "anon");
  // tier 0: A, B   tier 1 (verified F first, then C, D, E by name)   tier 2 (verified H first, then G)
  assert.equal(order, "ABFCDEHG");
  psql("update local_businesses set is_verified = false");
});

t("no visibility gain: inactive and discovery-hidden rows are still absent for visitors, whatever their tier", () => {
  const ids = psql("select string_agg(left(name,1), '' order by name) from local_businesses_public", "anon");
  assert.equal(ids, "ABCDEFGH");               // I (inactive), J (inactive featured), K (hidden) never appear
  assert.equal(psql("select count(*) from local_businesses_public where directory_rank is null", "anon"), "0");
});
t("visitors still cannot read owner_id, and the helper exposes only a boolean", () => {
  assert.ok(denied("select owner_id from local_businesses", "anon"));
  assert.ok(denied("select owner_id from local_businesses_public", "anon"));
  assert.equal(psql(`select business_has_owner('${F(4)}'), business_has_owner('${F(7)}'), business_has_owner(gen_random_uuid())`, "anon"), "t|f|f");
});
t("the migration only appends: every existing column keeps its position and the view stays security_invoker", () => {
  const after = psql("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='local_businesses_public'");
  assert.equal(after, columnsBefore + ",directory_rank");
  assert.match(psql("select reloptions::text from pg_class where relname='local_businesses_public'"), /security_invoker=true/);
});
t("no data is changed: the table is exactly as seeded", () => {
  assert.equal(psql("select count(*) from local_businesses"), "11");
  assert.equal(psql("select count(*) from local_businesses where owner_id is not null"), "8");
});
t("idempotent: applying it twice is harmless", () => { psql(migration); assert.equal(rank(1), "0"); });
