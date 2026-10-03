/**
 * jobs-listing.node.test.ts — what the public Jobs list shows, and that it fits a phone.
 *
 * Production audit (3 Oct 2026): the Jobs list was correct (exactly the open, unhidden, unexpired rows) but on a
 * phone the page was 876 px wide in a 375 px viewport. The list grid had an implicit auto column on mobile; an
 * auto track grows to the longest nowrap line, so one long job title pushed every card (857 px) off the edge.
 * Tailwind's grid-cols-1 is minmax(0,1fr), which can shrink.
 *
 * Also holds down that expired jobs are hidden in THREE independent places, which is what kept four closed
 * jobs invisible while the feed was stale.
 *
 * Source-level and read-only. Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(MOBILE, '..', 'oneshetland-web');
const have = existsSync(join(WEB, 'app/jobs/page.tsx'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const web = (p: string) => code(readFileSync(join(WEB, p), 'utf8'));

describe('the Jobs list fits a phone', opts, () => {
  test('THE DEFECT: both list grids start from a shrinkable single column, not an implicit auto track', () => {
    const src = web('app/jobs/page.tsx');
    const grids = src.match(/<div className="grid [^"]*sm:grid-cols-2 lg:grid-cols-3">/g) ?? [];
    assert.equal(grids.length, 2, 'the jobs grid and the shifts grid');
    for (const g of grids) assert.match(g, /grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3/);
  });
  test('cards truncate their title and employer line instead of widening', () => {
    const ui = web('components/jobs/JobsUI.tsx');
    const card = ui.slice(ui.indexOf('export function JobCard'), ui.indexOf('export function ShiftCard'));
    assert.match(card, /min-w-0 flex-1/);
    assert.match(card, /<h3 className="truncate/);
    assert.match(card, /<p className="mt-0\.5 truncate/);
  });
});

describe('expired jobs never show (three independent guards)', opts, () => {
  test('web list and featured queries filter on expires_at', () => {
    const d = web('lib/jobs-data.ts');
    assert.equal((d.match(/expires_at\.is\.null,expires_at\.gt\./g) ?? []).length, 2);
    assert.match(d, /\.eq\("is_hidden", false\)\.eq\("status", "open"\)/);
  });
  test('the app query filters on expires_at', () => {
    assert.match(code(readFileSync(join(MOBILE, 'lib/jobs-api.ts'), 'utf8')), /expires_at\.is\.null,expires_at\.gt\./);
  });
  test('row security hides a job once expires_at passes, whatever any client asks for', () => {
    const sql = readdirSync(join(MOBILE, 'supabase/migrations')).map((n) => readFileSync(join(MOBILE, 'supabase/migrations', n), 'utf8')).join('\n');
    assert.match(sql, /"jobs read" ON public\.jobs FOR SELECT USING \(\(\(\(NOT is_hidden\) AND \(\(expires_at IS NULL\) OR \(expires_at > now\(\)\)\)\) OR \(EXISTS/);
  });
});
