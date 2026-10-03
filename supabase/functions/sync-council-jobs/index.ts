import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient } from '../_shared/send-push.ts';
import { requireCronSecret } from '../_shared/cron-auth.ts';

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
 * SOURCE (since the September 2026 myjobscotland upgrade): the per-council page
 * /councils/shetland-islands-council/jobs is now an empty shell, so the sync reads the
 * national search results (/search-jobs, 25 cards a page) near Shetland and keeps the
 * cards published by Shetland Islands Council. Two searches (by location, by keyword)
 * are merged so one search changing its ranking cannot hide a vacancy.
 * The old page's parser silently returned 0 jobs for four days; see FAIL-SAFE.
 *
 * FAIL-SAFE — a bad run never wipes good data, and is never silent:
 *   · any fetch failure, on any page, aborts the whole run before anything is written
 *     (a half-read feed must not look like a feed where the rest of the jobs closed)
 *   · a parse that yields no jobs aborts
 *   · a parse that is implausibly small next to what we hold (under 40% of 10+ rows)
 *     still upserts, but does NOT prune
 *   · every run writes a row to job_sync_runs, failures are console.error'd, and a failed
 *     run answers HTTP 502 instead of 200
 * Expired jobs are also hidden independently by row security (expires_at > now()).
 *
 * Auth: callers must send an `x-cron-secret` matching CRON_SECRET. Fails
 * closed — an unconfigured secret is a 503, never an open door.
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
const BASE = 'https://www.myjobscotland.gov.uk';
const COUNCIL = 'Shetland Islands Council';
const COUNCIL_PATH = '/councils/shetland-islands-council/jobs/';
const COUNCIL_LOGO = 'https://admin.myjobscotland.gov.uk/sites/default/files/styles/logo/public/organisations/SIC_mjs.png';
const PAGE_CAP = 8; // 25 results a page: 200 per search is far more than the council ever posts

export type Parsed = {
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

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', pound: '£', eacute: 'é', egrave: 'è', ouml: 'ö', uuml: 'ü', hellip: '…', bull: '•', reg: '®',
};
export const decode = (s: string): string =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED[String(name).toLowerCase()] ?? m;
  });

const strip = (s: string | null | undefined) =>
  s ? decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : null;

