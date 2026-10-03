/**
 * events-listing.node.test.ts — what the public What's On list shows, and that it fits a phone.
 *
 * Production audit (3 Oct 2026): the list was correct (it showed exactly the published, approved, not-yet-ended
 * events) but on a phone the page was 636 px wide in a 375 px viewport. The date-grouped list used an implicit
 * auto grid column; an auto track grows to the longest nowrap line, and Mareel's venue name alone is 44
 * characters, so every Mareel row pushed the whole page sideways. The column is now minmax(0,1fr).
 *
 * Source-level and read-only. Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const have = existsSync(join(WEB, 'components/events/EventsListing.tsx'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => code(readFileSync(join(WEB, p), 'utf8'));

describe('the list fits a phone', opts, () => {
  const src = () => read('components/events/EventsListing.tsx');
  test('THE DEFECT: the day groups use a shrinkable column, not an auto track', () => {
    assert.match(src(), /className="grid grid-cols-\[minmax\(0,1fr\)\] gap-5 md:grid-cols-\[170px_minmax\(0,1fr\)\]"/);
    assert.doesNotMatch(src(), /className="grid gap-5 md:grid-cols-\[170px_1fr\]"/);
  });
  test('rows truncate long titles and venue lines instead of widening', () => {
    const row = src().slice(src().indexOf('function EventRow'));
    assert.match(row, /min-w-0 flex-1/);
    assert.match(row, /<h3 className="truncate/);
    assert.match(row, /<p className="mt-0\.5 truncate/);
  });
});

describe('what counts as upcoming and public', opts, () => {
  const data = () => read('lib/events-data.ts');
  test('only published events, and hub events only once the calendar has approved them', () => {
    assert.match(data(), /\.eq\("status", "published"\)/);
    assert.match(data(), /\.or\("organiser_hub_id\.is\.null,calendar_approved\.eq\.true"\)/);
  });
  test('an event stays listed until it has ENDED (a multi-day festival is not dropped on day two)', () => {
    assert.match(data(), /ends_at\.gte\.\$\{now\},and\(ends_at\.is\.null,starts_at\.gte\.\$\{now\}\)/);
  });
  test('the list is ordered by start time', () => {
    assert.match(data(), /\.order\("starts_at", \{ ascending: true \}\)/);
  });
});
