import * as WebBrowser from 'expo-web-browser';

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

export type TurnstileResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'cancelled' | 'no_token' | 'challenge_failed' };

/**
 * Runs the hosted Turnstile challenge and resolves with a fresh, single-use
 * token — or an explicit failure reason. There is no path that resolves
 * `ok: true` without a real token from the challenge page; a caller that gets
 * `ok: false` must not fall back to calling signUp without one.
 */
export async function getTurnstileToken(): Promise<TurnstileResult> {
  const result = await WebBrowser.openAuthSessionAsync(CHALLENGE_URL, RETURN_URL);

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

  if (error) return { ok: false, reason: 'challenge_failed' };
  if (!token) return { ok: false, reason: 'no_token' };
  return { ok: true, token };
}
