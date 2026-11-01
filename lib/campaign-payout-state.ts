/**
 * campaign-payout-state.ts — what a fundraiser says when its hub cannot be paid.
 *
 * Two moments, one rule (hub_payout_ready(), enforced by a database trigger when a campaign is published
 * or reopened, and by the card and wallet donation routes when money moves):
 *   · the hub admin creating or reopening a fundraiser — told to finish payout setup first;
 *   · a donor opening a fundraiser that is live but whose hub has since lost payout readiness — told
 *     donations are temporarily unavailable, and given no Donate action.
 *
 * Display only. Nothing here decides whether money can move; the server does that. The copy lives here
 * so a test can run it.
 */
export type CampaignPayoutNotice = { title: string; body: string; cta?: string };

/** Hub-admin side: shown on the Fundraising screen while the hub is not payout-ready. */
export const CAMPAIGN_PUBLISH_BLOCKED: CampaignPayoutNotice = {
  title: 'Set up payouts to publish a fundraiser',
  body: 'Donations are paid straight to your Hub’s connected payout account, so a fundraiser can only go live once that is set up. Your existing fundraisers, donations and history are not affected.',
  cta: 'Set up payouts',
};

/** Donor side: a live campaign whose hub is not payout-ready right now. */
export const DONATIONS_UNAVAILABLE: CampaignPayoutNotice = {
  title: 'Donations temporarily unavailable',
  body: 'This fundraiser can’t accept donations at the moment. Nothing has been charged. Please check back soon.',
};

/**
 * Whether the Donate action is offered. `payoutReady` is null when the answer could not be read — that
 * keeps the button (the server still refuses an unpayable donation, and a flaky connection must not hide a
 * working campaign); only a definite `false` withdraws it.
 */
export function donationActionAvailable(campaignOpen: boolean, payoutReady: boolean | null): boolean {
  return campaignOpen && payoutReady !== false;
}

/** Turns the database refusal (and the donation routes' own wording) into one sentence for the admin. */
export function campaignWriteMessage(e: unknown): string {
  const err = e as { message?: string; hint?: string; details?: string } | null | undefined;
  const text = `${err?.message ?? ''} ${err?.hint ?? ''}`;
  if (/hub_payout_not_ready|Finish setting up payouts before publishing/i.test(text)) {
    return 'Finish setting up payouts before publishing a fundraiser.';
  }
  return err?.message ?? '';
}
