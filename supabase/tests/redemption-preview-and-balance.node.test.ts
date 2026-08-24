/**
 * redemption-preview-and-balance.node.test.ts — look before you spend.
 *
 * WHAT WAS OBSERVED
 *
 * First real pass redemption. Customer screen said 1 use left; business screen
 * said 2. The database said 2, from exactly one consumed redemption row. So the
 * backend was right and one screen was lying.
 *
 * TWO SEPARATE FAULTS, NEITHER OF THEM A DOUBLE-SPEND.
 *
 * 1. THE CUSTOMER CARD COUNTED DOWN ON ITS OWN, IN A LOOP.
 *
 *    PassesClient passed `onDone={() => setUsesLeft(n => n - 1)}` — an inline
 *    arrow, new identity every render — and RedeemDialog listed onDone in its
 *    effect's dependency array. So: poll sees "consumed" -> onDone -> state
 *    changes -> new onDone identity -> effect re-runs -> new poll -> still
 *    "consumed" -> onDone again. One redemption walked the card 3 -> 2 -> 1.
 *
 *    Fixed twice over: onDone lives in a ref and fires once, and the balance is
 *    now the server's number rather than oldBalance - 1.
 *
 * 2. COUNTER MODE SPENT THE CREDIT BEFORE SHOWING ANYTHING.
 *
 *    Typing the code called the MUTATING verify immediately; the panel that then
 *    appeared was headed "Confirm a redemption" with a Next button. Staff could
 *    not tell whether they had taken the use or were about to. Next only reset
 *    the form and a re-scan is refused, so nothing was lost — but it is not a
 *    state to leave a till in.
 *
 *    Now: look up (read-only) -> preview -> Confirm redemption -> result.
 *
 * WHAT IS ASSERTED
 *   · the preview writes nothing and cannot be reached by a customer
 *   · exactly one mutating step, and it is the explicit confirm
 *   · neither screen computes a balance for itself
 *   · the customer poll is read-only and fires its callback once
 *   · the atomic RPC and its concurrency protection are untouched
 *   · Counter mode says passes and vouchers out loud
 *
 * SAFETY
 * Source inspection only. The live flow was exercised against production on a
 * disposable pass starting at 3 — preview kept it at 3, confirm took it to 2, a
 * retry left it at 2 — and removed afterwards. The real customer pass was never
 * redeemed.
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

const previewSql = read('supabase/migrations/20260824190000_redemption_preview.sql');
const atomicSql = read('supabase/migrations/20260824170000_atomic_pass_redemption_token_type.sql');
const verifyFn = read('supabase/functions/local-redeem-verify/index.ts');
const startFn = read('supabase/functions/local-redeem-start/index.ts');
const counterUi = web('components/business/RedeemVerify.tsx');
const counterMode = web('components/business/CounterMode.tsx');
const dialog = web('components/local/RedeemDialog.tsx');
const passes = web('app/account/passes/PassesClient.tsx');
const redeemClient = web('lib/loyalty-redeem-client.ts');
const appPasses = read('app/local-my-passes.tsx');
const appRedeem = read('app/local-redeem.tsx');

/** Strip comments — several of these files DOCUMENT the old wording on purpose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const fn = (src: string, name: string) =>
  src.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\n\\$\\$;`))?.[0] ?? '';

/* ── 1. Looking costs nothing ─────────────────────────────────────────────── */

