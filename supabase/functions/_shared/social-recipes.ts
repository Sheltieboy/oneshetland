/**
 * social-recipes — the seven newer Social Studio recipes, as plain functions the composer and the publisher both call.
 *
 *   notice_update · essential_alert · aald_memory · business_spotlight · hub_community · game_challenge · cruise_visit
 *
 * Why a shared module: (1) the selection / freshness / safety rules are pure functions a test can run, and (2) the publisher
 * re-asks `revalidatePost` immediately before sending, because a draft can sit in the queue for days and the thing it
 * describes may have expired, been withdrawn, or lost its permission by then.
 *
 * Nothing here publishes. composeNewRecipes only INSERTS rows into social_posts (draft, or 'scheduled' when a recipe's autopilot
 * is on — never for essential_alert). The publisher is unchanged apart from calling revalidatePost for these kinds.
 *
 * No Deno-only globals at module scope, so it also runs under node:test with a mocked client.
 */

import { selectRoundup, selectAccessible, revalidateRoundup, revalidateAccessible, formatOfEntity } from './social-regular-access.ts';

export const SITE = 'https://oneshetland.com';

/** Defaults for the two newest recipes. Kept here (not in social-regular-access.ts) so neither module needs the other at load time. */
export const REGULAR_DEFAULTS = { hour: 18, weekdays: ['Sat', 'Sun'], max_per_run: 1, max_pending: 2, max_items: 6, max_per_organiser: 2, lookback_weeks: 8, max_regenerations: 2 };
export const ACCESS_DEFAULTS = { hour: 14, weekdays: ['Wed'], max_per_run: 1, max_pending: 2, min_days_between: 13, business_requires_review: true, min_facts: 3, repeat_business_days: 90, repeat_resource_days: 120, max_resource_age_days: 180, approved_resources: [] as string[] };
export const go = (slug: string) => `${SITE}/go/${slug}`;

/** The five original recipes whose posts are also re-checked at send time (their ids ride in link_url#ids=, or the entity id). */
export const ORIGINAL_REVALIDATED = ['jobs_roundup', 'whats_on_roundup', 'event_spotlight', 'new_product'] as const;

export const NEW_KINDS = ['essential_alert', 'notice_update', 'cruise_visit', 'aald_memory', 'business_spotlight', 'hub_community', 'game_challenge', 'regular_roundup', 'accessible_info'] as const;
export type NewKind = typeof NEW_KINDS[number];
/** Kinds the publisher re-checks just before sending. */
export const REVALIDATED_KINDS = new Set<string>([...NEW_KINDS, ...ORIGINAL_REVALIDATED]);
/** Kinds whose caption states facts, so the AI "warm-up" is never applied (it could soften or embellish). */
const FACTUAL: ReadonlySet<string> = new Set(['essential_alert', 'notice_update', 'cruise_visit', 'regular_roundup', 'accessible_info']);

/* ── Defaults (the migration seeds the same values into social_recipes.config) ─────────────────────────────────── */

export const DEFAULTS: Record<NewKind, Record<string, unknown>> = {
  essential_alert:    { max_per_run: 1, min_hours_between: 6, min_remaining_hours: 2, max_pending: 2 },
  notice_update:      { hour: 12, max_per_run: 1, max_per_week: 4, max_age_days: 7, min_remaining_hours: 24, max_pending: 3, include_person: false },
  cruise_visit:       { hour: 8, max_per_run: 1, lead_days: 3, max_pending: 2, max_verified_age_days: 365 },
  aald_memory:        { hour: 19, weekdays: ['Mon', 'Wed', 'Sat'], max_per_run: 1, max_pending: 3, min_body_chars: 80 },
  business_spotlight: { hour: 13, weekdays: ['Mon', 'Tue', 'Thu', 'Fri'], max_per_run: 1, max_pending: 3, min_description_chars: 60, min_description_words: 8, repeat_after_days: 90, welcome_days: 14, welcome_max_consecutive: 2, skipped_cooloff_days: 7, failed_cooloff_days: 2 },
  hub_community:      { hour: 10, weekdays: ['Wed', 'Sat'], max_per_run: 1, max_pending: 2, min_description_chars: 40, repeat_after_days: 30 },
  game_challenge:     { hour: 17, weekdays: ['Thu', 'Sun'], max_per_run: 1, max_pending: 2, games: ['guess_da_wird', 'spik_sprint', 'spik_snap', 'map_it'] },
  regular_roundup:    { ...REGULAR_DEFAULTS },
  accessible_info:    { ...ACCESS_DEFAULTS },
};
/** Order matters: an alert is considered first so it gets the earliest free slot. Autopilot content that will really be published (notices, business
 *  spotlights) now comes BEFORE the review-only recipes (Aald Memories, Hubs), whose drafts still reserve slots until a person looks at them. */
const ORDER: NewKind[] = ['essential_alert', 'notice_update', 'cruise_visit', 'business_spotlight', 'regular_roundup', 'accessible_info', 'aald_memory', 'hub_community', 'game_challenge'];

export type Candidate = {
  kind: NewKind;
  entity_type: string;
  entity_id: string;
  business_id?: string | null;
  caption: string;
  image_url: string | null;
  link_url: string;
  context: string;
  /** Held as a DRAFT for a human to approve even when the recipe's autopilot is on (sensitive subject matter). */
  needsApproval?: boolean;
  /** Why it is held / which rotation lane chose it (shown to admins). */
  note?: string;
  /** Alt text for the image where the channel supports it (Facebook photo posts). */
  imageAlt?: string;
};

/** Upper bound on candidates a selector builds per run (each may cost a lookup); a run posts at most a day's worth anyway. */
const MAX_CANDIDATES = 8;

type Svc = any;   // the Supabase service client; typed loosely so the test can pass a mock

/* ── Europe/London time ────────────────────────────────────────────────────────────────────────────────────────── */

export const londonParts = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')), weekday: get('weekday') };
};

