import { Platform, Keyboard, AppState } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { withDeadline, TIMED_OUT } from './with-deadline';
import { logAuthStage } from './auth-diagnostics';

/**
 * turnstile.ts — obtaining a Cloudflare Turnstile token on mobile.
 *
 * Build #38 has no first-party way to run a Turnstile widget itself. Rather
 * than add a new native dependency (a WebView-embedded widget would need
 * react-native-webview, which this app does not currently carry and which
 * would require a native rebuild to add), this reuses the exact pattern
 * already proven in this app for the same shape of problem — driver Connect
 * onboarding (app/(driver)/connect-bank.tsx): open a legitimate
 * oneshetland.com page in expo-web-browser's in-app browser session, run the
 * web-only flow there, and get the result back over the app's own
 * oneshetland-fetch:// scheme. expo-web-browser is already a dependency —
 * nothing new is linked, so this ships as a plain JS/OTA update.
 *
 * The hosted page (oneshetland-web: app/mobile-turnstile-challenge) renders
 * the same Managed Turnstile widget the website's own sign-up form uses, with
 * the same public site key. No Turnstile secret is ever reachable from here —
 * verification happens entirely server-side, inside Supabase Auth.
 */

const CHALLENGE_URL = 'https://oneshetland.com/mobile-turnstile-challenge';
const RETURN_URL = 'oneshetland-fetch://turnstile-callback';

/**
 * Ceiling on the whole hosted check, sheet included. The native call has no
 * timeout of its own, so without this a sheet that never presents (or a page
 * that never returns) waits forever. A check that has produced nothing in 30s
 * should fail cleanly and let the person retry. This bounds the challenge stage
 * ONLY — the Supabase sign-in that follows has its own, separate deadline
 * (SIGN_IN_TIMEOUT_MS in context/AuthContext.tsx).
 *
 * The hosted page reports its own timeouts sooner (25s, with a reason), so this
 * is the backstop for the cases where the page never gets to speak at all.
 */
export const CHALLENGE_TIMEOUT_MS = 30_000;

/**
 * Failure reasons the hosted page may send back as `?error=`. These two mean
 * "ran out of time"; every other value is a plain failure. Neither is ever a
 * token — the caller still gets `ok: false`.
 */
const HOSTED_TIMEOUT_REASONS = ['challenge_timeout', 'script_load_timeout'];

export type TurnstileResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'cancelled' | 'no_token' | 'challenge_failed' | 'timeout' | 'unavailable' };

/**
 * True when the NATIVE module refused to start the auth session at all.
 * expo-web-browser 55.0.19+ rejects with WebAuthSessionFailedToStartException
 * when ASWebAuthenticationSession.start() returns false. Older versions ignored
 * that result and left the promise pending for ever — which is how a sign-in
 * spinner could run until the 30s ceiling with no stage after
 * captcha_session_started. Kept as its own reason ('unavailable') so it can be
 * told apart from a hosted-page failure in diagnostics; the person still just
 * sees the ordinary "couldn't complete the check" message and can retry.
 */
function isSessionFailedToStart(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  return e?.code === 'ERR_WEB_AUTH_SESSION_FAILED_TO_START'
    || (typeof e?.message === 'string' && /authentication session could not be started/i.test(e.message));
}

/**
 * Ends any native auth session still pending. The iOS module throws
 * WebBrowserAlreadyOpenException for as long as a previous session's promise is
 * unresolved, and resolves that promise itself when dismissed — so this both
 * unblocks the next attempt and settles an abandoned one. Harmless (a no-op)
 * when nothing is open. Android runs the polyfill, which has no such lock.
 */
function releaseAuthSession(): void {
  if (Platform.OS !== 'ios') return;
  try {
    WebBrowser.dismissAuthSession();
  } catch {
    /* nothing open */
  }
}

/**
 * The one automatic retry of a native session that would not start. iOS 27
 * devices were observed failing the FIRST start() in ~8ms and succeeding on the
 * person's second tap, seconds later. Long enough for the keyboard's hide
 * animation (~250-300ms) and a couple of frames to finish, short enough to read
 * as the sheet opening after a beat. Not tuned against an iOS 27 device — the
 * captcha_session_retry / attempt=2 diagnostics show whether it is enough.
 */
export const SESSION_RETRY_DELAY_MS = 450;

/** Upper bound on waiting for the keyboard to finish hiding before presenting. */
const KEYBOARD_SETTLE_MAX_MS = 500;

/** Best-effort UI state for diagnostics; never throws, never sensitive. */
function presentationState(): { keyboard: 'visible' | 'hidden'; appState: 'active' | 'inactive' | 'background' } {
  let keyboard: 'visible' | 'hidden' = 'hidden';
  let appState: 'active' | 'inactive' | 'background' = 'active';
  try { if (Keyboard.isVisible()) keyboard = 'visible'; } catch { /* unknown → hidden */ }
  try {
    const s = AppState.currentState;
    if (s === 'active' || s === 'inactive' || s === 'background') appState = s;
  } catch { /* unknown → active */ }
  return { keyboard, appState };
}

