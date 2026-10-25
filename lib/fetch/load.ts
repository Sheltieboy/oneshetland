/**
 * lib/fetch/load.ts — what each Fetch v2 screen loads (the app's version of the website's lib/fetch/load.server.ts). Every read goes
 * through lib/fetch-api.ts with the member's own session, so the database decides what each person may see.
 */
import type { FetchResult } from '@/lib/fetch-api';
import { fetchApi } from '@/lib/fetch/transport';
import type { DriverJobData, RequesterJobData } from '@/components/fetch/v2/Jobs';
import type { HomeData } from '@/components/fetch/v2/Home';

export type Job = { viewer: 'requester'; data: RequesterJobData } | { viewer: 'driver'; data: DriverJobData };

/** One job for whichever party is asking; anyone else gets not_found (the database's own answer). */
export async function loadJob(id: string): Promise<FetchResult<Job>> {
  const detail = await fetchApi.detail(id);
  if (!detail.ok) return detail;
  if (detail.data.viewer !== 'requester' && detail.data.viewer !== 'driver') return { ok: false, code: 'not_found', message: "We couldn't find that Fetch." };
  const [timeline, messages, photos, issues] = await Promise.all([fetchApi.timeline(id), fetchApi.messages(id), fetchApi.photos(id), fetchApi.myIssues(id)]);
  const common = { now: Date.now(), detail: detail.data, timeline: timeline.ok ? timeline.data : [], messages: messages.ok ? messages.data : null,
    photos: photos.ok ? photos.data.photos : [], issues: issues.ok ? issues.data.issues : [] };
  if (detail.data.viewer === 'driver') {
    const [jobs, elig] = await Promise.all([fetchApi.myJobs(), fetchApi.eligibility()]);
    return { ok: true, data: { viewer: 'driver', data: { ...common, pay: jobs.ok ? jobs.data.find((j) => j.id === id)?.pay ?? null : null,
      driverProblem: elig.ok ? elig.data.driver_problem : null } } };
  }
  const hint = detail.data.request.status === 'pending' ? await fetchApi.headingThatWay(id) : null;
  return { ok: true, data: { viewer: 'requester', data: { ...common, hint: hint?.ok ? hint.data : null } } };
}

export async function loadHome(): Promise<FetchResult<HomeData>> {
  const [req, jobs, runs, v] = await Promise.all([fetchApi.myRequests(), fetchApi.myJobs(), fetchApi.myRuns(), fetchApi.verification()]);
  if (!req.ok) return req;
  return { ok: true, data: { requests: req.data, jobs: jobs.ok ? jobs.data : [], runs: runs.ok ? runs.data : [], driverStatus: v.ok ? v.data.driver_status : null } };
}
