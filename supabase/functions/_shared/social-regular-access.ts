/**
 * social-regular-access.ts — two Social Studio recipes, built on the existing composer / queue / publisher (no second engine):
 *
 *   regular_roundup   "What's On This Week — Regular Activities": a weekly discovery post built from genuine published Regular Activities.
 *   accessible_info   "Accessible Shetland — Information & Discovery": fortnightly; rotates awareness / resource spotlight / business access information.
 *
 * Everything stated in a caption comes from a database record or the approved resource library; nothing is invented. Captions are deterministic
 * templates (no AI rewrite: these kinds are FACTUAL in social-recipes.ts). Both are re-checked against live data immediately before publishing.
 * Pure helpers are exported for tests; selectors take the service client (loosely typed) so a mock can stand in.
 */
import {
  go, SITE, londonParts, londonInstant, isFixtureName, isSensitiveText, httpsUrl, HELD_PREFIX, REGULAR_DEFAULTS, ACCESS_DEFAULTS, type Candidate,
} from './social-recipes.ts';

type Svc = any;
const DAY = 86400_000;

/* ── Time: Europe/London, DST-safe ─────────────────────────────────────────────────────────────────────────────── */

export const addDaysYmd = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};
const dowOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();            // 0 = Sunday

/** The London date on which the weekly roundup goes out: the first Sunday on or after today. */
export function roundupPostDay(now: Date): string {
  const today = londonParts(now).ymd;
  return addDaysYmd(today, (7 - dowOf(today)) % 7);
}
/** The Monday that starts the forthcoming Monday–Sunday week the roundup covers (the day after the post day). */
export const roundupMonday = (now: Date): string => addDaysYmd(roundupPostDay(now), 1);
/** [Monday 00:00, next Monday 00:00) in London time. Two separate conversions, so a BST/GMT change inside the week is handled. */
export const weekWindow = (mondayYmd: string): { from: Date; to: Date } => ({ from: londonInstant(mondayYmd, 0, 0), to: londonInstant(addDaysYmd(mondayYmd, 7), 0, 0) });

const fmtDow = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(new Date(iso));
const fmtHm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
   1. REGULAR ACTIVITIES — WEEKLY ROUNDUP
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════════ */


export type ListingRow = {
  id: string; slug: string; title: string; description: string | null; category: string; audience: string | null; venue: string | null; locality: string | null;
  price_text: string | null; booking_mode: string; cover_url: string | null; owner_kind: string; owner_id: string | null; owner_name: string; owner_slug: string | null;
  next_starts_at: string | null; next_ends_at: string | null; sessions_in_window: number; cancelled_in_window: number;
  upcoming: { starts_at: string; ends_at: string; status: string; venue: string | null; note: string | null }[];
};
export type RoundupExcluded = { id: string; title: string; reason: string };
export type RoundupItem = { id: string; title: string; organiser: string; category: string; place: string | null; photo: boolean; sessions: { starts_at: string; ends_at: string }[]; moreSessions: boolean };

const isLiveStatus = (s: string) => s !== 'cancelled' && s !== 'break';
const ownerKey = (r: Pick<ListingRow, 'owner_kind' | 'owner_id' | 'owner_name'>) => `${r.owner_kind}:${r.owner_id ?? r.owner_name}`;

/** The week's activities that really have a live session, straight from the existing listing function (cancelled sessions and breaks are already excluded from `sessions_in_window`). */
export async function loadWeekListing(svc: Svc, monday: string): Promise<ListingRow[]> {
  const w = weekWindow(monday);
  const { data, error } = await svc.rpc('regular_activities_listing', { p_from: w.from.toISOString(), p_to: w.to.toISOString(), p_dow: null, p_category: null, p_locality: null, p_drop_in: null, p_q: null, p_limit: 100 });
  if (error) throw error;
  return ((data ?? []) as ListingRow[]).filter((r) => r.sessions_in_window > 0);
}

/**
 * The listing function is security-invoker, and the composer holds the service key (which bypasses row security), so it can include drafts and
 * hidden owners. Public visibility is therefore re-verified here with the same rule the site uses (activity_is_public + discovery hiding).
 * Returns the ids that are genuinely public, plus why each other one was refused.
 */
export async function publicActivityIds(svc: Svc, ids: string[]): Promise<{ ok: Set<string>; refused: Map<string, string> }> {
  const ok = new Set<string>(); const refused = new Map<string, string>();
  if (!ids.length) return { ok, refused };
  const { data: acts, error } = await svc.from('regular_activities').select('id,status,admin_paused,organiser_hub_id,organiser_business_id,calendar_approved').in('id', ids);
  if (error) throw error;
  const rows = (acts ?? []) as { id: string; status: string; admin_paused: boolean; organiser_hub_id: string | null; organiser_business_id: string | null; calendar_approved: boolean }[];
  const hubIds = [...new Set(rows.map((r) => r.organiser_hub_id).filter((x): x is string => !!x))];
  const bizIds = [...new Set(rows.map((r) => r.organiser_business_id).filter((x): x is string => !!x))];
  const [hubs, biz] = await Promise.all([
    hubIds.length ? svc.from('hubs').select('id,is_active').in('id', hubIds) : { data: [] },
    bizIds.length ? svc.from('local_businesses').select('id,is_active').in('id', bizIds) : { data: [] },
  ]);
  const hubOk = new Set(((hubs.data ?? []) as { id: string; is_active: boolean }[]).filter((h) => h.is_active).map((h) => h.id));
  const bizOk = new Set(((biz.data ?? []) as { id: string; is_active: boolean }[]).filter((b) => b.is_active).map((b) => b.id));
  for (const id of ids) {
    const a = rows.find((r) => r.id === id);
    if (!a) { refused.set(id, 'not found'); continue; }
    if (a.status !== 'published') { refused.set(id, 'not published'); continue; }
    if (a.admin_paused) { refused.set(id, 'paused by staff'); continue; }
    if (a.organiser_hub_id && !(a.calendar_approved && hubOk.has(a.organiser_hub_id))) { refused.set(id, 'its Hub is inactive or has not approved it'); continue; }
    if (a.organiser_business_id && !bizOk.has(a.organiser_business_id)) { refused.set(id, 'its business is inactive'); continue; }
    ok.add(id);
  }
  // Discovery hiding of the owning entity: one lookup per distinct owner, only for owners of activities still in play.
  const owners = new Map<string, { entity: string; id: string }>();
  for (const id of ok) { const a = rows.find((r) => r.id === id)!; if (a.organiser_hub_id) owners.set(a.organiser_hub_id, { entity: 'hub', id: a.organiser_hub_id }); else if (a.organiser_business_id) owners.set(a.organiser_business_id, { entity: 'business', id: a.organiser_business_id }); }
  const hidden = new Set<string>();
  await Promise.all([...owners.values()].map(async (o) => { const r = await svc.rpc('is_discovery_hidden', { p_entity: o.entity, p_id: o.id }); if (r.data === true) hidden.add(o.id); }));
  for (const id of [...ok]) { const a = rows.find((r) => r.id === id)!; if (hidden.has(a.organiser_hub_id ?? a.organiser_business_id ?? '')) { ok.delete(id); refused.set(id, 'hidden'); } }
  return { ok, refused };
}

