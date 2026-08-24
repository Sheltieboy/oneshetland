/**
 * pass-purchase-history.node.test.ts — a spent pass is still a purchase.
 *
 * WHAT WAS WRONG
 *
 * The customer used the last of a 3-session pass and the whole thing vanished
 * from Account → Passes & vouchers, which then said "Nothing yet — Day passes,
 * class packs and vouchers you buy from Shetland businesses appear here." They
 * had bought one that afternoon and used it three times.
 *
 * Both clients asked the same question, and it was the wrong one:
 *
 *     .gt('uses_remaining', 0)
 *     .or('expires_at.is.null,expires_at.gt.<now>')
 *
 * That is "what can I spend right now?", and the page was presenting it as
 * "what have I bought?". Nothing was deleted — the row was always there, at
 * uses_remaining 0 with fully_used_at set. The query hid it.
 *
 * A purchase is an entitlement while it lasts and a receipt for ever after.
 * The two filters were about USABILITY, not access, so they moved out of the
 * query and into the rendering: Active keeps "Use at till", Used and Expired
 * are history and carry no redemption action at all.
 *
 * WHAT IS ASSERTED
 *   · neither client filters history out of the query any more
 *   · both classify identically: used > expired > active
 *   · only an active pass offers a redemption
 *   · "Nothing yet" appears only for somebody who has never bought one
 *   · owner scoping is unchanged — the fix removed usability filters, not the
 *     owner_id filter
 *   · the backend still refuses a challenge for a used or expired pass
 *   · no payment code involved
 *
 * SAFETY
 * Source inspection only. Classification, the expiry guard and owner isolation
 * were exercised against production on disposable purchases — active, used up
 * and expired — all removed afterwards. The real completed pass was read, never
 * written.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const webLib = web('lib/passes-data.ts');
const webUi = web('app/account/passes/PassesClient.tsx');
const appLib = read('lib/local-api.ts');
const appUi = read('app/local-my-passes.tsx');
const startFn = read('supabase/functions/local-redeem-start/index.ts');
const baseline = read('supabase/migrations/20260623000000_baseline_remote_schema.sql');

/** Strip comments — these files document the old filters on purpose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const webQuery = webLib.match(/export async function fetchMyPasses[\s\S]*?\n\}/)?.[0] ?? '';
const appQuery = (() => {
  const i = appLib.indexOf('export async function fetchMyPasses');
  const j = appLib.indexOf('\nexport ', i + 10);
  return i > -1 ? appLib.slice(i, j === -1 ? undefined : j) : '';
})();

/* ── 1. History is no longer filtered away ────────────────────────────────── */