/**
 * ASWebAuthenticationSession is anchored to UIApplication.keyWindow. Pressing
 * Sign in leaves the password field focused, so the keyboard (and its Done bar)
 * is still up in the same tick the session starts. Put the keyboard away and
 * wait — bounded, never hanging — for it to finish hiding before presenting.
 * iOS only, and a no-op when no keyboard is showing.
 */
async function settleKeyboard(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    if (!Keyboard.isVisible()) return;
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let sub: { remove(): void } | undefined;
    const finish = () => {
      clearTimeout(timer);
      try { sub?.remove(); } catch { /* already gone */ }
      resolve();
    };
    const timer = setTimeout(finish, KEYBOARD_SETTLE_MAX_MS);
    try {
      sub = Keyboard.addListener('keyboardDidHide', finish);
      Keyboard.dismiss();
    } catch {
      finish();
    }
  });
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Opens the hosted challenge and interprets what comes back. Never throws and
 * always settles — see getTurnstileToken. Timeouts are logged here, where the
 * source (this app's deadline vs the hosted page) is known; every other outcome
 * is logged once by getTurnstileToken.
 *
 * The 30s ceiling is for the whole check, not per attempt: a retry only gets
 * whatever is left of it.
 */
async function runChallenge(startedAt: number): Promise<TurnstileResult> {
  try {
    releaseAuthSession();

    const budgetLeft = Math.max(0, CHALLENGE_TIMEOUT_MS - (Date.now() - startedAt));
    const result = await withDeadline(
      WebBrowser.openAuthSessionAsync(CHALLENGE_URL, RETURN_URL),
      budgetLeft,
      releaseAuthSession,
    );
    if (result === TIMED_OUT) {
      logAuthStage('captcha_timed_out', { reason: 'app_deadline', elapsedMs: Date.now() - startedAt });
      return { ok: false, reason: 'timeout' };
    }

    if (result.type !== 'success' || !result.url) {
      // Covers 'cancel' (user dismissed) and 'dismiss' (backgrounded/closed).
      return { ok: false, reason: 'cancelled' };
    }

    let token: string | null = null;
    let error: string | null = null;
    try {
      const parsed = new URL(result.url);
      token = parsed.searchParams.get('token');
      error = parsed.searchParams.get('error');
    } catch {
      return { ok: false, reason: 'challenge_failed' };
    }

    if (error && HOSTED_TIMEOUT_REASONS.includes(error)) {
      logAuthStage('captcha_timed_out', { reason: 'hosted_page', elapsedMs: Date.now() - startedAt });
      return { ok: false, reason: 'timeout' };
    }
    if (error) return { ok: false, reason: 'challenge_failed' };
    if (!token) return { ok: false, reason: 'no_token' };
    return { ok: true, token };
  } catch (err) {
    console.warn('[OneShetland] Challenge session failed to run:', err);
    return { ok: false, reason: isSessionFailedToStart(err) ? 'unavailable' : 'challenge_failed' };
  }
}

/**
 * Runs the hosted Turnstile challenge and resolves with a fresh, single-use
 * token — or an explicit failure reason. There is no path that resolves
 * `ok: true` without a real token from the challenge page; a caller that gets
 * `ok: false` must not fall back to calling signUp without one. A timeout is a
 * failure, never a pass.
 *
 * It always settles: within CHALLENGE_TIMEOUT_MS, and it never throws — a
 * native rejection becomes `challenge_failed` rather than leaving the caller's
 * spinner running.
 *
 * Exactly ONE automatic retry, and only for `unavailable` — the native session
 * refusing to start at all. Nothing else is retried: not a cancel, a hosted-page
 * failure, an expired/invalid token or a timeout. The retry opens a brand-new
 * session and needs its own genuine token; there is still no path to ok:true
 * without one.
 */
export async function getTurnstileToken(): Promise<TurnstileResult> {
  const startedAt = Date.now();
  const ui = presentationState();
  logAuthStage('captcha_session_started', { keyboard: ui.keyboard, appState: ui.appState });

  await settleKeyboard();
  let result = await runChallenge(startedAt);
  let attempt: 1 | 2 = 1;

  if (!result.ok && result.reason === 'unavailable') {
    attempt = 2;
    logAuthStage('captcha_session_retry', { reason: 'unavailable', attempt: 2, elapsedMs: Date.now() - startedAt });
    releaseAuthSession();
    await settleKeyboard();
    await pause(SESSION_RETRY_DELAY_MS);
    result = await runChallenge(startedAt);
  }

  const elapsedMs = Date.now() - startedAt;
  const tried = attempt === 2 ? { attempt: 2 as const } : {};
  if (result.ok) {
    logAuthStage('captcha_session_completed', { elapsedMs, ...tried });
  } else if (result.reason !== 'timeout') {
    logAuthStage('captcha_failed', { reason: result.reason, elapsedMs, ...tried });
  }
  return result;
}
