/**
 * send-push.ts — shared helper for Expo Push Notifications
 *
 * Uses the free Expo Push API (https://exp.host/api/v2/push/send).
 * No APNs/FCM credentials needed — Expo handles that for you.
 *
 * Phase 1a of the notifications foundation adds:
 *   • categoryId          — drives iOS action buttons (Apple Watch wrist actions)
 *   • preference check    — respects notification_preferences + quiet hours
 *     via the public.should_notify(user_id, module, urgent) Postgres function
 *   • notification_log    — every attempt is recorded for debug + audit
 *
 * Senders should call the new `sendUserPush` (preferences-aware). The original
 * `sendPush` is kept as a low-level escape hatch that bypasses preferences —
 * use it only for genuinely critical pushes that should never be muted.
 *
 * FAILS CLOSED (31 Oct 2026). If the preference check cannot be completed (the rpc errors, throws, times out or answers with anything other than
 * true/false) NOTHING is sent: the member's opt-in is never assumed. The check is retried once, quickly, so a momentary blip does not drop a legitimate
 * notification; after that the result is { status: 'error', reason: 'preference_check_failed' } and the attempt is logged as an error, never as sent.
 * `urgent` still only bypasses QUIET HOURS (inside should_notify, after the master and module switches): it never bypasses an opt-out or a failed check.
 *
 * The result carries an additive `reason` so callers can tell the outcomes apart (`status` keeps its existing values):
 *   accepted              status 'sent'          the push PROVIDER accepted it for at least one device (NOT confirmation that a handset received it)
 *   preference_check_failed status 'error'        could not read the preferences: not sent
 *   opted_out             status 'skipped_pref'  master switch or this module is off: not sent
 *   quiet_hours           status 'skipped_quiet' in quiet hours (non-urgent): not sent, and NOT retried or sent later
 *   preference_blocked    status 'skipped_pref'  refused, but the reason could not be determined: not sent
 *   no_device             status 'no_token'      no valid device token: not sent
 *   provider_error        status 'error'         the provider rejected or could not be reached: not sent
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type NotificationModule =
  | 'bookings' | 'shifts' | 'fetch' | 'loyalty' | 'offers' | 'spik' | 'games'
  | 'jobs' | 'events' | 'cruise' | 'wallet' | 'hubs' | 'community'
  | 'notices' | 'business';

export type PushReason = 'accepted' | 'claim_lost' | 'preference_check_failed' | 'opted_out' | 'quiet_hours' | 'preference_blocked' | 'no_device' | 'provider_error';
export type LogStatus = 'sent' | 'skipped_pref' | 'skipped_quiet' | 'no_token' | 'error';
export interface SendUserPushResult { status: LogStatus; error?: string; reason: PushReason }

/** The preference check is attempted this many times (one quick retry for a transient fault), each with this timeout. (An object only so tests can shorten the waits.) */
export const preferenceCheckConfig = { attempts: 2, timeoutMs: 4000, retryDelayMs: 250 };

export interface SendUserPushInput {
  userId:     string;                  // recipient (used for prefs + log)
  module:     NotificationModule;
  categoryId: string;                  // e.g. "bookings.new" — must be registered client-side
  title:      string;
  body:       string;
  data?:      Record<string, unknown>;
  urgent?:    boolean;                 // bypass quiet hours (default false)
  sound?:     'default' | null;        // default 'default'
  /** called after the preference check and device lookup, right before the provider is contacted; returning false (or throwing) stops the send (reason 'claim_lost') */
  beforeProvider?: () => Promise<boolean | void>;
}

/**
 * Preferences-aware push to one user.
 * Looks up the recipient's push_token, checks should_notify(), sends if allowed,
 * and logs the outcome.
 */
