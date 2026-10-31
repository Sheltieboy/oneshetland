/**
 * accept-functions.ts — LOCAL-ONLY host for the submit-funeral-enquiry Edge Function: the REAL handler (supabase/functions/_shared/funeral-enquiry.ts) running in
 * Node, Cloudflare replaced by _mock-turnstile.ts, Supabase = the isolated acceptance backend. Used by accept-gateway.mjs and by the acceptance tests.
 * The environment below is fictional; the service key is the local HS256 token signed with the throwaway local secret.
 */
import { handleFuneralEnquiry, type EnquiryDeps } from '../../functions/_shared/funeral-enquiry.ts';
import { makeFetch } from './_mock-turnstile.ts';
import { assertIsolated } from '../_support/isolation.ts';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';

const GATEWAY = process.env.ACCEPT_URL ?? 'http://127.0.0.1:54800';
assertIsolated({ SUPABASE_URL: GATEWAY });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SECRET = 'a-proof-only-secret-that-is-at-least-32-characters-long';
const jwt = (role: string) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'accept', role, exp: Math.floor(Date.now() / 1000) + 86400 }); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };

export const LOCAL_ENV: Record<string, string> = {
  TURNSTILE_SECRET_KEY: 'mock-secret-key',
  TURNSTILE_ALLOWED_HOSTNAMES: 'localhost',
  FUNERAL_ENQUIRY_ALLOWED_ORIGINS: 'http://localhost:3011,http://127.0.0.1:3011,http://localhost:3012',
  FUNERAL_ENQUIRY_IP_SALT: 'local-test-salt-not-a-secret-0123456789',
  SUPABASE_URL: GATEWAY,
  SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'),
};
export const localDeps = (over: Partial<Record<string, string | undefined>> = {}): EnquiryDeps => ({ env: (k) => (k in over ? over[k] : LOCAL_ENV[k]), fetch: makeFetch() });
export const handleLocal = (req: Request, over: Partial<Record<string, string | undefined>> = {}) => handleFuneralEnquiry(req, localDeps(over));
void readFileSync;

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// notify-notice-audience, LOCAL: the REAL shared handler (functions/_shared/notice-audience.ts); the caller is identified by the local GoTrue; every database call
// is PostgREST on the isolated backend; the push sender is a MOCK that records what would have been sent and sends nothing, anywhere.
import { handleNoticeAudience, type Caller } from '../../functions/_shared/notice-audience.ts';
import type { PushStatus } from '../../functions/_shared/notice-dispatch.ts';

export const push = {
  log: [] as { userId: string; title: string; body: string; kind: string; noticeId: string }[],
  /** per-user scripted outcomes consumed in order ('sent' | 'error' | 'no_token' | 'throw'); anything not scripted is 'sent' */
  script: new Map<string, string[]>(),
  reset() { this.log.length = 0; this.script.clear(); },
};
const mockPush = async (userId: string, text: { title: string; body: string }, ctx: { kind: string; noticeId: string }): Promise<{ status: PushStatus; error?: string }> => {
  const next = push.script.get(userId)?.shift() ?? 'sent';
  push.log.push({ userId, title: text.title, body: text.body, kind: ctx.kind, noticeId: ctx.noticeId });   // the attempt is recorded even if it "fails"
  if (next === 'throw') throw new Error('mock transport crashed');
  if (next === 'error') return { status: 'error', error: 'mock provider error' };
  if (next === 'no_token') return { status: 'no_token' };
  return { status: 'sent' };
};
const svcHeaders = { apikey: LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
const lf = makeFetch();
export const localRpc = async (fn: string, args: Record<string, unknown>) => {
  const r = await lf(`${GATEWAY}/rest/v1/rpc/${fn}`, { method: 'POST', headers: svcHeaders, body: JSON.stringify(args) });
  const t = await r.text(); let data: unknown = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return r.ok ? { data, error: null } : { data: null, error: { message: String((data as { message?: string })?.message ?? t), code: (data as { code?: string })?.code } };
};
export const handleAudienceLocal = (req: Request): Promise<Response> => handleNoticeAudience(req, {
  cors: { 'Access-Control-Allow-Origin': req.headers.get('origin') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' },
  authenticate: async (r): Promise<{ caller: Caller } | { denied: Response }> => {
    const raw = (r.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const deny = (s: number) => ({ denied: new Response(JSON.stringify({ error: 'Unauthorised' }), { status: s, headers: { 'Content-Type': 'application/json' } }) });
    if (!raw) return deny(401);
    if (raw === LOCAL_ENV.SUPABASE_SERVICE_ROLE_KEY) return { caller: { userId: '', isServiceRole: true } };
    const anon = readFileSync('/tmp/accept-anon.txt', 'utf8').trim();
    const u = await lf(`${GATEWAY}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${raw}` } });
    if (!u.ok) return deny(401);
    const id = (await u.json() as { id?: string }).id;
    return id ? { caller: { userId: id, isServiceRole: false } } : deny(401);          // the anon key has no user: refused
  },
  rpc: localRpc as never,
  loadNotice: async (id) => { const r = await lf(`${GATEWAY}/rest/v1/notices?id=eq.${id}&select=id,title,body,action_text`, { headers: svcHeaders }); const rows = await r.json() as never[]; return (rows[0] as never) ?? null; },
  push: mockPush,
});
