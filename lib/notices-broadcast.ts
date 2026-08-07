/**
 * The island-wide urgent notice channel (admin only).
 *
 * Everything that matters — who may send, what qualifies, and the once-only
 * guarantee — is enforced server-side in the notify-community-notice edge
 * function. This is just the call.
 */

import { supabase } from './supabase';

export type BroadcastResult = { ok: true; recipients: number; sent: number };

/**
 * Which of these notices have already gone island-wide. Admin-only UI state,
 * kept out of the main notices query so an un-migrated database can't empty
 * the feed. Returns {} if the column isn't there yet — losing the "already
 * sent" label is cosmetic, since the edge function is what enforces once-only.
 */
export async function fetchNoticeBroadcastState(ids: string[]): Promise<Record<string, string | null>> {
  if (!ids.length) return {};
  try {
    const { data, error } = await supabase.from('notices').select('id, broadcast_at').in('id', ids);
    if (error) return {};
    return Object.fromEntries(
      (data ?? []).map((r: { id: string; broadcast_at: string | null }) => [r.id, r.broadcast_at]),
    );
  } catch { return {}; }
}

export async function broadcastNotice(noticeId: string): Promise<BroadcastResult> {
  const { data, error } = await supabase.functions.invoke('notify-community-notice', {
    body: { notice_id: noticeId },
  });
  if (error) {
    // Edge-function errors arrive as an opaque FunctionsHttpError; the useful
    // message is in the response body.
    let message = 'Could not send that notice.';
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.error) message = body.error as string;
    } catch { /* keep the generic message */ }
    throw new Error(message);
  }
  return data as BroadcastResult;
}
