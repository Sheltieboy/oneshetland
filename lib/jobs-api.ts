/**
 * lib/jobs-api.ts
 *
 * The Jobs board — traditional roles (permanent / part-time / seasonal /
 * apprenticeship) that sit alongside the casual "Shifts" tier under one Work
 * hub. Backed by the `jobs` table (045, extended in 078) + job_applications,
 * worker_profiles (shared candidate profile), cv_documents and saved_jobs.
 *
 * v1: businesses-only posting; posting + applicant pipeline are free.
 */

import { supabase } from './supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContractType   = 'full-time' | 'part-time' | 'casual' | 'apprenticeship' | 'volunteer' | 'freelance';
export type RemoteMode      = 'on_site' | 'hybrid' | 'remote';
export type PayPeriod       = 'hour' | 'day' | 'week' | 'month' | 'year' | 'total';
export type JobStatus       = 'open' | 'closed' | 'filled';
export type ApplicationStatus =
  | 'applied' | 'viewed' | 'shortlisted' | 'interview' | 'offer' | 'hired' | 'declined' | 'withdrawn';

export const CONTRACT_LABELS: Record<ContractType, string> = {
  'full-time': 'Full-time', 'part-time': 'Part-time', casual: 'Casual',
  apprenticeship: 'Apprenticeship', volunteer: 'Volunteer', freelance: 'Freelance',
};
export const REMOTE_LABELS: Record<RemoteMode, string> = {
  on_site: 'On-site', hybrid: 'Hybrid', remote: 'Remote',
};
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  applied: 'Applied', viewed: 'Viewed', shortlisted: 'Shortlisted', interview: 'Interview',
  offer: 'Offer', hired: 'Hired', declined: 'Not selected', withdrawn: 'Withdrawn',
};
/** Employer pipeline columns (the active stages, in order). */
export const PIPELINE_STAGES: ApplicationStatus[] = ['applied', 'viewed', 'shortlisted', 'interview', 'offer', 'hired'];

/** Job categories — aligned with the Shifts vocabulary for unified filtering. */
export const JOB_CATEGORIES = [
  'Hospitality', 'Maritime', 'Aquaculture', 'Energy', 'Care', 'Health',
  'Retail', 'Trades', 'Construction', 'Tourism', 'Education', 'Public sector',
  'Office & admin', 'Transport', 'Crofting', 'Other',
] as const;

export interface Job {
  id:                  string;
  employer_id:         string;
  posted_as_business_id: string | null;
  title:               string;
  description:         string | null;
  category:            string | null;
  location:            string | null;
  locality:            string | null;
  lat:                 number | null;
  lng:                 number | null;
  contract_type:       ContractType;
  pay_text:            string | null;
  pay_min:             number | null;
  pay_max:             number | null;
  pay_period:          PayPeriod | null;
  pay_hidden:          boolean;
  remote_mode:         RemoteMode;
  relocation_support:  boolean;
  housing_available:   boolean;
  is_seasonal:         boolean;
  season_label:        string | null;
  apply_url:           string | null;
  apply_email:         string | null;
  is_featured:         boolean;
  is_hidden:           boolean;
  boosted_until:       string | null;
  status:              JobStatus;
  views_count:         number;
  application_count:   number;
  expires_at:          string | null;
  posted_at:           string;
  created_at:          string;
  updated_at:          string;
  business?:           { id: string; name: string; logo_url: string | null; brand_color: string | null; slug: string | null; is_verified: boolean } | null;
}

export interface WorkerProfile {
  user_id:             string;
  headline:            string | null;
  summary:             string | null;
  skills:              string[];
  qualifications:      string[];
  experience:          { title?: string; org?: string; from?: string; to?: string; detail?: string }[];
  desired_pay_text:    string | null;
  willing_to_relocate: boolean;
  available_from:      string | null;
  is_diaspora:         boolean;
  is_public:           boolean;
  // Shift-side fields — the unified profile is a superset used by Jobs + Shifts.
  experience_summary:  string | null;
  hourly_rate_min:     number | null;
  hourly_rate_max:     number | null;
  is_open_to_work:     boolean;
  open_to_categories:  string[];
  created_at:          string;
  updated_at:          string;
}

export interface CvDocument {
  id:              string;
  user_id:         string;
  kind:            'cv' | 'cover_letter';
  label:           string;
  body:            string | null;
  external_url:    string | null;
  is_primary:      boolean;
  generated_by_ai: boolean;
  created_at:      string;
  updated_at:      string;
}

