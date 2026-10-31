import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { safeError } from '../_shared/safe-error.ts';
import { runSource, type Source } from '../_shared/notice-import.ts';

/**
 * import-official-notices — the hourly collector for APPROVED official sources.
 *
 * Scheduled (when, and only when, an administrator has approved at least one source and the schedule in supabase/deploy/notices-import-cron.sql has been
 * installed) with the cron secret. It does nothing for a source that is not enabled (the database refuses the run), so deploying this function while every
 * source is disabled imports nothing. Optional body { source } runs one source (same checks). It imports NO push sender: imported notices are silent by
 * product rule and the database independently refuses to announce them.
 */
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const only = (await req.json().catch(() => ({})))?.source as string | undefined;
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
    let q = svc.from('notice_import_sources').select('id, feed_kind, feed_url, allowed_hosts, default_category, default_area_ids, expiry_days').eq('is_enabled', true).is('retired_at', null);
    if (only) q = q.eq('id', only);
    const { data: sources, error } = await q;
    if (error) return json({ error: 'Could not read the import sources' }, 500);
    const results = [];
    for (const s of (sources ?? []) as Source[]) {
      results.push(await runSource({ rpc: (fn, args) => svc.rpc(fn, args) as never, fetch: ((url: string, init: RequestInit) => fetch(url, init)) as never }, s));
    }
    return json({ ok: true, sources: results.length, results });
  } catch (err) {
    console.error('[import-official-notices]', err);
    return json({ error: safeError('import-official-notices', err) }, 500);
  }
});
