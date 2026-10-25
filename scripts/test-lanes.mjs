#!/usr/bin/env node
/**
 * scripts/test-lanes.mjs — the test lanes (Fetch v2, Step 13). Lane membership lives in supabase/tests/lanes.json; the guard that keeps
 * every lane honest is scripts/test-safety/guard.mjs. See supabase/tests/README.md.
 *
 *   node scripts/test-lanes.mjs offline               `npm test` — the safe default. Nothing leaves this machine.
 *   node scripts/test-lanes.mjs production-readonly   `npm run test:integration:production-readonly` — explicit opt-in, read-only.
 *   node scripts/test-lanes.mjs quarantined           lists the write-capable production suites; never runs them.
 *
 * The offline lane:
 *   - starts tests in a CLEAN environment built here (an allow-list of harmless variables), not the developer's shell, so a fresh
 *     worktree or a dirty shell cannot hand a test production credentials;
 *   - loads the guard into every test process and every child they start (NODE_OPTIONS=--import), which refuses any socket, fetch or
 *     child process that would reach a live service, before it connects;
 *   - reports, separately: what passed; failures already present on the untouched base commit (lanes.json `base`; supabase/tests/baseline/offline.json);
 *     NEW failures (the only ones that fail the run); anything the guard blocked; and the suites deliberately not run here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionFindings, mentionsProduction, liveCredential } from './test-safety/production.mjs';
import { cleanEnv } from './test-safety/env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANES = JSON.parse(readFileSync(join(ROOT, 'supabase/tests/lanes.json'), 'utf8'));
const BASELINE_FILE = join(ROOT, 'supabase/tests/baseline/offline.json');
const BASE = LANES.base; // the commit this branch grew from: its failures are pre-existing
const lane = process.argv[2] ?? 'offline';
const only = process.env.LANE_ONLY; // run a subset while iterating: LANE_ONLY=<substring>
const OPT_IN = 'ONESHETLAND_ALLOW_PRODUCTION_READS';

const bar = (t) => `\n${'═'.repeat(8)} ${t} ${'═'.repeat(Math.max(4, 100 - t.length))}`;

/** Production configuration sitting in files a careless test could read. Reported (never echoed); the offline lane does not load them. */
function filesPointingAtProduction() {
  const found = [];
  for (const f of ['.env', '.env.local', '.env.development', '.env.test', 'supabase/.temp/project-ref', 'supabase/.temp/pooler-url', 'service_key.txt', 'supabase/service_key.txt']) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const s = readFileSync(p, 'utf8');
    if (mentionsProduction(s) || liveCredential(s) || /service_key/.test(f)) found.push(f);
  }
  return found;
}

function junitResults(xml) {
  const out = [];
  const re = /<testcase name="([^"]*)"[^>]*?file="([^"]*)"([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const body = m[5] ?? '';
    const status = /<failure/.test(body) || /failure="/.test(m[3]) ? 'fail' : /<skipped/.test(body) ? 'skip' : 'pass';
    out.push({ key: `${relative(ROOT, m[2])} :: ${decode(m[1])}`, status });
  }
  return out;
}
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function run(laneName, files, extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'oneshetland-lane-'));
  const junit = join(dir, 'junit.xml'), blockLog = join(dir, 'blocked.tsv');
  writeFileSync(blockLog, '');
  const env = cleanEnv(laneName, { ONESHETLAND_TEST_BLOCK_LOG: blockLog, ...extraEnv });
  // A last check on what we are about to hand the tests, beyond the allow-list (belt and braces).
  const bad = productionFindings(env);
  if (bad.length && laneName !== 'production-readonly') { console.error(`[test-lanes] refusing: the clean environment still has ${bad.join('; ')}`); process.exit(78); }
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=junit', `--test-reporter-destination=${junit}`, ...files], { cwd: ROOT, stdio: 'inherit', env });
  const results = existsSync(junit) ? junitResults(readFileSync(junit, 'utf8')) : [];
  const blocked = readFileSync(blockLog, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, results, blocked };
}

function present(list) { const missing = list.filter((f) => !existsSync(join(ROOT, f))); return { files: list.filter((f) => existsSync(join(ROOT, f))), missing }; }