export interface JobApplication {
  id:               string;
  job_id:           string;
  applicant_id:     string;
  status:           ApplicationStatus;
  cover_letter:     string | null;
  profile_snapshot: Record<string, any>;
  visibility:       'full' | 'snapshot';
  employer_note:    string | null;
  applied_at:       string;
  status_changed_at: string;
  created_at:       string;
  updated_at:       string;
  // joins
  job?:             Pick<Job, 'id' | 'title' | 'contract_type' | 'posted_as_business_id'> & { business?: Job['business'] } | null;
  applicant?:       { id: string; full_name: string | null; avatar_url: string | null } | null;
}

export interface ApplicationEvent {
  id:             string;
  application_id: string;
  from_status:    ApplicationStatus | null;
  to_status:      ApplicationStatus;
  actor_id:       string | null;
  note:           string | null;
  created_at:     string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  const whole = Math.round(n);
  return whole.toLocaleString('en-GB');
}

const PERIOD_SUFFIX: Record<PayPeriod, string> = {
  hour: '/hr', day: '/day', week: '/wk', month: '/mo', year: '/yr', total: '',
};

/** Human pay string from the structured fields, falling back to free-text. */
export function formatJobPay(j: Pick<Job, 'pay_min' | 'pay_max' | 'pay_period' | 'pay_hidden' | 'pay_text'>): string {
  if (j.pay_hidden) return j.pay_text?.trim() || 'Competitive';
  const per = j.pay_period ? PERIOD_SUFFIX[j.pay_period] : '';
  if (j.pay_min != null && j.pay_max != null) return `£${fmtMoney(j.pay_min)}–£${fmtMoney(j.pay_max)}${per}`;
  if (j.pay_min != null) return `From £${fmtMoney(j.pay_min)}${per}`;
  if (j.pay_max != null) return `Up to £${fmtMoney(j.pay_max)}${per}`;
  return j.pay_text?.trim() || 'Competitive';
}

export function payIsShown(j: Pick<Job, 'pay_min' | 'pay_max' | 'pay_hidden'>): boolean {
  return !j.pay_hidden && (j.pay_min != null || j.pay_max != null);
}

const JOB_SELECT =
  '*, business:local_businesses(id,name,logo_url,brand_color,slug,is_verified)';

// ── Jobs: browse / read ─────────────────────────────────────────────────────────

export interface JobFilter {
  category?:        string;
  contract_type?:   ContractType;
  remote_mode?:     RemoteMode;
  keyword?:         string;
  locality?:        string;
  relocationOnly?:  boolean;
  salaryShownOnly?: boolean;
  businessId?:      string;
  limit?:           number;
  offset?:          number;
}

export async function fetchJobs(opts: JobFilter = {}): Promise<Job[]> {
  let q = supabase
    .from('jobs')
    .select(JOB_SELECT)
    .eq('is_hidden', false)
    .eq('status', 'open')
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order('is_featured', { ascending: false })
    .order('posted_at',   { ascending: false });

  if (opts.category)      q = q.eq('category', opts.category);
  if (opts.contract_type) q = q.eq('contract_type', opts.contract_type);
  if (opts.remote_mode)   q = q.eq('remote_mode', opts.remote_mode);
  if (opts.locality)      q = q.eq('locality', opts.locality);
  if (opts.relocationOnly)  q = q.eq('relocation_support', true);
  if (opts.salaryShownOnly) q = q.eq('pay_hidden', false);
  if (opts.businessId)    q = q.eq('posted_as_business_id', opts.businessId);
  if (opts.keyword) {
    const k = opts.keyword.replace(/[%,]/g, '').trim();
    if (k) q = q.or(`title.ilike.%${k}%,description.ilike.%${k}%,category.ilike.%${k}%`);
  }
  if (opts.limit)  q = q.limit(opts.limit);
  if (opts.offset) q = q.range(opts.offset, opts.offset + (opts.limit ?? 20) - 1);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Job[];
}

