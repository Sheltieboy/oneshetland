/**
 * notice-import.ts — fetch an APPROVED official source's feed and turn its items into attributed, silent, expiring notices.
 *
 * Pure (no Deno / network imports): `fetch` and `rpc` are injected, so `node --test` runs it against recorded fixtures with nothing leaving the machine.
 *
 *   SAFETY       https only, port 443, no credentials, no IP literals / localhost / internal names, the host must be on the source's allow-list, redirects are
 *                followed by hand (max 3) and each hop re-validated, a hard timeout and a 1 MB body cap. A response that is not feed-shaped is a failed run.
 *   ORIGINALITY  an item becomes a short EXCERPT (first sentences, at most 300 characters, tags and entities stripped) with the source's own link - never the
 *                full text. Reuse conditions for each source are confirmed by an administrator before it can be enabled (see the database).
 *   IDENTITY     the item's stable id (guid / id / url) is the source reference, so a re-fetch updates in place.
 *   SILENCE      this module imports no push sender and calls no dispatch function; the database independently refuses to announce any imported notice.
 * Nothing is invented: a title, link or date the feed does not provide is skipped or left null, and no item is given a publication time it does not have.
 */

export type FeedKind = 'rss' | 'atom' | 'json';
export type FeedItem = { reference: string; title: string; summary: string; url: string; published: string | null };
export type Source = { id: string; feed_kind: FeedKind; feed_url: string; allowed_hosts: string[]; default_category: string; default_area_ids: string[]; expiry_days: number };
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
export type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) =>
  Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string>; body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null }>;

export const MAX_BYTES = 1_000_000;
export const MAX_ITEMS = 100;
export const SUMMARY_MAX = 300;

// ── URL safety ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export function assertSafeUrl(raw: string, allowedHosts: string[]): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('Not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('Only https is allowed');
  if (u.username || u.password) throw new Error('Credentials in a URL are not allowed');
  if (u.port && u.port !== '443') throw new Error('Only the standard https port is allowed');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || IPV4.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    throw new Error('That host is not allowed');
  }
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) throw new Error('That host is not on the allow-list');
  return u;
}

