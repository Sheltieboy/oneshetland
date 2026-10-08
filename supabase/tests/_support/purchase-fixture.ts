/**
 * purchase-fixture.ts — an isolated Postgres shaped like production's shop-order and gift tables, plus a Supabase-compatible
 * client that runs the handlers' own calls against it.
 *
 * SAFETY: requires PASS_PROOF_DSN (a throwaway cluster from `npm run test:isolated`) and refuses a DSN that mentions Supabase.
 * Nothing here can reach production, Stripe or the network.
 *
 * WHY A CLIENT THAT TALKS TO A REAL DATABASE: "two requests at once create one order" is a statement about the database, not
 * about JavaScript. Every call below is its OWN psql process — its own backend, its own transaction — so Promise.all over the real
 * handlers produces genuinely concurrent sessions fighting over the real unique index and the real row locks.
 *
 * The tables are the production definitions (commerce-engine migration + baseline), the three stock functions are
 * byte-identical to production's (md5-checked in the suite), and the attempt migration under test is applied verbatim.
 */

import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MIG = join(REPO_ROOT, 'supabase/migrations');
export const DSN = process.env.PASS_PROOF_DSN ?? '';
export const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
export const ATTEMPT_MIGRATION = join(MIG, '20261120010000_purchase_attempt_idempotency.sql');
const src = (p: string) => readFileSync(p, 'utf8');

