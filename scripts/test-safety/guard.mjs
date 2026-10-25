/**
 * scripts/test-safety/guard.mjs — the hard test guard (Fetch v2, Step 13). Loaded into EVERY test process by the lane runner through
 * NODE_OPTIONS=--import, so it is in place before any test file runs, and it re-arms itself in every child process those tests start.
 *
 * Why: in Step 12 an "offline" run of the app suites queried the production database, because a fresh worktree carries the tracked
 * supabase/.temp/project-ref and 86 suites shell out to `supabase db query --linked`. Nothing in the test setup stopped that.
 *
 * Lanes (ONESHETLAND_TEST_LANE):
 *   offline (default)        nothing leaves this machine: only localhost/unix sockets; no hosted Supabase, Stripe, Expo, Google, website;
 *                            no Supabase CLI against the linked project; no psql/curl to live hosts; no EAS/Expo publishing.
 *   isolated                 the same, for suites that use a throwaway local Postgres (scripts/isolated-pg.mjs).
 *   production-readonly      only via `npm run test:integration:production-readonly` with ONESHETLAND_PRODUCTION_READONLY set by that
 *                            runner after an explicit opt-in. Allows exactly two things: `supabase db query --linked` whose SQL is a plain
 *                            read (and the session is forced read-only by Postgres itself), and GET/HEAD to the production REST API.
 *                            Stripe, Expo, Google and the website stay blocked. Nothing is ever written.
 *
 * At start-up it refuses (exit 78) an environment that points at production or carries live credentials, unless the lane is the
 * opt-in read-only one. Every blocked attempt is printed and appended to ONESHETLAND_TEST_BLOCK_LOG so the runner can say which suite tried.
 */
import net from 'node:net';
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { childProcessRisk, isLocalHost, isProductionHost, liveService, productionFindings, sqlWriteReason } from './production.mjs';

const SELF = fileURLToPath(import.meta.url);
const LANE = process.env.ONESHETLAND_TEST_LANE || 'offline';
const PROD_OK = LANE === 'production-readonly' && process.env.ONESHETLAND_PRODUCTION_READONLY === 'yes-read-only-production';
const who = () => (process.argv.find((a) => /\.test\.(ts|mjs|js)$/.test(a)) ?? process.argv[1] ?? 'unknown').replace(/^.*supabase\/tests\//, 'supabase/tests/');

export class BlockedByTestGuard extends Error {
  constructor(what) {
    super(`[test-safety] BLOCKED (${LANE} lane): ${what}. Tests must not reach live services. See scripts/test-safety/README.md.`);
    this.name = 'BlockedByTestGuard';
    this.code = 'ONESHETLAND_TEST_GUARD';
  }
}
function block(what) {
  const err = new BlockedByTestGuard(what);
  try { process.stderr.write(`${err.message}  [${who()}]\n`); } catch { /* ignore */ }
  if (process.env.ONESHETLAND_TEST_BLOCK_LOG) { try { appendFileSync(process.env.ONESHETLAND_TEST_BLOCK_LOG, `${who()}\t${what}\n`); } catch { /* ignore */ } }
  return err;
}

// ── 1. refuse a production-pointing environment before anything runs ───────────────────────────────────────────────────────────
if (!PROD_OK) {
  const findings = productionFindings(process.env);
  if (findings.length) {
    process.stderr.write(`\n[test-safety] REFUSING TO RUN (${LANE} lane): this environment points at production or holds live credentials:\n`
      + findings.map((f) => `  - ${f}\n`).join('')
      + '  Run tests through `npm test` (it builds a clean environment), or unset these.\n\n');
    process.exit(78);
  }
}

// ── 2. sockets: everything (http, https, fetch/undici, tls, pg) goes through net.Socket.prototype.connect ─────────────────────────
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const o = args[0];
  const opts = typeof o === 'object' && o !== null ? (Array.isArray(o) ? o[0] : o) : null;
  const path = opts?.path ?? (typeof o === 'string' && isNaN(Number(o)) ? o : null);
  if (!path) {
    const host = opts ? (opts.host ?? opts.hostname ?? 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
    const port = opts ? opts.port : o;
    if (!isLocalHost(host) && !(PROD_OK && isProductionHost(host))) {
      throw block(`a network connection to ${host}:${port} (${liveService(host) ?? 'an external host'})`);
    }
  }
  return origConnect.apply(this, args);
};

// ── 3. fetch: say clearly what was refused, before undici tries ───────────────────────────────────────────────────────────────
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://localhost');
    const method = String(init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    if (!isLocalHost(url.hostname)) {
      const readOk = PROD_OK && isProductionHost(url.hostname) && (method === 'GET' || method === 'HEAD') && /^\/rest\/v1\//.test(url.pathname);
      if (!readOk) throw block(`${method} ${url.protocol}//${url.hostname}${url.pathname} (${liveService(url.hostname) ?? 'an external host'})`);
    }
    return origFetch(input, init);
  };
}

