/**
 * engagement-notify-auth.ts — who may make notify-engagement fire.
 *
 * notify-engagement checked only that the caller was signed in. Every id came
 * straight from the request body — including actor_id for a reaction, with no
 * check that the actor was the caller — so any account could:
 *
 *   memory_comment / vessel_comment  →  claim credit for a comment someone
 *                                        else actually wrote, notifying the
 *                                        story author or the parent commenter
 *                                        of a fabricated interaction
 *   memory_reaction                  →  name any user_id as `actor_id` and
 *                                        push "X reacted to your story" for a
 *                                        reaction that user never made
 *
 * The gate ties the caller to the real row: they must be the comment's actual
 * author, or — for a reaction — must actually be the person named, AND that
 * person must actually have a reaction row on that memory.
 */

import { NotifyDecision, denyNotify, isUuid } from './notify-decision.ts';

export type EngagementNotifyEvent = 'memory_comment' | 'memory_reaction' | 'vessel_comment';

export async function authoriseEngagementNotify(
  // deno-lint-ignore no-explicit-any
  svc: any,
  caller: { userId: string; isServiceRole: boolean },
  input: { event: unknown; commentId?: unknown; memoryId?: unknown; actorId?: unknown },
): Promise<NotifyDecision> {
  const { event } = input;
  if (!event) return denyNotify(400, 'event required');
  if (caller.isServiceRole) return { ok: true };

  if (event === 'memory_comment' || event === 'vessel_comment') {
    const { commentId } = input;
    if (!commentId) return denyNotify(400, 'comment_id required');
    if (!isUuid(commentId)) return denyNotify(400, 'comment_id required');
    const table = event === 'memory_comment' ? 'memory_comments' : 'vessel_comments';
    const { data: c } = await svc.from(table).select('author_id').eq('id', commentId).maybeSingle();
    if (!c) return denyNotify(404, 'comment not found');
    if ((c as { author_id?: string } | null)?.author_id !== caller.userId) return denyNotify(403, 'Not allowed');
    return { ok: true };
  }

  if (event === 'memory_reaction') {
    const { memoryId, actorId } = input;
    if (!memoryId || !actorId) return denyNotify(400, 'memory_id and actor_id required');
    if (!isUuid(memoryId) || !isUuid(actorId)) return denyNotify(400, 'memory_id and actor_id required');
    // Naming someone else as the actor is spoofing, full stop — checked before
    // the row lookup so it can never be confused with "no reaction yet".
    if (actorId !== caller.userId) return denyNotify(403, 'Not allowed');
    const { data: reaction } = await svc
      .from('memory_reactions').select('user_id')
      .eq('memory_id', memoryId).eq('user_id', actorId).limit(1);
    if (!Array.isArray(reaction) || reaction.length === 0) return denyNotify(403, 'Not allowed');
    return { ok: true };
  }

  // Unrecognised event — left to the handler's own "unknown event" 400.
  return { ok: true };
}
