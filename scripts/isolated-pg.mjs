#!/usr/bin/env node
/**
 * isolated-pg.mjs — a throwaway PostgreSQL for proofs that must not touch
 * production.
 *
 * Some invariants can only be proved by two connections fighting over one row,
 * and a rolled-back transaction is invisible to the other connection. The
 * booking capacity guard was proved that way before it was allowed near
 * production; this does the same for pass redemption, without a disposable
 * fixture in a live database.
 *
 * Creates a cluster under the OS temp directory, listening on a unix socket
 * inside its own data directory — no TCP port, so it cannot collide with a
 * developer's own Postgres and nothing outside this process can reach it. The
 * cluster is destroyed in a finally, including on Ctrl-C.
 *
 * Usage: npm run test:isolated
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PG_HOME = '/opt/homebrew/opt/postgresql@17';   // production is 17.x
const bin = (n) => (existsSync(join(PG_HOME, 'bin', n)) ? join(PG_HOME, 'bin', n) : n);

const SUITES = [
  'supabase/tests/pass-redemption-concurrency.node.test.ts',
  'supabase/tests/hub-column-privacy.node.test.ts',
  'supabase/tests/hub-member-number-concurrency.node.test.ts',
];

// macOS ships a locale that makes the postmaster multithread during startup
// ("postmaster became multithreaded during startup"), so pin a plain one for
// the cluster's own processes. The path also stays in the OS temp directory
// rather than anywhere longer: a unix socket path may not exceed 103 bytes.
const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

const dataDir = mkdtempSync(join(tmpdir(), 'oneshetland-proof-'));
let started = false;

const stop = () => {
  try { if (started) execFileSync(bin('pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore', env: PG_ENV }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
};
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('SIGTERM', () => { stop(); process.exit(143); });

let code = 1;
try {
  console.log(`[isolated-pg] ${execFileSync(bin('postgres'), ['--version'], { encoding: 'utf8' }).trim()}`);
  execFileSync(bin('initdb'), ['-D', dataDir, '-U', 'proof', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore', env: PG_ENV });
  // Unix socket only: listen_addresses empty means no TCP listener at all.
  execFileSync(bin('pg_ctl'),
    ['-D', dataDir, '-o', `-k ${dataDir} -c listen_addresses=''`, '-w', '-l', join(dataDir, 'server.log'), 'start'],
    { stdio: 'ignore', env: PG_ENV });
  started = true;
  execFileSync(bin('createdb'), ['-h', dataDir, '-U', 'proof', 'proof'], { stdio: 'ignore', env: PG_ENV });

  const dsn = `postgresql://proof@/proof?host=${dataDir}`;
  console.log('[isolated-pg] cluster up, running isolated suites\n');

  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...SUITES], {
    stdio: 'inherit',
    env: { ...process.env, PASS_PROOF_DSN: dsn, PASS_PROOF_PSQL: bin('psql') },
  });
  code = r.status ?? 1;
} catch (e) {
  console.error('[isolated-pg] failed to provision:', e.message);
  try { console.error(readFileSync(join(dataDir, 'server.log'), 'utf8').split('\n').slice(-8).join('\n')); } catch {}
  code = 1;
} finally {
  stop();
  console.log('\n[isolated-pg] cluster destroyed');
}
process.exit(code);
