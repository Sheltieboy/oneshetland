/**
 * directory-claim-entry.node.test.ts — one claim, asked for once.
 *
 * WHAT WAS WRONG
 *
 * The Directory card's call to action reads "Own this business? Claim this
 * listing →", and pointed at `/directory/{slug}#claim` — a fragment on the
 * listing, not a route. It scrolled the visitor to a banner that asked the
 * same question again, and only that banner's button entered the claim flow.
 * So the owner had to say "this is my business" twice, and a signed-out owner
 * met the sign-in wall on the third step rather than the first.
 *
 * Found during a real production claim journey, on a Directory where 198
 * listings are unclaimed — the primary route by which a business joins.
 *
 * WHAT IS ASSERTED
 *   · the card CTA points at the canonical claim route, not an anchor
 *   · that route is the one that renders the existing BusinessClaimForm —
 *     there is no second claim form anywhere
 *   · the card's parameter is slug-or-id, and the claim page resolves it with
 *     the same getBusiness() the listing uses, so both forms still work
 *   · a signed-out visitor is returned to the CLAIM page after signing in,
 *     not to the listing
 *   · the listing keeps its own banner, for people who arrive there directly
 *
 * SAFETY
 * Reads source files from both repositories. No database, no network, no
 * writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');

const CARD = join(WEB, 'components/local/LocalUI.tsx');
const LISTING = join(WEB, 'app/directory/[id]/page.tsx');
const CLAIM = join(WEB, 'app/directory/[id]/claim/page.tsx');
const DATA = join(WEB, 'lib/local-data.ts');

/** Source with comments stripped — assertions must match code, not prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the claim is asked for once', () => {
  test('the web repository is present', () => {
    for (const f of [CARD, LISTING, CLAIM, DATA]) {
      assert.ok(existsSync(f), `${f} is missing — this suite reads the web repo`);
    }
  });

  test('the card CTA enters the claim route directly', () => {
    const src = code(CARD);
    assert.match(src, /href=\{`\$\{href\}\/claim`\}/,
      'the Directory card CTA does not point at the claim route');
    assert.ok(!/href=\{`\$\{href\}#claim`\}/.test(src),
      'the card CTA still points at the #claim anchor, so the claim is asked for twice');
  });

  test('nothing else links to the old anchor', () => {
    // The anchor id itself stays — the banner still needs somewhere to be.
    assert.ok(!/#claim`/.test(code(CARD)), 'a #claim link survives on the card');
  });

  test('that route is where the existing claim form lives', () => {
    assert.match(code(CLAIM), /BusinessClaimForm/,
      'the claim route no longer renders BusinessClaimForm');
    assert.match(code(CLAIM), /from ["']@\/components\/directory\/BusinessClaimForm["']/,
      'the claim route imports its form from somewhere new');
  });

  test('there is exactly one claim form in the web app', () => {
    // A second form is how two flows drift apart. One file defines it.
    const form = join(WEB, 'components/directory/BusinessClaimForm.tsx');
    assert.ok(existsSync(form), 'the canonical claim form has moved');
  });
});

describe('slug and id both still reach the claim page', () => {
  test('the card passes slug-or-id, unchanged', () => {
    assert.match(code(CARD), /const href = `\/directory\/\$\{b\.slug \?\? b\.id\}`/,
      'the card no longer builds its href from slug-or-id');
  });

  test('the claim page resolves that parameter the same way the listing does', () => {
    // Same resolver on both routes is what makes the card's slug safe to reuse.
    for (const [name, path] of [['listing', LISTING], ['claim', CLAIM]] as const) {
      assert.match(code(path), /getBusiness\(id\)/, `the ${name} route stopped using getBusiness(id)`);
      assert.match(code(path), /from ["']@\/lib\/local-data["']/, `the ${name} route imports getBusiness elsewhere`);
    }
  });

  test('getBusiness accepts either form', () => {
    const src = code(DATA);
    assert.match(src, /export async function getBusiness\(idOrSlug: string\)/,
      'getBusiness no longer takes an id-or-slug');
    assert.match(src, /UUID\.test\(idOrSlug\) \? ["']id["'] : ["']slug["']/,
      'getBusiness no longer branches between id and slug');
  });
});

describe('signing in returns you to the claim, not the listing', () => {
  test('the claim page sends signed-out visitors to sign-in', () => {
    assert.match(code(CLAIM), /if \(!account\) redirect\(/,
      'the claim page no longer guards on being signed in');
  });

  test('and brings them back to the claim page itself', () => {
    assert.match(code(CLAIM), /redirect\(`\/sign-in\?next=\/directory\/\$\{id\}\/claim`\)/,
      'sign-in no longer returns the visitor to the claim page');
  });
});

describe('the listing keeps its own claim banner', () => {
  test('the banner is still rendered for unclaimed listings', () => {
    const src = code(LISTING);
    assert.match(src, /!b\.is_claimed && \(/, 'the listing lost its unclaimed branch');
    assert.match(src, /id="claim"/, 'the banner lost its anchor');
    assert.match(src, /href=\{`\/directory\/\$\{id\}\/claim`\}/,
      'the banner button no longer links to the claim route');
  });

  test('the card only offers the claim on unclaimed listings', () => {
    assert.match(code(CARD), /\{!b\.is_claimed && \(/,
      'the card CTA is no longer gated on the listing being unclaimed');
  });
});
