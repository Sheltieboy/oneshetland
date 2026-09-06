/**
 * gift-claimed-pass-ux.node.test.ts — the value moved; it was not spent.
 *
 * WHAT WAS WRONG
 *
 * Claiming a unit gift creates the pass and sets book_gifts.status = 'used' —
 * correct, because the gift has done its job. The page then said "Used", filed
 * it under "Already used", and opening it said "This gift has already been
 * claimed". A recipient holding a brand-new 3-use pass was told, in three
 * places, that their gift was gone.
 *
 * Nothing underneath is wrong and nothing underneath changed. This is the
 * explanation.
 *
 * WHAT IS ASSERTED
 *   · a claimed UNIT gift reads "Claimed ✓", never "Used"
 *   · it says the pass exists, and offers a way to it
 *   · the success state after claiming names the product and the uses
 *   · the pass is found through book_unit_purchases.gift_id — not the code
 *   · BOOKING gifts keep their own wording and their Pick a time flow
 *   · claiming still goes through claim_gift_by_id, and nothing re-claims on
 *     render, so reopening cannot mint a second pass
 *   · no backend status, claim, payment or migration changed
 *
 * SAFETY
 * Reads web source. No database, no network, no writes, no gift claimed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const CLIENT = join(WEB, 'app/account/gifts/GiftsClient.tsx');
const DATA = join(WEB, 'lib/passes-data.ts');

const src = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('a claimed unit gift is described as claimed, not spent', () => {
  const c = code(CLIENT);

  test('the badge says Claimed for a unit gift', () => {
    assert.match(c, /gift\.kind === "unit" \? "Claimed ✓" : "Used"/,
      'the used badge does not distinguish a unit gift that became a pass');
  });

  test('and the section is no longer called "Already used"', () => {
    assert.doesNotMatch(c, /Already used/,
      'a gift that became a full pass was filed under "Already used"');
    assert.match(c, /uppercase tracking-widest text-ink-muted">Claimed</);
  });

  test('it says where the value went', () => {
    assert.match(c, /Added to <span className="font-semibold text-ink">My passes<\/span>/);
  });

  test('and offers a way to get there', () => {
    assert.match(c, /href="\/account\/passes"[\s\S]{0,220}View pass/);
  });

  test('the uses left are shown when the pass is known', () => {
    assert.match(c, /pass\.uses_remaining\} use\$\{pass\.uses_remaining === 1 \? "" : "s"\} left/);
  });
});

describe('the success state after claiming', () => {
  const c = code(CLIENT);

  test('it congratulates and names the product', () => {
    assert.match(c, /Gift claimed!/);
    assert.match(c, /\{justClaimed\.name\}<\/span> has been added to My passes\./);
  });

  test('it states the uses available', () => {
    assert.match(c, /\{justClaimed\.pass\.uses_remaining\} use\{justClaimed\.pass\.uses_remaining === 1 \? "" : "s"\} available/);
  });

  test('the primary CTA is View my pass', () => {
    assert.match(c, /href="\/account\/passes"[\s\S]{0,200}View my pass/);
  });

  test('it is set from the claim, not guessed on render', () => {
    assert.match(c, /await claimGiftById\(g\.gift_id\)/);
    assert.match(c, /setJustClaimed\(\{/);
  });

  test('a missing pass costs the explanation, never the gift', () => {
    // uses/expiry are rendered only when the pass resolved.
    assert.match(c, /\{justClaimed\.pass && typeof justClaimed\.pass\.uses_remaining === "number" && \(/);
    assert.match(c, /pass: mine\.find\(\(x\) => x\.gift_id === g\.gift_id\) \?\? null/);
  });
});

describe('the pass is found by the relationship, not by the code', () => {
  test('book_unit_purchases.gift_id is what resolves it', () => {
    const c = code(CLIENT);
    assert.match(c, /passes\.find\(\(p\) => p\.gift_id === g\.id\)/);
    assert.doesNotMatch(c, /passes\.find\([^)]*code/, 'the pass must not be resolved through a gift code');
  });

  test('MyPass carries gift_id, and it was already selected and owner-scoped', () => {
    const d = code(DATA);
    assert.match(d, /gift_id: string \| null;/);
    assert.match(d, /gift_id: \(r\.gift_id as string \| null\) \?\? null/);
    const fn = d.slice(d.indexOf('export async function fetchMyPasses'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /\.eq\("owner_id", auth\.user\.id\)/, 'the pass read must stay owner-scoped');
    assert.match(body, /gift_id/);
  });

  test('no gift code is introduced into the pass lookup', () => {
    const d = code(DATA);
    const fn = d.slice(d.indexOf('export async function fetchMyPasses'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.doesNotMatch(body, /\bcode\b/, 'the pass query has no business with a gift code');
  });
});

describe('booking gifts keep their own lifecycle', () => {
  const c = code(CLIENT);

  test('the unit wording is gated on kind', () => {
    const occurrences = c.match(/gift\.kind === "unit" && gift\.status === "used"/g) ?? [];
    assert.ok(occurrences.length >= 2,
      'the "Added to My passes" copy and the View pass CTA must both be unit-only');
  });

  test('Pick a time is untouched', () => {
    assert.match(c, /const isBookingPending = gift\.kind === "booking" && gift\.status === "claimed" && !gift\.booked/);
    assert.match(c, /Pick a time/);
    assert.match(c, /\?book=\$\{gift\.service_id \?\? ""\}&gift=\$\{gift\.id\}/);
  });

  test('a booking gift is never told it became a pass', () => {
    // The only paths that mention passes are the unit-gated ones above.
    const passMentions = c.match(/Added to <span/g) ?? [];
    assert.equal(passMentions.length, 1, 'the pass explanation appears in more than one place');
  });
});

describe('nothing underneath moved', () => {
  test('claiming still goes through claim_gift_by_id', () => {
    const d = code(DATA);
    assert.match(d, /rpc\("claim_gift_by_id", \{ p_gift_id: giftId \}\)/);
  });

  test('nothing claims on render, so reopening cannot mint a second pass', () => {
    const c = code(CLIENT);
    const useEffectBlock = c.slice(c.indexOf('useEffect(('), c.indexOf('}, []);'));
    assert.doesNotMatch(useEffectBlock, /claimGiftById/,
      'claiming from an effect would re-claim on every render');
  });

  // Was `git status supabase/migrations` must be empty — true of the task that
  // wrote it, and false the moment any later approved migration lands. It meant
  // "this is presentation only", so it now says that about the files it guards
  // rather than about the whole repository.
  test('the gift UX is presentation only — no SQL, no schema, in these files', () => {
    for (const f of [CLIENT, DATA]) {
      const c = code(f);
      assert.doesNotMatch(c, /\b(create|alter|drop)\s+(table|function|policy|index)\b/i,
        `${f.split('/').pop()} contains DDL`);
      assert.doesNotMatch(c, /\bfrom\("book_gifts"\)[\s\S]{0,200}\.update\(/,
        `${f.split('/').pop()} writes gift state directly`);
    }
  });

  test('and it writes no gift or pass state of its own', () => {
    const c = code(CLIENT);
    assert.doesNotMatch(c, /\.update\(\{/, 'the page performs a direct table write');
    assert.doesNotMatch(c, /uses_remaining:\s*\d/, 'the page invents a balance');
  });

  test('the RPCs themselves are untouched in the migration chain', () => {
    const mig = src(join(REPO_ROOT, 'supabase/migrations/20260930120000_my_unclaimed_gifts.sql'));
    assert.match(mig, /return public\.claim_gift\(v_code\);/, 'claim delegation changed');
    assert.doesNotMatch(mig, /update public\.book_gifts set status/, 'the migration now writes gift status');
  });
});
