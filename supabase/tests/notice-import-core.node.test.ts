/**
 * notice-import-core.node.test.ts — the official-notice importer (supabase/functions/_shared/notice-import.ts) against FICTIONAL recorded feeds, with fetch
 * and the database both mocked. Nothing leaves the machine. The database rules (approval, allow-listed links, caps, silence, safe withdrawal) are proven in the
 * isolated-Postgres suite notices-alerts-imports; this proves the importer fetches safely, parses honestly, excerpts rather than copies, and cannot announce.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeUrl, safeFetchText, parseFeed, excerpt, plainText, runSource, MAX_ITEMS, type FetchLike, type Rpc, type Source } from '../functions/_shared/notice-import.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const HOSTS = ['www.example-council.example'];
const SOURCE: Source = { id: 'demo_council', feed_kind: 'rss', feed_url: 'https://www.example-council.example/rss', allowed_hosts: HOSTS, default_category: 'public_services', default_area_ids: ['shetland_wide'], expiry_days: 14 };

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Demo Council</title>
<item><title>Roadworks on the A970 near Brae</title><link>https://www.example-council.example/news/roadworks-brae</link><guid>https://www.example-council.example/news/roadworks-brae</guid>
<pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>Temporary traffic lights will operate near Brae for resurfacing this week. Please allow extra time. <a href="x">Full story</a></p><p>Second paragraph that should not be copied wholesale because it goes on and on about the contractor, the timetable, the diversion routes, the parking arrangements, the working hours, the noise limits and the many other operational details that residents may want to read on the council website itself rather than in a short notice.</p>]]></description></item>
<item><title>Bin collection changes &amp; holiday dates</title><link>https://www.example-council.example/news/bins</link><guid isPermaLink="false">bins-2026-11</guid><pubDate>Tue, 27 Oct 2026 09:00:00 GMT</pubDate><description>Collections move by a day over the holiday.</description></item>
<item><title>Offsite link item</title><link>https://evil.example/phish</link><guid>evil-1</guid><description>This item points somewhere that is not on the allow-list at all.</description></item>
<item><title></title><link>https://www.example-council.example/news/empty</link><guid>empty-1</guid><description>No title here at all, so it is skipped honestly.</description></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Ferry timetable update</title><id>tag:example,2026:ferry-1</id><link href="https://www.example-council.example/ferries/1"/>
<updated>2026-10-28T10:00:00Z</updated><summary>Winter timetable begins on Monday for all inter-island services.</summary></entry></feed>`;
const JSONFEED = JSON.stringify({ items: [{ id: 'j1', url: 'https://www.example-council.example/n/j1', title: 'Consultation open', summary: 'A public consultation on the draft plan is open until the end of the month.', date_published: '2026-10-29T08:00:00Z' }] });

const res = (status: number, body = '', headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body, body: null });
const fetchOf = (...answers: ReturnType<typeof res>[]): FetchLike & { urls: string[] } => { const f = (async (url: string) => { f.urls.push(url); return answers.shift() ?? res(500); }) as FetchLike & { urls: string[] }; f.urls = []; return f; };

describe('URL safety', () => {
  test('1 only https, port 443, no credentials, no IP literals / localhost / internal names, and only allow-listed hosts', () => {
    const ok = (u: string) => assertSafeUrl(u, HOSTS).hostname;
    assert.equal(ok('https://www.example-council.example/rss'), 'www.example-council.example');
    for (const bad of ['http://www.example-council.example/rss', 'https://user:pw@www.example-council.example/', 'https://www.example-council.example:8443/', 'https://127.0.0.1/',
      'https://[::1]/', 'https://localhost/', 'https://intranet/', 'https://printer.local/', 'https://metadata.internal/', 'https://169.254.169.254/latest', 'https://evil.example/',
      'https://www.example-council.example.evil.example/', 'ftp://www.example-council.example/', 'javascript:alert(1)', 'not a url', 'file:///etc/passwd']) {
      assert.throws(() => assertSafeUrl(bad, HOSTS), undefined, bad);
    }
    assert.throws(() => assertSafeUrl('https://www.example-council.example/', []), /allow-list/);
  });
  test('2 redirects are followed by hand and every hop is re-validated: a redirect off the allow-list, to http, or to an internal address is refused', async () => {
    const a = fetchOf(res(302, '', { location: 'https://www.example-council.example/rss2' }), res(200, RSS));
    assert.equal((await safeFetchText(a, 'https://www.example-council.example/rss', HOSTS)).includes('<rss'), true);
    assert.deepEqual(a.urls, ['https://www.example-council.example/rss', 'https://www.example-council.example/rss2']);
    for (const loc of ['https://evil.example/x', 'http://www.example-council.example/x', 'https://169.254.169.254/latest', '//evil.example/x']) {
      await assert.rejects(() => safeFetchText(fetchOf(res(301, '', { location: loc })), 'https://www.example-council.example/rss', HOSTS), undefined, loc);
    }
    await assert.rejects(() => safeFetchText(fetchOf(...Array.from({ length: 6 }, () => res(302, '', { location: 'https://www.example-council.example/loop' }))), 'https://www.example-council.example/rss', HOSTS), /Too many redirects/);
    await assert.rejects(() => safeFetchText(fetchOf(res(302)), 'https://www.example-council.example/rss', HOSTS), /Redirect without a location/);
  });
  test('3 non-200 answers and oversized bodies are failures; a hung source is abandoned by timeout', async () => {
    await assert.rejects(() => safeFetchText(fetchOf(res(503)), 'https://www.example-council.example/rss', HOSTS), /answered 503/);
    await assert.rejects(() => safeFetchText(fetchOf(res(200, 'x'.repeat(1_000_001))), 'https://www.example-council.example/rss', HOSTS), /too large/);
    const hung: FetchLike = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await assert.rejects(() => safeFetchText(hung, 'https://www.example-council.example/rss', HOSTS, { timeoutMs: 20 }), /aborted/);
  });
});

describe('parsing and excerpting', () => {
  test('4 RSS, Atom and JSON feeds parse to titled, linked, dated items with stable references; entities and markup are removed; an unparseable response is an error', () => {
    const rss = parseFeed('rss', RSS);
    assert.equal(rss.length, 4);
    assert.equal(rss[0].reference, 'https://www.example-council.example/news/roadworks-brae');
    assert.equal(rss[1].reference, 'bins-2026-11'); assert.equal(rss[1].title, 'Bin collection changes & holiday dates');
    assert.equal(rss[0].published, '2026-10-26T09:00:00.000Z');
    assert.deepEqual(parseFeed('atom', ATOM).map((i) => [i.reference, i.url, i.published]), [['tag:example,2026:ferry-1', 'https://www.example-council.example/ferries/1', '2026-10-28T10:00:00.000Z']]);
    assert.equal(parseFeed('json', JSONFEED)[0].title, 'Consultation open');
    assert.throws(() => parseFeed('rss', '<html><body>Not a feed</body></html>'), /not a feed/);
    assert.throws(() => parseFeed('json', '{"nope":1}'), /no items array/);
    assert.throws(() => parseFeed('json', 'not json'), /not valid JSON/);
  });
  test('5 the summary is a short plain-text EXCERPT (whole sentences, at most 300 characters), never the full text, never markup, links or scripts', () => {
    const roadworks = parseFeed('rss', RSS)[0];
    assert.equal(roadworks.summary, 'Temporary traffic lights will operate near Brae for resurfacing this week. Please allow extra time.');
    assert.ok(!roadworks.summary.includes('Second paragraph'));
    const long = excerpt('Word '.repeat(200)); assert.ok(long.length <= 300 && long.endsWith('…'));
    assert.equal(plainText('<script>alert(1)</script><b>Bold</b> &amp; &lt;tag&gt; &#163;5 &#x41;'), 'Bold & £5 A', 'entity-encoded markup is removed too: no tag can survive into a notice');
    assert.ok(!/[<>]/.test(excerpt('<img src=x onerror=alert(1)> Hello <b>there</b> friends, welcome to the council notices page of today.')));
  });
  test('6 a feed is capped at 100 items', () => {
    const many = `<rss>${Array.from({ length: 250 }, (_, i) => `<item><title>Item ${i}</title><link>https://www.example-council.example/${i}</link><description>Summary text number ${i} here.</description></item>`).join('')}</rss>`;
    assert.equal(parseFeed('rss', many).length, MAX_ITEMS);
  });
});

describe('a run', () => {
  function db(over: Partial<Record<string, { data?: unknown; error?: { message: string } }>> = {}) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const rpc: Rpc = async (fn, args) => { calls.push({ fn, args }); const o = over[fn]; if (o) return { data: o.data ?? null, error: o.error ?? null }; return { data: fn === 'import_start_run' ? 'run-1' : fn === 'import_upsert_notice' ? 'created' : null, error: null }; };
    return { rpc, calls, names: () => calls.map((c) => c.fn) };
  }
  test('7 a run starts via the database (which refuses disabled / retired / too-recent sources), imports the valid items, skips the off-list and untitled ones, and finishes with honest counts', async () => {
    const d = db();
    const out = await runSource({ rpc: d.rpc, fetch: fetchOf(res(200, RSS)) }, SOURCE);
    assert.deepEqual([out.status, out.fetched, out.created, out.errors], ['partial', 4, 2, 2]);
    const upserts = d.calls.filter((c) => c.fn === 'import_upsert_notice');
    assert.equal(upserts.length, 2);
    assert.ok(upserts.every((u) => String(u.args.p_source_url).startsWith('https://www.example-council.example/')));
    assert.ok(upserts.every((u) => u.args.p_category === null && u.args.p_area_ids === null && u.args.p_expires_at === null), 'category, areas and expiry come from the approved source configuration, never guessed');
    assert.equal(d.calls.at(-1)!.fn, 'import_finish_run');
    assert.equal(d.calls.at(-1)!.args.p_status, 'partial');
  });
  test('8 a clean feed finishes "ok" (so the database may withdraw items the source dropped); a failed fetch finishes "failed" and withdraws nothing', async () => {
    const ok = db(); const a = await runSource({ rpc: ok.rpc, fetch: fetchOf(res(200, ATOM.replace(/<feed/, '<feed'))) }, { ...SOURCE, feed_kind: 'atom' });
    assert.equal(a.status, 'ok'); assert.equal(ok.calls.at(-1)!.args.p_status, 'ok');
    const bad = db(); const b = await runSource({ rpc: bad.rpc, fetch: fetchOf(res(503)) }, SOURCE);
    assert.equal(b.status, 'failed'); assert.match(String(b.note), /503/);
    assert.equal(bad.calls.at(-1)!.args.p_status, 'failed');
    assert.ok(!bad.names().includes('import_upsert_notice'));
    const html = db(); assert.equal((await runSource({ rpc: html.rpc, fetch: fetchOf(res(200, '<html>maintenance</html>')) }, SOURCE)).status, 'failed');
  });
  test('9 a source the database will not run (not enabled / retired / fetched too recently) is skipped WITHOUT any network request', async () => {
    const d = db({ import_start_run: { error: { message: 'That source is not enabled' } } }); const f = fetchOf(res(200, RSS));
    const out = await runSource({ rpc: d.rpc, fetch: f }, SOURCE);
    assert.equal(out.status, 'skipped'); assert.deepEqual(f.urls, []); assert.deepEqual(d.names(), ['import_start_run']);
  });
  test('10 the importer and its entry point can never announce: they import no push sender and call no dispatch function, and the entry point is cron-secret protected', () => {
    for (const f of ['supabase/functions/_shared/notice-import.ts', 'supabase/functions/import-official-notices/index.ts']) {
      const s = src(f);
      assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ''), /send-push|sendUserPush|sendPush|notice_claim_dispatch|notice_dispatch_recipients|notify-/, f);
    }
    const e = src('supabase/functions/import-official-notices/index.ts');
    assert.match(e, /requireCronSecret\(req, corsHeaders\)/); assert.match(e, /\.eq\('is_enabled', true\)\.is\('retired_at', null\)/);
    assert.doesNotMatch(src('supabase/migrations/20261129040000_notice_imports.sql'), /cron\.schedule/, 'no migration can start a schedule');
    assert.match(src('supabase/deploy/notices-import-cron.sql'), /DEPLOYMENT NOTE, NOT A MIGRATION/);
  });
});
