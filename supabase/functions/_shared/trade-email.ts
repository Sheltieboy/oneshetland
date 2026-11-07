/**
 * Pure helpers for the Get it done transactional emails (no network, no secrets: unit-testable).
 * The emails carry the shape of the job only. Never the resident's name, phone or email.
 */

export const SITE_URL = 'https://oneshetland.com';

/** Titles that mark seed/test data. Nothing is ever emailed about these. */
export function isTestJob(title: string | null | undefined): boolean {
  return /^\s*(demo|test|zz)\b/i.test(title ?? '');
}

const TRADE_LABELS: Record<string, string> = {
  joiner: 'Joiner / carpenter', builder: 'Builder', plumber: 'Plumber', electrician: 'Electrician', roofer: 'Roofer',
};
export function tradeLabel(keys: string[] | null | undefined): string {
  const ks = (keys ?? []).filter(Boolean);
  if (ks.length === 0) return 'General';
  return ks.slice(0, 3).map((k) => TRADE_LABELS[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())).join(', ');
}

/**
 * A short, non-sensitive excerpt of the description: URLs, email addresses and anything that looks like a phone number
 * or house number + street are removed, whitespace collapsed, cut at 140 characters on a word boundary.
 */
export function safeSummary(description: string | null | undefined): string {
  let s = (description ?? '').replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, ' ')                                   // phone-like runs of digits
    .replace(/\b\d{1,4}[a-z]?\s+[A-Z][a-z]+\s+(road|street|st|place|drive|avenue|lane|brae|loan|wynd|crescent|gardens)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (s.length > 140) { s = s.slice(0, 140); s = s.slice(0, s.lastIndexOf(' ') > 60 ? s.lastIndexOf(' ') : 140).trim() + '…'; }
  return s || 'Open your job leads to read the details.';
}

/** The general area only: the text the resident typed for "town or area", capped; never anything after a comma-separated street. */
export function generalLocation(location: string | null | undefined): string {
  const first = (location ?? '').split(',').pop()?.trim() || (location ?? '').trim();
  return (first || 'Shetland').slice(0, 60);
}

export interface PrefsRow { enabled?: boolean | null; business_enabled?: boolean | null }
/** Opt-outs are honoured: the master switch for everyone, plus the business switch for a business owner. A missing row means "on". */
export function emailAllowed(prefs: PrefsRow | null | undefined, kind: 'business' | 'resident'): boolean {
  if (!prefs) return true;
  if (prefs.enabled === false) return false;
  if (kind === 'business' && prefs.business_enabled === false) return false;
  return true;
}
