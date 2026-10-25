select 'storage.policy' kind, policyname key, md5(cmd||'|'||roles::text||'|'||coalesce(regexp_replace(qual,'\s+',' ','g'),'')||'|'||coalesce(regexp_replace(with_check,'\s+',' ','g'),'')) h from pg_policies where schemaname='storage' and tablename='objects'
union all select 'storage.bucket', id, md5(coalesce(public::text,'')||'|'||coalesce(file_size_limit::text,'')||'|'||coalesce(allowed_mime_types::text,'')) from storage.buckets
order by 1,2
