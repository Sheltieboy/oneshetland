/**
 * business-discovery.node.test.ts — Directory tiers, live_tier and the ownership activation date, proved in a throwaway PostgreSQL
 * that mirrors production: a security_invoker view over local_businesses, column-level grants (anon cannot read owner_id), RLS
 * hiding inactive and discovery-hidden rows, the deployed business_meets_tier semantics, the trusted-writer rule, and the
 * existing owner/claims data. Synthetic data only. Needs postgresql@17 (skipped otherwise).
 * Run:  node --test supabase/tests/business-discovery.node.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = "/opt/homebrew/opt/postgresql@17/bin";
const have = existsSync(join(BIN, "initdb"));
const MIG = join(import.meta.dirname, "..", "migrations", "20261207000000_business_discovery.sql");
let dir = "", sock = "";
const env = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
const run = (q: string, role = "postgres") => execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", role === "postgres" ? q : `set role ${role}; ${q}`], { env, encoding: "utf8" }).trim();
const denied = (q: string, role: string) => spawnSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-d", "t", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `set role ${role}; ${q}`], { env, encoding: "utf8" }).status !== 0;

const migration = readFileSync(MIG, "utf8");
const viewStart = migration.indexOf("create or replace view");
const viewSql = migration.slice(viewStart, migration.indexOf("comment on column public.local_businesses_public")).trim().replace(/;$/, "");
const body = viewSql.replace(/^create or replace view public\.local_businesses_public\s+with \(security_invoker = true\) as\s*/i, "");
// The view as it is in production today = the new one minus the three appended columns.
const oldView = body.replace(/,\s*CASE[\s\S]*(?=\n\s+FROM local_businesses b)/, "");
const cols = ["id", ...[...oldView.matchAll(/^\s{4}([a-z_]+),?$/gm)].map((m) => m[1])];
const BOOL = new Set(["is_claimed", "is_active", "accepts_wallet", "is_verified"]);
const TS = new Set(["subscription_until", "created_at", "claimed_at", "verified_at"]);
const typeOf = (c: string) => c === "id" ? "uuid" : BOOL.has(c) ? "boolean" : TS.has(c) ? "timestamptz" : "text";
const F = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const OWNER = "11111111-1111-1111-1111-111111111111";
let columnsBefore = "";

