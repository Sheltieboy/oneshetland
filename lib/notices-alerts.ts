/**
 * notices-alerts.ts — pure view-model logic for the Notices & Alerts system (no imports, so it runs in the app and under `node --test`).
 *
 * The database is the authority (docs/notices-alerts-contract.md): get_essential_alerts / get_public_notices decide what is public, who
 * published it and whether it is an active Essential Alert. This file only
 *   - maps an RPC row to the shape the screens draw (and adapts the RPC `publisher` object; lib/notice-publisher.ts is NOT used for these rows),
 *   - decides a notice's destination (campaign > event > hub > business > none),
 *   - turns the screen's filter state into RPC arguments (area semantics: null = unfiltered, [] = Shetland-wide only, list = those areas),
 *   - composes Home (Essential slot + at most six equal cards, essential never repeated in the grid).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type PublisherKind = 'hub' | 'business' | 'person' | 'platform' | 'official';
export type NoticeLevel = 'essential' | 'official' | 'community';
/** Which identity mark to draw when there is no logo. */
export type AttributionMark = 'hub' | 'business' | 'person' | 'platform' | 'official-source' | 'official';

/** The authoritative `publisher` object returned by get_public_notices / get_essential_alerts. */
export type RpcPublisher = {
  kind?: string | null; label?: string | null; byline?: string | null;
  is_official_source?: boolean | null; source_label?: string | null; source_url?: string | null;
};

export type NoticeAttribution = {
  kind: PublisherKind;
  label: string;
  byline: string;
  is_official_source: boolean;
  source_label: string | null;
  /** Only ever a valid https URL. */
  source_url: string | null;
  logo_url: string | null;
  brand_color: string | null;
  mark: AttributionMark;
};

export type NoticeDestinationType = 'campaign' | 'event' | 'hub' | 'business';
export type NoticeDestination = {
  type: NoticeDestinationType;
  id: string;
  /** expo-router target: `router.push({ pathname, params })`. */
  route: { pathname: string; params: Record<string, string> };
};

export type NoticeModel = {
  id: string;
  title: string;
  body: string;
  actionText: string | null;
  severity: string | null;
  category: string | null;
  categoryLabel: string | null;
  publishedAt: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  reviewAt: string | null;
  /** Only ever a valid https URL. */
  linkUrl: string | null;
  level: NoticeLevel;
  /** True only for an ACTIVE Essential Alert (the server decides). */
  isEssential: boolean;
  attribution: NoticeAttribution;
  areaIds: string[];
  areaNames: string[];
  hubId: string | null;
  businessId: string | null;
  eventId: string | null;
  campaignId: string | null;
  imageUrl: string | null;
  destination: NoticeDestination | null;
};

// ── Small guards ─────────────────────────────────────────────────────────────

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** https only: a link that is not plain https is never shown as a link (contract: "valid https"). */
export function httpsUrl(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === 'https:' && !!u.hostname ? u.toString() : null; } catch { return null; }
}

