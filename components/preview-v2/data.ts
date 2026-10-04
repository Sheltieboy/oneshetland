/**
 * data.ts — what the App Home V2 / Local V2 previews read from production. READ-ONLY: every call here is an
 * existing public read the shipped screens already make. Nothing is written. Each source fails soft (an empty list),
 * so a flaky network can never crash a preview.
 */
import { supabase } from '../../lib/supabase';
import { BUSINESS_PUBLIC_SOURCE, BUSINESS_PUBLIC_COLS, fetchActiveOffers, fetchActiveLocalPasses, type LocalBusiness } from '../../lib/local-api';
import { fetchFreshProducts } from '../../lib/products-api';
import { fetchActiveBookableServices } from '../../lib/book-api';
import { fetchOpenShifts, shiftDisplayBusiness, formatPay } from '../../lib/shifts-api';
import type { WorkJob, WorkShift } from './work';
import { fetchTodaySnapshot, describeWeather, type TodaySnapshot } from '../../lib/shetland-today';
import { getCruiseHomeCard } from '../../lib/cruise-api';
import { fetchHomeNotices, fetchTodaysSpik } from '../../lib/concierge-api';
import type { Merch, Pillar } from './model';

const soft = async <T,>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };

export interface PreviewEvent { id: string; title: string; starts_at: string; venue: string | null; cover_url: string | null }
export interface PreviewData {
  today: TodaySnapshot | null;
  weather: string | null;
  ships: { count: number; isToday: boolean } | null;
  events: PreviewEvent[];
  businesses: LocalBusiness[];
  /** Real current jobs and real current shifts (the live Work content). Never padded: no shift in production → none. */
  jobs: WorkJob[];
  shifts: WorkShift[];
  notices: { id: string; title: string; body: string; publisher: string }[];
  spik: { word: string; meaning: string } | null;
  real: Record<Pillar, Merch[]>;
}

const gbp = (p: number) => (p % 100 === 0 ? `£${p / 100}` : `£${(p / 100).toFixed(2)}`);

/** Commercial listings only, one per trading name, dealt café → shop → service → stay. */
export function curate(list: LocalBusiness[], limit = 9): LocalBusiness[] {
  const okay = list.filter((b) => ['food_drink', 'retail', 'services', 'accommodation'].includes(b.category as string) && b.name?.trim());
  const seen = new Set<string>();
  const unique = okay.filter((b) => { const k = b.name.toLowerCase().replace(/[^a-z0-9]+/g, ''); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  const lanes = ['food_drink', 'retail', 'services', 'accommodation'].map((c) => unique.filter((b) => b.category === c));
  const out: LocalBusiness[] = [];
  for (let i = 0; out.length < unique.length && out.length < limit; i++) for (const lane of lanes) if (lane[i] && out.length < limit) out.push(lane[i]);
  return out;
}

export async function loadPreviewData(): Promise<PreviewData> {
  const now = new Date().toISOString();
  const [today, cruise, events, bizAll, jobs, notices, spik, products, offers, passes, services, openShifts] = await Promise.all([
    soft(fetchTodaySnapshot(), null),
    soft(getCruiseHomeCard(), null),
    soft(
      (async () => {
        const { data } = await supabase.from('events').select('id,title,starts_at,venue,cover_url').eq('status', 'published').gte('starts_at', now).order('starts_at', { ascending: true }).limit(5);
        return (data ?? []) as PreviewEvent[];
      })(), [] as PreviewEvent[]),
    soft(
      (async () => {
        // Commercial listings only (the directory also holds heritage points of interest), best-presented first.
        const { data } = await supabase.from(BUSINESS_PUBLIC_SOURCE).select(BUSINESS_PUBLIC_COLS).eq('is_active', true)
          .in('category', ['food_drink', 'retail', 'services', 'accommodation'])
          .not('logo_url', 'is', null)
          .order('is_claimed', { ascending: false }).order('is_verified', { ascending: false }).order('created_at', { ascending: false }).limit(120);
        return (data ?? []) as LocalBusiness[];
      })(), [] as LocalBusiness[]),
    soft(
      (async () => {
        const { data } = await supabase.from('jobs').select('id,title,location,pay_text,contract_type,external_employer_name').eq('status', 'open').eq('is_hidden', false)
          .or(`expires_at.is.null,expires_at.gt.${now}`).order('is_featured', { ascending: false }).order('posted_at', { ascending: false }).limit(4);
        return (data ?? []) as { id: string; title: string; location: string | null; pay_text: string | null; contract_type: string | null; external_employer_name: string | null }[];
      })(), [] as { id: string; title: string; location: string | null; pay_text: string | null; contract_type: string | null; external_employer_name: string | null }[]),
    soft(fetchHomeNotices({ limit: 2 }), []),
    soft(fetchTodaysSpik(), null),
    soft(fetchFreshProducts(12), [] as any[]),
    soft(fetchActiveOffers(), [] as any[]),
    soft(fetchActiveLocalPasses(12), [] as any[]),
    soft(fetchActiveBookableServices(12), [] as any[]),
    soft(fetchOpenShifts(), [] as any[]),
  ]);
  const ships = cruise && (cruise as any).isToday ? { count: (cruise as any).ships_count ?? (cruise as any).visits?.length ?? 1, isToday: true } : null;
  return {
    today,
    weather: today ? `Lerwick ${today.tempC != null ? Math.round(today.tempC) + '°' : ''} ${describeWeather(today.weatherCode).label}`.replace(/\s+/g, ' ').trim() + (today.sunset ? ` · Sunset ${today.sunset}` : '') : null,
    ships,
    events,
    businesses: curate(bizAll, 9),
    jobs: jobs.map((j) => ({ kind: 'job' as const, id: j.id, title: j.title, employer: j.external_employer_name, where: j.location, pay: j.pay_text, contract: j.contract_type })),
    shifts: (openShifts as any[]).map((s) => ({ kind: 'shift' as const, id: s.id, title: s.title, employer: shiftDisplayBusiness(s).name, where: s.location_text, startAt: s.start_at, endAt: s.end_at, rate: formatPay(s.pay_type, s.pay_amount) })),
    notices: (notices as any[]).filter((n) => n.source === 'db').map((n) => ({ id: n.id, title: n.title, body: n.body, publisher: n.publisher })),
    spik: spik ? { word: (spik as any).word, meaning: (spik as any).meaning } : null,
    real: {
      shop: (products as any[]).map((p) => ({ id: p.id, pillar: 'shop' as const, title: p.title, business: p.business_name ?? p.business?.name ?? '', price: gbp(p.price_pence), uri: p.photo ?? p.photos?.[0] })),
      offers: (offers as any[]).map((o) => ({ id: o.id, pillar: 'offers' as const, title: o.title, business: '', badge: 'Offer', meta: `Until ${new Date(o.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` })),
      book: (services as any[]).map((s) => ({ id: s.id, pillar: 'book' as const, title: s.name, business: s.business_name, price: `from ${gbp(s.price_pence)}`, meta: `${s.duration_minutes} min` })),
      experiences: (passes as any[]).map((p) => ({ id: p.id, pillar: 'experiences' as const, title: p.name, business: p.business_name, price: gbp(p.price_pence), uri: p.image_url ?? undefined, meta: `${p.uses_per_purchase > 1 ? `${p.uses_per_purchase} uses` : '1 use'}${p.valid_days ? ` · valid ${p.valid_days} days` : ''}` })),
    },
  };
}
