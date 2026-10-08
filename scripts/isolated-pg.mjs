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
  'supabase/tests/my-unclaimed-gifts.node.test.ts',
  'supabase/tests/gift-claim-concurrency.node.test.ts',
  'supabase/tests/gift-funded-booking-status-sync.node.test.ts',
  'supabase/tests/wallet-reversal-integrity.node.test.ts',
  'supabase/tests/loyalty-redemption-atomicity.node.test.ts',
  'supabase/tests/loyalty-earning-atomicity.node.test.ts',
  'supabase/tests/wallet-loyalty-points.node.test.ts',
  'supabase/tests/business-wallet-refunds.node.test.ts',
  'supabase/tests/wallet-concurrency.node.test.ts',
  'supabase/tests/production-concurrency-proofs.node.test.ts',
  'supabase/tests/statement-refund-accounting.node.test.ts',
  'supabase/tests/redemption-business-scope.node.test.ts',
  'supabase/tests/wallet-charge-cancel-concurrency.node.test.ts',
  'supabase/tests/wallet-liquidity-concurrency.node.test.ts',
  'supabase/tests/product-order-immutability.node.test.ts',
  'supabase/tests/pass-immutability.node.test.ts',
  'supabase/tests/event-orders-access.node.test.ts',
  'supabase/tests/event-wallet-refund.node.test.ts',
  'supabase/tests/ticket-capacity-release.node.test.ts',
  'supabase/tests/notification-centre-sql.node.test.ts',
  'supabase/tests/business-claims-flow.node.test.ts',
  'supabase/tests/email-tables-lockdown.node.test.ts',
  'supabase/tests/event-ticket-orders-server-only.node.test.ts',
  'supabase/tests/hub-members-server-authoritative.node.test.ts',
  'supabase/tests/payment-abuse-limits.node.test.ts',
  'supabase/tests/wallet-card-cashout.node.test.ts',
  'supabase/tests/launch-plan-grants.node.test.ts',
  'supabase/tests/discovery-fixtures-locality.node.test.ts',
  'supabase/tests/product-import-foundation.node.test.ts',
  'supabase/tests/launch-partner-claims.node.test.ts',
  'supabase/tests/launch-partner-campaigns.node.test.ts',
  'supabase/tests/launch-partner-profile-versions.node.test.ts',
  'supabase/tests/launch-partner-email-opening.node.test.ts',
  'supabase/tests/launch-partner-send-claim.node.test.ts',
  'supabase/tests/launch-partner-enrichment.node.test.ts',
  'supabase/tests/launch-partner-go-live.node.test.ts',
  'supabase/tests/launch-partner-takedown.node.test.ts',
  'supabase/tests/launch-outreach-suppression.node.test.ts',
  'supabase/tests/launch-invite-lifecycle.node.test.ts',
  'supabase/tests/purchase-attempt-idempotency.node.test.ts',
  'supabase/tests/purchase-attempt-handlers.node.test.ts',
  'supabase/tests/purchase-attempt-baseline.node.test.ts',
  'supabase/tests/event-notice-attribution.node.test.ts',
  'supabase/tests/stripe-customer-exposure.node.test.ts',
  'supabase/tests/shift-profile-trust-fields.node.test.ts',
];

// ISOLATED_ONLY=<substring> runs just the matching suites while iterating on one.
const selected = process.env.ISOLATED_ONLY ? SUITES.filter((s) => s.includes(process.env.ISOLATED_ONLY)) : SUITES;

// An empty list must NEVER reach `node --test`: with no file arguments it discovers every *.test.ts under the working directory,
// including the suites that read and WRITE the live production project (see package.json test:fixtures). A typo in ISOLATED_ONLY
// or an unregistered suite would otherwise run them.
if (selected.length === 0) {
  console.error(`[isolated-pg] no registered suite matches ISOLATED_ONLY=${JSON.stringify(process.env.ISOLATED_ONLY ?? '')}; refusing to start (an empty list would run every test file).`);
  process.exit(2);
}

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

  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selected], {
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
