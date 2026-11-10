/**
 * editions-env-1.ts — extra fixtures for the legacy Editions suites, built on editions-env.ts (which is not edited).
 * Everything here goes through the finished model: a real Hub or Business, owner entry, review, approval, package, publish.
 */
import { Env, USERS, last, d } from './editions-env.ts';

/** a platform moderator (not an administrator) */
export const MOD = 'ab000000-0000-4000-8000-0000000000ab';
export function addModerator(E: Env) {
  E.sup(`insert into auth.users (id, email) values ('${MOD}', '${MOD}@x.invalid') on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${MOD}','moderator','Mo Mod') on conflict (id) do update set role='moderator';`);
}
/** run as the moderator */
export const asMod = (E: Env, sql: string) => E.db.raw(`begin; set local request.jwt.claims = '{"sub":"${MOD}","email":"${MOD}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${MOD}'; set local role authenticated; ${sql}; rollback;`);

/** record the identity check the way the first approval does, without needing an Edition */
export const verifyOrg = (E: Env, org: string) => E.do('ADMIN', `select public.admin_decide_edition_organiser('${org}', 'verify', 'ZZ TEST verified by the suite')`);

/** submit (as an owner/admin) and approve an Edition */
export function approve(E: Env, owner: 'HUB_OWNER' | 'BIZ_OWNER' | 'HUB_COMMITTEE', ed: string) {
  E.do(owner, `select public.edition_submit_for_review('${ed}')`);
  return E.do('ADMIN', `select public.admin_review_edition('${ed}', 'approve', 'ZZ TEST approved by the suite')`);
}
export const grantPublish = (E: Env, ed: string, days = 90) => E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ed}', 'publish', now(), now() + interval '${days} days', 'ZZ TEST grant for the suite')`);

/** submit, approve, grant a package and publish: the Edition is public (if Editions is open) */
export function goLive(E: Env, owner: 'HUB_OWNER' | 'BIZ_OWNER', ed: string) {
  approve(E, owner, ed);
  grantPublish(E, ed);
  return E.do(owner, `select public.edition_set_status('${ed}', 'published')`);
}

/** a second Hub-run or Business-run organiser, already verified */
export function extraOrganiser(E: Env, who: keyof typeof USERS, kind: 'hub' | 'business', parent: string) {
  const o = last(E.do(who, `select (public.edition_ensure_organiser('${kind}', '${parent}') ->> 'id')`));
  verifyOrg(E, o);
  return o;
}
export { d };