/** The instant at which London wall-clock reads `ymd hour:minute`. DST-safe (two-step offset correction). */
export function londonInstant(ymd: string, hour: number, minute = 0): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  for (let i = 0; i < 2; i++) {
    const lp = londonParts(guess);
    const [ly, lm, ld] = lp.ymd.split('-').map(Number);
    const diff = (Date.UTC(y, m - 1, d, hour, minute) - Date.UTC(ly, lm - 1, ld, lp.hour, lp.minute));
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

const addDays = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

export const isoWeekKey = (d: Date): string => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7)).padStart(2, '0')}`;
};

/* ── Spacing: one allocator for every new recipe ───────────────────────────────────────────────────────────────── */

export type SlotOpts = {
  now: Date;
  /** Preferred London hour; null = as soon as allowed (alerts). */
  preferredHour: number | null;
  /** scheduled_for of every post already queued or posted around now (old recipes included). */
  taken: Date[];
  gapMinutes: number;
  maxPerDay: number;
  windowStartHour: number;
  windowEndHour: number;
  horizonDays: number;
  /** Earliest allowed lead time after `now`, minutes. */
  leadMinutes?: number;
  /** [0,1) — injected so tests are deterministic. */
  rand?: () => number;
  /** London dates (YYYY-MM-DD) this post must not land on (e.g. a day that already has a Business Spotlight). */
  excludeDays?: ReadonlySet<string>;
};

export function allocateSlot(o: SlotOpts): Date | null {
  const lead = o.leadMinutes ?? 30;
  const earliest = o.now.getTime() + lead * 60_000;
  const todayYmd = londonParts(o.now).ymd;
  const sameDay = (a: Date, ymd: string) => londonParts(a).ymd === ymd;
  const okAt = (t: Date, ymd: string): boolean => {
    if (t.getTime() < earliest) return false;
    const lp = londonParts(t);
    if (lp.ymd !== ymd) return false;
    const mins = lp.hour * 60 + lp.minute;
    if (mins < o.windowStartHour * 60 || mins > o.windowEndHour * 60) return false;
    if (o.taken.filter((x) => sameDay(x, ymd)).length >= o.maxPerDay) return false;
    return o.taken.every((x) => Math.abs(x.getTime() - t.getTime()) >= o.gapMinutes * 60_000);
  };
  for (let day = 0; day <= o.horizonDays; day++) {
    const ymd = addDays(todayYmd, day);
    if (o.excludeDays?.has(ymd)) continue;
    // A preferred hour outside the window (or none) means "as early as the window allows".
    const pref = o.preferredHour != null && o.preferredHour >= o.windowStartHour && o.preferredHour <= o.windowEndHour ? o.preferredHour : o.windowStartHour;
    const startMin = pref * 60;
    for (let m = startMin; m <= o.windowEndHour * 60; m += 15) {
      const base = londonInstant(ymd, Math.floor(m / 60), m % 60);
      if (!okAt(base, ymd)) continue;
      // A little human-looking jitter, kept only when it still satisfies every rule.
      if (o.rand) {
        const j = new Date(base.getTime() + Math.round((o.rand() * 2 - 1) * 7) * 60_000);
        if (okAt(j, ymd)) return j;
      }
      return base;
    }
  }
  return null;
}

/* ── Text safety ───────────────────────────────────────────────────────────────────────────────────────────────── */

// Anything bereavement-related, or personal safeguarding, is never promoted automatically. Deliberately broad: a false positive just
// means a human posts it by hand; a false negative is a distressing public post.
const SENSITIVE = /\b(funeral|funerals|obituar(y|ies)|death|deaths|died|dies|dying|deceased|passed away|passing of|notice of (the )?passing|has passed|passed on|sad news|bereave\w*|condolence\w*|in memoriam|rest in peace|\bRIP\b|cremation|burial|interment|wake for|memorial service|coroner|fatal\w*|suicid\w*|self[- ]harm|missing person|abuse[sd]?|assault\w*|arrest\w*|court\b|police appeal)\b/i;
export const isSensitiveText = (...parts: Array<string | null | undefined>): boolean => parts.some((p) => !!p && SENSITIVE.test(p));

export function excerpt(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > max * 0.5) return cut.slice(0, stop + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—]$/, '') + '…';
}

export const httpsUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u) ? u : null);
/**
 * Category artwork for notice posts. The images are static files on the website (public/social/notices/) and each notice page serves
 * its category's card as og:image (web lib/notice-share-image.ts, same mapping), so Facebook's LINK card shows it and opens the notice.
 * social_posts.image_url holds the same URL purely so Social Studio can preview it; the publisher never sends it as a photo post for
 * notices. Unmapped / missing categories fall back to the Community Notice card.
 */
export const NOTICE_IMAGE_BASE = `${SITE}/social/notices`;
export const NOTICE_CATEGORY_IMAGE: Readonly<Record<string, string>> = {
  travel_transport: 'travel',
  health: 'health',
  public_services: 'council',
  consultations_funding: 'consultations',
  community: 'community',
};
export const NOTICE_IMAGE_FALLBACK = 'community';
export function noticeCategoryImage(category: string | null | undefined): string {
  const key = NOTICE_CATEGORY_IMAGE[String(category ?? '').trim().toLowerCase()] ?? NOTICE_IMAGE_FALLBACK;
  return `${NOTICE_IMAGE_BASE}/notice-${key}.jpg`;
}
export const isFixtureName = (n: string | null | undefined) => /^\s*(ZZ|DEMO)\b/i.test(n ?? '');

/* ── Eligibility predicates (pure; the selectors below feed them rows) ─────────────────────────────────────────── */

type Notice = { id: string; title: string; body: string | null; category: string | null; published_at: string; expires_at: string | null; review_at?: string | null; image_url?: string | null; action_text?: string | null; link_url?: string | null; is_essential_active?: boolean; publisher?: any };
type NoticeMeta = { id: string; is_person_notice: boolean; status: string; is_hidden: boolean; visibility: string; withdrawn_at: string | null; source_label: string | null };

const hoursFrom = (iso: string, now: Date) => (new Date(iso).getTime() - now.getTime()) / 3600_000;

export function noticeEligible(n: Notice, m: NoticeMeta | undefined, cfg: Record<string, unknown>, now: Date): { ok: boolean; reason?: string } {
  if (!m) return { ok: false, reason: 'no-meta' };
  if (m.status !== 'published' || m.is_hidden || m.visibility !== 'public' || m.withdrawn_at) return { ok: false, reason: 'not-public' };
  if (n.is_essential_active) return { ok: false, reason: 'essential-handled-elsewhere' };
  if (m.is_person_notice && cfg.include_person !== true) return { ok: false, reason: 'person-notice' };
  if (isSensitiveText(n.title, n.body, n.category, m.source_label)) return { ok: false, reason: 'sensitive' };
  const age = -hoursFrom(n.published_at, now) / 24;
  if (age > Number(cfg.max_age_days ?? 7)) return { ok: false, reason: 'too-old' };
  if (n.expires_at && hoursFrom(n.expires_at, now) < Number(cfg.min_remaining_hours ?? 24)) return { ok: false, reason: 'expiring' };
  if (!n.title?.trim()) return { ok: false, reason: 'no-title' };
  return { ok: true };
}

export function alertEligible(n: Notice, m: NoticeMeta | undefined, cfg: Record<string, unknown>, now: Date): { ok: boolean; reason?: string } {
  if (!m) return { ok: false, reason: 'no-meta' };
  if (m.status !== 'published' || m.is_hidden || m.visibility !== 'public' || m.withdrawn_at) return { ok: false, reason: 'not-active' };
  if (n.is_essential_active !== true) return { ok: false, reason: 'not-essential-active' };
  if (isSensitiveText(n.title, n.body, n.category)) return { ok: false, reason: 'sensitive' };
  const min = Number(cfg.min_remaining_hours ?? 2);
  if (n.expires_at && hoursFrom(n.expires_at, now) < min) return { ok: false, reason: 'expiring' };
  if (!n.review_at || hoursFrom(n.review_at, now) < min) return { ok: false, reason: 'review-due' };
  if (!n.title?.trim()) return { ok: false, reason: 'no-title' };
  return { ok: true };
}

type Memory = { id: string; title: string | null; body: string | null; era: string | null; place_name: string | null; visibility: string; is_hidden: boolean; parent_id: string | null };
export function memoryEligible(m: Memory, allowed: boolean, cfg: Record<string, unknown>): { ok: boolean; reason?: string } {
  if (!allowed) return { ok: false, reason: 'no-permission' };
  if (m.visibility !== 'public' || m.is_hidden) return { ok: false, reason: 'not-public' };
  if (m.parent_id) return { ok: false, reason: 'reply' };
  if ((m.body ?? '').trim().length < Number(cfg.min_body_chars ?? 80)) return { ok: false, reason: 'too-short' };
  if (!m.title?.trim()) return { ok: false, reason: 'no-title' };
  if (isSensitiveText(m.title, m.body)) return { ok: false, reason: 'sensitive' };
  return { ok: true };
}

type Business = { id: string; name: string; description: string | null; cover_url: string | null; logo_url: string | null; category: string | null; is_claimed: boolean; is_active: boolean };
type Hub = { id: string; name: string; description: string | null; cover_url: string | null; logo_url: string | null; area: string | null; join_mode: string | null; is_active: boolean; slug: string | null };
export function hubEligible(h: Hub, hidden: boolean, optedOut: boolean, cfg: Record<string, unknown>): { ok: boolean; reason?: string } {
  if (!h.is_active) return { ok: false, reason: 'inactive' };
  if (hidden) return { ok: false, reason: 'hidden' };
  if (optedOut) return { ok: false, reason: 'opted-out' };
  if (isFixtureName(h.name)) return { ok: false, reason: 'fixture' };
  if ((h.description ?? '').trim().length < Number(cfg.min_description_chars ?? 40)) return { ok: false, reason: 'no-description' };
  return { ok: true };
}

/** A fundraiser may be mentioned only while it can actually take a donation: open, not past its end date, and its Hub payout-ready. */
export function campaignMentionable(c: { status: string; ends_at: string | null }, payoutReady: boolean, now: Date): boolean {
  return c.status === 'active' && (!c.ends_at || new Date(c.ends_at).getTime() > now.getTime()) && payoutReady === true;
}

type Visit = { id: string; ship_name_cache: string | null; arrival_at: string; departure_at: string | null; visit_date: string; berth: string | null; status: string | null; is_cruise_ship: boolean | null; last_verified: string | null; verification_source: string | null; is_tender?: boolean | null };
const VISIT_OK_STATUS = new Set(['scheduled', 'confirmed']);
export function visitEligible(v: Visit, cfg: Record<string, unknown>, now: Date): { ok: boolean; reason?: string } {
  if (!VISIT_OK_STATUS.has((v.status ?? '').toLowerCase())) return { ok: false, reason: 'status' };   // cancelled / postponed / unknown never
  if (v.is_cruise_ship === false) return { ok: false, reason: 'not-cruise' };
  if (!v.verification_source || !v.last_verified) return { ok: false, reason: 'unverified' };
  const ageDays = (now.getTime() - new Date(v.last_verified).getTime()) / 86400_000;
  if (ageDays > Number(cfg.max_verified_age_days ?? 365)) return { ok: false, reason: 'verification-stale' };
  const end = new Date(v.departure_at ?? v.arrival_at).getTime();
  if (end <= now.getTime()) return { ok: false, reason: 'past' };
  if (!v.ship_name_cache?.trim()) return { ok: false, reason: 'no-name' };
  return { ok: true };
}

/* ── Games ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const GAME_COPY: Record<string, { label: string; slug: string; lines: string[] }> = {
  guess_da_wird: { label: 'Guess da Wird', slug: 'games/guess-da-wird', lines: [
    'A new Shetland dialect word puzzle every day. Can you get it before the clues run out?',
    'Today’s Guess da Wird is waiting. Progressive clues, a few tries — how many will you need?',
    'Think you know your Shetland words? Test it with today’s Guess da Wird.' ] },
  spik_sprint: { label: 'Spik Sprint', slug: 'games/spik-sprint', lines: [
    'Sixty seconds, as many Shetland word meanings as you can tap. How high can you score?',
    'Spik Sprint: a one-minute race to match Shetland words to their meanings.' ] },
  spik_snap: { label: 'Spik Snap', slug: 'games/spik-snap', lines: [
    'Yes or no — does the meaning match the wird? Quick-fire Spik Snap.',
    'Spik Snap: spot the right meaning and keep your streak going.' ] },
  map_it: { label: 'Map It', slug: 'games/map-it', lines: [
    'Pin Shetland places on the map — ten rounds, and the closer the better.',
    'Map It: how well do you really know the isles? Ten places to pin.' ] },
};
/** True if a game caption could reveal a current answer. Generic copy never does; this guards edits to GAME_COPY and the AI warm-up. */
export const spoilsAnswer = (caption: string, answers: string[]): boolean => answers.some((a) => a && new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(caption));


/* ── Original recipes: availability rules shared by the composer (at compose) and the publisher (at send) ─────────── */

type EventRow = { id: string; title: string; starts_at: string; status: string | null; is_hidden: boolean | null; organiser_hub_id?: string | null; calendar_approved?: boolean | null };
/** Public, listed, not cancelled, a real (non-fixture) event that has NOT started by `at` (the moment the post goes out). */
export function eventPromotable(e: EventRow, at: Date): { ok: boolean; reason?: string } {
  if (e.status !== 'published') return { ok: false, reason: 'not-published' };      // cancelled / draft / archived
  if (e.is_hidden) return { ok: false, reason: 'hidden' };
  if (e.organiser_hub_id && e.calendar_approved !== true) return { ok: false, reason: 'not-calendar-approved' };   // the website's own listing rule
  if (isFixtureName(e.title)) return { ok: false, reason: 'fixture' };
  if (new Date(e.starts_at).getTime() <= at.getTime()) return { ok: false, reason: 'already-started' };
  return { ok: true };
}

type JobRow = { id: string; status: string | null; is_hidden: boolean | null; expires_at: string | null };
/** Open, listed and not past its closing time at `at` — the same rule the website's job list applies. */
export function jobPromotable(j: JobRow, at: Date): { ok: boolean; reason?: string } {
  if (j.status !== 'open') return { ok: false, reason: 'not-open' };
  if (j.is_hidden) return { ok: false, reason: 'hidden' };
  if (j.expires_at && new Date(j.expires_at).getTime() <= at.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true };
}

type ProductRow = { id: string; title: string; is_active: boolean | null; sold_at: string | null; stock_mode: string | null; stock: number | null; reserved: number | null; photos?: string[] | null };
type VariantRow = { stock: number | null; reserved: number | null; is_active: boolean | null };
/** The Shop's own availableQty() rule (lib/shop-data.ts), plus: has a photo, and is not a test fixture. */
export function productPromotable(p: ProductRow, variants: VariantRow[], businessName: string | null, businessActive: boolean, businessHidden: boolean): { ok: boolean; reason?: string } {
  if (!p.is_active || p.sold_at) return { ok: false, reason: 'unavailable' };
  if (!businessActive) return { ok: false, reason: 'business-inactive' };
  if (businessHidden) return { ok: false, reason: 'business-hidden' };
  if (isFixtureName(businessName) || isFixtureName(p.title)) return { ok: false, reason: 'fixture' };
  if (!(p.photos ?? []).length) return { ok: false, reason: 'no-photo' };
  const live = variants.filter((v) => v.is_active !== false);
  let qty: number;
  if (p.stock_mode === 'made_to_order') qty = 99;
  else if (p.stock_mode === 'one_off') qty = (p.reserved ?? 0) > 0 ? 0 : 1;
  else if (live.length && live.some((v) => v.stock != null)) qty = Math.max(0, ...live.map((v) => (v.stock != null ? v.stock - (v.reserved ?? 0) : 99)));
  else if (p.stock == null) qty = 99;
  else qty = Math.max(0, p.stock - (p.reserved ?? 0));
  return qty > 0 ? { ok: true } : { ok: false, reason: 'out-of-stock' };
}

/** Roundups record which items they list in link_url's fragment (never sent to Facebook: roundups are photo posts), so the publisher can re-check exactly those. */
export const withIds = (link: string, ids: string[]): string => (ids.length ? `${link}#ids=${ids.join(',')}` : link);
export const idsFromLink = (link: string | null | undefined): string[] => {
  const m = (link ?? '').match(/#ids=([A-Za-z0-9,_-]+)$/);
  return m ? m[1].split(',').filter(Boolean) : [];
};

/* ── One shared slot allocator for ALL twelve recipes ─────────────────────────────────────────────────────────── */

/** Marks a draft that is an autopilot post waiting only for approval (sensitive listing). */
export const HELD_PREFIX = 'Held for approval';
export type SlotContext = { now: Date; /** approved / scheduled / posted-today: slots that are really committed */ taken: Date[]; /** unapproved drafts: they space out against each other but never block a post that will really be published */ draftTaken: Date[]; gapMinutes: number; maxPerDay: number; windowStartHour: number; windowEndHour: number };

/** Reads the shared limits (admin_config) and every post already queued for the future or posted today. Call once per composer run. */
export async function loadSlotContext(svc: Svc, now: Date): Promise<SlotContext> {
  const { data: cfgRows } = await svc.from('admin_config').select('key,value').in('key', ['social.max_posts_per_day', 'social.min_gap_minutes', 'social.window_hours']);
  const g = new Map<string, string>(((cfgRows ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const [ws, we] = (g.get('social.window_hours') ?? '8-20').split('-').map(Number);
  const todayStart = londonInstant(londonParts(now).ymd, 0, 0).toISOString();
  const { data: around } = await svc.from('social_posts').select('status,scheduled_for,posted_at,error')
    .or(`and(status.in.(approved,scheduled),scheduled_for.gte.${now.toISOString()}),and(status.eq.draft,scheduled_for.gte.${now.toISOString()}),and(status.eq.posted,posted_at.gte.${todayStart})`).limit(500);
  type Around = { status: string; scheduled_for: string | null; posted_at: string | null; error?: string | null };
  const rowsAround = (around ?? []) as Around[];
  const when = (r: Around) => new Date((r.status === 'posted' ? r.posted_at : r.scheduled_for) as string);
  // Unapproved REVIEW-ONLY drafts do NOT reserve publishing slots: approved, scheduled and already-posted items do. A draft held for a person because of
  // sensitive subject matter ('Held for approval: ...') is an autopilot post waiting for one tick, so it keeps its slot like any scheduled post.
  const reserves = (r: Around) => r.status !== 'draft' || String(r.error ?? '').startsWith(HELD_PREFIX);
  const taken = rowsAround.filter(reserves).map(when).filter((x) => !isNaN(x.getTime()));
  const draftTaken = rowsAround.filter((r) => !reserves(r)).map(when).filter((x) => !isNaN(x.getTime()));
  return {
    now, taken, draftTaken,
    gapMinutes: Math.max(15, Number(g.get('social.min_gap_minutes') ?? 120) || 120),
    maxPerDay: Math.max(1, Number(g.get('social.max_posts_per_day') ?? 3) || 3),
    windowStartHour: Number.isFinite(ws) ? ws : 8, windowEndHour: Number.isFinite(we) ? we : 20,
  };
}

/** The next free slot for a recipe's preferred hour, or null if the limits leave none in the next 3 days. Does NOT reserve it: call ctx.taken.push(slot) once the post exists. */
export function peekSlot(ctx: SlotContext, preferredHour: number | null, rand: () => number = Math.random, asDraft = false): Date | null {
  return allocateSlot({ now: ctx.now, preferredHour, taken: asDraft ? [...ctx.taken, ...ctx.draftTaken] : ctx.taken, gapMinutes: ctx.gapMinutes, maxPerDay: ctx.maxPerDay, windowStartHour: ctx.windowStartHour, windowEndHour: ctx.windowEndHour, horizonDays: 3, rand });
}

/* ── Selectors: each returns already-filtered Candidates, best first ───────────────────────────────────────────── */

/**
 * A notice caption. The artwork already says "OneShetland" and the notice type, so the FIRST LINE is the notice's own title (the real
 * information, never a generic "COMMUNITY NOTICE" header). Then a short excerpt of the notice's own text, the source if it has one, and the link.
 * Nothing is invented: every word comes from the notice. Dates and deadlines appear when they are in the notice text itself.
 */
export function noticeCaption(n: { title: string; body: string | null; source?: string | null; link: string }): string {
  const title = excerpt(n.title.replace(/\s+/g, ' ').trim(), 140);
  let body = excerpt(n.body, 220);
  // Don't repeat the headline as the first words of the excerpt.
  if (body && title.length > 8 && body.toLowerCase().startsWith(title.toLowerCase())) body = body.slice(title.length).replace(/^[\s.:;,\-–—]+/, '');
  return [title, body, n.source ? `Source: ${n.source}` : '', `Full notice: ${n.link}`].filter(Boolean).join('\n\n');
}

export async function selectNotices(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<Candidate[]> {
  const { data, error } = await svc.rpc('get_public_notices', { p_level: 'all', p_area_ids: null, p_category: null, p_limit: 50, p_offset: 0 });
  if (error) throw error;
  const rows = (data ?? []) as Notice[];
  if (!rows.length) return [];
  const { data: metas, error: e2 } = await svc.from('notices')
    .select('id,is_person_notice,status,is_hidden,visibility,withdrawn_at,source_label').in('id', rows.map((r) => r.id));
  if (e2) throw e2;
  const meta = new Map<string, NoticeMeta>(((metas ?? []) as NoticeMeta[]).map((m) => [m.id, m]));
  return rows.filter((r) => noticeEligible(r, meta.get(r.id), cfg, now).ok).map((r) => {
    const source = meta.get(r.id)?.source_label;
    const link = go(`notice/${r.id}`);
    const body = excerpt(r.body, 220);
    return {
      kind: 'notice_update' as const, entity_type: 'notice', entity_id: r.id,
      caption: noticeCaption({ title: r.title, body: r.body, source, link }),
      image_url: noticeCategoryImage(r.category), link_url: link, context: `Public notice: "${r.title}".`,
    };
  });
}

export async function selectAlerts(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<Candidate[]> {
  const { data, error } = await svc.rpc('get_public_notices', { p_level: 'essential', p_area_ids: null, p_category: null, p_limit: 10, p_offset: 0 });
  if (error) throw error;
  const rows = (data ?? []) as Notice[];
  if (!rows.length) return [];
  const { data: metas, error: e2 } = await svc.from('notices')
    .select('id,is_person_notice,status,is_hidden,visibility,withdrawn_at,source_label').in('id', rows.map((r) => r.id));
  if (e2) throw e2;
  const meta = new Map<string, NoticeMeta>(((metas ?? []) as NoticeMeta[]).map((m) => [m.id, m]));
  return rows.filter((r) => alertEligible(r, meta.get(r.id), cfg, now).ok).map((r) => {
    const link = go(`notice/${r.id}`);
    const who = r.publisher?.label ?? r.publisher?.source_label ?? meta.get(r.id)?.source_label ?? null;
    const what = excerpt(r.action_text?.trim() || r.body, 240);
    return {
      kind: 'essential_alert' as const, entity_type: 'notice', entity_id: r.id,
      // Plain, exactly the issuer's wording. No emoji, no urgency words of our own.
      caption: `ESSENTIAL ALERT\n\n${r.title.trim()}${what ? `\n\n${what}` : ''}${who ? `\n\nIssued by ${who}.` : ''}\n\nLatest information: ${link}`,
      image_url: null, link_url: link, context: `Essential alert: "${r.title}".`,
    };
  });
}

export async function selectMemories(svc: Svc, cfg: Record<string, unknown>): Promise<Candidate[]> {
  const { data, error } = await svc.from('memories')
    .select('id,title,body,era,place_name,visibility,is_hidden,parent_id')
    .eq('visibility', 'public').eq('is_hidden', false).is('parent_id', null)
    .order('created_at', { ascending: false }).limit(80);
  if (error) throw error;
  const rows = (data ?? []) as Memory[];
  if (!rows.length) return [];
  const { data: perms, error: e2 } = await svc.from('social_promotion_permissions')
    .select('entity_id,allowed').eq('entity_type', 'memory').in('entity_id', rows.map((r) => r.id));
  if (e2) throw e2;
  const allowed = new Set(((perms ?? []) as { entity_id: string; allowed: boolean }[]).filter((p) => p.allowed).map((p) => p.entity_id));
  return rows.filter((m) => memoryEligible(m, allowed.has(m.id), cfg).ok).map((m) => {
    const link = go(`memory/${m.id}`);
    const era = m.era ? ` (${m.era})` : '';
    return {
      kind: 'aald_memory' as const, entity_type: 'memory', entity_id: m.id,
      caption: `AALD MEMORIES 📷\n\n${m.title!.trim()}${era}${m.place_name ? `\n📍 ${m.place_name}` : ''}\n\n${excerpt(m.body, 220)}\n\nRead it, and add your own memories: ${link}`,
      // Memory photos live in a PRIVATE bucket; there is no promotion-safe public image, so none is attached. Facebook builds the link preview.
      image_url: null, link_url: link, context: `A community memory shared on OneShetland: "${m.title}".`,
    };
  });
}

/* ── Business Spotlight: a fair, deterministic rotation ─────────────────────────────────────────────────────────────
 *
 * WHO GOES NEXT (never database order):
 *   1. WELCOME lane: claimed within the last `welcome_days` (14), never featured, OLDEST CLAIM FIRST.
 *   2. NEW: every other business that has never been featured, oldest claim first.
 *   3. ROTATION: businesses featured before whose `repeat_after_days` (90) exclusion has run out, longest ago first.
 *   No more than `welcome_max_consecutive` (2) welcome picks in a row while any other eligible business is waiting.
 *   Ties are broken by id, so the same data always gives the same order.
 * WHAT COUNTS:
 *   · Only a post that was actually PUBLISHED starts the 90-day exclusion.
 *   · A post still waiting (draft / approved / scheduled) blocks that business so it is never picked twice.
 *   · A skipped or failed post never blocks for long: a short cool-off (skipped_cooloff_days 7, failed_cooloff_days 2), then it is eligible again.
 * CONTENT: a business without a photograph uses OneShetland's generated card. A business whose wording is sensitive is still posted, but only as a
 *   DRAFT that a person approves. The pool is every claimed, active business (paged by id), not the first 120.
 */
export type SpotBiz = Business & { claimed_at?: string | null; owner_activated_at?: string | null; created_at?: string | null };
export type SpotPost = { entity_id: string | null; business_id?: string | null; status: string; created_at: string; posted_at?: string | null; scheduled_for?: string | null; error?: string | null };
export type SpotLane = 'welcome' | 'new' | 'rotation';
export type SpotRank = { id: string; name: string; lane: SpotLane; claimedAt: string | null; lastPostedAt: string | null; sensitive: boolean };
export type SpotExcluded = { id: string; name: string; reason: string; until?: string | null };
export type SpotReport = {
  at: string; streak: number; order: SpotRank[]; excluded: SpotExcluded[];
  counts: { pool: number; eligible: number; welcome: number; new: number; rotation: number; excluded: number };
  recent: { id: string; name: string; status: string; when: string }[];
};
export const SPOT_DEFAULTS = { welcome_days: 14, welcome_max_consecutive: 2, repeat_after_days: 90, skipped_cooloff_days: 7, failed_cooloff_days: 2, min_description_chars: 60, min_description_words: 8 };
const DAY = 86400_000;
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const spotCfg = (cfg: Record<string, unknown>) => ({
  welcomeDays: num(cfg.welcome_days, SPOT_DEFAULTS.welcome_days), welcomeMax: Math.max(1, num(cfg.welcome_max_consecutive, SPOT_DEFAULTS.welcome_max_consecutive)),
  repeatDays: num(cfg.repeat_after_days, SPOT_DEFAULTS.repeat_after_days), skippedDays: num(cfg.skipped_cooloff_days, SPOT_DEFAULTS.skipped_cooloff_days),
  failedDays: num(cfg.failed_cooloff_days, SPOT_DEFAULTS.failed_cooloff_days), minChars: num(cfg.min_description_chars, SPOT_DEFAULTS.min_description_chars),
  minWords: num(cfg.min_description_words, SPOT_DEFAULTS.min_description_words),
});

export const claimDate = (b: SpotBiz): string | null => b.claimed_at ?? b.owner_activated_at ?? b.created_at ?? null;
const PLACEHOLDER = /\b(lorem ipsum|placeholder|coming soon|to be confirmed|tbc|tba|n\/a|test (listing|business|description)|sample (text|business)|xxx+)\b/i;
/** Subjects that are fine to promote but deserve a person's eye first. Added to the shared sensitive-text list (bereavement, funerals, death...). */
const BUSINESS_SENSITIVE = /\b(counsell?ing|counsellor\w*|psychotherap\w*|grief|suicid\w*|self[- ]?harm|addiction|substance (use|misuse)|alcohol (dependency|misuse)|domestic (abuse|violence)|abuse|safeguarding|palliative|hospice|mental health|crisis|helpline|samaritans|cancer|undertaker\w*|cremat\w*|funeral\w*)\b/i;
export const businessSensitive = (b: { name?: string | null; description?: string | null; category?: string | null }) =>
  isSensitiveText(b.name, b.description, b.category) || BUSINESS_SENSITIVE.test([b.name, b.description, b.category].filter(Boolean).join(' '));

/** Minimum listing quality for an automatic Spotlight. A photograph is NOT required: the generated card is used instead. */
export function businessEligible(b: Business, hidden: boolean, optedOut: boolean, cfg: Record<string, unknown>): { ok: boolean; reason?: string } {
  const c = spotCfg(cfg);
  if (!b.is_claimed) return { ok: false, reason: 'unclaimed' };
  if (!b.is_active) return { ok: false, reason: 'inactive' };
  if (hidden) return { ok: false, reason: 'hidden' };
  if (optedOut) return { ok: false, reason: 'opted-out' };
  if (isFixtureName(b.name)) return { ok: false, reason: 'fixture' };
  if ((b.name ?? '').trim().length < 3) return { ok: false, reason: 'no-name' };
  const d = (b.description ?? '').trim();
  if (d.length < c.minChars) return { ok: false, reason: 'no-description' };
  if (d.split(/\s+/).filter(Boolean).length < c.minWords) return { ok: false, reason: 'thin-description' };
  if (PLACEHOLDER.test(`${b.name} ${d}`)) return { ok: false, reason: 'placeholder-text' };
  return { ok: true };
}

const bizOf = (p: SpotPost) => (p.business_id ?? (p.entity_id ?? '').split(':')[0]) || '';
const WAITING = ['draft', 'approved', 'scheduled'];
const tOf = (p: SpotPost) => Date.parse((p.posted_at ?? p.scheduled_for ?? p.created_at) as string);

type BizState = { lastPostedAt: number | null; pending: boolean; coolUntil: number | null; firstAttemptAt: number | null };
export function spotlightStates(history: SpotPost[], cfg: Record<string, unknown>): Map<string, BizState> {
  const c = spotCfg(cfg); const m = new Map<string, BizState>();
  for (const h of history) {
    const id = bizOf(h); if (!id) continue;
    const st = m.get(id) ?? { lastPostedAt: null, pending: false, coolUntil: null, firstAttemptAt: null }; m.set(id, st);
    const ct = Date.parse(h.created_at); if (!isNaN(ct) && (st.firstAttemptAt === null || ct < st.firstAttemptAt)) st.firstAttemptAt = ct;
    if (h.status === 'posted') { const t = tOf(h); if (!isNaN(t) && (st.lastPostedAt === null || t > st.lastPostedAt)) st.lastPostedAt = t; }
    else if (WAITING.includes(h.status)) st.pending = true;
    else if (h.status === 'skipped' || h.status === 'failed') {
      const t = Date.parse((h.scheduled_for ?? h.created_at) as string) + (h.status === 'failed' ? c.failedDays : c.skippedDays) * DAY;
      if (!isNaN(t) && (st.coolUntil === null || t > st.coolUntil)) st.coolUntil = t;
    }
  }
  return m;
}

/** How many of the most recent real picks (posted or waiting) were welcome-lane picks, in a row. Derived from the history, so it needs no stored state. */
export function welcomeStreak(history: SpotPost[], pool: Map<string, SpotBiz>, cfg: Record<string, unknown>): number {
  const c = spotCfg(cfg);
  const picks = history.filter((h) => h.status === 'posted' || WAITING.includes(h.status)).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const lanes: boolean[] = [];
  for (const p of picks) {
    const id = bizOf(p); const b = pool.get(id); const cd = b ? claimDate(b) : null; const t = Date.parse(p.created_at);
    const earlierPosted = history.some((h) => bizOf(h) === id && h.status === 'posted' && Date.parse(h.created_at) < t);
    const first = Math.min(...history.filter((h) => bizOf(h) === id).map((h) => Date.parse(h.created_at)));
    lanes.push(!earlierPosted && !!cd && first >= Date.parse(cd) - DAY && first - Date.parse(cd) <= c.welcomeDays * DAY);
  }
  let s = 0; for (let i = lanes.length - 1; i >= 0 && lanes[i]; i--) s++;
  return s;
}

/** The full pick order. Pure: same inputs, same order. */
export function orderSpotlight(eligible: SpotRank[], streak: number, welcomeMax: number): SpotRank[] {
  const byClaim = (a: SpotRank, b: SpotRank) => (a.claimedAt ?? '').localeCompare(b.claimedAt ?? '') || a.id.localeCompare(b.id);
  const w = eligible.filter((r) => r.lane === 'welcome').sort(byClaim);
  const n = eligible.filter((r) => r.lane === 'new').sort(byClaim);
  const r = eligible.filter((x) => x.lane === 'rotation').sort((a, b) => (a.lastPostedAt ?? '').localeCompare(b.lastPostedAt ?? '') || a.id.localeCompare(b.id));
  const out: SpotRank[] = []; let s = streak;
  while (w.length || n.length || r.length) {
    const others = n.length > 0 || r.length > 0;
    if (s >= welcomeMax && others) { out.push((n.length ? n : r).shift()!); s = 0; }
    else if (w.length) { out.push(w.shift()!); s++; }
    else { out.push((n.length ? n : r).shift()!); s = 0; }
  }
  return out;
}

async function loadSpotPool(svc: Svc): Promise<SpotBiz[]> {
  const out: SpotBiz[] = []; let last = '';
  for (let page = 0; page < 40; page++) {
    let q = svc.from('local_businesses').select('id,name,description,cover_url,logo_url,category,is_claimed,is_active,claimed_at,owner_activated_at,created_at').eq('is_claimed', true).eq('is_active', true).order('id', { ascending: true }).limit(500);
    if (last) q = q.gt('id', last);
    const { data, error } = await q; if (error) throw error;
    const rows = (data ?? []) as SpotBiz[]; out.push(...rows);
    if (rows.length < 500) break; last = rows[rows.length - 1].id;
  }
  return out;
}

const generatedCard = (id: string) => `${SITE}/api/social-image?kind=business&id=${id}`;

export async function selectSpotlight(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<{ candidates: Candidate[]; report: SpotReport }> {
  const c = spotCfg(cfg);
  const [poolRows, hist, perms] = await Promise.all([
    loadSpotPool(svc),
    svc.from('social_posts').select('entity_id,business_id,status,created_at,posted_at,scheduled_for,error').eq('kind', 'business_spotlight').order('created_at', { ascending: false }).limit(5000),
    svc.from('social_promotion_permissions').select('entity_id,allowed').eq('entity_type', 'business'),
  ]);
  if (hist.error) throw hist.error;
  const history = (hist.data ?? []) as SpotPost[];
  const optedOut = new Set(((perms.data ?? []) as { entity_id: string; allowed: boolean }[]).filter((p) => !p.allowed).map((p) => p.entity_id));
  const pool = new Map(poolRows.map((b) => [b.id, b])); const states = spotlightStates(history, cfg);
  const excluded: SpotExcluded[] = []; const passing: SpotBiz[] = [];
  const ymd = (t: number) => londonParts(new Date(t)).ymd;
  for (const b of poolRows) {
    const st = states.get(b.id); const q = businessEligible(b, false, optedOut.has(b.id), cfg);
    if (!q.ok) { excluded.push({ id: b.id, name: b.name, reason: q.reason! }); continue; }
    if (st?.pending) { excluded.push({ id: b.id, name: b.name, reason: 'already queued' }); continue; }
    if (st?.lastPostedAt != null && now.getTime() - st.lastPostedAt < c.repeatDays * DAY) { excluded.push({ id: b.id, name: b.name, reason: `featured ${ymd(st.lastPostedAt)}`, until: ymd(st.lastPostedAt + c.repeatDays * DAY) }); continue; }
    if (st?.coolUntil != null && st.coolUntil > now.getTime()) { excluded.push({ id: b.id, name: b.name, reason: 'cooling off after a skipped or failed post', until: ymd(st.coolUntil) }); continue; }
    passing.push(b);
  }
  const eligible: SpotBiz[] = passing;
  const ranks: SpotRank[] = eligible.map((b) => {
    const st = states.get(b.id); const cd = claimDate(b);
    const featured = st?.lastPostedAt != null;
    // A failed or skipped attempt keeps the business's priority: the welcome window is judged at its FIRST attempt (or now, if it has had none), so a cool-off never costs it its place.
    const anchor = st?.firstAttemptAt ?? now.getTime();
    const lane: SpotLane = featured ? 'rotation' : cd && anchor - Date.parse(cd) <= c.welcomeDays * DAY ? 'welcome' : 'new';
    return { id: b.id, name: b.name, lane, claimedAt: cd, lastPostedAt: featured ? new Date(st!.lastPostedAt!).toISOString() : null, sensitive: businessSensitive(b) };
  });
  const streak = welcomeStreak(history, pool, cfg);
  // The hidden-listing check is one RPC per business, so it is made only for the businesses about to be picked (the head of the order), a few at a
  // time; anyone found hidden is dropped and the order is recomputed. A large directory therefore costs a handful of lookups per run, never one each.
  let live = ranks.slice(); let order = orderSpotlight(live, streak, c.welcomeMax); const verified = new Set<string>();
  for (let guard = 0; guard < 50; guard++) {
    const head = order.slice(0, MAX_CANDIDATES).filter((r) => !verified.has(r.id));
    if (!head.length) break;
    const res = await Promise.all(head.map((r) => svc.rpc('is_discovery_hidden', { p_entity: 'business', p_id: r.id })));
    let dropped = false;
    head.forEach((r, j) => { if (res[j].data === true) { excluded.push({ id: r.id, name: r.name, reason: 'hidden' }); live = live.filter((x) => x.id !== r.id); dropped = true; } else verified.add(r.id); });
    if (!dropped) break;
    order = orderSpotlight(live, streak, c.welcomeMax);
  }
  const byId = new Map(eligible.map((b) => [b.id, b]));
  const candidates: Candidate[] = order.slice(0, MAX_CANDIDATES).map((r) => {
    const b = byId.get(r.id)!; const link = go(`business/${b.id}`);
    return {
      kind: 'business_spotlight', entity_type: 'business', entity_id: b.id, business_id: b.id,
      caption: `LOCAL BUSINESS SPOTLIGHT 🏪\n\n${b.name.trim()}${b.category ? ` — ${b.category}` : ''}\n\n${excerpt(b.description, 220)}\n\nFind them on OneShetland: ${link}`,
      image_url: httpsUrl(b.cover_url) ?? httpsUrl(b.logo_url) ?? generatedCard(b.id), link_url: link, context: `Local Shetland business "${b.name}".`,
      needsApproval: r.sensitive, note: r.sensitive ? `${HELD_PREFIX}: the listing touches a sensitive subject` : `${r.lane} lane`,
    };
  });
  const report: SpotReport = {
    at: now.toISOString(), streak, order: order.slice(0, 60), excluded: excluded.sort((a, b) => a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name)).slice(0, 80),
    counts: { pool: poolRows.length, eligible: order.length, welcome: order.filter((r) => r.lane === 'welcome').length, new: order.filter((r) => r.lane === 'new').length, rotation: order.filter((r) => r.lane === 'rotation').length, excluded: excluded.length },
    recent: history.filter((h) => h.status === 'posted' || WAITING.includes(h.status)).slice(0, 12).map((h) => ({ id: bizOf(h), name: pool.get(bizOf(h))?.name ?? bizOf(h), status: h.status, when: (h.posted_at ?? h.scheduled_for ?? h.created_at) as string })),
  };
  return { candidates, report };
}

/** Back-compatible entry point: the ordered candidates only. */
export async function selectBusinesses(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<Candidate[]> {
  return (await selectSpotlight(svc, cfg, now)).candidates;
}

/** Leave the latest selection where administrators can read it (admin_config 'social.spotlight_pool'). Best effort: never blocks a run. */
export async function writeSpotlightSnapshot(svc: Svc, report: SpotReport): Promise<void> {
  try {
    const key = 'social.spotlight_pool'; const value = JSON.stringify(report);
    const { data } = await svc.from('admin_config').select('key').eq('key', key).maybeSingle();
    if (data) await svc.from('admin_config').update({ value }).eq('key', key);
    else await svc.from('admin_config').insert({ key, value });
  } catch { /* visibility only */ }
}

export async function selectHubs(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<Candidate[]> {
  const { data, error } = await svc.from('hubs')
    .select('id,name,description,cover_url,logo_url,area,join_mode,is_active,slug').eq('is_active', true).limit(80);
  if (error) throw error;
  const rows = (data ?? []) as Hub[];
  if (!rows.length) return [];
  const { data: perms } = await svc.from('social_promotion_permissions').select('entity_id,allowed').eq('entity_type', 'hub').in('entity_id', rows.map((r) => r.id));
  const out = new Set(((perms ?? []) as { entity_id: string; allowed: boolean }[]).filter((p) => !p.allowed).map((p) => p.entity_id));
  const result: Candidate[] = [];
  for (const h of rows) {
    if (result.length >= MAX_CANDIDATES) break;
    if (!hubEligible(h, false, out.has(h.id), cfg).ok) continue;
    const { data: hidden } = await svc.rpc('is_discovery_hidden', { p_entity: 'hub', p_id: h.id });
    if (!hubEligible(h, hidden === true, out.has(h.id), cfg).ok) continue;
    const fundraiser = await mentionableCampaign(svc, h.id, now);
    const link = go(`hub/${h.id}`);
    const join = h.join_mode === 'open' ? '\nAnyone can join.' : '';
    result.push({
      kind: 'hub_community', entity_type: 'hub', entity_id: h.id,
      caption: `HUBS & COMMUNITY 🤝\n\n${h.name.trim()}${h.area ? ` · ${h.area}` : ''}\n\n${excerpt(h.description, 220)}${join}${fundraiser ? `\n\nCurrently fundraising: ${fundraiser.title}` : ''}\n\nSee what’s happening: ${link}`,
      image_url: httpsUrl(h.cover_url) ?? httpsUrl(h.logo_url), link_url: link, context: `A community Hub in Shetland: "${h.name}".`,
    });
  }
  return result;
}

async function mentionableCampaign(svc: Svc, hubId: string, now: Date): Promise<{ id: string; title: string } | null> {
  const { data } = await svc.from('hub_campaigns').select('id,title,status,ends_at').eq('hub_id', hubId).eq('status', 'active').limit(5);
  for (const c of (data ?? []) as { id: string; title: string; status: string; ends_at: string | null }[]) {
    if (c.ends_at && new Date(c.ends_at).getTime() <= now.getTime()) continue;
    const { data: ready } = await svc.rpc('campaign_payout_ready', { p_campaign: c.id });
    if (campaignMentionable(c, ready === true, now)) return { id: c.id, title: c.title };
  }
  return null;
}

export async function selectGames(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<Candidate[]> {
  const ids = ((cfg.games as string[] | undefined) ?? Object.keys(GAME_COPY)).filter((g) => GAME_COPY[g]);
  if (!ids.length) return [];
  const { data } = await svc.from('social_posts').select('entity_id,created_at').eq('kind', 'game_challenge').order('created_at', { ascending: false }).limit(60);
  const history = (data ?? []) as { entity_id: string | null; created_at: string }[];
  const gameOf = (e: string | null) => (e ?? '').split(':')[0];
  // Least recently featured first, so the games rotate rather than Guess da Wird dominating.
  const last = new Map<string, number>(); const count = new Map<string, number>();
  for (const h of history) { const g = gameOf(h.entity_id); count.set(g, (count.get(g) ?? 0) + 1); if (!last.has(g)) last.set(g, new Date(h.created_at).getTime()); }
  const week = isoWeekKey(now);
  return [...ids].sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0)).map((g) => {
    const c = GAME_COPY[g]; const link = go(c.slug);
    const line = c.lines[(count.get(g) ?? 0) % c.lines.length];
    return {
      kind: 'game_challenge' as const, entity_type: 'game', entity_id: `${g}:${week}`,
      caption: `${c.label.toUpperCase()} 🎮\n\n${line}\n\nPlay free: ${link}`,
      image_url: null, link_url: link, context: `The OneShetland game "${c.label}". Do not mention any specific answer.`,
    };
  });
}

export async function selectCruise(svc: Svc, cfg: Record<string, unknown>, now: Date): Promise<Candidate[]> {
  const today = londonParts(now).ymd; const lead = Number(cfg.lead_days ?? 3);
  const { data, error } = await svc.from('cruise_visits')
    .select('id,ship_name_cache,arrival_at,departure_at,visit_date,berth,status,is_cruise_ship,last_verified,verification_source,is_tender')
    .gte('visit_date', today).lte('visit_date', addDays(today, lead)).order('arrival_at', { ascending: true }).limit(40);
  if (error) throw error;
  const byDate = new Map<string, Visit[]>();
  for (const v of (data ?? []) as Visit[]) if (visitEligible(v, cfg, now).ok) byDate.set(v.visit_date, [...(byDate.get(v.visit_date) ?? []), v]);
  const t = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
  return [...byDate.entries()].map(([date, vs]) => {
    const link = go(`cruise/${date}`);
    const lines = vs.map((v) => `• ${v.ship_name_cache!.trim()} — in ${t(v.arrival_at)}${v.departure_at ? `, away ${t(v.departure_at)}` : ''}${v.berth ? ` (${v.berth})` : ''}`).join('\n');
    return {
      kind: 'cruise_visit' as const, entity_type: 'cruise_day', entity_id: date,
      caption: `CRUISE VISIT IN LERWICK 🚢\n\n${day(date)}\n${lines}\n\nVisitor information and what’s on: ${link}`,
      image_url: null, link_url: link, context: `Cruise ship visit on ${date}.`,
    };
  });
}

/* ── Publish-time revalidation ─────────────────────────────────────────────────────────────────────────────────── */

export type Validity = { state: 'valid' | 'invalid' | 'unknown'; reason?: string };
type QueuedPost = { id: string; kind: string; entity_id: string | null; caption: string; link_url?: string | null };

/**
 * Asked by social-publisher immediately before sending one of the new kinds. A draft may have waited days: the notice may have
 * expired or been withdrawn, the alert may be over, the visit cancelled, the permission revoked, the fundraiser closed.
 * 'invalid' => the publisher marks the post skipped. 'unknown' (a lookup failed) => the publisher leaves it untouched for the next pass.
 */
export async function revalidatePost(svc: Svc, post: QueuedPost, now: Date): Promise<Validity> {
  try {
    const id = post.entity_id ?? '';
    switch (post.kind) {
      case 'notice_update': {
        const { data, error } = await svc.rpc('get_public_notices', { p_level: 'all', p_area_ids: null, p_category: null, p_limit: 1, p_offset: 0, p_id: id });
        if (error) return { state: 'unknown' };
        const n = ((data ?? []) as Notice[])[0];
        if (!n) return { state: 'invalid', reason: 'notice is no longer public' };
        if (n.expires_at && new Date(n.expires_at).getTime() <= now.getTime()) return { state: 'invalid', reason: 'notice has expired' };
        const { data: m } = await svc.from('notices').select('is_person_notice,withdrawn_at,status,is_hidden,visibility,source_label').eq('id', id).maybeSingle();
        if (!m || m.withdrawn_at || m.status !== 'published' || m.is_hidden || m.visibility !== 'public') return { state: 'invalid', reason: 'notice withdrawn' };
        if (isSensitiveText(n.title, n.body, n.category)) return { state: 'invalid', reason: 'sensitive' };
        return { state: 'valid' };
      }
      case 'essential_alert': {
        const { data, error } = await svc.rpc('get_public_notices', { p_level: 'essential', p_area_ids: null, p_category: null, p_limit: 1, p_offset: 0, p_id: id });
        if (error) return { state: 'unknown' };
        const n = ((data ?? []) as Notice[])[0];
        if (!n || n.is_essential_active !== true) return { state: 'invalid', reason: 'alert is no longer active' };
        if (n.expires_at && new Date(n.expires_at).getTime() <= now.getTime()) return { state: 'invalid', reason: 'alert has expired' };
        if (!n.review_at || new Date(n.review_at).getTime() <= now.getTime()) return { state: 'invalid', reason: 'alert is due for review' };
        return { state: 'valid' };
      }
      case 'aald_memory': {
        const { data: m, error } = await svc.from('memories').select('id,visibility,is_hidden').eq('id', id).maybeSingle();
        if (error) return { state: 'unknown' };
        if (!m || m.visibility !== 'public' || m.is_hidden) return { state: 'invalid', reason: 'memory no longer public' };
        const { data: p } = await svc.from('social_promotion_permissions').select('allowed').eq('entity_type', 'memory').eq('entity_id', id).maybeSingle();
        return p?.allowed === true ? { state: 'valid' } : { state: 'invalid', reason: 'promotion permission removed' };
      }
      case 'business_spotlight': {
        const { data: b, error } = await svc.from('local_businesses').select('id,is_claimed,is_active').eq('id', id.split(':')[0]).maybeSingle();
        if (error) return { state: 'unknown' };
        if (!b || !b.is_claimed || !b.is_active) return { state: 'invalid', reason: 'business no longer claimed/active' };
        const { data: hidden } = await svc.rpc('is_discovery_hidden', { p_entity: 'business', p_id: b.id });
        const { data: p } = await svc.from('social_promotion_permissions').select('allowed').eq('entity_type', 'business').eq('entity_id', b.id).maybeSingle();
        return hidden === true || p?.allowed === false ? { state: 'invalid', reason: 'business hidden or opted out' } : { state: 'valid' };
      }
      case 'hub_community': {
        const hubId = id.split(':')[0];
        const { data: h, error } = await svc.from('hubs').select('id,is_active').eq('id', hubId).maybeSingle();
        if (error) return { state: 'unknown' };
        if (!h || !h.is_active) return { state: 'invalid', reason: 'hub no longer active' };
        const { data: hidden } = await svc.rpc('is_discovery_hidden', { p_entity: 'hub', p_id: hubId });
        if (hidden === true) return { state: 'invalid', reason: 'hub hidden' };
        // If the caption advertises a fundraiser, it must still be one that can take a donation.
        const m = post.caption.match(/Currently fundraising: (.+)/);
        if (m) {
          const live = await mentionableCampaign(svc, hubId, now);
          if (!live || live.title.trim() !== m[1].trim()) return { state: 'invalid', reason: 'fundraiser can no longer take donations' };
        }
        return { state: 'valid' };
      }
      case 'cruise_visit': {
        const { data, error } = await svc.from('cruise_visits')
          .select('id,ship_name_cache,arrival_at,departure_at,visit_date,berth,status,is_cruise_ship,last_verified,verification_source').eq('visit_date', id);
        if (error) return { state: 'unknown' };
        const ok = ((data ?? []) as Visit[]).some((v) => visitEligible(v, { max_verified_age_days: 365 }, now).ok);
        return ok ? { state: 'valid' } : { state: 'invalid', reason: 'visit cancelled, past or unverified' };
      }

      // ── The original recipes. Same question, asked of live data at the moment of sending. ──
      case 'event_spotlight': {
        const { data: e, error } = await svc.from('events').select('id,title,starts_at,status,is_hidden,organiser_hub_id,calendar_approved').eq('id', id).maybeSingle();
        if (error) return { state: 'unknown' };
        if (!e) return { state: 'invalid', reason: 'event no longer exists' };
        const v = eventPromotable(e as EventRow, now);
        return v.ok ? { state: 'valid' } : { state: 'invalid', reason: `event ${v.reason}` };
      }
      case 'whats_on_roundup': {
        const ids = idsFromLink((post as QueuedPost & { link_url?: string | null }).link_url);
        let evs: EventRow[];
        if (ids.length) {
          const { data, error } = await svc.from('events').select('id,title,starts_at,status,is_hidden,organiser_hub_id,calendar_approved').in('id', ids);
          if (error) return { state: 'unknown' };
          evs = (data ?? []) as EventRow[];
          if (evs.length !== ids.length) return { state: 'invalid', reason: 'a listed event no longer exists' };
          const bad = evs.find((e) => !eventPromotable(e, now).ok);
          return bad ? { state: 'invalid', reason: `a listed event is ${eventPromotable(bad, now).reason}` } : { state: 'valid' };
        }
        // No recorded list (a hand-made or older post): at least some upcoming public events must remain.
        const { data, error } = await svc.from('events').select('id,title,starts_at,status,is_hidden,organiser_hub_id,calendar_approved').eq('status', 'published').eq('is_hidden', false).gt('starts_at', now.toISOString()).limit(20);
        if (error) return { state: 'unknown' };
        return ((data ?? []) as EventRow[]).some((e) => eventPromotable(e, now).ok) ? { state: 'valid' } : { state: 'invalid', reason: 'no upcoming events' };
      }
      case 'jobs_roundup': {
        const ids = idsFromLink((post as QueuedPost & { link_url?: string | null }).link_url);
        let q = svc.from('jobs').select('id,status,is_hidden,expires_at');
        q = ids.length ? q.in('id', ids) : q.eq('status', 'open').eq('is_hidden', false).limit(20);
        const { data, error } = await q;
        if (error) return { state: 'unknown' };
        const rows = (data ?? []) as JobRow[];
        if (ids.length) {
          if (rows.length !== ids.length) return { state: 'invalid', reason: 'a listed job no longer exists' };
          const bad = rows.find((j) => !jobPromotable(j, now).ok);
          return bad ? { state: 'invalid', reason: `a listed job is ${jobPromotable(bad, now).reason}` } : { state: 'valid' };
        }
        return rows.some((j) => jobPromotable(j, now).ok) ? { state: 'valid' } : { state: 'invalid', reason: 'no open jobs' };
      }
      case 'new_product': {
        const { data: p, error } = await svc.from('products').select('id,title,is_active,sold_at,stock_mode,stock,reserved,photos,business_id').eq('id', id).maybeSingle();
        if (error) return { state: 'unknown' };
        if (!p) return { state: 'invalid', reason: 'product no longer exists' };
        const { data: b } = await svc.from('local_businesses').select('name,is_active').eq('id', (p as { business_id: string }).business_id).maybeSingle();
        const { data: vs } = await svc.from('product_variants').select('stock,reserved,is_active').eq('product_id', id);
        const { data: hidden } = await svc.rpc('is_discovery_hidden', { p_entity: 'business', p_id: (p as { business_id: string }).business_id });
        const v = productPromotable(p as ProductRow, (vs ?? []) as VariantRow[], b?.name ?? null, b?.is_active === true, hidden === true);
        return v.ok ? { state: 'valid' } : { state: 'invalid', reason: `product ${v.reason}` };
      }
      case 'game_challenge': return { state: 'valid' };
      case 'regular_roundup': return await revalidateRoundup(svc, post, now);
      case 'accessible_info': return await revalidateAccessible(svc, post, now);
      default: return { state: 'valid' };
    }
  } catch { return { state: 'unknown' }; }
}

const addDaysYmd = (ymd: string, n: number): string => { const [y, m, dd] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, dd + n)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`; };

/** The latest selection, left where staff can read it (admin_config). Best effort: never blocks a run. */
async function writeSnapshot(svc: Svc, key: string, report: unknown): Promise<void> {
  try { await svc.from('admin_config').upsert({ key, value: JSON.stringify(report), category: 'social', description: 'Latest Social Studio selection snapshot (read-only).', is_secret: false }, { onConflict: 'key' }); } catch { /* ignore */ }
}
/** When a recipe has nothing to post, say why in Social Studio as a skipped row (one per period, refreshed rather than duplicated). */
async function recordSkippedRow(svc: Svc, kind: string, entityType: string, entityId: string, reason: string, now: Date): Promise<void> {
  try {
    const { data: ex } = await svc.from('social_posts').select('id').eq('kind', kind).eq('entity_id', entityId).limit(1);
    if (ex && ex.length) { await svc.from('social_posts').update({ error: reason }).eq('id', ex[0].id); return; }
    await svc.from('social_posts').insert({ kind, entity_type: entityType, entity_id: entityId, caption: '(nothing to post)', status: 'skipped', error: reason, scheduled_for: now.toISOString() });
  } catch { /* ignore */ }
}

/* ── Orchestration ─────────────────────────────────────────────────────────────────────────────────────────────── */

export type ComposeDeps = {
  svc: Svc;
  now: Date;
  recipes: Map<string, { key: string; enabled: boolean; autopilot: boolean; config: Record<string, unknown> }>;
  force?: boolean;
  /** Optional caption warm-up (the composer's polishCaption); never used for FACTUAL kinds. */
  polish?: (template: string, context: string) => Promise<string>;
  rand?: () => number;
  /** Shared slot context (limits + queued posts). Omit to load it. */
  ctx?: SlotContext;
  /** Network access for link checks (tests inject a stub). */
  fetchFn?: typeof fetch;
  /** Build and report drafts but insert nothing: the preview path for staff and tests. */
  dryRun?: boolean;
};
export type DryRunDraft = { kind: string; entity_id: string; caption: string; image_url: string | null; link_url: string; image_alt?: string; held: boolean; note?: string; scheduled_for: string };
export type ComposeResult = Record<NewKind, number> & { errors: string[]; skipped: Record<string, string>; drafts?: DryRunDraft[] };

const PENDING_STATUSES = ['draft', 'approved', 'scheduled'];
const periodKey = (id: string, now: Date, days: number) => `${id}:${Math.floor(now.getTime() / (days * 86400_000))}`;

export async function composeNewRecipes(d: ComposeDeps): Promise<ComposeResult> {
  const { svc, now } = d;
  const out = Object.fromEntries(NEW_KINDS.map((k) => [k, 0])) as unknown as ComposeResult; out.errors = []; out.skipped = {}; if (d.dryRun) out.drafts = [];
  const active = ORDER.filter((k) => d.recipes.get(k)?.enabled === true);
  if (!active.length) return out;

  // Shared limits + everything already queued (the original recipes' posts included) — the same context the original recipes use.
  const ctx = d.ctx ?? await loadSlotContext(svc, now);   // the composer passes the one it already used for the original recipes
  const { maxPerDay, gapMinutes, windowStartHour, windowEndHour } = ctx;

  // One run never creates more than a day's worth of posts across ALL new recipes, however many are switched on or how much content exists.
  let runBudget = maxPerDay;

  for (const kind of active) {
    if (runBudget <= 0) { out.skipped[kind] = 'run budget used'; continue; }
    const r = d.recipes.get(kind)!;
    const cfg = { ...DEFAULTS[kind], ...(r.config ?? {}) } as Record<string, unknown>;
    try {
      const today = londonParts(now);
      const days = cfg.weekdays as string[] | undefined;
      if (!d.force && days && !days.includes(today.weekday)) { out.skipped[kind] = `not a posting day (${today.weekday})`; continue; }

      // Retire this recipe's OWN stale, never-reviewed drafts so unreviewed drafts cannot pile up into another backlog.
      // (Only the new kinds; nothing older is touched.)
      if (!d.dryRun) await svc.from('social_posts').update({ status: 'skipped', error: 'stale: never reviewed' })
        .eq('kind', kind).eq('status', 'draft').lt('scheduled_for', new Date(now.getTime() - 48 * 3600_000).toISOString());

      const { data: mine } = await svc.from('social_posts').select('entity_id,status,created_at,scheduled_for').eq('kind', kind).order('created_at', { ascending: false }).limit(300);
      const history = (mine ?? []) as { entity_id: string | null; status: string; created_at: string; scheduled_for: string | null }[];
      const pending = history.filter((h) => PENDING_STATUSES.includes(h.status) && (!h.scheduled_for || new Date(h.scheduled_for).getTime() >= now.getTime() - 48 * 3600_000)).length;
      if (!d.force && pending >= Number(cfg.max_pending ?? 3)) { out.skipped[kind] = `${pending} awaiting review/posting`; continue; }
      if (cfg.max_per_week && history.filter((h) => now.getTime() - new Date(h.created_at).getTime() < 7 * 86400_000).length >= Number(cfg.max_per_week)) { out.skipped[kind] = 'weekly limit'; continue; }
      if (kind === 'essential_alert') {
        const recent = history[0];
        if (recent && (now.getTime() - new Date(recent.created_at).getTime()) / 3600_000 < Number(cfg.min_hours_between ?? 6)) { out.skipped[kind] = 'too soon after previous alert post'; continue; }
      }

      // A recipe that runs less often than its posting day (Accessible Shetland: fortnightly) says so with min_days_between.
      if (!d.force && Number(cfg.min_days_between ?? 0) > 0) {
        const lastMade = history.find((h) => !['skipped', 'failed'].includes(h.status));
        if (lastMade && (now.getTime() - new Date(lastMade.created_at).getTime()) / 86400_000 < Number(cfg.min_days_between)) { out.skipped[kind] = `posted within the last ${cfg.min_days_between} days`; continue; }
      }

      let cands: Candidate[] = [];
      let postDayOnly: string | null = null;
      if (kind === 'notice_update') cands = await selectNotices(svc, cfg, now);
      else if (kind === 'essential_alert') cands = await selectAlerts(svc, cfg, now);
      else if (kind === 'aald_memory') cands = await selectMemories(svc, cfg);
      else if (kind === 'business_spotlight') { const sp = await selectSpotlight(svc, cfg, now); cands = sp.candidates; await writeSpotlightSnapshot(svc, sp.report); }
      else if (kind === 'hub_community') cands = await selectHubs(svc, cfg, now);
      else if (kind === 'game_challenge') cands = await selectGames(svc, cfg, now);
      else if (kind === 'cruise_visit') cands = await selectCruise(svc, cfg, now);
      else if (kind === 'regular_roundup') {
        const r = await selectRoundup(svc, cfg, now); cands = r.candidate ? [{ ...r.candidate, imageAlt: r.imageAlt }] : []; postDayOnly = r.report.postDay;
        if (!d.dryRun) await writeSnapshot(svc, 'social.regular_roundup_last', r.report);
        if (!r.candidate) { out.skipped[kind] = r.report.reason ?? 'nothing eligible'; if (!d.dryRun) await recordSkippedRow(svc, kind, 'week', `reg:${r.report.monday}:skip`, r.report.reason ?? 'nothing eligible', now); }
      } else if (kind === 'accessible_info') {
        const r = await selectAccessible(svc, cfg, now, d.fetchFn); cands = r.candidate ? [{ ...r.candidate, imageAlt: r.imageAlt }] : [];
        if (!d.dryRun) await writeSnapshot(svc, 'social.accessible_info_last', r.report);
        if (!r.candidate) { out.skipped[kind] = r.report.reason ?? 'nothing eligible'; if (!d.dryRun) await recordSkippedRow(svc, kind, 'fortnight', `access:${londonParts(now).ymd}:skip`, r.report.reason ?? 'nothing eligible', now); }
      }

      // Duplicate prevention. Single-use kinds: entity ever used. Rotating kinds: per period (business 90d, hub 30d). Games: per ISO week.
      const repeat = kind === 'business_spotlight' ? 0 : Number(cfg.repeat_after_days ?? 0);   // the spotlight applies its own, status-aware rule
      const keyOf = (c: Candidate) => (repeat > 0 ? periodKey(c.entity_id, now, repeat) : c.entity_id);
      // At most ONE Business Spotlight on any day: days that already have one (queued, scheduled or published) are skipped when placing the next.
      const spotlightDays = new Set<string>(kind === 'business_spotlight' ? history.filter((h) => ['draft', 'approved', 'scheduled', 'posted'].includes(h.status) && h.scheduled_for).map((h) => londonParts(new Date(h.scheduled_for as string)).ymd) : []);
      const used = new Set(history.map((h) => h.entity_id));
      const usedByEntity = (c: Candidate) => (repeat > 0 ? history.some((h) => (h.entity_id ?? '').split(':')[0] === c.entity_id && now.getTime() - new Date(h.created_at).getTime() < repeat * 86400_000) : used.has(c.entity_id));
      if (kind === 'regular_roundup' || kind === 'accessible_info') {
        // One roundup per week; one Accessible post per run. A skipped or failed one may be regenerated (a revision suffix keeps the unique key free), up to a limit.
        const c0 = cands[0];
        if (c0) {
          const same = history.filter((h) => h.entity_id && !h.entity_id.endsWith(':skip') && (kind === 'regular_roundup' ? h.entity_id.startsWith(c0.entity_id) : h.entity_id === c0.entity_id || h.entity_id.startsWith(`${c0.entity_id}:r`)));
          if (kind === 'regular_roundup' && same.some((h) => ['draft', 'approved', 'scheduled', 'posted'].includes(h.status))) { cands = []; out.skipped[kind] = 'already drafted or posted for this week'; }
          else if (same.length > Number(cfg.max_regenerations ?? 2)) { cands = []; out.skipped[kind] = 'regeneration limit reached'; }
          else if (same.length) c0.entity_id = `${c0.entity_id}:r${same.length + 1}`;
        }
      } else if (kind !== 'business_spotlight') cands = cands.filter((c) => !usedByEntity(c));

      const maxRun = Math.min(Number(cfg.max_per_run ?? 1), runBudget);
      let made = 0;
      for (const c of cands) {
        if (made >= maxRun) break;
        // Will this post be a draft (review-only recipe, alert, sensitive business)? Drafts space themselves against everything; real posts only against real posts.
        const held = kind === 'essential_alert' || c.needsApproval === true;
        const asDraft = kind === 'essential_alert' || (c.needsApproval !== true && r.autopilot !== true);   // a sensitive hold still keeps a real slot
        const slot = allocateSlot({
          now, preferredHour: typeof cfg.hour === 'number' ? cfg.hour : null, taken: asDraft ? [...ctx.taken, ...ctx.draftTaken] : ctx.taken, gapMinutes, maxPerDay,
          windowStartHour, windowEndHour, horizonDays: postDayOnly ? 7 : 3, rand: d.rand,
          excludeDays: kind === 'business_spotlight' ? spotlightDays : postDayOnly ? new Set(Array.from({ length: 8 }, (_, n) => addDaysYmd(londonParts(now).ymd, n)).filter((y) => y !== postDayOnly)) : undefined,
        });
        if (!slot) { out.skipped[kind] = 'no free slot in the next 3 days'; break; }
        let caption = c.caption;
        if (cfg.polish === true && !FACTUAL.has(kind) && d.polish) {
          const polished = await d.polish(c.caption, c.context);
          // Never accept a rewrite that lost the link or, for games, could name an answer.
          if (polished.includes(c.link_url) && (kind !== 'game_challenge' || !/answer|solution/i.test(polished))) caption = polished;
        }
        const status = held ? 'draft' : r.autopilot === true ? 'scheduled' : 'draft';
        if (d.dryRun) { out.drafts!.push({ kind, entity_id: c.entity_id, caption, image_url: c.image_url, link_url: c.link_url, image_alt: c.imageAlt, held: status === 'draft' && (held || r.autopilot !== true), note: c.note, scheduled_for: slot.toISOString() }); (asDraft ? ctx.draftTaken : ctx.taken).push(slot); made++; out[kind]++; runBudget--; continue; }
        const { error } = await svc.from('social_posts').insert({
          // A spotlight's id carries the day it was scheduled, so a later retry after a skipped or failed post never collides with the old row.
          kind, entity_type: c.entity_type, entity_id: kind === 'business_spotlight' ? `${c.entity_id}:${londonParts(slot).ymd}` : repeat > 0 ? keyOf(c) : c.entity_id, business_id: c.business_id ?? null,
          caption, image_url: c.image_url, link_url: c.link_url, scheduled_for: slot.toISOString(), status,
          ...(c.needsApproval ? { error: c.note ?? 'Held for approval' } : {}),
          ...(c.imageAlt ? { image_alt: c.imageAlt } : {}),
        });
        if (error) { out.errors.push(`${kind} insert: ${error.message}`); continue; }
        (asDraft ? ctx.draftTaken : ctx.taken).push(slot); if (kind === 'business_spotlight') spotlightDays.add(londonParts(slot).ymd); made++; out[kind]++; runBudget--;
      }
      if (!made && !out.skipped[kind]) out.skipped[kind] = 'nothing eligible';
      if (!d.dryRun) await svc.from('social_recipes').update({ last_run_at: now.toISOString() }).eq('key', kind);
    } catch (e) { out.errors.push(`${kind}: ${e instanceof Error ? e.message : e}`); }
  }
  return out;
}
