with ext_objs as (select objid from pg_depend where deptype='e' and classid='pg_proc'::regclass),
cols as (
  select 'col' kind, c.relname||'.'||a.attname key,
    format_type(a.atttypid,a.atttypmod)||'|nn='||a.attnotnull||'|def='||coalesce(regexp_replace(pg_get_expr(d.adbin,d.adrelid),'\s+',' ','g'),'')||'|gen='||a.attgenerated::text||'|ident='||a.attidentity::text txt
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped),
rels as (
  select 'rel' kind, c.relname key, c.relkind::text||'|rls='||c.relrowsecurity||'|force='||c.relforcerowsecurity||'|opts='||coalesce(c.reloptions::text,'') txt
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m')),
cons as (
  select 'con' kind, cl.relname||'.'||co.conname key, co.contype::text||'|'||pg_get_constraintdef(co.oid)||'|'||co.convalidated txt
  from pg_constraint co join pg_class cl on cl.oid=co.conrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname='public'),
idx as (
  select 'idx' kind, indexname key, regexp_replace(indexdef,'\s+',' ','g') txt from pg_indexes where schemaname='public'),
pols as (
  select 'pol' kind, tablename||'.'||policyname key, cmd||'|'||roles::text||'|'||coalesce(regexp_replace(qual,'\s+',' ','g'),'')||'|'||coalesce(regexp_replace(with_check,'\s+',' ','g'),'')||'|'||permissive txt from pg_policies where schemaname='public'),
trg as (
  select 'trg' kind, c.relname||'.'||t.tgname key, regexp_replace(pg_get_triggerdef(t.oid),'\s+',' ','g')||'|en='||t.tgenabled::text txt
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
fns as (
  select 'fn' kind, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' key,
    p.prosecdef::text||'|'||p.provolatile::text||'|'||coalesce(p.proconfig::text,'')||'|'||pg_get_function_result(p.oid)||'|'||p.prokind::text||'|'||regexp_replace(coalesce(p.prosrc,''),'\s+','','g') txt
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.oid not in (select objid from ext_objs)),
facl as (
  select 'facl' kind, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' key,
    coalesce((select string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC')||':'||a.privilege_type, ',' order by 1) from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a where a.grantee<>p.proowner),'') txt
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.oid not in (select objid from ext_objs)),
tacl as (
  select 'tacl' kind, c.relname key,
    coalesce((select string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC')||':'||a.privilege_type, ',' order by 1) from aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a where a.grantee<>c.relowner),'') txt
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m')),
cacl as (
  select 'cacl' kind, c.relname||'.'||a.attname key,
    (select string_agg(coalesce(nullif(x.grantee::regrole::text,'-'),'PUBLIC')||':'||x.privilege_type, ',' order by 1) from aclexplode(a.attacl) x where x.grantee<>c.relowner) txt
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attacl is not null and a.attnum>0 and not a.attisdropped),
views as (
  select 'view' kind, viewname key, regexp_replace(definition,'\s+',' ','g') txt from pg_views where schemaname='public'),
enums as (
  select 'enum' kind, t.typname key, (select string_agg(e.enumlabel,',' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid) txt from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e')
select kind, key, md5(txt) h, length(txt) l from (
  select * from cols union all select * from rels union all select * from cons union all select * from idx union all select * from pols
  union all select * from trg union all select * from fns union all select * from facl union all select * from tacl union all select * from cacl union all select * from views union all select * from enums) x
order by kind, key
