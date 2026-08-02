import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush, sendUserPushBulk } from '../_shared/send-push.ts';

/**
 * notify-engagement
 *
 * The social layer that brings people back: comments, reactions and replies on
 * Aald Memories (memories) and Da Boats (vessels). Previously all silent.
 *
 *   event 'memory_comment' { comment_id }  → story author (someone commented).
 *   event 'memory_reaction'{ memory_id, actor_id } → story author (someone reacted).
 *   event 'vessel_comment' { comment_id }  → reply: the parent commenter;
 *                                            top-level: everyone in the thread.
 *
 * Module 'community'. Never notifies you about your own action. Fire-and-forget.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Svc = ReturnType<typeof createServiceClient>;

async function actorName(svc: Svc, userId: string | null | undefined): Promise<string> {
  if (!userId) return 'Someone';
  const { data } = await svc.from('profiles').select('full_name').eq('id', userId).maybeSingle();
  return (data as { full_name?: string } | null)?.full_name ?? 'Someone';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const { event, comment_id, memory_id, actor_id } = await req.json();
    if (!event) return json({ error: 'event required' }, 400);
    const svc = createServiceClient();

    // ── Comment on a story ──────────────────────────────────────────────────
    if (event === 'memory_comment') {
      if (!comment_id) return json({ error: 'comment_id required' }, 400);
      const { data: c } = await svc
        .from('memory_comments').select('memory_id, author_id').eq('id', comment_id).maybeSingle();
      if (!c) return json({ error: 'comment not found' }, 404);
      const { data: mem } = await svc
        .from('memories').select('author_id, title, place_name').eq('id', c.memory_id).maybeSingle();
      if (!mem?.author_id || mem.author_id === c.author_id) return json({ ok: true, notified: 0 });
      const who   = await actorName(svc, c.author_id);
      const what  = mem.title ? `"${mem.title}"` : mem.place_name ? `your story from ${mem.place_name}` : 'your story';
      await sendUserPush(svc, {
        userId: mem.author_id, module: 'community', categoryId: 'community.comment',
        title: 'New comment 💬', body: `${who} commented on ${what}.`,
        data: { screen: 'memory', memory_id: c.memory_id },
      });
      return json({ ok: true, notified: 1 });
    }

    // ── Reaction on a story ─────────────────────────────────────────────────
    if (event === 'memory_reaction') {
      if (!memory_id || !actor_id) return json({ error: 'memory_id and actor_id required' }, 400);
      const { data: mem } = await svc
        .from('memories').select('author_id, title, place_name').eq('id', memory_id).maybeSingle();
      if (!mem?.author_id || mem.author_id === actor_id) return json({ ok: true, notified: 0 });
      const who  = await actorName(svc, actor_id);
      const what = mem.title ? `"${mem.title}"` : mem.place_name ? `your story from ${mem.place_name}` : 'your story';
      await sendUserPush(svc, {
        userId: mem.author_id, module: 'community', categoryId: 'community.reaction',
        title: 'Someone liked your story', body: `${who} reacted to ${what}.`,
        data: { screen: 'memory', memory_id },
      });
      return json({ ok: true, notified: 1 });
    }

    // ── Comment / reply on a vessel ─────────────────────────────────────────
    if (event === 'vessel_comment') {
      if (!comment_id) return json({ error: 'comment_id required' }, 400);
      const { data: c } = await svc
        .from('vessel_comments')
        .select('vessel_id, author_id, parent_comment_id')
        .eq('id', comment_id).maybeSingle();
      if (!c) return json({ error: 'comment not found' }, 404);
      const { data: vessel } = await svc
        .from('vessels').select('canonical_name').eq('id', c.vessel_id).maybeSingle();
      const vesselName = (vessel as { canonical_name?: string } | null)?.canonical_name ?? 'a vessel';
      const who = await actorName(svc, c.author_id);

      if (c.parent_comment_id) {
        // Reply → notify the parent commenter.
        const { data: parent } = await svc
          .from('vessel_comments').select('author_id').eq('id', c.parent_comment_id).maybeSingle();
        const target = (parent as { author_id?: string } | null)?.author_id;
        if (!target || target === c.author_id) return json({ ok: true, notified: 0 });
        await sendUserPush(svc, {
          userId: target, module: 'community', categoryId: 'community.reply',
          title: 'New reply 💬', body: `${who} replied to your comment on ${vesselName}.`,
          data: { screen: 'boat', vessel_id: c.vessel_id },
        });
        return json({ ok: true, notified: 1 });
      }

      // Top-level → notify everyone else who's commented on this vessel.
      const { data: others } = await svc
        .from('vessel_comments').select('author_id').eq('vessel_id', c.vessel_id);
      const ids = [...new Set((others ?? [])
        .map(o => o.author_id)
        .filter(id => id && id !== c.author_id) as string[])];
      const { sent } = await sendUserPushBulk(svc, ids, {
        module: 'community', categoryId: 'community.boats',
        title: 'New comment on a vessel', body: `${who} commented on ${vesselName}.`,
        data: { screen: 'boat', vessel_id: c.vessel_id },
      });
      return json({ ok: true, notified: sent });
    }

    return json({ error: 'unknown event' }, 400);
  } catch (err) {
    console.error('[notify-engagement]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});