describe('the preview consumes nothing', () => {
  const body = fn(previewSql, 'preview_redemption');

  test('it exists and is declared STABLE', () => {
    assert.ok(body.length > 0, 'preview_redemption not found');
    assert.match(body, /\bstable\b/);
  });

  test('it contains no write of any kind', () => {
    const sql = body.replace(/^\s*--.*$/gm, '');
    for (const w of ['update ', 'insert ', 'delete ']) {
      assert.ok(!sql.toLowerCase().includes(w), `preview_redemption performs a ${w.trim()}`);
    }
  });

  test('it reports the CURRENT balance, not a decremented one', () => {
    assert.match(body, /'uses_remaining', v_purchase\.uses_remaining/);
    assert.ok(!/uses_remaining - 1/.test(body), 'the preview subtracts a use');
  });

  test('it refuses a code that is not this business�s, indistinguishably', () => {
    assert.match(body, /b\.id = v_red\.business_id and b\.owner_id = p_verifier/);
    const notYours = body.slice(body.indexOf('not exists ('));
    assert.match(notYours, /'not_found'/);
  });

  test('and it is service_role only', () => {
    assert.match(previewSql, /revoke all on function public\.preview_redemption\(uuid, text, text\) from public, anon, authenticated;/);
    assert.match(previewSql, /grant execute on function public\.preview_redemption\(uuid, text, text\) to service_role;/);
  });

  test('the edge function returns before any mutating branch', () => {
    const previewBranch = verifyFn.indexOf('if (preview === true)');
    const firstMutation = verifyFn.indexOf("red.kind === 'offer'");
    assert.ok(previewBranch > -1, 'no preview branch');
    assert.ok(previewBranch < firstMutation, 'preview runs after a mutating branch');
    const branch = verifyFn.slice(previewBranch, firstMutation);
    assert.match(branch, /return json\(\{ ok: true, preview: true/);
    assert.ok(!/redeem_pass_atomic/.test(branch), 'the preview path can reach the spender');
  });
});

/* ── 2. Exactly one mutating step, and staff choose it ────────────────────── */

describe('Counter mode looks, then spends', () => {
  test('typing the code only looks it up', () => {
    const look = counterUi.match(/async function look\([\s\S]*?\n  \}/)?.[0] ?? '';
    assert.ok(look.length > 0, 'look() not found');
    assert.match(look, /previewRedemption\(\{ code \}\)/);
    assert.ok(!/verifyRedemption/.test(look), 'looking up still redeems');
  });

  test('only confirm() redeems', () => {
    const confirm = counterUi.match(/async function confirm\([\s\S]*?\n  \}/)?.[0] ?? '';
    assert.ok(confirm.length > 0, 'confirm() not found');
    assert.match(confirm, /verifyRedemption\(\{ code \}\)/);
    assert.equal((counterUi.match(/verifyRedemption\(/g) ?? []).length, 1, 'more than one call site can redeem');
  });

  test('the preview panel offers an explicit Confirm and a Cancel', () => {
    assert.match(counterUi, /About to redeem/);
    assert.match(counterUi, /Confirm redemption/);
    assert.match(counterUi, /onClick=\{reset\}[\s\S]{0,200}?Cancel/);
  });

  test('the old "Confirm a redemption" heading no longer sits over a spent credit', () => {
    assert.ok(!/Confirm a redemption/.test(code(counterUi)));
    assert.match(counterUi, /Scan or enter a customer code/);
  });

  test('the post-redemption button only resets — it never redeems again', () => {
    assert.match(counterUi, /onClick=\{reset\}[\s\S]{0,160}?Next customer/);
    const reset = counterUi.match(/function reset\([\s\S]*?\n  \}/)?.[0] ?? '';
    assert.ok(!/verifyRedemption|previewRedemption/.test(reset), 'reset calls an API');
  });

  test('neither Counter panel computes a balance', () => {
    assert.ok(!/- 1/.test(counterUi), 'Counter mode subtracts a use itself');
    assert.match(counterUi, /r\.detail\?\.subtitle/);
  });
});

/* ── 3. The customer card stops counting for itself ───────────────────────── */

describe('the customer sees the server’s number, once', () => {
  test('onDone is held in a ref, not depended on', () => {
    assert.match(dialog, /const onDoneRef = useRef\(onDone\)/);
    const effect = dialog.match(/useEffect\(\(\) => \{\s*\n\s*if \(!ticket\) return;[\s\S]*?\}, \[ticket\]\);/)?.[0] ?? '';
    assert.ok(effect.length > 0, 'the polling effect no longer matches — check its dependencies');
    assert.ok(!/\[ticket, onDone\]/.test(dialog), 'onDone is still a dependency');
  });

  test('and fires exactly once', () => {
    assert.match(dialog, /const fired = useRef\(false\)/);
    assert.match(dialog, /if \(!fired\.current\) \{ fired\.current = true; onDoneRef\.current\?\.\(usesRemaining\); \}/);
  });

  test('the card sets the server balance instead of subtracting', () => {
    assert.match(passes, /onDone=\{\(remaining\) => setUsesLeft\(\(n\) => \(remaining \?\? Math\.max\(0, n - 1\)\)\)\}/);
  });

  test('the success state shows that balance', () => {
    assert.match(dialog, /setBalance\(usesRemaining\)/);
    assert.match(dialog, /\{balance\} \{balance === 1 \? "use" : "uses"\} left/);
  });
});

describe('customer polling is read-only', () => {
  test('it selects, and never invokes a function', () => {
    const start = redeemClient.indexOf('export async function getRedemptionState');
    const end = redeemClient.indexOf('export async function getRedemptionStatus', start);
    const state = start > -1 && end > -1 ? redeemClient.slice(start, end) : '';
    assert.ok(state.length > 0, 'getRedemptionState not found');
    assert.match(state, /\.select\("status, kind, ref_id"\)/);
    assert.match(state, /\.select\("uses_remaining"\)/);
    for (const w of ['functions.invoke', 'rpc(', 'update(', 'insert(', 'delete(']) {
      assert.ok(!state.includes(w), `the poll performs ${w}`);
    }
  });

  test('the dialog polls that and nothing else', () => {
    assert.match(dialog, /await getRedemptionState\(ticket\.id\)/);
    assert.ok(!/verifyRedemption/.test(dialog), 'the customer modal can redeem');
  });

  test('the app side never subtracted in the first place, and still does not', () => {
    assert.match(appPasses, /\{pass\.uses_remaining\}/);
    assert.ok(!/uses_remaining - 1/.test(appPasses));
    assert.ok(!/verifyRedemption|local-redeem-verify/.test(appRedeem), 'the app modal can redeem');
  });
});

/* ── 4. Nothing that was already right moved ──────────────────────────────── */

describe('the atomic spender is untouched', () => {
  const body = fn(atomicSql, 'redeem_pass_atomic');

  test('it still locks the redemption row first', () => {
    assert.match(body, /from public\.local_redemptions[\s\S]*?for update/);
  });

  test('it still refuses a second use of the same code', () => {
    assert.match(body, /if v_red\.status <> 'pending' then[\s\S]*?'already_used'/);
  });

  test('it still checks ownership and the balance', () => {
    assert.match(body, /'not_your_business'/);
    assert.match(body, /'no_uses_left'/);
  });

  test('it is still service_role only', () => {
    assert.match(atomicSql, /revoke all on function public\.redeem_pass_atomic\(uuid, text, text\) from public, anon, authenticated;/);
  });

  test('the preview migration adds no write path to it', () => {
    assert.ok(!/redeem_pass_atomic/.test(code(previewSql)));
  });
});

describe('a second challenge is not created behind the customer’s back', () => {
  test('pressing Use at till again reuses the live pending one', () => {
    assert.match(startFn, /Reuse an existing live pending redemption/);
    assert.match(startFn, /\.eq\('status', 'pending'\)/);
  });
});

/* ── 5. Staff can find it ─────────────────────────────────────────────────── */

describe('Counter mode says what it is for', () => {
  test('the CTA is not limited to member cards', () => {
    assert.ok(!/Scan a member card/.test(code(counterMode)));
    assert.match(counterMode, /Scan or enter a customer code/);
  });

  test('the supporting copy names passes and vouchers', () => {
    assert.match(counterMode, /Passes, vouchers, loyalty rewards, offers and card payments/);
  });

  test('the panel itself says nothing is spent until confirmed', () => {
    assert.match(counterUi, /Nothing is used until you confirm/);
    assert.match(counterUi, /Passes, vouchers, loyalty rewards and offers/);
  });

  test('short-code entry is still there alongside', () => {
    assert.match(counterUi, /aria-label="Customer redemption code"/);
    assert.match(counterUi, /maxLength|slice\(0, 4\)/);
  });
});

/* ── 6. No payment path involved ──────────────────────────────────────────── */

describe('nothing here touches money', () => {
  test('the preview migration mentions no payment object', () => {
    const sql = previewSql.replace(/^\s*--.*$/gm, '').toLowerCase();
    for (const w of ['stripe', 'payment_intent', 'price_pence']) {
      assert.ok(!sql.includes(w), `the preview migration touches ${w}`);
    }
  });

  test('nor does the Counter UI', () => {
    for (const w of ['stripe', 'PaymentIntent', 'payment_intent']) {
      assert.ok(!counterUi.includes(w), `Counter mode touches ${w}`);
    }
  });
});