export async function fetchJob(id: string): Promise<Job | null> {
  const { data, error } = await supabase.from('jobs').select(JOB_SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Job | null;
}

/** Every job a business has posted (any status) — for the employer manager. */
export async function fetchBusinessJobs(businessId: string): Promise<Job[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select(JOB_SELECT)
    .eq('posted_as_business_id', businessId)
    .order('posted_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Job[];
}

// ── Jobs: create / update ────────────────────────────────────────────────────────

export interface JobInput {
  posted_as_business_id?: string | null;
  title:                string;
  description?:         string | null;
  category?:            string | null;
  location?:            string | null;
  locality?:            string | null;
  lat?:                 number | null;
  lng?:                 number | null;
  contract_type?:       ContractType;
  pay_text?:            string | null;
  pay_min?:             number | null;
  pay_max?:             number | null;
  pay_period?:          PayPeriod | null;
  pay_hidden?:          boolean;
  remote_mode?:         RemoteMode;
  relocation_support?:  boolean;
  housing_available?:   boolean;
  is_seasonal?:         boolean;
  season_label?:        string | null;
  apply_url?:           string | null;
  apply_email?:         string | null;
  expires_at?:          string | null;
  is_hidden?:           boolean;
  status?:              JobStatus;
}

export async function createJob(employerId: string, input: JobInput): Promise<Job> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({ employer_id: employerId, ...input })
    .select(JOB_SELECT)
    .single();
  if (error) throw error;
  return data as Job;
}

export async function updateJob(id: string, patch: Partial<JobInput>): Promise<void> {
  const { error } = await supabase.from('jobs').update(patch).eq('id', id);
  if (error) throw error;
}

export async function setJobStatus(id: string, status: JobStatus): Promise<void> {
  const { error } = await supabase.from('jobs').update({ status }).eq('id', id);
  if (error) throw error;

  // Let still-pending applicants know the role has closed / been filled.
  if (status === 'closed' || status === 'filled') {
    supabase.functions
      .invoke('notify-job', { body: { event: 'job_closed', job_id: id } })
      .catch(() => {});
  }
}

// ── Worker (candidate) profile ──────────────────────────────────────────────────

export async function fetchWorkerProfile(userId: string): Promise<WorkerProfile | null> {
  const { data, error } = await supabase.from('worker_profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return (data ?? null) as WorkerProfile | null;
}

/** Returns the worker profile, lazily seeding a blank one from `profiles` if absent. */
export async function ensureWorkerProfile(userId: string): Promise<WorkerProfile> {
  const existing = await fetchWorkerProfile(userId);
  if (existing) return existing;
  const { data: prof } = await supabase.from('profiles').select('bio').eq('id', userId).maybeSingle();
  const { data, error } = await supabase
    .from('worker_profiles')
    .insert({ user_id: userId, summary: (prof as any)?.bio ?? null })
    .select('*')
    .single();
  if (error) throw error;
  return data as WorkerProfile;
}

export async function upsertWorkerProfile(userId: string, patch: Partial<WorkerProfile>): Promise<WorkerProfile> {
  const { data, error } = await supabase
    .from('worker_profiles')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as WorkerProfile;
}

// ── CV / cover-letter library ──────────────────────────────────────────────────

export async function fetchCvDocuments(userId: string): Promise<CvDocument[]> {
  const { data, error } = await supabase
    .from('cv_documents').select('*').eq('user_id', userId)
    .order('is_primary', { ascending: false }).order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CvDocument[];
}

export async function saveCvDocument(
  userId: string,
  doc: { id?: string; kind: 'cv' | 'cover_letter'; label: string; body?: string | null; external_url?: string | null; generated_by_ai?: boolean },
): Promise<CvDocument> {
  const row = {
    user_id: userId, kind: doc.kind, label: doc.label,
    body: doc.body ?? null, external_url: doc.external_url ?? null,
    generated_by_ai: doc.generated_by_ai ?? false,
  };
  const { data, error } = doc.id
    ? await supabase.from('cv_documents').update(row).eq('id', doc.id).select('*').single()
    : await supabase.from('cv_documents').insert(row).select('*').single();
  if (error) throw error;
  return data as CvDocument;
}

export async function deleteCvDocument(id: string): Promise<void> {
  const { error } = await supabase.from('cv_documents').delete().eq('id', id);
  if (error) throw error;
}

// ── Applications ────────────────────────────────────────────────────────────────

export async function hasApplied(jobId: string, userId: string): Promise<boolean> {
  // Exclude withdrawn — a withdrawn application should let the worker re-apply,
  // so the job shows "Apply" again (not "View application").
  const { count, error } = await supabase
    .from('job_applications')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId).eq('applicant_id', userId).neq('status', 'withdrawn');
  if (error) return false;
  return (count ?? 0) > 0;
}

export async function applyToJob(input: {
  jobId: string; userId: string; coverLetter?: string | null; snapshot?: Record<string, any>;
}): Promise<JobApplication> {
  const { data, error } = await supabase
    .from('job_applications')
    .insert({
      job_id:           input.jobId,
      applicant_id:     input.userId,
      cover_letter:     input.coverLetter ?? null,
      profile_snapshot: input.snapshot ?? {},
    })
    .select('*')
    .single();
  if (error) throw error;

  // Notify the employer of the new application (fire-and-forget).
  supabase.functions
    .invoke('notify-job', { body: { event: 'application', application_id: (data as JobApplication).id } })
    .catch(() => {});

  return data as JobApplication;
}

export async function withdrawApplication(id: string): Promise<void> {
  const { error } = await supabase.from('job_applications').update({ status: 'withdrawn' }).eq('id', id);
  if (error) throw error;

  // Notify the employer the candidate pulled out.
  supabase.functions
    .invoke('notify-job', { body: { event: 'withdrawn', application_id: id } })
    .catch(() => {});
}

/** The signed-in candidate's applications (with the role they applied for). */
export async function fetchMyApplications(userId: string): Promise<JobApplication[]> {
  const { data, error } = await supabase
    .from('job_applications')
    .select('*, job:jobs(id,title,contract_type,posted_as_business_id,business:local_businesses(id,name,logo_url,brand_color,slug,is_verified))')
    .eq('applicant_id', userId)
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as JobApplication[];
}

/** Applications to one job (employer view), newest first, with applicant identity. */
export async function fetchJobApplications(jobId: string): Promise<JobApplication[]> {
  const { data, error } = await supabase
    .from('job_applications')
    .select('*, applicant:profiles!job_applications_applicant_id_fkey(id,full_name,avatar_url)')
    .eq('job_id', jobId)
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as JobApplication[];
}

export async function updateApplicationStatus(id: string, status: ApplicationStatus, note?: string | null): Promise<void> {
  const patch: Record<string, any> = { status };
  if (note !== undefined) patch.employer_note = note;
  const { error } = await supabase.from('job_applications').update(patch).eq('id', id);
  if (error) throw error;

  // Notify the applicant of meaningful stage changes (notify-job filters out
  // the silent stages like 'viewed').
  supabase.functions
    .invoke('notify-job', { body: { event: 'status', application_id: id, status } })
    .catch(() => {});
}

export async function setApplicationNote(id: string, note: string): Promise<void> {
  const { error } = await supabase.from('job_applications').update({ employer_note: note }).eq('id', id);
  if (error) throw error;
}

export async function fetchApplicationEvents(applicationId: string): Promise<ApplicationEvent[]> {
  const { data, error } = await supabase
    .from('application_events').select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ApplicationEvent[];
}

// ── Saved jobs ────────────────────────────────────────────────────────────────

export async function fetchSavedJobIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('saved_jobs').select('job_id').eq('user_id', userId);
  if (error) return new Set();
  return new Set((data ?? []).map((r: any) => r.job_id as string));
}

