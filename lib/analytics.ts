/**
 * lib/analytics.ts — first-party product analytics (mobile app)
 *
 * Thin, batched, consent-aware client. Events are queued and flushed to the
 * `log_events` RPC (which stamps is_conversion/category from the registry and
 * scrubs PII). NEVER put money amounts or PII in props — revenue lives in the
 * ledgers; transaction events are fired server-side from the edge functions.
 *
 * Consent model (app): default ON, with an opt-out toggle in Settings. Flip
 * DEFAULT_CONSENT to false for strict opt-in. See web lib for the opt-in banner.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform, AppState } from 'react-native';
import { supabase } from './supabase';

type UserType = 'visitor' | 'user' | 'seller' | 'admin' | 'driver';

interface TrackContext {
  props?:       Record<string, unknown>;
  objectType?:  string;
  objectId?:    string;
  businessId?:  string | null;
  hubId?:       string | null;
  orderId?:     string | null;
  occurredAt?:  string;            // ISO; defaults to now
}

interface QueuedEvent {
  event_name:  string;
  occurred_at: string;
  anon_id:     string;
  session_id:  string;
  platform:    'app';
  user_type:   UserType;
  app_version?: string;
  object_type?: string;
  object_id?:   string;
  business_id?: string | null;
  hub_id?:      string | null;
  order_id?:    string | null;
  props:        Record<string, unknown>;
  consent:      boolean;
}

const ANON_KEY    = 'os_analytics_anon_id';
const CONSENT_KEY = 'os_analytics_consent';
const DEFAULT_CONSENT = true;            // app: opt-out model
const FLUSH_MS    = 5000;
const MAX_BATCH   = 25;

const APP_VERSION = (Constants.expoConfig?.version ?? undefined) as string | undefined;

let anonId:    string | null = null;
let sessionId: string = uuid();
let userType:  UserType = 'visitor';
let consent:   boolean = DEFAULT_CONSENT;
let queue:     QueuedEvent[] = [];
let timer:     ReturnType<typeof setTimeout> | null = null;
let ready = false;

// RFC4122-ish v4 (analytics anon id only — not security-sensitive). expo-crypto
// isn't installed, so we use Math.random here, which is fine for this purpose.
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Load persisted anon id + consent. Safe to call multiple times. */
export async function initAnalytics(): Promise<void> {
  if (ready) return;
  try {
    anonId = await AsyncStorage.getItem(ANON_KEY);
    if (!anonId) { anonId = uuid(); await AsyncStorage.setItem(ANON_KEY, anonId); }
    const c = await AsyncStorage.getItem(CONSENT_KEY);
    consent = c === null ? DEFAULT_CONSENT : c === 'true';
  } catch { anonId = anonId ?? uuid(); }
  ready = true;
}

/** Tell analytics who the current user is (call on auth state change). */
export function identifyAnalytics(type: UserType): void { userType = type; }

export async function setAnalyticsConsent(on: boolean): Promise<void> {
  consent = on;
  try { await AsyncStorage.setItem(CONSENT_KEY, String(on)); } catch { /* ignore */ }
  if (!on) queue = [];                    // drop anything pending
}
export function getAnalyticsConsent(): boolean { return consent; }

/** Queue an event. Cheap + non-blocking; never throws. */
export function track(eventName: string, ctx: TrackContext = {}): void {
  try {
    if (!consent) return;
    if (!ready) { void initAnalytics(); }
    queue.push({
      event_name:  eventName,
      occurred_at: ctx.occurredAt ?? new Date().toISOString(),
      anon_id:     anonId ?? 'pending',
      session_id:  sessionId,
      platform:    'app',
      user_type:   userType,
      app_version: APP_VERSION,
      object_type: ctx.objectType,
      object_id:   ctx.objectId,
      business_id: ctx.businessId ?? undefined,
      hub_id:      ctx.hubId ?? undefined,
      order_id:    ctx.orderId ?? undefined,
      props:       ctx.props ?? {},
      consent,
    });
    if (queue.length >= MAX_BATCH) { void flushAnalytics(); }
    else if (!timer) { timer = setTimeout(() => { void flushAnalytics(); }, FLUSH_MS); }
  } catch { /* analytics must never break the app */ }
}

/** Send any queued events. Called on a timer, on batch-full, and on backgrounding. */
export async function flushAnalytics(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!consent || queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH).map(e => ({
    ...e,
    anon_id: e.anon_id === 'pending' ? (anonId ?? 'unknown') : e.anon_id,
  }));
  try {
    const { error } = await supabase.rpc('log_events', { p_events: batch });
    if (error) queue.unshift(...batch);   // requeue on failure
  } catch {
    queue.unshift(...batch);
  }
}

// Best-effort flush when the app goes to background.
AppState.addEventListener('change', s => { if (s !== 'active') void flushAnalytics(); });

export const __analyticsDebug = { get queueLength() { return queue.length; }, get platform() { return Platform.OS; } };
