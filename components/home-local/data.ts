/**
 * data.ts — what the Home and Local screens read. Every call is an existing public read the app already makes, and each
 * source fails soft (an empty list), so one flaky request can never blank a screen. Nothing is invented: a source with
 * no rows yields an empty list, and the screen decides how to present "none" (a pillar's proposition panel, a collapsed
 * section, or the jobs-only version of Work).
 */
import { supabase } from '@/lib/supabase';
import {
  BUSINESS_PUBLIC_SOURCE, BUSINESS_PUBLIC_COLS, fetchActiveOffers, fetchActiveLocalPasses, formatOfferDiscount,
  type LocalBusiness,
} from '@/lib/local-api';
import { fetchFreshProducts } from '@/lib/products-api';
import { fetchActiveBookableServices } from '@/lib/book-api';
import { fetchTodaySnapshot, describeWeather, type TodaySnapshot } from '@/lib/shetland-today';
import { getCruiseHomeCard } from '@/lib/cruise-api';
import { fetchHomeEvents, fetchHomeNotices, fetchTodaysSpik, type HomeEvent, type HomeNotice } from '@/lib/concierge-api';
import { fetchFixtureIds, NO_FIXTURES, type FixtureIds } from '@/lib/discovery-fixtures';
import { fetchOpenShifts, shiftDisplayBusiness, formatPay } from '@/lib/shifts-api';
import { EXPERIENCE_ROUTE, type Merch, type Pillar } from './model';
import type { WorkJob, WorkShift } from './work';

const soft = async <T,>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };

export interface HomeLocalData {
  today: TodaySnapshot | null;
  weather: string | null;
  ships: { count: number } | null;
  events: HomeEvent[];
  businesses: LocalBusiness[];
  jobs: WorkJob[];
  shifts: WorkShift[];
  notices: HomeNotice[];
  spik: { word: string; meaning: string } | null;
  commerce: Record<Pillar, Merch[]>;
  /** Test fixtures (administrators only; empty for everyone else) so the screens can label them. */
  fixtures: FixtureIds;
}

const gbp = (p: number) => (p % 100 === 0 ? `£${p / 100}` : `£${(p / 100).toFixed(2)}`);
const COMMERCIAL = ['food_drink', 'retail', 'services', 'accommodation'];

