import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient } from '../_shared/send-push.ts';

/**
 * social-composer — the "Peerie Press" recipe runner (Phase 1).
 *
 * Watches platform data and turns it into DRAFT social posts in the
 * social_posts queue, ready for admin review at /admin/social. Never publishes
 * anything itself — that's social-publisher's job.
 *
 * Recipes (rows in social_recipes; each has an `enabled` switch):
 *   • wird_of_day      — one Spik dictionary word a day, never repeated
 *   • whats_on_roundup — Mondays: the next 7 days of events in one card
 *                        (widens to 14 days when the week is thin, so the
 *                        card never goes out looking empty)
 *   • event_spotlight  — events published by PREMIUM businesses get their own post
 *   • jobs_roundup     — Wednesdays: newest open jobs + total count
 *
 * Idempotent: social_posts has a unique (kind, entity_id) index, so re-runs
 * (or overlapping runs) can never queue a duplicate.
 *
 * Captions: deterministic templates, optionally warmed up by Peerie Bot when
 * ANTHROPIC_API_KEY is set (falls back to the template on any AI failure).
 *
 * Invoke on a schedule (daily ~6am is plenty) — see DEPLOY-SOCIAL.md.
 * Auth: if CRON_SECRET is set, callers must send a matching `x-cron-secret`.
 * Body (optional): { "force": true } bypasses day-of-week gates for testing.
 */

const SITE = 'https://oneshetland.com';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

/* ── Europe/London time helpers ─────────────────────────────────────────── */

const londonParts = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), weekday: get('weekday') };
};

/** Next occurrence of `hour`:00 Europe/London, as an ISO string. */
const nextLondonHour = (hour: number): string => {
  const now = new Date();
  // Walk forward in 15-min steps until London wall-clock hits the target hour.
  // (Cheap, DST-proof, and only ever runs ≤ ~100 iterations.)
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 200; i++) {
    const lp = londonParts(d);
    if (lp.hour === hour && d.getTime() > now.getTime()) return d.toISOString();
    d.setTime(d.getTime() + 60 * 60_000);
  }
  return now.toISOString();
};

/** ±25 min of randomness — a feed posting at 08:00:00 sharp every day reads
 *  as a robot; 08:11 one day and 07:43 the next reads as a person. */
const jitter = (iso: string): string =>
  new Date(new Date(iso).getTime() + Math.round((Math.random() * 50 - 25) * 60_000)).toISOString();

const isoWeek = (d: Date): string => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // nearest Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const fmtDow = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/London' }).toUpperCase();

// Clean short links — captions show e.g. oneshetland.com/go/spik. The /go/*
// redirect on the website attaches the utm params AND server-logs a
// social_link_clicked analytics event, so clicks count in /admin/analytics.
const go = (slug: string) => `${SITE}/go/${slug}`;

/* ── Optional Peerie Bot caption polish ─────────────────────────────────── */

// Condensed product knowledge — keep in step with the full version in
// oneshetland-web/lib/peerie-bot-context.ts (the single source to edit).
const ONESHETLAND_CONTEXT = `About OneShetland: the community app and website for the Shetland Isles (oneshetland.com) — one place for island life, built in Shetland; currently in testing/pre-launch, app coming to iOS and Android. Sections: What's On (/whats-on — every Shetland event, tickets, journey planner with buses and ferries), Directory (/directory — hundreds of Shetland businesses, free to claim), Local (offers, loyalty stamps, wallet pay), Work — Jobs & Shifts (/jobs — local vacancies incl. council roles, plus one-off shifts), Spik (/spik — living Shaetlan dialect dictionary with audio, word of the day, Guess da Wird game), Da Boats (the fishing fleet past and present), Auld Stories (community memories), Cruise (ship-visit days), Hubs (clubs and halls), Fetch (community deliveries), Games. Businesses: free claimable listing; paid plans add offers/loyalty/bookings/ticketing (point them to oneshetland.com/business; never quote prices). Facts discipline: these are the only product facts you know — never invent user numbers, launch dates, awards, partnerships or statistics.`;

