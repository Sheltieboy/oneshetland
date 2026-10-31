/**
 * notice-broadcast.ts — may this notice go island-wide RIGHT NOW?
 *
 * notify-community-notice reads notices with the service role, so row-level security does not protect it. Until Notices Stage 2 added
 * `status` and `starts_at`, "public, not hidden, unexpired" was the whole definition of a live notice. It no longer is: a pending, withdrawn or
 * resolved notice, or one scheduled for later, must never push every device on the island.
 *
 * This mirrors the database's own visibility rule (the "notices read" policy, migration 20261128010000) for the cases that matter to a broadcast:
 *   status = 'published'   AND  NOT is_hidden   AND  (starts_at IS NULL OR starts_at <= now())   AND  (expires_at IS NULL OR expires_at > now())
 *   AND visibility = 'public'   (a broadcast is never members-only or committee-only)   AND  severity = 'urgent'
 * PRODUCT RULE: an official IMPORTED notice never goes island-wide, whatever its state (Notices Stage 2: imports stay silent). An import is
 * identified by `source IS NOT NULL` - the column the Stage 2 constraints make authoritative (source set => platform notice with a label, a
 * reference and an expiry; every other source_* column requires it). A row that does not report `source` at all is refused, never assumed native.
 * Boundaries are the database's: a notice is live AT its start instant and no longer live AT its expiry instant.
 *
 * Timestamps are compared as absolute instants (Date.parse), never as local wall-clock text, so a value written with any UTC offset is read
 * correctly. A timestamp that cannot be read is treated as "not eligible": this gate fails closed.
 *
 * Pure: no imports, no I/O, so the same file runs under the edge runtime and under `node --test`.
 */

export type BroadcastCandidate = {
  source?: unknown; severity?: unknown; visibility?: unknown; is_hidden?: unknown; status?: unknown;
  starts_at?: unknown; expires_at?: unknown; broadcast_at?: unknown;
};
export type BroadcastRefusal = { error: string; status: number };

const instant = (v: unknown): number | null | 'invalid' => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : 'invalid';
};

/** null = eligible. Otherwise the refusal to return. The first four messages are the function's original ones, unchanged. */
export function broadcastRefusal(n: BroadcastCandidate, nowMs: number): BroadcastRefusal | null {
  if (n.broadcast_at) return { error: 'Already sent to everyone', status: 409 };
  if (n.source !== null) return { error: 'Official source notices are not sent as alerts', status: 400 };
  if (n.severity !== 'urgent') return { error: 'Only urgent notices go island-wide', status: 400 };
  if (n.visibility !== 'public' || n.is_hidden !== false) return { error: 'That notice is not public', status: 400 };
  const exp = instant(n.expires_at);
  if (exp === 'invalid' || (exp !== null && exp <= nowMs)) return { error: 'That notice has expired', status: 400 };
  // Lifecycle (Notices Stage 2): only a published notice that has started may reach the island.
  if (n.status !== 'published') return { error: 'That notice is not published', status: 400 };
  const start = instant(n.starts_at);
  if (start === 'invalid' || (start !== null && start > nowMs)) return { error: 'That notice has not started yet', status: 400 };
  return null;
}
