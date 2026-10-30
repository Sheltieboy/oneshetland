/**
 * In-memory stand-in for the Supabase client, used ONLY by tests. It EXECUTES the filters the real
 * call sites build (eq / in / gte / lte / is / not / or(…and(…)…) / order / limit / range) over fixture
 * rows, so a test exercises the real query code, not a re-implementation of it.
 *
 * Row-level security is mimicked with the rule production has on public.events: a signed-out visitor or
 * ordinary signed-in user sees a row only if it is NOT hidden (status other than "published" is hidden
 * by the database trigger); an admin sees everything. The tests set the viewer with setViewer().
 * Fixtures: globalThis.__FAKE_DB__ = { events: [...], <table>: [...] }.
 */
const state = globalThis.__FAKE_STATE__ ??= { viewer: "anon" };
export const setViewer = (v) => { state.viewer = v; };
export const setDb = (db) => { globalThis.__FAKE_DB__ = db; };

const isoLike = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
const norm = (a, b) => (isoLike(a) && isoLike(b) ? [Date.parse(a), Date.parse(b)] : [a, b]);
const ops = {
  eq: (a, b) => { [a, b] = norm(a, String(b)); return String(a) === String(b); },
  neq: (a, b) => !ops.eq(a, b),
  gte: (a, b) => { if (a == null) return false; [a, b] = norm(a, b); return a >= b; },
  gt: (a, b) => { if (a == null) return false; [a, b] = norm(a, b); return a > b; },
  lte: (a, b) => { if (a == null) return false; [a, b] = norm(a, b); return a <= b; },
  lt: (a, b) => { if (a == null) return false; [a, b] = norm(a, b); return a < b; },
  is: (a, b) => (b === "null" ? a == null : String(a) === b),
  ilike: (a, b) => a != null && new RegExp("^" + String(b).replace(/%/g, ".*") + "$", "i").test(String(a)),
};

function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function parseTerm(t) {
  t = t.trim();
  if (t.startsWith("and(") && t.endsWith(")")) { const ps = splitTop(t.slice(4, -1)).map(parseTerm); return (r) => ps.every((p) => p(r)); }
  if (t.startsWith("or(") && t.endsWith(")")) { const ps = splitTop(t.slice(3, -1)).map(parseTerm); return (r) => ps.some((p) => p(r)); }
  const m = /^([a-z_]+)\.([a-z]+)\.(.*)$/.exec(t);
  if (!m) throw new Error("fake-supabase cannot parse filter term: " + t);
  const [, col, op, val] = m;
  if (!ops[op]) throw new Error("fake-supabase: unsupported operator " + op);
  return (r) => ops[op](r[col], val);
}

class Query {
  constructor(table) { this.table = table; this.preds = []; this.sort = []; this.lim = null; this.rng = null; this.single = false; }
  select() { return this; }
  eq(c, v) { this.preds.push((r) => ops.eq(r[c], v)); return this; }
  neq(c, v) { this.preds.push((r) => ops.neq(r[c], v)); return this; }
  in(c, arr) { this.preds.push((r) => arr.map(String).includes(String(r[c]))); return this; }
  gte(c, v) { this.preds.push((r) => ops.gte(r[c], v)); return this; }
  gt(c, v) { this.preds.push((r) => ops.gt(r[c], v)); return this; }
  lte(c, v) { this.preds.push((r) => ops.lte(r[c], v)); return this; }
  lt(c, v) { this.preds.push((r) => ops.lt(r[c], v)); return this; }
  is(c, v) { this.preds.push((r) => ops.is(r[c], String(v))); return this; }
  ilike(c, v) { this.preds.push((r) => ops.ilike(r[c], v)); return this; }
  not(c, op, v) { const f = ops[op]; this.preds.push((r) => !f(r[c], String(v))); return this; }
  or(str) { const ps = splitTop(str).map(parseTerm); this.preds.push((r) => ps.some((p) => p(r))); return this; }
  order(c, o = {}) { this.sort.push([c, o.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  maybeSingle() { this.single = true; return this; }
  single_() { return this; }
  rows() {
    const db = globalThis.__FAKE_DB__ ?? {};
    let rows = [...(db[this.table] ?? [])];
    if (this.table === "events" && state.viewer !== "admin") rows = rows.filter((r) => r.is_hidden === false);   // RLS: events_public_read
    rows = rows.filter((r) => this.preds.every((p) => p(r)));
    for (const [c, asc] of [...this.sort].reverse()) {
      rows.sort((x, y) => {
        const [a, b] = norm(x[c], y[c]);
        const d = a == null ? (b == null ? 0 : -1) : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0;
        return asc ? d : -d;
      });
    }
    if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
    else if (this.lim != null) rows = rows.slice(0, this.lim);
    return rows;
  }
  then(res, rej) {
    return Promise.resolve().then(() => {
      const rows = this.rows();
      return { data: this.single ? (rows[0] ?? null) : rows, error: null };
    }).then(res, rej);
  }
}
const client = { from: (t) => new Query(t), rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null } }) } };
export const publicClient = () => client;
export const createClient = async () => client;
export const createBrowserClient = () => client;
export const createServerClient = async () => client;
export default client;
