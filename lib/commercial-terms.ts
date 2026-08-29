import { supabase } from '@/lib/supabase';
import { COMMERCIAL_TERMS_VERSION } from '@/lib/compliance';

/**
 * commercial-terms.ts — the app's half of the same acceptance, not a second one.
 *
 * Same server truth as the website: the same two RPCs, the same event type, the
 * same version. The app has its own presentation because React Native cannot
 * share the web components, but nothing about the record is decided here.
 *
 * The browser — and the phone — are trusted with one thing: the business id.
 * The user comes from auth.uid() inside the function, the version is held on
 * the server, and the event type is a literal in its body. Direct insertion of
 * the acceptance event is refused by policy, so this is the only route.
 */

export type CommercialTermsStatus =
  | { known: true; accepted: boolean; version: string }
  /** We could not find out. Never treated as accepted. */
  | { known: false };

/** Has the SIGNED-IN user accepted the current commercial terms for this business? */
export async function fetchCommercialTermsStatus(businessId: string): Promise<CommercialTermsStatus> {
  try {
    const { data, error } = await supabase.rpc('my_commercial_terms_status', {
      p_business_id: businessId,
    });
    if (error || !data) return { known: false };
    const row = data as { accepted?: boolean; version?: string };
    if (typeof row.accepted !== 'boolean') return { known: false };
    return { known: true, accepted: row.accepted, version: String(row.version ?? COMMERCIAL_TERMS_VERSION) };
  } catch {
    return { known: false };
  }
}

/** Record acceptance. One argument — everything else is the server's. */
export async function acceptCommercialTerms(businessId: string): Promise<void> {
  const { error } = await supabase.rpc('record_commercial_terms_acceptance', {
    p_business_id: businessId,
  });
  if (error) throw new Error(error.message);
}
