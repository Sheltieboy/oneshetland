/**
 * function-deps.mjs — what an Edge Function bundle contains, worked out from source.
 *
 * `supabase functions deploy <name>` bundles <name>/index.ts plus every relative file it (transitively) imports, normally from
 * ../_shared. This resolves that closure so the manifest and the pre-deploy guard can compare source against what production runs.
 * Only static relative imports/exports and literal dynamic imports are followed; URLs, npm: and jsr: specifiers are ignored.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, posix } from 'node:path';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;

/** Relative specifiers imported by one source text (comments are stripped first so a commented-out import is not followed). */
export function relativeImports(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const out = new Set();
  for (const m of code.matchAll(IMPORT_RE)) out.add(m[1] ?? m[2]);
  return [...out];
}

/**
 * The bundle a function would deploy: paths relative to `functionsDir`, in posix form, e.g. ['notify-event-update/index.ts', '_shared/send-push.ts'].
 * Throws if an imported file does not exist (a bundle that cannot build).
 */
export function bundleFiles(functionsDir, fnName) {
  const root = resolve(functionsDir);
  const entry = join(root, fnName, 'index.ts');
  if (!existsSync(entry)) throw new Error(`${fnName}: ${posix.join(fnName, 'index.ts')} does not exist`);
  const seen = new Set(); const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of relativeImports(readFileSync(file, 'utf8'))) {
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) throw new Error(`${relative(root, file)} imports ${spec}, which does not exist`);
      stack.push(target);
    }
  }
  return [...seen].map((f) => relative(root, f).split(/[\\/]/).join('/')).sort();
}

/** { 'path': sha256 } for the bundle a function would deploy from this source tree. */
export function bundleHashes(functionsDir, fnName) {
  const out = {};
  for (const rel of bundleFiles(functionsDir, fnName)) out[rel] = sha256(readFileSync(join(functionsDir, rel)));
  return out;
}
