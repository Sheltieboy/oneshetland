/**
 * refund-notice.ts — tell a customer their money has come back, and where it went.
 *
 * Before this, three refund routes returned money and told the customer nothing: an event-ticket
 * refund (card and Wallet), a merchant's Wallet refund, and a Wallet-paid hub membership refund.
 * The state was visible if they went looking (My Tickets shows the order refunded, the Wallet shows
 * the credit), but a refund that nobody announces looks like a refund that didn't happen — and for a
 * card refund the money takes days to show, so the question "did it work?" has no answer anywhere.
 *
 * ONE channel, on purpose: sendUserPush writes a durable Notification Centre row for every
 * attempt (visible even for a user with no push token) and pushes when it can. No email — the
 * refund is a ledger event with a persistent in-app record, and a refund email on top would be
 * the noise this standard avoids. (Card memberships already announce through charge.refunded.)
 *
 * It can never undo or block the refund: it never throws, and a repeat of the same refund —
 * a double-click, a retry after a timeout — is a no-op because each refunded thing has a
 * stable `refundKey` that is stored on the notification.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from './send-push.ts';

export const REFUND_CATEGORY = 'wallet.refunded';

const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;

export interface RefundNoticeInput {
  userId:      string | null | undefined;   // the customer who gets the money
  refundKey:   string;                      // stable per refunded thing, e.g. `event_order:<id>`
  amountPence: number;
  what:        string;                      // "Your tickets for Up Helly Aa"
  destination: 'wallet' | 'card';
  data?:       Record<string, unknown>;     // deep link: { screen } and/or ids
}

export function refundCopy(i: Pick<RefundNoticeInput, 'amountPence' | 'what' | 'destination'>): { title: string; body: string } {
  const amount = gbp(i.amountPence);
  return i.destination === 'wallet'
    ? { title: `${amount} refunded to your Wallet`, body: `${i.what} — the money is back in your OneShetland Wallet now.` }
    : { title: `${amount} refunded to your card`, body: `${i.what}. It can take 5–10 working days to show on your statement.` };
}

export async function notifyRefund(
  svc: SupabaseClient,
  i: RefundNoticeInput,
): Promise<'sent' | 'duplicate' | 'skipped' | 'failed'> {
  try {
    if (!i.userId || !Number.isFinite(i.amountPence) || !(i.amountPence > 0)) return 'skipped';

    // Already announced? A failed attempt (status 'error') is hidden from the inbox, so it does not count.
    const { data: prior } = await svc
      .from('notification_log')
      .select('id')
      .eq('user_id', i.userId)
      .eq('category', REFUND_CATEGORY)
      .eq('data->>refund_key', i.refundKey)
      .neq('status', 'error')
      .limit(1);
    if (prior && prior.length) return 'duplicate';

    const { title, body } = refundCopy(i);
    await sendUserPush(svc, {
      userId: i.userId, module: 'wallet', categoryId: REFUND_CATEGORY,
      title, body, data: { ...(i.data ?? {}), refund_key: i.refundKey },
    });
    return 'sent';
  } catch (e) {
    console.error('[refund-notice] failed:', e instanceof Error ? e.message : 'error');
    return 'failed';
  }
}
