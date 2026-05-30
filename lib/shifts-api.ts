/**
 * shifts-api.ts
 * All Supabase calls for the OneShetland Shifts feature.
 */

import { supabase } from './supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Urgency          = 'asap' | 'today' | 'this_week' | 'planned';
export type PayType          = 'hourly' | 'fixed' | 'negotiable' | 'discuss' | 'volunteer';
export type ShiftStatus      = 'draft' | 'open' | 'filled' | 'cancelled' | 'completed';
export type ApplicationStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';
export type CheckInStatus    = 'checked_in' | 'checked_out' | 'employer_confirmed' | null;

export interface ShiftEmployer {
  business_name: string;
  logo_url:      string | null;
  is_verified:   boolean;
}

/**
 * Joined Local business — populated when the shift was posted as
 * a registered Local business (via posted_as_business_id FK).
 */
export interface ShiftLinkedBusiness {
  id:          string;
  name:        string;
  logo_url:    string | null;
  category:    string;
  address:     string | null;
  is_verified: boolean;
}

export interface Shift {
  id:               string;
  employer_id:      string;
  posted_as_business_id: string | null;
  title:            string;
  description:      string | null;
  category:         string;
  location_text:    string;
  start_at:         string;
  end_at:           string;
  pay_type:         PayType;
  pay_amount:       number | null;
  positions_total:  number;
  positions_filled: number;
  requirements:     string[];
  urgency:          Urgency;
  status:           ShiftStatus;
  boosted_until:    string | null;
  created_at:       string;
  // joined
  employer?:        ShiftEmployer | null;
  business?:        ShiftLinkedBusiness | null;
}

// ── Display helpers — single source of truth for "what business is this shift from?" ──

/**
 * Prefer the linked Local business when present, else fall back to the
 * user's old-school shift_employer_profile. Returns name + logo + verified.
 */
export function shiftDisplayBusiness(s: Shift): { name: string; logo_url: string | null; is_verified: boolean } {
  if (s.business) {
    return { name: s.business.name, logo_url: s.business.logo_url, is_verified: s.business.is_verified };
  }
  if (s.employer) {
    return { name: s.employer.business_name, logo_url: s.employer.logo_url, is_verified: s.employer.is_verified };
  }
  return { name: 'Employer', logo_url: null, is_verified: false };
}

export interface ShiftApplication {
  id:                    string;
  shift_id:              string;
  worker_id:             string;
  status:                ApplicationStatus;
  message:               string | null;
  check_in_status:       CheckInStatus;
  checked_in_at:         string | null;
  checked_out_at:        string | null;
  employer_confirmed_at: string | null;
  created_at:            string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Human-readable pay string e.g. "£13.50/hr" or "£120 fixed" */
export function formatPay(payType: PayType, payAmount: number | null): string {
  if (payType === 'volunteer')  return 'Voluntary';
  if (payType === 'negotiable') return 'Negotiable';
  if (payType === 'discuss')    return 'To discuss';
  if (!payAmount)               return 'Pay TBC';
  if (payType === 'hourly')     return `£${payAmount.toFixed(2)}/hr`;
  return `£${payAmount.toFixed(0)} fixed`;
}

/** Duration string from two ISO timestamps e.g. "6 hrs" */
export function formatDuration(startAt: string, endAt: string): string {
  const hrs = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 3_600_000;
  if (hrs < 1)   return `${Math.round(hrs * 60)} mins`;
  if (hrs === 1) return '1 hr';
  return Number.isInteger(hrs) ? `${hrs} hrs` : `${hrs.toFixed(1)} hrs`;
}

/** e.g. "Mon 26 May · 2:00pm" */
export function formatShiftDate(startAt: string): string {
  const d = new Date(startAt);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  }) + ' · ' + d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── Urgency colours ────────────────────────────────────────────────────────────

export const URGENCY_CONFIG: Record<Urgency, { label: string; color: string; bg: string }> = {
  asap:      { label: 'ASAP',      color: '#DC2626', bg: '#FEE2E2' },
  today:     { label: 'Today',     color: '#EA580C', bg: '#FFEDD5' },
  this_week: { label: 'This week', color: '#D97706', bg: '#FEF3C7' },
  planned:   { label: 'Planned',   color: '#6B7280', bg: '#F3F4F6' },
};

