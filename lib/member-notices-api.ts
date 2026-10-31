/** member-notices-api.ts - the member's own notices (RPC wrappers; every call is made as the signed-in member, so RLS and the server rules apply). */
import { supabase } from './supabase';
import { mapMyNoticeRow, buildSubmitArgs, buildEditArgs, type MyNotice, type NoticeForm } from './member-notices';

export async function loadMyNotices(): Promise<MyNotice[]> {
  const { data, error } = await supabase.rpc('my_person_notices');
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(mapMyNoticeRow);
}
export async function submitMyNotice(f: NoticeForm): Promise<string> {
  const { data, error } = await supabase.rpc('submit_person_notice', buildSubmitArgs(f));
  if (error) throw error;
  return String(data);
}
export async function editMyNotice(id: string, f: NoticeForm): Promise<void> {
  const { error } = await supabase.rpc('edit_my_person_notice', buildEditArgs(id, f));
  if (error) throw error;
}
export async function withdrawMyNotice(id: string): Promise<void> {
  const { error } = await supabase.rpc('withdraw_my_person_notice', { p_notice: id });
  if (error) throw error;
}
