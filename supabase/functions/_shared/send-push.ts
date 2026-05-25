/**
 * send-push.ts — shared helper for Expo Push Notifications
 *
 * Uses the free Expo Push API (https://exp.host/api/v2/push/send).
 * No APNs/FCM credentials needed — Expo handles that for you.
 */

export async function sendPush(
  token: string | null | undefined,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  if (!token?.startsWith('ExponentPushToken[')) return;

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        title,
        body,
        sound: 'default',
        data: data ?? {},
      }),
    });
    const json = await res.json();
    if (!res.ok || json?.data?.status === 'error') {
      console.error('[send-push] Expo API error:', JSON.stringify(json));
    } else {
      console.log('[send-push] sent to', token, '→', json?.data?.status ?? 'ok');
    }
  } catch (err) {
    console.error('[send-push] fetch failed:', err);
  }
}