// ── 4. child processes: the Supabase CLI, psql, curl, EAS — and carry the guard into every child ──────────────────────────────
const READ_ONLY_PREFIX = 'set default_transaction_read_only = on;\n';
function sqlIndex(args) {
  const q = args.indexOf('query');
  let best = -1;
  for (let i = q + 1; i < args.length; i++) {
    const a = String(args[i]);
    if (a.startsWith('-') || ['json', 'table', 'csv', 'pretty'].includes(a) || ['--output-format', '-o'].includes(String(args[i - 1]))) continue;
    if (best < 0 || a.length > String(args[best]).length) best = i;
  }
  return best;
}
function vet(cmd, args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const risk = childProcessRisk(cmd, list);
  if (!risk) return list;
  // The single permitted remote action: a plain read through `supabase db query --linked`, in the opt-in read-only lane.
  const isQuery = list.includes('db') && list.includes('query') && list.includes('--linked');
  if (PROD_OK && isQuery) {
    const i = sqlIndex(list);
    const why = i < 0 ? 'no SQL found' : sqlWriteReason(list[i]);
    if (why) throw block(`a production query that is not a plain read (${why})`);
    const out = [...list]; out[i] = READ_ONLY_PREFIX + out[i]; return out;
  }
  throw block(risk);
}
const GUARD_IMPORT = `--import=${SELF}`;
function withGuardEnv(options) {
  const env = { ...(options?.env ?? process.env) };
  if (!String(env.NODE_OPTIONS ?? '').includes(SELF)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} ${GUARD_IMPORT}`.trim();
  for (const k of ['ONESHETLAND_TEST_LANE', 'ONESHETLAND_PRODUCTION_READONLY', 'ONESHETLAND_TEST_BLOCK_LOG']) if (process.env[k] !== undefined && env[k] === undefined) env[k] = process.env[k];
  return { ...(options ?? {}), env };
}
function splitCommand(command) { return String(command).match(/"[^"]*"|'[^']*'|\S+/g)?.map((s) => s.replace(/^['"]|['"]$/g, '')) ?? []; }

/** Normalise child_process call arguments: (cmd, [args], [options], [callback]) → vetted args and a guarded options object. */
function prepareFile(cmd, args, options, rest) {
  if (!Array.isArray(args)) { if (args !== undefined) rest.unshift(options); options = args; args = []; }
  if (typeof options === 'function') { rest.unshift(options); options = undefined; }
  return [cmd, vet(cmd, args), withGuardEnv(options && typeof options === 'object' ? options : undefined), ...rest.filter((r) => r !== undefined)];
}
function prepareShell(command, options, rest) {
  const [cmd, ...args] = splitCommand(command);
  vet(cmd, args); // a shell string is refused outright if risky; the read-only rewrite only applies to the array forms
  if (typeof options === 'function') { rest.unshift(options); options = undefined; }
  return [command, withGuardEnv(options && typeof options === 'object' ? options : undefined), ...rest.filter((r) => r !== undefined)];
}
const CUSTOM = promisify.custom;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const orig = childProcess[name];
  const guarded = function guarded(cmd, args, options, ...rest) { return orig.apply(this, prepareFile(cmd, args, options, rest)); };
  // exec/execFile carry a custom promisified form ({ stdout, stderr }); keep it, guarded.
  if (orig[CUSTOM]) guarded[CUSTOM] = (cmd, args, options, ...rest) => orig[CUSTOM](...prepareFile(cmd, args, options, rest));
  childProcess[name] = guarded;
}
for (const name of ['exec', 'execSync']) {
  const orig = childProcess[name];
  const guarded = function guarded(command, options, ...rest) { return orig.apply(this, prepareShell(command, options, rest)); };
  if (orig[CUSTOM]) guarded[CUSTOM] = (command, options, ...rest) => orig[CUSTOM](...prepareShell(command, options, rest));
  childProcess[name] = guarded;
}
{
  const orig = childProcess.fork;
  childProcess.fork = function guardedFork(modulePath, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    return orig.call(this, modulePath, args, withGuardEnv(options));
  };
}

// Named ESM imports of node:child_process / node:net (`import { execFileSync } from …`) only see the patched functions after this.
syncBuiltinESMExports();

// Keep the guard in this process's own env, so `{ ...process.env }` copies made by tests carry it too.
if (!String(process.env.NODE_OPTIONS ?? '').includes(SELF)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${GUARD_IMPORT}`.trim();
process.env.ONESHETLAND_TEST_LANE = LANE;
