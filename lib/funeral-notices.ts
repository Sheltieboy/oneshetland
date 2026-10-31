/**
 * funeral-notices.ts — pure view-models and form logic for Deaths & Funeral Notices (no imports; runs in the app and under `node --test`).
 *
 * PUBLIC: get_funeral_notices / get_funeral_notice return only public fields; arrangement fields are null unless the family approved
 * publishing them. mapFuneralRow copies an explicit allow-list, so a private column that ever appeared on a row (contact details, verification)
 * could not reach a screen. SUBMISSION: everything is optional except what the contract requires; arrangements are only sent behind the explicit
 * "publish the funeral arrangements" choice; notification consent defaults to OFF.
 */

import { httpsUrl } from './notices-alerts';

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** A `date` column arrives as 'YYYY-MM-DD'; read it as a calendar date (no time-zone shift). */
export function formatCalendarDate(v: string | null | undefined): string | null {
  const m = typeof v === 'string' ? v.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : longDate(d);
}

export function formatServiceWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  return `${longDate(d)} at ${hh}:${mm}`;
}

export const SERVICE_KIND_LABEL: Record<string, string> = {
  funeral: 'Funeral service', burial: 'Burial', cremation: 'Cremation', memorial: 'Memorial service', private: 'Private service',
};

export type FuneralNoticeModel = {
  id: string;
  fullName: string;
  /** "Known as", only when it differs from the full name. */
  knownAs: string | null;
  photoUrl: string | null;
  /** "12 March 1941 – 3 October 2026", "Died 3 October 2026", or null. */
  dates: string | null;
  announcement: string | null;
  /** null when the family did not approve publishing arrangements: nothing about a service is shown. */
  service: { kind: string | null; venue: string | null; when: string | null; notes: string | null } | null;
  familyRequests: string | null;
  donationInfo: string | null;
  donationUrl: string | null;
  areaName: string | null;
  publishedAt: string | null;
};

export function mapFuneralRow(row: Record<string, any>): FuneralNoticeModel {
  const full = clean(row.full_name) ?? 'Name withheld';
  const pref = clean(row.preferred_name);
  const born = formatCalendarDate(row.born_on), died = formatCalendarDate(row.died_on);
  const kindKey = clean(row.service_kind);
  const svc = {
    kind: kindKey ? (SERVICE_KIND_LABEL[kindKey] ?? null) : null,
    venue: clean(row.service_venue),
    when: formatServiceWhen(row.service_at),
    notes: clean(row.service_notes),
  };
  const hasService = !!(svc.kind || svc.venue || svc.when || svc.notes);
  return {
    id: String(row.id),
    fullName: full,
    knownAs: pref && pref.toLowerCase() !== full.toLowerCase() ? pref : null,
    photoUrl: httpsUrl(row.photo_url),
    dates: born && died ? `${born} – ${died}` : died ? `Died ${died}` : born ? `Born ${born}` : null,
    announcement: clean(row.announcement),
    service: hasService ? svc : null,
    familyRequests: clean(row.family_requests),
    donationInfo: clean(row.donation_info),
    donationUrl: httpsUrl(row.donation_url),
    areaName: clean(row.area_name),
    publishedAt: clean(row.published_at),
  };
}

export function mapFuneralRows(rows: unknown): FuneralNoticeModel[] {
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object' && r.id).map(mapFuneralRow) : [];
}

// ── Submission ───────────────────────────────────────────────────────────────

export type SubmissionForm = {
  fullName: string; preferredName: string; photoUrl: string;
  bornOn: string; diedOn: string;                       // DD/MM/YYYY as typed
  announcement: string;
  areaId: string | null;
  publishArrangements: boolean;                          // the explicit choice; nothing below is sent unless true
  serviceKind: string | null; serviceVenue: string; serviceDate: string; serviceTime: string; serviceNotes: string;
  familyRequests: string; donationInfo: string; donationUrl: string;
  submitterName: string; submitterRelationship: string; submitterPhone: string; submitterEmail: string;
  familyAuthorised: boolean;
  announceInNotifications: boolean; announceNameInPreview: boolean;   // consent: default OFF
};

export const EMPTY_SUBMISSION: SubmissionForm = {
  fullName: '', preferredName: '', photoUrl: '', bornOn: '', diedOn: '', announcement: '', areaId: null,
  publishArrangements: false, serviceKind: null, serviceVenue: '', serviceDate: '', serviceTime: '', serviceNotes: '',
  familyRequests: '', donationInfo: '', donationUrl: '',
  submitterName: '', submitterRelationship: '', submitterPhone: '', submitterEmail: '',
  familyAuthorised: false, announceInNotifications: false, announceNameInPreview: false,
};

