/**
 * commission.ts — pure, shared platform-commission calculator.
 *
 * One function, one job: given the final amount being charged to the customer
 * (in pence) and a fee config { percent_bps, fixed_pence }, return the platform
 * fee in pence.
 *
 * Used by every vendor-sale rail (Fetch, Wallet, future Product sales). All
 * fees are INCLUSIVE — the fee is deducted from the amount being charged, never
 * added on top. The connected account receives (amount − fee).
 *
 * Rounding: Math.floor. Favours the connected account (driver/business) by a
 * sub-pence rounding error so the platform never overcharges them.
 *
 * No clamp. If a misconfig produces fee ≥ amount, Stripe's API will reject the
 * charge with a clear error — the admin sees it immediately and fixes it.
 *
 * Money-losing warn: if the fee is smaller than an *estimated* Stripe processing
 * cost (1.5% + 20p — typical UK card, real cost varies by card type) we set
 * loss_warning and console.warn so a config that costs the platform money is
 * visible. Estimate, not authoritative.
 */

export interface CommissionConfig {
  /** Percentage in basis points. 200 = 2.00%. */
  percent_bps: number;
  /** Fixed amount in pence. 150 = £1.50. */
  fixed_pence: number;
}

export interface CommissionResult {
  /** The platform fee in pence (integer, ≥ 0). */
  fee_pence: number;
  /**
   * Non-null when the computed fee is smaller than an estimated Stripe cost
   * for this amount — i.e. the platform is losing money on this charge.
   */
  loss_warning: string | null;
}

/**
 * Estimated Stripe processing cost for a UK card charge.
 * Used only for the money-losing warning — not for fee computation.
 */
function estimatedStripeCostPence(amount_pence: number): number {
  return Math.ceil(amount_pence * 0.015) + 20;
}

export function calculateCommission(
  amount_pence: number,
  config: CommissionConfig,
  rail_label?: string,
): CommissionResult {
  if (!Number.isFinite(amount_pence) || amount_pence < 0) {
    throw new Error(`calculateCommission: amount_pence must be a non-negative number, got ${amount_pence}`);
  }
  if (!Number.isFinite(config.percent_bps) || config.percent_bps < 0) {
    throw new Error(`calculateCommission: percent_bps must be a non-negative number, got ${config.percent_bps}`);
  }
  if (!Number.isFinite(config.fixed_pence) || config.fixed_pence < 0) {
    throw new Error(`calculateCommission: fixed_pence must be a non-negative number, got ${config.fixed_pence}`);
  }

  // percent_bps / 10_000 = the fraction (e.g. 200 bps → 0.02).
  const percentPart = Math.floor((amount_pence * config.percent_bps) / 10_000);
  const fee_pence = percentPart + Math.floor(config.fixed_pence);

  let loss_warning: string | null = null;
  const estimated = estimatedStripeCostPence(amount_pence);
  if (fee_pence < estimated) {
    loss_warning =
      `[commission${rail_label ? ':' + rail_label : ''}] fee ${fee_pence}p is less than estimated Stripe cost ${estimated}p ` +
      `for charge ${amount_pence}p — this config loses money on this transaction.`;
    console.warn(loss_warning);
  }

  return { fee_pence, loss_warning };
}
