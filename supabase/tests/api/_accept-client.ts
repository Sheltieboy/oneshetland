// _accept-client.ts — signed-in client for the acceptance backend (accept-env.sh). Every call is made AS a user: real GoTrue sign-in, their own JWT, PostgREST + RLS.
// `owner()` (psql as the database owner) is used ONLY to read database state for verification, or to set up clock/quiet-hour conditions a test needs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as createHmacLib from 'node:crypto';
export const URL_ = process.env.ACCEPT_URL ?? 'http://127.0.0.1:54800';
export const ANON = readFileSync('/tmp/accept-anon.txt', 'utf8').trim();
export const SEED = JSON.parse(readFileSync('/tmp/accept-users.json', 'utf8')) as { password: string; ids: Record<string, string>; hub: string; business: string };
export type Session = { token: string; id: string };
const sessions = new Map<string, Session>();
export async function login(k: string): Promise<Session> {
  const hit = sessions.get(k); if (hit) return hit;
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email: `${k}@accept.test`, password: SEED.password }) });
  const j = await r.json() as { access_token?: string; user?: { id: string } };
  if (!j.access_token) throw new Error(`sign-in failed for ${k}: ${JSON.stringify(j)}`);
  const s = { token: j.access_token, id: j.user!.id }; sessions.set(k, s); return s;
}
export type Res<T = any> = { status: number; data: T; error: { code?: string; message?: string } | null };
async function send(token: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: { apikey: ANON, authorization: `Bearer ${token ?? ANON}`, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let data: any = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { status: r.status, data, error: r.status >= 400 ? (data && typeof data === 'object' ? { code: data.code, message: data.message ?? data.error } : { message: String(data) }) : null };
}
/** rpc as user `k` (or anonymously with null) */
export const rpc = async (k: string | null, fn: string, args: Record<string, unknown> = {}) => send(k ? (await login(k)).token : null, 'POST', `rpc/${fn}`, args);
export const table = async (k: string | null, method: string, path: string, body?: unknown, prefer = 'return=representation') => send(k ? (await login(k)).token : null, method, path, body, { prefer });
export const serviceToken = () => { const c = createHmacLib; const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url'); const h = b({ alg: 'HS256', typ: 'JWT' }), p = b({ iss: 'accept', role: 'service_role', exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${c.createHmac('sha256', 'a-proof-only-secret-that-is-at-least-32-characters-long').update(`${h}.${p}`).digest('base64url')}`; };
export const owner = (q: string) => execFileSync('docker', ['exec', '-i', 'notices-accept-pg', 'psql', '-U', 'postgres', '-h', 'localhost', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
export const iso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
