/**
 * stripe-customer-exposure.mjs — find Stripe CUSTOMER identifier columns that a client role can reach.
 *
 * A Stripe customer id (cus_…) is a server-side handle: the Edge Functions bind it from the authenticated user or business and
 * hand it to Stripe. No browser or app needs the raw value, and a column that is readable by anon / authenticated leaks it, while
 * one that is writable lets a user choose which customer a later server path will act on.
 *
 * The check is a catalogue query, so it applies to every relation in the database, whatever migration created it:
 *   · DIRECT   a column whose name looks like a Stripe customer id (stripe…customer / customer…stripe) that anon or authenticated
 *              holds SELECT, INSERT or UPDATE on (column-level or inherited from a table-level grant);
 *   · DERIVED  a view / materialised view that selects from such a column and that anon or authenticated can read.
 * Account ids (acct_), PaymentIntent / SetupIntent / subscription / transfer ids are NOT customer ids and are not examined here.
 *
 * Anything reachable must be listed in ALLOWED with the reason it is safe AND a machine-checked requirement that keeps the reason
 * true (row-level security that confines reads to the owner, a trigger that restores the value on a user write, no client
 * INSERT policy). An allow-list entry whose requirement no longer holds is a violation; an entry that no longer matches anything
 * is stale and also fails, so the list cannot rot.
 *
 * Used by: supabase/tests/stripe-customer-exposure.node.test.ts (isolated database), scripts/migration-replay/replay.mjs (the
 * whole schema, built from migrations alone), and — pasted into a read-only session — against production after a deploy.
 */

export const NAME_PATTERN = 'stripe.*customer|customer.*stripe';
export const ROLES = ['anon', 'authenticated'];
export const ACCESS = ['SELECT', 'INSERT', 'UPDATE'];

/**
 * Reachable-by-design customer-id columns. `requires` is verified against the catalogue every run.
 *   rls-confined      row-level security is on and no SELECT-capable policy lets every row through
 *   trigger:<name>    that trigger exists, is enabled and fires on the command (INSERT / UPDATE) being allowed
 *   no-insert-policy  no INSERT-capable policy exists, so a client INSERT is refused by RLS
 */
export const ALLOWED = [
  { relation: 'public.profiles', column: 'stripe_customer_id', access: 'SELECT', requires: ['rls-confined'],
    why: 'The owner\'s own row (policy auth.uid() = id) and admins only; the value is never selected by a client.' },
  { relation: 'public.profiles', column: 'stripe_customer_id', access: 'UPDATE', requires: ['trigger:trg_profiles_lock_sensitive:UPDATE'],
    why: 'tg_profiles_lock_sensitive restores the stored value on every user-JWT update of the owner\'s row.' },
  { relation: 'public.profiles', column: 'stripe_customer_id', access: 'INSERT', requires: ['no-insert-policy'],
    why: 'Profile rows are created by the auth trigger; there is no client INSERT policy, so RLS refuses a client INSERT.' },
  { relation: 'public.local_businesses', column: 'stripe_customer_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_business_columns:INSERT'],
    why: 'tg_lock_business_columns nulls the value on a user INSERT. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'stripe_customer_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_business_columns:UPDATE'],
    why: 'tg_lock_business_columns restores the value on a user UPDATE. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'business_stripe_customer_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_business_columns:INSERT'],
    why: 'tg_lock_business_columns nulls the value on a user INSERT. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'business_stripe_customer_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_business_columns:UPDATE'],
    why: 'tg_lock_business_columns restores the value on a user UPDATE. Not readable (SELECT is not granted).' },
];

const roleList = ROLES.map((r) => `'${r}'`).join(',');
const accessList = ACCESS.map((a) => `('${a}')`).join(',');
const SYSTEM = `n.nspname not in ('pg_catalog','information_schema','pg_toast') and n.nspname !~ '^pg_'`;