async function polishCaption(template: string, context: string): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return template;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('SOCIAL_CAPTION_MODEL') ?? 'claude-sonnet-5',
        max_tokens: 400,
        system:
          'You write Facebook captions for OneShetland, the Shetland community app. Voice: warm, plain-spoken, community-first, standard English — like a real person running a local page, not a brand. Shetland dialect may appear ONLY as quoted content being featured (e.g. the word of the day itself or its example sentence) — never write the caption copy itself in dialect. VARIETY IS ESSENTIAL: vary the opener, structure and length from post to post; never fall into a repeating format; skip the all-caps template headers unless they genuinely help. Occasionally (not every time) nod naturally to the day of the week or time of year. No corporate speak, no exclamation-mark spam, at most 2 relevant emoji (sometimes none). Keep every URL from the draft EXACTLY as-is. 1–4 short lines plus the link line. Reply with the caption only.\n\n' + ONESHETLAND_CONTEXT,
        messages: [{ role: 'user', content: `Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })}.\nContext: ${context}\n\nDraft caption to improve:\n${template}` }],
      }),
    });
    if (!res.ok) return template;
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    // Safety: never accept a caption that lost its link.
    return text && text.includes(SITE) ? text : template;
  } catch {
    return template;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const secret = Deno.env.get('CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') !== secret) {
    return json({ error: 'forbidden' }, 403);
  }

  let force = false;
  try { force = Boolean((await req.json())?.force); } catch { /* no body */ }

  try {
    const svc = createServiceClient();
    const now = new Date();
    const today = londonParts(now);
    const result = { wird_of_day: 0, whats_on_roundup: 0, event_spotlight: 0, jobs_roundup: 0, new_product: 0, errors: [] as string[] };

    type Recipe = { key: string; enabled: boolean; config: Record<string, unknown> };
    const { data: recipeRows } = await svc.from('social_recipes').select('*');
    const recipes = new Map<string, Recipe>(((recipeRows ?? []) as Recipe[]).map((r) => [r.key, r]));
    const enabled = (k: string) => recipes.get(k)?.enabled === true;
    const cfg = (k: string): Record<string, unknown> => (recipes.get(k)?.config ?? {}) as Record<string, unknown>;
    const touch = (k: string) => svc.from('social_recipes').update({ last_run_at: now.toISOString() }).eq('key', k);

    /* ── Wird o' da Day ──────────────────────────────────────────────────── */
    if (enabled('wird_of_day')) {
      try {
        // One per London day, worded as entity_id `<wordId>` + a daily gate.
        const { data: todays } = await svc
          .from('social_posts').select('id').eq('kind', 'wird_of_day')
          .gte('created_at', `${today.ymd}T00:00:00Z`).limit(1);
        if (!todays?.length) {
          const { data: used } = await svc
            .from('social_posts').select('entity_id').eq('kind', 'wird_of_day').limit(5000);
          const usedIds = new Set((used ?? []).map((u: { entity_id: string | null }) => u.entity_id));
          const { data: words } = await svc
            .from('spik_dictionary')
            .select('id, word, short_meaning, example_sentence, part_of_speech')
            .not('short_meaning', 'is', null)
            .not('example_sentence', 'is', null)
            .or('word_status.is.null,word_status.in.(approved,published)')
            .limit(600);
          const pool = (words ?? []).filter((w: { id: number }) => !usedIds.has(String(w.id)));
          if (pool.length) {
            const w = pool[Math.floor(Math.random() * pool.length)];
            const link = go('spik');
            const template =
              `WORD OF THE DAY 🗣️\n\n${w.word} — ${w.short_meaning}\n\n“${w.example_sentence}”\n\nDiscover more Shetland words: ${link}`;
            const caption = await polishCaption(template, `Shetland dialect word of the day: "${w.word}" meaning "${w.short_meaning}".`);
            const { error } = await svc.from('social_posts').insert({
              kind: 'wird_of_day', entity_type: 'spik_word', entity_id: String(w.id),
              caption,
              image_url: `${SITE}/api/social-image?kind=wird&id=${w.id}`,
              link_url: link,
              scheduled_for: jitter(nextLondonHour(Number(cfg('wird_of_day').hour ?? 8))),
            });
            if (!error) result.wird_of_day++; else result.errors.push(`wird insert: ${error.message}`);
          }
          await touch('wird_of_day');
        }
      } catch (e) { result.errors.push(`wird_of_day: ${e}`); }
    }

    /* ── Whit's On dis week (Mondays) ────────────────────────────────────── */
    if (enabled('whats_on_roundup')) {
      try {
        const isMonday = today.weekday === 'Mon';
        if (isMonday || force) {
          const week = isoWeek(now);
          const from = `${today.ymd}T00:00:00Z`;
          const max = Number(cfg('whats_on_roundup').max_events ?? 8);
          const fetchWindow = async (days: number) => {
            const to = new Date(now.getTime() + days * 86400_000).toISOString();
            const { data } = await svc
              .from('events')
              .select('id, title, starts_at, venue, locality')
              .eq('status', 'published').eq('is_hidden', false)
              .gte('starts_at', from).lt('starts_at', to)
              .order('starts_at', { ascending: true })
              .limit(max);
            return data ?? [];
          };
          // A one-event card looks dead — widen to a fortnight when thin.
          let days = 7;
          let events = await fetchWindow(7);
          if (events.length < 3) { days = 14; events = await fetchWindow(14); }
          if (events.length) {
            const link = go('whats-on');
            const lines = events.map((e: { title: string; starts_at: string; venue: string | null }) =>
              `${fmtDow(e.starts_at)} ${new Date(e.starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' })} · ${e.title}${e.venue ? ` — ${e.venue}` : ''}`).join('\n');
            const template =
              `${days <= 7 ? "WHAT'S ON THIS WEEK" : 'COMING UP IN SHETLAND'} 📅\n\n${lines}\n\nFull details & tickets: ${link}`;
            const caption = await polishCaption(template, `Roundup of ${events.length} events happening in Shetland over the next ${days} days.`);
            const { error } = await svc.from('social_posts').insert({
              kind: 'whats_on_roundup', entity_type: 'week', entity_id: week,
              caption,
              image_url: `${SITE}/api/social-image?kind=roundup&start=${today.ymd}&days=${days}`,
              link_url: link,
              scheduled_for: jitter(nextLondonHour(Number(cfg('whats_on_roundup').hour ?? 9))),
            });
            if (!error) result.whats_on_roundup++; else result.errors.push(`roundup insert: ${error.message}`);
          }
          await touch('whats_on_roundup');
        }
      } catch (e) { result.errors.push(`whats_on_roundup: ${e}`); }
    }

    /* ── Jobs roundup (Wednesdays) — newest open roles + total count ──────── */
    if (enabled('jobs_roundup')) {
      try {
        const isWednesday = today.weekday === 'Wed';
        if (isWednesday || force) {
          const week = isoWeek(now);
          const { count } = await svc
            .from('jobs').select('id', { count: 'exact', head: true })
            .eq('status', 'open').eq('is_hidden', false);
          const { data: jobs } = await svc
            .from('jobs')
            .select('title, external_employer_name, locality, location, local_businesses!posted_as_business_id(name)')
            .eq('status', 'open').eq('is_hidden', false)
            .order('posted_at', { ascending: false })
            .limit(Number(cfg('jobs_roundup').max_jobs ?? 6));
          if (count && jobs?.length) {
            const link = go('jobs');
            const lines = jobs.map((j: { title: string; external_employer_name: string | null; locality: string | null; location: string | null; local_businesses?: { name?: string } | { name?: string }[] }) => {
              const biz = Array.isArray(j.local_businesses) ? j.local_businesses[0] : j.local_businesses;
              const employer = biz?.name ?? j.external_employer_name;
              return `• ${j.title}${employer ? ` — ${employer}` : ''}`;
            }).join('\n');
            const template =
              `HIRING IN SHETLAND 💼\n\n${lines}\n\n${count} open role${count === 1 ? '' : 's'} across the isles — browse and apply: ${link}`;
            const caption = await polishCaption(template, `Weekly jobs roundup: ${count} open roles in Shetland right now.`);
            const { error } = await svc.from('social_posts').insert({
              kind: 'jobs_roundup', entity_type: 'week', entity_id: week,
              caption,
              image_url: `${SITE}/api/social-image?kind=jobs`,
              link_url: link,
              scheduled_for: jitter(nextLondonHour(Number(cfg('jobs_roundup').hour ?? 9))),
            });
            if (!error) result.jobs_roundup++; else result.errors.push(`jobs insert: ${error.message}`);
          }
          await touch('jobs_roundup');
        }
      } catch (e) { result.errors.push(`jobs_roundup: ${e}`); }
    }

    /* ── New product spotlights — Shop Shetland's marketing loop ─────────── */
    if (enabled('new_product')) {
      try {
        const maxPerRun = Number(cfg('new_product').max_per_run ?? 2);
        const { data: candidates } = await svc
          .from('products')
          .select('id, title, price_pence, stock_mode, photos, created_at, business:local_businesses(name, is_active)')
          .eq('is_active', true)
          .is('sold_at', null)
          .order('created_at', { ascending: false })
          .limit(20);
        const { data: done } = await svc
          .from('social_posts').select('entity_id').eq('kind', 'new_product').limit(5000);
        const doneIds = new Set((done ?? []).map((d: { entity_id: string | null }) => d.entity_id));
        let created = 0;
        for (const prod of (candidates ?? []) as Record<string, unknown>[]) {
          if (created >= maxPerRun) break;
          if (doneIds.has(prod.id as string)) continue;
          const biz = (Array.isArray(prod.business) ? (prod.business as Record<string, unknown>[])[0] : prod.business) as { name?: string; is_active?: boolean } | null;
          if (!biz?.is_active) continue;
          if (!(prod.photos as string[])?.length) continue;             // photo-less posts don't sell
          if ((biz.name ?? '').toUpperCase().startsWith('DEMO')) continue; // never market test data
          const price = `£${((prod.price_pence as number) / 100).toFixed(2)}`;
          const modeLine = prod.stock_mode === 'one_off' ? '\nOne of a kind — first come, first served.'
            : prod.stock_mode === 'made_to_order' ? '\nMade to order, just for you.' : '';
          const link = go(`product/${prod.id}`);
          const template =
            `NEW IN 🛍️\n\n${prod.title} — ${price}, from ${biz.name}.${modeLine}\n\nSee it: ${link}`;
          const caption = await polishCaption(template, `New product for sale on OneShetland: "${prod.title}" (${price}) from ${biz.name}.`);
          const { error } = await svc.from('social_posts').insert({
            kind: 'new_product', entity_type: 'product', entity_id: prod.id,
            caption,
            image_url: `${SITE}/api/social-image?kind=product&id=${prod.id}`,
            link_url: link,
            scheduled_for: jitter(nextLondonHour(Number(cfg('new_product').hour ?? 11))),
          });
          if (!error) { created++; result.new_product++; }
          else result.errors.push(`new_product insert: ${error.message}`);
        }
        await touch('new_product');
      } catch (e) { result.errors.push(`new_product: ${e}`); }
    }

    /* ── Event spotlight — premium businesses' events get their own post ─── */
    if (enabled('event_spotlight')) {
      try {
        const maxPerRun = Number(cfg('event_spotlight').max_per_run ?? 2);
        const { data: candidates } = await svc
          .from('events')
          .select('id, title, starts_at, venue, locality, cover_url, organiser_business_id, local_businesses!events_organiser_business_id_fkey(subscription_tier, name)')
          .eq('status', 'published').eq('is_hidden', false)
          .not('organiser_business_id', 'is', null)
          .gt('starts_at', now.toISOString())
          .order('starts_at', { ascending: true })
          .limit(25);
        const premium = (candidates ?? []).filter((e: { local_businesses?: { subscription_tier?: string } | { subscription_tier?: string }[] }) => {
          const b = Array.isArray(e.local_businesses) ? e.local_businesses[0] : e.local_businesses;
          return b?.subscription_tier === 'premium';
        });
        const { data: done } = await svc
          .from('social_posts').select('entity_id').eq('kind', 'event_spotlight').limit(5000);
        const doneIds = new Set((done ?? []).map((d: { entity_id: string | null }) => d.entity_id));
        let created = 0;
        for (const e of premium) {
          if (created >= maxPerRun) break;
          if (doneIds.has(e.id)) continue;
          const b = Array.isArray(e.local_businesses) ? e.local_businesses[0] : e.local_businesses;
          const where = [e.venue, e.locality].filter(Boolean).join(', ');
          const link = go(`event/${e.id}`);
          const template =
            `${e.title} 🎟️\n\n${fmtDay(e.starts_at)} · ${fmtTime(e.starts_at)}${where ? `\n${where}` : ''}\n\nTickets & details: ${link}`;
          const caption = await polishCaption(template, `Event by ${b?.name ?? 'a local business'} in Shetland: ${e.title}.`);
          const { error } = await svc.from('social_posts').insert({
            kind: 'event_spotlight', entity_type: 'event', entity_id: e.id,
            business_id: e.organiser_business_id,
            caption,
            image_url: `${SITE}/api/social-image?kind=event&id=${e.id}`,
            link_url: link,
            scheduled_for: jitter(nextLondonHour(Number(cfg('event_spotlight').hour ?? 18))),
          });
          if (!error) { created++; result.event_spotlight++; }
        }
        await touch('event_spotlight');
      } catch (e) { result.errors.push(`event_spotlight: ${e}`); }
    }

    return json({ ok: true, ...result });
  } catch (err) {
    console.error('[social-composer] fatal', err);
    return json({ error: String(err) }, 500);
  }
});
