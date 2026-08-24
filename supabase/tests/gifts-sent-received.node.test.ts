/**
 * gifts-sent-received.node.test.ts — buying a gift is not receiving one.
 *
 * WHAT WAS WRONG
 *
 * Account → Gifts only ever asked one question: "which gifts did I CLAIM?"
 * (book_gifts where claimed_by_user_id = me). There was no notion of a gift you
 * had SENT, on either client, even though the "Purchasers see their gifts"
 * policy had always permitted that read. A buyer's own purchase history had
 * nowhere to live.
 *
 * In the real Paygate 3 run the purchaser and the recipient were the SAME
 * account, so the gift appeared under "Gifts received → To claim" with a "Pick
 * a time" button — technically true (they had claimed it) but it read as the
 * sender being offered a recipient action, and their sent history was invisible.
 *
 * The second half is a genuine defect and outlived the booking:
 *
 *   claim_gift() sets status='claimed'. Only a UNIT gift ever reaches 'used'.
 *   The write meant to mark a booked SERVICE gift used lives in createBooking —
 *   `update book_gifts set status='used'` — and book_gifts has three SELECT
 *   policies and NO UPDATE policy, so that write silently matches zero rows.
 *   A booking gift therefore sits at 'claimed' forever and keeps offering
 *   "Pick a time" long after the slot is booked and confirmed.
 *
 * Fixed by DERIVING the booked state from book_bookings — the authoritative
 * record, readable by the claimer under "Customers see their own bookings" —
 * rather than by granting a new UPDATE policy on book_gifts.
 *
 * WHAT IS ASSERTED
 *   · received is claimed_by_user_id; sent is purchaser_id; neither client
 *     invents a third rule, and the two clients agree
 *   · a sent gift carries no claim / pick-a-time / redeem action
 *   · a sent gift exposes no recipient account, bearer code or payment field
 *   · a booked gift stops offering "Pick a time" on both clients
 *   · every status shown is a real book_gifts status
 *   · the self-gift case is deterministic and documented
 *   · no policy, migration or payment path changed
 *
 * SAFETY
 * Source inspection only. No network, no database, no payment. The live
 * relationships were verified separately against the real Paygate 3 gift.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const webLib = web('lib/passes-data.ts');
const webClient = web('app/account/gifts/GiftsClient.tsx');
const webPage = web('app/account/gifts/page.tsx');
const appLib = read('lib/local-api.ts');
const appScreen = read('app/local-my-gifts.tsx');
const baseline = read('supabase/migrations/20260623000000_baseline_remote_schema.sql');

/** The body of one exported function, to the next top-level export. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start === -1) return '';
  const next = src.indexOf('\nexport ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

/* ── 1. The two relationships ─────────────────────────────────────────────── */

