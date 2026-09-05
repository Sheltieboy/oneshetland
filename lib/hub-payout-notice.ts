/**
 * hub-payout-notice.ts — what the hub admin is told about payouts.
 *
 * The mobile tiers screen only mentioned payouts once a PAID tier already
 * existed (`hasPaid && !hub.payout_enabled`), so a brand-new hub could design
 * and save a paid tier before anything said it could not be sold. Hub Manage
 * had no Payouts row at all, so there was nowhere to go and learn otherwise.
 *
 * The copy lives here so a test can run it rather than read it.
 *
 * `ready` comes from hub_payout_ready() (migration 20260928120000) — a
 * SECURITY DEFINER boolean. It is NOT hubs.payout_enabled: that flag alone can
 * be true without a connected account, and the account id itself is granted to
 * no client role. The mobile app must never hold it.
 *
 * Deliberately not byte-identical to the web wording: the web screen sits
 * beside a payouts route of its own, while this one is the only place a mobile
 * admin meets the requirement.
 */
export type HubPayoutNotice = {
  title: string;
  body: string;
  cta: string;
};

export function hubPayoutNotice(ready: boolean): HubPayoutNotice {
  return ready
    ? {
        title: 'Payouts ready ✓',
        body: 'Membership payments will be paid to this Hub’s connected payout account.',
        cta: 'Manage payouts',
      }
    : {
        title: 'Set up payouts to offer paid memberships',
        body: 'Free tiers work straight away. Paid tiers need a connected payout account.',
        cta: 'Set up payouts',
      };
}

/**
 * Whether the tiers screen shows the notice at all.
 *
 * Always, until payouts are ready — including with zero tiers, which is exactly
 * the case the old `hasPaid` gate missed. Once ready it still shows, compactly,
 * so an admin can confirm the money has somewhere to go.
 */
export function showsPayoutNotice(): boolean {
  return true;
}
