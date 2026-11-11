/**
 * editions-web-handoff-core.ts — the pure rules behind the app -> website hand-off. No network, no database, no secrets: everything here runs under plain node.
 * Design and threat model: docs/editions/APP_HANDOFF_SECURITY.md (web repo). The edge function (editions-web-handoff/index.ts) does the I/O and calls these.
 */

/** The ONLY destinations a code can carry. Keys, never URLs; the path is built in the database from slugs. */
export const DESTINATIONS = ['dashboard', 'editions', 'edition', 'team', 'profile'] as const;
export type Destination = (typeof DESTINATIONS)[number];
export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CODE_TTL_SECONDS = 60;
/** 32 random bytes, base64url without padding. */
export const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh opaque code: 256 bits from the platform CSPRNG. */
export function generateCode(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (equal length enforced by the caller's own length check). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export type MintRequest = { organiser_id: string; destination: Destination; edition_id: string | null; platform: Platform };

/** Validates a mint body. Unknown destinations (a free URL, 'packages', 'promote', 'checkout' ...) are refused here AND again in the database. */
export function parseMintBody(b: unknown): MintRequest | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  if (typeof o.organiser_id !== 'string' || !UUID_RE.test(o.organiser_id)) return null;
  if (typeof o.destination !== 'string' || !(DESTINATIONS as readonly string[]).includes(o.destination)) return null;
  if (typeof o.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(o.platform)) return null;
  const ed = o.edition_id;
  if (o.destination === 'edition') { if (typeof ed !== 'string' || !UUID_RE.test(ed)) return null; }
  else if (ed !== undefined && ed !== null) return null;
  return { organiser_id: o.organiser_id.toLowerCase(), destination: o.destination as Destination, edition_id: o.destination === 'edition' ? String(ed).toLowerCase() : null, platform: o.platform as Platform };
}

/** The website the code is for. Fixed allowlist: a configuration mistake cannot send people to another host. */
const ORIGINS = ['https://oneshetland.com', 'https://www.oneshetland.com'];
export function siteOrigin(configured: string | undefined | null): string {
  const v = (configured ?? '').trim().replace(/\/+$/, '');
  return ORIGINS.includes(v) ? v : ORIGINS[0];
}
/** The code travels in the URL FRAGMENT: browsers never send a fragment to any server, so no log, proxy, CDN or referrer can ever hold it. */
export function handoffUrl(origin: string, code: string): string {
  return `${siteOrigin(origin)}/app-handoff#c=${encodeURIComponent(code)}`;
}

/** The 4-digit check number the app shows and the website asks for. Uniform (rejection sampling), never zero-padded away. */
export const CHECK_RE = /^[0-9]{4}$/;
export function generateCheckNumber(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 10000) * 10000;
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return String(buf[0] % 10000).padStart(4, '0');
}
/** Only this hash is stored with the code: a number alone proves nothing without the code. */
export async function checkHash(codeHash: string, number: string): Promise<string> {
  return sha256Hex(`${codeHash}:${number}`);
}

/** Compares two secrets through equal-length SHA-256 digests, so neither length nor early mismatch is observable. */
export async function secretMatches(secret: string, given: string): Promise<boolean> {
  if (typeof secret !== 'string' || secret.length < 32 || typeof given !== 'string') return false;
  return timingSafeEqual(await sha256Hex(secret), await sha256Hex(given));
}

/** j***@example.com — enough for a person to recognise their own address and nobody else's. */
export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes('@')) return 'your account';
  const [local, domain] = [email.slice(0, email.lastIndexOf('@')), email.slice(email.lastIndexOf('@') + 1)];
  return `${local.slice(0, 1)}***@${domain}`;
}

export interface AuthUserLike { email?: string | null; email_confirmed_at?: string | null; confirmed_at?: string | null; banned_until?: string | null; deleted_at?: string | null }
export interface FactorLike { status?: string }

/**
 * May this account be given a website session? A magic-link sign-in marks an unconfirmed address as confirmed, so the hand-off must refuse unconfirmed
 * accounts itself (it must never bypass email confirmation); it also refuses banned, deleted and MFA-enrolled accounts (a link session is AAL1).
 */
export function accountDecision(u: AuthUserLike | null | undefined, factors: FactorLike[] | null | undefined, now: number = Date.now()): { ok: true; email: string } | { ok: false; reason: string } {
  if (!u) return { ok: false, reason: 'no_user' };
  if (u.deleted_at) return { ok: false, reason: 'deleted' };
  if (u.banned_until) { const t = Date.parse(u.banned_until); if (!Number.isFinite(t) || t > now) return { ok: false, reason: 'banned' }; }
  if (!u.email) return { ok: false, reason: 'no_email' };
  if (!u.email_confirmed_at && !u.confirmed_at) return { ok: false, reason: 'unconfirmed' };
  if ((factors ?? []).some((f) => f?.status === 'verified')) return { ok: false, reason: 'mfa' };
  return { ok: true, email: u.email };
}

/** The website path must be one of the closed set; used again by the website. Packages, promote, checkout, payments, participation and members are never matched. */
export const ALLOWED_PATH = /^\/organise\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/(?:editions|team|profile)|\/editions\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
