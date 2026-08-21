/**
 * rate-limit-concurrency.node.test.ts — the ceiling under real concurrency.
 *
 * WHY THIS IS NOT IN THE ROUTINE SUITE
 *
 * A limiter is only worth anything if simultaneous callers cannot all read the
 * same "9 of 10" and all proceed. Proving that needs genuinely separate
 * database connections, and separate connections cannot see each other's
 * uncommitted work — so unlike every other limiter test, this one has to
 * COMMIT. Step 14 split the suites precisely so that committing tests are
 * opt-in, and this file honours that: it runs under `npm run test:fixtures`.
 *
 * It writes only to public.rate_limits, under a synthetic subject that belongs
 * to no account, and deletes those rows again at the end. No customer row, no
 * email, no push, no Stripe object and no provider call is produced.
 *
 * Run: npm run test:fixtures
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBJECT = 'user:rl-concurrency-probe';

async function sql(text: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await execFileAsync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${text}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000 });
  const p = JSON.parse(stdout) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 200)}`);
  return p.rows ?? [];
}

after(async () => {
  await sql(`delete from public.rate_limits where subject = '${SUBJECT}';`);
});

describe('the ceiling holds when callers arrive together', () => {
  test('ten simultaneous connections cannot exceed a ceiling of six', async () => {
    await sql(`delete from public.rate_limits where subject = '${SUBJECT}';`);

    // Ten independent processes, therefore ten independent connections, all
    // claiming the same 6/hour action at once.
    const attempts = await Promise.all(Array.from({ length: 10 }, () =>
      sql(`select allowed from public.claim_rate_limits('${SUBJECT}', array['notify_broadcast']);`)
        .then((rows) => ({ ok: true as const, allowed: rows[0]?.allowed === true || rows[0]?.allowed === 't' }))
        // The Supabase CLI shares one credential store, and ten of them racing
        // can lose that race. A process that never reached the database is not
        // evidence either way, so it is counted separately rather than as a pass.
        .catch(() => ({ ok: false as const, allowed: false }))));

    const reached = attempts.filter((a) => a.ok);
    const allowed = reached.filter((a) => a.allowed).length;

    assert.ok(reached.length >= 6,
      `only ${reached.length} of 10 connections reached the database — too few to prove anything`);
    assert.ok(allowed <= 6, `${allowed} claims were granted against a ceiling of 6`);

    // What the database itself recorded must agree with what the callers were told.
    const [row] = await sql(`select count::text as c from public.rate_limits where subject = '${SUBJECT}' and action = 'notify_broadcast';`);
    assert.equal(Number(row?.c ?? 0), allowed, 'the stored count must match the number of granted claims');
  });
});