describe('received and sent are different questions about the same table', () => {
  test('web received asks claimed_by_user_id', () => {
    const f = fn(webLib, 'fetchMyGiftsReceived');
    assert.match(f, /\.eq\("claimed_by_user_id", auth\.user\.id\)/);
    // It must not FILTER on the purchaser. (purchaser_name is legitimately
    // selected — the recipient is shown who the gift is from.)
    const filters = [...f.matchAll(/\.eq\("(\w+)"/g)].map((m) => m[1]);
    assert.ok(!filters.includes('purchaser_id'), 'received keys off the purchaser');
  });

  test('web sent asks purchaser_id', () => {
    const f = fn(webLib, 'fetchMyGiftsSent');
    assert.ok(f.length > 0, 'fetchMyGiftsSent does not exist');
    assert.match(f, /\.eq\("purchaser_id", auth\.user\.id\)/);
  });

  test('the app asks exactly the same two questions', () => {
    assert.match(fn(appLib, 'fetchMyGiftsReceived'), /\.eq\('claimed_by_user_id', userId\)/);
    const s = fn(appLib, 'fetchMyGiftsSent');
    assert.ok(s.length > 0, 'the app has no fetchMyGiftsSent');
    assert.match(s, /\.eq\('purchaser_id', userId\)/);
  });

  test('an unpaid gift is not "sent" on either client', () => {
    assert.match(fn(webLib, 'fetchMyGiftsSent'), /\.neq\("status", "pending_payment"\)/);
    assert.match(fn(appLib, 'fetchMyGiftsSent'), /\.neq\('status', 'pending_payment'\)/);
  });

  test('both relationships were already permitted — no new policy', () => {
    assert.match(baseline, /CREATE POLICY "Purchasers see their gifts" ON public\.book_gifts FOR SELECT USING \(\(purchaser_id = auth\.uid\(\)\)\)/);
    assert.match(baseline, /CREATE POLICY "Claimers see gifts they've claimed" ON public\.book_gifts FOR SELECT USING \(\(claimed_by_user_id = auth\.uid\(\)\)\)/);
  });

  test('this change ships no migration at all', () => {
    const migrations = readdirSync(join(REPO_ROOT, 'supabase/migrations'))
      .filter((f) => f.startsWith('202608240') || f.startsWith('20260824'));
    assert.deepEqual(migrations, [], `unexpected migration(s): ${migrations.join(', ')}`);
  });
});

/* ── 2. A sender is not a recipient ───────────────────────────────────────── */

describe('a sent gift offers no recipient action', () => {
  const webSentRow = webClient.match(/function SentGiftRow[\s\S]*?\n}/)?.[0] ?? '';
  const appSentCard = appScreen.match(/function SentGiftCard[\s\S]*?\n}/)?.[0] ?? '';

  test('both sent cards exist', () => {
    assert.ok(webSentRow.length > 0, 'web SentGiftRow missing');
    assert.ok(appSentCard.length > 0, 'app SentGiftCard missing');
  });

  for (const [name, src] of [['web', () => webClient.match(/function SentGiftRow[\s\S]*?\n}/)?.[0] ?? ''],
                             ['app', () => appScreen.match(/function SentGiftCard[\s\S]*?\n}/)?.[0] ?? '']] as const) {
    test(`the ${name} sent card has no claim / pick-a-time / redeem`, () => {
      const s = src();
      // Actions, not words: "Claimed by recipient" is a status, not a button.
      for (const action of ['Pick a time', 'Pick a slot', 'onPickSlot', 'Redeem',
                            'Use gift', 'claimGift', 'claim_gift', 'onPress', 'onClick']) {
        assert.ok(!s.includes(action), `the ${name} sent card offers "${action}"`);
      }
      // No interactive element of any kind.
      assert.ok(!/<(button|TouchableOpacity|Pressable)\b/.test(s), `the ${name} sent card has a control on it`);
    });

    test(`the ${name} sent card exposes no code, recipient account or payment field`, () => {
      const s = src();
      for (const leak of ['gift.code', 'claimed_by_user_id', 'recipient_email', 'payment_intent', '/g/']) {
        assert.ok(!s.includes(leak), `the ${name} sent card exposes ${leak}`);
      }
    });
  }

  test('the sent query never selects the bearer code or the recipient email', () => {
    for (const [name, f] of [['web', fn(webLib, 'fetchMyGiftsSent')], ['app', fn(appLib, 'fetchMyGiftsSent')]] as const) {
      const select = f.match(/\.select\(([\s\S]*?)\)\s*\n/)?.[1] ?? '';
      assert.ok(select.length > 0, `${name} select not found`);
      for (const banned of ['code', 'recipient_email', 'payment_intent_id']) {
        assert.ok(!new RegExp(`\\b${banned}\\b`).test(select), `${name} sent query selects ${banned}`);
      }
    }
  });
});

/* ── 3. Only real statuses ────────────────────────────────────────────────── */