if (lane === 'offline') {
  const { files, missing } = present(LANES.offline.filter((f) => !only || f.includes(only)));
  const prodFiles = filesPointingAtProduction();
  console.log(bar('SAFE OFFLINE LANE — npm test'));
  console.log(`Clean environment, guard loaded into every process: no hosted Supabase, Stripe, Expo, Google or website; no Supabase CLI against the linked project.`);
  if (prodFiles.length) console.log(`Note: ${prodFiles.join(', ')} point at production or hold live credentials. This lane does not load them, and the guard blocks any use.`);
  if (missing.length) console.log(`Not on disk (listed in lanes.json): ${missing.join(', ')}`);
  const { status, results, blocked } = run('offline', files);
  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : { failures: [] };
  const known = new Set(baseline.failures);
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.key);
  // Branch-specific expectations with a stated condition (e.g. "until the Fetch v2 migrations are applied"), reported on their own.
  const expected = LANES.expectedOnBranch ?? {};
  const preExisting = failed.filter((k) => known.has(k));
  const onBranch = failed.filter((k) => !known.has(k) && expected[k]);
  const fresh = failed.filter((k) => !known.has(k) && !expected[k]);
  const nowPassing = baseline.failures.filter((k) => results.some((r) => r.key === k && r.status === 'pass'));
  const skipped = results.filter((r) => r.status === 'skip').length;
  // Used once per branch to record the baseline: the failures of this lane on an untouched checkout of the base commit.
  if (process.env.LANE_WRITE_FAILURES) writeFileSync(process.env.LANE_WRITE_FAILURES, JSON.stringify({ failures: failed, results: results.length }, null, 2));
  console.log(bar('SUMMARY'));
  console.log(`Safe offline tests: ${results.length} in ${files.length} files — ${results.filter((r) => r.status === 'pass').length} passed, ${failed.length} failed, ${skipped} skipped.`);
  console.log(`External access attempts blocked by the guard: ${blocked.length}${blocked.length ? ' — a suite in this lane tried to reach a live service:' : ' (nothing tried to leave this machine)'}`);
  for (const [f, what] of blocked) console.log(`  ✖ ${f}: ${what}`);
  console.log(`Known ${BASE.label} baseline failures (pre-existing on untouched ${BASE.commit}, not caused by Fetch v2): ${preExisting.length}`);
  for (const k of preExisting) console.log(`  · ${k}`);
  if (Object.keys(expected).length) {
    console.log(`Expected on this branch, with a stated condition (lanes.json expectedOnBranch): ${onBranch.length} of ${Object.keys(expected).length}`);
    for (const k of onBranch) console.log(`  ~ ${k}\n      ${expected[k]}`);
    for (const k of Object.keys(expected).filter((k) => results.some((r) => r.key === k && r.status === 'pass'))) console.log(`  ✓ now passing — remove from expectedOnBranch: ${k}`);
  }
  console.log(`NEW failures (not in the ${BASE.label} baseline): ${fresh.length}`);
  for (const k of fresh) console.log(`  ✖ ${k}`);
  const gone = baseline.failures.filter((k) => !results.some((r) => r.key === k));
  if (gone.length) { console.log(`Baseline entries for tests that did not run (renamed, removed or file missing — review and prune): ${gone.length}`); for (const k of gone) console.log(`  ? ${k}`); }
  if (nowPassing.length) { console.log(`Baseline entries now passing (remove them from the baseline): ${nowPassing.length}`); for (const k of nowPassing) console.log(`  ✓ ${k}`); }
  console.log(`Not run in this lane: ${LANES.productionReadonly.length} production read-only suites (opt-in: npm run test:integration:production-readonly); `
    + `${Object.keys(LANES.quarantined).length} quarantined write-capable production suites (never run); ${LANES.isolated.length} isolated-database suites (npm run test:isolated); `
    + `${LANES.unregisteredAtBase.length} suites unregistered since ${BASE.label}.`);
  const fail = fresh.length > 0 || blocked.length > 0 || (status !== 0 && failed.length === 0 && results.length === 0);
  process.exit(fail ? 1 : 0);
}

if (lane === 'production-readonly') {
  console.log(bar('PRODUCTION READ-ONLY INTEGRATION LANE'));
  console.log('⚠  These suites READ the live OneShetland production database and REST API. Nothing may be written: the guard refuses any');
  console.log('⚠  statement that is not a plain read, forces the database session read-only, allows only GET/HEAD to the REST API, and keeps');
  console.log('⚠  Stripe, Expo, Google and the website blocked. Only the allow-listed suites in lanes.json productionReadonly can run.');
  if (process.env[OPT_IN] !== 'yes') {
    console.log(`\nRefusing: set ${OPT_IN}=yes in your own shell for this one command. No script or CI job sets it.\n`);
    process.exit(2);
  }
  const requested = process.argv.slice(3);
  const allowed = new Set(LANES.productionReadonly);
  const files = (requested.length ? requested : LANES.productionReadonly).filter((f) => !only || f.includes(only));
  const refused = files.filter((f) => !allowed.has(f));
  if (refused.length) { console.log(`Refusing suites that are not allow-listed read-only: ${refused.join(', ')}`); process.exit(2); }
  const WRITE = /\b(insert\s+into|update\s+[\w."]+\s+set|delete\s+from|truncate|alter\s+table|drop\s|create\s+(or\s+replace\s+)?(function|table|policy|trigger)|grant\s|revoke\s)/i;
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    if (WRITE.test([...s.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]).join('\n')) || /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(s)) {
      console.log(`Refusing ${f}: its source contains write SQL or a write HTTP method. Move it to the quarantine.`); process.exit(2);
    }
  }
  const { results, blocked } = run('production-readonly', files, { ONESHETLAND_PRODUCTION_READONLY: 'yes-read-only-production' });
  console.log(bar('SUMMARY'));
  console.log(`Production read-only tests: ${results.length} — ${results.filter((r) => r.status === 'pass').length} passed, ${results.filter((r) => r.status === 'fail').length} failed.`);
  console.log(`Refused by the guard (writes or other services): ${blocked.length}`);
  for (const [f, what] of blocked) console.log(`  ✖ ${f}: ${what}`);
  process.exit(results.some((r) => r.status === 'fail') || blocked.length ? 1 : 0);
}

if (lane === 'quarantined') {
  console.log(bar('QUARANTINED — write-capable production suites (never run)'));
  for (const [f, v] of Object.entries(LANES.quarantined)) console.log(`  ${f}\n      ${v.class} · via ${v.via}${v.fetchRelated ? ' · Fetch' : ''}`);
  console.log('\nThese wrote to production (some only inside rolled-back transactions, which is not a safety boundary). They need porting to the');
  console.log('isolated lane, mocks, or read-only assertions before they can run anywhere. See supabase/tests/README.md.');
  process.exit(1);
}

console.error(`Unknown lane "${lane}". Use offline, production-readonly or quarantined.`);
process.exit(2);
