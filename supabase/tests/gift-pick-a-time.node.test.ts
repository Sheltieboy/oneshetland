/**
 * gift-pick-a-time.node.test.ts — the last step of a booking gift.
 *
 * WHAT WAS WRONG
 *
 * Three separate faults on the same journey.
 *
 * 1. WEB NAVIGATION. "Pick a time" linked to `/directory/${business_id}` — the
 *    general business page. Neither the gifted SERVICE nor the GIFT travelled
 *    with it, so the recipient landed in discovery and had to find the service
 *    again. Even if they did, the picker opened with no gift attached and would
 *    have charged them.
 *
 * 2. APP NAVIGATION. local-my-gifts pushed
 *      { id, gift_id, gift_service_id }
 *    while local-book-business reads
 *      { businessId, serviceId, giftId }.
 *    Every name wrong, so the screen opened without even a business.
 *
 * 3. NO AUTHORISATION ON A GIFT-FUNDED BOOKING. book_bookings.gift_id came
 *    straight from the client and nothing checked it. Both of these were
 *    reproduced against production before the fix:
 *      · a signed-in STRANGER inserted a booking carrying somebody else's
 *        gift_id with deposit 0 — HTTP 201, a free service on another
 *        person's gift;
 *      · the rightful claimant used a £45 gift to book a DIFFERENT service —
 *        HTTP 201.
 *    Neither client offered those, which is precisely why the fix belongs in
 *    the database: a hidden button is not an authorisation boundary.
 *
 * The slot picker itself was never the problem — BookServiceModal already took
 * a giftId, already zeroed the deposit for one, and already passed it to
 * createBooking. Nothing ever handed it one.
 *
 * WHAT IS ASSERTED
 *   · both clients carry service AND gift into the existing picker
 *   · neither routes to the bare business page any more
 *   · a gift-funded booking takes no payment
 *   · the database enforces claimant, service, business, spendability and
 *     one-live-booking-per-gift
 *   · an ordinary paid booking is untouched
 *   · the earlier sent/received and recipient-verification work still holds
 *
 * SAFETY
 * Source inspection only. The live behaviour — including both exploits, before
 * and after — was exercised against production on disposable gifts and
 * accounts, all removed afterwards.
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

const guard = read('supabase/migrations/20260824140000_gift_funded_booking_guard.sql');
const appGifts = read('app/local-my-gifts.tsx');
const appClaim = read('app/g/[code].tsx');
const appBook = read('app/local-book-business.tsx');
const webGifts = web('app/account/gifts/GiftsClient.tsx');
const webClaim = web('app/g/[code]/GiftClaimClient.tsx');
const webSection = web('components/local/ServicesSection.tsx');
const webModal = web('components/local/BookServiceModal.tsx');
const webBookData = web('lib/book-data.ts');
const webBizPage = web('app/directory/[id]/page.tsx');

/* ── 1. The service and the gift travel with the tap ──────────────────────── */

describe('Pick a time carries what the booking needs', () => {
  test('web links to the gifted service and the gift, not just the business', () => {
    assert.match(webGifts, /href=\{`\/directory\/\$\{gift\.business_id\}\?book=\$\{gift\.service_id \?\? ""\}&gift=\$\{gift\.id\}`\}/);
  });

  test('web no longer links to the bare business page', () => {
    for (const [name, src] of [['gifts list', webGifts], ['claim page', webClaim]] as const) {
      const bare = src.match(/href=\{`\/directory\/\$\{[a-zA-Z.]+\}`\}/g) ?? [];
      assert.deepEqual(bare, [], `${name} still links to a bare business page: ${bare.join(', ')}`);
    }
  });

  test('the post-claim page carries them too', () => {
    assert.match(webClaim, /\?book=\$\{bookingTarget\.serviceId \?\? ""\}&gift=\$\{bookingTarget\.giftId\}/);
    assert.match(webClaim, /serviceId: result\.service_id/);
    assert.match(webClaim, /giftId: result\.gift_id/);
  });

  test('the app uses the parameter names the booking screen actually reads', () => {
    const expects = appBook.match(/const \{[^}]*\} = useLocalSearchParams<\{[\s\S]*?\}>/)?.[0] ?? '';
    assert.ok(expects.length > 0, 'booking screen params not found');
    for (const n of ['businessId', 'serviceId', 'giftId']) {
      assert.ok(expects.includes(n), `booking screen no longer reads ${n}`);
    }
    const push = appGifts.match(/function pickSlot[\s\S]*?\n  \}/)?.[0] ?? '';
    assert.match(push, /businessId: g\.business_id/);
    assert.match(push, /serviceId: g\.service_id/);
    assert.match(push, /giftId: g\.id/);
    // The old names must not come back. Comments stripped first: the fix
    // documents the wrong names on purpose, and that prose is not a param.
    const code = push.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const bad of ['gift_service_id', 'gift_id:', 'id: g.business_id']) {
      assert.ok(!code.includes(bad), `pickSlot still sends "${bad}"`);
    }
  });

  test('the app claim screen was already right and still is', () => {
    const push = appClaim.match(/pathname: '\/local-book-business',[\s\S]*?\}\)/)?.[0] ?? '';
    assert.match(push, /businessId: result\.business_id/);
    assert.match(push, /serviceId:\s+result\.service_id/);
    assert.match(push, /giftId:\s+result\.gift_id/);
  });
});

/* ── 2. It reuses the existing picker ─────────────────────────────────────── */

