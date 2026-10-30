/**
 * job-taxonomy.node.test.ts — the shared jobs vocabulary (categories, contract types, areas, closing dates).
 *
 * Runs the REAL module against the 30 live council titles/locations audited on 30 Oct 2026 (Stage 1) and pins the three copies
 * (app lib/, edge _shared/, web lib/) to be byte-identical so the sync, the app and the website can never disagree.
 * No network, no database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../../lib/job-taxonomy.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// [title, location] for the 30 production jobs as audited.
const AUDITED: [string, string][] = [
  ['Engineer MV Hendra', 'Hendra Ferry, Shetland Islands'], ['Director of Place', '8 North Ness, Lerwick'],
  ['Learning Support Worker - Severe & Complex Needs - Anderson High School', 'Anderson High School, Lerwick'],
  ['Play Practitioner - Islesburgh Out of School Club', 'Islesburgh Community Centre, Lerwick'],
  ['Domestic Assistant - Fernlea Care Services', 'Fernlea Care Centre, Whalsay'],
  ['Teacher of Craft, Design & Technology - Aith Junior High School', 'Aith Junior High School, Aith'],
  ['Learning Support Worker - Brae High School', 'Brae High School, Brae'],
  ['Social Care Worker - Montfield Support Services', 'Montfield Support Services, Lerwick'],
  ['Relief Trainers - Human Resources', '8 North Ness, Lerwick'], ['Head Teacher - Whalsay School', 'Whalsay School, Whalsay'],
  ['Learning Support Assistant - Whalsay School', 'Whalsay School, Whalsay'],
  ['Social Care Worker - Mental Health Community Support Services', 'Annsbrae House, Lerwick'],
  ['Social Care Worker - Practitioner - Overtonlea Care Services', 'Overtonlea Care Centre, Levenwick'],
  ['Supervisory Assistant - Whalsay School', 'Whalsay School, Whalsay'],
  ['Teacher of Additional Support Needs (Complex Needs) - Anderson High School', 'Anderson High School, Lerwick'],
  ['ASN/Social Care PCV Driver', '8 North Ness, Lerwick'], ['Research & Information Officer - Housing', '8 North Ness, Lerwick'],
  ['Social Care Worker Practitioner - Newcraigielea', 'Newcraigielea, Lerwick'],
  ['Teacher of Primary - Mid Yell Junior High School & Cullivoe Primary School', 'Shetland (see advert), Shetland Islands'],
  ['Cook in Charge - Happyhansel Primary School', 'Happy Hansel Primary School, Walls'],
  ['Relief Cleaners - Sound School', 'Sound Primary School, Lerwick'], ['Social Care Workers - Newcraigielea', 'Newcraigielea, Lerwick'],
  ['Social Workers - Adult Social Work - Grantfield', 'Grantfield, Lerwick'],
  ['Learning Support Worker - Early Learning & Childcare - Lunnasting Primary School', 'Lunnasting Primary School, Vidlin'],
  ['Relief Assistant Cook - Isleshavn Care Services', 'Isleshavn Care Centre, Mid Yell'],
  ['Relief Domestic Assistants - Isleshavn Care Services', 'Isleshavn Care Centre, Mid Yell'],
  ['Relief Kitchen Assistants - Isleshavn Care Services', 'Isleshavn Care Centre, Mid Yell'],
  ['Social Worker - Mental Health Officer - Adult Social Work', 'Grantfield, Lerwick'],
  ['Relief Bank for Teachers (Primary and Secondary)', 'Shetland (see advert), Shetland Islands'],
  ['Supply for Early Learning & Childcare, Learning Support and Out of School Clubs', 'Shetland (see advert), Shetland Islands'],
];

describe('categories', () => {
  test('canonical vocabulary is the 16 the website already offered, in order', () => {
    assert.deepEqual([...T.JOB_CATEGORIES], ['Hospitality', 'Maritime', 'Aquaculture', 'Energy', 'Care', 'Health', 'Retail', 'Trades', 'Construction', 'Tourism', 'Education', 'Public sector', 'Office & admin', 'Transport', 'Crofting', 'Other']);
  });
  test('null, empty, wrong-type and unknown categories normalise to null and never throw', () => {
    for (const v of [null, undefined, '', '  ', 42, {}, [], 'Astronaut']) assert.equal(T.normaliseJobCategory(v), null);
    assert.equal(T.normaliseJobCategory(' care '), 'Care');
    assert.equal(T.normaliseJobCategory('PUBLIC SECTOR'), 'Public sector');
  });
  test('chips come only from categories in use: an all-null feed yields none, unknowns are ignored, order is canonical', () => {
    assert.deepEqual(T.jobCategoriesInUse(new Array(30).fill(null)), []);
    assert.deepEqual(T.jobCategoriesInUse(['Education', 'Care', 'Care', 'Astronaut', null]), ['Care', 'Education']);
  });
  test('categoryFromTitle is deterministic and conservative against all 30 audited titles', () => {
    const out = AUDITED.map(([t]) => [t, T.categoryFromTitle(t)] as const);
    const by = (t: string) => out.find(([x]) => x === t)![1];
    assert.equal(by('Social Care Worker - Montfield Support Services'), 'Care');
    assert.equal(by('Social Care Workers - Newcraigielea'), 'Care');
    assert.equal(by('Head Teacher - Whalsay School'), 'Education');
    assert.equal(by('Teacher of Additional Support Needs (Complex Needs) - Anderson High School'), 'Education');
    // ambiguous or unevidenced -> null, never guessed
    assert.equal(by('Engineer MV Hendra'), null);
    assert.equal(by('Director of Place'), null);
    assert.equal(by('Cook in Charge - Happyhansel Primary School'), null);
    assert.equal(by('ASN/Social Care PCV Driver'), null, 'matches Care AND Transport words -> ambiguous');
    assert.equal(by('Relief Cleaners - Sound School'), null);
    assert.ok(out.filter(([, c]) => c !== null).length <= 12, 'the framework must not categorise most of the feed on weak evidence');
    assert.equal(T.categoryFromTitle(null), null);
    assert.equal(T.categoryFromTitle(''), null);
  });
});

describe('contract types', () => {
  test("Temporary is its own type with its own label — it is not Casual", () => {
    assert.ok((T.JOB_CONTRACT_TYPES as readonly string[]).includes('temporary'));
    assert.equal(T.contractLabel('temporary'), 'Temporary');
    assert.notEqual(T.contractLabel('temporary'), T.contractLabel('casual'));
  });
  test('every known type has a label; an unknown or blank value is shown tidily, not thrown on', () => {
    for (const t of T.JOB_CONTRACT_TYPES) assert.ok(T.contractLabel(t));
    assert.equal(T.contractLabel('fixed_term'), 'Fixed term');
    assert.equal(T.contractLabel(null), '');
    assert.equal(T.contractLabel('  '), '');
  });
});

describe('areas', () => {
  test('the agreed vocabulary is complete', () => {
    for (const a of ['Lerwick', 'Scalloway', 'Bressay', 'Burra', 'South Mainland', 'Westside', 'North Mainland', 'Brae / Sullom Voe', 'Whalsay', 'Yell', 'Unst', 'Fetlar', 'Shetland-wide', 'Offshore / marine', 'Remote / hybrid']) assert.ok((T.JOB_AREAS as readonly string[]).includes(a), a);
  });
  test('audited council locations map from explicit tokens only', () => {
    const area = (loc: string) => T.areaForLocation(loc);
    assert.equal(area('8 North Ness, Lerwick'), 'Lerwick');
    assert.equal(area('Whalsay School, Whalsay'), 'Whalsay');
    assert.equal(area('Isleshavn Care Centre, Mid Yell'), 'Yell');
    assert.equal(area('Overtonlea Care Centre, Levenwick'), 'South Mainland');
    assert.equal(area('Aith Junior High School, Aith'), 'Westside');
    assert.equal(area('Happy Hansel Primary School, Walls'), 'Westside');
    assert.equal(area('Lunnasting Primary School, Vidlin'), 'North Mainland');
    assert.equal(area('Brae High School, Brae'), 'Brae / Sullom Voe');
    assert.equal(area('Sullom Voe Terminal'), 'Brae / Sullom Voe', '"Voe" must not also claim North Mainland');
    assert.equal(area('Shetland (see advert), Shetland Islands'), 'Shetland-wide');
  });
  test('never inferred from nothing: unknown, blank and contradictory places give null', () => {
    assert.equal(T.areaForLocation('Hendra Ferry, Shetland Islands'), null);
    for (const v of [null, undefined, '', '   ', 7]) assert.equal(T.areaForLocation(v), null);
    assert.equal(T.areaForLocation('Between Lerwick and Unst'), null);
    assert.equal(T.areaForLocation('Anywhere in the world'), null);
  });
});

describe('closing dates', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z');
  test('shows "Closes 6 Nov" for a future date, in Shetland time', () => {
    assert.equal(T.closingLabel('2026-11-06T23:59:00Z', NOW), 'Closes 6 Nov');
  });
  test('today / tomorrow / already closed', () => {
    assert.equal(T.closingLabel('2026-10-30T23:00:00Z', NOW), 'Closes today');
    assert.equal(T.closingLabel('2026-10-31T10:00:00Z', NOW), 'Closes tomorrow');
    assert.equal(T.closingLabel('2026-10-28T10:00:00Z', NOW), 'Closed 28 Oct');
  });
  test('subtle urgency: "Closes in N days" for 2-5 days out, plain date beyond', () => {
    assert.equal(T.closingLabel('2026-11-02T23:59:00Z', NOW), 'Closes in 3 days');
    assert.equal(T.closingLabel('2026-11-04T23:59:00Z', NOW), 'Closes in 5 days');
    assert.equal(T.closingLabel('2026-11-05T23:59:00Z', NOW), 'Closes 5 Nov');
    assert.equal(T.closingLabel('2026-11-06T23:59:00Z', NOW), 'Closes 6 Nov');
  });
  test('no closing date -> nothing is invented; garbage -> nothing', () => {
    for (const v of [null, undefined, '', 'not a date', 5]) assert.equal(T.closingLabel(v, NOW), '');
  });
  test('the label uses the Shetland day even when the UTC day differs (BST)', () => {
    assert.equal(T.closingLabel('2026-07-01T23:30:00Z', Date.parse('2026-06-01T12:00:00Z')), 'Closes 2 Jul');
  });
  test('isJobExpired: past -> expired, future/null -> not', () => {
    assert.equal(T.isJobExpired('2026-10-29T00:00:00Z', NOW), true);
    assert.equal(T.isJobExpired('2026-11-06T00:00:00Z', NOW), false);
    assert.equal(T.isJobExpired(null, NOW), false);
  });
  test('default employer expiry is exactly 30 days after publication', () => {
    assert.equal(T.EMPLOYER_DEFAULT_DAYS, 30);
    assert.equal(T.defaultExpiryIso(Date.parse('2026-10-30T12:00:00Z')), '2026-11-29T12:00:00.000Z');
  });
});

describe('closing instant for a chosen date', () => {
  test('a date closes at the end of that Shetland day, in winter (GMT) and summer (BST)', () => {
    assert.equal(T.closingInstantForDate('2026-11-06'), '2026-11-06T23:59:59.000Z');
    assert.equal(T.closingInstantForDate('2026-07-01'), '2026-07-01T22:59:59.000Z');
    assert.equal(T.shetlandDateOf(T.closingInstantForDate('2026-07-01')!), '2026-07-01');
  });
  test('malformed dates give null', () => {
    for (const v of [null, '', '6 Nov', '2026-13-40x', 20261106]) assert.equal(T.closingInstantForDate(v), null);
  });
});

describe('the three copies cannot drift', () => {
  test('app lib, edge _shared and web lib are byte-identical', () => {
    const app = read('lib/job-taxonomy.ts');
    assert.equal(read('supabase/functions/_shared/job-taxonomy.ts'), app);
    const web = join(ROOT, '..', 'oneshetland-web-launch-testing', 'lib', 'job-taxonomy.ts');
    if (existsSync(web)) assert.equal(readFileSync(web, 'utf8'), app, 'web copy differs');
  });
});