/** Commercial listings only, one per trading name, dealt café → shop → service → stay so the mix is varied. */
export function curate(list: LocalBusiness[], limit = 9): LocalBusiness[] {
  const okay = list.filter((b) => COMMERCIAL.includes(b.category as string) && b.name?.trim());
  const seen = new Set<string>();
  const unique = okay.filter((b) => { const k = b.name.toLowerCase().replace(/[^a-z0-9]+/g, ''); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  const lanes = COMMERCIAL.map((c) => unique.filter((b) => b.category === c));
  const out: LocalBusiness[] = [];
  for (let i = 0; out.length < unique.length && out.length < limit; i++) for (const lane of lanes) if (lane[i] && out.length < limit) out.push(lane[i]);
  return out;
}

/** The businesses behind "Who's open for business" / "Featured locally", optionally within one area (matched on address,
 *  as the existing Local feed does). Best-presented first. */
export async function loadBusinesses(areaLabel?: string, limit = 9): Promise<LocalBusiness[]> {
  return soft((async () => {
    let q = supabase.from(BUSINESS_PUBLIC_SOURCE).select(BUSINESS_PUBLIC_COLS).eq('is_active', true).in('category', COMMERCIAL).not('logo_url', 'is', null);
    if (areaLabel) q = q.ilike('address', `%${areaLabel}%`);
    const { data } = await q.order('is_claimed', { ascending: false }).order('is_verified', { ascending: false }).order('created_at', { ascending: false }).limit(120);
    return curate((data ?? []) as LocalBusiness[], limit);
  })(), [] as LocalBusiness[]);
}

type Pass = Awaited<ReturnType<typeof fetchActiveLocalPasses>>[number];
/** Passes → the Experiences pillar's cards. A card opens the existing pass purchase flow for that pass. */
export function passesToMerch(passes: Pass[], fixtures: FixtureIds): Merch[] {
  return passes.map((p) => ({
    id: p.id, pillar: 'experiences' as const, title: p.name, business: p.business_name, price: gbp(p.price_pence), uri: p.image_url ?? undefined,
    meta: `${p.uses_per_purchase > 1 ? `${p.uses_per_purchase} uses` : '1 use'}${p.valid_days ? ` · valid ${p.valid_days} days` : ''}`,
    route: { pathname: EXPERIENCE_ROUTE, params: { itemId: p.id } }, test: fixtures.business.has(p.business_id),
  }));
}

async function loadJobs(): Promise<WorkJob[]> {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('jobs')
    .select('id, title, location, pay_text, contract_type, external_employer_name, biz:local_businesses!posted_as_business_id(name)')
    .eq('status', 'open').eq('is_hidden', false)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('is_featured', { ascending: false }).order('posted_at', { ascending: false }).limit(4);
  return ((data ?? []) as Record<string, unknown>[]).map((j) => {
    const biz = (Array.isArray(j.biz) ? (j.biz as { name?: string }[])[0] : j.biz) as { name?: string } | null;
    return {
      kind: 'job' as const, id: j.id as string, title: j.title as string,
      employer: biz?.name ?? (j.external_employer_name as string | null) ?? null,
      where: (j.location as string | null) ?? null, pay: (j.pay_text as string | null) ?? null, contract: (j.contract_type as string | null) ?? null,
    };
  });
}

async function loadShifts(): Promise<WorkShift[]> {
  const shifts = await fetchOpenShifts();
  return shifts.map((s) => ({
    kind: 'shift' as const, id: s.id, title: s.title, employer: shiftDisplayBusiness(s).name, where: s.location_text,
    startAt: s.start_at, endAt: s.end_at, rate: formatPay(s.pay_type, s.pay_amount),
  }));
}

export async function loadHomeLocalData(viewerParish?: string | null, userId?: string | null): Promise<HomeLocalData> {
  const [fixtures, today, cruise, events, businesses, jobs, shifts, notices, spik, products, offers, passes, services] = await Promise.all([
    soft(fetchFixtureIds(userId), NO_FIXTURES),
    soft(fetchTodaySnapshot(), null),
    soft(getCruiseHomeCard(), null),
    soft(fetchHomeEvents(5), [] as HomeEvent[]),
    loadBusinesses(undefined, 9),
    soft(loadJobs(), [] as WorkJob[]),
    soft(loadShifts(), [] as WorkShift[]),
    soft(fetchHomeNotices({ limit: 2, viewerParish }), [] as HomeNotice[]),
    soft(fetchTodaysSpik(), null),
    soft(fetchFreshProducts(12), [] as Awaited<ReturnType<typeof fetchFreshProducts>>),
    soft(fetchActiveOffers(), [] as Awaited<ReturnType<typeof fetchActiveOffers>>),
    soft(fetchActiveLocalPasses(12), [] as Awaited<ReturnType<typeof fetchActiveLocalPasses>>),
    soft(fetchActiveBookableServices(12), [] as Awaited<ReturnType<typeof fetchActiveBookableServices>>),
  ]);
  const ships = cruise && cruise.isToday ? { count: cruise.ships_count } : null;
  const weather = today
    ? (`Lerwick ${today.tempC != null ? Math.round(today.tempC) + '°' : ''} ${describeWeather(today.weatherCode).label}`.replace(/\s+/g, ' ').trim() + (today.sunset ? ` · Sunset ${today.sunset}` : ''))
    : null;
  return {
    fixtures, today, weather, ships, events, businesses, jobs, shifts, notices,
    spik: spik ? { word: spik.word, meaning: spik.meaning } : null,
    commerce: {
      shop: products.map((p) => ({ id: p.id, pillar: 'shop' as const, title: p.title, business: p.business_name, price: gbp(p.price_pence), uri: p.photo, route: { pathname: '/product-detail', params: { id: p.id } }, test: fixtures.business.has(p.business_id) })),
      offers: offers.filter((o) => o.business?.is_active !== false).map((o) => ({
        id: o.id, pillar: 'offers' as const, title: o.title, business: o.business?.name ?? '', badge: formatOfferDiscount(o),
        meta: `Until ${new Date(o.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
        route: { pathname: '/local-business-detail', params: { id: o.business_id } }, test: fixtures.business.has(o.business_id),
      })),
      book: services.map((s) => ({
        id: s.id, pillar: 'book' as const, title: s.name, business: s.business_name, price: `from ${gbp(s.price_pence)}`, meta: `${s.duration_minutes} min`,
        route: { pathname: '/local-book-business', params: { businessId: s.business_id, serviceId: s.id } }, test: fixtures.business.has(s.business_id),
      })),
      experiences: passesToMerch(passes, fixtures),
    },
  };
}