/** 'DD/MM/YYYY' (or D/M/YYYY) -> 'YYYY-MM-DD' for a real calendar date, else null. */
export function parseUkDate(v: string): string | null {
  const m = v.trim().match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Service date + 'HH:MM' -> an instant (interpreted in the device's time zone, which is Shetland's for Shetland users). */
export function parseServiceInstant(date: string, time: string): string | null {
  const iso = parseUkDate(date);
  if (!iso) return null;
  const t = time.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (time.trim() && !t) return null;
  const h = t ? Number(t[1]) : 12, mi = t ? Number(t[2]) : 0;
  if (h > 23 || mi > 59) return null;
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Plain-language problems, in form order. Empty = ready to send. Mirrors the server's required fields; the server still decides. */
export function validateSubmission(f: SubmissionForm, today: Date = new Date()): string[] {
  const e: string[] = [];
  if (!f.fullName.trim()) e.push('Please enter the full name of the person who has died.');
  if (!f.submitterName.trim()) e.push('Please enter your name.');
  if (!f.submitterPhone.trim() && !f.submitterEmail.trim()) e.push('Please give a phone number or an email address so we can check the notice with you. It is never shown publicly.');
  if (f.submitterEmail.trim() && !EMAIL.test(f.submitterEmail.trim())) e.push('That email address does not look right.');
  if (!f.familyAuthorised) e.push('Please confirm that you are authorised to make this announcement.');
  const born = f.bornOn.trim() ? parseUkDate(f.bornOn) : null, died = f.diedOn.trim() ? parseUkDate(f.diedOn) : null;
  if (f.bornOn.trim() && !born) e.push('Date of birth: please use DD/MM/YYYY.');
  if (f.diedOn.trim() && !died) e.push('Date of death: please use DD/MM/YYYY.');
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (died && died > todayIso) e.push('The date of death cannot be in the future.');
  if (born && died && born > died) e.push('The date of birth is after the date of death.');
  if (f.announcement.length > 1500) e.push('The announcement is too long (1,500 characters at most).');
  if (/https?:\/\/|www\./i.test(f.announcement)) e.push('Please leave web links out of the announcement.');
  if (f.photoUrl.trim() && !httpsUrl(f.photoUrl)) e.push('The photograph link must start with https://');
  if (f.donationUrl.trim() && !httpsUrl(f.donationUrl)) e.push('The donation link must start with https://');
  if (f.publishArrangements) {
    if (f.serviceDate.trim() && !parseUkDate(f.serviceDate)) e.push('Service date: please use DD/MM/YYYY.');
    if (f.serviceDate.trim() && !parseServiceInstant(f.serviceDate, f.serviceTime)) e.push('Service time: please use HH:MM, for example 14:00.');
  }
  return e;
}

/**
 * The jsonb sent to submit_funeral_notice. Blank optional fields are left out. Arrangements (service_*) are sent, and service_public set true,
 * ONLY when `publishArrangements` is on; otherwise service_public is false and no service field is sent. announce_name_in_preview can only be
 * true when announce_in_notifications is true.
 */
export function buildSubmissionPayload(f: SubmissionForm): Record<string, unknown> {
  const p: Record<string, unknown> = {
    full_name: f.fullName.trim(),
    submitter_name: f.submitterName.trim(),
    submitter_role: 'family',
    family_authorised: f.familyAuthorised === true,
    service_public: f.publishArrangements === true,
    announce_in_notifications: f.announceInNotifications === true,
    announce_name_in_preview: f.announceInNotifications === true && f.announceNameInPreview === true,
  };
  const put = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== '') p[k] = v; };
  put('preferred_name', f.preferredName.trim());
  put('photo_url', httpsUrl(f.photoUrl));
  put('born_on', f.bornOn.trim() ? parseUkDate(f.bornOn) : null);
  put('died_on', f.diedOn.trim() ? parseUkDate(f.diedOn) : null);
  put('announcement', f.announcement.trim());
  put('area_id', f.areaId);
  put('family_requests', f.familyRequests.trim());
  put('donation_info', f.donationInfo.trim());
  put('donation_url', httpsUrl(f.donationUrl));
  put('submitter_relationship', f.submitterRelationship.trim());
  put('submitter_phone', f.submitterPhone.trim());
  put('submitter_email', f.submitterEmail.trim());
  if (f.publishArrangements) {
    put('service_kind', f.serviceKind);
    put('service_venue', f.serviceVenue.trim());
    put('service_at', f.serviceDate.trim() ? parseServiceInstant(f.serviceDate, f.serviceTime) : null);
    put('service_notes', f.serviceNotes.trim());
  }
  return p;
}

