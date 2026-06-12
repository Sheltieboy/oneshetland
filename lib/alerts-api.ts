/**
 * alerts-api.ts — Partner Alert System
 *
 * Businesses with approved + active access can push urgent alerts
 * that appear app-wide in real-time.
 */

import { supabase } from './supabase';

export type AlertType = 'emergency' | 'disruption' | 'info';
export type AlertAccessStatus = 'requested' | 'approved' | 'active' | 'rejected' | 'suspended';

export interface PartnerAlert {
  id:            string;
  business_id:   string;
  business_name: string;
  message:       string;
  type:          AlertType;
  is_active:     boolean;
  starts_at:     string;
  expires_at:    string | null;
  created_at:    string;
}

export interface AlertAccess {
  id:              string;
  business_id:     string;
  status:          AlertAccessStatus;
  requested_at:    string;
  reviewed_at:     string | null;
  reviewer_notes:  string | null;
  activated_at:    string | null;
}

// ── Active alerts (shown in the app) ────────────────────────────────────────

export async function fetchActiveAlerts(): Promise<PartnerAlert[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('partner_alerts')
    .select('*')
    .eq('is_active', true)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// ── Business: alert add-on payment intent ───────────────────────────────────

export interface AlertAddonIntent {
  paymentIntent:  string;
  ephemeralKey:   string;
  customer:       string;
  subscriptionId: string;
}

export async function createAlertAddonIntent(businessId: string): Promise<AlertAddonIntent> {
  const { data, error } = await supabase.functions.invoke('alert-addon-intent', {
    body: { business_id: businessId },
  });
  if (error) {
    let realMessage = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) realMessage = body.error;
      }
    } catch { /* fall through */ }
    throw new Error(realMessage);
  }
  return data as AlertAddonIntent;
}

// ── Business: request access ─────────────────────────────────────────────────

export async function requestAlertAccess(businessId: string): Promise<void> {
  const { error } = await supabase
    .from('business_alert_access')
    .insert({ business_id: businessId, status: 'requested' });
  if (error) throw error;
}

export async function fetchMyAlertAccess(businessId: string): Promise<AlertAccess | null> {
  const { data } = await supabase
    .from('business_alert_access')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle();
  return data ?? null;
}

// ── Business: send / cancel alerts ──────────────────────────────────────────

export async function sendAlert(params: {
  businessId:   string;
  businessName: string;
  message:      string;
  type:         AlertType;
  expiresAt?:   Date | null;
  scheduledFor?: Date | null;  // if set, alert is saved inactive until this time
}): Promise<PartnerAlert> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const isScheduled = !!params.scheduledFor;

  const { data, error } = await supabase
    .from('partner_alerts')
    .insert({
      business_id:   params.businessId,
      business_name: params.businessName,
      message:       params.message,
      type:          params.type,
      is_active:     !isScheduled,         // false until cron activates it
      starts_at:     params.scheduledFor?.toISOString() ?? new Date().toISOString(),
      expires_at:    params.expiresAt?.toISOString() ?? null,
      created_by:    user.id,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function fetchScheduledAlerts(businessId: string): Promise<PartnerAlert[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('partner_alerts')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_active', false)
    .gt('starts_at', now)
    .order('starts_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// All alerts for this business — live, scheduled, and recently ended (last 30 days)
export async function fetchAllBusinessAlerts(businessId: string): Promise<PartnerAlert[]> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('partner_alerts')
    .select('*')
    .eq('business_id', businessId)
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Admin: all alerts across all businesses — live, scheduled, recent
export async function fetchAllAlertsAdmin(): Promise<PartnerAlert[]> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('partner_alerts')
    .select('*')
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function forceExpireAlert(alertId: string): Promise<void> {
  const { error } = await supabase
    .from('partner_alerts')
    .update({ is_active: false, expires_at: new Date().toISOString() })
    .eq('id', alertId);
  if (error) throw error;
}

export async function cancelAlert(alertId: string): Promise<void> {
  const { error } = await supabase
    .from('partner_alerts')
    .update({ is_active: false })
    .eq('id', alertId);
  if (error) throw error;
}

export async function fetchMyBusinessAlerts(businessId: string): Promise<PartnerAlert[]> {
  const { data, error } = await supabase
    .from('partner_alerts')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  return data ?? [];
}

// ── Admin: pending requests ──────────────────────────────────────────────────

export interface AlertAccessWithBusiness extends AlertAccess {
  local_businesses: { name: string; category: string | null } | null;
}

export async function fetchPendingAlertRequests(): Promise<AlertAccessWithBusiness[]> {
  const { data, error } = await supabase
    .from('business_alert_access')
    .select('*, local_businesses(name, category)')
    .eq('status', 'requested')
    .order('requested_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function fetchAllAlertAccess(): Promise<AlertAccessWithBusiness[]> {
  const { data, error } = await supabase
    .from('business_alert_access')
    .select('*, local_businesses(name, category)')
    .order('requested_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function reviewAlertRequest(
  accessId: string,
  decision: 'approved' | 'rejected',
  notes?: string,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { error } = await supabase
    .from('business_alert_access')
    .update({
      status:        decision,
      reviewed_at:   new Date().toISOString(),
      reviewed_by:   user.id,
      reviewer_notes: notes ?? null,
    })
    .eq('id', accessId);
  if (error) throw error;
}

// Mark as active (after payment confirmed — called from Stripe webhook or manually)
export async function activateAlertAccess(
  businessId: string,
  stripeSubscriptionId?: string,
): Promise<void> {
  const { error } = await supabase
    .from('business_alert_access')
    .update({
      status:                 'active',
      activated_at:           new Date().toISOString(),
      stripe_subscription_id: stripeSubscriptionId ?? null,
    })
    .eq('business_id', businessId);
  if (error) throw error;
}
