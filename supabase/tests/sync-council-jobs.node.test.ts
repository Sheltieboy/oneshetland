/**
 * sync-council-jobs.node.test.ts — the council jobs feed, against the real upgraded myjobscotland markup.
 *
 * WHAT WAS WRONG
 *
 * myjobscotland upgraded its site in September 2026. The per-council page the sync read
 * (/councils/shetland-islands-council/jobs) became an empty shell, so from 29 Sep every run answered
 * "parsed 0 — left existing rows untouched". The fail-safe held (nothing was wiped) but the feed went
 * stale unnoticed: new vacancies never arrived, closing dates the council had extended never updated, and the
 * only trace was an HTTP response that pg_net keeps for about six hours. Four days later 17 of 39 current
 * vacancies were missing.
 *
 * The sync now reads the national search results near Shetland and keeps the cards published by Shetland
 * Islands Council. This runs the REAL function against real cards captured after the upgrade
 * (fixtures/myjobscotland-search-2026-10.html) with a faked network and database.
 *
 * WHAT IS ASSERTED
 *   A  parsing the real markup: only Shetland Islands Council cards, entities decoded, links, refs, contract,
 *      pay with its unit restored, closing dates
 *   B  the pay-unit rule
 *   C  a good run: both searches, paging, merge, upsert, prune the dropped, log it, answer 200
 *   D  every way a run can go wrong leaves existing jobs untouched, is logged, and answers 502
 *   E  an implausibly small feed upserts but does not prune
 *   F  dry runs write nothing; an unauthorised call does nothing; a broken log never breaks a sync
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule, readRepo } from './_support/load-source.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'myjobscotland-search-2026-10.html'), 'utf8');
const EMPTY_PAGE = '<html><body><main><div class="mjs-search-results"></div></main></body></html>';

type Row = Record<string, any>;
let calls: { fetches: string[]; upserts: Row[][]; deletes: { source?: string; keep?: string }[]; logs: Row[]; logPurges: number };
let held: number;
let pageFor: (params: URLSearchParams) => { status: number; body: string } | 'throw';
let logThrows: boolean;
let authDenied: Response | null;
let handler: (r: Request) => Promise<Response>;
let mod: Record<string, any>;

function fakeDb() {
  return {
    from(table: string) {
      if (table === 'job_sync_runs') {
        return {
          insert: async (row: Row) => { if (logThrows) throw new Error('log table down'); calls.logs.push(row); return {}; },
          delete: () => ({ lt: async () => { calls.logPurges++; return {}; } }),
        };
      }
      assert.equal(table, 'jobs');
      return {
        select: () => ({ eq: async () => ({ count: held }) }),
        upsert: async (rows: Row[]) => { calls.upserts.push(rows); return { error: null }; },
        delete: () => {
          const rec: { source?: string; keep?: string } = {};
          const q: any = {
            eq: (_c: string, v: string) => { rec.source = v; return q; },
            not: (_c: string, _op: string, v: string) => { rec.keep = v; return q; },
            select: async () => { calls.deletes.push(rec); return { data: [{ id: 'x' }, { id: 'y' }], error: null }; },
          };
          return q;
        },
      };
    },
  };
}

beforeEach(() => {
  calls = { fetches: [], upserts: [], deletes: [], logs: [], logPurges: 0 };
  held = 8; logThrows = false; authDenied = null;
  // Both searches return the fixture on page 0 and an empty page after it.
  pageFor = (p) => ({ status: 200, body: p.get('page') === '0' ? FIXTURE : EMPTY_PAGE });
  (globalThis as any).fetch = async (url: string) => {
    const u = new URL(url);
    calls.fetches.push(`${u.pathname}?${u.searchParams}`);
    assert.equal(u.origin + u.pathname, 'https://www.myjobscotland.gov.uk/search-jobs', 'only ever reads the public search');
    const r = pageFor(u.searchParams);
    if (r === 'throw') throw new Error('network down');
    return { ok: r.status < 400, status: r.status, text: async () => r.body };
  };
  mod = loadModule('supabase/functions/sync-council-jobs/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    '../_shared/send-push.ts': { createServiceClient: () => fakeDb() },
    '../_shared/cron-auth.ts': { requireCronSecret: () => authDenied },
  });
});

const run = (qs = '') => handler(new Request(`https://x.supabase.co/functions/v1/sync-council-jobs${qs}`, { method: 'POST', headers: { 'x-cron-secret': 's' } }));

describe('A — the real post-upgrade markup', () => {
  const parse = () => mod.parseSearchPage(FIXTURE);

  test('only Shetland Islands Council cards are kept (Police Scotland and Orkney are in the fixture)', () => {
    const { jobs, cards } = parse();
    assert.equal(cards, 9);
    assert.equal(jobs.length, 7);
    assert.ok(jobs.every((j: Row) => j.employer_name === 'Shetland Islands Council' && j.apply_url.includes('/councils/shetland-islands-council/jobs/')));
  });
  test('each job links to the official listing on the www host and is keyed on the numeric id', () => {
    for (const j of parse().jobs) {
      assert.match(j.apply_url, /^https:\/\/www\.myjobscotland\.gov\.uk\/councils\/shetland-islands-council\/jobs\/[a-z0-9-]+-\d{5,}$/);
      assert.equal(j.source_ref, j.apply_url.match(/-(\d+)$/)![1]);
    }
  });
  test('HTML entities in titles are decoded (&amp; → &), not shown raw', () => {
    const t = parse().jobs.map((j: Row) => j.title);
    assert.ok(t.includes('Club and Community Sport Officer - Sport & Leisure'));
    assert.ok(t.includes('Trainee Health & Safety Adviser - Human Resources'));
    assert.ok(t.every((x: string) => !/&amp;|&#/.test(x)));
  });
  test('pay keeps its unit: hourly and annual, and an identical min/max collapses to one figure', () => {
    const pay = Object.fromEntries(parse().jobs.map((j: Row) => [j.title, j.pay_text]));
    assert.equal(pay['Club and Community Sport Officer - Sport & Leisure'], '£20.90 - £21.68 per hour');
    assert.equal(pay['Teacher of English - Anderson High School'], '£39,156.00 - £57,450.00 per year');
    assert.equal(pay['Director of Place'], '£125,000.00 per year');
  });
  test('contract type is mapped from the position and contract tags', () => {
    const c = Object.fromEntries(parse().jobs.map((j: Row) => [j.title, j.contract_type]));
    assert.equal(c['Club and Community Sport Officer - Sport & Leisure'], 'part-time');
    assert.equal(c['Teacher of English - Anderson High School'], 'full-time');
    assert.equal(c['Director of Place'], 'full-time');
    assert.equal(Object.entries(c).find(([t]) => t.startsWith('Modern Apprentice'))![1], 'apprenticeship');
    assert.equal(Object.entries(c).find(([t]) => t.startsWith('Supply for Early Learning'))![1], 'casual');
    assert.equal(Object.entries(c).find(([t]) => t.startsWith('Social Care Worker (Predominantly Nights)'))![1], 'casual', 'Temporary maps as before');
  });
  test('closing dates become end-of-day timestamps, and locations are kept', () => {
    const j = parse().jobs.find((x: Row) => x.title === 'Teacher of English - Anderson High School');
    assert.equal(j.expires_at, '2026-10-14T23:59:00Z');
    assert.ok(j.location && j.location.length > 3);
    assert.ok(parse().jobs.every((x: Row) => /^2026-\d\d-\d\dT23:59:00Z$/.test(x.expires_at)));
  });
  test('each of the two filters stands alone: publisher AND link path must both say Shetland Islands Council', () => {
    const card = (publisher: string, path: string) => `<div class="mjs-card border-light"><div class="mjs-card__body"><h3 class="mjs-card__title"><a href="https://myjobscotland.gov.uk${path}">X</a></h3><span class="label">Published by
\t${publisher}</span><div class="mjs-card__description"><p>Lerwick</p></div><div class="mjs-card__tags"><span class="mjs-tag mjs-tag__secondary">Full Time</span><span class="mjs-tag mjs-tag__secondary">Closing on 01/11/2026</span></div></div></div>`;
    const sic = '/councils/shetland-islands-council/jobs/x-111111', other = '/councils/orkney-islands-council/jobs/x-222222';
    assert.equal(mod.parseSearchPage(card('Shetland Islands Council', sic)).jobs.length, 1);
    assert.equal(mod.parseSearchPage(card('Orkney Islands Council', sic)).jobs.length, 0, 'wrong publisher, right path');
    assert.equal(mod.parseSearchPage(card('Shetland Islands Council', other)).jobs.length, 0, 'right publisher, wrong path');
  });
  test('the OLD page shape is not mistaken for results (this is how the feed went quiet)', () => {
    assert.equal(mod.parseSearchPage('<article class="mjs-container py--0"><h1><span>Jobs</span></h1><div></div></article>').jobs.length, 0);
    assert.equal(mod.parseSearchPage('<article class="job-listing"><h3><a href="/councils/shetland-islands-council/jobs/x-1">X</a></h3></article>').jobs.length, 0);
  });
});

describe('B — the pay unit rule', () => {
  const p = (s: string | null) => mod.payWithUnit(s);
  test('under £100 is hourly; £1,000 and over is annual', () => {
    assert.equal(p('£15.50'), '£15.50 per hour');
    assert.equal(p('£17.44 - £19.46'), '£17.44 - £19.46 per hour');
    assert.equal(p('£31,628.69 - £46,456.16'), '£31,628.69 - £46,456.16 per year');
  });
  test('an ambiguous amount is left exactly as published, and a stated unit is never doubled', () => {
    assert.equal(p('£500 - £900'), '£500 - £900');
    assert.equal(p('£15.50 per hour'), '£15.50 per hour');
    assert.equal(p('£30,000 per year'), '£30,000 per year');
  });
  test('no pay stays empty', () => { assert.equal(p(null), null); });
});

describe('C — a good run', () => {
  test('reads both searches, pages until a page is empty, and merges duplicates', async () => {
    const res = await run();
    assert.equal(res.status, 200);
    const searches = new Set(calls.fetches.map((f) => new URL('https://x/' + f).searchParams.has('keyword') ? 'keyword' : 'location'));
    assert.deepEqual([...searches].sort(), ['keyword', 'location']);
    assert.equal(calls.fetches.length, 4, 'page 0 and the empty page 1 of each search');
    assert.equal(calls.upserts.length, 1);
    assert.equal(calls.upserts[0].length, 7, 'the same 7 from both searches are merged, not doubled');
  });
  test('the upserted rows are open, visible, external, and carry the council identity', async () => {
    await run();
    for (const r of calls.upserts[0]) {
      assert.equal(r.source, 'myjobscotland'); assert.equal(r.status, 'open'); assert.equal(r.is_hidden, false);
      assert.equal(r.employer_id, null); assert.equal(r.external_employer_name, 'Shetland Islands Council');
      assert.match(r.external_employer_logo_url, /SIC_mjs\.png$/);
      assert.equal(r.pay_hidden, !r.pay_text);
      assert.ok(r.title.length > 0 && r.title.length <= 200);
    }
  });
  test('jobs that dropped off the feed are pruned, keeping exactly the current ones', async () => {
    await run();
    assert.equal(calls.deletes.length, 1);
    assert.equal(calls.deletes[0].source, 'myjobscotland');
    const keep = calls.deletes[0].keep!.match(/\d{5,}/g)!;
    assert.deepEqual([...keep].sort(), calls.upserts[0].map((r: Row) => r.source_ref).sort());
  });
  test('the run is logged with its counts', async () => {
    await run();
    assert.equal(calls.logs.length, 1);
    assert.deepEqual([calls.logs[0].source, calls.logs[0].ok, calls.logs[0].parsed, calls.logs[0].removed, calls.logs[0].prune_skipped], ['myjobscotland', true, 7, 2, false]);
    assert.equal(calls.logPurges, 1, 'old log rows are trimmed');
  });
});

describe('D — every failure leaves the existing jobs untouched, is logged, and answers 502', () => {
  const assertSafe = async (expectReason: RegExp) => {
    const res = await run();
    assert.equal(res.status, 502);
    assert.equal(calls.upserts.length, 0, 'nothing written');
    assert.equal(calls.deletes.length, 0, 'nothing pruned');
    assert.equal(calls.logs.length, 1);
    assert.equal(calls.logs[0].ok, false);
    assert.match(calls.logs[0].reason, expectReason);
    return res;
  };
  test('THE DEFECT: a page with no council jobs (the shape the broken sync saw) writes nothing and says so', async () => {
    pageFor = () => ({ status: 200, body: EMPTY_PAGE });
    await assertSafe(/parsed 0/);
  });
  test('the source answering an error', async () => {
    pageFor = () => ({ status: 503, body: 'down' });
    await assertSafe(/fetch 503/);
  });
  test('the network failing outright', async () => {
    pageFor = () => 'throw';
    await assertSafe(/network down/);
  });
  test('a later page failing after a good first page does not prune a half-read feed', async () => {
    pageFor = (p) => (p.get('page') === '0' ? { status: 200, body: FIXTURE } : { status: 500, body: 'oops' });
    await assertSafe(/fetch 500 \(page 1\)/);
  });
  test('the second search failing after the first succeeded also writes nothing', async () => {
    pageFor = (p) => (p.has('keyword') ? { status: 500, body: 'oops' } : { status: 200, body: p.get('page') === '0' ? FIXTURE : EMPTY_PAGE });
    await assertSafe(/fetch 500/);
  });
  test('a failure is written to the console as well as the log', async () => {
    const errs: string[] = []; const orig = console.error; console.error = (...a: any[]) => { errs.push(a.join(' ')); };
    try { pageFor = () => ({ status: 200, body: EMPTY_PAGE }); await run(); } finally { console.error = orig; }
    assert.ok(errs.some((e) => e.includes('[sync-council-jobs] source failed')));
  });
});

describe('E — a feed that is suddenly tiny', () => {
  test('under 40% of what we hold: upsert the new, keep the old, log that pruning was skipped', async () => {
    held = 30;
    const res = await run();
    assert.equal(res.status, 200);
    assert.equal(calls.upserts.length, 1);
    assert.equal(calls.deletes.length, 0, 'no pruning on an implausible drop');
    assert.equal(calls.logs[0].prune_skipped, true);
  });
  test('a small board is not treated as suspicious (fewer than 10 rows held)', async () => {
    held = 9;
    await run();
    assert.equal(calls.deletes.length, 1);
  });
  test('7 of 12 held (58%) is a normal clear-out and prunes', async () => {
    held = 12;
    await run();
    assert.equal(calls.deletes.length, 1);
  });
});

describe('F — dry run, authorisation, and the log never breaking the sync', () => {
  test('?dry=1 parses and reports but writes and logs nothing', async () => {
    const res = await run('?dry=1');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.dry, true);
    assert.equal(body.results[0].parsed, 7);
    assert.deepEqual([calls.upserts.length, calls.deletes.length, calls.logs.length], [0, 0, 0]);
  });
  test('an unauthorised call reads and writes nothing', async () => {
    authDenied = new Response('no', { status: 401 });
    const res = await run();
    assert.equal(res.status, 401);
    assert.deepEqual([calls.fetches.length, calls.upserts.length, calls.logs.length], [0, 0, 0]);
  });
  test('a broken log table cannot break a good sync', async () => {
    logThrows = true;
    const res = await run();
    assert.equal(res.status, 200);
    assert.equal(calls.upserts.length, 1);
  });
  test('the source is read politely: a named bot user agent and a page cap', () => {
    const src = readRepo('supabase/functions/sync-council-jobs/index.ts');
    assert.match(src, /OneShetlandJobsBot\/1\.0 \(\+https:\/\/oneshetland\.com/);
    assert.match(src, /const PAGE_CAP = 8/);
  });
});

describe('the schedule and table are in place', () => {
  test('the run-log table is admin-read only and has row security', () => {
    const sql = readRepo('supabase/migrations/20261031050000_job_sync_runs.sql').replace(/^\s*--.*$/gm, '');
    assert.match(sql, /alter table public\.job_sync_runs enable row level security/);
    assert.match(sql, /create policy "Admins read job sync runs"[\s\S]*role = 'admin'/);
    assert.match(sql, /revoke all on public\.job_sync_runs from anon, authenticated/);
  });
  test('the function stays cron-only (no JWT, secret required)', () => {
    assert.match(readRepo('supabase/config.toml'), /\[functions\.sync-council-jobs\]\s*\nverify_jwt = false/);
    assert.match(readRepo('supabase/functions/sync-council-jobs/index.ts'), /requireCronSecret\(req, corsHeaders\)/);
  });
});
