/**
 * notifications-inbox.ts
 *
 * Read side of notification_log — the in-app notification inbox. Every push the
 * backend sends is logged here (via sendUserPush), so the inbox shows the
 * user's notification history even if they missed or dismissed the push.
 *
 * RLS: users can only read their own log rows ("Users see their own
 * notification log"). Mark-read + unread-count go through SECURITY DEFINER RPCs.
 */
import { supabase } from './supabase';

export interface InboxNotification {
  id:         string;
  category:   string;          // e.g. 'fetch.delivered'
  title:      string;
  body:       string;
  data:       Record<string, unknown> | null;
  status:     string;
  created_at: string;
  read_at:    string | null;
}

// Statuses a user could meaningfully see in their inbox. Opt-outs (skipped_pref)
// and hard errors are not surfaced — the inbox is "things that happened for you".
const VISIBLE_STATUSES = ['sent', 'no_token', 'skipped_quiet'];

export async function fetchInbox(limit = 50): Promise<InboxNotification[]> {
  const { data, error } = await supabase
    .from('notification_log')
    .select('id, category, title, body, data, status, created_at, read_at')
    .in('status', VISIBLE_STATUSES)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as InboxNotification[];
}

export async function fetchUnreadCount(): Promise<number> {
  const { data, error } = await supabase.rpc('unread_notification_count');
  if (error) { console.warn('[inbox] unread count failed', error); return 0; }
  return (data as number | null) ?? 0;
}

/** Mark specific notifications read, or all of the user's unread ones when ids omitted. */
export async function markNotificationsRead(ids?: string[]): Promise<void> {
  const { error } = await supabase.rpc('mark_notifications_read', {
    p_ids: ids && ids.length ? ids : null,
  });
  if (error) throw error;
}
