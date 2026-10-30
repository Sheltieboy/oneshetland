/**
 * mobile-jobs-structural.node.test.ts — Jobs Stage 2, the app's half (local branch; not in any shipped build).
 *
 * Runs the REAL lib/business-home.ts and lib/jobs-api.ts against a recording fake of the Supabase client (no network, no project):
 *   · a business's own jobs are found by `posted_as_business_id` (the app's business home filtered on `business_id`, a column jobs does not have)
 *   · fetchJobs: unknown category ignored, Temporary label, newest-first on listed_at
 *   · the card shows the closing date; posting defaults to a finite 30 days and an edit never silently moves an existing date
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, readRepo } from './_support/load-source.ts';
import * as T from '../../lib/job-taxonomy.ts';

type Call = { table: string; eq: [string, unknown][]; order: [string, boolean][]; };
function recorder(rowsByTable: Record<string, any[]> = {}) {
  const calls: Call[] = [];
  const supabase = {
    from(table: string) {
      const c: Call = { table, eq: [], order: [] }; calls.push(c);
      const b: any = {
        select() { return b; }, or() { return b; }, limit() { return b; }, range() { return b; }, gte() { return b; }, gt() { return b; }, lte() { return b; },
        in() { return b; }, is() { return b; }, neq() { return b; }, maybeSingle() { return b; }, single() { return b; },
        eq(col: string, v: unknown) { c.eq.push([col, v]); return b; },
        order(col: string, o: { ascending?: boolean } = {}) { c.order.push([col, o.ascending !== false]); return b; },
        then(res: any, rej: any) { return Promise.resolve({ data: rowsByTable[table] ?? [], error: null, count: (rowsByTable[table] ?? []).length }).then(res, rej); },
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { supabase, calls };
}

describe('business home finds its own jobs', () => {
  test('the jobs query filters on posted_as_business_id, never business_id', async () => {
    const { supabase, calls } = recorder({ jobs: [{ id: 'job-1' }] });
    const mod = loadModule('lib/business-home.ts', {
      '@/lib/supabase': { supabase },
      '@/lib/entitlement': { fetchEffectiveTier: async () => ({}), NO_ENTITLEMENT: {} },
      '@/lib/business-outcomes': {},
    });
    await mod.fetchBusinessHome('biz-1', 'owner-1', {}, () => false);
    const jobs = calls.filter((c) => c.table === 'jobs');
    assert.ok(jobs.length >= 1);
    for (const c of jobs) {
      assert.ok(c.eq.some(([col, v]) => col === 'posted_as_business_id' && v === 'biz-1'), JSON.stringify(c));
      assert.ok(!c.eq.some(([col]) => col === 'business_id'));
    }
    // and the applications count is keyed on the job ids it found
    assert.ok(calls.some((c) => c.table === 'job_applications'));
  });
  test('source scan: no jobs read in the app uses business_id', () => {
    for (const f of ['lib/business-home.ts', 'lib/jobs-api.ts']) {
      assert.doesNotMatch(readRepo(f), /from\('jobs'\)[^;]{0,200}\.eq\('business_id'/s, f);
    }
  });
});

describe('fetchJobs', () => {
  const load = (rows: any[] = []) => { const r = recorder({ jobs: rows }); return { ...r, mod: loadModule('lib/jobs-api.ts', { './supabase': { supabase: r.supabase }, '@/lib/job-taxonomy': T }) }; };
  test('a category in the vocabulary filters; an unknown one is ignored', async () => {
    const a = load(); await a.mod.fetchJobs({ category: 'Care' });
    assert.ok(a.calls[0].eq.some(([c, v]) => c === 'category' && v === 'Care'));
    const b = load(); await b.mod.fetchJobs({ category: 'Astronaut' });
    assert.ok(!b.calls[0].eq.some(([c]) => c === 'category'));
  });
  test('newest first uses listed_at (source publication date when known)', async () => {
    const a = load(); await a.mod.fetchJobs({});
    assert.ok(a.calls[0].order.some(([c]) => c === 'listed_at'));
    assert.ok(!a.calls[0].order.some(([c]) => c === 'posted_at'));
  });
  test('Temporary has its own label, not Casual', () => {
    const { mod } = load();
    assert.equal(mod.CONTRACT_LABELS.temporary, 'Temporary');
    assert.notEqual(mod.CONTRACT_LABELS.temporary, mod.CONTRACT_LABELS.casual);
  });
});

describe('card and posting', () => {
  test('the card shows the closing date only when there is one', () => {
    const src = readRepo('components/JobCard.tsx');
    assert.match(src, /closingLabel\(job\.expires_at\) \?/);
    assert.match(src, /job\.listed_at \?\? job\.posted_at/);
    assert.equal(T.closingLabel('2026-11-06T23:59:00Z', Date.parse('2026-10-30T12:00:00Z')), 'Closes 6 Nov');
    assert.equal(T.closingLabel(null), '');
  });
  test('posting has no open-ended option, defaults to 30 days, and an edit only sends a closing date the employer changed', () => {
    const src = readRepo('app/job-post.tsx');
    assert.doesNotMatch(src, /No close date/);
    assert.match(src, /useState\(30\)/);
    assert.match(src, /\.\.\.\(!isEdit \|\| expiryTouched \? \{ expires_at: expires \} : \{\}\)/);
  });
});