export function assertIsolated(): void {
  if (!DSN) throw new Error('PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  if (/supabase\.co|pooler\.supabase/.test(DSN)) throw new Error('PASS_PROOF_DSN points at Supabase. Refusing to run.');
}

/** one psql statement; ON_ERROR_STOP so a failure is a non-zero exit with the server's message */
export async function exec(sql: string): Promise<{ out: string; err: string | null }> {
  try {
    const r = await execFileAsync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { cwd: REPO_ROOT, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    return { out: r.stdout.trim(), err: null };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    const m = String(x.stderr ?? '').match(/ERROR:\s+([^\n]*)/);
    return { out: String(x.stdout ?? '').trim(), err: m ? m[1].trim() : String(x.stderr ?? 'psql failed').trim() };
  }
}
export function execSync(sql: string): { out: string; err: string | null } {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status === 0) return { out: (r.stdout ?? '').trim(), err: null };
  const m = String(r.stderr ?? '').match(/ERROR:\s+([^\n]*)/);
  return { out: (r.stdout ?? '').trim(), err: m ? m[1].trim() : String(r.stderr ?? 'psql failed').trim() };
}
export function execFileSync(path: string): { out: string; err: string | null } {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', path], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  if (r.status === 0) return { out: (r.stdout ?? '').trim(), err: null };
  const m = String(r.stderr ?? '').match(/ERROR:\s+([^\n]*)/);
  return { out: (r.stdout ?? '').trim(), err: m ? m[1].trim() : String(r.stderr ?? 'psql failed').trim() };
}
/** run, and throw on error — for fixture setup and assertions on counts */
export function must(sql: string): string {
  const r = execSync(sql); if (r.err) throw new Error(`${r.err}\n--- sql: ${sql.slice(0, 300)}`); return r.out;
}
export const scalar = (sql: string) => must(sql).split('\n').pop() ?? '';
export const num = (sql: string) => Number(scalar(sql));

function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.toLowerCase().indexOf(opener.toLowerCase());
  if (start === -1) throw new Error(`${opener} is gone from ${file}`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
function fnSource(file: string, header: string): string {
  const s = src(file); const start = s.toLowerCase().indexOf(header.toLowerCase());
  if (start === -1) throw new Error(`${header} is gone from ${file}`);
  const open = s.slice(start).match(/\$(\w*)\$/)!; const tag = open[0]; const bodyStart = start + open.index! + tag.length;
  const end = s.indexOf(`${tag};`, bodyStart);
  return s.slice(start, end + tag.length + 1).replace(/^create function/i, 'create or replace function');
}

export const IDS = {
  ALICE: 'a1000000-0000-4000-8000-0000000000a1',
  BOB: 'b2000000-0000-4000-8000-0000000000b2',
  OWNER: '0e000000-0000-4000-8000-0000000000e0',
  BIZ: 'bb000000-0000-4000-8000-0000000000bb',
  P_TRACKED: 'f1000000-0000-4000-8000-0000000000f1',   // tracked stock 10
  P_ONEOFF: 'f2000000-0000-4000-8000-0000000000f2',    // a one-off
  P_MADE: 'f3000000-0000-4000-8000-0000000000f3',      // made to order (unlimited)
  P_LOW: 'f4000000-0000-4000-8000-0000000000f4',       // tracked stock 1
  UNIT: 'c1000000-0000-4000-8000-0000000000c1',
  SERVICE: 'c2000000-0000-4000-8000-0000000000c2',
};

/** Production-shaped schema + the migration under test. Call once in `before`. */
export function buildFixture(): void {
  assertIsolated();
  const COMMERCE = join(MIG, '20260801130000_commerce_engine.sql');
  const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
  const STOCK = join(MIG, '20260801140000_product_stock_rpcs.sql');
  const setup = [
    'drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; create schema auth; create table auth.users (id uuid primary key);',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'grant usage on schema public to anon, authenticated, service_role;',
    // stand-ins for the tables the real ones reference (their own behaviour is not under test here)
    'create table public.local_businesses (id uuid primary key, owner_id uuid, name text, is_active boolean default true, accepts_wallet boolean default true, cashback_percent numeric default 0);',
    'create table public.profiles (id uuid primary key, stripe_customer_id text, has_payment_method boolean default false, full_name text);',
    'create table public.business_shipping (business_id uuid primary key, collect_enabled boolean default true, post_enabled boolean default false, fetch_enabled boolean default false, post_uk_pence integer, post_shetland_pence integer, post_per_extra_item_pence integer, free_over_pence integer);',
    'create table public.regions (slug text primary key);',
    'create table public.book_services (id uuid primary key, business_id uuid, name text, price_pence integer, is_active boolean default true);',
    'create table public.book_unit_items (id uuid primary key, business_id uuid, name text, price_pence integer, stock integer, is_active boolean default true);',
    // the real shop tables
    createTable(COMMERCE, 'create table if not exists public.products ('),
    createTable(COMMERCE, 'create table if not exists public.product_variants ('),
    createTable(COMMERCE, 'create table if not exists public.product_orders ('),
    createTable(COMMERCE, 'create table if not exists public.product_order_items ('),
    // columns production's product_orders gained after the commerce-engine migration that the functions under test touch
    `alter table public.product_orders add column if not exists delivery_region_slug text, add column if not exists delivery_request_id uuid;`,
    // the real gift table, as the baseline dump has it
    createTable(BASELINE, 'CREATE TABLE public.book_gifts ('),
    'alter table public.book_gifts add primary key (id);',
    'alter table public.book_gifts add constraint book_gifts_code_key unique (code);',
    // the three stock functions, exactly as production runs them
    fnSource(STOCK, 'create or replace function public.reserve_product_stock('),
    fnSource(STOCK, 'create or replace function public.commit_product_stock('),
    fnSource(STOCK, 'create or replace function public.release_product_stock('),
    // what the handler asks the database about a business (answered by the real functions in production)
    `create function public.business_meets_tier(p_business_id uuid, p_required_tier text) returns boolean language sql as $$ select true $$;`,
    `create function public.business_payout_destination(p_business uuid) returns jsonb language sql as $$ select '[{"account_id":"acct_seller","is_demo":false}]'::jsonb $$;`,
    `create function public.loyalty_award_for_wallet_spend(p_wallet_txn uuid) returns void language sql as $$ select $$;`,
    // production mints an unbiased 14-character code from gen_random_bytes; any unique string serves the tests
    `create function public.generate_gift_code() returns text language sql as $$ select upper(substr(md5(random()::text || clock_timestamp()::text), 1, 14)) $$;`,
    `grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;`,
  ].join('\n');
  must(setup);
  // the migration under test, verbatim
  const r = execFileSync(ATTEMPT_MIGRATION);
  if (r.err) throw new Error(`attempt migration failed: ${r.err}`);
  must(`grant execute on all functions in schema public to service_role;`);
  seed();
}

export function seed(): void {
  const { ALICE, BOB, OWNER, BIZ, P_TRACKED, P_ONEOFF, P_MADE, P_LOW, UNIT, SERVICE } = IDS;
  must(`
    insert into auth.users (id) values ('${ALICE}'), ('${BOB}'), ('${OWNER}');
    insert into public.profiles (id, stripe_customer_id, has_payment_method, full_name) values ('${ALICE}', 'cus_alice', true, 'Alice Buyer'), ('${BOB}', null, false, 'Bob Buyer'), ('${OWNER}', null, false, 'Owner');
    insert into public.local_businesses (id, owner_id, name) values ('${BIZ}', '${OWNER}', 'Test Shop');
    insert into public.products (id, business_id, title, price_pence, stock_mode, stock) values
      ('${P_TRACKED}', '${BIZ}', 'Tracked jumper', 1000, 'tracked', 10),
      ('${P_ONEOFF}',  '${BIZ}', 'One-off print',  2500, 'one_off', null),
      ('${P_MADE}',    '${BIZ}', 'Made to order',  1500, 'made_to_order', null),
      ('${P_LOW}',     '${BIZ}', 'Last one',       1200, 'tracked', 1);
    insert into public.book_unit_items (id, business_id, name, price_pence, stock) values ('${UNIT}', '${BIZ}', 'Ten-visit pass', 3000, 5);
    insert into public.book_services (id, business_id, name, price_pence) values ('${SERVICE}', '${BIZ}', 'Haircut', 4000);
  `);
}

/** wipe every purchase and restore stock, keeping the schema (cheap reset between tests) */
export function resetData(): void {
  must(`
    truncate public.product_order_items, public.product_orders, public.book_gifts restart identity cascade;
    update public.products set reserved = 0, sold_at = null, is_active = true,
           stock = case id when '${IDS.P_TRACKED}' then 10 when '${IDS.P_LOW}' then 1 else stock end;
  `);
}

/* ── a Supabase-compatible client over psql ─────────────────────────────── */

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`bad identifier ${s}`);
  return s;
};
const cols = (c: string) => (c.trim() === '*' ? '*' : c.split(',').map((x) => ident(x.trim())).join(', '));

