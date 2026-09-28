/*
 * Copied from oneshetland-web's lib/event-ticket-utils.ts. The two repos
 * deploy separately, so this is a deliberate duplicate rather than a shared
 * package — same reasoning as lib/business-outcomes.ts.
 *
 * Edit the web copy first, then mirror it here, or the pin in
 * supabase/tests/event-create-per-order-max.node.test.ts (per-order-max
 * helpers) and supabase/tests/event-manage-ticket-capacity.node.test.ts
 * (ticketCapacity) fails.
 */

/** The database default for event_ticket_types.per_order_max. Shown to the
 *  owner rather than applied behind them. */
export const DEFAULT_PER_ORDER_MAX = 10;

/**
 * What to put on the owner's Capacity card.
 *
 * It used to read events.capacity — a venue headcount nobody fills in — so an
 * owner who had just set a ticket quantity of 5 was told "∞" and reasonably
 * concluded it had not saved. The number that governs whether a ticket can be
 * sold is event_ticket_types.quantity_available; reserve_ticket_slots reads
 * that and never looks at events.capacity.
 *
 * Unlimited stays "∞" because it genuinely is. A mixture of finite and
 * unlimited types is also "∞": once one type is uncapped the event has no
 * ceiling, and adding the finite ones up would state a limit that does not
 * exist. Only when EVERY active type is finite is there a total worth showing.
 */
export function ticketCapacity(
  types: { quantity_available: number | null; is_active: boolean }[],
  eventCapacity: number | null,
): { label: string; source: "tickets" | "venue" } {
  const active = types.filter((t) => t.is_active);
  if (active.length === 0) {
    return { label: eventCapacity != null ? String(eventCapacity) : "∞", source: "venue" };
  }
  if (active.some((t) => t.quantity_available == null)) return { label: "∞", source: "tickets" };
  return {
    label: String(active.reduce((n, t) => n + (t.quantity_available ?? 0), 0)),
    source: "tickets",
  };
}

/**
 * What the Maximum per order box holds WHILE it is being edited.
 *
 * "" is a legitimate intermediate state. The first version normalised on every
 * keystroke, so backspacing the last digit ran parseInt("") → NaN → the default
 * → 10, and the field sprang back under the cursor. The only way to get from 10
 * to 2 was to select the whole value and overtype it.
 */
export type PerOrderMaxDraft = number | "";

/** Keystroke → draft. Deliberately does not judge: "" stays "", and a
 *  half-typed or out-of-range number is left alone until the user stops. */
export function parsePerOrderMax(raw: string): PerOrderMaxDraft {
  if (raw.trim() === "") return "";
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : "";
}

/**
 * Draft → the value that may be stored. Applied when the field is left and
 * again when the form is saved, so a blank that is never blurred still cannot
 * reach the database.
 *
 * Blank means "I did not choose", which is the documented default of 10.
 * Anything below 1 is a number the owner did choose and got wrong, so it
 * settles on the minimum rather than the default — snapping -5 to 10 would
 * look like the field inventing a figure.
 */
export function normalisePerOrderMax(v: PerOrderMaxDraft | number | null | undefined): number {
  if (v === "" || v === null || v === undefined) return DEFAULT_PER_ORDER_MAX;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_PER_ORDER_MAX;
  return n < 1 ? 1 : n;
}