// ── Category labels ────────────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<string, string> = {
  hospitality: 'Hospitality',
  maritime:    'Maritime & Fishing',
  oil_gas:     'Oil & Gas',
  aquaculture: 'Aquaculture',
  crofting:    'Crofting',
  care:        'Care & Support',
  events:      'Events',
  retail:      'Retail & Admin',
  driving:     'Driving',
  trades:      'Trades',
  education:   'Education',
  tourism:     'Tourism',
};

// ── API calls ─────────────────────────────────────────────────────────────────

/** Fetch open shifts, most urgent first */
export async function fetchOpenShifts(category?: string): Promise<Shift[]> {
  let query = supabase
    .from('shifts')
    .select('*')
    .eq('status', 'open')
    .gte('end_at', new Date().toISOString())
    .order('start_at', { ascending: true })
    .limit(50);

  if (category) query = query.eq('category', category);

  const { data, error } = await query;
  if (error) throw error;

  // Sort: boosted first (boosted_until > now), then by urgency within each group
  const order: Urgency[] = ['asap', 'today', 'this_week', 'planned'];
  const now = new Date().toISOString();
  const all  = data as Shift[];
  const boosted = all.filter(s => s.boosted_until && s.boosted_until > now)
    .sort((a, b) => order.indexOf(a.urgency) - order.indexOf(b.urgency));
  const regular = all.filter(s => !s.boosted_until || s.boosted_until <= now)
    .sort((a, b) => order.indexOf(a.urgency) - order.indexOf(b.urgency));
  const shifts = [...boosted, ...regular];

  // Fetch employer profiles + linked Local businesses in parallel
  const employerIds = [...new Set(shifts.map(s => s.employer_id).filter(Boolean))];
  const businessIds = [...new Set(shifts.map(s => s.posted_as_business_id).filter(Boolean) as string[])];

  const [empRes, bizRes] = await Promise.all([
    employerIds.length > 0
      ? supabase
          .from('shift_employer_profiles')
          .select('id, business_name, logo_url, is_verified')
          .in('id', employerIds)
      : Promise.resolve({ data: [] as any[] }),
    businessIds.length > 0
      ? supabase
          .from('local_businesses')
          .select('id, name, logo_url, category, address, is_verified')
          .in('id', businessIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const empMap = Object.fromEntries((empRes.data ?? []).map((e: any) => [e.id, e]));
  const bizMap = Object.fromEntries((bizRes.data ?? []).map((b: any) => [b.id, b]));

  return shifts.map(s => ({
    ...s,
    employer: empMap[s.employer_id] ?? null,
    business: s.posted_as_business_id ? bizMap[s.posted_as_business_id] ?? null : null,
  }));
}

/**
 * Fetch the most-recently-boosted active shift, hydrated with its employer +
 * Local business profile. Used by the Home tab to surface a "Featured shift"
 * card whenever someone has paid to boost — gives boosters real value beyond
 * a higher position in the Shifts list.
 */
export async function fetchFeaturedBoostedShift(): Promise<Shift | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('status', 'open')
    .gte('end_at', now)
    .gt('boosted_until', now)
    .order('boosted_until', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[fetchFeaturedBoostedShift]', error.message);
    return null;
  }
  if (!data) return null;

  const shift = data as Shift;
  const [empRes, bizRes] = await Promise.all([
    shift.employer_id
      ? supabase
          .from('shift_employer_profiles')
          .select('business_name, logo_url, is_verified')
          .eq('id', shift.employer_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    shift.posted_as_business_id
      ? supabase
          .from('local_businesses')
          .select('id, name, logo_url, category, address, is_verified')
          .eq('id', shift.posted_as_business_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    ...shift,
    employer: (empRes.data as ShiftEmployer | null) ?? null,
    business: (bizRes.data as ShiftLinkedBusiness | null) ?? null,
  };
}

/** Fetch a single shift with employer profile */
export async function fetchShift(id: string): Promise<Shift> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;

  const shift = data as Shift;

  // Fetch employer + linked business in parallel
  const [empRes, bizRes] = await Promise.all([
    shift.employer_id
      ? supabase
          .from('shift_employer_profiles')
          .select('business_name, logo_url, is_verified')
          .eq('id', shift.employer_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    shift.posted_as_business_id
      ? supabase
          .from('local_businesses')
          .select('id, name, logo_url, category, address, is_verified')
          .eq('id', shift.posted_as_business_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  shift.employer = (empRes.data as any) ?? null;
  shift.business = (bizRes.data as any) ?? null;

  return shift;
}

/** Check if current user has already applied to a shift */
export async function fetchMyApplication(
  shiftId: string,
  workerId: string,
): Promise<ShiftApplication | null> {
  const { data } = await supabase
    .from('shift_applications')
    .select('*')
    .eq('shift_id', shiftId)
    .eq('worker_id', workerId)
    .maybeSingle();
  return data as ShiftApplication | null;
}

/** Submit interest in a shift */
export async function submitInterest(
  shiftId: string,
  workerId: string,
  message?: string,
): Promise<void> {
  const { data: app, error } = await supabase
    .from('shift_applications')
    .insert({ shift_id: shiftId, worker_id: workerId, message: message ?? null })
    .select('id')
    .single();
  if (error) throw error;

  // Fire-and-forget: notify the employer of the new application
  if (app?.id) {
    supabase.functions.invoke('notify-shift-application', {
      body: { application_id: app.id },
    }).catch(() => {});
  }
}

/** Fetch all applications made by the current user */
export async function fetchMyApplications(workerId: string) {
  const { data: apps, error } = await supabase
    .from('shift_applications')
    .select('*')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!apps || apps.length === 0) return [];

  const shiftIds = [...new Set(apps.map(a => a.shift_id))];
  const { data: shifts } = await supabase
    .from('shifts')
    .select('id, title, start_at, end_at, location_text, pay_type, pay_amount, status')
    .in('id', shiftIds);

  const shiftMap = Object.fromEntries((shifts ?? []).map(s => [s.id, s]));
  return apps.map(app => ({ ...app, shift: shiftMap[app.shift_id] ?? null }));
}

/** Withdraw an application — decrements positions_filled if the application was accepted */
export async function withdrawApplication(
  applicationId: string,
  shiftId?: string,
  wasAccepted?: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('shift_applications')
    .update({ status: 'withdrawn' })
    .eq('id', applicationId);
  if (error) throw error;

  if (wasAccepted && shiftId) {
    const { data: shift } = await supabase
      .from('shifts')
      .select('positions_filled, status')
      .eq('id', shiftId)
      .single();
    if (shift) {
      await supabase
        .from('shifts')
        .update({
          positions_filled: Math.max(0, shift.positions_filled - 1),
          // Re-open the shift if it was marked filled
          ...(shift.status === 'filled' ? { status: 'open' } : {}),
        })
        .eq('id', shiftId);
    }
  }
}

/** Fetch all applications for shifts posted by an employer */
export async function fetchEmployerApplications(employerId: string) {
  // 1. Get the employer's shift IDs
  const { data: shifts, error: shiftsError } = await supabase
    .from('shifts')
    .select('id, title, start_at')
    .eq('employer_id', employerId);
  if (shiftsError) throw shiftsError;
  if (!shifts || shifts.length === 0) return [];

  const shiftIds = shifts.map(s => s.id);
  const shiftMap = Object.fromEntries(shifts.map(s => [s.id, s]));

  // 2. Get pending applications for those shifts
  const { data: apps, error: appsError } = await supabase
    .from('shift_applications')
    .select('*')
    .in('shift_id', shiftIds)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (appsError) throw appsError;
  if (!apps || apps.length === 0) return [];

  // 3. Fetch worker profiles separately
  const workerIds = [...new Set(apps.map(a => a.worker_id).filter(Boolean))];

  const [{ data: profiles }, { data: workerProfiles }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, avatar_url, location_area, created_at')
      .in('id', workerIds),
    supabase
      .from('shift_worker_profiles')
      .select('user_id, bio, experience_summary, skills, hourly_rate_min, hourly_rate_max, qualifications')
      .in('user_id', workerIds),
  ]);

  const profileMap      = Object.fromEntries((profiles      ?? []).map(p => [p.id,       p]));
  const workerProfMap   = Object.fromEntries((workerProfiles ?? []).map(p => [p.user_id, p]));

  // 4. Combine
  return apps.map(app => ({
    ...app,
    shift:         shiftMap[app.shift_id]   ?? null,
    worker:        profileMap[app.worker_id] ?? null,
    workerProfile: workerProfMap[app.worker_id] ?? null,
  }));
}

/** Fetch all shifts posted by an employer, with pending + total application counts */
export async function fetchEmployerShifts(employerId: string) {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('employer_id', employerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const shiftIds = data.map((s: any) => s.id);
  const { data: apps } = await supabase
    .from('shift_applications')
    .select('shift_id, status, check_in_status')
    .in('shift_id', shiftIds)
    .neq('status', 'withdrawn');

  const counts: Record<string, { pending: number; total: number; checked_out: number }> = {};
  for (const app of apps ?? []) {
    if (!counts[app.shift_id]) counts[app.shift_id] = { pending: 0, total: 0, checked_out: 0 };
    counts[app.shift_id].total++;
    if (app.status === 'pending') counts[app.shift_id].pending++;
    if (app.check_in_status === 'checked_out') counts[app.shift_id].checked_out++;
  }

  return (data as Shift[]).map(s => ({
    ...s,
    pending_count:      counts[s.id]?.pending      ?? 0,
    total_apps:         counts[s.id]?.total         ?? 0,
    checked_out_count:  counts[s.id]?.checked_out   ?? 0,
  }));
}

/** Cancel a shift — sets status to 'cancelled' */
export async function cancelShift(shiftId: string): Promise<void> {
  const { error } = await supabase
    .from('shifts')
    .update({ status: 'cancelled' })
    .eq('id', shiftId);
  if (error) throw error;
}

/** Worker checks in to their shift */
export async function checkIn(applicationId: string): Promise<void> {
  const { error } = await supabase
    .from('shift_applications')
    .update({ check_in_status: 'checked_in', checked_in_at: new Date().toISOString() })
    .eq('id', applicationId);
  if (error) throw error;

  supabase.functions.invoke('notify-worker-checkin', {
    body: { application_id: applicationId, event: 'checked_in' },
  }).catch(() => {});
}

/** Worker marks their shift as finished */
export async function checkOut(applicationId: string): Promise<void> {
  const { error } = await supabase
    .from('shift_applications')
    .update({ check_in_status: 'checked_out', checked_out_at: new Date().toISOString() })
    .eq('id', applicationId);
  if (error) throw error;

  supabase.functions.invoke('notify-worker-checkin', {
    body: { application_id: applicationId, event: 'checked_out' },
  }).catch(() => {});
}

/** Employer marks a shift as fully complete — confirms all accepted workers and closes the shift */
export async function confirmShiftComplete(shiftId: string): Promise<void> {
  // 1. Update shift status to completed
  const { error: shiftErr } = await supabase
    .from('shifts')
    .update({ status: 'completed' })
    .eq('id', shiftId);
  if (shiftErr) throw shiftErr;

  // 2. Stamp employer_confirmed on all accepted applications
  const { error: appErr } = await supabase
    .from('shift_applications')
    .update({
      check_in_status:       'employer_confirmed',
      employer_confirmed_at: new Date().toISOString(),
    })
    .eq('shift_id', shiftId)
    .eq('status', 'accepted');
  if (appErr) throw appErr;

  // 3. Notify all workers fire-and-forget
  supabase.functions.invoke('notify-shift-complete', {
    body: { shift_id: shiftId },
  }).catch(() => {});
}

/** Accept or reject an application — increments positions_filled on accept and auto-fills shift */
export async function updateApplicationStatus(
  applicationId: string,
  status: 'accepted' | 'rejected',
  shiftId?: string,
): Promise<void> {
  const { error } = await supabase
    .from('shift_applications')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', applicationId);
  if (error) throw error;

  if (status === 'accepted' && shiftId) {
    const { data: shift } = await supabase
      .from('shifts')
      .select('positions_filled, positions_total')
      .eq('id', shiftId)
      .single();
    if (shift) {
      const newFilled = shift.positions_filled + 1;
      await supabase
        .from('shifts')
        .update({
          positions_filled: newFilled,
          // Auto-close shift when all positions are filled
          ...(newFilled >= shift.positions_total ? { status: 'filled' } : {}),
        })
        .eq('id', shiftId);
    }
  }

  // Fire-and-forget: notify the worker of the decision
  supabase.functions.invoke('notify-application-update', {
    body: { application_id: applicationId, status },
  }).catch(() => {});
}