export async function sendUserPush(
  supabase: SupabaseClient,
  input: SendUserPushInput,
): Promise<SendUserPushResult> {

  // 1. Check preferences + quiet hours via the DB function. FAIL CLOSED: a check that cannot be completed is never permission.
  const decision = await preferenceDecision(supabase, input.userId, input.module, input.urgent ?? false);
  if (decision === 'failed') {
    console.error('[send-push] preference check failed; not sending');
    await logAttempt(supabase, input, 'error', 'preference_check_failed');
    return { status: 'error', error: 'preference_check_failed', reason: 'preference_check_failed' };
  }
  if (decision === 'blocked') {
    // should_notify answers only true/false. Asked again as URGENT it differs only by ignoring quiet hours, which tells a quiet-hours hold from an opt-out.
    // (An urgent send that is blocked can only be a master/module opt-out.)
    const ignoringQuiet = input.urgent ? 'blocked' : await preferenceDecision(supabase, input.userId, input.module, true, 1);
    if (ignoringQuiet === 'allow') {
      await logAttempt(supabase, input, 'skipped_quiet');
      return { status: 'skipped_quiet', error: 'quiet_hours', reason: 'quiet_hours' };
    }
    const reason: PushReason = ignoringQuiet === 'blocked' ? 'opted_out' : 'preference_blocked';
    await logAttempt(supabase, input, 'skipped_pref');
    return { status: 'skipped_pref', error: reason, reason };
  }

  // 2. Look up every active push token for this user (multi-device), falling
  //    back to the legacy profiles.push_token column.
  const tokens = await getUserPushTokens(supabase, input.userId);
  if (tokens.length === 0) {
    await logAttempt(supabase, input, 'no_token');
    return { status: 'no_token', error: 'no_device', reason: 'no_device' };
  }

  // 2b. Callers that coordinate through a database claim (reminder-runner) are asked LAST, immediately before the first byte goes to the provider: it records
  //     "a send began" so a crash after this point is never mistaken for "nothing was sent". A false answer or a throw means the claim is no longer ours: send nothing.
  if (input.beforeProvider) {
    let still = false;
    try { still = (await input.beforeProvider()) !== false; } catch (e) { console.error('[send-push] beforeProvider failed; not sending', e); }
    if (!still) return { status: 'error', error: 'claim_lost', reason: 'claim_lost' };
  }

  // 3. Send to each device. Prune any token Expo reports as unregistered.
  let anyOk = false;
  let lastError: string | undefined;
  for (const token of tokens) {
    const result = await sendPushRaw({
      token,
      title:      input.title,
      body:       input.body,
      data:       { ...(input.data ?? {}), categoryId: input.categoryId },
      categoryId: input.categoryId,
      sound:      input.sound === null ? null : 'default',
    });
    if (result.ok) {
      anyOk = true;
    } else {
      lastError = result.error;
      if (result.deviceNotRegistered) {
        await pruneToken(supabase, input.userId, token);
      }
    }
  }

  // 4. Log once per notification (not per device) — this row backs the in-app
  //    inbox, so we want one entry the user can see and mark read.
  await logAttempt(supabase, input, anyOk ? 'sent' : 'error', anyOk ? undefined : lastError);

  return anyOk ? { status: 'sent', reason: 'accepted' } : { status: 'error', error: lastError ?? 'provider_error', reason: 'provider_error' };
}

/**
 * Collect every valid Expo push token for a user: the push_tokens table
 * (multi-device) plus the legacy profiles.push_token column, de-duplicated.
 */
async function getUserPushTokens(
  supabase: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const set = new Set<string>();

  const { data: rows } = await supabase
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  for (const r of rows ?? []) {
    const t = (r as { token?: string }).token;
    if (t?.startsWith('ExponentPushToken[')) set.add(t);
  }

  // Legacy fallback for users who registered before push_tokens existed.
  const { data: profile } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', userId)
    .maybeSingle();
  const legacy = (profile as { push_token?: string } | null)?.push_token;
  if (legacy?.startsWith('ExponentPushToken[')) set.add(legacy);

  return [...set];
}

/** Remove a dead token (Expo reported DeviceNotRegistered) from both stores. */
async function pruneToken(
  supabase: SupabaseClient,
  userId: string,
  token: string,
): Promise<void> {
  try {
    await supabase.from('push_tokens').delete().eq('token', token);
    await supabase
      .from('profiles')
      .update({ push_token: null })
      .eq('id', userId)
      .eq('push_token', token);
  } catch (e) {
    console.error('[send-push] pruneToken failed:', e);
  }
}

/**
 * Convenience: send the same notification to multiple users at once. Loops
 * sendUserPush — keeps preferences/quiet-hours checks honoured per recipient.
 */
