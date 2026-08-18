/**
 * invoice-lines.ts — read an invoice's line items across Stripe API generations.
 *
 * Stripe's 2025-03-31.basil release restructured invoice lines: the top-level
 * `proration` boolean moved under `parent.subscription_item_details`. It is the
 * same release that removed /v1/invoices/upcoming, so any account that 404s the
 * old endpoint is guaranteed to be on the NEW line shape. Reading `l.proration`
 * there returns undefined for every line, every proration silently classifies as
 * a recurring charge, and anything that itemises a bill shows one flat number.
 *
 * Both callers below quote money to a business, so this lives in _shared rather
 * than being written out twice — the two copies drifting is exactly how the flat
 * number survived as long as it did.
 */

// deno-lint-ignore no-explicit-any
export function isProration(line: any): boolean {
  // Checked against docs.stripe.com/api/invoice-line-item/object: the current
  // object has NO top-level `proration` — it sits under `parent`, and under one
  // of TWO parent types. A subscription plan change bills its catch-up as
  // proration INVOICE ITEMS, so invoice_item_details is the path that carries
  // the money here; subscription_item_details covers lines the subscription
  // itself generates. The top-level read is kept for pre-basil accounts.
  const parent = line?.parent;
  return line?.proration === true
      || parent?.invoice_item_details?.proration === true
      || parent?.subscription_item_details?.proration === true;
}

/**
 * Split an invoice into the recurring plan charge and the proration adjustments.
 * `adjustPence` is signed: positive is catch-up owed, negative is credit back.
 */
// deno-lint-ignore no-explicit-any
export function splitInvoice(invoice: any): { basePence: number; adjustPence: number; classified: boolean } {
  // deno-lint-ignore no-explicit-any
  const lines: any[] = invoice?.lines?.data ?? [];
  const prorations = lines.filter(isProration);
  const sum = (ls: any[]) => ls.reduce((t: number, l: any) => t + (l.amount ?? 0), 0);
  return {
    basePence:  sum(lines.filter(l => !isProration(l))),
    adjustPence: sum(prorations),
    // False when nothing was recognised as a proration. Callers should fall back
    // to a single total rather than print a breakdown that doesn't add up.
    classified: prorations.length > 0,
  };
}
