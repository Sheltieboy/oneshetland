import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient } from '../_shared/send-push.ts';

/**
 * sync-council-jobs
 *
 * Scheduled sync of Shetland public-sector vacancies into the Work section.
 * Source: Shetland Islands Council on myjobscotland (server-rendered HTML).
 * Applications always go OUT to the official listing (apply_url) — we never
 * copy full descriptions, only the facts (title, location, pay, closing date)
 * and link back. Rows are keyed on (source, source_ref) and upserted, so the
 * feed stays in sync run to run; listings that drop off are removed.
 *
 * FAIL-SAFE: if the fetch fails or the parse yields no jobs, we abort and leave
 * the existing rows untouched — a bad run never wipes good data.
 *
 * Auth: if CRON_SECRET is set, callers must send a matching `x-cron-secret`.
 * Deploy with --no-verify-jwt (cron-invoked, no user JWT).
 *
 * Adding NHS Shetland (JobTrain) later = another SOURCES entry with its own
 * fetch/parse; the upsert/prune logic is shared.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const UA = 'OneShetlandJobsBot/1.0 (+https://oneshetland.com; jobs aggregation, links back to source)';

type Parsed = {
  source_ref: string;
  title: string;
  apply_url: string;
  location: string | null;
  contract_type: string;
  pay_text: string | null;
  expires_at: string | null;
  employer_name: string;
  employer_logo_url: string | null;
};

const strip = (s: string | null | undefined) =>
  s ? s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim() : null;

// dd/mm/yyyy → ISO at end of that day (Europe/London ~ close of business)
function ukDateToIso(d: string | null): string | null {
  if (!d) return null;
  const m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T23:59:00Z`;
}

function mapContract(contract: string | null, position: string | null): string {
  const s = `${contract ?? ''} ${position ?? ''}`.toLowerCase();
  if (/apprentice/.test(s)) return 'apprenticeship';
  if (/volunt/.test(s)) return 'volunteer';
  if (/casual|relief|bank|temporary|fixed.?term|seasonal/.test(s)) return 'casual';
  if (/part.?time/.test(s)) return 'part-time';
  return 'full-time';
}

/** Parse the myjobscotland Shetland Islands Council jobs page. */
function parseMyJobScotland(html: string): Parsed[] {
  const BASE = 'https://www.myjobscotland.gov.uk';
  const out: Parsed[] = [];
  const blocks = html.split(/<article class="job-listing/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<h3><a href="(\/councils\/shetland-islands-council\/jobs\/[^"]+)">([^<]+)<\/a>/);
    if (!a) continue;
    const path = a[1];
    const idm = path.match(/-(\d+)(?:[/?#].*)?$/);
    const source_ref = idm ? idm[1] : path;
    const loc = b.match(/<p><span[^>]*>([^<]+)<\/span>/);
    const dd = (label: string) => {
      const m = b.match(new RegExp('<dt>\\s*' + label + '\\s*</dt><dd><div>([^<]+)</div>', 'i'));
      return m ? strip(m[1]) : null;
    };
    const logo = b.match(/src="(\/\/admin\.myjobscotland[^"]+\.(?:png|jpe?g|svg))"/i);
    out.push({
      source_ref,
      title: strip(a[2]) ?? '',
      apply_url: BASE + path,
      location: loc ? strip(loc[1]) : null,
      contract_type: mapContract(dd('Contract Type'), dd('Position Type')),
      pay_text: dd('Salary'),
      expires_at: ukDateToIso(dd('Closing Date')),
      employer_name: 'Shetland Islands Council',
      employer_logo_url: logo ? 'https:' + logo[1] : null,
    });
  }
  return out;
}

const SOURCES = [
  {
    source: 'myjobscotland',
    label: 'via myjobscotland',
    url: 'https://www.myjobscotland.gov.uk/councils/shetland-islands-council/jobs',
    parse: parseMyJobScotland,
  },
];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const secret = Deno.env.get('CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') !== secret) return json({ error: 'unauthorized' }, 401);

  // ?dry=1 → parse + report only, never touch the DB.
  const dry = new URL(req.url).searchParams.get('dry') === '1';
  const sb = createServiceClient();
  const results: Record<string, unknown>[] = [];

  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
      if (!res.ok) { results.push({ source: src.source, ok: false, reason: `fetch ${res.status}` }); continue; }
      const html = await res.text();
      const jobs = src.parse(html);

      // FAIL-SAFE: never let an empty/broken parse prune live rows.
      if (jobs.length === 0) { results.push({ source: src.source, ok: false, reason: 'parsed 0 — left existing rows untouched' }); continue; }
      if (dry) { results.push({ source: src.source, ok: true, dry: true, parsed: jobs.length, sample: jobs.slice(0, 3) }); continue; }

      const rows = jobs.map((j) => ({
        source: src.source,
        source_ref: j.source_ref,
        source_label: src.label,
        title: j.title.slice(0, 200),
        location: j.location,
        contract_type: j.contract_type,
        pay_text: j.pay_text,
        pay_hidden: !j.pay_text,
        apply_url: j.apply_url,
        expires_at: j.expires_at,
        external_employer_name: j.employer_name,
        external_employer_logo_url: j.employer_logo_url,
        employer_id: null,
        posted_as_business_id: null,
        status: 'open',
        is_hidden: false,
        updated_at: new Date().toISOString(),
      }));

      const { error: upErr } = await sb.from('jobs').upsert(rows, { onConflict: 'source,source_ref' });
      if (upErr) { results.push({ source: src.source, ok: false, reason: `upsert: ${upErr.message}` }); continue; }

      // Prune listings that have dropped off the feed (these have no internal
      // applications — apply is external — so a plain delete is clean).
      const keep = jobs.map((j) => j.source_ref);
      const { data: removed, error: delErr } = await sb
        .from('jobs')
        .delete()
        .eq('source', src.source)
        .not('source_ref', 'in', `(${keep.map((r) => `"${r}"`).join(',')})`)
        .select('id');

      results.push({
        source: src.source,
        ok: true,
        synced: rows.length,
        removed: delErr ? `err: ${delErr.message}` : (removed?.length ?? 0),
      });
    } catch (e) {
      results.push({ source: src.source, ok: false, reason: String(e) });
    }
  }

  return json({ ran_at: new Date().toISOString(), dry, results });
});
