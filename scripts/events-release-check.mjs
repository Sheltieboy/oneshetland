#!/usr/bin/env node
/**
 * events-release-check.mjs — judge the output of supabase/production/events-release/post-apply-checks.sql against post-apply-expectations.json.
 *   supabase db query --linked -f <rendered post-apply-checks.sql> -o json > result.json
 *   node scripts/events-release-check.mjs result.json            (exit 0 = every criterion passed)
 *   node scripts/events-release-check.mjs result.json --expect <criteria.json>   (a different criteria file, e.g. testers-expectations.json)
 * Reads files only; never touches the database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const expectFile = (() => { const i = process.argv.indexOf('--expect'); return i > 0 ? process.argv[i + 1] : null; })();
export const EXPECT = JSON.parse(readFileSync(expectFile ?? join(here, '..', 'supabase/production/events-release/post-apply-expectations.json'), 'utf8')).expect;

/** Accepts the CLI's JSON ({"rows":[{k,v}]}, possibly preceded by log text) or a plain array of {k,v}. */
export function parseRows(text) {
  const a = text.indexOf('['), o = text.indexOf('{');
  const start = o >= 0 && (a < 0 || o < a) ? o : a;
  const end = text[start] === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']');
  const v = JSON.parse(text.slice(start, end + 1));
  return Array.isArray(v) ? v : v.rows;
}

export function judge(rows, expect = EXPECT, relax = {}) {
  const got = new Map(rows.map((r) => [r.k, String(r.v)]));
  const results = [];
  for (const [k, re] of Object.entries(expect)) {
    const pattern = relax[k] ?? re;
    const v = got.get(k);
    results.push({ k, ok: v !== undefined && new RegExp(pattern, 's').test(v), got: v });
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/events-release-check.mjs <result.json>'); process.exit(2); }
  const results = judge(parseRows(readFileSync(file, 'utf8')));
  let bad = 0;
  for (const r of results) { if (!r.ok) bad++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.k}${r.ok ? '' : `   got: ${String(r.got).slice(0, 140)}`}`); }
  console.log(`\n${results.length - bad}/${results.length} criteria passed`);
  process.exit(bad ? 1 : 0);
}