// dd/mm/yyyy → ISO at end of that day (Europe/London ~ close of business)
export function ukDateToIso(d: string | null): string | null {
  if (!d) return null;
  const m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T23:59:00Z`;
}

export function mapContract(contract: string | null, position: string | null): string {
  const s = `${contract ?? ''} ${position ?? ''}`.toLowerCase();
  if (/apprentice/.test(s)) return 'apprenticeship';
  if (/volunt/.test(s)) return 'volunteer';
  if (/casual|relief|bank|temporary|fixed.?term|seasonal/.test(s)) return 'casual';
  if (/part.?time/.test(s)) return 'part-time';
  return 'full-time';
}

/**
 * The new cards show the pay range with no unit ("£17.44 - £19.46", "£39,156.00 - £57,450.00"). The
 * old page said "per hour" / "per year", and the app shows pay_text as written, so restore the unit
 * from the size of the number: under £100 is an hourly rate, £1,000 and over is an annual salary.
 * Anything in between is left exactly as published rather than guessed.
 */
export function payWithUnit(raw: string | null): string | null {
  if (!raw) return null;
  const nums = [...raw.matchAll(/£\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  if (nums.length === 0) return raw;
  const text = nums.length === 2 && nums[0] === nums[1] ? raw.split(' - ')[0] : raw;
  if (/\bper\b|\/\s?(hr|hour|year|annum)/i.test(text)) return text;
  const hi = Math.max(...nums);
  if (hi < 100) return `${text} per hour`;
  if (hi >= 1000) return `${text} per year`;
  return text;
}

/**
 * Parse one page of myjobscotland national search results. Only cards published by Shetland
 * Islands Council AND linking into its council path are returned; `cards` is the total number of
 * cards seen (used to know when a page is empty).
 */
export function parseSearchPage(html: string): { jobs: Parsed[]; cards: number } {
  const blocks = html.split('<div class="mjs-card border-light">').slice(1);
  const jobs: Parsed[] = [];
  for (const b of blocks) {
    const publisher = strip(b.match(/Published by\s*([^<]+)</)?.[1]);
    if (publisher !== COUNCIL) continue;
    const a = b.match(/<h3[^>]*>\s*<a href="([^"]+)">([^<]+)<\/a>/);
    if (!a) continue;
    let path: string;
    try { path = new URL(a[1], BASE).pathname; } catch { continue; }
    if (!path.startsWith(COUNCIL_PATH)) continue;
    const idm = path.match(/-(\d+)\/?$/);
    const source_ref = idm ? idm[1] : path;

    const tagBlock = b.match(/<div class="mjs-card__tags">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const tags = [...tagBlock.matchAll(/<span class="mjs-tag mjs-tag__secondary">([\s\S]*?)<\/span>/g)]
      .map((m) => strip(m[1]) ?? '').filter(Boolean);
    const closing = tags.find((t) => /^Closing on/i.test(t)) ?? null;
    const pay = tags.find((t) => t.includes('£')) ?? null;
    const rest = tags.filter((t) => t !== closing && t !== pay);
    const location = strip(b.match(/<div class="mjs-card__description">\s*<p>([\s\S]*?)<\/p>/)?.[1]);

    jobs.push({
      source_ref,
      title: strip(a[2]) ?? '',
      apply_url: BASE + path,
      location,
      contract_type: mapContract(rest.join(' '), rest.join(' ')),
      pay_text: payWithUnit(pay),
      expires_at: ukDateToIso(closing),
      employer_name: COUNCIL,
      employer_logo_url: COUNCIL_LOGO,
    });
  }
  return { jobs, cards: blocks.length };
}

/** The searches that together cover Shetland. Each is paged until a page holds no council job. */
const SEARCHES: Record<string, string>[] = [
  { location: 'ZE1 0NA', distance: '100' },
  { keyword: 'Shetland' },
];

async function fetchPage(params: Record<string, string>, page: number): Promise<string> {
  const qs = new URLSearchParams({ ...params, page: String(page) });
  const res = await fetch(`${BASE}/search-jobs?${qs}`, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  if (!res.ok) throw new Error(`fetch ${res.status} (page ${page})`);
  return await res.text();
}

/** Every Shetland Islands Council vacancy currently listed, or throws if any page cannot be read. */
export async function fetchAllCouncilJobs(): Promise<Parsed[]> {
  const byRef = new Map<string, Parsed>();
  for (const params of SEARCHES) {
    for (let page = 0; page < PAGE_CAP; page++) {
      const { jobs, cards } = parseSearchPage(await fetchPage(params, page));
      if (cards === 0 || jobs.length === 0) break;
      for (const j of jobs) if (!byRef.has(j.source_ref)) byRef.set(j.source_ref, j);
    }
  }
  return [...byRef.values()];
}

const SOURCES = [
  {
    source: 'myjobscotland',
    label: 'via myjobscotland',
    fetchJobs: fetchAllCouncilJobs,
  },
];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Fails CLOSED: no server secret is a 503, a bad or absent header is a 401.
  // Nothing privileged happens above this line.
  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;

  // ?dry=1 → parse + report only, never touch the DB.
  const dry = new URL(req.url).searchParams.get('dry') === '1';
  const sb = createServiceClient();
  const results: Record<string, unknown>[] = [];

  for (const src of SOURCES) {
    const started = Date.now();
    const result: Record<string, unknown> = { source: src.source, ok: false };
    try {
      const jobs = await src.fetchJobs();

      // FAIL-SAFE: never let an empty/broken parse prune live rows.
      if (jobs.length === 0) { result.reason = 'parsed 0 — left existing rows untouched'; }
      else if (dry) { Object.assign(result, { ok: true, dry: true, parsed: jobs.length, sample: jobs.slice(0, 3) }); }
      else {
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

        const { count: held } = await sb.from('jobs').select('id', { count: 'exact', head: true }).eq('source', src.source);
        const { error: upErr } = await sb.from('jobs').upsert(rows, { onConflict: 'source,source_ref' });
        if (upErr) { result.reason = `upsert: ${upErr.message}`; }
        else {
          // A feed that suddenly holds under 40% of what we have is more likely a half-read page than a
          // genuine clear-out: keep what we have (row security hides anything past its closing date anyway).
          const suspicious = (held ?? 0) >= 10 && jobs.length < (held ?? 0) * 0.4;
          let removed: number | string = 0;
          if (!suspicious) {
            // Prune listings that have dropped off the feed (these have no internal applications —
            // apply is external — so a plain delete is clean).
            const keep = jobs.map((j) => j.source_ref);
            const { data, error: delErr } = await sb
              .from('jobs')
              .delete()
              .eq('source', src.source)
              .not('source_ref', 'in', `(${keep.map((r) => `"${r}"`).join(',')})`)
              .select('id');
            removed = delErr ? `err: ${delErr.message}` : (data?.length ?? 0);
          }
          Object.assign(result, { ok: true, synced: rows.length, held: held ?? 0, removed, prune_skipped: suspicious });
        }
      }
    } catch (e) {
      result.reason = String(e);
    }

    if (result.ok !== true) console.error('[sync-council-jobs] source failed:', JSON.stringify(result));
    if (!dry) {
      try {
        await sb.from('job_sync_runs').insert({
          source: src.source,
          ok: result.ok === true,
          reason: (result.reason as string | undefined) ?? null,
          parsed: (result.synced as number | undefined) ?? (result.parsed as number | undefined) ?? 0,
          removed: typeof result.removed === 'number' ? result.removed : 0,
          prune_skipped: result.prune_skipped === true,
          duration_ms: Date.now() - started,
        });
        await sb.from('job_sync_runs').delete().lt('ran_at', new Date(Date.now() - 30 * 86_400_000).toISOString());
      } catch (e) {
        console.error('[sync-council-jobs] could not write the run log:', String(e));
      }
    }
    results.push(result);
  }

  const failed = results.some((r) => r.ok !== true);
  return json({ ran_at: new Date().toISOString(), dry, results }, failed ? 502 : 200);
});
