/**
 * ticket-reserve-error.ts — the sentence a buyer sees when reserve_ticket_basket refuses a basket.
 *
 * Pure: no network, no database. create-event-ticket-intent calls it with the database error message.
 * Every refusal stays HTTP 409 and fails closed (nothing is reserved, charged or created); this only chooses the words.
 *
 * MULTI_PERFORMANCE is raised by reserve_ticket_basket once the Events Phase-1 migrations are applied, for an event with
 * two or more live dates. Before that migration the string never occurs and this behaves exactly as it always has.
 */
export const MULTI_PERFORMANCE_TEXT =
  'This event runs on several dates, so tickets cannot be bought here yet. Please use the organiser\'s ticket link or contact them using the details on the event page.';

export function reserveFailureText(msg: string): string {
  return msg.includes('MULTI_PERFORMANCE') ? MULTI_PERFORMANCE_TEXT
    : msg.includes('SOLD_OUT')             ? 'Some tickets are now sold out. Please refresh and try again.'
    : msg.includes('CHECKOUT_EXPIRED')     ? 'This checkout has expired. Please start again.'
    : msg.includes('IDEMPOTENCY_CONFLICT') ? 'That checkout reference was already used for a different order. Please start again.'
    :                                        'Those tickets are not available. Please refresh and try again.';
}
