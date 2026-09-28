/**
 * load-source.ts — run REAL app source under plain node.
 *
 * The app's auth code imports React Native modules, and two of the files that
 * matter (context/AuthContext.tsx, app/(auth)/sign-in.tsx) contain JSX, so none
 * of it can simply be `import`ed by node's test runner. Rather than restate
 * that logic in a fake, these helpers execute the actual source text:
 *
 *   loadModule(path, stubs)         strips types, replaces each `import` with a
 *                                   stub, and evaluates the module.
 *   extractFunction(src, header)    pulls one function (brace-matched) out of a
 *                                   file — used for a handler that lives inside
 *                                   a React component.
 *   instantiate(fnSource, scope)    evaluates that function with the names it
 *                                   closes over (state setters etc.) supplied.
 *
 * Test-only. Nothing here ships in the app.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const readRepo = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const strip = (src: string) => stripTypeScriptTypes(src, { mode: 'strip' });

/** Rewrites one ES import clause into a destructure of the stub for `mod`. */
function importToStub(clause: string, mod: string): string {
  const ref = `__stubs[${JSON.stringify(mod)}]`;
  const c = clause.trim();
  const ns = c.match(/^\*\s+as\s+(\w+)$/);
  if (ns) return `const ${ns[1]} = ${ref};`;
  const parts: string[] = [];
  const named = c.match(/\{([\s\S]*)\}/);
  const def = c.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();
  if (def) parts.push(`const ${def} = ${ref}.default ?? ${ref};`);
  if (named) {
    const names = named[1].split(',').map((n) => n.trim()).filter(Boolean)
      .map((n) => n.replace(/\s+as\s+/, ': '));
    parts.push(`const { ${names.join(', ')} } = ${ref};`);
  }
  return parts.join(' ');
}

export function loadModule(rel: string, stubs: Record<string, unknown> = {}): Record<string, any> {
  let js = strip(readRepo(rel));
  const missing: string[] = [];

  js = js.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, ''); // side-effect imports
  js = js.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm, (_m, clause, mod) => {
    if (!(mod in stubs)) missing.push(mod);
    return importToStub(clause, mod);
  });
  if (missing.length) throw new Error(`${rel}: no stub supplied for import(s): ${missing.join(', ')}`);

  const exported: string[] = [];
  js = js.replace(/^export\s+(?:default\s+)?(async\s+function|function|const|let|class)\s+(\w+)/gm,
    (_m, kind, name) => { exported.push(name); return `${kind} ${name}`; });

  const body = `${js}\nreturn { ${exported.join(', ')} };`;
  return new Function('__stubs', body)(stubs);
}

/** Returns the full text of `header ... { ... }` with braces matched. */
export function extractFunction(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`function not found: ${header}`);

  // Skip the parameter list, then find the body's opening brace.
  let i = src.indexOf('(', start);
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) { i++; break; }
  }
  i = src.indexOf('{', i);

  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${header}`);
}

/** Evaluates extracted function source with `scope`'s names in closure. */
export function instantiate<T = (...args: any[]) => any>(fnSource: string, scope: Record<string, unknown>): T {
  const js = strip(fnSource);
  const names = Object.keys(scope);
  return new Function(...names, `return (${js});`)(...names.map((n) => scope[n])) as T;
}

/** Evaluates a top-level `const NAME = <expr>;` statement and returns the value. */
export function extractConst(src: string, name: string): any {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?);\\n`));
  if (!m) throw new Error(`const not found: ${name}`);
  return new Function(`${strip(`const __v = ${m[1]};`)}\nreturn __v;`)();
}
