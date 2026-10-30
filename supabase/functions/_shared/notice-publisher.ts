/**
 * notice-publisher.ts — who a notice says it is from. Mirrors public.notice_publisher_display() so web, app and edge code agree.
 *
 * Never "Member": a hub shows its name, a business its name, a person their display name (or "Former member" once the account is gone),
 * OneShetland's own notices say "OneShetland", and an imported official notice shows its source ("Source: NHS Shetland") without OneShetland
 * claiming authorship. Source labels come from the row (set by staff or the trusted importer only), never from the viewer.
 */
export type NoticePublisherKind = 'platform' | 'hub' | 'business' | 'person';

export type NoticePublisherInput = {
  is_platform_notice?: boolean | null;
  is_person_notice?: boolean | null;
  publisher_hub_id?: string | null;
  publisher_business_id?: string | null;
  publisher_user_id?: string | null;
  source?: string | null;
  source_label?: string | null;
  source_url?: string | null;
  hub_name?: string | null;
  business_name?: string | null;
  person_name?: string | null;
};

export type NoticePublisher = {
  kind: NoticePublisherKind;
  label: string;
  byline: string;
  is_official_source: boolean;
  source_label: string | null;
  source_url: string | null;
};

const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function noticePublisher(n: NoticePublisherInput): NoticePublisher {
  const own = { is_official_source: false, source_label: null, source_url: null };
  if (n.is_platform_notice) {
    const label = clean(n.source_label);
    if (clean(n.source) && label) return { kind: 'platform', label, byline: `Source: ${label}`, is_official_source: true, source_label: label, source_url: clean(n.source_url) };
    return { kind: 'platform', label: 'OneShetland', byline: 'Posted by OneShetland', ...own };
  }
  if (n.is_person_notice) {
    const label = n.publisher_user_id ? clean(n.person_name) ?? 'A OneShetland member' : 'Former member';
    return { kind: 'person', label, byline: `Posted by ${label}`, ...own };
  }
  if (n.publisher_hub_id) {
    const label = clean(n.hub_name) ?? 'Community hub';
    return { kind: 'hub', label, byline: `Posted by ${label}`, ...own };
  }
  const label = clean(n.business_name) ?? 'Local business';
  return { kind: 'business', label, byline: `Posted by ${label}`, ...own };
}
