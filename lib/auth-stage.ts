/**
 * auth-stage.ts — which stage of sign-in did this device reach?
 *
 * Pure (no React Native imports) so the redaction rules can be unit-tested
 * under node. The wiring to the real sinks is lib/auth-diagnostics.ts.
 *
 * WHAT MAY BE RECORDED — an allow-list, not a deny-list:
 *   phase       one of AUTH_PHASES
 *   reason      one of AUTH_REASONS
 *   elapsed_ms  a whole number of milliseconds
 *   attempt     1 or 2 — which try of the verification session this was
 *   keyboard    'visible' | 'hidden' — was the keyboard up when the check began
 *   app_state   'active' | 'inactive' | 'background'
 * Anything else a caller passes is dropped, and a phase/reason outside the
 * lists is dropped rather than passed through — so an email address, a
 * password, a Turnstile token, an access/refresh token, a session object, an
 * auth header or a raw server response cannot reach a sink even by mistake.
 * This matches lib/analytics.ts: props carry no PII, ever.
 */

export const AUTH_STAGES = [
  'auth_submit_started',
  'captcha_session_started',
  // The native session refused to start and the check is being tried once more.
  'captcha_session_retry',
  'captcha_session_completed',
  'captcha_failed',
  'captcha_timed_out',
  'supabase_signin_started',
  'supabase_signin_completed',
  'session_bootstrap_started',
  'session_bootstrap_completed',
  'auth_failed',
  'auth_timed_out',
] as const;
export type AuthStage = (typeof AUTH_STAGES)[number];

export const AUTH_PHASES = ['launch', 'profile'] as const;
export const AUTH_REASONS = [
  // captcha_failed
  'cancelled', 'no_token', 'challenge_failed', 'unavailable',
  // captcha_timed_out / auth_timed_out — who ran out of time
  'app_deadline', 'hosted_page', 'supabase_deadline', 'captcha',
  // supabase_signin_completed / auth_failed
  'ok', 'invalid_credentials', 'email_not_confirmed', 'other', 'exception',
  // session_bootstrap_completed
  'no_session', 'restored', 'error',
] as const;

export const AUTH_ATTEMPTS = [1, 2] as const;
export const AUTH_KEYBOARD_STATES = ['visible', 'hidden'] as const;
export const AUTH_APP_STATES = ['active', 'inactive', 'background'] as const;

export interface AuthStageDetail {
  phase?: (typeof AUTH_PHASES)[number];
  reason?: (typeof AUTH_REASONS)[number];
  elapsedMs?: number;
  attempt?: (typeof AUTH_ATTEMPTS)[number];
  keyboard?: (typeof AUTH_KEYBOARD_STATES)[number];
  appState?: (typeof AUTH_APP_STATES)[number];
}

export type AuthStageProps = {
  phase?: string;
  reason?: string;
  elapsed_ms?: number;
  attempt?: number;
  keyboard?: string;
  app_state?: string;
};

/** Reduces whatever was passed to the allow-listed, non-sensitive props. */
export function authStageProps(detail?: unknown): AuthStageProps {
  const out: AuthStageProps = {};
  if (!detail || typeof detail !== 'object') return out;
  const d = detail as Record<string, unknown>;
  if ((AUTH_PHASES as readonly unknown[]).includes(d.phase)) out.phase = d.phase as string;
  if ((AUTH_REASONS as readonly unknown[]).includes(d.reason)) out.reason = d.reason as string;
  if (typeof d.elapsedMs === 'number' && Number.isFinite(d.elapsedMs) && d.elapsedMs >= 0) {
    out.elapsed_ms = Math.round(d.elapsedMs);
  }
  if ((AUTH_ATTEMPTS as readonly unknown[]).includes(d.attempt)) out.attempt = d.attempt as number;
  if ((AUTH_KEYBOARD_STATES as readonly unknown[]).includes(d.keyboard)) out.keyboard = d.keyboard as string;
  if ((AUTH_APP_STATES as readonly unknown[]).includes(d.appState)) out.app_state = d.appState as string;
  return out;
}

/**
 * Buckets a Supabase auth error into a fixed reason. Only the bucket is ever
 * recorded — never the message, which can echo the email address.
 */
export function classifyAuthError(message: string | null | undefined): 'ok' | 'invalid_credentials' | 'email_not_confirmed' | 'other' {
  if (!message) return 'ok';
  if (message.includes('Invalid login credentials')) return 'invalid_credentials';
  if (message.includes('Email not confirmed')) return 'email_not_confirmed';
  return 'other';
}

export interface AuthStageSinks {
  /** Device log — visible in Console.app / Xcode for a plugged-in phone. */
  log: (line: string) => void;
  /** First-party analytics — visible server-side for a TestFlight tester. */
  track: (eventName: string, props: AuthStageProps) => void;
}

/**
 * Never throws: diagnostics must not be able to break sign-in.
 */
export function createAuthStageLogger(sinks: AuthStageSinks) {
  return function logAuthStage(stage: AuthStage, detail?: AuthStageDetail): void {
    try {
      const props = authStageProps(detail);
      const suffix = Object.entries(props).map(([k, v]) => `${k}=${v}`).join(' ');
      sinks.log(`[OneShetland] auth:${stage}${suffix ? ' ' + suffix : ''}`);
      sinks.track(stage, props);
    } catch {
      /* diagnostics are best-effort */
    }
  };
}
