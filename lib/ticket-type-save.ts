/**
 * ticket-type-save.ts — which existing event ticket types stop selling on Save.
 *
 * WHY THIS EXISTS
 *
 * event-create.tsx's "Remove" button on a ticket type only ever touched local
 * React state. Save then upserted whatever remained in that state, but nothing
 * ever called the existing deleteTicketType() (lib/events-api.ts) for the id
 * that got dropped — so a business that removed a ticket tier and saved would
 * see it gone from the editor, while the ticket type row was untouched in the
 * database and customers could still buy it at create-event-ticket-intent.
 *
 * deleteTicketType() is a SOFT delete — `update({ is_active: false })`, not a
 * row delete — which is what makes this safe to call even when the type has
 * existing sales: event_tickets.ticket_type_id has no ON DELETE CASCADE (in
 * fact no cascade at all — ON DELETE defaults to RESTRICT), so a hard delete
 * would fail once a single ticket existed for the type. Flipping is_active is
 * exactly what create-event-ticket-intent already gates future purchases on
 * (`.eq('is_active', true)`), so this is the correct, minimal, non-destructive
 * fix: no schema change, no migration, existing tickets/orders untouched.
 *
 * This module is deliberately pure and import-free (no supabase client, no RN
 * modules) so it can be unit-tested directly under Node's native TypeScript
 * type-stripping (`node --test`), the same way commission.ts is — importing
 * events-api.ts itself for a test would pull in expo-file-system and fail
 * outside the app runtime.
 */

/** The minimal shape event-create.tsx's ticketTypes state needs to expose. */
export interface TicketTypeSaveRef {
  /** Present once the row has been persisted; absent for a freshly-added row. */
  id?: string;
  /** True for a ticket type added in this editing session, never yet saved. */
  _local?: boolean;
}

export type TicketMode = 'none' | 'oneshetland' | 'external';

/**
 * Existing (server-known) ticket-type ids that must be taken off sale on this
 * Save, because they were loaded with the event but are no longer present in
 * the current form state — either the owner removed them individually, or
 * switched the event away from OneShetland ticketing entirely (which is the
 * same defect in a wider form: every previously-sold type must stop selling,
 * not just silently stop being upserted).
 *
 * `originalIds` should be the ticket-type ids the event was loaded with
 * (populate once, from the initial fetch — not re-derived from ticketTypes,
 * or a removal would immediately erase its own evidence).
 */
export function ticketTypesToDeactivate(
  originalIds: readonly string[],
  currentTypes: readonly TicketTypeSaveRef[],
  ticketMode: TicketMode,
): string[] {
  if (originalIds.length === 0) return [];

  // Switching away from OneShetland ticketing drops every ticket type from
  // the save payload (event-create.tsx clears the local list before upsert),
  // so every originally-loaded type must be deactivated — none can "survive".
  if (ticketMode !== 'oneshetland') return [...originalIds];

  const kept = new Set(
    currentTypes
      .filter(t => !t._local && typeof t.id === 'string' && t.id.length > 0)
      .map(t => t.id as string),
  );
  return originalIds.filter(id => !kept.has(id));
}
