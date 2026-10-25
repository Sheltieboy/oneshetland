/**
 * lib/fetch/mobile.ts — the app-only Fetch v2 rules that have no web equivalent (pure; tested under node).
 *
 *   accessFrom()         the server flag answer → what the Fetch tab shows (fails closed)
 *   lostAccess()         a refusal that means "Fetch is no longer for you" → leave Fetch safely
 *   fetchRouteFor()      a Step 8 notification → the app screen (same paths as the website)
 *   directionsUrl()      collection / delivery directions per platform (Android never gets an Apple Maps link)
 *   photoPlan()          how a picked photo is prepared: every photo is re-encoded as a JPEG on the device, so HEIC becomes
 *                        JPEG, orientation is baked in and the original metadata (location, camera) is not uploaded
 */

export type Access = 'checking' | 'on' | 'off';

/** The flag RPC (fetch_v2_enabled) answers true only for the audience the server allows. Anything else is off. */
export function accessFrom(result: { data: unknown; error: unknown } | null): Exclude<Access, 'checking'> {
  return result && !result.error && result.data === true ? 'on' : 'off';
}

/** Refusals that mean the member can no longer use Fetch at all (flag turned off, signed out, restricted). */
export function lostAccess(code: string): boolean {
  return code === 'fetch_unavailable' || code === 'unauthorised' || code === 'member_restricted';
}

/**
 * The Step 8 notification payload is { screen: 'fetch', route, kind, request_id }. The route is the website path; the app has the same
 * paths, so a known pattern is opened as-is. Anything else (an unknown or admin route, a malformed id) opens the Fetch home, which
 * itself checks the flag — so a stale or disallowed notification fails safely.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTES = [
  new RegExp(`^/fetch/requests/${UUID}$`, 'i'),
  new RegExp(`^/fetch/requests/${UUID}/payment$`, 'i'),
  new RegExp(`^/fetch/jobs/${UUID}$`, 'i'),
  new RegExp(`^/fetch/board/${UUID}$`, 'i'),
  /^\/fetch\/driver\/verification$/,
  /^\/fetch\/(board|history|drive|new)$/,
];
export const FETCH_HOME = '/(tabs)/fetch';
export function fetchRouteFor(data: Record<string, unknown> | null | undefined): string | null {
  if (!data || data.screen !== 'fetch') return null;
  const route = typeof data.route === 'string' ? data.route : '';
  return ROUTES.some((r) => r.test(route)) ? route : FETCH_HOME;
}

/** Directions to an address. iOS: Apple Maps. Android: a geo: intent (the user's maps app). Elsewhere: Google Maps on the web. */
export function directionsUrl(address: string, os: string): string {
  const q = encodeURIComponent(address.trim());
  if (os === 'ios') return `maps://?daddr=${q}`;
  if (os === 'android') return `geo:0,0?q=${q}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
/** If the platform app can't be opened, Google Maps on the web always can. */
export const directionsFallback = (address: string) => directionsUrl(address, 'web');

/** Fetch photos: JPEG/PNG/WEBP only on the server. On the device every pick is re-encoded to a JPEG no larger than this on its long side. */
export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_QUALITY = 0.8;
export function photoPlan(asset: { width?: number; height?: number; mimeType?: string | null; fileSize?: number | null }): {
  resize: { width: number } | { height: number } | null; format: 'jpeg'; mime: 'image/jpeg'; wasHeic: boolean;
} {
  const w = asset.width ?? 0, h = asset.height ?? 0;
  const resize = Math.max(w, h) > PHOTO_MAX_EDGE ? (w >= h ? { width: PHOTO_MAX_EDGE } : { height: PHOTO_MAX_EDGE }) : null;
  return { resize, format: 'jpeg', mime: 'image/jpeg', wasHeic: /hei[cf]/i.test(asset.mimeType ?? '') };
}

/**
 * The old v1 Fetch screens (app/(customer)/*, app/(driver)/*) forward to their v2 replacements, so no v1 screen can be reached and none can
 * write v1 data. Two screens stay: saved addresses (the member's own address book) and payouts (the app's bank set-up, used beyond Fetch).
 * Returns the v2 path, or null to keep the screen.
 */
export function v1Forward(group: string, screen: string | undefined, id?: string | null): string | null {
  const valid = id && new RegExp(`^${UUID}$`, 'i').test(id) ? id : null;
  if (group === '(customer)') {
    if (screen === 'saved-addresses') return null;
    if (screen === 'request') return '/fetch/new';
    if (screen === 'request-detail') return valid ? `/fetch/requests/${valid}` : FETCH_HOME;
    if (screen === 'previous-requests') return '/fetch/history';
    if (screen === 'apply-driver') return '/fetch/drive/apply';
    return FETCH_HOME;
  }
  if (group === '(driver)') {
    if (screen === 'connect-bank') return null;
    if (screen === 'create-run') return '/fetch/journeys/new';
    if (screen === 'request-detail') return valid ? `/fetch/jobs/${valid}` : '/fetch/drive';
    return '/fetch/drive';
  }
  return null;
}
