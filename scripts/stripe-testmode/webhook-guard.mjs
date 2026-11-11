#!/usr/bin/env node
// webhook-guard.mjs: keeps Stripe TEST-mode events away from systems that must not receive them (above all the production Supabase project).
//
//   node webhook-guard.mjs plan            --allow FILE                          read-only: list, classify, say what would be disabled
//   node webhook-guard.mjs disable         --allow FILE --approved FILE --state FILE   disable ONLY the ids in the approved file (state saved first)
//   node webhook-guard.mjs restore         --state FILE                          re-enable exactly what the state file recorded, then re-read and verify
//   node webhook-guard.mjs verify-isolated --allow FILE                          read-only: non-zero unless EVERY enabled endpoint is in the allow list
//
// Exit codes: 0 ok | 1 usage/other failure | 2 refused (safety rule) | 3 livemode seen | 4 verification failed (LOUD) | 5 could not read endpoints
// Files: the allow file and the approved-ids file hold one entry per line (# comments). Allow lines: an endpoint id, `host:example.com`, or `url:https://full/url`.
// A PRODUCTION-host endpoint (nkrtmakxygkvxuxriiil.supabase.co) can never be allowed, whatever the file says.
// Stripe calls: read-only GETs everywhere; `stripe post .../webhook_endpoints/{id} -d disabled=true|false` ONLY inside disable/restore (v2 destinations: .../disable and .../enable).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripe, assertTestMode, PRODUCTION_HOST } from './lib/stripe-cli.mjs';

const STATE_DIR = process.env.GUARD_STATE_DIR ?? '/Users/darrenfullerton/Claude/safe-test/state';
const out = (s = '') => process.stdout.write(`${s}\n`);
const loud = (s) => process.stderr.write(`\n!!!!!!!!!!!!!!!! ${s} !!!!!!!!!!!!!!!!\n\n`);
class Refuse extends Error { constructor(m, code = 2) { super(m); this.exit = code; } }

export function parseArgs(argv) {
  const [mode, ...rest] = argv; const o = { mode, flags: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (['--allow', '--approved', '--state'].includes(a)) o[a.slice(2)] = rest[++i];
    else if (a === '--allow-v2-unreadable') o.flags.add('v2-unreadable');
    else throw new Refuse(`unknown argument ${a}`, 1);
  }
  return o;
}
const readLines = (p, what) => { if (!p) throw new Refuse(`--${what} FILE is required`, 1); if (!existsSync(p)) throw new Refuse(`${what} file not found: ${p}`, 1);
  return readFileSync(p, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean); };

export const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };
export function classify(ep, allow) {
  const host = hostOf(ep.url);
  if (host === PRODUCTION_HOST || (ep.url ?? '').includes(PRODUCTION_HOST)) return 'PRODUCTION';
  const A = allow ?? [];
  if (A.includes(ep.id) || A.includes(`host:${host}`) || A.includes(`url:${ep.url}`)) return 'ALLOWED';
  return 'OTHER';
}
const norm = (x, kind) => kind === 'v1'
  ? { id: x.id, kind, status: x.status, url: x.url ?? null, enabled_events: [...(x.enabled_events ?? [])], api_version: x.api_version ?? null, description: x.description ?? null, metadata: x.metadata ?? {}, connect: x.application ? true : false, application: x.application ?? null, livemode: x.livemode }
  : { id: x.id, kind, status: x.status, url: x.webhook_endpoint?.url ?? null, enabled_events: [...(x.enabled_events ?? [])], api_version: x.events_from ? JSON.stringify(x.events_from) : (x.snapshot_api_version ?? null), description: x.description ?? x.name ?? null, metadata: x.metadata ?? {}, connect: Array.isArray(x.events_from) ? x.events_from.includes('other_account') : false, application: null, livemode: x.livemode, type: x.type };

