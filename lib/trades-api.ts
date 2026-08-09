/**
 * Get it done — app side.
 *
 * Talks to the same tables and the same matching endpoint as the website, so a
 * job posted on a phone and a job posted on a laptop reach exactly the same
 * trades in the same order. The one thing NOT duplicated is the ranking: that
 * lives in the web's lib/trades-data.ts behind /api/trades/match, because two
 * implementations of "who should hear about this" would drift apart and the
 * drift would be invisible — nobody notices the joiner who stopped being
 * offered work.
 */

import { supabase } from './supabase';
import { WEB_BASE_URL } from '@/constants/peerie';
import {
  FREE_LEADS_PER_MONTH, hasUnlimitedLeads, isTradeKey,
  type Availability, type Scale, type TradeKey, type Urgency,
} from '@/constants/trades';

export type TradeMatch = {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  availability: Availability | null;
  trades: string[];
  credentials: string[];
  minJobPence: number | null;
  distanceKm: number | null;
  responseRate: number | null;
  tier: string;
  score: number;
};

/** Who could take this on — the same ranking the website shows. */
export async function findMatches(input: {
  trades: TradeKey[];
  urgency: Urgency;
  scale: Scale;
}): Promise<TradeMatch[]> {
  if (input.trades.length === 0) return [];
  try {
    const res = await fetch(`${WEB_BASE_URL}/api/trades/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.matches) ? (data.matches as TradeMatch[]) : [];
  } catch {
    // A failed match list must never block posting — the brief is the point,
    // the preview is a courtesy.
    return [];
  }
}

export type BriefInput = {
  title: string;
  description: string;
  trades: TradeKey[];
  scale: Scale;
  urgency: Urgency;
  locationText: string;
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
};

/**
 * Post a brief and dispatch it.
 *
 * Mirrors the web's postBrief server action, including the two rules that
 * matter: at most 8 recipients (broadcasting to everyone is how the busiest
 * firms learn to ignore the app), and the free monthly cap applied at
 * DELIVERY, so a lead skips a spent free listing and goes to the next trade
 * with room rather than making somebody wait longer because nobody paid.
 */
export async function postBrief(
  userId: string,
  input: BriefInput,
): Promise<{ ok: boolean; id?: string; sentTo?: number; error?: string }> {
  const trades = input.trades.filter(isTradeKey);
  if (trades.length === 0) return { ok: false, error: 'Pick at least one trade.' };

  const { data: brief, error } = await supabase
    .from('trade_briefs')
    .insert({
      author_id: userId,
      title: input.title.trim(),
      description: input.description.trim(),
      trades,
      scale: input.scale,
      urgency: input.urgency,
      location_text: input.locationText.trim(),
      contact_name: input.contactName.trim() || null,
      contact_phone: input.contactPhone.trim(),
      contact_email: input.contactEmail?.trim() || null,
    })
    .select('id')
    .single();

  if (error || !brief) return { ok: false, error: error?.message ?? "Couldn't post that." };

  const matches = (await findMatches({ trades, urgency: input.urgency, scale: input.scale })).slice(0, 8);
  if (matches.length === 0) return { ok: true, id: brief.id, sentTo: 0 };

  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const freeIds = matches.filter(m => !hasUnlimitedLeads(m.tier)).map(m => m.id);
  const usage: Record<string, number> = {};
  if (freeIds.length > 0) {
    const { data: used } = await supabase
      .from('trade_brief_matches')
      .select('business_id')
      .in('business_id', freeIds)
      .gte('created_at', monthStart.toISOString());
    for (const r of (used ?? []) as { business_id: string }[]) {
      usage[r.business_id] = (usage[r.business_id] ?? 0) + 1;
    }
  }

  const deliverable = matches.filter(
    m => hasUnlimitedLeads(m.tier) || (usage[m.id] ?? 0) < FREE_LEADS_PER_MONTH,
  );

  if (deliverable.length > 0) {
    await supabase.from('trade_brief_matches').insert(
      deliverable.map(m => ({ brief_id: brief.id, business_id: m.id, status: 'sent' })),
    );
  }
  return { ok: true, id: brief.id, sentTo: deliverable.length };
}

/* ── Reading your own briefs ──────────────────────────────────────────────── */

export type MyBrief = {
  id: string;
  title: string;
  trades: string[];
  location: string;
  status: string;
  createdAt: string;
  responses: {
    id: string;
    status: string;
    declineReason: string | null;
    businessName: string;
    businessPhone: string | null;
  }[];
};

export async function fetchMyBriefs(userId: string): Promise<MyBrief[]> {
  const { data: briefs } = await supabase
    .from('trade_briefs')
    .select('id, created_at, title, trades, location_text, status')
    .eq('author_id', userId)
    .order('created_at', { ascending: false });

  const ids = (briefs ?? []).map(b => b.id as string);
  if (ids.length === 0) return [];

  const { data: matches } = await supabase
    .from('trade_brief_matches')
    .select('id, brief_id, status, decline_reason, local_businesses(name, phone)')
    .in('brief_id', ids);

  const byBrief = new Map<string, MyBrief['responses']>();
  for (const m of (matches ?? []) as Record<string, unknown>[]) {
    const raw = m.local_businesses;
    const biz = (Array.isArray(raw) ? raw[0] : raw) as { name?: string; phone?: string } | null;
    const key = m.brief_id as string;
    byBrief.set(key, [
      ...(byBrief.get(key) ?? []),
      {
        id: m.id as string,
        status: m.status as string,
        declineReason: (m.decline_reason as string | null) ?? null,
        businessName: biz?.name ?? 'A business',
        // Both ways round: once a trade says yes, the person who posted gets
        // their number too rather than sitting by the phone.
        businessPhone: m.status === 'interested' ? (biz?.phone ?? null) : null,
      },
    ]);
  }

  return (briefs ?? []).map(b => ({
    id: b.id as string,
    title: b.title as string,
    trades: (b.trades as string[]) ?? [],
    location: b.location_text as string,
    status: b.status as string,
    createdAt: b.created_at as string,
    responses: byBrief.get(b.id as string) ?? [],
  }));
}

export async function closeBrief(
  briefId: string,
  userId: string,
  outcome: 'via_oneshetland' | 'elsewhere' | 'gave_up' | 'no_longer_needed',
): Promise<boolean> {
  const { error } = await supabase
    .from('trade_briefs')
    .update({
      status: outcome === 'gave_up' ? 'withdrawn' : 'sorted',
      outcome,
      updated_at: new Date().toISOString(),
    })
    .eq('id', briefId)
    .eq('author_id', userId);
  return !error;
}

/* ── The trade's side ─────────────────────────────────────────────────────── */

export type Lead = {
  matchId: string;
  status: string;
  createdAt: string;
  brief: {
    title: string; description: string; trades: string[];
    scale: string; urgency: string; location: string; createdAt: string; closed: boolean;
  };
  contact: { name: string | null; phone: string | null; email: string | null } | null;
};

export async function fetchLeads(businessId: string): Promise<Lead[]> {
  const { data } = await supabase
    .from('trade_brief_matches')
    .select('id, status, created_at, trade_briefs(title, description, trades, scale, urgency, location_text, created_at, status, contact_name, contact_phone, contact_email)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(50);

  return ((data ?? []) as Record<string, unknown>[]).flatMap(m => {
    const raw = m.trade_briefs;
    const b = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null;
    if (!b) return [];
    return [{
      matchId: m.id as string,
      status: m.status as string,
      createdAt: m.created_at as string,
      brief: {
        title: b.title as string,
        description: b.description as string,
        trades: (b.trades as string[]) ?? [],
        scale: b.scale as string,
        urgency: b.urgency as string,
        location: b.location_text as string,
        createdAt: b.created_at as string,
        closed: (b.status as string) !== 'open',
      },
      // Same gate as the web, in one place: nothing shows a phone number
      // unless this trade has said yes.
      contact: m.status === 'interested' ? {
        name: (b.contact_name as string | null) ?? null,
        phone: (b.contact_phone as string | null) ?? null,
        email: (b.contact_email as string | null) ?? null,
      } : null,
    }];
  });
}

export async function respondToLead(
  matchId: string,
  response: 'interested' | 'declined',
  declineReason?: string,
): Promise<{ ok: boolean; contact?: { name: string | null; phone: string | null; email: string | null } }> {
  const { data, error } = await supabase
    .from('trade_brief_matches')
    .update({
      status: response,
      decline_reason: response === 'declined' ? (declineReason ?? 'other') : null,
      responded_at: new Date().toISOString(),
    })
    .eq('id', matchId)
    .select('brief_id')
    .single();

  if (error || !data) return { ok: false };
  if (response !== 'interested') return { ok: true };

  const { data: brief } = await supabase
    .from('trade_briefs')
    .select('contact_name, contact_phone, contact_email')
    .eq('id', data.brief_id)
    .single();

  return {
    ok: true,
    contact: {
      name: brief?.contact_name ?? null,
      phone: brief?.contact_phone ?? null,
      email: brief?.contact_email ?? null,
    },
  };
}

export async function saveTradeProfile(
  businessId: string,
  input: { trades: string[]; availability: string | null; minJobPence: number | null; credentials: string[] },
): Promise<boolean> {
  const { error } = await supabase
    .from('local_businesses')
    .update({
      trade_categories: input.trades.filter(isTradeKey),
      trade_availability: input.availability,
      // Stamped on every save — this timestamp is what stops a March answer
      // being believed in June.
      trade_availability_set_at: input.availability ? new Date().toISOString() : null,
      trade_min_job_pence: input.minJobPence,
      trade_credentials: input.credentials,
    })
    .eq('id', businessId);
  return !error;
}

/* ── The waiting list ─────────────────────────────────────────────────────── */

export type DemandRow = { trade: string; waiting: number; unanswered: number; avgDaysWaiting: number };

export async function fetchTradeDemand(): Promise<DemandRow[]> {
  const { data, error } = await supabase.rpc('trade_demand_summary');
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(r => ({
    trade: r.trade as string,
    waiting: Number(r.waiting ?? 0),
    unanswered: Number(r.unanswered ?? 0),
    avgDaysWaiting: Number(r.avg_days_waiting ?? 0),
  }));
}
