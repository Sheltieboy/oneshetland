/**
 * fetch-v2-push-gateway.ts — the production push gateway for the Fetch v2 outbox (Deno only). Tests inject their own.
 *
 * Same Expo Push API, token sources and dead-token pruning as _shared/send-push.ts (push_tokens rows, then the legacy
 * profiles.push_token), but it only pushes: the Fetch outbox has already written the inbox row and checked preferences, so
 * sendUserPush (which checks and logs itself) is not used. send-push.ts is bundled by ~40 deployed functions and is left untouched.
 * Expo's "ok" is a ticket — the provider accepted the message — and is reported as accepted, never as delivered.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { PushAttempt, PushGateway, PushMessage } from './fetch-v2-notify.ts';

const EXPO = 'https://exp.host/--/api/v2/push/send';
const isExpo = (t: unknown): t is string => typeof t === 'string' && t.startsWith('ExponentPushToken[');

export function expoPushGateway(svc: SupabaseClient, fetchImpl: typeof fetch = fetch): PushGateway {
  return {
    tokens: async (userId) => {
      const set = new Set<string>();
      const { data: rows } = await svc.from('push_tokens').select('token').eq('user_id', userId);
      for (const r of rows ?? []) if (isExpo((r as { token?: string }).token)) set.add((r as { token: string }).token);
      const { data: p } = await svc.from('profiles').select('push_token').eq('id', userId).maybeSingle();
      if (isExpo((p as { push_token?: string } | null)?.push_token)) set.add((p as { push_token: string }).push_token);
      return [...set];
    },
    send: async (token: string, m: PushMessage): Promise<PushAttempt> => {
      let res: Response;
      try {
        res = await fetchImpl(EXPO, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: token, title: m.title, body: m.body, data: { ...m.data, categoryId: m.categoryId }, sound: 'default',
            _category: m.categoryId, categoryId: m.categoryId }) });
      } catch { return { ok: false, reason: 'retryable', error: 'network' }; }
      if (res.status === 429 || res.status >= 500) return { ok: false, reason: 'retryable', error: `http_${res.status}` };
      const json = await res.json().catch(() => null);
      const ticket = json?.data;
      if (res.ok && ticket?.status !== 'error') return { ok: true };
      const code = String(ticket?.details?.error ?? json?.errors?.[0]?.code ?? `http_${res.status}`);
      if (code === 'DeviceNotRegistered') return { ok: false, reason: 'device_not_registered', error: code };
      if (code === 'MessageRateExceeded') return { ok: false, reason: 'retryable', error: code };
      if (code === 'InvalidCredentials') return { ok: false, reason: 'unavailable', error: code };
      return { ok: false, reason: 'rejected', error: code.slice(0, 120) };
    },
    prune: async (userId, token) => {
      await svc.from('push_tokens').delete().eq('token', token);
      await svc.from('profiles').update({ push_token: null }).eq('id', userId).eq('push_token', token);
    },
  };
}
