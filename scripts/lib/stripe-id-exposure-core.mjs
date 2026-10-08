/**
 * stripe-id-exposure-core.mjs — shared engine behind the Stripe identifier exposure guards.
 *
 * A guard is a name pattern for one class of Stripe identifier plus an allow-list. It reports every column of that class that anon or
 * authenticated can SELECT, INSERT or UPDATE (column-level or inherited from a table-level grant), and every view / materialised view that
 * selects from such a column and can be read by them. A reachable column must be allow-listed with a reason AND a machine-checked
 * requirement that keeps the reason true; an allow-list entry that no longer matches anything is stale and fails too.
 *
 *   rls-confined      row-level security is on and no SELECT-capable client policy lets every row through (USING true / no USING)
 *   rls-own-row       stricter: every SELECT-capable client policy is tied to the caller (auth.uid(), is_admin() or get_my_role())
 *   trigger:<n>:<cmd> that trigger exists, is enabled, fires BEFORE the command (INSERT / UPDATE) AND its function assigns NEW.<column>
 *   no-insert-policy  no INSERT-capable client policy exists, so a client INSERT is refused by RLS
 *
 * Wrappers: stripe-customer-exposure.mjs (cus_…) and stripe-account-exposure.mjs (acct_…).
 */

export const ROLES = ['anon', 'authenticated'];
export const ACCESS = ['SELECT', 'INSERT', 'UPDATE'];

export function createGuard({ namePattern, allowed }) {
  const NAME_PATTERN = namePattern;
  const ALLOWED = allowed;
  const roleList = ROLES.map((r) => `'${r}'`).join(',');
  const accessList = ACCESS.map((a) => `('${a}')`).join(',');
  const SYSTEM = `n.nspname not in ('pg_catalog','information_schema','pg_toast') and n.nspname !~ '^pg_'`;

  /** rows: kind, relation, column, access, role  (tab-separated by the runner) */
  const EXPOSURE_SQL = `
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
  function requirementSql(relation, requirement, access, column) {
    const [schema, table] = relation.split('.');
    const rel = `'${q(schema)}.${q(table)}'::regclass`;
    if (requirement === 'rls-confined') {
      return `select (select relrowsecurity from pg_class where oid = ${rel})
        and not exists (select 1 from pg_policy p where p.polrelid = ${rel} and p.polcmd in ('r','*')
          and (p.polroles = '{0}' or exists (select 1 from unnest(p.polroles) o where o in ('anon'::regrole, 'authenticated'::regrole)))
          and (p.polqual is null or pg_get_expr(p.polqual, p.polrelid) in ('true','(true)')))`;
    }
    if (requirement === 'rls-own-row') {
      return `select (select relrowsecurity from pg_class where oid = ${rel})
        and not exists (select 1 from pg_policy p where p.polrelid = ${rel} and p.polcmd in ('r','*')
          and (p.polroles = '{0}' or exists (select 1 from unnest(p.polroles) o where o in ('anon'::regrole, 'authenticated'::regrole)))
          and (p.polqual is null or pg_get_expr(p.polqual, p.polrelid) !~ '(auth\\.uid\\(\\)|is_admin\\(\\)|get_my_role\\(\\))'
               or pg_get_expr(p.polqual, p.polrelid) in ('true','(true)')))`;
    }
    if (requirement === 'no-insert-policy') {
      return `select not exists (select 1 from pg_policy p where p.polrelid = ${rel} and p.polcmd in ('a','*')
        and (p.polroles = '{0}' or exists (select 1 from unnest(p.polroles) o where o in ('anon'::regrole, 'authenticated'::regrole))))`;
    }
    const m = /^trigger:([^:]+):(INSERT|UPDATE)$/.exec(requirement);
    if (m) {
      const bit = m[2] === 'INSERT' ? 4 : 16;           // tgtype bits: 4 = INSERT, 16 = UPDATE
      // the trigger must exist, be enabled, fire BEFORE the command, AND its function must actually assign NEW.<column> (a trigger that never
      // mentions the column protects nothing)
      return `select exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
        where t.tgrelid = ${rel} and t.tgname = '${q(m[1])}' and not t.tgisinternal
        and t.tgenabled <> 'D' and (t.tgtype & 2) = 2 and (t.tgtype & ${bit}) = ${bit}
        and position('new.${q(column)}' in lower(f.prosrc)) > 0)`;
    }
    throw new Error(`unknown requirement ${requirement} for ${relation} (${access})`);
  }

  /**
   * @param {(sql: string) => string[][]} query  runs read-only SQL and returns tab-split rows
   * @param {typeof ALLOWED} [allowList]  defaults to the production allow-list; a fixture passes its own
   * @returns {{ violations: string[], allowed: string[], stale: string[] }}
   */
  function evaluate(query, allowList = ALLOWED) {
    const rows = query(EXPOSURE_SQL);
    const violations = []; const allowed = []; const seen = new Set();
    for (const [kind, relation, column, access, role] of rows) {
      const entry = kind === 'direct' ? allowList.find((e) => e.relation === relation && e.column === column && e.access === access) : undefined;
      const label = `${kind} ${relation}.${column} ${access} ← ${role}`;
      if (!entry) { violations.push(label); continue; }
      seen.add(`${entry.relation}.${entry.column}.${entry.access}`);
      const failed = entry.requires.filter((req) => !['t', 'true'].includes(String(query(requirementSql(entry.relation, req, entry.access, entry.column)).flat().pop() ?? 'f')));
      if (failed.length) violations.push(`${label} — allow-list requirement no longer holds: ${failed.join(', ')}`);
      else allowed.push(label);
    }
    const stale = allowList.filter((e) => !seen.has(`${e.relation}.${e.column}.${e.access}`)).map((e) => `${e.relation}.${e.column} ${e.access}`);
    return { violations, allowed, stale };
  }

  return { NAME_PATTERN, ROLES, ACCESS, ALLOWED, EXPOSURE_SQL, evaluate };
}
