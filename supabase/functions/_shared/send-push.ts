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
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type NotificationModule =
  | 'bookings' | 'shifts' | 'fetch' | 'loyalty' | 'offers' | 'spik' | 'games';

export interface SendUserPushInput {
  userId:     string;                  // recipient (used for prefs + log)
  module:     NotificationModule;
  categoryId: string;                  // e.g. "bookings.new" — must be registered client-side
  title:      string;
  body:       string;
  data?:      Record<string, unknown>;
  urgent?:    boolean;                 // bypass quiet hours (default false)
  sound?:     'default' | null;        // default 'default'
}

/**
 * Preferences-aware push to one user.
 * Looks up the recipient's push_token, checks should_notify(), sends if allowed,
 * and logs the outcome.
 */
export async function sendUserPush(
  supabase: SupabaseClient,
  input: SendUserPushInput,
): Promise<{ status: LogStatus; error?: string }> {

  // 1. Check preferences + quiet hours via the DB function
  const { data: shouldSendData, error: shouldErr } = await supabase
    .rpc('should_notify', {
      p_user_id: input.userId,
      p_module:  input.module,
      p_urgent:  input.urgent ?? false,
    });

  if (shouldErr) {
    console.error('[send-push] should_notify rpc failed:', shouldErr);
    // Fail-open: deliver if the check itself errored — better to over-notify than miss critical ones
  } else if (shouldSendData === false) {
    await logAttempt(supabase, input, 'skipped_pref');
    return { status: 'skipped_pref' };
  }

  // 2. Look up push token
  const { data: profile } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', input.userId)
    .maybeSingle();

  const token = profile?.push_token as string | null | undefined;
  if (!token || !token.startsWith('ExponentPushToken[')) {
    await logAttempt(supabase, input, 'no_token');
    return { status: 'no_token' };
  }

  // 3. Send via Expo Push API
  const result = await sendPushRaw({
    token,
    title:      input.title,
    body:       input.body,
    data:       { ...(input.data ?? {}), categoryId: input.categoryId },
    categoryId: input.categoryId,
    sound:      input.sound === null ? null : 'default',
  });

  // 4. Log
  await logAttempt(supabase, input, result.ok ? 'sent' : 'error', result.error);

  return { status: result.ok ? 'sent' : 'error', error: result.error };
}

/**
 * Convenience: send the same notification to multiple users at once. Loops
 * sendUserPush — keeps preferences/quiet-hours checks honoured per recipient.
 */
export async function sendUserPushBulk(
  supabase: SupabaseClient,
  userIds: string[],
  payload: Omit<SendUserPushInput, 'userId'>,
): Promise<{ sent: number; skipped: number; errored: number }> {
  const results = await Promise.allSettled(
    userIds.map(uid => sendUserPush(supabase, { ...payload, userId: uid })),
  );
  let sent = 0, skipped = 0, errored = 0;
  for (const r of results) {
    if (r.status === 'rejected') { errored++; continue; }
    const s = r.value.status;
    if (s === 'sent')          sent++;
    else if (s === 'error')    errored++;
    else                       skipped++;
  }
  return { sent, skipped, errored };
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

// ── Internals ────────────────────────────────────────────────────────────────

type LogStatus = 'sent' | 'skipped_pref' | 'skipped_quiet' | 'no_token' | 'error';

async function sendPushRaw(opts: {
  token:       string | null | undefined;
  title:       string;
  body:        string;
  data?:       Record<string, unknown>;
  categoryId?: string;
  sound?:      'default' | null;
}): Promise<{ ok: boolean; error?: string }> {
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
      console.error('[send-push] Expo API error:', errMsg);
      return { ok: false, error: errMsg };
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
