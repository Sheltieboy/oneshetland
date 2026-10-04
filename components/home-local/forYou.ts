/**
 * forYou.ts — Home's "For you" row, built ONLY from things that genuinely belong to the signed-in person:
 *
 *   • their own live commitments — a delivery in flight, an upcoming booking, tickets for an upcoming event, a shift
 *     application, a reward ready to redeem, a gift waiting to be booked
 *   • their Wallet (when there is a balance)
 *   • something they saved (vessels they follow)
 *   • a genuine offer from a business physically near them (only if they have already allowed location)
 *
 * There is no editorial filler, no "today's game", no engagement-driven suggestions and no placeholder. If none of the
 * above exists the list is empty and the section is not rendered at all.
 */
import type { HomeData } from '@/lib/home-data';
import type { NearbyOffer } from '@/lib/concierge-api';

export type ForYouTone = 'wallet' | 'booking' | 'ticket' | 'delivery' | 'work' | 'reward' | 'gift' | 'saved' | 'nearby';

export interface ForYouTile {
  id: string;
  tone: ForYouTone;
  /** Small label on the tile ("Wallet", "Booked", "Tickets"…). */
  tag: string;
  /** The big line. */
  headline: string;
  /** One supporting line. */
  detail: string;
  /** Wallet tiles show the amount in a larger size. */
  big?: boolean;
  route: { pathname: string; params?: Record<string, string> };
}

export interface ForYouInputs {
  signedIn: boolean;
  walletPence: number | null;
  home: HomeData | null;
  /** The person's valid tickets, each with the event it is for. */
  tickets: { event?: { id: string; title: string; starts_at: string } | null }[];
  savedBoats: { canonical_name?: string | null }[];
  nearby: NearbyOffer[];
}

const MAX_TILES = 6;
const gbp = (p: number) => (p % 100 === 0 ? `£${p / 100}` : `£${(p / 100).toFixed(2)}`);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const dayWord = (d: Date, now: Date) => {
  if (sameDay(d, now)) return 'Today';
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  return sameDay(d, tomorrow) ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};
const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function buildForYou(i: ForYouInputs, now: Date = new Date()): ForYouTile[] {
  if (!i.signedIn) return [];
  const out: ForYouTile[] = [];
  const h = i.home;

  if (h?.activeDelivery) {
    const d = h.activeDelivery;
    out.push({
      id: 'delivery', tone: 'delivery', tag: 'Your delivery',
      headline: d.destination_area ? `To ${d.destination_area}` : 'On its way',
      detail: d.status === 'pending' ? 'Finding you a driver' : d.status === 'collected' ? 'On its way to you' : 'A driver is on the way',
      route: { pathname: '/(tabs)/fetch' },
    });
  }
  if (h?.upcomingBooking) {
    const b = h.upcomingBooking;
    const at = new Date(b.starts_at);
    out.push({
      id: 'booking', tone: 'booking', tag: sameDay(at, now) ? 'Booking today' : 'Booked',
      headline: `${dayWord(at, now)} ${hhmm(at)}`,
      detail: [b.service_name ?? 'Appointment', b.business_name].filter(Boolean).join(' · '),
      route: { pathname: '/local-my-bookings' },
    });
  }

  // Tickets: group by event, soonest upcoming event first.
  const upcoming = i.tickets.filter((t) => t.event && new Date(t.event.starts_at).getTime() > now.getTime());
  if (upcoming.length > 0) {
    const byEvent = new Map<string, { title: string; at: Date; n: number }>();
    for (const t of upcoming) {
      const e = t.event!;
      const cur = byEvent.get(e.id);
      if (cur) cur.n += 1; else byEvent.set(e.id, { title: e.title, at: new Date(e.starts_at), n: 1 });
    }
    const next = [...byEvent.values()].sort((a, b) => +a.at - +b.at)[0];
    out.push({
      id: 'tickets', tone: 'ticket', tag: 'Tickets',
      headline: `${dayWord(next.at, now)}${sameDay(next.at, now) ? ` ${hhmm(next.at)}` : ''}`,
      detail: `${next.n} ${next.n === 1 ? 'ticket' : 'tickets'} · ${next.title}`,
      route: { pathname: '/my-event-tickets' },
    });
  }

  if (h?.application && (h.application.status === 'accepted' || h.application.status === 'pending')) {
    const a = h.application;
    out.push({
      id: 'application', tone: 'work', tag: a.status === 'accepted' ? "You're confirmed" : 'Application in',
      headline: a.title, detail: a.status === 'accepted' ? 'Confirmed' : 'Awaiting the employer',
      route: { pathname: '/my-shift-applications' },
    });
  }
  if (h?.rewardReady) {
    const r = h.rewardReady;
    out.push({
      id: 'reward', tone: 'reward', tag: 'Reward ready',
      headline: r.business_name ? `Free reward at ${r.business_name}` : 'A reward is ready',
      detail: 'Show your card to redeem', route: { pathname: '/local-my-cards' },
    });
  }
  if (h?.giftToClaim) {
    out.push({ id: 'gift', tone: 'gift', tag: 'Gift to book', headline: 'You have a gift to book', detail: 'Pick a time — no need to find the email', route: { pathname: '/local-my-gifts' } });
  }

  if (i.walletPence != null && i.walletPence > 0) {
    out.push({ id: 'wallet', tone: 'wallet', tag: 'Wallet', headline: gbp(i.walletPence), detail: 'In your Wallet · spend it with local businesses', big: true, route: { pathname: '/local-wallet' } });
  }

  const withOffer = i.nearby.find((n) => n.offer_title);
  if (withOffer) {
    out.push({ id: 'nearby', tone: 'nearby', tag: 'Near you', headline: withOffer.offer_title as string, detail: withOffer.business_name, route: { pathname: '/local-offers' } });
  }

  if (i.savedBoats.length > 0) {
    const first = i.savedBoats[0];
    out.push({
      id: 'saved-boats', tone: 'saved', tag: 'Saved',
      headline: first.canonical_name ?? `${i.savedBoats.length} saved ${i.savedBoats.length === 1 ? 'vessel' : 'vessels'}`,
      detail: i.savedBoats.length > 1 ? `+ ${i.savedBoats.length - 1} more saved` : 'Tap to track movements',
      route: { pathname: '/(tabs)/da-boats' },
    });
  }

  return out.slice(0, MAX_TILES);
}
