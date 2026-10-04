/**
 * gift-to-book-discovery.node.test.ts
 *
 * A recipient who claims a booking gift and later cancels the resulting
 * booking gets the gift correctly reopened server-side (see
 * gift-funded-booking-status-sync.node.test.ts) — but the only obvious way
 * back into it was the original claim email/link. That's poor UX: an
 * entitlement already on the account shouldn't need an old email to use.
 *
 * Rather than fabricate a fake booking row before a slot exists, claimed-
 * but-unspent booking gifts are surfaced as an actionable entitlement:
 *   - mobile: a "Gifts to book" strip above Upcoming on local-my-bookings.tsx
 *   - web:    the same section on /account/bookings
 *   - both:   a light nudge in the existing For You / home feed
 *
 * No new server code. This reuses, unmodified, three things already proven
 * elsewhere:
 *   1. fetchMyGiftsReceived's `booked` derivation — a live join against
 *      book_bookings excluding cancelled rows, NOT book_gifts.status alone
 *      (local-my-gifts.tsx already relies on this for its own "Pick a slot").
 *      Because sync_gift_status_with_booking now keeps status and booked in
 *      lockstep (proved in gift-funded-booking-status-sync.node.test.ts:
 *      creation -> used, cancellation -> claimed, rebooking -> used again),
 *      `status === 'claimed' && !booked` is exactly "no live booking
 *      currently consumes it" — this file does not re-prove that DB
 *      behaviour, only that the UI reads it with the right predicate.
 *   2. the existing serviceId/giftId deep link into local-book-business
 *      (mobile) and ?book=<serviceId>&gift=<giftId> into ServicesSection /
 *      BookServiceModal (web) — both already used by the gift-claim flow.
 *   3. book_gifts RLS ("Claimers see gifts they've claimed": claimed_by_user_id
 *      = auth.uid()) — the only ownership boundary that matters, since every
 *      list here is scoped by .eq("claimed_by_user_id", ...). A client-
 *      supplied gift_id still has to pass enforce_gift_funded_booking's own
 *      claimant/service/business/one-live-booking checks regardless of how
 *      the id reached the screen — unchanged by this task.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT   = join(REPO_ROOT, '..', 'oneshetland-web');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `function ${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(export )?(async function|function|const|type|interface) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/* ── 1. The filter predicate: claimed + booking + not already booked ─────── */

describe('the "Gifts to book" predicate is exactly the entitlement that should surface', () => {
  test('mobile local-my-bookings.tsx filters kind, status and booked together', () => {
    const screen = code(read('app/local-my-bookings.tsx'));
    assert.match(screen, /gifts\.filter\(g => g\.kind === 'booking' && g\.status === 'claimed' && !g\.booked\)/);
  });

  test('web BookingsClient.tsx applies the identical predicate', () => {
    const client = code(readWeb('app/account/bookings/BookingsClient.tsx'));
    assert.match(client, /gifts\.filter\(\(g\) => g\.kind === "booking" && g\.status === "claimed" && !g\.booked\)/);
  });

  test('a USED gift is excluded on both platforms — status must be exactly "claimed"', () => {
    // Not `!== 'used'` (which would also admit 'cancelled' if that ever
    // became a real book_gifts status here) — an explicit allow-list.
    const screen = code(read('app/local-my-bookings.tsx'));
    const client = code(readWeb('app/account/bookings/BookingsClient.tsx'));
    assert.match(screen, /g\.status === 'claimed'/);
    assert.doesNotMatch(screen, /g\.status !== 'used'/);
    assert.match(client, /g\.status === "claimed"/);
  });

  test('booked is read from fetchMyGiftsReceived\'s own derivation, not reimplemented', () => {
    // Both screens consume the `booked` field as-is; neither screen queries
    // book_bookings itself to work it out again.
    const screen = read('app/local-my-bookings.tsx');
    const client = readWeb('app/account/bookings/BookingsClient.tsx');
    assert.doesNotMatch(code(screen), /from\('book_bookings'\)/);
    assert.doesNotMatch(code(client), /from\("book_bookings"\)/);
    assert.match(screen, /fetchMyGiftsReceived/);
    assert.match(client, /fetchMyGiftsReceived/);
  });
});

/* ── 2. Ownership: every source list is scoped to the caller ─────────────── */

describe('another user\'s claimed gift cannot surface — every source is owner-scoped', () => {
  test('mobile fetchMyGiftsReceived scopes by claimed_by_user_id', () => {
    const api = read('lib/local-api.ts');
    const fn = functionBody(api, 'fetchMyGiftsReceived');
    assert.match(fn, /\.eq\('claimed_by_user_id', userId\)/);
  });

  test('web fetchMyGiftsReceived scopes by the authenticated caller\'s own id, not a passed-in id', () => {
    const data = readWeb('lib/passes-data.ts');
    const start = data.indexOf('export async function fetchMyGiftsReceived');
    const fn = data.slice(start, data.indexOf('\n}\n', start) + 2);
    assert.match(fn, /\.eq\("claimed_by_user_id", auth\.user\.id\)/);
    assert.doesNotMatch(fn, /export async function fetchMyGiftsReceived\([^)]+\)/, 'no userId parameter — a caller cannot ask for someone else\'s gifts');
  });

  test('web fetchGiftsToBook (For You) is scoped the same way', () => {
    const forYou = readWeb('lib/for-you.server.ts');
    const fn = functionBody(forYou, 'fetchGiftsToBook');
    assert.match(fn, /\.eq\("claimed_by_user_id", userId\)/);
    assert.match(fn, /\.eq\("status", "claimed"\)/);
    assert.match(fn, /\.eq\("kind", "booking"\)/);
  });

  test('mobile home tile is gated on personal.giftToClaim, itself scoped in getGiftToClaim', () => {
    const home = read('lib/home-data.ts');
    const fn = functionBody(home, 'getGiftToClaim');
    assert.match(fn, /\.eq\('claimed_by_user_id', userId\)/);
    assert.match(fn, /\.eq\('status', 'claimed'\)/);
    assert.match(fn, /\.eq\('kind', 'booking'\)/);
  });
});

