/**
 * ticket-celebration.ts — when a holder's ticket earns its "You're in!" moment.
 *
 * WHY THIS EXISTS
 *
 * The celebration used to fire only from a Realtime UPDATE that happened to land
 * while the ticket screen was mounted and the socket alive. A phone that was
 * locked, backgrounded, or showing the QR full-screen at scan time missed the
 * push; the screen then simply loaded the row, saw `used`, and had no memory of
 * ever seeing it `valid` — so it settled straight into "Used" with no reward.
 *
 * THE RULE (server rows only, never a scan or a guess)
 *
 *   celebrate ⇔ the ticket is `used`
 *             ∧ this device SAW it `valid` first          (a real transition)
 *             ∧ it has not been celebrated before          (once, ever)
 *             ∧ it was checked in recently                  (a moment, not a memory)
 *
 * So: first successful scan, however the row reaches us (push, foreground
 * re-read, poll), celebrates exactly once. A used ticket first met on a fresh
 * load never celebrates; nor does reopening it later; nor do cancelled, refunded
 * or pending tickets, which are never `used`.
 *
 * Pure: storage is injected, so the whole decision is testable without a phone.
 */

/** How long after check-in a first sighting can still count as "just now". */
export const CELEBRATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How long the celebration stays on screen. Brief, and it never blocks touches. */
export const CELEBRATION_MS = 1800;

export interface TicketRow {
  id: string;
  status?: string | null;
  checked_in_at?: string | null;
}

export interface CelebrationStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function shouldCelebrate(input: {
  status: string | null | undefined;
  checkedInAt: string | null | undefined;
  seenValid: boolean;
  celebrated: boolean;
  now: number;
}): boolean {
  if (input.status !== 'used') return false;
  if (!input.seenValid || input.celebrated) return false;
  const at = input.checkedInAt ? Date.parse(input.checkedInAt) : NaN;
  if (!Number.isFinite(at)) return false;
  const age = input.now - at;
  return age >= -60_000 && age <= CELEBRATION_MAX_AGE_MS; // a minute of clock skew either way
}

const SEEN = (id: string) => `os.ticket.seenValid.${id}`;
const DONE = (id: string) => `os.ticket.celebrated.${id}`;

export function createTicketCelebrations(store: CelebrationStore, clock: () => number = Date.now) {
  // In-memory mirrors: they make the decision synchronous-first, so two screens
  // (the list under the detail) reading the same row cannot both celebrate it,
  // and they keep working if storage is unavailable.
  const seen = new Set<string>();
  const claimed = new Set<string>();

  const read = async (key: string) => { try { return (await store.get(key)) === '1'; } catch { return false; } };
  const write = async (key: string) => { try { await store.set(key, '1'); } catch { /* memory still holds it */ } };

  /** The device saw this ticket live and unscanned — the "before" of a transition. */
  async function markSeenValid(id: string): Promise<void> {
    if (seen.has(id)) return;
    seen.add(id);
    await write(SEEN(id));
  }

  /**
   * Feed every ticket row a screen reads. Resolves true at most once per ticket,
   * ever: the moment it is worth celebrating.
   */
  async function observe(t: TicketRow): Promise<boolean> {
    if (t.status === 'valid') { await markSeenValid(t.id); return false; }
    if (t.status !== 'used') return false;
    if (claimed.has(t.id)) return false;
    claimed.add(t.id); // claim before any await: one winner across screens

    const seenValid = seen.has(t.id) || (await read(SEEN(t.id)));
    const celebrated = await read(DONE(t.id));
    const go = shouldCelebrate({
      status: t.status, checkedInAt: t.checked_in_at, seenValid, celebrated, now: clock(),
    });
    if (go) await write(DONE(t.id));
    return go;
  }

  return { observe, markSeenValid };
}