/** Why a listed activity cannot be advertised, or null. */
export function roundupRefusal(r: ListingRow): string | null {
  if (isFixtureName(r.title) || isFixtureName(r.owner_name)) return 'test fixture';
  if (!r.title?.trim()) return 'no title';
  if (isSensitiveText(r.title, r.description, r.audience)) return 'sensitive subject';
  if (!r.next_starts_at || !r.next_ends_at) return 'no live session';
  return null;
}

export type RoundupHistory = { ids: string[]; at: string }[];   // earlier roundups, newest first, with the activity ids each featured

/**
 * Chooses up to `max` activities. Greedy, one at a time, ranking: an organiser not yet chosen this week, the organiser featured least in recent
 * roundups, the activity featured least recently, a category not yet chosen, a locality not yet chosen, then a stable weekly hash (so ties rotate
 * week by week and nobody is favoured). No organiser exceeds `perOrganiser`. With fewer candidates than `max`, all of them are used: no filler.
 */
export function pickRoundup(rows: ListingRow[], history: RoundupHistory, cfg: Record<string, unknown>, weekKey: string): ListingRow[] {
  const max = Math.max(1, Number(cfg.max_items ?? REGULAR_DEFAULTS.max_items)), perOrg = Math.max(1, Number(cfg.max_per_organiser ?? REGULAR_DEFAULTS.max_per_organiser));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const actCount = new Map<string, number>(), orgCount = new Map<string, number>();
  history.forEach((h, i) => { const w = 1 / (1 + i * 0.25); for (const id of h.ids) { actCount.set(id, (actCount.get(id) ?? 0) + w); const r = byId.get(id); if (r) orgCount.set(ownerKey(r), (orgCount.get(ownerKey(r)) ?? 0) + w); } });
  const chosen: ListingRow[] = []; const orgNow = new Map<string, number>(); const cats = new Set<string>(); const places = new Set<string>();
  const place = (r: ListingRow) => (r.locality ?? r.venue ?? '').trim().toLowerCase();
  while (chosen.length < max) {
    let best: ListingRow | null = null; let bestKey: number[] = [];
    for (const r of rows) {
      if (chosen.includes(r)) continue;
      const k = ownerKey(r); if ((orgNow.get(k) ?? 0) >= perOrg) continue;
      const key = [(orgNow.get(k) ?? 0) === 0 ? 1 : 0, -(orgCount.get(k) ?? 0), -(actCount.get(r.id) ?? 0), cats.has(r.category) ? 0 : 1, places.has(place(r)) || !place(r) ? 0 : 1, -(hash(`${weekKey}|${r.id}`) / 4294967296)];
      let better = !best;
      if (best) for (let i = 0; i < key.length; i++) { if (key[i] !== bestKey[i]) { better = key[i] > bestKey[i]; break; } }
      if (better) { best = r; bestKey = key; }
    }
    if (!best) break;
    chosen.push(best); orgNow.set(ownerKey(best), (orgNow.get(ownerKey(best)) ?? 0) + 1); cats.add(best.category); places.add(place(best));
  }
  return chosen;
}

export function roundupItem(r: ListingRow): RoundupItem {
  const live = (r.upcoming ?? []).filter((u) => isLiveStatus(u.status));
  if (r.next_starts_at && r.next_ends_at && !live.some((u) => u.starts_at === r.next_starts_at)) live.unshift({ starts_at: r.next_starts_at, ends_at: r.next_ends_at, status: 'scheduled', venue: null, note: null });
  live.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const tidy = (x: string) => x.replace(/\s+/g, ' ').trim();   // owners type double spaces; a caption should not repeat them
  const place = [...new Set([r.venue, r.locality].filter((x): x is string => !!x && !!x.trim()).map(tidy))].join(', ') || null;
  return { id: r.id, title: tidy(r.title), organiser: r.owner_kind === 'platform' ? 'OneShetland' : tidy(r.owner_name), category: r.category, place, photo: !!httpsUrl(r.cover_url),
    sessions: live.slice(0, 2).map((u) => ({ starts_at: u.starts_at, ends_at: u.ends_at })), moreSessions: r.sessions_in_window > Math.min(live.length, 2) };
}

const OPENERS = ['Fancy trying something new this week? 💙', 'Looking for something to do this week? 💙', 'A new week, and plenty of things to try across Shetland. 💙'];