describe('no second slot picker was built', () => {
  test('the business page accepts the deep link', () => {
    assert.match(webBizPage, /searchParams\?: Promise<Record<string, string \| string\[\] \| undefined>>/);
    assert.match(webBizPage, /const openServiceId = one\(sp\.book\)/);
    assert.match(webBizPage, /const openGiftId = one\(sp\.gift\)/);
    assert.match(webBizPage, /openServiceId=\{openServiceId\} openGiftId=\{openGiftId\}/);
  });

  test('and opens the SAME modal the Book button opens', () => {
    assert.match(webSection, /const target = services\.find\(\(s\) => s\.id === openServiceId\)/);
    assert.match(webSection, /setBook\(target\)/);
    assert.match(webSection, /giftId=\{bookGiftId\}/);
    // exactly one BookServiceModal on the page
    assert.equal((webSection.match(/<BookServiceModal/g) ?? []).length, 1);
  });

  test('an ordinary Book press carries no gift', () => {
    assert.match(webSection, /onClick=\{\(\) => \{ setBookGiftId\(null\); setBook\(s\); \}\}/);
  });

  test('the app preselects the gifted service on the existing screen', () => {
    assert.match(appBook, /const targetId = paramServiceId \?\? svcs\[0\]\?\.id;/);
  });
});

/* ── 3. Nobody pays twice ─────────────────────────────────────────────────── */

describe('a gift-funded booking takes no money', () => {
  test('the deposit is zeroed when a gift is attached', () => {
    assert.match(webModal, /const depositPence = giftId \? 0 : service\.requires_deposit \? service\.deposit_pence : 0;/);
  });

  test('and the gift id reaches createBooking', () => {
    assert.match(webModal, /giftId,/);
    assert.match(webBookData, /gift_id: input\.giftId \?\? null,/);
  });

  test('nothing on this path creates a Stripe intent or debits the wallet', () => {
    for (const [name, src] of [['modal', webModal], ['book-data', webBookData], ['app booking', appBook]] as const) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '').toLowerCase();
      for (const b of ['createpaymentintent', 'payment_intent', 'wallet_debit', 'local-wallet-pay', 'stripe_intent']) {
        assert.ok(!code.includes(b), `${name} touches ${b} on the booking path`);
      }
    }
  });
});

/* ── 4. The database decides, not the screen ──────────────────────────────── */

describe('the gift-funded booking guard', () => {
  test('it is a trigger on the table, not a client check', () => {
    assert.match(guard, /create trigger enforce_gift_funded_booking\s*\n\s*before insert or update of gift_id, service_id, business_id, customer_id\s*\n\s*on public\.book_bookings/);
    assert.match(guard, /security definer/);
    assert.match(guard, /set search_path = public, pg_temp/);
  });

  test('an ordinary booking passes straight through', () => {
    assert.match(guard, /if new\.gift_id is null then\s*\n\s*return new;/);
  });

  test('the spender must be the claimant', () => {
    assert.match(guard, /new\.customer_id is distinct from v_gift\.claimed_by_user_id/);
    assert.match(guard, /'gift_not_yours'/);
    assert.match(guard, /v_gift\.claimed_by_user_id is null/);
  });

  test('the gift funds only its own service, at its own business', () => {
    assert.match(guard, /new\.service_id is distinct from v_gift\.service_id/);
    assert.match(guard, /'gift_service_mismatch'/);
    assert.match(guard, /new\.business_id is distinct from v_gift\.business_id/);
    assert.match(guard, /'gift_business_mismatch'/);
  });

  test('an unspendable or expired gift is refused', () => {
    assert.match(guard, /v_gift\.status in \('pending_payment', 'cancelled'\)/);
    assert.match(guard, /v_gift\.expires_at < now\(\)/);
    assert.match(guard, /v_gift\.kind <> 'booking'/);
  });

  test('one live booking per gift, and a cancelled one releases it', () => {
    assert.match(guard, /b\.status <> 'cancelled'/);
    assert.match(guard, /'gift_already_booked'/);
  });

  test('it refuses with a permission error rather than a generic failure', () => {
    const raises = [...guard.matchAll(/raise exception '[a-z_]+' using errcode = '(\d+)'/g)].map((m) => m[1]);
    assert.ok(raises.length >= 7, `expected every refusal to set an errcode, found ${raises.length}`);
    for (const c of raises) assert.equal(c, '42501');
  });
});

/* ── 5. Already booked, and the earlier work ──────────────────────────────── */

describe('nothing already fixed regressed', () => {
  test('a booked gift still hides Pick a time on both clients', () => {
    assert.match(webGifts, /gift\.kind === "booking" && gift\.status === "claimed" && !gift\.booked/);
    assert.match(appGifts, /gift\.kind === 'booking' && gift\.status === 'claimed' && !gift\.booked/);
  });

  test('sent gifts still offer no recipient action', () => {
    const sent = webGifts.match(/function SentGiftRow[\s\S]*?\n}/)?.[0] ?? '';
    assert.ok(sent.length > 0);
    for (const a of ['Pick a time', 'onClick', 'href=']) {
      assert.ok(!sent.includes(a), `the sent card gained "${a}"`);
    }
  });

  test('recipient verification is untouched by this change', () => {
    assert.ok(!/gift_recipient|verification/i.test(guard), 'the booking guard reaches into verification');
    assert.match(webClaim, /verification_required/);
    assert.match(appClaim, /verification_required/);
  });

  test('the guard changes no policy and no payment table', () => {
    assert.ok(!/create policy|drop policy/i.test(guard));
    assert.ok(!/stripe|payment_intent/i.test(guard.replace(/^\s*--.*$/gm, '')));
  });
});
