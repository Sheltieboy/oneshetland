/**
 * redemption-ux.ts — telling the two counter jobs apart, in words staff can act on.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * OneShetland gives a merchant two different scanners, and until now nothing on
 * screen said which was which:
 *
 *   Loyalty till          scan the customer's MEMBER CARD, then choose what to
 *                         do — add a stamp, add points, give a ready reward.
 *   Confirm a redemption  scan a one-time REDEMPTION QR the customer generated
 *                         by pressing "Use at till" — a pass, voucher, reward
 *                         or offer that is already earned and about to be spent.
 *
 * Staff holding a customer's phone had no way to know which button was the right
 * one, and the wrong one failed with "Member code not found" or "Code not found,
 * already used, or expired" — messages that read like the customer's credit is
 * gone when in fact the merchant was simply on the wrong screen.
 *
 * WHY A SCANNED PAYLOAD CAN BE CLASSIFIED AT ALL
 *
 * The two codes are structurally different, and both shapes are fixed by the
 * schema rather than by convention:
 *
 *   member code   profiles.member_code, written by ensure_member_code() as
 *                 upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))
 *                 — exactly 8 uppercase hex characters, no hyphens.
 *   redemption    local_redemptions.token, `uuid not null default
 *                 gen_random_uuid()` — a full 36-character UUID.
 *
 * A member code can therefore never be mistaken for a token and vice versa, so
 * the client can say "that's a member card, use the Loyalty till" BEFORE it
 * sends anything anywhere. That is the whole cross-flow guarantee: the wrong
 * code never reaches the wrong endpoint, so it can never have the wrong effect.
 *
 * The 4-character short code (local-redeem-start's makeCode, alphabet
 * ABCDEFGHJKLMNPQRSTUVWXYZ23456789) is typed, not scanned, and is accepted only
 * by the redemption screen's manual field.
 */

/** What a scanned QR payload is, decided from its shape alone. */
export type ScanKind = 'redemption' | 'member' | 'unknown';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER_RE = /^[0-9A-F]{8}$/i;

/**
 * Classify a raw QR payload. Never throws, never calls anything: this runs
 * before any network request so a mis-scan costs nothing.
 */
export function classifyScan(raw: string | null | undefined): ScanKind {
  const s = (raw ?? '').trim();
  if (UUID_RE.test(s)) return 'redemption';
  if (MEMBER_RE.test(s)) return 'member';
  return 'unknown';
}

/** A merchant-facing state: a short headline and one operational sentence. */
export type MerchantState = { title: string; message: string };

/**
 * What to show when the WRONG kind of code is scanned on a screen. Returned
 * instead of calling the backend, so nothing is consumed and nothing is looked
 * up — the merchant is simply pointed at the other button.
 */
export function wrongScannerState(screen: 'redemption' | 'till', scanned: ScanKind): MerchantState | null {
  if (screen === 'redemption') {
    if (scanned === 'member') {
      return {
        title: 'That’s a member card',
        message: 'This screen redeems a reward the customer has already claimed. To add a stamp or points, go back and use the Loyalty till.',
      };
    }
    if (scanned === 'unknown') {
      return {
        title: 'Not a OneShetland code',
        message: 'That QR isn’t a customer reward code. Ask them to open their reward in the app and tap “Use at till”.',
      };
    }
    return null;
  }
  if (scanned === 'redemption') {
    return {
      title: 'That’s a reward code',
      message: 'This screen scans a customer’s member card. To redeem that reward, go back and use “Redeem a reward”.',
    };
  }
  if (scanned === 'unknown') {
    return {
      title: 'Not a member card',
      message: 'That QR isn’t a customer member card. Ask them to show their card from the OneShetland app.',
    };
  }
  return null;
}

/**
 * Turn whatever came back into something a merchant can act on.
 *
 * Every message the redemption endpoints deliberately return is mapped by hand.
 * Anything else — a PostgREST constraint string, a Supabase transport message, a
 * message we have never seen — collapses to one "can't check right now" state,
 * because a merchant cannot act on internals and should not be shown them. The
 * original text is not discarded: it is returned as `detail` for logging.
 */
export function redemptionErrorState(err: unknown): MerchantState & { detail: string } {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const known = matchKnown(raw);
  return { ...(known ?? UNRECOGNISED), detail: raw };
}

const UNRECOGNISED: MerchantState = {
  title: 'Unable to check right now',
  message: 'We couldn’t reach OneShetland to check that code. Nothing has been used. Check your connection and try again.',
};