/**
 * The caption. Every fact is the listing's own. It never says free, drop-in, suitable for everyone or beginner-friendly: a class's booking and price
 * details live on its page, which the post links to.
 */
export function roundupCaption(items: RoundupItem[], opts: { index: number; link: string }): string {
  const lines = items.slice().sort((a, b) => (a.sessions[0]?.starts_at ?? '').localeCompare(b.sessions[0]?.starts_at ?? '')).map((i) => {
    const when = i.sessions.map((s) => `${fmtDow(s.starts_at)} ${fmtHm(s.starts_at)}–${fmtHm(s.ends_at)}`).join(', ') + (i.moreSessions ? ' and more' : '');
    return `• ${i.title} (${i.organiser}): ${when}${i.place ? `, ${i.place}` : ''}`;
  });
  const opener = OPENERS[opts.index % OPENERS.length];
  const intro = items.length === 1 ? 'Here is one regular activity on this week:' : 'A few of the regular classes, clubs and groups on this week:';
  return `${opener}\n\n${intro}\n\n${lines.join('\n')}\n\nSee every regular activity, with full details and any changes: ${opts.link}`;
}

export const roundupAlt = (items: RoundupItem[]) => `OneShetland "Regular activities this week" card listing ${items.length === 1 ? 'one activity' : `${items.length} activities`}: ${items.map((i) => i.title).join(', ')}.`;

export type RoundupReport = { at: string; monday: string; postDay: string; counts: { listed: number; qualifying: number; chosen: number }; chosen: { id: string; title: string; organiser: string; category: string }[]; excluded: RoundupExcluded[]; reason?: string };

