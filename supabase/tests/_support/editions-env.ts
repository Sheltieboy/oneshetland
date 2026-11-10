/**
 * editions-env.ts — shared fixtures for the Editions suites (ISOLATED Postgres only).
 *
 * The finished Editions service has exactly two kinds of organiser: a Hub's and a Business's. Suites therefore build a REAL Hub or Business first and then enter Editions the way an owner
 * does (edition_ensure_organiser). Nothing here creates a standalone organiser, because the database refuses one.
 */
import { createReplayDb, type ReplayDb } from './replay-db.ts';

export const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
export const USERS = {
  ADMIN: id(1), BIZ_OWNER: id(2), BIZ2_OWNER: id(3), HUB_OWNER: id(4), HUB_COMMITTEE: id(5), HUB_MEMBER: id(6), HELPER: id(7), STRANGER: id(8), EDITOR: id(9), HUB2_OWNER: id(10),
} as const;
export type Who = keyof typeof USERS | 'anon';

const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const noise = /^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/;
export const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !noise.test(l));
export const last = (o: string) => rowsOf(o).pop() ?? '';
export const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates|not permitted|not found|only the|only an|not open yet|already|reserved|owners only|admins only|refus|cannot|must |finish these|not been approved|helper cannot|no longer|too many|not waiting|tell the organiser|a note|is not active|restrict/im.test(o);

export class Env {
  db!: ReplayDb;
  constructor(name: string) { this.db = createReplayDb(name); }
  as(who: Who) {
    return who === 'anon' ? 'set local role anon;' : `set local request.jwt.claims = '{"sub":"${USERS[who]}","email":"${USERS[who]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${USERS[who]}'; set local role authenticated;`;
  }
  /** run as a user inside a transaction that is rolled back (a probe) */
  try(who: Who, sql: string) { return this.db.raw(`begin; ${this.as(who)} ${sql}; rollback;`); }
  /** run as a user and commit */
  do(who: Who, sql: string) { return this.db.raw(`begin; ${this.as(who)} ${sql}; commit;`); }
  q(sql: string) { return last(this.db.raw(sql)); }
  sup(sql: string) { return this.db.raw(sql); }
  one(who: Who, sql: string) { return last(this.try(who, sql)); }
  /** committed call by a user that returns its last value */
  call(who: Who, sql: string) { return last(this.do(who, sql)); }
  drop() { try { this.db.drop(); } catch { /* */ } }
}

export const d = (n: number) => `(current_date + ${n})`;

/** Users, a Hub (owner + committee + member) and a Business, Editions switched ON (the finished service). Returns ids. */
export function seed(E: Env) {
  E.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  E.sup(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array[${Object.values(USERS).map((u) => `'${u}'::uuid`).join(',')}]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${USERS.ADMIN}','admin','Zed Admin'),('${USERS.BIZ_OWNER}','customer','Bea Business'),('${USERS.BIZ2_OWNER}','customer','Ben Other'),
      ('${USERS.HUB_OWNER}','customer','Hana Hub'),('${USERS.HUB_COMMITTEE}','customer','Colm Committee'),('${USERS.HUB_MEMBER}','customer','Mia Member'),('${USERS.HELPER}','customer','Hal Helper'),
      ('${USERS.STRANGER}','customer','Sam Stranger'),('${USERS.EDITOR}','customer','Edie Editor'),('${USERS.HUB2_OWNER}','customer','Hugh Other')
      on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;`);
  const uuid = (out: string) => { const v = last(out); if (!/^[0-9a-f-]{36}$/.test(v)) throw new Error(`fixture insert failed: ${out.slice(0, 400)}`); return v; };
  const hub = (owner: string, name: string, slug: string) => uuid(E.sup(`insert into hubs (owner_id, name, slug, type, area, description, is_active) values ('${owner}','${name}','${slug}','club','Lerwick','A hub',true) returning id`));
  const biz = (owner: string | null, name: string) => uuid(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values (${owner ? `'${owner}'` : 'null'},'${name}','food_drink','1 Commercial Street, Lerwick',true) returning id`));
  const HUB = hub(USERS.HUB_OWNER, 'ZZ Test Hub', 'zz-test-hub');
  const HUB2 = hub(USERS.HUB2_OWNER, 'ZZ Other Hub', 'zz-other-hub');
  E.sup(`insert into hub_members (hub_id, user_id, role, status) values ('${HUB}','${USERS.HUB_COMMITTEE}','committee','active'),('${HUB}','${USERS.HUB_MEMBER}','member','active') on conflict do nothing`);
  const BIZ = biz(USERS.BIZ_OWNER, 'ZZ Test Cafe');
  const BIZ2 = biz(USERS.BIZ2_OWNER, 'ZZ Other Shop');
  const BIZ_UNCLAIMED = biz(null, 'ZZ Unclaimed Listing');
  E.sup(`insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true'`);
  return { HUB, HUB2, BIZ, BIZ2, BIZ_UNCLAIMED };
}

/** Enter Editions from a parent exactly as an owner does; returns the organiser id */
export function enter(E: Env, who: Who, kind: 'hub' | 'business', parent: string) {
  const out = E.do(who, `select (public.edition_ensure_organiser('${kind}', '${parent}') ->> 'id')`);
  const v = last(out); if (!/^[0-9a-f-]{36}$/.test(v)) throw new Error(`could not enter Editions: ${out.slice(0, 500)}`);
  return v;
}

/** a draft Edition with a summary and a welcome page, made by the given team member */
export function draftEdition(E: Env, who: Who, org: string, slug: string, title = 'ZZ Test Festival') {
  const ed = last(E.do(who, `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${org}','${slug}','${title}','A festival','multi_day',${d(20)},${d(22)}) returning id`));
  E.sup(`insert into public.edition_pages (edition_id, slug, nav_label, title, body, position, in_nav, is_home) values ('${ed}','welcome','Welcome','Welcome','Hello',0,true,true)`);
  return ed;
}
