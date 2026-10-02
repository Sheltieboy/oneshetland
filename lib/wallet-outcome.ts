/**
 * wallet-outcome.ts — what to tell the customer when a Wallet payment does not go through.
 *
 * Pure: no React Native, no Supabase, so the exact words and decisions are testable.
 *
 * WHY A NOTICE AND NOT AN ALERT
 * Every Wallet checkout starts from <ConfirmPaymentSheet>, which is an RN <Modal>, and
 * the root alert (useAlert) is another <Modal>. iOS cannot present a second modal over
 * an open one, or while the first is still dismissing. The Wallet runners opened the
 * alert while the sheet was open and then closed the sheet in `finally`, so the alert
 * was being presented at the very moment its neighbour was dismissed: the alert's React
 * state said "visible", nothing was on screen, and the app stopped taking touches. The
 * success paths already avoided it by showing the result inline; the failure paths did
 * not. Failures are now shown INSIDE the sheet (see ConfirmPaymentSheet `notice`), so
 * there is only ever one modal.
 */

/** The server declined a Wallet payment BEFORE debiting it (the liquidity gate). */
export class WalletUnavailableError extends Error {
  readonly reason = 'liquidity_unavailable' as const;
  /** True when nothing was taken. False for a resumed attempt whose money had already moved. */
  readonly noCharge: boolean;
  constructor(message: string, noCharge: boolean) {
    super(message);
    this.name = 'WalletUnavailableError';
    this.noCharge = noCharge;
  }
}

export interface PaymentNotice {
  /** 'calm' for an operational pause (nothing is wrong with the customer or the payment); 'error' otherwise. */
  tone: 'calm' | 'error';
  title: string;
  message: string;
}

export const WALLET_UNAVAILABLE_NOTICE: PaymentNotice = {
  tone: 'calm',
  title: 'Wallet temporarily unavailable',
  message: 'No money has been taken. Please use another payment method.',
};

/**
 * The notice for a failed Wallet payment. An unavailable Wallet is calm and says no
 * money was taken (only when that is true); anything else keeps the screen's own
 * failure title and the server's message.
 */
export function walletFailureNotice(e: unknown, failedTitle: string): PaymentNotice {
  if (e instanceof WalletUnavailableError) {
    return e.noCharge
      ? WALLET_UNAVAILABLE_NOTICE
      : { tone: 'calm', title: 'Payment still being completed', message: e.message };
  }
  return { tone: 'error', title: failedTitle, message: (e as { message?: string } | null)?.message || 'Please try again.' };
}
