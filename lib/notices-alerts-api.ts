/**
 * notices-alerts-api.ts — the app's reads and writes for Notices & Alerts. Every call is a database function from
 * docs/notices-alerts-contract.md; the database decides what is public, who published it and what is an active Essential Alert.
 * Reads never throw into Home: fetchEssentialAlerts / fetchHomeCards answer [] on failure so a failed request collapses its section.
 * The Notices screen uses the throwing variants so it can show a real error state.
 */
import { supabase } from './supabase';
import {
  mapRows, mapEssentialRow, mapNoticeRow, homeAreaArgs, buildQuery, HOME_CARD_MAX, composeHome, trimPage, PAGE_SIZE,
  type NoticeModel, type FilterState, type HomeComposition, type AreaParents,
} from './notices-alerts';
import { mapFuneralRows, mapFuneralRow, mapSubmissionRows, buildChangeRequest, buildSubmissionPayload, buildUpdatePayload, formFromSubmissionRow, type SubmissionForm, type ChangeKind, type FuneralNoticeModel, type SubmissionModel } from './funeral-notices';

export type AreaOption = { id: string; name: string; type: string; parentId: string | null };
export type CategoryOption = { id: string; label: string };

/** Fallback only when notice_categories cannot be read (the nine canonical ids, migration 20261128000000). */
export const FALLBACK_CATEGORIES: CategoryOption[] = [
  { id: 'travel_transport', label: 'Travel & transport' }, { id: 'health', label: 'Health' }, { id: 'public_services', label: 'Council & public services' },
  { id: 'schools_education', label: 'Schools & education' }, { id: 'community', label: 'Community' }, { id: 'consultations_funding', label: 'Consultations & funding' },
  { id: 'lost_found', label: 'Lost & found' }, { id: 'appeals_volunteering', label: 'Appeals & volunteering' }, { id: 'other', label: 'Other' },
];

// ── Public reads ─────────────────────────────────────────────────────────────

/** Active essential alerts, optionally for areas (null = unfiltered, [] = Shetland-wide only, list = those areas). Throws on error. */
export async function loadEssentialAlerts(areaIds: string[] | null): Promise<NoticeModel[]> {
  const { data, error } = await supabase.rpc('get_essential_alerts', { p_area_ids: areaIds });
  if (error) throw error;
  return mapRows(data, mapEssentialRow);
}

/** One page of the Notices list (or, for the funeral tab, the funeral list). */
export async function loadNoticePage(state: FilterState, myAreas: string[] | null, offset: number): Promise<{ notices: NoticeModel[]; funeral: FuneralNoticeModel[]; hasMore: boolean }> {
  // One row more than a page: its presence is the only "there is more" signal (no empty Show more after an exact multiple).
  const q = buildQuery(state, myAreas, offset, PAGE_SIZE + 1);
  const { data, error } = await supabase.rpc(q.fn, q.args);
  if (error) throw error;
  if (q.fn === 'get_funeral_notices') { const t = trimPage(mapFuneralRows(data), PAGE_SIZE); return { notices: [], funeral: t.rows, hasMore: t.hasMore }; }
  const t = trimPage(mapRows(data, mapNoticeRow), PAGE_SIZE);
  return { notices: t.rows, funeral: [], hasMore: t.hasMore };
}

/** One public notice by id (deep links, ?open=<id>). null when it is not public (resolved, scheduled, hidden, withdrawn or unknown). */
export async function loadPublicNotice(id: string): Promise<NoticeModel | null> {
  const { data, error } = await supabase.rpc('get_public_notice', { p_id: id });
  if (error) throw error;
  return mapRows(data, mapNoticeRow)[0] ?? null;
}

/** Home: the Essential slot and the card grid, each failing independently to "nothing". */
export async function loadHomeNotices(myAreas: string[] | null): Promise<HomeComposition> {
  const areas = homeAreaArgs(myAreas);
  const [essential, notices] = await Promise.all([
    loadEssentialAlerts(areas).catch(() => [] as NoticeModel[]),
    supabase.rpc('get_public_notices', { p_level: 'all', p_area_ids: areas, p_category: null, p_limit: 20, p_offset: 0 })
      .then(({ data, error }) => (error ? [] : mapRows(data, mapNoticeRow)), () => [] as NoticeModel[]),
  ]);
  // the area hierarchy lets the slot rank an alert for a parent / child of the member's area above an island-wide one (as the database matches them)
  const parents = myAreas && myAreas.length ? await loadAreas().then((a) => Object.fromEntries(a.map((x) => [x.id, x.parentId])) as AreaParents, () => null) : null;
  return composeHome(essential, notices, HOME_CARD_MAX, myAreas, parents);
}

export async function loadFuneralNotice(id: string): Promise<FuneralNoticeModel | null> {
  const { data, error } = await supabase.rpc('get_funeral_notice', { p_id: id });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row && row.id ? mapFuneralRow(row) : null;
}

export async function loadAreas(): Promise<AreaOption[]> {
  const { data, error } = await supabase.from('areas').select('id, name_display, type, parent_id, sort_order')
    .eq('is_active', true).eq('is_physical', true).order('sort_order', { ascending: true }).order('name_display', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((a: any) => ({ id: a.id, name: a.name_display, type: a.type, parentId: a.parent_id ?? null }));
}

export async function loadCategories(): Promise<CategoryOption[]> {
  try {
    const { data, error } = await supabase.from('notice_categories').select('id, label').eq('is_active', true).order('sort_order', { ascending: true });
    if (error || !data || data.length === 0) return FALLBACK_CATEGORIES;
    return data.map((c: any) => ({ id: c.id, label: c.label }));
  } catch { return FALLBACK_CATEGORIES; }
}

// ── Funeral: signed in ───────────────────────────────────────────────────────

export async function submitFuneralNotice(form: SubmissionForm): Promise<string> {
  const { data, error } = await supabase.rpc('submit_funeral_notice', { p: buildSubmissionPayload(form) });
  if (error) throw error;
  return String(data);
}

export async function loadMyFuneralSubmission(id: string): Promise<{ form: SubmissionForm; status: string; staffMessage: string | null } | null> {
  const { data, error } = await supabase.rpc('my_funeral_submission', { p_id: id });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row && row.id ? { form: formFromSubmissionRow(row), status: String(row.status), staffMessage: typeof row.review_message === 'string' && row.review_message.trim() ? row.review_message.trim() : null } : null;
}

export async function updateFuneralSubmission(id: string, form: SubmissionForm): Promise<void> {
  const { error } = await supabase.rpc('update_my_funeral_submission', { p_id: id, p: buildUpdatePayload(form) });
  if (error) throw error;
}

export async function loadMyFuneralSubmissions(): Promise<SubmissionModel[]> {
  const { data, error } = await supabase.rpc('my_funeral_submissions');
  if (error) throw error;
  return mapSubmissionRows(data);
}

export async function withdrawFuneralNotice(id: string): Promise<void> {
  const { error } = await supabase.rpc('withdraw_my_funeral_notice', { p_id: id });
  if (error) throw error;
}

export async function requestFuneralChange(id: string, kind: ChangeKind, message: string, contact: string): Promise<void> {
  const built = buildChangeRequest(id, kind, message, contact);
  if ('error' in built) throw new Error(built.error);
  const { error } = await supabase.rpc('request_funeral_notice_change', built.args);
  if (error) throw error;
}
