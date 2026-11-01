/**
 * hub-campaign-payout-ui.node.test.ts — the mobile screens tell the truth about a hub that cannot be paid.
 *
 * WHAT WAS WRONG: a hub admin could publish a fundraiser with no payout setup, and donors then met "has not finished
 * setting up payouts" at the very last step, by card and by wallet. The database now refuses the publish (migration
 * 20261201000000); these screens explain it up front, and withdraw the Donate action from a live fundraiser whose hub has
 * since lost payout readiness.
 *
 * ASSERTED (runs the real helper, reads the real screens; no database, no network, no payment)
 *  - copy: the publish-blocked notice and "Donations temporarily unavailable";
 *  - the Donate action is withdrawn only on a DEFINITE "not ready" — an unreadable answer keeps it (the server still refuses);
 *  - Fundraising: new fundraiser and reopen are blocked with the explanation and a path to payouts; closing and editing are not;
 *  - the database refusal is translated, not shown raw;
 *  - public campaign page: no Donate button when not ready; the closed-campaign wording is unchanged;
 *  - donate screen (reached by deep link, covers BOTH card and wallet because both start from this form): replaced by the
 *    unavailable state before any form renders; a completed donation's thank-you is never replaced;
 *  - the display check is the public boolean campaign_payout_ready — no account id, no hubs column read by the client;
 *  - card and wallet payment code paths and their server-side checks are untouched.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const H = await import(join(ROOT, 'lib/campaign-payout-state.ts'));

describe('copy and decisions', () => {
  test('publish-blocked notice explains the requirement and reassures about existing campaigns', () => {
    assert.match(H.CAMPAIGN_PUBLISH_BLOCKED.title, /payouts/i);
    assert.match(H.CAMPAIGN_PUBLISH_BLOCKED.body, /payout account/i);
    assert.match(H.CAMPAIGN_PUBLISH_BLOCKED.body, /existing fundraisers, donations and history are not affected/i);
    assert.equal(H.CAMPAIGN_PUBLISH_BLOCKED.cta, 'Set up payouts');
  });
  test('donor message is exactly "Donations temporarily unavailable" and says nothing was charged', () => {
    assert.equal(H.DONATIONS_UNAVAILABLE.title, 'Donations temporarily unavailable');
    assert.match(H.DONATIONS_UNAVAILABLE.body, /Nothing has been charged/);
  });
  test('Donate is withdrawn only on a definite "not ready"', () => {
    assert.equal(H.donationActionAvailable(true, true), true);
    assert.equal(H.donationActionAvailable(true, false), false);
    assert.equal(H.donationActionAvailable(true, null), true);     // unreadable: server still decides
    assert.equal(H.donationActionAvailable(false, true), false);   // closed / ended stays closed
    assert.equal(H.donationActionAvailable(false, null), false);
  });
  test('the database refusal is translated; other errors pass through', () => {
    assert.equal(H.campaignWriteMessage({ message: 'Finish setting up payouts before publishing a campaign.', hint: 'hub_payout_not_ready' }), 'Finish setting up payouts before publishing a fundraiser.');
    assert.equal(H.campaignWriteMessage({ hint: 'hub_payout_not_ready' }), 'Finish setting up payouts before publishing a fundraiser.');
    assert.equal(H.campaignWriteMessage({ message: 'network down' }), 'network down');
    assert.equal(H.campaignWriteMessage(null), '');
  });
});

describe('Fundraising (hub admin)', () => {
  const src = read('app/hub-campaigns.tsx');
  test('asks hub_payout_ready, shows the banner with a path to payouts', () => {
    assert.match(src, /fetchHubPayoutReady\(id\)/);
    assert.match(src, /!payoutReady \? \(/);
    assert.match(src, /router\.push\(`\/hub-payouts\?id=\$\{id\}`\)/);
  });
  test('a NEW fundraiser is blocked with the explanation before the editor opens', () => {
    const open = src.slice(src.indexOf('const openNew'), src.indexOf('const openEdit'));
    assert.match(open, /if \(!payoutReady\)[\s\S]*CAMPAIGN_PUBLISH_BLOCKED[\s\S]*return;/);
    assert.ok(open.indexOf('if (!payoutReady)') < open.indexOf('setEditorOpen(true)'));
  });
  test('REOPENING is blocked, CLOSING never is', () => {
    const t = src.slice(src.indexOf('const toggleStatus'), src.indexOf('const exportGiftAid'));
    assert.match(t, /next === 'active' && !payoutReady/);
    assert.doesNotMatch(t, /next === 'closed' && !payoutReady/);
  });
  test('editing an existing fundraiser needs no readiness (the edit path never checks it)', () => {
    const save = src.slice(src.indexOf('const save = async'), src.indexOf('const toggleStatus'));
    assert.doesNotMatch(save, /payoutReady/);
  });
  test('database errors are shown translated, not raw', () => {
    assert.equal((src.match(/campaignWriteMessage\(e\)/g) ?? []).length, 2);
  });
});

describe('public campaign page', () => {
  const src = read('app/hub-campaign.tsx');
  test('reads the public boolean and withdraws Donate on a definite no', () => {
    assert.match(src, /fetchCampaignPayoutReady\(c\.id\)/);
    assert.match(src, /donationActionAvailable\(campaignAcceptsDonations\(campaign\), payoutReady\)/);
    assert.match(src, /DONATIONS_UNAVAILABLE\.title/);
  });
  test('the Donate button exists only in the available branch; the closed wording is unchanged', () => {
    const footer = src.slice(src.indexOf('donationActionAvailable('));
    assert.ok(footer.indexOf("router.push(`/hub-donate?campaign=") < footer.indexOf('DONATIONS_UNAVAILABLE.title'));
    assert.match(src, /This fundraiser has closed\. Thank you to everyone who gave\./);
  });
});

describe('donate screen — card and wallet both start here', () => {
  const src = read('app/hub-donate.tsx');
  test('replaced by the unavailable state before any form, card button or wallet option renders', () => {
    const guard = src.indexOf('donated == null && !donationActionAvailable(true, payoutReady)');
    assert.ok(guard > 0, 'guard present');
    assert.ok(guard < src.indexOf('onDonate'), 'before the Donate button');
    assert.ok(guard < src.indexOf('<ConfirmPaymentSheet'), 'before the payment sheet (card and wallet)');
    assert.match(src.slice(guard, guard + 900), /DONATIONS_UNAVAILABLE\.title[\s\S]*DONATIONS_UNAVAILABLE\.body/);
  });
  test('a completed donation keeps its thank-you', () => {
    assert.match(src, /donated == null && !donationActionAvailable/);
  });
  test('card and wallet payment calls are unchanged', () => {
    assert.match(src, /walletCheckout\(\{\s*type: 'hub_donation'/);
    assert.match(src, /startHubDonation\(campaign\.id, effectiveAmount, attemptId\(\)/);
  });
});

describe('what the client may know', () => {
  const api = read('lib/hubs-api.ts');
  test('display uses the public boolean only; no account id or hubs column is read', () => {
    assert.match(api, /rpc\('campaign_payout_ready', \{ p_campaign: campaignId \}\)/);
    const fn = api.slice(api.indexOf('export async function fetchCampaignPayoutReady'), api.indexOf('export async function fetchCampaignPayoutReady') + 400);
    assert.doesNotMatch(fn, /stripe_account_id|payout_enabled/);
  });
  test('unreadable is null, not false', () => {
    assert.match(api, /if \(error \|\| typeof data !== 'boolean'\) return null/);
  });
  test('the server-side donation checks are not edited by this change', () => {
    const card = read('supabase/functions/create-hub-donation-intent/index.ts');
    const wallet = read('supabase/functions/wallet-checkout/index.ts');
    assert.match(card, /has not finished setting up payouts/);
    assert.match(wallet, /!hub\.stripe_account_id \|\| !hub\.payout_enabled/);
  });
});