/** ISO date ('YYYY-MM-DD…') -> 'DD/MM/YYYY' for the form. */
function toUkDate(v: unknown): string {
  const m = typeof v === 'string' ? v.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** my_funeral_submission(p_id) -> the edit form. Missing fields become empty; consent flags only ever read as true when the row says true. */
export function formFromSubmissionRow(row: Record<string, any>): SubmissionForm {
  const at = typeof row.service_at === 'string' ? new Date(row.service_at) : null;
  const okAt = at && !Number.isNaN(at.getTime()) ? at : null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    ...EMPTY_SUBMISSION,
    fullName: str(row.full_name), preferredName: str(row.preferred_name), photoUrl: str(row.photo_url),
    bornOn: toUkDate(row.born_on), diedOn: toUkDate(row.died_on), announcement: str(row.announcement), areaId: clean(row.area_id),
    publishArrangements: row.service_public === true,
    serviceKind: clean(row.service_kind), serviceVenue: str(row.service_venue),
    serviceDate: okAt ? `${String(okAt.getDate()).padStart(2, '0')}/${String(okAt.getMonth() + 1).padStart(2, '0')}/${okAt.getFullYear()}` : '',
    serviceTime: okAt ? `${String(okAt.getHours()).padStart(2, '0')}:${String(okAt.getMinutes()).padStart(2, '0')}` : '',
    serviceNotes: str(row.service_notes), familyRequests: str(row.family_requests), donationInfo: str(row.donation_info), donationUrl: str(row.donation_url),
    submitterName: str(row.submitter_name), submitterRelationship: str(row.submitter_relationship), submitterPhone: str(row.submitter_phone), submitterEmail: str(row.submitter_email),
    familyAuthorised: true,
    announceInNotifications: row.announce_in_notifications === true, announceNameInPreview: row.announce_in_notifications === true && row.announce_name_in_preview === true,
  };
}

/**
 * The jsonb for update_my_funeral_submission. Unlike a new submission, a blank field is sent as '' so the person can CLEAR it (an omitted key
 * means "leave as it is"). Arrangements: when the choice is on they are sent (including blanks); when it is off only service_public=false is
 * sent and the stored service fields are left untouched. The server ignores submitter, area and authorisation fields on an edit, so they are not sent.
 */
export function buildUpdatePayload(f: SubmissionForm): Record<string, unknown> {
  const p: Record<string, unknown> = {
    full_name: f.fullName.trim(), preferred_name: f.preferredName.trim(), photo_url: httpsUrl(f.photoUrl) ?? '',
    born_on: f.bornOn.trim() ? (parseUkDate(f.bornOn) ?? '') : '', died_on: f.diedOn.trim() ? (parseUkDate(f.diedOn) ?? '') : '',
    announcement: f.announcement.trim(), family_requests: f.familyRequests.trim(), donation_info: f.donationInfo.trim(), donation_url: httpsUrl(f.donationUrl) ?? '',
    service_public: f.publishArrangements === true,
    announce_in_notifications: f.announceInNotifications === true,
    announce_name_in_preview: f.announceInNotifications === true && f.announceNameInPreview === true,
  };
  if (f.publishArrangements) {
    p.service_kind = f.serviceKind ?? '';
    p.service_venue = f.serviceVenue.trim();
    p.service_at = f.serviceDate.trim() ? (parseServiceInstant(f.serviceDate, f.serviceTime) ?? '') : '';
    p.service_notes = f.serviceNotes.trim();
  }
  return p;
}

// ── My submissions ───────────────────────────────────────────────────────────

export type SubmissionStatus = 'submitted' | 'in_review' | 'needs_info' | 'approved' | 'rejected' | 'withdrawn' | 'taken_down';

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: 'Received - waiting to be checked',
  in_review: 'Being checked',
  needs_info: 'We need a little more information',
  approved: 'Published',
  rejected: 'Not published',
  withdrawn: 'Withdrawn',
  taken_down: 'Taken down',
};

export type SubmissionModel = {
  id: string; status: SubmissionStatus; statusLabel: string; fullName: string;
  createdAt: string | null; publishedAt: string | null;
  /** The staff message (the server releases it only while information is needed). */
  staffMessage: string | null;
  canWithdraw: boolean;
  /** Only while waiting or when more information is needed (update_my_funeral_submission). */
  canEdit: boolean;
  /** A published notice is changed by staff on request. */
  canRequestChange: boolean;
};

export function mapSubmissionRow(row: Record<string, any>): SubmissionModel {
  const status = (row.status in SUBMISSION_STATUS_LABEL ? row.status : 'submitted') as SubmissionStatus;
  return {
    id: String(row.id), status, statusLabel: SUBMISSION_STATUS_LABEL[status], fullName: clean(row.full_name) ?? 'Notice',
    createdAt: clean(row.created_at), publishedAt: clean(row.published_at), staffMessage: clean(row.review_message),
    canEdit: status === 'submitted' || status === 'needs_info',
    canWithdraw: status === 'submitted' || status === 'in_review' || status === 'needs_info' || status === 'approved',
    canRequestChange: status === 'approved',
  };
}

export function mapSubmissionRows(rows: unknown): SubmissionModel[] {
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object' && r.id).map(mapSubmissionRow) : [];
}

export type ChangeKind = 'correction' | 'takedown';
/** Arguments for request_funeral_notice_change; a message is needed so staff know what to change. */
export function buildChangeRequest(id: string, kind: ChangeKind, message: string, contact: string): { args: Record<string, unknown> } | { error: string } {
  const m = message.trim();
  if (m.length < 5) return { error: kind === 'correction' ? 'Please say what needs to be corrected.' : 'Please tell us why the notice should be taken down.' };
  return { args: { p_id: id, p_kind: kind, p_message: m, p_contact: clean(contact) } };
}
