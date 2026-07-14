/**
 * lib/wallet-hub.ts
 *
 * Aggregates the "Work" and "Fetch" section data the My Wallet hub renders.
 * Each side (worker / employer / customer / driver) is fetched independently
 * so any failure only blanks that one role's row, not the whole section.
 *
 * Mirrors the resilience pattern in lib/home-data.ts.
 */

import { supabase } from './supabase';
import { fetchMyApplications, fetchEmployerShifts } from './shifts-api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkerSide {
  /** Count of the worker's open applications. */
  appCount:        number;
  /** Top app (most actionable) — accepted first, else most recent pending. */
  topAppTitle:     string | null;
  topAppStatus:    string | null;
  hasWorkerProfile: boolean;
}

export interface EmployerSide {
  /** Count of shifts the user has posted that are still active. */
  activeShifts:    number;
  /** Top shift title. */
  topShiftTitle:   string | null;
  topShiftApplicants: number;
}

export interface WorkSummary {
  worker:   WorkerSide;
  employer: EmployerSide;
  /** Quick "should we render the section at all?" check. */
  hasAny:   boolean;
}

export interface CustomerFetchSide {
  /** Active / in-flight delivery requests (pending, matched, collected). */
  activeCount:     number;
  /** Recent count over the last 30 days (including completed). */
  recentCount:     number;
  topRequestStatus: string | null;
  topRequestRoute: string | null;   // e.g. "Spar → Lerwick"
}

export interface DriverFetchSide {
  isDriver:        boolean;
  /** Upcoming runs (departure_end >= now). */
  activeRuns:      number;
}

export interface FetchSummary {
  customer: CustomerFetchSide;
  driver:   DriverFetchSide;
  hasAny:   boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getWorkerSide(userId: string): Promise<WorkerSide> {
  try {
    const apps  = await fetchMyApplications(userId);
    const open  = apps.filter((a: any) => a.status === 'accepted' || a.status === 'pending');
    const top   = open.find((a: any) => a.status === 'accepted') ?? open[0] ?? null;

    let hasWorkerProfile = false;
    try {
      const { count } = await supabase
        .from('worker_profiles')
        .select('user_id', { head: true, count: 'exact' })
        .eq('user_id', userId);
      hasWorkerProfile = (count ?? 0) > 0;
    } catch { /* leave false */ }

    return {
      appCount:        open.length,
      topAppTitle:     top?.title ?? null,
      topAppStatus:    top?.status ?? null,
      hasWorkerProfile,
    };
  } catch {
    return { appCount: 0, topAppTitle: null, topAppStatus: null, hasWorkerProfile: false };
  }
}

async function getEmployerSide(userId: string): Promise<EmployerSide> {
  try {
    const shifts = await fetchEmployerShifts(userId);
    const active = shifts.filter((s: any) => s.is_active !== false);
    const top    = active[0];

    let topShiftApplicants = 0;
    if (top?.id) {
      try {
        const { count } = await supabase
          .from('shift_applications')
          .select('id', { count: 'exact', head: true })
          .eq('shift_id', top.id)
          .in('status', ['pending', 'accepted']);
        topShiftApplicants = count ?? 0;
      } catch { /* leave 0 */ }
    }

    return {
      activeShifts:        active.length,
      topShiftTitle:       top?.title ?? null,
      topShiftApplicants,
    };
  } catch {
    return { activeShifts: 0, topShiftTitle: null, topShiftApplicants: 0 };
  }
}

async function getCustomerFetchSide(userId: string): Promise<CustomerFetchSide> {
  try {
    const { data: active } = await supabase
      .from('delivery_requests')
      .select('id, status, pickup_name, destination_area')
      .eq('customer_id', userId)
      .in('status', ['pending', 'matched', 'collected'])
      .order('created_at', { ascending: false });

    const top = active?.[0];

    // Cheap recent count over the last 30 days
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let recentCount = 0;
    try {
      const { count } = await supabase
        .from('delivery_requests')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', userId)
        .gte('created_at', since);
      recentCount = count ?? 0;
    } catch { /* leave 0 */ }

    return {
      activeCount:      active?.length ?? 0,
      recentCount,
      topRequestStatus: top?.status ?? null,
      topRequestRoute:
        top
          ? `${top.pickup_name ?? 'Pickup'} → ${top.destination_area ?? 'Destination'}`
          : null,
    };
  } catch {
    return { activeCount: 0, recentCount: 0, topRequestStatus: null, topRequestRoute: null };
  }
}

async function getDriverFetchSide(userId: string): Promise<DriverFetchSide> {
  try {
    // Cheap probe — does this user have a driver_profile row?
    const { data: dp } = await supabase
      .from('driver_profiles')
      .select('id, driver_status')
      .eq('id', userId)
      .maybeSingle();

    const isDriver = !!dp && dp.driver_status === 'approved';
    if (!isDriver) return { isDriver: false, activeRuns: 0 };

    let activeRuns = 0;
    try {
      const { count } = await supabase
        .from('runs')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', userId)
        .gte('departure_end', new Date().toISOString());
      activeRuns = count ?? 0;
    } catch { /* leave 0 */ }

    return { isDriver, activeRuns };
  } catch {
    return { isDriver: false, activeRuns: 0 };
  }
}

// ── Public aggregators ───────────────────────────────────────────────────────

export async function fetchWorkSummary(userId: string): Promise<WorkSummary> {
  const [worker, employer] = await Promise.all([
    getWorkerSide(userId),
    getEmployerSide(userId),
  ]);
  return {
    worker,
    employer,
    hasAny:
      worker.appCount > 0 ||
      worker.hasWorkerProfile ||
      employer.activeShifts > 0,
  };
}

export async function fetchFetchSummary(userId: string): Promise<FetchSummary> {
  const [customer, driver] = await Promise.all([
    getCustomerFetchSide(userId),
    getDriverFetchSide(userId),
  ]);
  return {
    customer,
    driver,
    hasAny:
      customer.activeCount > 0 ||
      customer.recentCount > 0 ||
      driver.isDriver,
  };
}
