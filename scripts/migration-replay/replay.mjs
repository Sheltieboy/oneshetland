#!/usr/bin/env node
/**
 * replay.mjs — build a database from supabase/migrations alone and compare it with production's recorded catalog fingerprint.
 *
 *   node scripts/migration-replay/replay.mjs            (or: npm run test:replay)
 *
 * Starts a throwaway PostgreSQL 17 cluster (unix socket only, destroyed afterwards), installs minimal Supabase-style stand-ins
 * (auth, storage, cron, net, vault — see setup.sql), applies every migration in order running as role `postgres` exactly as production
 * does, applies the documented hand-applied supplements (supabase/production/hand-applied-supplements/), then fingerprints the catalog
 * (tables, columns, constraints, indexes, RLS policies, triggers, functions incl. SECURITY DEFINER/volatility/config/body, grants,
 * views, enums, storage policies and buckets) and compares it with supabase/production/catalog-fingerprint.tsv.
 *
 * PASS = every object matches production, apart from supabase/production/catalog-known-differences.json (cosmetic, explained).
 * Never connects to production. To refresh the fingerprint after an approved production change, run catalog.sql and storage.sql
 * read-only against production and rewrite the .tsv.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate as stripeCustomerExposure } from '../lib/stripe-customer-exposure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PG_HOME = '/opt/homebrew/opt/postgresql@17';
const bin = (n) => (existsSync(join(PG_HOME, 'bin', n)) ? join(PG_HOME, 'bin', n) : n);
const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C', PGOPTIONS: '-c client_min_messages=error' };

const dir = mkdtempSync(join(tmpdir(), 'replay-'));
let started = false;
const stop = () => {
  try { if (started) execFileSync(bin('pg_ctl'), ['-D', dir, '-m', 'immediate', 'stop'], { stdio: 'ignore', env: ENV }); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
};
process.on('SIGINT', () => { stop(); process.exit(130); });

let code = 1;
try {
  execFileSync(bin('initdb'), ['-D', dir, '-U', 'proof', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore', env: ENV });
  execFileSync(bin('pg_ctl'), ['-D', dir, '-o', `-k ${dir} -c listen_addresses=''`, '-w', '-l', join(dir, 's.log'), 'start'], { stdio: 'ignore', env: ENV });
  started = true;
  execFileSync(bin('createdb'), ['-h', dir, '-U', 'proof', 'proof'], { stdio: 'ignore', env: ENV });
  const asProof = `postgresql://proof@/proof?host=${dir}`;
  const asPostgres = `postgresql://postgres@/proof?host=${dir}`;
  const psql = (dsn, args) => spawnSync(bin('psql'), [dsn, '-X', '-q', '-v', 'ON_ERROR_STOP=0', ...args], { encoding: 'utf8', env: ENV, maxBuffer: 1 << 28 });
  const errorsOf = (r) => (r.stderr || '').split('\n').filter((l) => /ERROR:/.test(l));

  const setup = psql(asProof, ['-f', join(HERE, 'setup.sql')]);
  if (errorsOf(setup).length) throw new Error(`setup failed: ${errorsOf(setup)[0]}`);

  const migDir = join(ROOT, 'supabase/migrations'); const supDir = join(ROOT, 'supabase/production/hand-applied-supplements');
  const unexpected = [];
  for (const f of readdirSync(migDir).filter((n) => n.endsWith('.sql')).sort()) {
    for (const e of errorsOf(psql(asPostgres, ['-f', join(migDir, f)]))) {
      // The baseline is a pg_dump that begins with CREATE SCHEMA public; the harness has already created it (pg_trgm lives there in production).
      if (f.startsWith('20260623000000_') && /schema "public" already exists/.test(e)) continue;
      unexpected.push(`${f}: ${e.replace(/^psql:[^ ]+ /, '')}`);
    }
    const sup = join(supDir, f.replace(/\.sql$/, '.supplement.sql'));
    if (existsSync(sup)) for (const e of errorsOf(psql(asPostgres, ['-f', sup]))) unexpected.push(`${f} (supplement): ${e}`);
  }

  const rows = (file) => (psql(asPostgres, ['-t', '-A', '-F', '\t', '-f', join(HERE, file)]).stdout || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const replay = new Map([...rows('catalog.sql'), ...rows('storage.sql')].map(([k, key, h]) => [`${k}\t${key}`, h]));
  const prod = new Map(readFileSync(join(ROOT, 'supabase/production/catalog-fingerprint.tsv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const [k, key, h] = l.split('\t'); return [`${k}\t${key}`, h]; }));
  const known = new Set(JSON.parse(readFileSync(join(ROOT, 'supabase/production/catalog-known-differences.json'), 'utf8')).differences.map((d) => `${d.kind}\t${d.key}`));

  const onlyProd = [...prod.keys()].filter((k) => !replay.has(k));
  const onlyReplay = [...replay.keys()].filter((k) => !prod.has(k));
  const differ = [...prod.keys()].filter((k) => replay.has(k) && replay.get(k) !== prod.get(k));
  const unexplained = differ.filter((k) => !known.has(k));
  const staleKnown = [...known].filter((k) => !differ.includes(k));

  console.log(`migrations replayed: ${readdirSync(migDir).filter((n) => n.endsWith('.sql')).length}; objects — production ${prod.size}, replay ${replay.size}`);
  console.log(`only in production: ${onlyProd.length}; only in replay: ${onlyReplay.length}; differing: ${differ.length} (explained: ${differ.length - unexplained.length}, unexplained: ${unexplained.length}); migration errors: ${unexpected.length}`);
  for (const [t, l] of [['ONLY IN PRODUCTION', onlyProd], ['ONLY IN REPLAY', onlyReplay], ['UNEXPLAINED DIFFERENCE', unexplained], ['STALE known-difference entry', staleKnown]]) for (const k of l.slice(0, 30)) console.log(`  ${t}: ${k.replace('\t', ' ')}`);
  for (const e of unexpected.slice(0, 20)) console.log(`  MIGRATION ERROR: ${e}`);
  // Whole-schema guard: no Stripe CUSTOMER id column may be reachable by anon / authenticated beyond the documented allow-list.
  const guard = stripeCustomerExposure((sql) => (psql(asPostgres, ['-t', '-A', '-F', '\t', '-c', sql]).stdout || '').split('\n').filter(Boolean).map((l) => l.split('\t')));
  console.log(`stripe customer-id exposure guard: ${guard.violations.length} violation(s), ${guard.allowed.length} documented exception(s), ${guard.stale.length} stale allow-list entr${guard.stale.length === 1 ? 'y' : 'ies'}`);
  for (const v of guard.violations) console.log(`  STRIPE CUSTOMER ID EXPOSED: ${v}`);
  for (const v of guard.stale) console.log(`  STALE stripe-customer allow-list entry: ${v}`);
  code = onlyProd.length + onlyReplay.length + unexplained.length + unexpected.length + staleKnown.length + guard.violations.length + guard.stale.length === 0 ? 0 : 1;
} catch (e) { console.error(e.message); } finally { stop(); }
process.exit(code);