describe('sender statuses are the ones the backend can actually reach', () => {
  const allowed = (baseline.match(/CONSTRAINT book_gifts_status_check CHECK \(\(status = ANY \(ARRAY\[([^\]]*)\]/)?.[1] ?? '');
  const real = [...allowed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  test('the lifecycle is the five the CHECK allows', () => {
    assert.deepEqual(real.sort(), ['cancelled', 'claimed', 'pending_payment', 'sent', 'used'].sort());
  });

  test('every sender label maps to a real status, on both clients', () => {
    for (const [name, src] of [['web', webClient], ['app', appScreen]] as const) {
      const map = src.match(/SENT_STATUS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
      assert.ok(map.length > 0, `${name} SENT_STATUS missing`);
      const keys = [...map.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      assert.ok(keys.length > 0);
      for (const k of keys) assert.ok(real.includes(k), `${name} invents sender status "${k}"`);
      // pending_payment is filtered out of the query, so it needs no label.
      assert.ok(!keys.includes('pending_payment'));
    }
  });
});

/* ── 4. A booked gift stops asking to be booked ───────────────────────────── */

describe('booked state comes from the booking, not from gift.status', () => {
  test('both clients derive it from book_bookings', () => {
    for (const [name, f] of [['web', fn(webLib, 'fetchMyGiftsReceived')], ['app', fn(appLib, 'fetchMyGiftsReceived')]] as const) {
      assert.match(f, /book_bookings/, `${name} does not consult the booking table`);
      assert.match(f, /gift_id/, `${name} does not match bookings by gift`);
      assert.match(f, /cancelled/, `${name} counts a cancelled booking as booked`);
    }
  });

  test('"Pick a time" is suppressed once booked', () => {
    assert.match(webClient, /gift\.kind === "booking" && gift\.status === "claimed" && !gift\.booked/);
    assert.match(appScreen, /gift\.kind === 'booking' && gift\.status === 'claimed' && !gift\.booked/);
  });

  test('and the card says Booked instead', () => {
    assert.match(webClient, /Booked</);
    assert.match(appScreen, /Booked</);
  });

  test('the reason is written down where the next person will look', () => {
    for (const [name, src] of [['web', webLib], ['app', appLib]] as const) {
      assert.match(src, /no UPDATE policy/i, `${name} does not explain why status is not trusted`);
    }
  });
});

/* ── 5. Self-gifting is deliberate ────────────────────────────────────────── */

describe('purchaser == claimer is handled on purpose', () => {
  test('both clients compute it', () => {
    assert.match(webLib, /claimed_by_me: r\.claimed_by_user_id === auth\.user!\.id/);
    assert.match(appLib, /claimed_by_me:\s*r\.claimed_by_user_id === userId/);
  });

  test('and say so rather than hiding half the history', () => {
    assert.match(webClient, /Claimed by you/);
    assert.match(appScreen, /Claimed by you/);
  });
});

/* ── 6. The recipient side still works ────────────────────────────────────── */

describe('the recipient keeps everything they had', () => {
  test('the received query is otherwise unchanged', () => {
    for (const [name, f] of [['web', fn(webLib, 'fetchMyGiftsReceived')], ['app', fn(appLib, 'fetchMyGiftsReceived')]] as const) {
      assert.match(f, /'claimed', 'used'|"claimed", "used"/, `${name} changed which gifts count as received`);
    }
  });

  test('an unbooked booking gift still offers the slot picker', () => {
    assert.match(webClient, /Pick a time/);
    assert.match(appScreen, /Pick a slot/);
    assert.match(appScreen, /onPickSlot=\{pickSlot\}/);
  });

  test('the claim and booking paths are untouched', () => {
    // claim_gift still requires auth and still locks the row.
    assert.match(baseline, /RAISE EXCEPTION 'auth_required'/);
    assert.match(baseline, /WHERE code = p_code FOR UPDATE/);
  });
});

/* ── 7. Both surfaces agree, and nothing about payment moved ──────────────── */

describe('the two clients tell the same story', () => {
  test('both pages are titled Gifts, not Gifts received', () => {
    assert.match(webPage, /<h1[^>]*>Gifts<\/h1>/);
    assert.match(appScreen, /title="Gifts"/);
    assert.ok(!/title="Gifts received"/.test(appScreen));
  });

  test('both show a received and a sent section', () => {
    for (const [name, src] of [['web', webClient], ['app', appScreen]] as const) {
      assert.match(src, /Gifts received/, `${name} lost the received heading`);
      assert.match(src, /Gifts sent/, `${name} has no sent section`);
    }
  });

  test('both have a sensible empty state for each side', () => {
    assert.match(webClient, /No gifts received yet/);
    assert.match(webClient, /No gifts sent yet/);
    assert.match(appScreen, /Nothing sent your way yet/);
    assert.match(appScreen, /haven&rsquo;t sent a gift yet|haven't sent a gift yet/);
  });

  test('no Stripe or payment call appears in the gift history layer', () => {
    for (const [name, f] of [
      ['web-sent', fn(webLib, 'fetchMyGiftsSent')],
      ['app-sent', fn(appLib, 'fetchMyGiftsSent')],
      ['web-recv', fn(webLib, 'fetchMyGiftsReceived')],
      ['app-recv', fn(appLib, 'fetchMyGiftsReceived')],
    ] as const) {
      // Comments stripped: these functions DOCUMENT which payment fields they
      // deliberately never select, and that prose is not a payment call.
      const code = f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '').toLowerCase();
      for (const b of ['stripe', 'payment_intent', 'create-gift-intent', 'confirm-gift']) {
        assert.ok(!code.includes(b), `${name} touches ${b}`);
      }
    }
  });
});
