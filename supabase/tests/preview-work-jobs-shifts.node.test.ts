/**
 * preview-work-jobs-shifts.node.test.ts — guard rails for "Work = jobs + shifts" in the WEB V2 DESIGN PREVIEWS
 * (web /preview/home-v2 and /preview/local-v2), plus a parity check that the production app's Work model derives
 * urgency and times exactly as the web preview does. (The app's own behaviour is tested in home-local-screens.node.test.ts.)
 * Not a design acceptance: the look is judged by eye.
 *
 * What must never regress:
 *   • the web and app models agree (same urgency labels, same curation, same routing)
 *   • urgency is derived from the real start time in London time — never from a flag, never from a far-off date
 *   • the seed state carries exactly one invented "Saturday café cover" shift, and never the old build-144 bar-cover sample
 *   • the LIVE state invents nothing: no real shift → no shift, and `?work=` cannot add one
 *   • no shifts → no shifts section; no jobs → shifts still keep the Work destination; neither → a compact gateway
 *   • "See all jobs & shifts" goes to the Work hub (`/jobs`, or its Shifts tab when only shifts exist)
 *   • none of it touches production Home / Local
 *
 * Needs the sibling ../oneshetland-web checkout for the web half.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO, '..', 'oneshetland-web');
const haveWeb = existsSync(join(WEB, 'lib/preview-work.ts'));
const webOpts = { skip: haveWeb ? false : 'sibling oneshetland-web checkout not found' };
const code = (abs: string) => readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const app = loadModule('components/home-local/work.ts');
const web = haveWeb ? loadModule('../oneshetland-web/lib/preview-work.ts') : null;
const MODELS: [string, any][] = web ? [['web', web]] : [];
const BOTH: [string, any][] = [['app', app], ...MODELS];

// Tue 6 Oct 2026, 11:00 London (BST) = 10:00Z.   Winter: Tue 1 Dec 2026, 10:00 GMT.
const NOW = new Date('2026-10-06T10:00:00Z');
const WINTER = new Date('2026-12-01T10:00:00Z');
const iso = (s: string) => new Date(s).toISOString();

describe('urgency is derived from the real start time, in London time (app and web agree)', () => {
  for (const [name, m] of BOTH) {
    test(`${name}: TODAY · TONIGHT · TOMORROW · THIS WEEK · none`, () => {
      const u = (start: string, end: string, now = NOW) => m.shiftUrgency(iso(start), iso(end), now);
      assert.equal(u('2026-10-06T11:30:00Z', '2026-10-06T15:00:00Z'), 'TODAY');
      assert.equal(u('2026-10-06T09:00:00Z', '2026-10-06T14:00:00Z'), 'TODAY', 'in progress');
      assert.equal(u('2026-10-06T17:00:00Z', '2026-10-06T22:00:00Z'), 'TONIGHT');
      assert.equal(u('2026-10-07T08:00:00Z', '2026-10-07T12:00:00Z'), 'TOMORROW');
      assert.equal(u('2026-10-09T08:00:00Z', '2026-10-09T12:00:00Z'), 'THIS WEEK');
      assert.equal(u('2026-10-12T08:00:00Z', '2026-10-12T12:00:00Z'), 'THIS WEEK', 'six days out is the last "this week" day');
      assert.equal(u('2026-10-13T08:00:00Z', '2026-10-13T12:00:00Z'), null, 'a shift a week out gets no urgency label');
      assert.equal(u('2026-11-14T08:00:00Z', '2026-11-14T12:00:00Z'), null);
      assert.equal(u('2026-10-06T08:00:00Z', '2026-10-06T10:00:00Z'), null, 'already over');
    });
    test(`${name}: 17:00 London is the TONIGHT boundary in both BST and GMT`, () => {
      assert.equal(m.shiftUrgency(iso('2026-10-06T15:59:00Z'), iso('2026-10-06T20:00:00Z'), NOW), 'TODAY');     // 16:59 BST
      assert.equal(m.shiftUrgency(iso('2026-10-06T16:00:00Z'), iso('2026-10-06T20:00:00Z'), NOW), 'TONIGHT');   // 17:00 BST
      assert.equal(m.shiftUrgency(iso('2026-12-01T16:59:00Z'), iso('2026-12-01T20:00:00Z'), WINTER), 'TODAY'); // 16:59 GMT
      assert.equal(m.shiftUrgency(iso('2026-12-01T17:00:00Z'), iso('2026-12-01T20:00:00Z'), WINTER), 'TONIGHT');
    });
    test(`${name}: times are shown in London time`, () => {
      assert.equal(m.clockRange(iso('2026-10-10T10:00:00Z'), iso('2026-10-10T16:00:00Z')), '11:00–17:00');
      assert.equal(m.clockRange(iso('2026-12-10T11:00:00Z'), iso('2026-12-10T17:00:00Z')), '11:00–17:00');
      assert.equal(m.shortDate(iso('2026-10-10T10:00:00Z')), 'Sat 10 Oct');
    });
  }
});

describe('the seed state', () => {
  for (const [name, m] of MODELS) {
    test(`${name}: realistic formal jobs and exactly one invented casual shift`, () => {
      const w = m.buildWork('seed', undefined, { jobs: [], shifts: [] }, NOW);
      assert.ok(w.jobs.length >= 3);
      assert.deepEqual(new Set(w.jobs.map((j: any) => j.contract)), new Set(['permanent', 'apprenticeship', 'fixed-term']));
      assert.equal(w.shifts.length, 1);
      const s = w.shifts[0];
      assert.equal(s.title, 'Saturday café cover');
      assert.equal(s.where, 'Lerwick');
      assert.equal(s.rate, '£13.50/hr');
      assert.equal(m.clockRange(s.startAt, s.endAt), '11:00–17:00');
      assert.equal(m.shortDate(s.startAt).slice(0, 3), 'Sat');
      assert.match(s.employer, /^Sample /, 'not attributable to a real employer');
      assert.equal(s.sample, true);
      assert.equal(m.shiftUrgency(s.startAt, s.endAt, NOW), 'THIS WEEK', 'Saturday is four days out from a Tuesday');
    });
    test(`${name}: on the Saturday itself it is TODAY, and after 17:00 it rolls to next week`, () => {
      const morning = m.buildWork('seed', undefined, { jobs: [], shifts: [] }, new Date('2026-10-10T08:00:00Z')).shifts[0];
      assert.equal(m.shiftUrgency(morning.startAt, morning.endAt, new Date('2026-10-10T08:00:00Z')), 'TODAY');
      const evening = m.buildWork('seed', undefined, { jobs: [], shifts: [] }, new Date('2026-10-10T17:30:00Z')).shifts[0];
      assert.equal(m.shortDate(evening.startAt), 'Sat 17 Oct');
      assert.equal(m.shiftUrgency(evening.startAt, evening.endAt, new Date('2026-10-10T17:30:00Z')), null);
    });
    test(`${name}: the old build-144 "Bar cover" sample is not reused anywhere in the preview data`, () => {
      for (const st of ['seed', 'full', 'empty', 'live']) {
        assert.doesNotMatch(JSON.stringify(m.buildWork(st, undefined, { jobs: [], shifts: [] }, NOW)), /bar cover/i);
      }
    });
  }
});

describe('the populated state scales without listing everything', () => {
  for (const [name, m] of MODELS) {
    test(`${name}: several shifts and jobs; Home curates one timely shift first; Local stays compact`, () => {
      const w = m.buildWork('full', undefined, { jobs: [], shifts: [] }, NOW);
      assert.ok(w.shifts.length >= 4 && w.jobs.length >= 6);
      const labels = w.shifts.map((s: any) => m.shiftUrgency(s.startAt, s.endAt, NOW));
      assert.ok(['TODAY', 'TONIGHT', 'TOMORROW', 'THIS WEEK'].every((l) => labels.includes(l)), `labels ${labels}`);
      assert.deepEqual(w.shifts.map((s: any) => s.startAt), [...w.shifts.map((s: any) => s.startAt)].sort(), 'most imminent first');
      const h = m.curateHome(w);
      assert.equal(h.shifts.length, 1);
      assert.ok(h.jobs.length >= 2 && h.jobs.length <= 4);
      assert.equal(h.moreShifts, w.shifts.length - 1);
      const l = m.curateLocal(w);
      assert.ok(l.shifts.length <= 2 && l.shifts.length + l.jobs.length <= 4);
    });
  }
});

describe('the live state never invents a shift', () => {
  const realJob = { kind: 'job', id: 'j1', title: 'Teacher of English', employer: 'Shetland Islands Council', where: 'Lerwick', pay: null, contract: 'permanent', href: '/jobs/j1' };
  const realShift = { kind: 'shift', id: 's1', title: 'Real shift', employer: 'A real employer', where: 'Brae', startAt: iso('2026-10-07T08:00:00Z'), endAt: iso('2026-10-07T12:00:00Z'), rate: '£12/hr', href: '/shifts/s1' };
  for (const [name, m] of MODELS) {
    test(`${name}: production holds no shift → jobs only`, () => {
      const w = m.buildWork('live', undefined, { jobs: [realJob], shifts: [] }, NOW);
      assert.equal(w.shifts.length, 0);
      assert.equal(w.jobs.length, 1);
    });
    test(`${name}: the ?work= override cannot add a shift to live`, () => {
      for (const mix of ['both', 'shifts', 'jobs', 'none']) {
        const w = m.buildWork('live', mix, { jobs: [realJob], shifts: [] }, NOW);
        assert.equal(w.shifts.length, 0, mix);
        assert.equal(w.jobs.length, 1, mix);
      }
    });
    test(`${name}: a real shift passes straight through, ordered, and an ended one is dropped`, () => {
      const ended = { ...realShift, id: 's0', startAt: iso('2026-10-05T08:00:00Z'), endAt: iso('2026-10-05T12:00:00Z') };
      const w = m.buildWork('live', undefined, { jobs: [], shifts: [realShift, ended] }, NOW);
      assert.deepEqual(w.shifts.map((s: any) => s.id), ['s1']);
    });
    test(`${name}: sample items never leak into live`, () => {
      assert.doesNotMatch(JSON.stringify(m.buildWork('live', undefined, { jobs: [realJob], shifts: [] }, NOW)), /sample/i);
    });
  }
});

describe('combinations and the empty state', () => {
  for (const [name, m] of MODELS) {
    test(`${name}: empty → neither; seed overrides give jobs-only, shifts-only, none`, () => {
      const none = { jobs: [], shifts: [] };
      assert.deepEqual(m.buildWork('empty', undefined, none, NOW), none);
      assert.deepEqual(m.buildWork('empty', 'both', none, NOW), none);
      const jobsOnly = m.buildWork('seed', 'jobs', none, NOW);
      assert.ok(jobsOnly.jobs.length > 0 && jobsOnly.shifts.length === 0);
      const shiftsOnly = m.buildWork('seed', 'shifts', none, NOW);
      assert.ok(shiftsOnly.shifts.length > 0 && shiftsOnly.jobs.length === 0);
      assert.deepEqual(m.buildWork('seed', 'none', none, NOW), none);
    });
    test(`${name}: curation with shifts only, jobs only`, () => {
      const jobsOnly = m.buildWork('full', 'jobs', { jobs: [], shifts: [] }, NOW);
      assert.equal(m.curateHome(jobsOnly).shifts.length, 0);
      assert.ok(m.curateHome(jobsOnly).jobs.length >= 3);
      assert.equal(m.curateLocal(jobsOnly).shifts.length, 0);
      const shiftsOnly = m.buildWork('full', 'shifts', { jobs: [], shifts: [] }, NOW);
      assert.equal(m.curateHome(shiftsOnly).jobs.length, 0);
      assert.ok(m.curateHome(shiftsOnly).shifts.length >= 1);
    });
  }
});

describe('routing — "See all jobs & shifts" goes to the Work hub', () => {
  const j = { jobs: [{}], shifts: [] }, s = { jobs: [], shifts: [{}] }, both = { jobs: [{}], shifts: [{}] };
  test('web: /jobs, or /jobs?tab=shifts when there is nothing but shifts', { skip: web ? false : 'no web checkout' }, () => {
    assert.equal(web.workHubHref(j), '/jobs');
    assert.equal(web.workHubHref(both), '/jobs');
    assert.equal(web.workHubHref(s), '/jobs?tab=shifts');
  });
  test('the routes exist: web /jobs (+ ?tab=shifts, and /shifts redirects there); app (tabs)/jobs reads ?tab=', { skip: haveWeb ? false : 'no web checkout' }, () => {
    assert.ok(existsSync(join(WEB, 'app/jobs/page.tsx')));
    assert.match(code(join(WEB, 'app/jobs/page.tsx')), /tab === "shifts"/);
    assert.match(code(join(WEB, 'app/shifts/page.tsx')), /redirect\("\/jobs\?tab=shifts"\)/);
  });
  test('the CTA copy is exactly "See all jobs & shifts" on web and app', { skip: haveWeb ? false : 'no web checkout' }, () => {
    assert.match(code(join(WEB, 'components/preview/v2/WorkV2.tsx')), /label: "See all jobs & shifts"/);
    assert.match(code(join(REPO, 'components/home-local/WorkModule.tsx')), /See all jobs &amp; shifts →/);
  });
});

describe('surfaces', () => {
  test('web Home and Local V2 use the shared Work module; the old jobs-only modules are gone', { skip: haveWeb ? false : 'no web checkout' }, () => {
    assert.match(code(join(WEB, 'app/preview/home-v2/page.tsx')), /<HomeWork /);
    assert.match(code(join(WEB, 'app/preview/local-v2/page.tsx')), /<LocalWork /);
    assert.doesNotMatch(code(join(WEB, 'components/preview/v2/HomeV2.tsx')), /Who's hiring|View all jobs/);
    assert.doesNotMatch(code(join(WEB, 'components/preview/v2/LocalV2.tsx')), /Hiring locally|JobsCompact/);
  });
  test('live data is only ever read: no write calls in either Work data path', { skip: haveWeb ? false : 'no web checkout' }, () => {
    for (const f of [join(WEB, 'lib/preview-work.ts'), join(WEB, 'lib/preview-work-live.ts'), join(REPO, 'components/home-local/work.ts'), join(REPO, 'components/home-local/data.ts')]) {
      assert.doesNotMatch(code(f), /\.(insert|update|upsert|delete|rpc)\(/, f);
    }
  });
  test('the live data path has no fallback shift: nothing in it can produce a shift except a real row', { skip: haveWeb ? false : 'no web checkout' }, () => {
    const live = code(join(WEB, 'lib/preview-work-live.ts'));
    assert.match(live, /getOpenShifts\(\)\.catch\(\(\) => \[\]\)/);
    assert.doesNotMatch(live, /sample|SAMPLE/);
    assert.doesNotMatch(code(join(REPO, 'components/home-local/data.ts')), /sample.?shift|SAMPLE_SHIFTS/i);
  });
  test('production Home / Local never mention the Work preview', { skip: haveWeb ? false : 'no web checkout' }, () => {
    assert.doesNotMatch(code(join(WEB, 'app/page.tsx')) + code(join(WEB, 'app/local/page.tsx')), /preview-work|WorkV2|HomeWork|LocalWork/);
  });
});