type Result = { data: any; error: { message: string; code?: string } | null };

class Query implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private selectCols = '*';
  private returning: string | null = null;
  private filters: string[] = [];
  private values: Record<string, unknown>[] = [];
  private patch: Record<string, unknown> = {};
  private lim: number | null = null;
  private orderBy: string | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private table: string;
  private log: (s: string) => void;
  constructor(table: string, log: (s: string) => void) { this.table = table; this.log = log; }

  select(c = '*') { if (this.op === 'select') this.selectCols = c; else this.returning = c; return this; }
  insert(v: Record<string, unknown> | Record<string, unknown>[]) { this.op = 'insert'; this.values = Array.isArray(v) ? v : [v]; return this; }
  update(p: Record<string, unknown>) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c: string, v: unknown) { this.filters.push(v === null ? `${ident(c)} is null` : `${ident(c)} = ${lit(v)}`); return this; }
  neq(c: string, v: unknown) { this.filters.push(`${ident(c)} is distinct from ${lit(v)}`); return this; }
  is(c: string, v: unknown) { this.filters.push(v === null ? `${ident(c)} is null` : `${ident(c)} is ${lit(v)}`); return this; }
  in(c: string, arr: unknown[]) { this.filters.push(arr.length ? `${ident(c)} in (${arr.map(lit).join(', ')})` : 'false'); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === 'in') { const list = String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim()).filter(Boolean); this.filters.push(`${ident(c)} not in (${list.map(lit).join(', ')})`); }
    else if (op === 'is') this.filters.push(`${ident(c)} is not ${v === null ? 'null' : lit(v)}`);
    else throw new Error(`not(${op}) unsupported by the test adapter`);
    return this;
  }
  lt(c: string, v: unknown) { this.filters.push(`${ident(c)} < ${lit(v)}`); return this; }
  order(c: string, o: { ascending?: boolean } = {}) { this.orderBy = `${ident(c)} ${o.ascending === false ? 'desc' : 'asc'}`; return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  private sql(): string {
    const where = this.filters.length ? ` where ${this.filters.join(' and ')}` : '';
    const t = `public.${ident(this.table)}`;
    if (this.op === 'select') return `select ${cols(this.selectCols)} from ${t}${where}${this.orderBy ? ` order by ${this.orderBy}` : ''}${this.lim ? ` limit ${this.lim}` : ''}`;
    const ret = this.returning ? ` returning ${cols(this.returning)}` : '';
    if (this.op === 'insert') {
      const keys = [...new Set(this.values.flatMap((v) => Object.keys(v)))];
      return `insert into ${t} (${keys.map(ident).join(', ')}) values ${this.values.map((v) => `(${keys.map((k) => lit(v[k])).join(', ')})`).join(', ')}${ret}`;
    }
    if (this.op === 'update') return `update ${t} set ${Object.entries(this.patch).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(', ')}${where}${ret}`;
    return `delete from ${t}${where}${ret}`;
  }

  async run(): Promise<Result> {
    const inner = this.sql();
    const wantsRows = this.op === 'select' || this.returning !== null;
    const sql = wantsRows ? `select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)::text from (${inner}) q` : inner;
    this.log(`${this.op} ${this.table}`);
    // Data-modifying statements cannot sit inside a subquery in a FROM clause, so wrap them in a CTE.
    const finalSql = wantsRows && this.op !== 'select'
      ? `with q as (${inner}) select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)::text from q`
      : sql;
    const r = await exec(finalSql);
    if (r.err) return { data: null, error: { message: r.err } };
    if (!wantsRows) return { data: null, error: null };
    const rows = JSON.parse(r.out || '[]') as any[];
    if (this.mode === 'many') return { data: rows, error: null };
    if (this.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: rows.length ? 'multiple rows' : 'no rows', code: 'PGRST116' } };
    if (rows.length > 1) return { data: null, error: { message: 'multiple rows' } };
    return { data: rows[0] ?? null, error: null };
  }
  then<R1 = Result, R2 = never>(ok?: ((v: Result) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) {
    return this.run().then(ok, bad);
  }
}

