/**
 * wallet-liquidity-concurrency.node.test.ts
 *
 * Two simultaneous £60 Wallet transfers against £100 of headroom must not
 * both pass independently and together overdraw the platform. Read
 * independently, BOTH would see "£100 available, £60 needed — fine" and both
 * would proceed, together needing £120 that was never there.
 *
 * wallet_liquidity_reserve() (migration 20261025050000) closes this with a
 * single, pg_advisory_xact_lock-serialised database round trip — the check
 * AND the claim happen together, never as two independent reads compared in
 * application code. This proves it against a REAL second connection — a
 * separate OS process, launched together — not two sequential calls
 * relabelled as concurrent.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase', 'migrations');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';

function rawSync(body: string): string {
  return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', body],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}
async function rawAsync(body: string): Promise<string> {
  const { stdout } = await execFileAsync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', body],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  return stdout;
}
const jsonRow = (finalSelect: string) =>
  `select coalesce(row_to_json(x)::text, '{}') from (${finalSelect}) x;`;
const parseRow = (out: string): Record<string, unknown> => {
  const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop() ?? '{}';
  return JSON.parse(line);
};

function schema() {
  const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
  const LIQUIDITY = join(MIG, '20261025050000_wallet_liquidity.sql');
  const baselineSrc = readFileSync(BASELINE, 'utf8');

  function createTable(opener: string): string {
    const start = baselineSrc.indexOf(opener);
    assert.notEqual(start, -1, `${opener} is gone`);
    const open = baselineSrc.indexOf('(', start);
    let d = 0, end = -1;
    for (let i = open; i < baselineSrc.length; i++) {
      if (baselineSrc[i] === '(') d++; else if (baselineSrc[i] === ')') { d--; if (d === 0) { end = i; break; } }
    }
    return baselineSrc.slice(start, end + 1) + ';';
  }

  // The migration's own DDL, up to (not including) the cron.schedule call —
  // pg_cron/pg_net/vault are Supabase-managed extensions this throwaway
  // cluster does not have, and the scheduling itself is covered by source
  // checks in wallet-liquidity.node.test.ts, not by running it here.
  const fullMig = readFileSync(LIQUIDITY, 'utf8');
  const marker = '-- ── The scheduled monitor';
  const cutAt = fullMig.indexOf(marker);
  assert.notEqual(cutAt, -1, 'the scheduled-monitor marker moved — update this test\'s slice point');
  const ddlOnly = fullMig.slice(0, cutAt);

  const out = rawSync([
    'drop schema if exists public cascade; create schema public;',
    'create extension if not exists pgcrypto;',
    createTable('CREATE TABLE public.admin_config ('),
    'alter table public.admin_config add primary key (key);',
    ddlOnly,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1500)}`);
}

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is required — run via `npm run test:isolated`');
  assert.ok(!/supabase/i.test(DSN), 'refusing to run against anything that looks like Supabase');
  schema();
});

describe('two concurrent Wallet spends cannot oversubscribe the same headroom', () => {
  test('of two concurrent £60 reservations against £100 headroom, exactly one succeeds', async () => {
    const attempt = jsonRow(`select * from public.wallet_liquidity_reserve(6000, 10000, 0)`);
    const [a, b] = await Promise.all([rawAsync(attempt), rawAsync(attempt)]);
    const ra = parseRow(a), rb = parseRow(b);
    const oks = [ra.ok, rb.ok].filter(Boolean).length;
    assert.equal(oks, 1, `expected exactly one of two concurrent £60 reservations to succeed against £100 headroom, got ${oks}`);
  });

  test('held reservations never exceed headroom after the race — the sum is provably safe, not merely "usually fine"', () => {
    const row = parseRow(rawSync(jsonRow(
      `select coalesce(sum(amount_pence),0) as held from public.local_wallet_liquidity_reservations where status='held' and created_at > now() - interval '2 minutes'`,
    )));
    assert.ok(Number(row.held) <= 10000, `held (${row.held}p) exceeded the £100 headroom it was checked against`);
  });

  test('two £40 reservations against £100 headroom BOTH succeed — the lock serialises, it does not just refuse everything', async () => {
    rawSync(`update public.local_wallet_liquidity_reservations set status='released' where status='held';`);
    const attempt = jsonRow(`select * from public.wallet_liquidity_reserve(4000, 10000, 0)`);
    const [a, b] = await Promise.all([rawAsync(attempt), rawAsync(attempt)]);
    const ra = parseRow(a), rb = parseRow(b);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    const held = parseRow(rawSync(jsonRow(
      `select coalesce(sum(amount_pence),0) as held from public.local_wallet_liquidity_reservations where status='held' and created_at > now() - interval '2 minutes'`,
    )));
    assert.equal(Number(held.held), 8000);
  });

  test('a reservation older than 2 minutes is excluded from held — a crashed process cannot permanently lock up headroom', () => {
    rawSync(`update public.local_wallet_liquidity_reservations set status='released' where status='held';`);
    rawSync(`insert into public.local_wallet_liquidity_reservations (amount_pence, created_at)
      values (9000, now() - interval '5 minutes');`);
    const row = parseRow(rawSync(jsonRow(`select * from public.wallet_liquidity_reserve(5000, 10000, 0)`)));
    assert.equal(row.ok, true, 'a stale reservation blocked a new one that should have fit');
  });

  test('released reservations never count toward held, so a settled spend frees its headroom for the next one', () => {
    rawSync(`update public.local_wallet_liquidity_reservations set status='released';`);
    const first = parseRow(rawSync(jsonRow(`select * from public.wallet_liquidity_reserve(9000, 10000, 0)`)));
    assert.equal(first.ok, true);
    const secondBeforeRelease = parseRow(rawSync(jsonRow(`select * from public.wallet_liquidity_reserve(5000, 10000, 0)`)));
    assert.equal(secondBeforeRelease.ok, false, 'a second reservation should not fit while the first is still held');
    rawSync(`select public.wallet_liquidity_release('${first.reservation_id}'::uuid);`);
    const secondAfterRelease = parseRow(rawSync(jsonRow(`select * from public.wallet_liquidity_reserve(5000, 10000, 0)`)));
    assert.equal(secondAfterRelease.ok, true, 'releasing the first reservation should free its headroom');
  });
});
