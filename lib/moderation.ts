/**
 * moderation.ts — client helpers for the app-store-required UGC safety features:
 * reporting objectionable content, blocking abusive users, and account deletion.
 *
 * Tables: content_reports, blocked_users (migration 20260630120000).
 * Edge fn: delete-account.
 */
import { supabase } from './supabase';

export type ReportContentType =
  | 'memory'
  | 'memory_comment'
  | 'memory_pin'
  | 'vessel_comment'
  | 'notice'
  | 'profile'
  | 'job'
  | 'shift'
  | 'hub_campaign'
  | 'other';

export const REPORT_REASONS: { key: string; label: string }[] = [
  { key: 'spam', label: 'Spam or misleading' },
  { key: 'harassment', label: 'Harassment or bullying' },
  { key: 'hate', label: 'Hate speech or discrimination' },
  { key: 'sexual', label: 'Sexual or explicit content' },
  { key: 'violence', label: 'Violence or threats' },
  { key: 'self_harm', label: 'Self-harm' },
  { key: 'illegal', label: 'Illegal or dangerous' },
  { key: 'other', label: 'Something else' },
];

export interface ReportInput {
  contentType: ReportContentType;
  contentId: string;
  reportedUserId?: string | null; // the author, when known
  reason: string;
  details?: string | null;
}

/** File a report against a piece of content. Reporter = current user. */
export async function reportContent(input: ReportInput): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Please sign in to report content.');
  const { error } = await supabase.from('content_reports').insert({
    reporter_id: user.id,
    content_type: input.contentType,
    content_id: input.contentId,
    reported_user_id: input.reportedUserId ?? null,
    reason: input.reason,
    details: input.details?.trim() || null,
  });
  if (error) throw error;
}

/** Block a user. Their content is hidden from you across the app. */
export async function blockUser(blockedId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Please sign in to block a user.');
  if (user.id === blockedId) throw new Error("You can't block yourself.");
  const { error } = await supabase
    .from('blocked_users')
    .upsert({ blocker_id: user.id, blocked_id: blockedId }, { onConflict: 'blocker_id,blocked_id' });
  if (error) throw error;
}

export async function unblockUser(blockedId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase
    .from('blocked_users')
    .delete()
    .eq('blocker_id', user.id)
    .eq('blocked_id', blockedId);
  if (error) throw error;
}

/** The set of user ids the current user has blocked (for client-side filtering). */
export async function fetchBlockedIds(): Promise<string[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data } = await supabase.from('blocked_users').select('blocked_id').eq('blocker_id', user.id);
  return (data ?? []).map((r: { blocked_id: string }) => r.blocked_id);
}

export async function isUserBlocked(blockedId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('blocked_users')
    .select('blocked_id')
    .eq('blocker_id', user.id)
    .eq('blocked_id', blockedId)
    .maybeSingle();
  return !!data;
}

/**
 * Permanently delete the current user's account (Apple 5.1.1(v) / Google Play).
 * Server scrubs PII, deletes the user's UGC, deactivates owned businesses, and
 * soft-deletes the login. The caller MUST sign out + clear the local session
 * afterwards (the session is dead server-side).
 */
export async function deleteAccount(): Promise<void> {
  const { error } = await supabase.functions.invoke('delete-account', { body: {} });
  if (error) throw error;
}