export async function selectRoundup(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<{ candidate: Candidate | null; report: RoundupReport; imageAlt?: string }> {
  const monday = roundupMonday(now); const postDay = roundupPostDay(now); const weekKey = `reg:${monday}`;
  const report: RoundupReport = { at: now.toISOString(), monday, postDay, counts: { listed: 0, qualifying: 0, chosen: 0 }, chosen: [], excluded: [] };
  const listed = await loadWeekListing(svc, monday); report.counts.listed = listed.length;
  const { ok, refused } = await publicActivityIds(svc, listed.map((r) => r.id));
  const qualifying: ListingRow[] = [];
  for (const r of listed) {
    const why = refused.get(r.id) ?? (ok.has(r.id) ? roundupRefusal(r) : 'not public');
    if (why) report.excluded.push({ id: r.id, title: r.title, reason: why }); else qualifying.push(r);
  }
  report.counts.qualifying = qualifying.length;
  if (!qualifying.length) { report.reason = `no Regular Activities with a live session in the week starting ${monday}`; return { candidate: null, report }; }
  // Earlier roundups (any status except skipped/failed) tell the rotation who has had their turn.
  const lookback = Math.max(1, Number(cfg.lookback_weeks ?? REGULAR_DEFAULTS.lookback_weeks));
  const { data: past } = await svc.from('social_posts').select('link_url,created_at,status').eq('kind', 'regular_roundup').in('status', ['posted', 'scheduled', 'approved', 'draft']).gte('created_at', new Date(now.getTime() - lookback * 7 * DAY).toISOString()).order('created_at', { ascending: false }).limit(20);
  const history: RoundupHistory = ((past ?? []) as { link_url: string | null; created_at: string }[]).map((p) => ({ ids: idsFrom(p.link_url), at: p.created_at }));
  const chosen = pickRoundup(qualifying, history, cfg, weekKey);
  report.counts.chosen = chosen.length;
  report.chosen = chosen.map((r) => ({ id: r.id, title: r.title, organiser: r.owner_name, category: r.category }));
  const items = chosen.map(roundupItem);
  // The graphic leads with activities that have a real photograph (the large tile), otherwise in session order.
  const imageOrder = items.slice().sort((a, b) => Number(b.photo) - Number(a.photo) || (a.sessions[0]?.starts_at ?? '').localeCompare(b.sessions[0]?.starts_at ?? ''));
  const ids = imageOrder.map((i) => i.id);
  const link = go('regular-activities');
  const caption = roundupCaption(items, { index: history.length, link });
  return {
    candidate: { kind: 'regular_roundup', entity_type: 'week', entity_id: weekKey, caption, image_url: `${SITE}/api/social-image?kind=regular&ids=${ids.join(',')}&v=${monday}`, link_url: `${link}#ids=${ids.join(',')}`, context: 'Weekly roundup of genuine Regular Activities.',
      note: `${chosen.length} of ${qualifying.length} qualifying activities, week of ${monday}` },
    report, imageAlt: roundupAlt(items),
  };
}

/** Activity ids carried on a post's link (…#ids=a,b,c). */
export const idsFrom = (link: string | null | undefined): string[] => { const m = /#ids=([A-Za-z0-9,-]+)/.exec(link ?? ''); return m ? m[1].split(',').filter(Boolean) : []; };

/** Publish-time check for a roundup: the week must not have started, and every listed activity must still be public with a live session that week. */
export async function revalidateRoundup(svc: Svc, post: { entity_id: string | null; link_url?: string | null }, now: Date): Promise<{ state: 'valid' | 'invalid' | 'unknown'; reason?: string }> {
  const monday = /^reg:(\d{4}-\d{2}-\d{2})/.exec(post.entity_id ?? '')?.[1];
  const ids = idsFrom(post.link_url);
  if (!monday || !ids.length) return { state: 'invalid', reason: 'roundup has no recorded week or activities' };
  if (now.getTime() >= weekWindow(monday).from.getTime()) return { state: 'invalid', reason: `the week starting ${monday} has already begun` };
  const listed = await loadWeekListing(svc, monday);
  const { ok } = await publicActivityIds(svc, ids);
  for (const id of ids) {
    const r = listed.find((x) => x.id === id);
    if (!ok.has(id) || !r) return { state: 'invalid', reason: `an advertised activity no longer has live public sessions that week (${id})` };
    const why = roundupRefusal(r); if (why) return { state: 'invalid', reason: `an advertised activity is no longer eligible: ${why}` };
  }
  return { state: 'valid' };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
   2. ACCESSIBLE SHETLAND — INFORMATION & DISCOVERY
   ══════════════════════════════════════════════════════════════════════════════════════════════════════════════ */


export type AccessTopic = 'getting_here' | 'getting_around' | 'visiting' | 'facilities' | 'support' | 'information';
export type AccessResource = { slug: string; topic: AccessTopic; title: string; by: string; href: string; about: string; verified_on: string; anchor: string };

/**
 * The approved resource library: the SAME verified links as the Accessible Shetland page (the web test suite checks the two agree). Each was fetched
 * and answered on `verified_on`. We summarise and credit; we never copy their text. A resource is automated only when its slug is listed in the
 * recipe's `approved_resources`; any other is drafted for staff review.
 */
export const ACCESS_RESOURCES: AccessResource[] = [
  { slug: 'northlink-support', topic: 'getting_here', by: 'NorthLink Ferries', title: 'Accessibility support', href: 'https://www.northlinkferries.co.uk/travel/passenger-info/accessibility-support/', about: 'Cabins, boarding help and advance-notice guidance for the Aberdeen, Orkney and Shetland ferries.', verified_on: '2026-11-06', anchor: 'r-travel' },
  { slug: 'northlink-policy', topic: 'getting_here', by: 'NorthLink Ferries', title: 'Accessibility policy', href: 'https://www.northlinkferries.co.uk/accessibility-policy/', about: 'Their formal policy for terminals, vessels and assistance dogs.', verified_on: '2026-11-06', anchor: 'r-travel' },
  { slug: 'loganair-support', topic: 'getting_here', by: 'Loganair', title: 'Accessibility support', href: 'https://www.loganair.co.uk/customer-support/accessibility-assistance-hub/', about: 'How to arrange assistance for a flight.', verified_on: '2026-11-06', anchor: 'r-travel' },
  { slug: 'sumburgh-assistance', topic: 'getting_here', by: 'HIAL', title: 'Assistance and accessibility at Sumburgh Airport', href: 'https://www.hial.co.uk/sumburgh-airport/assistance-accessibility-1', about: 'Help at the airport. Assistance is booked through your airline.', verified_on: '2026-11-06', anchor: 'r-travel' },
  { slug: 'sic-ferries-faq', topic: 'getting_around', by: 'Shetland Islands Council', title: 'Inter-island ferries: frequently asked questions', href: 'https://www.shetland.gov.uk/ferries/faq', about: "Answers about the council's inter-island ferries.", verified_on: '2026-11-06', anchor: 'r-travel' },
  { slug: 'zettrans-bus', topic: 'getting_around', by: 'ZetTrans', title: 'Shetland by bus', href: 'https://www.zettrans.org.uk/travel/public-transport/bus', about: 'Bus travel information from the regional transport partnership.', verified_on: '2026-11-06', anchor: 'r-travel' },
  { slug: 'community-transport', topic: 'getting_around', by: 'Royal Voluntary Service', title: 'Shetland Community Transport', href: 'https://www.royalvoluntaryservice.org.uk/find-help-support/search/shetland-hub/shetland-community-transport-46407000/', about: 'Volunteer transport for people who find public transport difficult.', verified_on: '2026-11-06', anchor: 'r-travel' },
  { slug: 'shetlandorg-accessible', topic: 'visiting', by: 'Shetland.org', title: 'Accessible Shetland', href: 'https://www.shetland.org/visit/plan/getting-around/accessible-shetland', about: 'Visitor overview, including an accessible accommodation filter and borrowable all-terrain wheelchairs.', verified_on: '2026-11-06', anchor: 'r-visiting' },
  { slug: 'shetlandorg-toilets', topic: 'facilities', by: 'Shetland.org', title: 'Public toilets in Shetland', href: 'https://www.shetland.org/visit/plan/getting-around/public-toilets-in-shetland', about: 'An island-wide list of public toilets, including accessible ones.', verified_on: '2026-11-06', anchor: 'r-visiting' },
  { slug: 'shetlandorg-routes', topic: 'visiting', by: 'Shetland.org', title: 'All-terrain wheelchair routes', href: 'https://www.shetland.org/blog/all-terrain-wheelchair-accessible-routes-shetland', about: 'A blog post on routes suited to all-terrain wheelchairs.', verified_on: '2026-11-06', anchor: 'r-visiting' },
  { slug: 'museum-access', topic: 'visiting', by: 'Shetland Museum and Archives', title: 'Accessibility at Shetland Museum and Archives', href: 'https://www.shetlandmuseumandarchives.org.uk/visit/accessibility', about: 'Access information for the museum.', verified_on: '2026-11-06', anchor: 'r-visiting' },
  { slug: 'euans-guide', topic: 'visiting', by: "Euan's Guide", title: 'Shetland Islands on Euan’s Guide', href: 'https://www.euansguide.com/reviews/scotland/shetland-islands', about: 'Disabled-access reviews written by visitors.', verified_on: '2026-11-06', anchor: 'r-visiting' },
  { slug: 'changing-places', topic: 'facilities', by: 'Changing Places', title: 'Changing Places toilet finder', href: 'https://www.changing-places.org/find', about: 'A national map of Changing Places toilets.', verified_on: '2026-11-06', anchor: 'r-visiting' },
  { slug: 'blue-badge-apply', topic: 'information', by: 'Shetland Islands Council', title: 'Apply for a Blue Badge', href: 'https://www.shetland.gov.uk/transport/apply-blue-badge', about: 'How to apply in Shetland.', verified_on: '2026-11-06', anchor: 'r-support' },
  { slug: 'sic-adult-services', topic: 'support', by: 'Shetland Islands Council', title: 'Adults and older people', href: 'https://www.shetland.gov.uk/adults-older-people', about: "The council's adult social care services.", verified_on: '2026-11-06', anchor: 'r-support' },
  { slug: 'cab-shetland', topic: 'support', by: 'Citizens Advice', title: 'Shetland Islands Citizens Advice Bureau', href: 'https://www.shetlandcab.org.uk/', about: 'Free, impartial and confidential advice.', verified_on: '2026-11-06', anchor: 'r-support' },
  { slug: 'alzheimer-scotland', topic: 'support', by: 'Alzheimer Scotland', title: 'Shetland Brain Health and Dementia Resource Centre', href: 'https://www.alzscot.org/centre/shetland/', about: 'The local resource centre.', verified_on: '2026-11-06', anchor: 'r-support' },
  { slug: 'nhs-travel', topic: 'support', by: 'NHS Shetland', title: 'Travelling for care', href: 'https://www.nhsshetland.scot/travelling-care', about: 'Travelling to appointments, including travel help.', verified_on: '2026-11-06', anchor: 'r-support' },
  { slug: 'ability-shetland', topic: 'support', by: 'Disability Information Scotland', title: 'Ability Shetland', href: 'https://www.disabilityscot.org.uk/organisation/disability-shetland/', about: 'A directory entry for Ability Shetland, which lends equipment such as all-terrain wheelchairs.', verified_on: '2026-11-06', anchor: 'r-support' },
  { slug: 'blue-badge-rules', topic: 'information', by: 'mygov.scot', title: 'How to use a Blue Badge', href: 'https://www.mygov.scot/how-to-use-blue-badge', about: 'The rules for using a badge in Scotland.', verified_on: '2026-11-06', anchor: 'r-info' },
  { slug: 'mygov-bus', topic: 'information', by: 'mygov.scot', title: 'If you cannot get a bus', href: 'https://www.mygov.scot/transport-help/if-you-cannot-get-bus', about: 'Alternatives such as community transport.', verified_on: '2026-11-06', anchor: 'r-info' },
  { slug: 'visitbritain-islands', topic: 'visiting', by: 'VisitBritain', title: 'Accessible guide to the Scottish islands', href: 'https://www.visitbritain.com/en/plan-your-trip/accessible-britain/accessible-guide-scottish-islands', about: 'A general guide to accessible travel to the islands.', verified_on: '2026-11-06', anchor: 'r-info' },
];

const HOOKS: Record<AccessTopic, string> = {
  getting_here: 'Travelling to Shetland by ferry or air?',
  getting_around: 'Getting around Shetland?',
  visiting: 'Planning what to see and do in Shetland?',
  facilities: 'Looking for toilets and facilities while you are out and about?',
  support: 'Looking for local support and advice?',
  information: 'A handy piece of information to know before you go:',
};

/** Approved, unchanging awareness copy. Staff approve these once; they are the only awareness wording the recipe uses. */
export const AWARENESS_COPY: string[] = [
  `Planning a visit to Shetland, or looking for somewhere new to explore?\n\nAccessible Shetland brings together practical access information to help you make your own decisions about places to visit, activities to enjoy and facilities available.\n\nWe're building it with help from local businesses and the community. 💙\n\n{LINK}`,
  `Everyone plans a day out differently.\n\nAccessible Shetland gathers practical details about access, facilities and assistance in one place, shared by the places themselves and the organisations who know most, so you can decide what works for you.\n\nIt's growing as more businesses and groups add their details. 💙\n\n{LINK}`,
  `Know what to expect before you go.\n\nAccessible Shetland helps residents and visitors find practical information about steps, parking, toilets, quiet times and assistance, along with links to ferry, flight and visitor guides.\n\nMore is added as local businesses and organisations take part. 💙\n\n{LINK}`,
];

export type AccessFormat = 'awareness' | 'resource' | 'business';
const FORMATS: AccessFormat[] = ['awareness', 'resource', 'business'];
export const formatOfEntity = (id: string | null | undefined): AccessFormat | null => { const h = (id ?? '').split(':')[0]; return h === 'awareness' || h === 'resource' ? h : h === 'biz' ? 'business' : null; };

/** The format that follows the most recent one in the cycle awareness → resource → business. The first post is awareness. */
export function nextFormat(historyNewestFirst: { entity_id: string | null }[]): AccessFormat {
  const last = historyNewestFirst.map((h) => formatOfEntity(h.entity_id)).find((f): f is AccessFormat => !!f);
  return last ? FORMATS[(FORMATS.indexOf(last) + 1) % FORMATS.length] : 'awareness';
}

export type LinkCheck = { state: 'ok' | 'dead' | 'unknown'; status?: number };
/**
 * Is a public link still good? 404/410 = dead. A site that blocks automated requests (403, 429, 5xx, timeouts, DNS) is 'unknown', never 'dead':
 * the post is then held back for the next pass rather than published on faith or discarded on a hunch.
 */
export async function checkLink(url: string, fetchFn: typeof fetch = fetch): Promise<LinkCheck> {
  if (!/^https:\/\//i.test(url)) return { state: 'dead' };
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetchFn(url, { method, redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'OneShetland-link-check', ...(method === 'GET' ? { range: 'bytes=0-1023' } : {}) } });
      if (res.status >= 200 && res.status < 400) return { state: 'ok', status: res.status };
      if (res.status === 404 || res.status === 410) { if (method === 'GET') return { state: 'dead', status: res.status }; continue; }
      if (method === 'GET') return { state: 'unknown', status: res.status };
    } catch { if (method === 'GET') return { state: 'unknown' }; }
  }
  return { state: 'unknown' };
}

const daysAgo = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / DAY;

/** Least recently featured first; never-featured first; topic variety versus the most recent resource posts; stable weekly hash for ties. */
export function pickResource(history: { entity_id: string | null; created_at: string }[], cfg: Record<string, unknown>, now: Date, library: AccessResource[] = ACCESS_RESOURCES): AccessResource[] {
  const repeat = Number(cfg.repeat_resource_days ?? ACCESS_DEFAULTS.repeat_resource_days), maxAge = Number(cfg.max_resource_age_days ?? ACCESS_DEFAULTS.max_resource_age_days);
  const last = new Map<string, string>(); const recentTopics: AccessTopic[] = [];
  for (const h of history) { if (formatOfEntity(h.entity_id) !== 'resource') continue; const slug = (h.entity_id ?? '').split(':')[1]; if (slug && !last.has(slug)) last.set(slug, h.created_at); const r = library.find((x) => x.slug === slug); if (r && recentTopics.length < 2) recentTopics.push(r.topic); }
  return library
    .filter((r) => daysAgo(`${r.verified_on}T12:00:00Z`, now) <= maxAge)                          // a stale verification is not shown
    .filter((r) => !last.has(r.slug) || daysAgo(last.get(r.slug)!, now) >= repeat)
    .sort((a, b) => {
      const la = last.get(a.slug) ? new Date(last.get(a.slug)!).getTime() : 0, lb = last.get(b.slug) ? new Date(last.get(b.slug)!).getTime() : 0;
      if (la !== lb) return la - lb;
      const ta = recentTopics.includes(a.topic) ? 1 : 0, tb = recentTopics.includes(b.topic) ? 1 : 0;
      return ta - tb || hash(`${londonParts(now).ymd.slice(0, 7)}|${a.slug}`) - hash(`${londonParts(now).ymd.slice(0, 7)}|${b.slug}`);
    });
}

const norm = (x: string) => x.toLowerCase().replace(/[’']/g, "'");
export const resourceCaption = (r: AccessResource, link: string): string =>
  `${HOOKS[r.topic]}\n\n${r.title}${norm(r.title).includes(norm(r.by)) ? '' : `, from ${r.by}`}. ${r.about}\n\nAccessible Shetland brings links like this together so you can plan on your own terms: ${link}\n\nSource: ${r.by} (${r.href})`;
export const resourceAlt = (r: AccessResource) => `OneShetland card: ${r.title}${norm(r.title).includes(norm(r.by)) ? '' : `, from ${r.by}`}, shared through Accessible Shetland.`;

/* ── Business access information ───────────────────────────────────────────────────────────────────────────── */

export const FACILITY_LABEL: Record<string, string> = {
  step_free_entrance: 'a step-free entrance', ramp: 'a ramp', lift: 'a lift', automatic_door: 'an automatic or push-button door', wide_doors: 'wide doorways', level_inside: 'level floors inside', space_to_move: 'space to move around',
  accessible_parking: 'accessible parking', drop_off: 'a drop-off point close to the entrance', accessible_toilet: 'an accessible toilet', changing_places: 'a Changing Places toilet', wheelchair_seating: 'wheelchair space or seating',
  seating_available: 'seating', hearing_loop: 'a hearing loop', communication_support: 'communication support', large_print_or_easy_read: 'large print or Easy Read information', visual_support: 'support for people with sight loss',
  quiet_space: 'a quiet space', quiet_times: 'quieter times', sensory_friendly: 'sensory-friendly options', assistance_dogs_welcome: 'assistance dogs welcome', staff_assistance: 'staff who can help',
  companion_or_carer: 'carer or companion arrangements', equipment_available: 'equipment to borrow or hire',
};
export type AccessFact = { facility: string; status: 'available' | 'partial' | 'not_available' | 'not_known' };
export type AccessProfile = { subject_id: string; verification: 'owner_provided' | 'official_source' | 'independently_checked'; verified_on: string | null; updated_at: string };

/** A stable fingerprint of exactly what a caption says, so a later edit (or a staff verification change) invalidates a drafted post. */
export const factsHash = (p: Pick<AccessProfile, 'verification'>, facts: AccessFact[]): string =>
  hash(`${p.verification}|${facts.filter((f) => f.status === 'available' || f.status === 'partial').map((f) => `${f.facility}:${f.status}`).sort().join(',')}`).toString(36);

export function provenanceSentence(p: Pick<AccessProfile, 'verification' | 'verified_on'>): string {
  if (p.verification === 'independently_checked' && p.verified_on) return `These details were independently checked on ${p.verified_on.split('-').reverse().join('/')}.`;
  if (p.verification === 'official_source') return 'These details come from an official source.';
  return "These details were provided by the business and haven't been independently checked.";
}

/** What the caption says: only facilities answered Yes or Partly, in plain words. "No" and "not sure" are never turned into claims. */
export function businessCaption(name: string, facts: AccessFact[], p: Pick<AccessProfile, 'verification' | 'verified_on'>, link: string): string {
  const yes = facts.filter((f) => f.status === 'available' && FACILITY_LABEL[f.facility]).map((f) => FACILITY_LABEL[f.facility]);
  const partly = facts.filter((f) => f.status === 'partial' && FACILITY_LABEL[f.facility]).map((f) => FACILITY_LABEL[f.facility]);
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const said = [yes.length ? `${list(yes.slice(0, 5))}` : '', partly.length ? `partly: ${list(partly.slice(0, 3))}` : ''].filter(Boolean).join('; ');
  return `${name.trim()} has shared information about access and facilities to help people plan a visit.\n\nThey've told us about ${said}.\n\n${provenanceSentence(p)}\n\nSee their details, and decide what works for you: ${link}\n\nSharing access information is voluntary, and it isn't a certification or an endorsement. 💙`;
}
export const businessAlt = (name: string) => `OneShetland card: access information shared by ${name} on Accessible Shetland.`;

export type AccessReport = { at: string; format: AccessFormat | null; tried: AccessFormat[]; reason?: string; chosen?: { id: string; label: string }; pool?: { businesses: number; withEnoughDetail: number; resources: number } };

export async function selectAccessible(svc: Svc, cfg: Record<string, unknown>, now: Date, fetchFn: typeof fetch = fetch): Promise<{ candidate: Candidate | null; report: AccessReport; imageAlt?: string }> {
  const report: AccessReport = { at: now.toISOString(), format: null, tried: [] };
  const { data: hist } = await svc.from('social_posts').select('entity_id,created_at,status,link_url').eq('kind', 'accessible_info').in('status', ['posted', 'scheduled', 'approved', 'draft']).order('created_at', { ascending: false }).limit(60);
  const history = (hist ?? []) as { entity_id: string | null; created_at: string; status: string; link_url: string | null }[];
  const first = nextFormat(history);
  const order: AccessFormat[] = first === 'business' ? ['business', 'resource', 'awareness'] : first === 'resource' ? ['resource', 'awareness'] : ['awareness', 'resource'];
  const ymd = londonParts(now).ymd;
  for (const f of order) {
    report.tried.push(f);
    if (f === 'awareness') {
      const used = history.filter((h) => formatOfEntity(h.entity_id) === 'awareness');
      const lastVariant = new Map<number, string>(); for (const h of used) { const v = Number((h.entity_id ?? '').split(':')[1]?.replace('v', '')); if (!lastVariant.has(v)) lastVariant.set(v, h.created_at); }
      const free = AWARENESS_COPY.map((_, i) => i).filter((i) => !lastVariant.has(i) || daysAgo(lastVariant.get(i)!, now) >= 120).sort((a, b) => (lastVariant.has(a) ? 1 : 0) - (lastVariant.has(b) ? 1 : 0) || a - b);
      if (!free.length) continue;
      const v = free[0]; const link = go('accessible');
      report.format = 'awareness'; report.chosen = { id: `v${v}`, label: `awareness copy ${v + 1}` };
      return { candidate: { kind: 'accessible_info', entity_type: 'awareness', entity_id: `awareness:v${v}:${ymd}`, caption: AWARENESS_COPY[v].replace('{LINK}', link), image_url: `${SITE}/api/social-image?kind=access&format=awareness&v=${v}`, link_url: link, context: 'Accessible Shetland awareness.', note: `awareness copy ${v + 1}` }, report, imageAlt: 'OneShetland card: Accessible Shetland, practical access information for planning a visit.' };
    }
    if (f === 'resource') {
      const approved = new Set(((cfg.approved_resources as string[] | undefined) ?? []).map(String));
      const pool = pickResource(history, cfg, now);
      report.pool = { ...(report.pool ?? { businesses: 0, withEnoughDetail: 0 }), resources: pool.length };
      for (const r of pool.slice(0, 3)) {
        const c = await checkLink(r.href, fetchFn);
        if (c.state !== 'ok') continue;                                   // dead or unverifiable right now: try the next, never publish on faith
        const link = `${go('accessible')}#${r.anchor}`;
        const needsApproval = !approved.has(r.slug);
        report.format = 'resource'; report.chosen = { id: r.slug, label: `${r.title} (${r.by})` };
        return { candidate: { kind: 'accessible_info', entity_type: 'resource', entity_id: `resource:${r.slug}:${ymd}`, caption: resourceCaption(r, link), image_url: `${SITE}/api/social-image?kind=access&format=resource&slug=${r.slug}`, link_url: link, context: 'Accessible Shetland resource spotlight.',
          needsApproval, note: needsApproval ? `${HELD_PREFIX}: this resource has not been approved for automatic posting` : 'approved resource' }, report, imageAlt: resourceAlt(r) };
      }
      continue;
    }
    // business access information: always reviewed by staff unless the recipe says otherwise
    const found = await selectBusinessAccess(svc, cfg, now, history);
    report.pool = { ...(report.pool ?? { resources: 0 }), businesses: found.published, withEnoughDetail: found.eligible };
    if (found.pick) {
      const p = found.pick; const link = go(`business/${p.id}`);
      report.format = 'business'; report.chosen = { id: p.id, label: p.name };
      return { candidate: { kind: 'accessible_info', entity_type: 'business', entity_id: `biz:${p.id}:${ymd}`, business_id: p.id, caption: businessCaption(p.name, p.facts, p.profile, link), image_url: `${SITE}/api/social-image?kind=access&format=business&id=${p.id}`,
        link_url: `${link}#h=${factsHash(p.profile, p.facts)}`, context: `Accessible Shetland business access information: "${p.name}".`, needsApproval: cfg.business_requires_review !== false, note: `${HELD_PREFIX}: business access information is reviewed by staff before posting` }, report, imageAlt: businessAlt(p.name) };
    }
  }
  report.reason = 'nothing worthwhile to post: no eligible business access information, no verified resource, and no unused awareness copy';
  return { candidate: null, report };
}

type BizPick = { id: string; name: string; profile: AccessProfile; facts: AccessFact[] };
/** Published, not hidden by staff, claimed-business access information with enough detail, fairly rotated. Owner notes and free-text details are never read. */
export async function selectBusinessAccess(svc: Svc, cfg: Record<string, unknown>, now: Date, history: { entity_id: string | null; created_at: string }[]): Promise<{ pick: BizPick | null; published: number; eligible: number }> {
  const { data: profs, error } = await svc.from('accessibility_profiles').select('subject_id,published,hidden_by_staff,verification,verified_on,updated_at').eq('subject_type', 'business').eq('published', true).eq('hidden_by_staff', false).limit(500);
  if (error) throw error;
  const profiles = (profs ?? []) as (AccessProfile & { published: boolean; hidden_by_staff: boolean })[];
  if (!profiles.length) return { pick: null, published: 0, eligible: 0 };
  const ids = profiles.map((p) => p.subject_id);
  const [biz, facts, perms] = await Promise.all([
    svc.from('local_businesses').select('id,name,is_active').in('id', ids),
    svc.from('accessibility_facts').select('subject_id,facility,status').eq('subject_type', 'business').in('subject_id', ids).limit(ids.length * 30),
    svc.from('social_promotion_permissions').select('entity_id,allowed').eq('entity_type', 'business'),
  ]);
  const optedOut = new Set(((perms.data ?? []) as { entity_id: string; allowed: boolean }[]).filter((p) => !p.allowed).map((p) => p.entity_id));
  const names = new Map(((biz.data ?? []) as { id: string; name: string; is_active: boolean }[]).filter((b) => b.is_active && !isFixtureName(b.name)).map((b) => [b.id, b.name]));
  const byBiz = new Map<string, AccessFact[]>();
  for (const f of (facts.data ?? []) as (AccessFact & { subject_id: string })[]) (byBiz.get(f.subject_id) ?? byBiz.set(f.subject_id, []).get(f.subject_id)!).push({ facility: f.facility, status: f.status });
  const minFacts = Number(cfg.min_facts ?? ACCESS_DEFAULTS.min_facts), repeat = Number(cfg.repeat_business_days ?? ACCESS_DEFAULTS.repeat_business_days);
  const lastFeatured = new Map<string, string>(); for (const h of history) if (formatOfEntity(h.entity_id) === 'business') { const id = (h.entity_id ?? '').split(':')[1]; if (id && !lastFeatured.has(id)) lastFeatured.set(id, h.created_at); }
  const eligible = profiles.filter((p) => names.has(p.subject_id) && !optedOut.has(p.subject_id) && (byBiz.get(p.subject_id) ?? []).filter((f) => (f.status === 'available' || f.status === 'partial') && FACILITY_LABEL[f.facility]).length >= minFacts
    && (!lastFeatured.has(p.subject_id) || daysAgo(lastFeatured.get(p.subject_id)!, now) >= repeat));
  eligible.sort((a, b) => {
    const la = lastFeatured.get(a.subject_id) ? new Date(lastFeatured.get(a.subject_id)!).getTime() : 0, lb = lastFeatured.get(b.subject_id) ? new Date(lastFeatured.get(b.subject_id)!).getTime() : 0;
    return la - lb || hash(`${londonParts(now).ymd}|${a.subject_id}`) - hash(`${londonParts(now).ymd}|${b.subject_id}`);
  });
  for (const p of eligible.slice(0, 6)) {
    const hidden = await svc.rpc('is_discovery_hidden', { p_entity: 'business', p_id: p.subject_id });
    if (hidden.data === true) continue;
    return { pick: { id: p.subject_id, name: names.get(p.subject_id)!, profile: p, facts: byBiz.get(p.subject_id)! }, published: profiles.length, eligible: eligible.length };
  }
  return { pick: null, published: profiles.length, eligible: eligible.length };
}

/** Publish-time check for an Accessible Shetland post. */
export async function revalidateAccessible(svc: Svc, post: { entity_id: string | null; link_url?: string | null }, now: Date, fetchFn: typeof fetch = fetch): Promise<{ state: 'valid' | 'invalid' | 'unknown'; reason?: string }> {
  const [head, key] = (post.entity_id ?? '').split(':');
  if (head === 'awareness') return AWARENESS_COPY[Number(key?.replace('v', ''))] ? { state: 'valid' } : { state: 'invalid', reason: 'unknown awareness copy' };
  if (head === 'resource') {
    const r = ACCESS_RESOURCES.find((x) => x.slug === key);
    if (!r) return { state: 'invalid', reason: 'resource is no longer in the approved library' };
    if (daysAgo(`${r.verified_on}T12:00:00Z`, now) > 180) return { state: 'invalid', reason: 'the resource has not been re-verified recently' };
    const c = await checkLink(r.href, fetchFn);
    return c.state === 'ok' ? { state: 'valid' } : c.state === 'dead' ? { state: 'invalid', reason: `the resource link no longer works (${c.status ?? 'invalid'})` } : { state: 'unknown' };
  }
  if (head === 'biz') {
    const { data: p, error } = await svc.from('accessibility_profiles').select('subject_id,published,hidden_by_staff,verification,verified_on').eq('subject_type', 'business').eq('subject_id', key).maybeSingle();
    if (error) return { state: 'unknown' };
    if (!p || !p.published || p.hidden_by_staff) return { state: 'invalid', reason: 'the business access information is no longer published' };
    const [{ data: b }, { data: f }, { data: perm }, hid] = await Promise.all([
      svc.from('local_businesses').select('is_active').eq('id', key).maybeSingle(),
      svc.from('accessibility_facts').select('facility,status').eq('subject_type', 'business').eq('subject_id', key).limit(60),
      svc.from('social_promotion_permissions').select('allowed').eq('entity_type', 'business').eq('entity_id', key).maybeSingle(),
      svc.rpc('is_discovery_hidden', { p_entity: 'business', p_id: key }),
    ]);
    if (!b?.is_active || hid.data === true || perm?.allowed === false) return { state: 'invalid', reason: 'the business is no longer promotable' };
    const want = /#h=([a-z0-9]+)/.exec(post.link_url ?? '')?.[1];
    if (want && want !== factsHash(p, (f ?? []) as AccessFact[])) return { state: 'invalid', reason: 'the business changed its access details after this post was drafted' };
    return { state: 'valid' };
  }
  return { state: 'invalid', reason: 'unrecognised accessible_info post' };
}