function matchKnown(raw: string): MerchantState | null {
  const m = raw.trim();
  switch (m) {
    case 'Already redeemed':
      return {
        title: 'Already used',
        message: 'This has already been redeemed. It hasn’t been taken a second time.',
      };
    case 'Already used by this member':
      return {
        title: 'Already used',
        message: 'This customer has already used that offer.',
      };
    case 'No uses left':
      return {
        title: 'No uses left',
        message: 'There are no uses left on this pass.',
      };
    case 'This pass has expired':
      return {
        title: 'Expired',
        message: 'This pass has expired, so it can’t be used.',
      };
    case 'Offer no longer active':
    case 'Offer not available':
      return {
        title: 'No longer available',
        message: 'That offer isn’t running any more.',
      };
    // The code is real and the caller owns the business that issued it — but
    // that is not the business they are standing in. Named separately from the
    // stranger's-code case below, and never as "already used", which would tell
    // a merchant a perfectly good reward had been spent.
    case 'This reward is not for this business':
      return {
        title: 'Not for this business',
        message: 'This reward was earned at one of your other businesses, so it can’t be redeemed here.',
      };
    case 'That is not your business.':
      return {
        title: 'Wrong business',
        message: 'You’re not set up to redeem for that business. Open the business you’re serving and try again.',
      };
    case 'That code is not for your business':
      return {
        title: 'Another business’s code',
        message: 'That code belongs to a different business, so it can’t be redeemed here.',
      };
    case 'No reward ready to claim':
      return {
        title: 'No reward ready',
        message: 'This customer hasn’t earned a reward yet.',
      };
    case 'Not enough points':
      return {
        title: 'Not enough points',
        message: 'There aren’t enough points on this card for that reward.',
      };
    case 'Code not found, already used, or expired':
      return {
        title: 'Code not valid',
        message: 'We couldn’t find that code — it may already have been used, or it may have expired. Ask the customer to open the reward again and tap “Use at till”.',
      };
    case 'Card not found':
    case 'Pass not found':
      return {
        title: 'Not found',
        message: 'We couldn’t find what that code is for. Ask the customer to show it again from the app.',
      };
    case 'You do not run a business':
      return {
        title: 'No business on this account',
        message: 'This account doesn’t run a business, so it can’t redeem customer codes.',
      };
    case 'Unauthorised':
      return {
        title: 'Signed out',
        message: 'Sign in again to redeem customer codes.',
      };
    // The 500s the verify function returns when its own RPC threw. The RPC
    // throwing means its transaction rolled back, so nothing was taken — which
    // is the one thing a merchant standing at a till needs to be told.
    case 'Could not redeem that code.':
    case 'Could not redeem that pass.':
    case 'Could not look that code up.':
      return {
        title: 'Didn’t go through',
        message: 'Something went wrong at our end, so nothing was redeemed. Try again.',
      };
    default:
      return null;
  }
}

/**
 * The same treatment for the Loyalty till. Its deliberate messages are already
 * written for staff, so they pass through verbatim; anything else — including
 * the PostgREST text `loyalty-till` still returns when an offer insert fails for
 * a reason other than a duplicate — collapses to one safe sentence with the
 * original kept for the log.
 */
export function tillErrorState(err: unknown): MerchantState & { detail: string } {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const m = raw.trim();
  if (TILL_MESSAGES.has(m)) return { title: m, message: '', detail: raw };
  switch (m) {
    case 'Member code not found':
      return {
        title: 'Not a member card',
        message: 'We couldn’t find that member card. Ask the customer to show their card from the OneShetland app.',
        detail: raw,
      };
    case 'Unauthorised':
      return { title: 'Signed out', message: 'Sign in again to use the till.', detail: raw };
    default:
      return {
        title: 'Unable to check right now',
        message: 'We couldn’t reach OneShetland. Nothing has been changed. Check your connection and try again.',
        detail: raw,
      };
  }
}

/**
 * Exactly the strings loyalty-till returns on purpose. Every entry appears
 * verbatim in supabase/functions/loyalty-till/index.ts, except the last, which
 * is SAFE_ERROR_MESSAGE from supabase/functions/_shared/safe-error.ts — the one
 * sentence that function's catch-all is allowed to return. A message that is not
 * on this list is treated as internal and never shown.
 */
const TILL_MESSAGES = new Set([
  'Pick which business this is for',
  'You do not run a business',
  "That's your own code",
  'No stamp card here',
  'Just stamped \u2014 give it a moment',
  'No points card here',
  'Enter the amount spent',
  'That earns no points',
  'No programme here',
  'No card yet',
  'No reward ready',
  'That card is not for your business',
  'Offer not available',
  'Already used by this member',
  "Couldn't save the stamp.",
  "Couldn't save the points.",
  "Couldn't record the redemption.",
  'Something went wrong. Please try again.',
]);
