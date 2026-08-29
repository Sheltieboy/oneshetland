/**
 * compliance.ts
 *
 * Client-side helper for logging compliance events to compliance_log.
 *
 * Call this immediately when a user agrees to something, verifies their
 * email, acknowledges liability etc. The record is immutable once written.
 *
 * Usage:
 *   import { logCompliance } from '@/lib/compliance';
 *
 *   await logCompliance({
 *     eventType:       'terms.accepted',
 *     documentVersion: '1.0',
 *     description:     'Accepted OneShetland Terms of Service',
 *     metadata:        { screen: 'sign-up' },
 *   });
 */

import { supabase } from './supabase';

export type ComplianceEventType =
  | 'email.verified'
  | 'terms.accepted'
  | 'privacy.accepted'
  | 'fetch.liability_ack'
  | 'driver.terms_accepted'
  | 'marketing.opted_in'
  | 'marketing.opted_out'
  | 'data.export_requested'
  | 'account.deletion_req'
  | 'age.confirmed'
  | 'booking.terms_accepted'
  | 'payment.method_added'
  | 'password.changed'
  | 'email.changed';

/**
 * The "Businesses & selling on OneShetland" section of the Terms.
 *
 * Display only — the database stamps the version onto the acceptance record via
 * a SECURITY DEFINER writer that takes no version argument. This exists so a
 * screen can show the right document, and a test pins it to the database value
 * and to the website's copy so the three cannot drift apart.
 */
export const COMMERCIAL_TERMS_VERSION = '1.0';

export const COMPLIANCE_EVENT_LABELS: Record<ComplianceEventType, string> = {
  'email.verified':        'Email verified',
  'terms.accepted':        'Terms of service accepted',
  'privacy.accepted':      'Privacy policy accepted',
  'fetch.liability_ack':   'Fetch delivery liability acknowledged',
  'driver.terms_accepted': 'Driver terms accepted',
  'marketing.opted_in':    'Marketing emails opted in',
  'marketing.opted_out':   'Marketing emails opted out',
  'data.export_requested': 'Data export requested (GDPR)',
  'account.deletion_req':  'Account deletion requested (GDPR)',
  'age.confirmed':         'Age (16+) confirmed',
  'booking.terms_accepted':'Booking terms accepted',
  'payment.method_added':  'Payment method added',
  'password.changed':      'Password changed',
  'email.changed':         'Email address changed',
};

export interface LogComplianceInput {
  eventType:        ComplianceEventType;
  documentVersion?: string;
  description?:     string;
  metadata?:        Record<string, unknown>;
  emailLogId?:      string;
}

/**
 * Log a compliance event for the currently signed-in user.
 * Silently swallows errors — compliance logging should never block the UX.
 */
export async function logCompliance(input: LogComplianceInput): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return;

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', session.user.id)
      .single();

    await supabase.from('compliance_log').insert({
      user_id:          session.user.id,
      user_email:       session.user.email ?? '',
      user_name:        profile?.full_name ?? null,
      event_type:       input.eventType,
      document_version: input.documentVersion ?? null,
      description:      input.description ?? COMPLIANCE_EVENT_LABELS[input.eventType],
      metadata:         input.metadata ?? {},
      email_log_id:     input.emailLogId ?? null,
    });
  } catch (err) {
    // Non-fatal — log to console for debugging but never surface to user
    console.warn('[compliance] Failed to log event:', input.eventType, err);
  }
}

/**
 * Fetch compliance records for the current user (for "My data" screens).
 */
export interface ComplianceRecord {
  id:               string;
  event_type:       ComplianceEventType;
  document_version: string | null;
  description:      string | null;
  created_at:       string;
  metadata:         Record<string, unknown>;
}

export async function fetchMyComplianceLog(): Promise<ComplianceRecord[]> {
  const { data, error } = await supabase
    .from('compliance_log')
    .select('id, event_type, document_version, description, created_at, metadata')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ComplianceRecord[];
}
