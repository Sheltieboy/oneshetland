/**
 * load-social-fns.ts — runs the REAL social-composer/index.ts, social-publisher/index.ts and _shared/event-occurrence-dates.ts under node.
 * Seams only: Deno `serve` (captures the handler), createServiceClient (the in-memory FakeDb), requireCronSecret (open), getConfig (reads the
 * fake admin_config), Deno.env, and global fetch (records Graph calls, never reaches the network). Time is fixed by replacing global Date.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FakeDb } from './fake-svc.ts';

const FN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'functions');
let n = 0;

async function load(which: 'social-composer' | 'social-publisher', db: FakeDb, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), `${which}-`));
  mkdirSync(join(dir, which)); mkdirSync(join(dir, '_shared'));
  writeFileSync(join(dir, '_shared', 'event-occurrence-dates.ts'), readFileSync(join(FN, '_shared', 'event-occurrence-dates.ts'), 'utf8'));
  let src = readFileSync(join(FN, which, 'index.ts'), 'utf8');
  src = src
    .replace(/import \{ serve \} from '[^']+';/, 'const serve = (h: any) => { (globalThis as any).__handler = h; };')
    .replace(/import \{ createServiceClient \} from '[^']+';/, 'const createServiceClient = () => (globalThis as any).__db;')
    .replace(/import \{ requireCronSecret \} from '[^']+';/, 'const requireCronSecret = (_r: unknown, _c: unknown) => null;')
    .replace(/import \{ getConfig \} from '[^']+';/, "const getConfig = async (s: any, k: string, f: any = null) => { const { data } = await s.from('admin_config').select('value').eq('key', k).maybeSingle(); return data?.value || f; };");
  writeFileSync(join(dir, which, 'index.ts'), src);
  (globalThis as any).__db = db;
  (globalThis as any).Deno = { env: { get: (k: string) => env[k] } };
  await import(pathToFileURL(join(dir, which, 'index.ts')).href + `?v=${++n}`);
  const handler = (globalThis as any).__handler as (r: Request) => Promise<Response>;
  return async (at: Date, body: Record<string, unknown> = {}) => {
    const RealDate = Date;
    const T = at.getTime();
    class FixedDate extends RealDate {
      constructor(...a: any[]) { if (a.length === 0) super(T); else super(...(a as [any])); }
      static now() { return T; }
    }
    (globalThis as any).Date = FixedDate;
    try {
      const res = await handler(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }));
      return await res.json() as Record<string, any>;
    } finally { (globalThis as any).Date = RealDate; }
  };
}

export const loadComposer = (db: FakeDb) => load('social-composer', db, {});

/** Publisher with Meta configured and a recording fetch: returns the runner and the list of Graph calls made. */
export async function loadPublisher(db: FakeDb) {
  const graph: string[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string) => { graph.push(String(url)); return new Response(JSON.stringify({ id: 'fb_1', post_id: 'fb_1' }), { status: 200 }); };
  const run = await load('social-publisher', db, { META_PAGE_ID: 'page', META_PAGE_TOKEN: 'tok' });
  return { run, graph, restore: () => { (globalThis as any).fetch = realFetch; } };
}
