/**
 * bookings-canonical-time.node.test.ts — a Shetland appointment is a Shetland
 * hour, wherever it is read.
 *
 * WHAT WAS WRONG
 *
 * Booking 1fe3289a — Mens fade at Anderson & Co, 09:30 on Mon 7 Sep 2026 — was
 * stored correctly as 2026-09-07 08:30:00+00, which IS 09:30 in Europe/London
 * because September is BST. The customer's confirmation said 09:30, the
 * bookings manager said 09:30, and Business Home said 08:30.
 *
 * Nothing was converted wrongly and no data was wrong. `toLocaleString` with no
 * `timeZone` answers with whatever clock the machine running it keeps.
 * BookServiceModal, BookingsClient and BookingsManager are client components,
 * so they inherited the browser's Europe/London and were right by luck.
 * DashboardTop has no "use client", renders on Netlify, and Netlify keeps UTC.
 *
 * The same luck covered mobile: a phone in Shetland is on Europe/London, so a
 * customer opening the app abroad would have been told the wrong hour.
 *
 * It is seasonal, which is why it survived — correct in GMT, an hour out for
 * the seven months of BST.
 *
 * WHAT IS ASSERTED
 *   · the reported booking reads 09:30 through the REAL formatter options,
 *     lifted from source and executed, not re-typed here
 *   · BST converts and GMT gets no phantom +1 — so the fix is the timezone
 *     database and not a hard-coded hour
 *   · the same booking reads the same hour under TZ=UTC, Europe/London and
 *     America/New_York
 *   · every booking-facing formatter in both repos names the zone
 *   · notifications and reminders are untouched and still name it
 *
 * SAFETY
 * Reads source from both repositories and runs node subprocesses. No database,
 * no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');

/** The booking that exposed this. Stored instant; 09:30 Europe/London. */
const REPORTED = '2026-09-07T08:30:00Z';

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Lift a real `toLocale*` options object out of source, by the text that
 * uniquely identifies its call site. Re-typing the options here would prove
 * only that a literal I wrote agrees with itself.
 */
function optionsAt(path: string, anchor: string): string {
  const src = read(path);
  const i = src.indexOf(anchor);
  assert.notEqual(i, -1, `anchor not found in ${path}: ${anchor}`);
  const open = src.indexOf('{', i);
  assert.notEqual(open, -1, `no options object after anchor in ${path}`);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  throw new Error(`unterminated options object in ${path}`);
}

/** The zone the app is actually configured with — read, not assumed, so that
 *  changing it (to a fixed offset, say) breaks the DST proofs below. */
function configuredZone(): string {
  const m = read(join(WEB, 'lib/shetland-time.ts')).match(/SHETLAND_TZ\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'SHETLAND_TZ is not defined in the web repo');
  return m![1];
}

/** Format an instant with those real options, in a process pinned to `tz`. */
function formatUnder(tz: string, iso: string, options: string, fn = 'toLocaleString'): string {
  const opts = options.replace(/SHETLAND_TZ/g, JSON.stringify(configuredZone()));
  const script = `process.stdout.write(new Date(${JSON.stringify(iso)}).${fn}("en-GB", ${opts}))`;
  return execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8', env: { ...process.env, TZ: tz },
  });
}

const DASH = join(WEB, 'components/business/DashboardTop.tsx');
const DASH_ANCHOR = 'new Date(iso).toLocaleString("en-GB",';

describe('the reported booking reads 09:30, through the real formatter', () => {
  test('Business Home, on a UTC server — the exact reported failure', () => {
    const out = formatUnder('UTC', REPORTED, optionsAt(DASH, DASH_ANCHOR));
    assert.match(out, /09:30/, `Business Home rendered "${out}" on a UTC server`);
    assert.ok(!out.includes('08:30'), `Business Home still shows the UTC clock: "${out}"`);
  });

  test('and it says Monday 7 September, not some other day', () => {
    const out = formatUnder('UTC', REPORTED, optionsAt(DASH, DASH_ANCHOR));
    assert.match(out, /Mon/);
    assert.match(out, /7 Sept/);
  });
});

describe('BST and GMT, decided by the timezone database', () => {
  test('September is BST: the stored instant is an hour later locally', () => {
    const out = formatUnder('UTC', '2026-09-07T08:30:00Z', optionsAt(DASH, DASH_ANCHOR));
    assert.match(out, /09:30/, 'BST did not add its hour');
  });

  test('January is GMT: no phantom +1', () => {
    // The failure mode of a hard-coded offset. 08:30Z in January IS 08:30 local.
    const out = formatUnder('UTC', '2026-01-07T08:30:00Z', optionsAt(DASH, DASH_ANCHOR));
    assert.match(out, /08:30/, `GMT gained an hour it should not have: "${out}"`);
    assert.ok(!out.includes('09:30'), `a fixed +1 offset was applied in winter: "${out}"`);
  });

  test('the boundary is the database, not a month number', () => {
    // BST 2026 ends 25 October. 01:30Z on the 25th is 01:30 GMT, not 02:30.
    const before = formatUnder('UTC', '2026-10-24T08:30:00Z', optionsAt(DASH, DASH_ANCHOR));
    const after  = formatUnder('UTC', '2026-10-26T08:30:00Z', optionsAt(DASH, DASH_ANCHOR));
    assert.match(before, /09:30/, 'still BST on 24 October');
    assert.match(after,  /08:30/, 'already GMT on 26 October');
  });
});

