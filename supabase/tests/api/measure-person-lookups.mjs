// measure-person-lookups.mjs — LOCAL-ONLY. Measures what the person-name lookups cost against the fixture backend (ui-fixture-env.sh start).
//   node supabase/tests/api/measure-person-lookups.mjs
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { loadModule } from '../_support/load-source.ts';
const KEY = readFileSync('/tmp/ui-anon.key', 'utf8').trim();
const pub = loadModule('lib/notice-publisher.ts'); const feed = loadModule('lib/notice-feed.ts', { './notice-publisher': pub });
const sb = createClient('http://127.0.0.1:54790', KEY, { auth: { persistSession: false } });
const stat = async () => (await (await fetch('http://127.0.0.1:54790/__stats')).json()).rpcCount;
const now = () => performance.now();
const rpc = (fn, args) => sb.rpc(fn, args);
const fetchRows = async (limit) => (await feed.applyPublicNoticeFilters(sb.from('notices').select('id, publisher_kind, publisher_user_id').eq('is_hidden', false).eq('visibility', 'public')).order('published_at', { ascending: false }).limit(limit)).data;
const out = [];
async function scenario(name, rows, opts = {}) {
  const before = await stat(); const t0 = now();
  const names = await feed.loadPersonNames(rpc, rows, { cache: null, ...opts });
  const ms = now() - t0; out.push({ scenario: name, personNotices: rows.filter((r) => r.publisher_kind === 'person').length, rpcRequests: (await stat()) - before, names: Object.keys(names).length, ms: Math.round(ms) });
}
const all = await fetchRows(200); const persons = all.filter((r) => r.publisher_kind === 'person' && r.publisher_user_id); const nonPersons = all.filter((r) => r.publisher_kind !== 'person');
const one = persons.slice(0, 1), several = persons.slice(0, 5), thirty = [...new Map(persons.map((r) => [r.publisher_user_id, r])).values()].slice(0, 30);
const repeat = persons.filter((r) => r.publisher_user_id === 'aa000000-0000-4000-8000-000000000000');
let t = now(); await fetchRows(40); const queryMs = Math.round(now() - t);
await scenario('no person notices', nonPersons.slice(0, 10)); await scenario('one person notice', one); await scenario('five person notices (5 authors)', several);
await scenario('30 person notices (30 authors)', thirty); await scenario(`${repeat.length} notices by ONE author`, repeat);
// per-notice (the previous behaviour) for comparison: one request per notice
{ const before = await stat(); const t0 = now(); await Promise.all(thirty.concat(repeat).map((r) => rpc('notice_publisher_display', { p_notice: r.id }))); out.push({ scenario: `OLD behaviour: one request per notice (${thirty.length + repeat.length} notices)`, rpcRequests: (await stat()) - before, ms: Math.round(now() - t0) }); }
// cache: second call within the lifetime
{ const cache = new Map(); await feed.loadPersonNames(rpc, thirty, { cache }); const before = await stat(); const t0 = now(); await feed.loadPersonNames(rpc, thirty, { cache }); out.push({ scenario: 'repeat of the 30-author page within 2 minutes (cache)', rpcRequests: (await stat()) - before, ms: Math.round(now() - t0) }); }
// failure: an unknown / failing function name path
{ const before = await stat(); const t0 = now(); const names = await feed.loadPersonNames(async () => ({ data: null, error: { message: 'boom' } }), thirty, { cache: null }); out.push({ scenario: 'all lookups FAIL (30 authors)', rpcRequests: 0, names: Object.keys(names).length, ms: Math.round(now() - t0), note: 'every notice keeps "A OneShetland member"' }); }
console.log(JSON.stringify({ publicFeedQueryMs: queryMs, results: out }, null, 1));
