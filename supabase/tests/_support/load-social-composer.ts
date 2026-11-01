/**
 * load-social-composer.ts — runs the REAL social-composer/index.ts and the REAL _shared/social-recipes.ts under node.
 * Three seams only: Deno's `serve` (captures the handler), createServiceClient (hands back the in-memory FakeDb) and requireCronSecret (open).
 * Time is controlled by replacing global Date for the duration of a call. No network: ANTHROPIC_API_KEY is unset so captions are the templates.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FakeDb } from './fake-svc.ts';

const FN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'functions');
let n = 0;

export async function loadComposer(db: FakeDb) {
  const dir = mkdtempSync(join(tmpdir(), 'composer-'));
  mkdirSync(join(dir, 'social-composer')); mkdirSync(join(dir, '_shared'));
  writeFileSync(join(dir, '_shared', 'social-recipes.ts'), readFileSync(join(FN, '_shared', 'social-recipes.ts'), 'utf8'));
  let src = readFileSync(join(FN, 'social-composer', 'index.ts'), 'utf8');
  src = src
    .replace(/import \{ serve \} from '[^']+';/, 'const serve = (h: any) => { (globalThis as any).__composerHandler = h; };')
    .replace(/import \{ createServiceClient \} from '[^']+';/, 'const createServiceClient = () => (globalThis as any).__db;')
    .replace(/import \{ requireCronSecret \} from '[^']+';/, 'const requireCronSecret = (_r: unknown, _c: unknown) => null;');
  writeFileSync(join(dir, 'social-composer', 'index.ts'), src);
  (globalThis as any).__db = db;
  (globalThis as any).Deno = { env: { get: (_k: string) => undefined } };
  await import(pathToFileURL(join(dir, 'social-composer', 'index.ts')).href + `?v=${++n}`);
  const handler = (globalThis as any).__composerHandler as (r: Request) => Promise<Response>;
  /** Runs one composer pass at the given instant and returns its JSON. */
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