describe('the same booking reads the same hour on any runtime', () => {
  for (const tz of ['UTC', 'Europe/London', 'America/New_York']) {
    test(`TZ=${tz}`, () => {
      const out = formatUnder(tz, REPORTED, optionsAt(DASH, DASH_ANCHOR));
      assert.match(out, /09:30/, `TZ=${tz} rendered "${out}"`);
    });
  }

  test('all three agree exactly, character for character', () => {
    const outs = ['UTC', 'Europe/London', 'America/New_York']
      .map((tz) => formatUnder(tz, REPORTED, optionsAt(DASH, DASH_ANCHOR)));
    assert.equal(new Set(outs).size, 1, `runtimes disagreed: ${JSON.stringify(outs)}`);
  });
});

/** Booking-facing formatters, by repo. Each must name the zone. */
const WEB_SURFACES = [
  'components/business/DashboardTop.tsx',
  'components/business/BookingsManager.tsx',
  'components/local/BookServiceModal.tsx',
  'app/account/bookings/BookingsClient.tsx',
];
const MOBILE_SURFACES = [
  'app/local-my-bookings.tsx',
  'app/local-book-bookings.tsx',
  'lib/book-slots.ts',
];

/**
 * Every toLocale* call in a file, each paired with its OWN options object,
 * read by brace balance. A fixed-width window round the call site reaches into
 * the next call's options, so stripping one zone of two still looked covered —
 * the assertion passed on its neighbour.
 */
function localeCalls(src: string): string[] {
  const out: string[] = [];
  const re = /toLocale(?:String|TimeString|DateString)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const argsFrom = m.index + m[0].length;
    // No-argument number formatting: value.toLocaleString()
    if (src[argsFrom] === ')') { out.push(src.slice(m.index, argsFrom + 1)); continue; }
    const open = src.indexOf('{', argsFrom);
    const stop = src.indexOf(')', argsFrom);
    if (open === -1 || (stop !== -1 && stop < open)) { out.push(src.slice(m.index, stop + 1)); continue; }
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) { out.push(src.slice(m.index, j + 1)); break; }
      }
    }
  }
  return out;
}

describe('every booking-facing formatter names the zone', () => {
  test('the shared constant exists in both repos, and is Europe/London', () => {
    for (const p of [join(WEB, 'lib/shetland-time.ts'), join(REPO_ROOT, 'lib/shetland-time.ts')]) {
      assert.ok(existsSync(p), `${p} is missing`);
      assert.match(read(p), /SHETLAND_TZ\s*=\s*['"]Europe\/London['"]/, `${p} does not define the zone`);
    }
  });

  test('web surfaces', () => {
    for (const f of WEB_SURFACES) {
      const src = read(join(WEB, f));
      assert.match(src, /SHETLAND_TZ/, `${f} does not reference the canonical zone`);
      for (const call of localeCalls(src)) {
        // Number formatting (value.toLocaleString()) takes no options, no time.
        if (/^toLocaleString\(\)$/.test(call)) continue;
        assert.match(call, /timeZone:\s*SHETLAND_TZ/,
          `${f} formats a date without the zone: ${call.slice(0, 110)}`);
      }
    }
  });

  test('mobile surfaces use the zone rather than the device', () => {
    for (const f of MOBILE_SURFACES) {
      const src = read(join(REPO_ROOT, f));
      assert.match(src, /SHETLAND_TZ/, `${f} does not reference the canonical zone`);
      for (const call of localeCalls(src)) {
        if (/^toLocaleString\(\)$/.test(call)) continue;
        assert.match(call, /timeZone:\s*SHETLAND_TZ/,
          `${f} formats a date without the zone: ${call.slice(0, 110)}`);
      }
    }
  });

  test('the day a slot is filed under is the Shetland day, not the reader\'s', () => {
    assert.match(read(join(REPO_ROOT, 'lib/book-slots.ts')), /return shetlandDayKey\(d\)/,
      'mobile groups slots by the device calendar day');
    assert.match(read(join(WEB, 'components/local/BookServiceModal.tsx')), /const dayKey = shetlandDayKey/,
      'web groups slots by the device calendar day');
  });

  test('a slot just after Shetland midnight files under the right day everywhere', () => {
    const key = (tz: string) => execFileSync(process.execPath,
      ['-e', 'process.stdout.write(new Date("2026-09-07T00:30:00+01:00").toLocaleDateString("en-CA",{timeZone:"Europe/London"}))'],
      { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    for (const tz of ['UTC', 'Europe/London', 'America/New_York']) {
      assert.equal(key(tz), '2026-09-07', `TZ=${tz} filed the slot under the wrong day`);
    }
  });
});

describe('notifications and reminders are untouched', () => {
  test('notify-booking still names Europe/London', () => {
    const src = read(join(REPO_ROOT, 'supabase/functions/notify-booking/index.ts'));
    assert.match(src, /const londonWhen/, 'the booking notification formatter was renamed or removed');
    assert.match(src, /timeZone: 'Europe\/London'/, 'the booking notification lost its zone');
  });

  test('reminder-runner still names Europe/London', () => {
    const src = read(join(REPO_ROOT, 'supabase/functions/reminder-runner/index.ts'));
    const calls = localeCalls(src).filter((c) => /hour:|weekday:/.test(c));
    assert.ok(calls.length > 0, 'reminder-runner no longer formats a time');
    for (const c of calls) {
      assert.match(c, /timeZone: 'Europe\/London'/, `a reminder formatter lost its zone: ${c.slice(0, 110)}`);
    }
  });
});
