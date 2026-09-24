/**
 * card-label.ts — how a saved card is named on screen.
 *
 * Brand and last four digits only. Mirrors oneshetland-web/lib/card-label.ts.
 */

const BRAND_NAMES: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'EFTPOS',
};

/** "Visa ending •••• 4242" — or just "Card" when the details are not to hand. */
export function formatCardLabel(brand: string | null | undefined, last4: string | null | undefined): string {
  const name = (brand && BRAND_NAMES[brand]) || 'Card';
  return last4 && /^\d{4}$/.test(last4) ? `${name} ending •••• ${last4}` : name;
}
