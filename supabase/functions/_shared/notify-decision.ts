/**
 * notify-decision.ts — the shape every notify-* authorisation check returns.
 *
 * One type and one constructor, shared so each fan-out's auth module (booking,
 * business-claim, engagement, job, shift-status, event-update, hub-content,
 * claim outcome) reads the same way and its index.ts applies the result the
 * same way: `if (!decision.ok) return json({ error: decision.error },
 * decision.status);`.
 */

export type NotifyDecision = { ok: true } | { ok: false; status: number; error: string };

export const denyNotify = (status: number, error: string): NotifyDecision => ({ ok: false, status, error });

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
