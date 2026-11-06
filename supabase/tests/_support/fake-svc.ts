/**
 * A tiny in-memory stand-in for the Supabase service client — just the query shapes social-recipes.ts uses.
 * Tables are arrays of rows; rpc handlers are functions. insert() enforces the social_posts (kind, entity_id) unique index.
 * No network, no database.
 */
type Row = Record<string, any>;
type Result = { data: any; error: { message: string } | null };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  rpcs: Record<string, (args: any) => any> = {};
  log: { op: string; table: string; payload?: any }[] = [];
  clock: () => string = () => new Date().toISOString();
  failTables = new Set<string>();
  failRpcs = new Set<string>();
  table(n: string) { return (this.tables[n] ??= []); }
  from(table: string) { return new Q(this, table); }
  async rpc(name: string, args: any): Promise<Result> {
    if (this.failRpcs.has(name)) return { data: null, error: { message: `${name} failed` } };
    const fn = this.rpcs[name];
    if (!fn) return { data: null, error: { message: `no rpc ${name}` } };
    return { data: fn(args), error: null };
  }
}

const cmp = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);

class Q implements PromiseLike<Result> {
  mode: 'select' | 'update' | 'insert' | 'upsert' = 'select'; conflictCol: string | null = null;
  filters: ((r: Row) => boolean)[] = [];
  patch: Row | null = null; ins: Row | null = null;
  orderBy: { col: string; asc: boolean } | null = null; lim = Infinity; single = false;
  private db: FakeDb; private t: string;
  constructor(db: FakeDb, t: string) { this.db = db; this.t = t; }
  count: 'exact' | null = null; head = false;
  select(_c?: string, o?: { count?: 'exact'; head?: boolean }) { if (o?.count) { this.count = o.count; this.head = !!o.head; } return this; }
  update(p: Row) { this.mode = 'update'; this.patch = p; return this; }
  insert(r: Row) { this.mode = 'insert'; this.ins = r; return this; }
  upsert(r: Row, o?: { onConflict?: string }) { this.mode = 'upsert'; this.ins = r; this.conflictCol = o?.onConflict ?? 'id'; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this; }
  not(c: string, op: string, v: any) { this.filters.push((r) => (op === 'is' ? (v === null ? r[c] != null : r[c] !== v) : !String(v).replace(/^\(|\)$/g, '').split(',').includes(String(r[c])))); return this; }
  gt(c: string, v: any) { this.filters.push((r) => r[c] != null && cmp(r[c], v) > 0); return this; }
  is(c: string, v: any) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  lt(c: string, v: any) { this.filters.push((r) => r[c] != null && cmp(r[c], v) < 0); return this; }
  gte(c: string, v: any) { this.filters.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this; }
  lte(c: string, v: any) { this.filters.push((r) => r[c] != null && cmp(r[c], v) <= 0); return this; }
  or(expr: string) { this.filters.push(parseOr(expr)); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }
  then<A, B>(ok?: (v: Result) => A | PromiseLike<A>, bad?: (e: any) => B | PromiseLike<B>) { return Promise.resolve(this.run()).then(ok, bad); }
  run(): Result {
    const db = this.db;
    if (db.failTables.has(this.t)) return { data: null, error: { message: `${this.t} unavailable` } };
    const rows = db.table(this.t);
    if (this.mode === 'upsert') {
      const col = this.conflictCol!; const hit = rows.find((x) => x[col] === this.ins![col]);
      if (hit) Object.assign(hit, this.ins); else rows.push({ id: crypto.randomUUID(), created_at: db.clock(), ...this.ins });
      db.log.push({ op: 'upsert', table: this.t, payload: this.ins });
      return { data: null, error: null };
    }
    if (this.mode === 'insert') {
      const r = { id: crypto.randomUUID(), created_at: db.clock(), ...this.ins };
      if (this.t === 'social_posts') {
        if (r.entity_id != null && rows.some((x) => x.kind === r.kind && x.entity_id === r.entity_id)) return { data: null, error: { message: 'duplicate key value violates unique constraint "social_posts_kind_entity_uniq"' } };
        if (r.kind === 'essential_alert' && r.status === 'scheduled') return { data: null, error: { message: 'violates check constraint "social_posts_essential_needs_human"' } };
      }
      rows.push(r); db.log.push({ op: 'insert', table: this.t, payload: r });
      return { data: r, error: null };
    }
    let m = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === 'update') { m.forEach((r) => Object.assign(r, this.patch)); db.log.push({ op: 'update', table: this.t, payload: { patch: this.patch, n: m.length } }); return { data: null, error: null }; }
    if (this.orderBy) { const { col, asc } = this.orderBy; m = [...m].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col])); }
    const total = m.length;
    m = m.slice(0, this.lim);
    if (this.count) return { data: this.head ? null : m, count: total, error: null } as any;
    return { data: this.single ? (m[0] ?? null) : m, error: null };
  }
}

/** Parses the one `or=` shape the composer uses: and(status.in.(a,b),col.gte.X),and(status.eq.s,col.gte.Y) */
function parseOr(expr: string): (r: Row) => boolean {
  if (!/and\(/.test(expr)) {
    const conds = expr.split(/,(?![^(]*\))/).map(cond);
    return (r) => conds.some((f) => f(r));
  }
  const groups = expr.match(/and\((?:[^()]|\([^)]*\))*\)/g) ?? [];
  const conds = groups.map((g) => g.slice(4, -1).split(/,(?![^(]*\))/).map(cond));
  return (r) => conds.some((cs) => cs.every((f) => f(r)));
}

function cond(c: string): (r: Row) => boolean {
  const m = c.match(/^([a-z_]+)\.(in|eq|gte|lte|gt|lt|is)\.(.+)$/)!;
  const [, col, op, val] = m;
  if (op === 'in') { const vs = val.replace(/^\(|\)$/g, '').split(','); return (r) => vs.includes(r[col]); }
  if (op === 'is') return (r) => (val === 'null' ? r[col] == null : String(r[col]) === val);
  if (op === 'eq') return (r) => String(r[col]) === val;
  if (op === 'gte') return (r) => r[col] != null && cmp(r[col], val) >= 0;
  if (op === 'gt') return (r) => r[col] != null && cmp(r[col], val) > 0;
  if (op === 'lt') return (r) => r[col] != null && cmp(r[col], val) < 0;
  return (r) => r[col] != null && cmp(r[col], val) <= 0;
}