/** Read every endpoint. v1 must succeed. v2 must succeed unless --allow-v2-unreadable (then a LOUD note: isolation cannot be proven for v2 destinations). */
export function listAll(flags = new Set(), call = stripe) {
  const all = []; let after = null;
  for (let page = 0; page < 50; page++) {
    const r = call('GET', '/v1/webhook_endpoints', { query: [['limit', '100'], ...(after ? [['starting_after', after]] : [])] });
    if (!r.ok) throw new Refuse(`cannot read /v1/webhook_endpoints (${r.status}): ${r.body?.error?.message}`, 5);
    assertTestMode(r.body, 'webhook endpoint list');
    for (const x of r.body.data ?? []) all.push(norm(x, 'v1'));
    if (!r.body.has_more) break; after = r.body.data.at(-1).id;
  }
  let v2note = null; let pageUrl = null;
  for (let page = 0; page < 50; page++) {
    // the CLI's v2 GET takes no -d limit (it answers 502 with a hint); further pages need ONE `data` JSON param
    const r = call('GET', '/v2/core/event_destinations', { query: pageUrl ? [['data', JSON.stringify({ page: pageUrl })]] : [] });
    if (!r.ok) { v2note = `v2 event destinations NOT READABLE (${r.status}): ${r.body?.error?.message}`; if (!flags.has('v2-unreadable')) throw new Refuse(`${v2note}. Pass --allow-v2-unreadable only if you have checked the Dashboard yourself.`, 5); break; }
    assertTestMode(r.body, 'event destination list');
    for (const x of r.body.data ?? []) if (!all.some((e) => e.id === x.id)) all.push(norm(x, 'v2'));   // the SAME endpoint appears in v1 (with its URL) and v2 (URL hidden): v1 wins, one entry per id
    if (!r.body.next_page_url && !r.body.next_page) break; pageUrl = r.body.next_page ?? r.body.next_page_url;
  }
  return { all, v2note };
}
const row = (e, cls) => `${cls.padEnd(10)} ${e.kind} ${String(e.id).padEnd(30)} ${String(e.status).padEnd(9)} ${e.connect ? 'connect ' : 'account '} ${e.url}  [${(e.enabled_events ?? []).length} events]`;

