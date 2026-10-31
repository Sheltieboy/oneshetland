/**
 * notice-publisher.ts — who a notice says it is from, and how to show it. Mirrors public.notice_publisher_display() so web, app and edge code agree.
 *
 * RULES (Notices Stage 3A.2)
 *   hub        "Posted by <hub name>", the hub's logo and brand colour, links to the hub page
 *   business   "Posted by <business name>", the business's logo, links to the business page
 *   person     "Posted by <display name>" (only a name the database released for a public notice), a generic member mark, NO link;
 *              no display name -> "A OneShetland member"; account gone (publisher_user_id NULL) -> "Former member"
 *   platform   "OneShetland" / "Posted by OneShetland", OneShetland branding, no link
 *   official   the database's source_label / "Source: <source_label>" / "View at source" when source_url is a valid http(s) URL. OneShetland is
 *              never presented as the author. Nothing here invents a source label.
 *
 * The KIND comes from the database (the generated `publisher_kind` column, or the flags it is generated from). It is never inferred from
 * whichever joined table happened to return a row: the joins only supply the name / logo / colour of the publisher the kind already names.
 * A person's name is never read from profiles (private): it comes from the notice_publisher_display RPC, which releases it only while the
 * notice is public. No generic "Member" label exists for notices; the last-resort labels are accurate ("Community hub", "Local business").
 *
 * Pure: no imports, so it runs in the app, the website, the edge runtime and `node --test`. The same file lives in all three places; each
 * repo's test pins the same golden vectors so the copies cannot drift unnoticed.
 */
export type NoticePublisherKind = 'platform' | 'hub' | 'business' | 'person';
/** Which identity mark to draw when there is no logo. */
export type NoticeMark = 'hub' | 'business' | 'person' | 'platform' | 'official-source';

export type PublisherRef = { id?: string | null; name?: string | null; logo_url?: string | null; brand_color?: string | null; slug?: string | null } | null;

export type NoticePublisherInput = {
  /** The database's generated column; authoritative when present. */
  publisher_kind?: string | null;
  is_platform_notice?: boolean | null;
  is_person_notice?: boolean | null;
  publisher_hub_id?: string | null;
  publisher_business_id?: string | null;
  /** NULL (not merely missing) means the account that posted a person notice no longer exists. */
  publisher_user_id?: string | null;
  source?: string | null;
  source_label?: string | null;
  source_url?: string | null;
  /** Embedded rows for the publisher the kind names (hub:hubs(...), business:local_businesses(...)). */
  hub?: PublisherRef;
  business?: PublisherRef;
  /** Released by notice_publisher_display for a person notice that is public; never read from profiles. */
  person_name?: string | null;
  /** Flat names, kept for callers that only have a name. */
  hub_name?: string | null;
  business_name?: string | null;
};

export type NoticeDestination = { type: 'hub' | 'business'; id: string; slug: string | null };

export type NoticePublisher = {
  kind: NoticePublisherKind;
  label: string;
  byline: string;
  is_official_source: boolean;
  source_label: string | null;
  /** Only ever a valid http(s) URL. */
  source_url: string | null;
  logo_url: string | null;
  brand_color: string | null;
  mark: NoticeMark;
  /** The existing hub / business page, or null when the publisher has none (person, platform, official source). */
  destination: NoticeDestination | null;
};

const clean = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const KINDS: readonly string[] = ['platform', 'hub', 'business', 'person'];

/** http(s) only: a database value that is not a web link is not shown as one. */
export function safeSourceUrl(v: string | null | undefined): string | null {
  const s = clean(v);
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
}

/** The database's own answer, else the flags it is generated from. */
export function resolveKind(n: NoticePublisherInput): NoticePublisherKind {
  if (typeof n.publisher_kind === 'string' && KINDS.includes(n.publisher_kind)) return n.publisher_kind as NoticePublisherKind;
  if (n.is_platform_notice) return 'platform';
  if (n.is_person_notice) return 'person';
  if (n.publisher_hub_id) return 'hub';
  return 'business';
}

export function noticePublisher(n: NoticePublisherInput): NoticePublisher {
  const kind = resolveKind(n);
  const base = { is_official_source: false, source_label: null, source_url: null, logo_url: null, brand_color: null, destination: null } as const;

  if (kind === 'platform') {
    if (clean(n.source)) {
      // An official import: the source speaks, OneShetland does not.
      const label = clean(n.source_label) ?? 'Official source';
      return { ...base, kind, label, byline: clean(n.source_label) ? `Source: ${label}` : label, is_official_source: true, source_label: label, source_url: safeSourceUrl(n.source_url), mark: 'official-source' };
    }
    return { ...base, kind, label: 'OneShetland', byline: 'Posted by OneShetland', mark: 'platform' };
  }

  if (kind === 'person') {
    const label = n.publisher_user_id === null ? 'Former member' : clean(n.person_name) ?? 'A OneShetland member';
    return { ...base, kind, label, byline: `Posted by ${label}`, mark: 'person' };
  }

  if (kind === 'hub') {
    const id = clean(n.hub?.id) ?? clean(n.publisher_hub_id);
    const label = clean(n.hub?.name) ?? clean(n.hub_name) ?? 'Community hub';
    return {
      ...base, kind, label, byline: `Posted by ${label}`, mark: 'hub', logo_url: clean(n.hub?.logo_url), brand_color: clean(n.hub?.brand_color),
      destination: id ? { type: 'hub', id, slug: clean(n.hub?.slug) } : null,
    };
  }

  const id = clean(n.business?.id) ?? clean(n.publisher_business_id);
  const label = clean(n.business?.name) ?? clean(n.business_name) ?? 'Local business';
  return {
    ...base, kind, label, byline: `Posted by ${label}`, mark: 'business', logo_url: clean(n.business?.logo_url), brand_color: clean(n.business?.brand_color),
    destination: id ? { type: 'business', id, slug: clean(n.business?.slug) } : null,
  };
}