/** Full Job rows the user has bookmarked, most-recently-saved first. */
export async function fetchSavedJobs(userId: string): Promise<Job[]> {
  const { data: saved, error } = await supabase
    .from('saved_jobs').select('job_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = (saved ?? []) as { job_id: string; created_at: string }[];
  if (!rows.length) return [];
  const ids = rows.map(r => r.job_id);
  // Hydrate the same way as fetchJobs so JobCard renders identically.
  const { data, error: jErr } = await supabase.from('jobs').select(JOB_SELECT).in('id', ids);
  if (jErr) throw jErr;
  const jobs = (data ?? []) as Job[];
  // Preserve saved-order (created_at desc) — the `.in()` query loses it.
  const rank = new Map(ids.map((id, i) => [id, i] as const));
  return jobs.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

// ── AI cover letter ──────────────────────────────────────────────────────────

/** Drafts a tailored cover letter from the user's worker profile + the job. */
export async function generateCoverLetter(jobId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('ai-cover-letter', { body: { job_id: jobId } });
  if (error) {
    let msg = error.message;
    try { const body = await (error as any).context?.json(); if (body?.error) msg = body.error; } catch { /* */ }
    throw new Error(msg);
  }
  return (data?.cover_letter as string) ?? '';
}

export async function toggleSavedJob(userId: string, jobId: string): Promise<boolean> {
  const { count } = await supabase
    .from('saved_jobs').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('job_id', jobId);
  if ((count ?? 0) > 0) {
    await supabase.from('saved_jobs').delete().eq('user_id', userId).eq('job_id', jobId);
    return false;
  }
  await supabase.from('saved_jobs').insert({ user_id: userId, job_id: jobId });
  return true;
}
