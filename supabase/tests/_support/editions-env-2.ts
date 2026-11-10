/** editions-env-2.ts — extra fixture helpers for the Editions suites (ISOLATED Postgres only). Builds on editions-env.ts. */
import { Env, last, type Who } from './editions-env.ts';

/** submit -> approve -> entitle -> publish, so the Edition is publicly visible (the finished service's only route). `who` is a team member allowed to submit and publish. */
export function publishEdition(E: Env, who: Who, ed: string, note = 'ZZ TEST grant') {
  E.do(who, `select public.edition_submit_for_review('${ed}')`);
  E.do('ADMIN', `select public.admin_review_edition('${ed}', 'approve', 'approved by the test suite')`);
  E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ed}', 'publish', now(), now() + interval '90 days', '${note}')`);
  E.do(who, `select public.edition_set_status('${ed}', 'published')`);
  if (E.q(`select status from public.editions where id='${ed}'`) !== 'published') throw new Error(`could not publish ${ed}`);
  return ed;
}

/** invite a helper by email as the owner and accept as that helper; returns the invite id */
export function addHelper(E: Env, owner: Who, org: string, helper: Who, helperEmail: string, role: 'admin' | 'editor' = 'editor') {
  const inv = last(E.do(owner, `select public.invite_edition_member('${org}', '${helperEmail}', '${role}')`));
  E.do(helper, `select public.accept_edition_invite('${inv}')`);
  return inv;
}

/** submit -> approve only (an approved Edition can have a package chosen; it is not yet public) */
export function approveEdition(E: Env, who: Who, ed: string) {
  E.do(who, `select public.edition_submit_for_review('${ed}')`);
  E.do('ADMIN', `select public.admin_review_edition('${ed}', 'approve', 'approved by the test suite')`);
  if (E.q(`select review_state from public.editions where id='${ed}'`) !== 'approved') throw new Error(`could not approve ${ed}`);
  return ed;
}

/** A view of an Env where a suite's own role names (e.g. ORG_OWNER) map onto the shared fixture users; 'anon' passes through; 'service' runs as service_role (the role is created on demand);
 *  anything else must be in the map. */
export function aliased<K extends string>(E: Env, map: Record<K, Who>) {
  let svc = false;
  const ensureSvc = () => { if (!svc) { E.sup(`do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;`); svc = true; } };
  const run = (w: K | 'anon' | 'service', sql: string, end: 'rollback' | 'commit') => {
    if (w === 'service') { ensureSvc(); return E.sup(`begin; set local role service_role; ${sql}; ${end};`); }
    const who: Who = w === 'anon' ? 'anon' : map[w as K];
    return end === 'commit' ? E.do(who, sql) : E.try(who, sql);
  };
  return {
    base: E,
    try: (w: K | 'anon' | 'service', sql: string) => run(w, sql, 'rollback'),
    do: (w: K | 'anon' | 'service', sql: string) => run(w, sql, 'commit'),
    one: (w: K | 'anon' | 'service', sql: string) => last(run(w, sql, 'rollback')),
    doOne: (w: K | 'anon' | 'service', sql: string) => last(run(w, sql, 'commit')),
    q: (sql: string) => E.q(sql),
    sup: (sql: string) => E.sup(sql),
  };
}