export async function sendUserPushBulk(
  supabase: SupabaseClient,
  userIds: string[],
  payload: Omit<SendUserPushInput, 'userId'>,
): Promise<{ sent: number; skipped: number; errored: number; checkFailed: number }> {
  const results = await Promise.allSettled(
    userIds.map(uid => sendUserPush(supabase, { ...payload, userId: uid })),
  );
  let sent = 0, skipped = 0, errored = 0, checkFailed = 0;
  for (const r of results) {
    if (r.status === 'rejected') { errored++; continue; }
    const s = r.value.status;
    if (s === 'sent')          sent++;
    else if (s === 'error')  { errored++; if (r.value.reason === 'preference_check_failed') checkFailed++; }   // counted in errored too: additive
    else                       skipped++;
  }
  return { sent, skipped, errored, checkFailed };
}

// ── Low-level helper (back-compat for existing senders) ──────────────────────
/**
 * Raw send — no preference check, no logging. Existing senders use this; new
 * senders should prefer sendUserPush. Keeping the signature back-compat so
 * we don't break the 11 functions already in production.
 */
export async function sendPush(
  token: string | null | undefined,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  categoryId?: string,
): Promise<void> {
  await sendPushRaw({
    token, title, body, data, categoryId, sound: 'default',
  });
}


type PreferenceDecision = 'allow' | 'blocked' | 'failed';

/** should_notify with a timeout and a bounded retry. Anything but a clean true/false (error, exception, timeout, null, a string) is 'failed': never 'allow'. */
async function preferenceDecision(supabase: SupabaseClient, userId: string, module: NotificationModule, urgent: boolean, attempts = preferenceCheckConfig.attempts): Promise<PreferenceDecision> {
  for (let i = 0; i < attempts; i++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('preference check timed out')), preferenceCheckConfig.timeoutMs); });
      const res = await Promise.race([Promise.resolve(supabase.rpc('should_notify', { p_user_id: userId, p_module: module, p_urgent: urgent })), timeout]) as { data: unknown; error: unknown };
      if (!res.error && res.data === true) return 'allow';
      if (!res.error && res.data === false) return 'blocked';
      console.error('[send-push] should_notify gave no usable answer:', res.error ?? typeof res.data);
    } catch (e) {
      console.error('[send-push] should_notify threw:', e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, preferenceCheckConfig.retryDelayMs));
  }
  return 'failed';
}

// ── Internals ────────────────────────────────────────────────────────────────


async function sendPushRaw(opts: {
  token:       string | null | undefined;
  title:       string;
  body:        string;
  data?:       Record<string, unknown>;
  categoryId?: string;
  sound?:      'default' | null;
}): Promise<{ ok: boolean; error?: string; deviceNotRegistered?: boolean }> {
  if (!opts.token?.startsWith('ExponentPushToken[')) {
    return { ok: false, error: 'invalid_token' };
  }
  try {
    const payload: Record<string, unknown> = {
      to:    opts.token,
      title: opts.title,
      body:  opts.body,
      data:  opts.data ?? {},
    };
    if (opts.sound !== null) payload.sound = opts.sound ?? 'default';
    // iOS: this is the magic line that surfaces wrist action buttons.
    if (opts.categoryId) payload._category = opts.categoryId;   // Expo accepts `_category`
    if (opts.categoryId) payload.categoryId = opts.categoryId;  // future-compat

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok || json?.data?.status === 'error') {
      const errMsg = json?.data?.message ?? JSON.stringify(json);
      // Expo flags a stale/uninstalled token with this error code — the caller
      // prunes it so we stop sending to dead devices.
      const dnr = json?.data?.details?.error === 'DeviceNotRegistered';
      console.error('[send-push] Expo API error:', errMsg);
      return { ok: false, error: errMsg, deviceNotRegistered: dnr };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[send-push] fetch failed:', msg);
    return { ok: false, error: msg };
  }
}

async function logAttempt(
  supabase: SupabaseClient,
  input: SendUserPushInput,
  status: LogStatus,
  error?: string,
): Promise<void> {
  try {
    await supabase.from('notification_log').insert({
      user_id:  input.userId,
      category: input.categoryId,
      title:    input.title,
      body:     input.body,
      data:     input.data ?? null,
      status,
      error:    error ?? null,
    });
  } catch (e) {
    console.error('[send-push] log insert failed:', e);
  }
}

/**
 * Helper for senders that want to create a service-role client without
 * repeating the boilerplate.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}
