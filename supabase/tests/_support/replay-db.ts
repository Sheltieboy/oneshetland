/**
 * replay-db.ts — a private database inside the isolated cluster, built from the REAL migrations.
 *
 * The isolated suites run in one throwaway Postgres (PASS_PROOF_DSN). Most of them hand-build the few tables they need; a suite that must exercise
 * triggers, grants and functions exactly as production has them replays every migration instead — into its OWN database so the other suites'
 * schemas are never disturbed. `stopBefore` leaves out a migration (and everything after it) to reproduce production's PRE-FIX state; apply
 * the fix afterwards with `rawFile`.
 *
 * Isolated database only: refuses a DSN mentioning Supabase. Nothing here touches production.
 */
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const SUPPLEMENTS = join(REPO_ROOT, 'supabase/production/hand-applied-supplements');

export interface ReplayDb {
  dsnPg: string;
  /** everything psql said (stdout + stderr), as the postgres superuser. Never throws. */
  raw(body: string): string;
  rawFile(path: string): string;
  /** run SQL in the background (own connection) — for real concurrency */
  bg(body: string): Promise<{ stdout: string; stderr: string }>;
  drop(): void;
}

export function createReplayDb(name: string, opts: { stopBefore?: string } = {}): ReplayDb {
  const DSN = process.env.PASS_PROOF_DSN ?? '';
  const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  const dsnFor = (user: string, db: string) => DSN.replace(/^postgresql:\/\/[^@]+@\/[^?]+/, `postgresql://${user}@/${db}`);
  const proof = dsnFor('proof', 'proof');
  const dsnPg = dsnFor('postgres', name);
  const psql = (dsn: string, args: string[], input?: string) =>
    spawnSync(PSQL, [dsn, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, input, maxBuffer: 1 << 26 });

  spawnSync(PSQL, [proof, '-X', '-q', '-c', `drop database if exists ${name}`]);
  const cr = psql(proof, ['-c', `create database ${name} template template0 encoding 'UTF8'`]);
  assert.doesNotMatch(`${cr.stdout}${cr.stderr}`, /ERROR/, 'could not create the private database');
  const setup = readFileSync(join(REPO_ROOT, 'scripts/migration-replay/setup.sql'), 'utf8').replace('alter database proof set', `alter database ${name} set`);
  const s = psql(dsnFor('proof', name), [], setup);
  assert.doesNotMatch((s.stderr ?? '').split('\n').filter((l) => /ERROR/.test(l) && !/already exists/.test(l)).join('\n'), /ERROR/, `replay stand-ins failed:\n${s.stderr?.slice(0, 800)}`);

  const errors: string[] = [];
  for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) {
    if (opts.stopBefore && f >= opts.stopBefore) continue;
    const r = psql(dsnPg, ['-f', join(MIG, f)]);
    for (const l of (r.stderr ?? '').split('\n')) if (/ERROR/.test(l) && !(f.startsWith('20260623000000') && /schema "public" already exists/.test(l))) errors.push(`${f}: ${l.slice(0, 160)}`);
    const sup = join(SUPPLEMENTS, f.replace(/\.sql$/, '.supplement.sql'));
    if (existsSync(sup)) psql(dsnPg, ['-f', sup]);
  }
  assert.deepEqual(errors, [], 'the migration replay must be clean');

  return {
    dsnPg,
    raw: (body) => { const r = psql(dsnPg, ['-c', body]); return `${r.stdout ?? ''}${r.stderr ?? ''}`; },
    rawFile: (path) => { const r = psql(dsnPg, ['-f', path]); return `${r.stdout ?? ''}${r.stderr ?? ''}`; },
    bg: (body) => new Promise((resolve) => {
      const p = spawn(PSQL, [dsnPg, '-X', '-q', '-t', '-A', '-c', body], { cwd: REPO_ROOT });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', () => resolve({ stdout, stderr }));
    }),
    drop: () => { spawnSync(PSQL, [proof, '-X', '-q', '-c', `drop database if exists ${name}`]); },
  };
}
