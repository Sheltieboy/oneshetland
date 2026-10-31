/**
 * load-send-push.ts — loads the REAL supabase/functions/_shared/send-push.ts in Node (same source, byte for byte apart from its one Deno import line, which is
 * pointed at a stub) so tests exercise the actual preference logic, with a fake Supabase client and a MOCK Expo endpoint. Nothing here can reach Expo, Supabase
 * or the internet: the mock `fetch` answers exp.host itself and refuses every other non-loopback host.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export type SendPushModule = typeof import('../../functions/_shared/send-push.ts');

export async function loadSendPush(): Promise<SendPushModule> {
  const dir = mkdtempSync(join(tmpdir(), 'send-push-'));
  writeFileSync(join(dir, 'stub.mjs'), `export const createClient = () => { throw new Error('createClient is not available in tests'); }; export class SupabaseClient {}`);
  const src = readFileSync(process.env.SEND_PUSH_SOURCE ?? join(ROOT, 'supabase/functions/_shared/send-push.ts'), 'utf8')   // SEND_PUSH_SOURCE: a MUTATED copy, used only to prove these tests catch the old fail-open behaviour
    .replace("'https://esm.sh/@supabase/supabase-js@2'", "'./stub.mjs'");
  if (/https?:\/\//.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/'https:\/\/exp\.host[^']*'/g, ''))) throw new Error('an unexpected URL remains in send-push.ts');
  writeFileSync(join(dir, 'send-push.ts'), src);
  return import(pathToFileURL(join(dir, 'send-push.ts')).href);
}

export type ExpoCall = { to: string; title: string; body: string; categoryId?: string };
/** a fake Supabase client: rpc is scripted; push_tokens / profiles / notification_log are in memory; everything is recorded */
export function fakeClient(o: {
  should?: (args: { p_user_id: string; p_module: string; p_urgent: boolean }, n: number) => Promise<{ data: unknown; error: unknown }> | { data: unknown; error: unknown };
  tokens?: string[]; legacy?: string | null;
}) {
  const rec = { rpc: [] as any[], logs: [] as any[], pruned: [] as string[] };
  const tokens = [...(o.tokens ?? ['ExponentPushToken[aaaa]'])];
  const chain = (result: () => unknown) => { const c: any = { select: () => c, eq: () => c, delete: () => c, update: () => c, maybeSingle: () => Promise.resolve(result()), then: (r: any, j: any) => Promise.resolve(result()).then(r, j) }; return c; };
  const client: any = {
    rpc: (fn: string, args: any) => { rec.rpc.push({ fn, args }); return Promise.resolve(fn === 'should_notify' ? o.should!(args, rec.rpc.filter((r) => r.fn === 'should_notify').length) : { data: null, error: null }); },
    from: (table: string) => {
      if (table === 'push_tokens') { const c = chain(() => ({ data: tokens.map((token) => ({ token })), error: null })); const del = c.delete; c.delete = () => { const d = del(); const e = d.eq; d.eq = (_col: string, v: string) => { rec.pruned.push(v); const i = tokens.indexOf(v); if (i >= 0) tokens.splice(i, 1); return d; }; return d; }; return c; }
      if (table === 'profiles') return chain(() => ({ data: { push_token: o.legacy ?? null }, error: null }));
      if (table === 'notification_log') return { insert: (row: any) => { rec.logs.push(row); return Promise.resolve({ error: null }); } };
      return chain(() => ({ data: null, error: null }));
    },
  };
  return { client, rec };
}

/** a mock Expo: records each message it is asked to send and answers per token ('ok' | 'error' | 'unregistered'); any other host (except loopback) is refused */
type Answer = 'ok' | 'error' | 'unregistered';
export function mockExpo(answers: Record<string, Answer | Answer[]> = {}) {
  const sent: ExpoCall[] = []; const real = globalThis.fetch;
  const fetch = (async (u: any, init: any) => {
    const url = new URL(typeof u === 'string' || u instanceof URL ? String(u) : u.url);
    if (url.hostname === 'exp.host') {
      const b = JSON.parse(String(init?.body)); sent.push({ to: b.to, title: b.title, body: b.body, categoryId: b.categoryId });
      const given = answers[b.to]; const a: Answer = Array.isArray(given) ? (given.length > 1 ? given.shift()! : given[0] ?? 'ok') : given ?? 'ok';
      if (a === 'ok') return new Response(JSON.stringify({ data: { status: 'ok', id: 'mock-ticket' } }), { status: 200 });
      if (a === 'unregistered') return new Response(JSON.stringify({ data: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } }), { status: 200 });
      return new Response(JSON.stringify({ data: { status: 'error', message: 'mock provider error' } }), { status: 200 });
    }
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return real(u, init);
    throw new Error(`ISOLATION: the test refused to fetch ${url.hostname}`);
  }) as typeof globalThis.fetch;
  return { sent, install: () => { globalThis.fetch = fetch; }, restore: () => { globalThis.fetch = real; } };
}