export interface PgClient {
  from(table: string): Query;
  rpc(name: string, args?: Record<string, unknown>): Promise<Result>;
  /** every operation the handler performed, in order — "rpc claim_product_order", "update product_orders"… */
  readonly log: string[];
  /** hooks a test can set to simulate a crash / lost response at a named point */
  hooks: Record<string, () => void | Promise<void>>;
}

export function pgClient(): PgClient {
  const log: string[] = [];
  const hooks: Record<string, () => void | Promise<void>> = {};
  return {
    log, hooks,
    from: (table: string) => new Query(table, (s) => log.push(s)),
    async rpc(name: string, args: Record<string, unknown> = {}) {
      log.push(`rpc ${name}`);
      if (hooks[`before:${name}`]) await hooks[`before:${name}`]();
      const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ');
      const r = await exec(`select public.${ident(name)}(${named})::text`);
      if (r.err) return { data: null, error: { message: r.err } };
      if (hooks[`after:${name}`]) await hooks[`after:${name}`]();
      const out = r.out;
      if (out === '') return { data: null, error: null };
      if (out === 't') return { data: true, error: null };
      if (out === 'f') return { data: false, error: null };
      try { return { data: JSON.parse(out), error: null }; } catch { return { data: out, error: null }; }
    },
  };
}