function hexColour(v: unknown): string | null {
  const s = clean(v);
  return s && /^#?[0-9a-fA-F]{6}$/.test(s) ? (s.startsWith('#') ? s : `#${s}`) : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

// ── Attribution adapter ──────────────────────────────────────────────────────

const KINDS: readonly string[] = ['hub', 'business', 'person', 'platform', 'official'];

type PublisherContext = {
  publisher_hub_id?: string | null; publisher_business_id?: string | null;
  publisher_logo_url?: string | null; publisher_brand_color?: string | null;
};

/**
 * RPC `publisher` -> what the screens show. The label and byline are the database's ("Posted by Voe Hall", "Issued by …",
 * "Source: …", "A OneShetland member"); the fallbacks below only apply to a malformed row and never invent a person or an organisation.
 * "Member" on its own is never shown.
 */
export function adaptPublisher(pub: RpcPublisher | null | undefined, ctx: PublisherContext = {}): NoticeAttribution {
  const p = pub ?? {};
  const given = clean(p.kind);
  const kind: PublisherKind = given && KINDS.includes(given) ? (given as PublisherKind)
    : ctx.publisher_hub_id ? 'hub' : ctx.publisher_business_id ? 'business' : 'platform';
  const isSource = p.is_official_source === true;
  let label = clean(p.label);
  if (label && label.toLowerCase() === 'member') label = null;
  if (!label) {
    label = kind === 'hub' ? 'Community hub' : kind === 'business' ? 'Local business' : kind === 'person' ? 'A OneShetland member'
      : kind === 'official' ? 'Official organisation' : isSource ? (clean(p.source_label) ?? 'Official source') : 'OneShetland';
  }
  let byline = clean(p.byline);
  if (!byline) {
    byline = kind === 'official' ? `Issued by ${label}` : kind === 'platform' ? (isSource ? `Source: ${label}` : 'Posted by OneShetland') : `Posted by ${label}`;
  }
  const mark: AttributionMark = kind === 'official' ? 'official' : kind === 'platform' ? (isSource ? 'official-source' : 'platform') : kind;
  const branded = kind === 'hub' || kind === 'business';
  return {
    kind, label, byline,
    is_official_source: isSource || kind === 'official',
    source_label: clean(p.source_label),
    source_url: httpsUrl(p.source_url),
    logo_url: branded ? httpsUrl(ctx.publisher_logo_url) : null,
    brand_color: branded ? hexColour(ctx.publisher_brand_color) : null,
    mark,
  };
}

// ── Destination: campaign > event > hub > business > none ───────────────────

export type DestinationInput = {
  campaignId: string | null; eventId: string | null; hubId: string | null; businessId: string | null; kind: PublisherKind;
};

/**
 * A notice opens ONE real place or nothing. Order (approved): its fundraiser campaign, then its EVENT (previously an event notice opened
 * its hub), then the publishing hub, then the publishing business. A person, OneShetland, an import or a verified organisation has no page,
 * so such a notice is a plain block. An event only counts when its id is a real uuid (the screen it opens fetches by id).
 */
export function resolveDestination(d: DestinationInput): NoticeDestination | null {
  const campaign = clean(d.campaignId);
  if (campaign) return { type: 'campaign', id: campaign, route: { pathname: '/hub-campaign', params: { id: campaign } } };
  const event = clean(d.eventId);
  if (event && UUID.test(event)) return { type: 'event', id: event, route: { pathname: '/events/[id]', params: { id: event } } };
  const hub = d.kind === 'hub' ? clean(d.hubId) : null;
  if (hub) return { type: 'hub', id: hub, route: { pathname: '/hubs/[id]', params: { id: hub } } };
  const biz = d.kind === 'business' ? clean(d.businessId) : null;
  if (biz) return { type: 'business', id: biz, route: { pathname: '/local-business-detail', params: { id: biz } } };
  return null;
}

// ── Row -> model ─────────────────────────────────────────────────────────────

export function mapNoticeRow(row: Record<string, any>): NoticeModel {
  const attribution = adaptPublisher(row.publisher, row);
  const level: NoticeLevel = row.level === 'essential' || row.level === 'official' ? row.level : 'community';
  const isEssential = row.is_essential_active === true || (row.level === 'essential' && row.is_essential_active !== false);
  const hubId = clean(row.publisher_hub_id), businessId = clean(row.publisher_business_id);
  const eventId = clean(row.event_id), campaignId = clean(row.campaign_id);
  return {
    id: String(row.id),
    title: clean(row.title) ?? 'Notice',
    body: typeof row.body === 'string' ? row.body : '',
    actionText: clean(row.action_text),
    severity: clean(row.severity),
    category: clean(row.category),
    categoryLabel: clean(row.category_label),
    publishedAt: clean(row.published_at),
    startsAt: clean(row.starts_at),
    expiresAt: clean(row.expires_at),
    reviewAt: clean(row.review_at),
    linkUrl: httpsUrl(row.link_url),
    level, isEssential, attribution,
    areaIds: strings(row.area_ids),
    areaNames: strings(row.area_names),
    hubId, businessId, eventId, campaignId,
    imageUrl: httpsUrl(row.image_url),
    destination: resolveDestination({ campaignId, eventId, hubId, businessId, kind: attribution.kind }),
  };
}

/** get_essential_alerts rows carry no `level` column: every row is an active essential alert by definition. */
export function mapEssentialRow(row: Record<string, any>): NoticeModel {
  return mapNoticeRow({ ...row, level: 'essential', is_essential_active: true });
}

export function mapRows(rows: unknown, mapper: (r: Record<string, any>) => NoticeModel = mapNoticeRow): NoticeModel[] {
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object' && r.id).map(mapper) : [];
}

// ── Areas ────────────────────────────────────────────────────────────────────

export type AreaScope = { mode: 'all' } | { mode: 'mine' } | { mode: 'area'; areaId: string };

/**
 * p_area_ids semantics (contract): null = unfiltered; [] = Shetland-wide notices only; a list = those areas (and anything inside or containing
 * them) plus Shetland-wide. "My areas" with no areas saved therefore means Shetland-wide only, never "everything".
 */
export function areaArgs(scope: AreaScope, myAreas: string[] | null | undefined): string[] | null {
  if (scope.mode === 'all') return null;
  if (scope.mode === 'area') return [scope.areaId];
  return Array.isArray(myAreas) ? [...myAreas] : [];
}

/**
 * Home's own area argument. A member with areas sees alerts for those areas; a signed-out visitor or a member who has chosen no areas sees
 * everything (null): hiding an island-wide road closure from someone because they never picked an area would be the unsafe default.
 */
export function homeAreaArgs(myAreas: string[] | null | undefined): string[] | null {
  return Array.isArray(myAreas) && myAreas.length > 0 ? [...myAreas] : null;
}

/** "Voe, Brae +2" - first two names, then a count. Empty when the notice names no area. */
export function areaSummary(names: string[], show = 2): string {
  const n = names.filter(Boolean);
  if (n.length === 0) return '';
  return n.length <= show ? n.join(', ') : `${n.slice(0, show).join(', ')} +${n.length - show}`;
}

// ── Time ─────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Just now", "12 min ago", "3 h ago", "2 d ago", then "12 Oct 2026". */
export function formatNoticeTime(iso: string | null, now: Date | number = new Date()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = new Date(now).getTime() - t;
  if (diff < 0) return formatDate(new Date(t));
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d} d ago` : formatDate(new Date(t));
}
function formatDate(d: Date): string { return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }

// ── Filters and pagination ───────────────────────────────────────────────────

export type NoticeTab = 'all' | 'essential' | 'official' | 'community' | 'funeral';
export const NOTICE_TABS: { key: NoticeTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'essential', label: 'Essential alerts' },
  { key: 'official', label: 'Health & official' },
  { key: 'community', label: 'Community' },
  { key: 'funeral', label: 'Deaths & funeral' },
];
export const PAGE_SIZE = 20;

export type FilterState = { tab: NoticeTab; scope: AreaScope; category: string | null };
export const INITIAL_FILTER: FilterState = { tab: 'all', scope: { mode: 'all' }, category: null };

export type FilterAction =
  | { type: 'tab'; tab: NoticeTab }
  | { type: 'scope'; scope: AreaScope }
  | { type: 'category'; category: string | null };

/** The funeral list has no category, so leaving it for another tab or entering it clears the category. */
export function reduceFilter(s: FilterState, a: FilterAction): FilterState {
  if (a.type === 'tab') return { ...s, tab: a.tab, category: a.tab === 'funeral' ? null : s.category };
  if (a.type === 'scope') return { ...s, scope: a.scope };
  return s.tab === 'funeral' ? s : { ...s, category: a.category };
}

export function levelForTab(tab: NoticeTab): 'all' | 'essential' | 'official' | 'community' {
  return tab === 'funeral' ? 'all' : tab;
}

export type NoticeQuery =
  | { fn: 'get_public_notices'; args: { p_level: string; p_area_ids: string[] | null; p_category: string | null; p_limit: number; p_offset: number } }
  | { fn: 'get_funeral_notices'; args: { p_area_ids: string[] | null; p_limit: number; p_offset: number } };

export function buildQuery(state: FilterState, myAreas: string[] | null | undefined, offset = 0, limit = PAGE_SIZE): NoticeQuery {
  const p_area_ids = areaArgs(state.scope, myAreas);
  if (state.tab === 'funeral') return { fn: 'get_funeral_notices', args: { p_area_ids, p_limit: limit, p_offset: offset } };
  return { fn: 'get_public_notices', args: { p_level: levelForTab(state.tab), p_area_ids, p_category: state.category, p_limit: limit, p_offset: offset } };
}

/** Appends a page without repeating a row the server returned twice across pages; `hasMore` is true while a page came back full. */
export function appendPage<T extends { id: string }>(prev: T[], incoming: T[], pageSize = PAGE_SIZE): { items: T[]; hasMore: boolean } {
  const seen = new Set(prev.map((x) => x.id));
  return { items: [...prev, ...incoming.filter((x) => !seen.has(x.id))], hasMore: incoming.length >= pageSize };
}

/** Distinct categories present in the rows already loaded, for the chip row when the category list could not be fetched. */
export function categoriesFrom(models: NoticeModel[]): { id: string; label: string }[] {
  const m = new Map<string, string>();
  for (const n of models) if (n.category && !m.has(n.category)) m.set(n.category, n.categoryLabel ?? n.category);
  return [...m].map(([id, label]) => ({ id, label }));
}

// ── Home composition ─────────────────────────────────────────────────────────

export const HOME_CARD_MAX = 6;

export type HomeComposition = {
  /** Active essential alerts for the reserved top slot; [] means the slot renders nothing and leaves no gap. */
  essential: NoticeModel[];
  showEssential: boolean;
  /** At most six, newest first, never an active essential alert. */
  cards: NoticeModel[];
};

const time = (n: NoticeModel) => (n.publishedAt ? new Date(n.publishedAt).getTime() || 0 : 0);

/**
 * Essential alerts live ONLY in the top slot (from get_essential_alerts). The card grid is get_public_notices('all') minus every active
 * essential alert (by flag, level or id), newest first, capped at six.
 */
export function composeHome(essential: NoticeModel[], notices: NoticeModel[], max = HOME_CARD_MAX): HomeComposition {
  const slotIds = new Set(essential.map((e) => e.id));
  const cards = notices
    .filter((n) => !n.isEssential && n.level !== 'essential' && !slotIds.has(n.id))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => time(b.n) - time(a.n) || a.i - b.i)
    .map((x) => x.n)
    .slice(0, max);
  return { essential, showEssential: essential.length > 0, cards };
}

/**
 * Precedence of what can claim the top of Home (one coherent order):
 *   1. Essential Alert (get_essential_alerts)      - the only red/urgent treatment, the only thing in the reserved slot.
 *   2. nothing else competes for that position.
 * Below the fold: the calm "Update from <business>" strip (partner_alerts), then the notice cards. The old `severity = 'urgent'` header chip
 * and the floating emergency-coloured AlertPill no longer claim the top.
 */
export const HOME_TOP_ORDER = ['essential-alert'] as const;

/** A partner alert is a business's own update: calm wording, never emergency wording. */
export function partnerStripText(a: { business_name?: string | null; message?: string | null }): { who: string; text: string } {
  return { who: `Update from ${clean(a.business_name) ?? 'a local business'}`, text: clean(a.message) ?? '' };
}
