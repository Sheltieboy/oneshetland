// _shared/analytics.ts — server-side analytics for edge functions.
//
// Fires TRUSTED conversion events (the source-of-truth confirmations) into the
// analytics_events stream. The DB trigger stamps is_conversion + category from
// the registry, so we only pass the event name, identity and id pointers.
//
// Rules:
//   - NEVER put money amounts or PII in props — order_id points at the ledger.
//   - NEVER let analytics block or fail a payment: always fire-and-forget.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface ServerEvent {
  event_name:   string;
  user_id?:     string | null;
  business_id?: string | null;
  hub_id?:      string | null;
  order_id?:    string | null;   // pointer to the ledger row (no money here)
  object_type?: string;
  object_id?:   string | null;
  user_type?:   string;
  props?:       Record<string, unknown>;
}

/** Fire-and-forget conversion event. Swallows all errors. */
export async function logServerEvent(
  supabase: SupabaseClient,
  e: ServerEvent,
): Promise<void> {
  try {
    await supabase.from('analytics_events').insert({
      event_name:  e.event_name,
      user_id:     e.user_id     ?? null,
      business_id: e.business_id ?? null,
      hub_id:      e.hub_id      ?? null,
      order_id:    e.order_id    ?? null,
      object_type: e.object_type ?? null,
      object_id:   e.object_id   ?? null,
      platform:    'app',
      user_type:   e.user_type   ?? 'user',
      props:       e.props       ?? {},
      // is_conversion + category are set by the analytics_stamp DB trigger
    });
  } catch (_err) {
    // analytics must never break a transaction
  }
}