export async function safeFetchText(fetchFn: FetchLike, url: string, allowedHosts: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  let current = assertSafeUrl(url, allowedHosts).toString();
  for (let hop = 0; hop <= 3; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetchFn(current, { redirect: 'manual', signal: ctl.signal, headers: { accept: 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.8', 'user-agent': 'OneShetlandNoticesImporter/1.0 (+https://oneshetland.com)' } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Redirect without a location');
        current = assertSafeUrl(new URL(loc, current).toString(), allowedHosts).toString();   // every hop is re-validated against the allow-list
        continue;
      }
      if (res.status !== 200) throw new Error(`The source answered ${res.status}`);
      const max = opts.maxBytes ?? MAX_BYTES;
      let text = '';
      if (res.body?.getReader) {
        const reader = res.body.getReader(); const dec = new TextDecoder(); let total = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; total += value?.byteLength ?? 0; if (total > max) throw new Error('The feed is too large'); text += dec.decode(value, { stream: true }); }
      } else {
        text = await res.text(); if (text.length > max) throw new Error('The feed is too large');
      }
      return text;
    } finally { clearTimeout(timer); }
  }
  throw new Error('Too many redirects');
}

// ── text helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', pound: '£' };
export const decodeEntities = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});
/** Strip markup and scripts, decode entities, collapse whitespace. Output is plain text only. */
export function plainText(html: string): string {
  const noCdata = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const noScripts = noCdata.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities(noScripts.replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
/** A short excerpt: whole sentences up to `max` characters; if the first sentence is longer, cut at a word boundary with an ellipsis. */
export function excerpt(text: string, max = SUMMARY_MAX): string {
  const t = plainText(text);
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const s of sentences) { if ((out + s).trim().length > max) break; out += s; }
  if (out.trim().length >= 40) return out.trim();
  const cut = t.slice(0, max - 1); return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trimEnd()}…`;
}

// ── parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const blocks = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);
const tagText = (b: string, tag: string) => { const m = b.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')); return m ? plainText(m[1]) : ''; };
const iso = (v: string) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export function parseFeed(kind: FeedKind, text: string): FeedItem[] {
  const items: FeedItem[] = [];
  if (kind === 'json') {
    let j: { items?: Record<string, unknown>[] };
    try { j = JSON.parse(text); } catch { throw new Error('The feed is not valid JSON'); }
    if (!Array.isArray(j.items)) throw new Error('The feed has no items array');
    for (const it of j.items.slice(0, MAX_ITEMS)) {
      const url = String(it.url ?? it.external_url ?? ''); const ref = String(it.id ?? url);
      if (!url || !ref) continue;
      items.push({ reference: ref.slice(0, 200), title: plainText(String(it.title ?? '')), summary: excerpt(String(it.summary ?? it.content_text ?? it.content_html ?? '')), url, published: iso(String(it.date_published ?? '')) });
    }
    return items;
  }
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new Error('The response is not a feed');
  if (kind === 'rss') {
    for (const b of blocks(text, 'item').slice(0, MAX_ITEMS)) {
      const link = tagText(b, 'link'); const guid = tagText(b, 'guid') || link;
      if (!link || !guid) continue;
      items.push({ reference: guid.slice(0, 200), title: tagText(b, 'title'), summary: excerpt(tagText(b, 'description') || tagText(b, 'content:encoded')), url: link, published: iso(tagText(b, 'pubDate')) });
    }
  } else {
    for (const b of blocks(text, 'entry').slice(0, MAX_ITEMS)) {
      const href = (b.match(/<link[^>]*\bhref="([^"]+)"/i) ?? [])[1] ?? ''; const id = tagText(b, 'id') || href;
      if (!href || !id) continue;
      items.push({ reference: id.slice(0, 200), title: tagText(b, 'title'), summary: excerpt(tagText(b, 'summary') || tagText(b, 'content')), url: decodeEntities(href), published: iso(tagText(b, 'published') || tagText(b, 'updated')) });
    }
  }
  return items;
}

// ── one run ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type RunOutcome = { source: string; status: 'ok' | 'partial' | 'failed' | 'skipped'; fetched: number; created: number; updated: number; unchanged: number; withdrawn: number; errors: number; note?: string };

export async function runSource(deps: { rpc: Rpc; fetch: FetchLike }, s: Source): Promise<RunOutcome> {
  const out: RunOutcome = { source: s.id, status: 'failed', fetched: 0, created: 0, updated: 0, unchanged: 0, withdrawn: 0, errors: 0 };
  const start = await deps.rpc('import_start_run', { p_source: s.id });
  if (start.error) return { ...out, status: 'skipped', note: start.error.message };          // disabled, retired or fetched too recently
  const run = String(start.data);
  let error: string | null = null;
  try {
    const text = await safeFetchText(deps.fetch, s.feed_url, s.allowed_hosts);
    const items = parseFeed(s.feed_kind, text);
    out.fetched = items.length;
    for (const it of items) {
      if (!it.title || it.title.length < 3 || it.summary.length < 10) { out.errors++; continue; }
      try { assertSafeUrl(it.url, s.allowed_hosts); } catch { out.errors++; continue; }
      const r = await deps.rpc('import_upsert_notice', {
        p_source: s.id, p_reference: it.reference, p_title: it.title.slice(0, 200), p_summary: it.summary, p_source_url: it.url, p_source_published_at: it.published,
        p_category: null, p_area_ids: null, p_expires_at: null,                         // the source's configured defaults and expiry apply; nothing is guessed
      });
      if (r.error) { out.errors++; continue; }
      const res = String(r.data);
      if (res === 'created') out.created++; else if (res === 'updated') out.updated++; else if (res === 'unchanged') out.unchanged++;
    }
    out.status = out.errors > 0 ? 'partial' : 'ok';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e); out.status = 'failed'; out.note = error;
  }
  const fin = await deps.rpc('import_finish_run', { p_run: run, p_status: out.status, p_fetched: out.fetched, p_created: out.created, p_updated: out.updated, p_unchanged: out.unchanged, p_errors: out.errors, p_error: error });
  if (!fin.error && typeof fin.data === 'number') out.withdrawn = fin.data;
  return out;
}
