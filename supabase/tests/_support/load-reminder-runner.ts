/**
 * load-reminder-runner.ts — runs the REAL supabase/functions/reminder-runner/index.ts together with the REAL _shared/send-push.ts, cron-auth.ts and safe-error.ts
 * in Node. Only three seams are replaced: the Deno `serve` import (captures the handler), the supabase-js import (hands back an in-memory database) and the Expo
 * endpoint (mockExpo). The in-memory database implements just the PostgREST query shapes the runner uses; should_notify is scripted per user with the same
 * semantics as the production function (no row = true, opt-out = false, quiet hours = false unless urgent, outage = error).
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const FN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'functions');
type Row = Record<string, any>;
export type Mode = 'allow' | 'missing' | 'optout' | 'quiet' | 'error' | 'throw';


// ── the REAL database ledger (reminder_deliveries) in the ISOLATED Postgres ──────────────────────────────────────────────────────────────────────────────
// The runner's domain tables stay in memory, but every reminder_* call goes to a real Postgres through psql, so the claim's atomicity is PostgreSQL's own.
// Names ('u1', 'h2') stand in for user ids: they map to fixed uuids here and back again in results. The controlled clock (Date, mocked by the test) is passed as p_now.
const pexec = promisify(execFile);
const DSN = process.env.PASS_PROOF_DSN ?? '', PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const ids = new Map<string, string>(), names = new Map<string, string>();
export const uuidOf = (n: string) => { if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(n)) return n; let u = ids.get(n);
  if (!u) { const h = createHash('md5').update(`reminder-test:${n}`).digest('hex'); u = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; ids.set(n, u); names.set(u, n); } return u; };
export const nameOf = (u: string) => names.get(u) ?? u;
const q = (v: unknown) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const KIND: Record<string, string> = { p_users: 'uuid[]', p_results: 'jsonb', p_deadline: 'timestamptz', p_reuse_after: 'interval', p_older_than: 'interval', p_token: 'uuid', p_user: 'uuid' };
const lit = (k: string, v: unknown): string => {
  if (k === 'p_users') return `array[${(v as string[]).map((x) => q(uuidOf(x))).join(',')}]::uuid[]`;
  if (k === 'p_results') return `${q(JSON.stringify((v as any[]).map((r) => ({ ...r, user: uuidOf(r.user) }))))}::jsonb`;
  if (k === 'p_user') return `${q(uuidOf(v as string))}::uuid`;
  if (typeof v === 'number') return String(v);
  return v === null || v === undefined ? 'null' : `${q(v)}${KIND[k] ? `::${KIND[k]}` : ''}`;
};
export const psql = async (sql: string) => (await pexec(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
export const ledgerRows = async (where = 'true') => (JSON.parse(await psql(`select coalesce(jsonb_agg(to_jsonb(t) order by family, subject_id, user_id), '[]') from reminder_deliveries t where ${where}`)) as Record<string, any>[]).map((r) => ({ ...r, user: nameOf(r.user_id) }));
export async function resetLedgerDb() {
  if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only): run via `npm run test:isolated`');
  if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');
  await psql(`drop schema if exists public cascade; create schema public; do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;`);
  const out = await pexec(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(FN, '..', 'migrations', '20261129090000_reminder_delivery_ledger.sql')]);
  await psql('grant usage on schema public to anon, authenticated, service_role');   // as on Supabase: the schema is reachable, so the TABLE and FUNCTION privileges are what is under test
  return out.stderr;
}
export const clearLedger = () => psql('truncate reminder_deliveries');
async function ledgerRpc(fn: string, args: Record<string, unknown>, nowIso: string, hooks: Hooks) {
  try {
    if (hooks.before?.[fn]) await hooks.before[fn](args);
    const named = Object.entries({ ...args, p_now: nowIso }).map(([k, v]) => `${k} => ${k === 'p_now' ? `${q(v)}::timestamptz` : lit(k, v)}`).join(', ');
    const set = fn === 'reminder_claim_many';
    const raw = await psql(set ? `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.${fn}(${named}) t` : `select to_jsonb(public.${fn}(${named}))`);
    let data = JSON.parse(raw || 'null'); if (set) data = data.map((r: any) => ({ ...r, r_user: nameOf(r.r_user) }));
    if (hooks.after?.[fn]) await hooks.after[fn](args, data);
    return { data, error: null };
  } catch (e) { if ((e as Error).message?.startsWith('CRASH')) throw e; return { data: null, error: { message: String((e as any).stderr ?? (e as Error).message).slice(0, 300) } }; }
}
export interface Hooks { before?: Record<string, (args: any) => Promise<void>>; after?: Record<string, (args: any, data: any) => Promise<void>> }

export function makeDb() {
  const tables: Record<string, Row[]> = {};
  const modes = new Map<string, Mode>();
  const calls = { should_notify: [] as { user: string; urgent: boolean; mode: Mode }[], rpc: [] as string[], invoke: [] as string[], rpcArgs: [] as { fn: string; args: any }[] };
  const hooks: Hooks = {};   // fault injection for the ledger: a hook that throws Error('CRASH ...') kills the whole runner pass at that point, like a dead worker
  const rpcHandlers: Record<string, (args: any) => { data: unknown; error: unknown }> = {};   // scripted database functions (dispatch machinery)
  const table = (t: string) => (tables[t] ??= []);
  const cmp = (a: any, b: any) => (a === null || a === undefined ? false : a);
  const builder = (t: string) => {
    let mode: 'select' | 'update' | 'upsert' | 'delete' = 'select'; let patch: Row = {}; let head = false; let wantCount = false; let lim = Infinity; let range: [number, number] | null = null;
    const preds: ((r: Row) => boolean)[] = []; let ret: Row[] | null = null; let upsertRow: Row | null = null; let onConflict = '';
    const rows = () => table(t).filter((r) => preds.every((p) => p(r)));
    const exec = () => {
      if (mode === 'upsert') { const key = upsertRow![onConflict]; const ex = table(t).find((r) => r[onConflict] === key); if (ex) Object.assign(ex, upsertRow); else table(t).push({ ...upsertRow }); return { data: null, error: null }; }
      if (mode === 'update') { ret = rows(); for (const r of ret) Object.assign(r, patch); return { data: ret.map((r) => ({ ...r })), error: null }; }
      if (mode === 'delete') { const m = new Set(rows()); tables[t] = table(t).filter((r) => !m.has(r)); return { data: null, error: null }; }
      let out = rows(); if (range) out = out.slice(range[0], range[1] + 1); out = out.slice(0, lim);
      return head ? { data: null, count: rows().length, error: null } : { data: out.map((r) => ({ ...r })), count: wantCount ? out.length : undefined, error: null };
    };
    const b: any = {
      select: (_c?: string, o?: { count?: string; head?: boolean }) => { if (o?.head) head = true; if (o?.count) wantCount = true; return b; },
      update: (p: Row) => { mode = 'update'; patch = p; return b; }, delete: () => { mode = 'delete'; return b; },
      upsert: (row: Row, o: { onConflict: string }) => { mode = 'upsert'; upsertRow = row; onConflict = o.onConflict; return b; },
      insert: (row: Row) => { table(t).push({ ...row }); return Promise.resolve({ error: null }); },
      eq: (c: string, v: any) => (preds.push((r) => r[c] === v), b), neq: (c: string, v: any) => (preds.push((r) => r[c] !== v), b),
      is: (c: string, v: any) => (preds.push((r) => (v === null ? r[c] == null : r[c] === v)), b),
      not: (c: string, op: string, v: any) => (preds.push((r) => (op === 'is' && v === null ? r[c] != null : true)), b),
      gt: (c: string, v: any) => (preds.push((r) => cmp(r[c], v) !== false && r[c] > v), b), lt: (c: string, v: any) => (preds.push((r) => r[c] != null && r[c] < v), b),
      lte: (c: string, v: any) => (preds.push((r) => r[c] != null && r[c] <= v), b), gte: (c: string, v: any) => (preds.push((r) => r[c] != null && r[c] >= v), b),
      in: (c: string, v: any[]) => (preds.push((r) => v.includes(r[c])), b), order: () => b, limit: (n: number) => ((lim = n), b), range: (a: number, z: number) => ((range = [a, z]), b),
      maybeSingle: () => { const r = exec(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }); },
      then: (res: any, rej: any) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  };
  const client: any = {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: any) => {
      calls.rpc.push(fn); calls.rpcArgs.push({ fn, args });
      if (fn.startsWith('reminder_')) return ledgerRpc(fn, args, new Date().toISOString(), hooks);
      if (rpcHandlers[fn]) return Promise.resolve(rpcHandlers[fn](args));
      if (fn !== 'should_notify') return Promise.resolve({ data: null, error: null });
      const m = modes.get(args.p_user_id) ?? 'allow'; calls.should_notify.push({ user: args.p_user_id, urgent: !!args.p_urgent, mode: m });
      if (m === 'throw') return Promise.reject(new Error('connection reset'));
      if (m === 'error') return Promise.resolve({ data: null, error: { message: 'statement timeout' } });
      if (m === 'optout') return Promise.resolve({ data: false, error: null });
      if (m === 'quiet') return Promise.resolve({ data: !!args.p_urgent, error: null });
      return Promise.resolve({ data: true, error: null });   // allow, or no preferences row (production default)
    },
    functions: { invoke: (n: string) => { calls.invoke.push(n); return Promise.resolve({ data: { units: 0 }, error: null }); } },
  };
  return { tables, table, modes, calls, client, rpcHandlers, hooks, setMode: (u: string, m: Mode) => modes.set(u, m) };
}

export async function loadReminderRunner() {
  const dir = mkdtempSync(join(tmpdir(), 'reminder-runner-'));
  mkdirSync(join(dir, '_shared')); mkdirSync(join(dir, 'reminder-runner'));
  writeFileSync(join(dir, 'serve-stub.mjs'), `export const serve = (h) => { globalThis.__runnerHandler = h; };`);
  writeFileSync(join(dir, 'supa-stub.mjs'), `export const createClient = () => globalThis.__fakeDb; export class SupabaseClient {}`);
  for (const f of readdirSync(join(FN, '_shared')).filter((x) => /^(send-push|cron-auth|safe-error)\.ts$/.test(x)))
    writeFileSync(join(dir, '_shared', f), readFileSync(join(FN, '_shared', f), 'utf8').replace("'https://esm.sh/@supabase/supabase-js@2'", "'../supa-stub.mjs'"));
  const idx = readFileSync(process.env.REMINDER_RUNNER_SOURCE ?? join(FN, 'reminder-runner', 'index.ts'), 'utf8').replace("'https://deno.land/std@0.168.0/http/server.ts'", "'../serve-stub.mjs'");
  if (/from 'https?:/.test(idx)) throw new Error('unreplaced remote import in reminder-runner');
  writeFileSync(join(dir, 'reminder-runner', 'index.ts'), idx);
  const env: Record<string, string> = { CRON_SECRET: 'test-cron-secret', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'test-key' };
  (globalThis as any).Deno = { env: { get: (k: string) => env[k] } };
  await import(pathToFileURL(join(dir, 'reminder-runner', 'index.ts')).href);
  const sp = await import(pathToFileURL(join(dir, '_shared', 'send-push.ts')).href);
  const handler = (globalThis as any).__runnerHandler as (r: Request) => Promise<Response>;
  return {
    sendPush: sp as typeof import('../../functions/_shared/send-push.ts'),
    run: async (db: ReturnType<typeof makeDb>) => { (globalThis as any).__fakeDb = db.client;
      const res = await handler(new Request('http://127.0.0.1/reminder-runner', { method: 'POST', headers: { 'x-cron-secret': 'test-cron-secret' } }));
      return { status: res.status, json: (await res.json()) as Record<string, any> }; },
    runUnauthorised: async () => (await handler(new Request('http://127.0.0.1/reminder-runner', { method: 'POST' }))).status,
  };
}

/**
 * loadFunction — the same technique for any Edge Function whose only remote imports are `serve` and supabase-js: the REAL handler, REAL _shared code (incl. the real
 * sender), in-memory database, mock Expo. Auth is the function's own: tests call with the service-role bearer (a trusted backend caller).
 */
