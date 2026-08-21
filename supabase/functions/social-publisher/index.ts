import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient } from '../_shared/send-push.ts';
import { requireCronSecret } from '../_shared/cron-auth.ts';

/**
 * social-publisher — posts due, human-approved social_posts to the OneShetland
 * Facebook Page via the Meta Graph API. (Instagram lands in Phase 2 — the
 * queue's `channels` column is already multi-channel.)
 *
 * Picks posts with status approved/scheduled whose scheduled_for is unset or
 * in the past, publishes them oldest-first, and records the outcome on the row
 * (status posted/failed, posted_ids.facebook, error). A post scheduled more
 * than 48h ago is marked skipped instead of published, so a paused pipeline
 * never floods the page with stale backlog when it wakes up.
 *
 * Config (Supabase function secrets):
 *   META_PAGE_ID     — the Facebook Page id
 *   META_PAGE_TOKEN  — a long-lived Page access token
 * Until both are set the function is a safe no-op that reports what's due.
 *
 * Invoke every ~15 min (see DEPLOY-SOCIAL.md). Auth: matching `x-cron-secret`;
 * fails closed if CRON_SECRET is unset. Body (optional): { "post_id": "<uuid>" } publishes
 * that single post immediately, ignoring its schedule (admin "post now").
 */

const GRAPH = 'https://graph.facebook.com/v23.0';
const MAX_PER_RUN = 5;
const STALE_HOURS = 48;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

interface PostRow {
  id: string;
  caption: string;
  image_url: string | null;
  link_url: string | null;
  channels: string[];
  status: string;
  scheduled_for: string | null;
  posted_ids: Record<string, string>;
}

async function postToFacebook(pageId: string, token: string, post: PostRow): Promise<string> {
  // Photo post when we have an image (the branded card), plain link post otherwise.
  const endpoint = post.image_url ? `${GRAPH}/${pageId}/photos` : `${GRAPH}/${pageId}/feed`;
  const body = new URLSearchParams(
    post.image_url
      ? { url: post.image_url, caption: post.caption, access_token: token }
      : { message: post.caption, ...(post.link_url ? { link: post.link_url } : {}), access_token: token },
  );
  const res = await fetch(endpoint, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message ?? `Graph API ${res.status}`);
  }
  // /photos returns {id, post_id}; /feed returns {id}. Prefer the feed post id.
  return String(data.post_id ?? data.id);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Fails CLOSED: no server secret is a 503, a bad or absent header is a 401.
  // Nothing privileged happens above this line.
  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;

  let onlyPostId: string | null = null;
  try { onlyPostId = (await req.json())?.post_id ?? null; } catch { /* no body */ }

  try {
    const svc = createServiceClient();
    const now = new Date();
    const nowIso = now.toISOString();

    let due: PostRow[] = [];
    if (onlyPostId) {
      const { data } = await svc
        .from('social_posts').select('*')
        .eq('id', onlyPostId)
        .in('status', ['draft', 'approved', 'scheduled'])
        .limit(1);
      due = (data ?? []) as PostRow[];
    } else {
      const { data } = await svc
        .from('social_posts').select('*')
        .in('status', ['approved', 'scheduled'])
        .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
        .order('scheduled_for', { ascending: true, nullsFirst: true })
        .limit(MAX_PER_RUN);
      due = (data ?? []) as PostRow[];
    }

    const pageId = Deno.env.get('META_PAGE_ID');
    const token = Deno.env.get('META_PAGE_TOKEN');
    if (!pageId || !token) {
      return json({ ok: true, configured: false, due: due.length, note: 'Set META_PAGE_ID + META_PAGE_TOKEN to start publishing.' });
    }

    const result = { posted: 0, failed: 0, skipped: 0, errors: [] as string[] };

    for (const post of due) {
      // Stale guard: never dump old backlog onto the page (manual "post now" is exempt).
      if (!onlyPostId && post.scheduled_for &&
          now.getTime() - new Date(post.scheduled_for).getTime() > STALE_HOURS * 3600_000) {
        await svc.from('social_posts')
          .update({ status: 'skipped', error: `stale: scheduled_for more than ${STALE_HOURS}h ago` })
          .eq('id', post.id);
        result.skipped++;
        continue;
      }

      try {
        const fbId = await postToFacebook(pageId, token, post);
        await svc.from('social_posts').update({
          status: 'posted',
          posted_at: nowIso,
          posted_ids: { ...(post.posted_ids ?? {}), facebook: fbId },
          error: null,
        }).eq('id', post.id);
        result.posted++;
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        await svc.from('social_posts').update({ status: 'failed', error: msg }).eq('id', post.id);
        result.failed++;
        result.errors.push(`${post.id}: ${msg}`);
      }
    }

    return json({ ok: true, configured: true, ...result });
  } catch (err) {
    console.error('[social-publisher] fatal', err);
    return json({ error: String(err) }, 500);
  }
});