/* ── 3. Book now carries the right IDs into the existing booking flow ────── */

describe('Book now enters the existing flow with business, service and gift already selected', () => {
  test('mobile goBookGift pushes businessId, serviceId and giftId — no new navigation mechanism', () => {
    const screen = read('app/local-my-bookings.tsx');
    const fn = functionBody(screen, 'MyBookingsScreen'); // goBookGift is a const inside; search the whole file instead
    void fn;
    const goBook = screen.slice(screen.indexOf('const goBookGift'), screen.indexOf('const handleCancel'));
    assert.match(goBook, /pathname: '\/local-book-business'/);
    assert.match(goBook, /businessId: g\.business_id/);
    assert.match(goBook, /serviceId: g\.service_id/);
    assert.match(goBook, /giftId: g\.id/);
  });

  test('web GiftToBookRow links to the business page with ?book=<serviceId>&gift=<giftId> — the same param names the claim flow already installed', () => {
    const client = readWeb('app/account/bookings/BookingsClient.tsx');
    const fn = functionBody(client, 'GiftToBookRow');
    assert.match(fn, /`\$\{bizHref\}\?book=\$\{gift\.service_id\}&gift=\$\{gift\.id\}`/);
  });

  test('the web business page already reads ?book= and ?gift= into ServicesSection — confirmed, not assumed', () => {
    const page = readWeb('app/directory/[id]/page.tsx');
    assert.match(page, /const openServiceId = one\(sp\.book\);/);
    assert.match(page, /const openGiftId = one\(sp\.gift\);/);
    assert.match(page, /openServiceId=\{openServiceId\} openGiftId=\{openGiftId\}/);
  });

  test('ServicesSection wires openGiftId straight into BookServiceModal\'s giftId — no client-side re-derivation of ownership', () => {
    const section = readWeb('components/local/ServicesSection.tsx');
    assert.match(section, /setBookGiftId\(openGiftId \?\? null\)/);
    assert.match(section, /giftId=\{bookGiftId\}/);
  });

  test('mobile local-book-business.tsx already threads giftId through to createBooking — confirmed, not assumed', () => {
    const screen = read('app/local-book-business.tsx');
    assert.match(screen, /giftId\s*} = useLocalSearchParams/);
    assert.match(screen, /\.\.\.\(giftId \? \{ giftId \} : \{\}\)/);
  });
});

/* ── 4. For You: one actionable nudge, pointed at the real destination ───── */

describe('For You surfaces the entitlement once, without duplicating the actionable UI', () => {
  test('web fetchGiftsToBook returns at most one item, and it links to My Bookings rather than re-implementing the direct book link', () => {
    const forYou = readWeb('lib/for-you.server.ts');
    const fn = functionBody(forYou, 'fetchGiftsToBook');
    assert.match(fn, /unspent\[0\]/, 'only the single most relevant claimed gift is surfaced');
    assert.match(fn, /href: "\/account\/bookings"/);
    assert.doesNotMatch(fn, /\?book=/, 'For You should not re-implement the direct ?book=&gift= link — My Bookings already does');
  });

  test('web fetchGiftsToBook also excludes gifts that already have a live booking — same booked derivation', () => {
    const forYou = readWeb('lib/for-you.server.ts');
    const fn = functionBody(forYou, 'fetchGiftsToBook');
    assert.match(fn, /from\("book_bookings"\)\.select\("gift_id"\)\.in\("gift_id", giftIds\)\.neq\("status", "cancelled"\)/);
    assert.match(fn, /unspent = rows\.filter\(\(r\) => !bookedIds\.has\(r\.id\)\)/);
  });

  test('mobile home tile copy names the action ("book"), and still routes through the single My Gifts destination', () => {
    const forYou = read('components/home-local/forYou.ts');
    const tile = forYou.slice(forYou.indexOf("if (h?.giftToClaim)"), forYou.indexOf("if (i.walletPence"));
    assert.match(tile, /You have a gift to book/);
    assert.match(tile, /pathname: '\/local-my-gifts'/);
  });

  test('the mobile gift tile is one of the person\'s own live commitments — built before wallet, nearby and saved items', () => {
    const forYou = read('components/home-local/forYou.ts');
    assert.ok(forYou.indexOf("id: 'gift'") > 0 && forYou.indexOf("id: 'gift'") < forYou.indexOf("id: 'wallet'"));
    assert.ok(forYou.indexOf("id: 'gift'") < forYou.indexOf("id: 'nearby'"));
  });
});