export async function loadFunction(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `fn-${name}-`));
  mkdirSync(join(dir, '_shared')); mkdirSync(join(dir, name));
  writeFileSync(join(dir, 'serve-stub.mjs'), `export const serve = (h) => { globalThis.__fnHandler = h; };`);
  writeFileSync(join(dir, 'supa-stub.mjs'), `export const createClient = () => globalThis.__fakeDb; export class SupabaseClient {}`);
  const fix = (src: string, rel: string) => src.replace(/'https:\/\/esm\.sh\/@supabase\/supabase-js@2'/g, `'${rel}supa-stub.mjs'`).replace(/'https:\/\/deno\.land\/std@0\.168\.0\/http\/server\.ts'/g, `'${rel}serve-stub.mjs'`);
  const shared = readdirSync(join(FN, '_shared')).filter((x) => x.endsWith('.ts'));
  const typeNames = new Set<string>();   // Node strips types but cannot know an un-annotated import is type-only: mark those imports `type`
  for (const f of shared) for (const m of readFileSync(join(FN, '_shared', f), 'utf8').matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) typeNames.add(m[1]);
  const typed = (src: string) => src.replace(/import\s*\{([^}]*)\}\s*from/g, (_m, names: string) => `import {${names.split(',').map((n) => { const t = n.trim(); return t && !t.startsWith('type ') && typeNames.has(t.split(/\s+as\s+/)[0]) ? ` type ${t}` : n; }).join(',')}} from`);
  for (const f of shared) writeFileSync(join(dir, '_shared', f), typed(fix(readFileSync(join(FN, '_shared', f), 'utf8'), '../')));
  const src = typed(fix(readFileSync(join(FN, name, 'index.ts'), 'utf8'), '../'));
  if (/from 'https?:/.test(src)) throw new Error(`unreplaced remote import in ${name}`);
  writeFileSync(join(dir, name, 'index.ts'), src);
  const env: Record<string, string> = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-tests', CRON_SECRET: 'test-cron-secret' };
  (globalThis as any).Deno = { env: { get: (k: string) => env[k] } };
  await import(pathToFileURL(join(dir, name, 'index.ts')).href);
  const handler = (globalThis as any).__fnHandler as (r: Request) => Promise<Response>;
  const sp = await import(pathToFileURL(join(dir, '_shared', 'send-push.ts')).href) as typeof import('../../functions/_shared/send-push.ts');
  return {
    sendPush: sp,
    call: async (db: ReturnType<typeof makeDb>, body: unknown) => { (globalThis as any).__fakeDb = db.client;
      const res = await handler(new Request(`http://127.0.0.1/${name}`, { method: 'POST', headers: { Authorization: 'Bearer service-key-for-tests', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      return { status: res.status, json: (await res.json()) as Record<string, any> }; },
  };
}