describe('the query returns what was bought, not what is spendable', () => {
  test('both queries were found', () => {
    assert.ok(webQuery.length > 0 && appQuery.length > 0);
  });

  for (const [name, q] of [['web', () => webQuery], ['app', () => appQuery]] as const) {
    test(`${name} no longer excludes a spent pass`, () => {
      assert.ok(!/uses_remaining['"], 0\)/.test(code(q())), `${name} still filters on uses_remaining`);
      assert.ok(!/\.gt\(/.test(code(q())), `${name} still has a .gt() filter`);
    });

    test(`${name} no longer excludes an expired pass`, () => {
      assert.ok(!/expires_at\.gt\./.test(code(q())), `${name} still filters expired purchases out`);
      assert.ok(!/\.or\(/.test(code(q())), `${name} still has the expiry .or()`);
    });

    test(`${name} still selects only this owner's rows`, () => {
      assert.match(q(), /\.eq\(['"]owner_id['"], (auth\.user\.id|userId)\)/);
    });

    test(`${name} now selects fully_used_at, so history can say when`, () => {
      assert.match(q(), /fully_used_at/);
    });
  }
});

/* ── 2. Both clients classify the same way ────────────────────────────────── */

describe('active, used and expired mean the same thing on both', () => {
  const webClassify = webLib.match(/function classify\([\s\S]*?\n\}/)?.[0] ?? '';
  const appClassify = appLib.match(/export function classifyPass\([\s\S]*?\n\}/)?.[0] ?? '';

  test('both have a classifier', () => {
    assert.ok(webClassify.length > 0, 'web classify() missing');
    assert.ok(appClassify.length > 0, 'app classifyPass() missing');
  });

  test('a spent pass is "used" — checked before expiry, so it never reads as Expired', () => {
    for (const [name, c] of [['web', webClassify], ['app', appClassify]] as const) {
      assert.match(c, /usesRemaining <= 0\) return ['"]used['"]/, `${name} does not call a spent pass used`);
      const usedAt = c.indexOf('used');
      const expiredAt = c.indexOf('expired');
      assert.ok(usedAt < expiredAt, `${name} checks expiry before exhaustion`);
    }
  });

  test('a pass with uses left but past its date is "expired"', () => {
    for (const c of [webClassify, appClassify]) {
      assert.match(c, /expiresAt && new Date\(expiresAt\)\.getTime\(\) <= Date\.now\(\)\) return ['"]expired['"]/);
    }
  });

  test('anything else is active', () => {
    for (const c of [webClassify, appClassify]) assert.match(c, /return ['"]active['"]/);
  });

  test('the three statuses are the same set on both clients', () => {
    assert.match(webLib, /"active" \| "used" \| "expired"/);
    assert.match(appLib, /'active' \| 'used' \| 'expired'/);
  });
});

/* ── 3. Only an active pass can be spent ──────────────────────────────────── */

describe('history carries no redemption action', () => {
  test('web gates "Use at till" on active', () => {
    assert.match(webUi, /pass\.status === "active" && usesLeft > 0 && \(/);
  });

  test('the app gates "Use at till" on active', () => {
    assert.match(appUi, /pass\.status === 'active' && pass\.uses_remaining > 0 && \(/);
  });

  test('neither renders a redeem control outside that gate', () => {
    // Exactly one <RedeemDialog> in the file, and it sits inside the gate above.
    assert.equal((webUi.match(/<RedeemDialog/g) ?? []).length, 1);
    assert.equal((appUi.match(/pathname: '\/local-redeem'/g) ?? []).length, 1);
  });

  test('history says what happened instead of showing a balance', () => {
    assert.match(webUi, /Fully used/);
    assert.match(webUi, /Expired/);
    assert.match(appUi, /used:\s+'Fully used'/);
    assert.match(appUi, /expired: 'Expired'/);
  });

  test('the paid amount is still shown, from the purchase snapshot', () => {
    assert.match(webUi, /gbp\(pass\.paid_amount_pence\)/);
    assert.match(appUi, /formatPence\(pass\.paid_amount_pence\)/);
  });

  test('the backend refuses a challenge for a used or expired pass', () => {
    assert.match(startFn, /No uses left on this pass/);
    assert.match(startFn, /expired/i);
  });
});

/* ── 4. The empty state tells the truth ───────────────────────────────────── */

describe('"Nothing yet" means never bought one', () => {
  test('web shows it only when there are no purchases at all', () => {
    assert.match(webUi, /if \(passes\.length === 0\) \{[\s\S]*?Nothing yet/);
  });

  test('the app shows it only when there are no purchases at all', () => {
    assert.match(appUi, /passes\.length === 0 \? \([\s\S]*?title="Nothing yet"/);
  });

  test('a customer with only history sees sections, not the empty state', () => {
    for (const [name, ui] of [['web', webUi], ['app', appUi]] as const) {
      assert.match(ui, /Previous passes/, `${name} has no history section`);
      assert.match(ui, /(status !== "active"|status !== 'active')/, `${name} does not split history out`);
    }
  });

  test('an account with history but nothing usable says so, without claiming it has nothing', () => {
    assert.match(webUi, /Nothing to use right now\./);
    assert.match(appUi, /Nothing to use right now\./);
  });
});

/* ── 5. History survives the item being withdrawn ─────────────────────────── */

describe('a business withdrawing a pass does not erase somebody’s receipt', () => {
  test('the owner UI deactivates rather than deletes', () => {
    const manage = web('lib/book-manage-items.ts');
    const del = manage.match(/export async function deleteUnitItem[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(del, /\.update\(\{ is_active: false \}\)/);
    assert.ok(!/\.delete\(\)/.test(del), 'deleteUnitItem really deletes');
  });

  test('and the database would refuse a hard delete anyway', () => {
    // No ON DELETE clause => NO ACTION => a purchase pins its item row.
    const fk = baseline.match(/ADD CONSTRAINT book_unit_purchases_item_id_fkey[^;]*/)?.[0] ?? '';
    assert.ok(fk.length > 0, 'FK not found');
    assert.ok(!/ON DELETE/i.test(fk), 'purchases no longer pin their item row');
  });

  test('the amount paid is snapshotted on the purchase, not read from the item', () => {
    assert.match(webQuery, /paid_amount_pence/);
    assert.ok(!/item:book_unit_items \([^)]*price/.test(webQuery), 'history prices from the live item');
  });
});

/* ── 6. Nothing else moved ────────────────────────────────────────────────── */

describe('no payment or access change', () => {
  test('no payment identifier is read or rendered on a pass', () => {
    for (const [name, src] of [['web query', webQuery], ['web ui', webUi], ['app query', appQuery], ['app ui', appUi]] as const) {
      for (const w of ['payment_intent', 'PaymentIntent', 'client_secret', 'charge_id']) {
        assert.ok(!code(src).includes(w), `${name} touches ${w}`);
      }
    }
  });

  test('the only thing this page wants from the Stripe module is a currency formatter', () => {
    const imports = webUi.match(/import \{([^}]*)\} from "@\/lib\/stripe"/)?.[1] ?? '';
    assert.equal(imports.trim(), 'gbp');
    assert.ok(!/confirmPayment|createPaymentIntent|stripe\./.test(code(webUi)));
  });

  test('showing history did not require loosening RLS', () => {
    const policies = [...baseline.matchAll(/CREATE POLICY "[^"]+" ON public\.book_unit_purchases[^;]*/g)].map((m) => m[0]);
    assert.ok(policies.length > 0, 'no policies found on book_unit_purchases');
    for (const p of policies) {
      assert.ok(/owner_id|auth\.uid\(\)|local_businesses/.test(p), `a purchase policy is not scoped: ${p.slice(0, 90)}`);
    }
  });
});