/** rows: kind, relation, column, access, role  (tab-separated by the runner) */
export const EXPOSURE_SQL = `
select 'direct' as kind, format('%s.%s', n.nspname, c.relname) as relation, a.attname as col, x.access as access, r.rolname as role
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
cross join (values ${accessList}) x(access)
cross join (select unnest(array[${roleList}]) rolname) r
where ${SYSTEM} and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
  and a.attname ~* '${NAME_PATTERN}'
  and has_column_privilege(r.rolname, c.oid, a.attnum, x.access)
union all
select 'derived', format('%s.%s', vn.nspname, v.relname), a.attname, 'SELECT', r.rolname
from pg_rewrite rw
join pg_depend d on d.objid = rw.oid and d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
join pg_class v on v.oid = rw.ev_class and v.relkind in ('v','m') and v.oid <> d.refobjid
join pg_namespace vn on vn.oid = v.relnamespace
join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
cross join (select unnest(array[${roleList}]) rolname) r
where a.attname ~* '${NAME_PATTERN}' and vn.nspname !~ '^pg_' and vn.nspname <> 'information_schema'
  and has_any_column_privilege(r.rolname, v.oid, 'SELECT')
order by 1, 2, 3, 4, 5`;

const q = (s) => String(s).replace(/'/g, "''");

/** one boolean per requirement; true = the reason the exception exists still holds */
function requirementSql(relation, requirement, access) {
  const [schema, table] = relation.split('.');
  const rel = `'${q(schema)}.${q(table)}'::regclass`;
  if (requirement === 'rls-confined') {
    return `select (select relrowsecurity from pg_class where oid = ${rel})
      and not exists (select 1 from pg_policy p where p.polrelid = ${rel} and p.polcmd in ('r','*')
        and (p.polroles = '{0}' or exists (select 1 from unnest(p.polroles) o where o in ('anon'::regrole, 'authenticated'::regrole)))
        and (p.polqual is null or pg_get_expr(p.polqual, p.polrelid) in ('true','(true)')))`;
  }
  if (requirement === 'no-insert-policy') {
    return `select not exists (select 1 from pg_policy p where p.polrelid = ${rel} and p.polcmd in ('a','*')
      and (p.polroles = '{0}' or exists (select 1 from unnest(p.polroles) o where o in ('anon'::regrole, 'authenticated'::regrole))))`;
  }
  const m = /^trigger:([^:]+):(INSERT|UPDATE)$/.exec(requirement);
  if (m) {
    const bit = m[2] === 'INSERT' ? 4 : 16;           // tgtype bits: 4 = INSERT, 16 = UPDATE
    return `select exists (select 1 from pg_trigger t where t.tgrelid = ${rel} and t.tgname = '${q(m[1])}' and not t.tgisinternal
      and t.tgenabled <> 'D' and (t.tgtype & 2) = 2 and (t.tgtype & ${bit}) = ${bit})`;
  }
  throw new Error(`unknown requirement ${requirement} for ${relation} (${access})`);
}

/**
 * @param {(sql: string) => string[][]} query  runs read-only SQL and returns tab-split rows
 * @param {typeof ALLOWED} [allowList]  defaults to the production allow-list; a fixture passes its own
 * @returns {{ violations: string[], allowed: string[], stale: string[] }}
 */
export function evaluate(query, allowList = ALLOWED) {
  const rows = query(EXPOSURE_SQL);
  const violations = []; const allowed = []; const seen = new Set();
  for (const [kind, relation, column, access, role] of rows) {
    const entry = kind === 'direct' ? allowList.find((e) => e.relation === relation && e.column === column && e.access === access) : undefined;
    const label = `${kind} ${relation}.${column} ${access} ← ${role}`;
    if (!entry) { violations.push(label); continue; }
    seen.add(`${entry.relation}.${entry.column}.${entry.access}`);
    const failed = entry.requires.filter((req) => !['t', 'true'].includes(String(query(requirementSql(entry.relation, req, entry.access)).flat().pop() ?? 'f')));
    if (failed.length) violations.push(`${label} — allow-list requirement no longer holds: ${failed.join(', ')}`);
    else allowed.push(label);
  }
  const stale = allowList.filter((e) => !seen.has(`${e.relation}.${e.column}.${e.access}`)).map((e) => `${e.relation}.${e.column} ${e.access}`);
  return { violations, allowed, stale };
}