test.before(() => {
  if (!have) return;
  assert.ok(cols.includes("subscription_tier") && cols.includes("trade_credentials") && cols.includes("created_at"), "parsed the production column list");
  assert.ok(!/directory_rank|live_tier/.test(oldView), "the 'before' view has none of the new columns");
  dir = mkdtempSync(join(tmpdir(), "bd-")); sock = mkdtempSync(join("/tmp", "bds-"));
  execFileSync(join(BIN, "initdb"), ["--locale=en_US.UTF-8", "-D", join(dir, "pg"), "-A", "trust", "-U", "postgres"], { env, stdio: "ignore" });
  execFileSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-o", `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off`, "-l", join(dir, "log"), "-w", "start"], { env });
  execFileSync(join(BIN, "psql"), ["-h", sock, "-U", "postgres", "-X", "-q", "-c", "create database t"], { env });
  const tableCols = ["owner_id uuid", ...cols.filter((c) => c !== "wallet_live" && c !== "locality").map((c) => `${c} ${typeOf(c)}${c === "id" ? " primary key" : ""}`)].join(", ");
  run(`create role anon; create role authenticated; create role service_role;
    create table local_businesses(${tableCols});
    create table business_claims(id serial primary key, business_id uuid, status text, reviewed_at timestamptz);
    create function auth_uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create function is_admin() returns boolean language sql stable as $$ select false $$;
    -- the deployed rule, verbatim in effect
    create function tg_is_trusted_writer() returns boolean language plpgsql stable as $$ begin
      if current_user not in ('authenticated','anon') then return true; end if; return is_admin(); end $$;
    -- the deployed entitlement predicate: recorded high enough AND a live, non-null end date
    create function business_meets_tier(i uuid, t text) returns boolean language plpgsql stable security definer as $$
      declare v_req int := case t when 'free' then 0 when 'pro' then 1 when 'premium' then 2 end; v_tier text; v_until timestamptz; v_act int;
      begin select subscription_tier, subscription_until into v_tier, v_until from local_businesses where id = i;
        if not found then return false; end if; if v_req = 0 then return true; end if;
        v_act := case v_tier when 'premium' then 2 when 'pro' then 1 else 0 end;
        if v_act < v_req then return false; end if; return v_until is not null and v_until > now(); end $$;
    create function business_locality(a text) returns text language sql immutable as $$ select a $$;
    create table hidden_ids(id uuid);
    create function is_discovery_hidden(k text, i uuid) returns boolean language sql stable security definer as $$ select exists(select 1 from hidden_ids where id = i) $$;
    -- a stand-in for production's column lock: clients cannot change owner_id by update
    create function tg_zz_lock() returns trigger language plpgsql as $$ begin
      if tg_op = 'UPDATE' and not tg_is_trusted_writer() then new.owner_id := old.owner_id; end if; return new; end $$;
    create trigger tg_zz_lock_business_columns before insert or update on local_businesses for each row execute function tg_zz_lock();
    alter table local_businesses enable row level security;
    create policy read_active on local_businesses for select using ((is_active = true and not is_discovery_hidden('business', id)) or owner_id = auth_uid());
    create policy owner_write on local_businesses for insert to authenticated with check (owner_id = auth_uid());
    create policy owner_upd on local_businesses for update to authenticated using (owner_id = auth_uid());
    grant select (${cols.filter((c) => c !== "wallet_live" && c !== "locality").join(", ")}) on local_businesses to anon, authenticated;
    grant insert, update on local_businesses to authenticated;
    grant select on hidden_ids to anon, authenticated;
    create view local_businesses_public with (security_invoker = true) as ${oldView};
    grant select on local_businesses_public to anon, authenticated;`);

  // id, name, tier, until, is_claimed, owner, active, created_at, claimed_at
  const rows: Array<[number, string, string, string, string, boolean, boolean, string, string]> = [
    [1, "A premium live (unowned)", "premium", "now() + interval '30 days'", "false", false, true, "'2026-07-01'", "null"],
    [2, "B pro live (owned)", "pro", "now() + interval '30 days'", "true", true, true, "'2026-08-01'", "'2026-08-02'"],
    [3, "C pro, NO end date (anomaly)", "pro", "null", "false", false, true, "'2026-07-02'", "null"],
    [4, "D premium LAPSED, owned", "premium", "now() - interval '1 day'", "true", true, true, "'2026-07-03'", "'2026-07-04'"],
    [5, "E approved claim", "free", "null", "true", true, true, "'2026-07-05'", "'2026-09-09'"],
    [6, "F created by owner (web, is_claimed true)", "free", "null", "true", true, true, "'2026-10-10'", "null"],
    [7, "G created by owner (is_claimed false)", "free", "null", "false", true, true, "'2026-10-11'", "null"],
    [8, "H unclaimed import", "free", "null", "false", false, true, "'2026-07-06'", "null"],
    [9, "I unclaimed import 2", "free", "null", "false", false, true, "'2026-07-07'", "null"],
    [10, "J owner-managed INACTIVE", "free", "null", "true", true, false, "'2026-10-12'", "null"],
    [11, "K featured INACTIVE", "pro", "now() + interval '30 days'", "false", true, false, "'2026-10-13'", "null"],
    [12, "L owner-managed discovery-HIDDEN", "free", "null", "true", true, true, "'2026-10-14'", "null"],
    [13, "M is_claimed true, no owner record", "free", "null", "true", false, true, "'2026-07-08'", "null"],
  ];
  for (const [n, name, tier, until, claimed, owned, active, created, claimedAt] of rows) {
    run(`insert into local_businesses(id, owner_id, name, subscription_tier, subscription_until, is_claimed, is_active, is_verified, address, created_at, claimed_at)
         values ('${F(n)}', ${owned ? `'${OWNER}'` : "null"}, '${name}', '${tier}', ${until}, ${claimed}, ${active}, false, 'Lerwick', ${created}, ${claimedAt})`);
  }
  run(`insert into hidden_ids values ('${F(12)}')`);
  // approved claim for E (date differs from claimed_at on purpose); a PENDING and a REJECTED claim must be ignored
  run(`insert into business_claims(business_id, status, reviewed_at) values ('${F(5)}','approved','2026-09-10 09:00+00'), ('${F(5)}','pending','2026-09-20'), ('${F(2)}','rejected','2026-09-01')`);
  columnsBefore = run("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='local_businesses_public'");
  run(migration);
});
test.after(() => { if (!have || !dir) return; spawnSync(join(BIN, "pg_ctl"), ["-D", join(dir, "pg"), "-m", "immediate", "stop"], { env, stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); });
const t = (name: string, fn: () => void) => test(name, { skip: !have && "postgresql@17 not installed" }, fn);
const col = (c: string, n: number, role = "anon") => run(`select ${c} from local_businesses_public where id='${F(n)}'`, role);
const rank = (n: number) => col("directory_rank", n);

// ── tiers
t("tier 0 is canonical entitlement: a LIVE Pro or Premium (end date set and in the future), owned or not", () => {
  assert.equal(rank(1), "0"); assert.equal(rank(2), "0");
});
t("tier 0 is NOT any active-looking Pro: no end date, or a lapsed plan, does not qualify", () => {
  assert.equal(rank(3), "2");   // pro with no end date: business_meets_tier is false, so not featured (and unowned)
  assert.equal(rank(4), "1");   // lapsed premium: falls to the ownership tier, not featured
});
t("tier 1, both ownership routes: an approved claim, and a listing created by its owner (whatever is_claimed says)", () => {
  assert.equal(rank(5), "1"); assert.equal(rank(6), "1"); assert.equal(rank(7), "1");
});
t("tier 1 keeps what the Directory already treats as claimed (is_claimed without an owner record is not demoted)", () => assert.equal(rank(13), "1"));
t("tier 2: unclaimed imports", () => { assert.equal(rank(8), "2"); assert.equal(rank(9), "2"); });

t("the order is tier, then the EXISTING order (verified first, then name) inside each tier", () => {
  run("update local_businesses set is_verified = true where id in ('" + F(7) + "','" + F(9) + "')");
  const order = run(`select string_agg(left(name,1), '' order by directory_rank, is_verified desc, name) from local_businesses_public where is_active = true`, "anon");
  // tier 0: A, B (by name)   tier 1: G (verified first), then D, E, F, M   tier 2: I (verified first), then C, H
  assert.equal(order, "ABGDEFMICH");
  run("update local_businesses set is_verified = false");
});

// ── live_tier
t("live_tier is the entitlement right now: premium, pro, or free — never the recorded plan alone", () => {
  assert.equal(col("live_tier", 1), "premium"); assert.equal(col("live_tier", 2), "pro");
  assert.equal(col("live_tier", 3), "free");    // no end date
  assert.equal(col("live_tier", 4), "free");    // lapsed premium
  assert.equal(col("live_tier", 8), "free");
});

// ── visibility and privacy
t("no visibility gain: inactive and discovery-hidden rows stay absent for visitors, whatever their tier", () => {
  assert.equal(run("select string_agg(left(name,1), '' order by name) from local_businesses_public", "anon"), "ABCDEFGHIM");
});
t("visitors still cannot read owner_id; the view stays security_invoker; there is no SECURITY DEFINER helper", () => {
  assert.ok(denied("select owner_id from local_businesses", "anon"));
  assert.ok(denied("select owner_id from local_businesses_public", "anon"));
  assert.match(run("select reloptions::text from pg_class where relname='local_businesses_public'"), /security_invoker=true/);
  assert.equal(run("select count(*) from pg_proc where proname in ('business_has_owner')"), "0");
  assert.equal(run("select prosecdef from pg_proc where proname='tg_owner_activation'"), "f");
});
t("the migration only appends three columns and keeps every existing position", () => {
  assert.equal(run("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='local_businesses_public'"),
    columnsBefore + ",directory_rank,live_tier,owner_activated_at");
});

// ── ownership activation date
t("backfill is accurate: approved claim review date, else claimed_at, else created_at; unowned stay empty; pending/rejected ignored", () => {
  assert.match(run(`select (owner_activated_at at time zone 'UTC')::text from local_businesses where id='${F(5)}'`), /^2026-09-10 09:00:00/);   // the APPROVED claim, not claimed_at (09-09) or the pending one (09-20)
  assert.match(run(`select owner_activated_at::text from local_businesses where id='${F(2)}'`), /^2026-08-02/);            // rejected claim ignored; claimed_at
  assert.match(run(`select owner_activated_at::text from local_businesses where id='${F(6)}'`), /^2026-10-10/);            // owner-created: created_at
  assert.equal(run(`select count(*) from local_businesses where owner_id is null and owner_activated_at is not null`), "0");
  assert.equal(run(`select count(*) from local_businesses where owner_id is not null and owner_activated_at is null`), "0");
});
t("a listing created by its owner is stamped now, and a client cannot forge the date", () => {
  run(`set app.uid='${OWNER}'; insert into local_businesses(id, owner_id, name, subscription_tier, is_claimed, is_active, is_verified, address, owner_activated_at, created_at)
       values ('${F(40)}', '${OWNER}', 'N new by owner, forged date', 'free', true, true, false, 'Lerwick', '2020-01-01', now())`, "authenticated");
  const age = run(`select extract(epoch from now() - owner_activated_at) < 5 from local_businesses where id='${F(40)}'`);
  assert.equal(age, "t");
});
t("a client cannot move the date afterwards, and cannot take ownership by update", () => {
  const before = run(`select owner_activated_at::text from local_businesses where id='${F(6)}'`);
  const n = run(`set app.uid='${OWNER}'; with u as (update local_businesses set owner_activated_at = now(), owner_id = null where id='${F(6)}' returning 1) select count(*) from u`, "authenticated");
  assert.equal(n.split("\n").pop(), "1", "the owner's update really ran (so the guard, not RLS, is what held the values)");
  assert.equal(run(`select owner_activated_at::text from local_businesses where id='${F(6)}'`), before);
  assert.equal(run(`select (owner_id is not null)::text from local_businesses where id='${F(6)}'`), "true");
});
t("an approved claim stamps now (ownership begins); removing the owner clears the date; a trusted writer may set an exact date", () => {
  run(`update local_businesses set owner_id='${OWNER}', is_claimed = true where id='${F(8)}'`);   // trusted (service/definer) path: how an approved claim lands
  assert.equal(run(`select extract(epoch from now() - owner_activated_at) < 5 from local_businesses where id='${F(8)}'`), "t");
  assert.equal(rank(8), "1");
  run(`update local_businesses set owner_id = null where id='${F(8)}'`);
  assert.equal(run(`select (owner_activated_at is null)::text from local_businesses where id='${F(8)}'`), "true");
  run(`update local_businesses set owner_id='${OWNER}', owner_activated_at='2026-05-05' where id='${F(8)}'`);
  assert.match(run(`select owner_activated_at::text from local_businesses where id='${F(8)}'`), /^2026-05-05/);
});
t("the invariant is enforced by the database: an owner with no date, or a date with no owner, is refused", () => {
  assert.ok(denied(`update local_businesses set owner_activated_at = null where id='${F(5)}'`, "postgres") === false, "the trigger repairs a missing date");
  assert.equal(run(`select (owner_activated_at is not null)::text from local_businesses where id='${F(5)}'`), "true");
  assert.match(run(`select pg_get_constraintdef(oid) from pg_constraint where conname='local_businesses_owner_activation_consistent'`), /owner_id IS NULL\) = \(owner_activated_at IS NULL/);
});
t("visitors can read the activation date through the view, and the column is not client-writable by grant", () => {
  assert.match(col("owner_activated_at::text", 5), /^2026-09-10/);
  assert.ok(denied(`update local_businesses set owner_activated_at = now() where id='${F(5)}'`, "anon"));
});
t("idempotent: applying the migration twice changes no date and no rank", () => {
  const snap = () => run("select md5(string_agg(id::text||coalesce(owner_activated_at::text,'-')||coalesce(directory_rank::text,'-'), ',' order by id)) from local_businesses_public");
  const a = snap(); run(migration); assert.equal(snap(), a);
});