const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameSorted = (a, b) => eqJson([...(a ?? [])].sort(), [...(b ?? [])].sort());
const sortKeys = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([x], [y]) => x.localeCompare(y)));
export function diffEndpoint(orig, now) {
  const d = [];
  if (orig.status !== now.status) d.push(`status ${orig.status} -> ${now.status}`);
  if (orig.url !== now.url) d.push(`url ${orig.url} -> ${now.url}`);
  if (!sameSorted(orig.enabled_events, now.enabled_events)) d.push('enabled_events differ');
  if (orig.api_version !== now.api_version) d.push(`api_version ${orig.api_version} -> ${now.api_version}`);
  if (orig.description !== now.description) d.push('description differs');
  if (!eqJson(sortKeys(orig.metadata), sortKeys(now.metadata))) d.push('metadata differs');
  if (orig.connect !== now.connect) d.push('connect flag differs');
  return d;
}
const writeState = (path, state) => { mkdirSync(dirname(path), { recursive: true }); const t = `${path}.tmp`; writeFileSync(t, JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(t, path); };
const toggle = (ep, enable, call) => ep.kind === 'v1'
  ? call('POST', `/v1/webhook_endpoints/${ep.id}`, { data: [['disabled', enable ? 'false' : 'true']] })
  : call('POST', `/v2/core/event_destinations/${ep.id}/${enable ? 'enable' : 'disable'}`, {});

export function planMode(o, call = stripe) {
  const allow = readLines(o.allow, 'allow'); const { all, v2note } = listAll(o.flags, call);
  out(`Webhook endpoints and event destinations in the TEST account: ${all.length}`);
  const todo = [];
  for (const e of all) { const c = classify(e, allow); out(row(e, c)); if (e.status === 'enabled' && c !== 'ALLOWED') todo.push(e); }
  if (v2note) loud(v2note);
  out(`\nWould be disabled by an approved run (${todo.length}):`); for (const e of todo) out(`  ${e.id}  ${e.url}`);
  out('\nNothing was changed. To act, write the ids you approve (one per line) to a file and pass it to `disable --approved`.');
  return 0;
}

export function disableMode(o, call = stripe) {
  const allow = readLines(o.allow, 'allow'); const approved = readLines(o.approved, 'approved');
  if (!o.state) throw new Refuse('--state FILE is required', 1);
  if (approved.length === 0) throw new Refuse('the approved-ids file is empty: nothing to do', 2);
  const { all } = listAll(o.flags, call); const byId = new Map(all.map((e) => [e.id, e]));
  for (const id of approved) {
    const e = byId.get(id); if (!e) throw new Refuse(`approved id ${id} does not exist in the account: refusing to continue (nothing changed)`);
    if (classify(e, allow) === 'ALLOWED') throw new Refuse(`approved id ${id} is on the allow list: refusing (an allowed endpoint must never be disabled)`);
  }
  // 1. save the COMPLETE original state before any change (merge: a previous crashed run's originals are never overwritten by 'disabled' values)
  const state = existsSync(o.state) ? JSON.parse(readFileSync(o.state, 'utf8')) : { version: 1, created_at: new Date().toISOString(), snapshot_all: all.map((e) => ({ id: e.id, status: e.status, url: e.url })), endpoints: {} };
  for (const id of approved) if (!state.endpoints[id]) state.endpoints[id] = { original: byId.get(id), disabled_by_guard: false };
  state.approved = [...new Set([...(state.approved ?? []), ...approved])]; state.restored_at = null;
  writeState(o.state, state); out(`state saved: ${o.state}`);
  // 2. disable only those that were enabled; idempotent
  let failures = 0;
  for (const id of approved) {
    const rec = state.endpoints[id]; const cur = byId.get(id);
    if (rec.original.status !== 'enabled') { out(`skip ${id}: it was already ${rec.original.status} when first recorded`); continue; }
    if (cur.status === 'disabled') { out(`skip ${id}: already disabled`); rec.disabled_by_guard = true; writeState(o.state, state); continue; }
    const r = toggle(cur, false, call); rec.disabled_by_guard = true; rec.disable_http = r.status; writeState(o.state, state);   // marked BEFORE we trust the result: restore re-enables anyway
    if (!r.ok) { failures++; loud(`could not disable ${id}: ${r.body?.error?.message}`); } else out(`disabled ${id}`);
  }
  // 3. verify
  const after = new Map(listAll(o.flags, call).all.map((e) => [e.id, e]));
  for (const id of approved) if (state.endpoints[id].original.status === 'enabled' && after.get(id)?.status !== 'disabled') { failures++; loud(`${id} is NOT disabled after the attempt`); }
  return failures ? 4 : 0;
}

export function restoreMode(o, call = stripe) {
  if (!o.state || !existsSync(o.state)) throw new Refuse(`state file not found: ${o.state}`, 1);
  const state = JSON.parse(readFileSync(o.state, 'utf8'));
  const { all } = listAll(o.flags, call); const byId = new Map(all.map((e) => [e.id, e]));
  let bad = 0;
  for (const [id, rec] of Object.entries(state.endpoints)) {
    const cur = byId.get(id); if (!cur) { bad++; loud(`${id} no longer exists: cannot restore`); continue; }
    if (rec.original.status === 'enabled' && cur.status !== 'enabled') { const r = toggle(cur, true, call); if (!r.ok) { bad++; loud(`could not re-enable ${id}: ${r.body?.error?.message}`); } else out(`re-enabled ${id}`); }
    else out(`nothing to do for ${id} (originally ${rec.original.status}, now ${cur.status})`);
  }
  // re-read and compare every recorded field to the original
  const fresh = new Map(listAll(o.flags, call).all.map((e) => [e.id, e]));
  for (const [id, rec] of Object.entries(state.endpoints)) {
    const now = fresh.get(id); if (!now) continue;
    const d = diffEndpoint(rec.original, now);
    if (d.length) { bad++; loud(`RESTORE NOT VERIFIED for ${id}: ${d.join('; ')}`); } else out(`verified ${id}: status, url, enabled_events, api_version, description, metadata, connect all identical to the original`);
  }
  for (const s of state.snapshot_all ?? []) if (!state.endpoints[s.id]) { const now = fresh.get(s.id); if (now && (now.status !== s.status || now.url !== s.url)) loud(`WARNING: ${s.id} was not ours but differs from the snapshot taken at disable time (${s.status} -> ${now.status})`); }
  if (bad) { loud('RESTORATION COULD NOT BE VERIFIED: check the Stripe test-mode webhook endpoints by hand NOW and re-run: node webhook-guard.mjs restore --state ' + o.state); return 4; }
  state.restored_at = new Date().toISOString(); writeState(o.state, state); out('restore verified'); return 0;
}

export function verifyIsolatedMode(o, call = stripe) {
  const allow = readLines(o.allow, 'allow'); const { all, v2note } = listAll(o.flags, call);
  const bad = all.filter((e) => e.status === 'enabled' && classify(e, allow) !== 'ALLOWED');
  for (const e of all) out(row(e, classify(e, allow)));
  if (v2note) { loud(v2note); return 4; }
  if (bad.length) { loud(`NOT ISOLATED: ${bad.length} enabled endpoint(s) outside the allow list: ${bad.map((e) => e.id).join(', ')}`); return 2; }
  out('ISOLATED: every enabled endpoint is on the allow list'); return 0;
}

export function main(argv, call = stripe) {
  try {
    const o = parseArgs(argv);
    const modes = { plan: planMode, disable: disableMode, restore: restoreMode, 'verify-isolated': verifyIsolatedMode };
    if (!modes[o.mode]) throw new Refuse('usage: webhook-guard.mjs plan|disable|restore|verify-isolated [--allow F] [--approved F] [--state F] [--allow-v2-unreadable]', 1);
    return modes[o.mode](o, call);
  } catch (e) { if (e.code === 'LIVEMODE') { loud(e.message); return 3; } if (e.exit) { loud(e.message); return e.exit; } console.error(e); return 1; }
}
if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
void STATE_DIR; void join;
