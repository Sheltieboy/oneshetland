/**
 * wallet-sheet-failure.node.test.ts
 *
 * THE FREEZE (2 Oct 2026, first physical test of a Wallet donation while Wallet liquidity
 * was Critical). The server did exactly the right thing — the liquidity gate refused the
 * £1.00 donation before any debit, released the attempt, and answered 503. The app then
 * stopped responding.
 *
 * Every Wallet checkout starts from <ConfirmPaymentSheet>, an RN <Modal>. The Wallet
 * runners kept that sheet open while the request ran, then — on any failure — opened the
 * root alert (useAlert, a SECOND <Modal>) and, in `finally`, closed the sheet. iOS cannot
 * present a modal over another or while another is dismissing, so the alert was being
 * presented at the same instant its neighbour was dismissed: its React state said
 * "visible", nothing was on screen, and touches stopped. (Success already avoided this by
 * showing its result inline; the failure path did not. Event tickets and gifts had the
 * identical pattern, and their routes return the same 503.)
 *
 * The fix: a failed Wallet payment is shown INSIDE the sheet (`notice`) and the sheet
 * stays open — one modal, never two.
 *
 * This runs the REAL runner functions, extracted from the real screens, against recorders
 * (no React Native, no network, no money), for donation, membership and pass, and pins
 * the pattern out of all five screens that use the sheet.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFunction, instantiate } from './_support/load-source.ts';
import {
  WalletUnavailableError, walletFailureNotice, WALLET_UNAVAILABLE_NOTICE,
} from '../../lib/wallet-outcome.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── the words ─────────────────────────────────────────────────────────────── */

describe('the notice a failed Wallet payment produces', () => {
  test('a refusal by the liquidity gate is calm, says no money was taken, and is not a "failed payment"', () => {
    const n = walletFailureNotice(new WalletUnavailableError('whatever the server said', true), 'Donation failed');
    assert.deepEqual(n, WALLET_UNAVAILABLE_NOTICE);
    assert.deepEqual([n.tone, n.title, n.message], ['calm', 'Wallet temporarily unavailable', 'No money has been taken. Please use another payment method.']);
    assert.doesNotMatch(n.title, /fail/i);
  });

  test('a RESUMED attempt (money already moved) is calm too but never claims nothing was taken', () => {
    const n = walletFailureNotice(new WalletUnavailableError('Your wallet payment is still being completed. Nothing more has been taken — please try again shortly.', false), 'Payment failed');
    assert.equal(n.tone, 'calm');
    assert.equal(n.title, 'Payment still being completed');
    assert.doesNotMatch(n.message, /No money has been taken/);
  });

  test('every other error keeps its screen\'s own title and the server\'s message', () => {
    assert.deepEqual(walletFailureNotice(new Error('Insufficient balance — top up first'), 'Donation failed'),
      { tone: 'error', title: 'Donation failed', message: 'Insufficient balance — top up first' });
    assert.deepEqual(walletFailureNotice(new Error(''), 'Purchase failed'), { tone: 'error', title: 'Purchase failed', message: 'Please try again.' });
    assert.deepEqual(walletFailureNotice(null, 'Payment failed'), { tone: 'error', title: 'Payment failed', message: 'Please try again.' });
  });
});

/* ── the real runners, executed ─────────────────────────────────────────────── */

type Calls = { name: string; args: unknown[] }[];
const recorder = (calls: Calls) => (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };

/** The body of `const <name> = ... async (...) => { ... }` (with or without a useCallback wrapper). */
function runnerSource(file: string, name: string, arrowHeader = 'async () =>'): string {
  const src = read(file);
  const at = src.indexOf(`const ${name} =`);
  assert.notEqual(at, -1, `${file}: ${name} is gone`);
  return extractFunction(src.slice(at), arrowHeader);
}

interface Harness {
  calls: Calls;
  run: (...a: unknown[]) => Promise<void>;
  inFlight: { current: boolean };
  walletCalls: () => number;
}

/** What each screen's runner closes over. Everything is a recorder: nothing real can happen. */
function harness(opts: {
  file: string; name: string; header?: string;
  wallet: () => Promise<unknown>;
  extra?: Record<string, unknown>;
}): Harness {
  const calls: Calls = [];
  const rec = recorder(calls);
  let walletCalls = 0;
  const inFlight = { current: false };
  const scope: Record<string, unknown> = {
    walletInFlight: inFlight,
    walletCheckout: async () => { walletCalls++; return opts.wallet(); },
    walletFailureNotice,
    attemptId: () => 'attempt-1',
    Haptics: { notificationAsync: () => {}, NotificationFeedbackType: { Success: 'success' } },
    // state setters — every one recorded
    setPaying: rec('setPaying'), setActing: rec('setActing'), setSubmitting: rec('setSubmitting'),
    setPayNotice: rec('setPayNotice'), setConfirming: rec('setConfirming'), setPayingType: rec('setPayingType'),
    setWalletBalance: rec('setWalletBalance'), setDonated: rec('setDonated'), setDone: rec('setDone'),
    setJoinSuccess: rec('setJoinSuccess'),
    load: rec('load'),
    // things that must NEVER be touched by a Wallet failure
    alert: rec('alert'),
    router: { push: rec('router.push'), back: rec('router.back'), replace: rec('router.replace') },
    ...opts.extra,
  };
  const run = instantiate<(...a: unknown[]) => Promise<void>>(runnerSource(opts.file, opts.name, opts.header), scope);
  return { calls, run, inFlight, walletCalls: () => walletCalls };
}

const names = (c: Calls) => c.map((x) => x.name);
const last = (c: Calls, name: string) => [...c].reverse().find((x) => x.name === name)?.args[0];

const RAILS = [
  {
    key: 'donation', file: 'app/hub-donate.tsx', name: 'runDonationWallet', header: 'async () =>', failedTitle: 'Donation failed',
    busy: 'setPaying', args: [] as unknown[],
    extra: {
      campaign: { id: 'camp-1' }, profile: { id: 'u-1' }, effectiveAmount: 100, message: '', anonymous: false,
      buildGiftAid: () => null,
    },
    success: (c: Calls) => { assert.deepEqual(last(c, 'setDonated'), 100); assert.deepEqual(last(c, 'setConfirming'), false); },
  },
  {
    key: 'membership', file: 'app/hubs/[id].tsx', name: 'runMembershipWallet', header: 'async (type: HubMembershipType) =>', failedTitle: 'Payment failed',
    busy: 'setActing', args: [{ id: 'tier-1' }] as unknown[],
    extra: { hub: { id: 'hub-1', name: 'ZZ TEST Hub' }, profile: { id: 'u-1' } },
    success: (c: Calls) => {
      assert.deepEqual(last(c, 'setPayingType'), null);
      assert.match(String((last(c, 'setJoinSuccess') as { message: string }).message), /now a member of ZZ TEST Hub/);
    },
  },
  {
    key: 'pass', file: 'app/local-buy-unit.tsx', name: 'runBuyWallet', header: 'async () =>', failedTitle: 'Purchase failed',
    busy: 'setSubmitting', args: [] as unknown[],
    extra: { profile: { id: 'u-1' }, item: { id: 'item-1' } },
    success: (c: Calls) => { assert.deepEqual(last(c, 'setDone'), true); assert.deepEqual(last(c, 'setConfirming'), false); },
  },
] as const;

for (const r of RAILS) {
  const make = (wallet: () => Promise<unknown>) => harness({ file: r.file, name: r.name, header: r.header, wallet, extra: r.extra as Record<string, unknown> });

  describe(`${r.key}: when the liquidity gate refuses the Wallet payment`, () => {
    const refused = () => Promise.reject(new WalletUnavailableError('Wallet temporarily unavailable. No money has been taken. Please use another payment method.', true));

    test('the calm notice is shown, INSIDE the sheet', async () => {
      const h = make(refused);
      await h.run(...r.args);
      assert.deepEqual(last(h.calls, 'setPayNotice'), WALLET_UNAVAILABLE_NOTICE);
      assert.equal((last(h.calls, 'setPayNotice') as { title: string }).title, 'Wallet temporarily unavailable');
    });

    test('the root alert is NEVER used — there is no second modal to deadlock', async () => {
      const h = make(refused);
      await h.run(...r.args);
      assert.equal(names(h.calls).includes('alert'), false);
    });

    test('the sheet is not closed or reopened by the runner (no modal churn), and nothing navigates', async () => {
      const h = make(refused);
      await h.run(...r.args);
      assert.equal(names(h.calls).filter((n) => n === 'setConfirming' || n === 'setPayingType').length, 0, 'the runner closed the sheet while showing the notice');
      assert.equal(names(h.calls).some((n) => n.startsWith('router.')), false, 'a refusal navigated');
    });

    test('loading is cleared, so the screen is responsive again', async () => {
      const h = make(refused);
      await h.run(...r.args);
      const busy = h.calls.filter((c) => c.name === r.busy).map((c) => c.args[0]);
      assert.deepEqual(busy, [true, false], 'the busy state was not set then cleared exactly once');
      assert.equal(h.inFlight.current, false);
    });

    test('no donation / membership / pass is recorded and nothing else on the screen changes', async () => {
      const h = make(refused);
      await h.run(...r.args);
      for (const n of ['setDonated', 'setDone', 'setJoinSuccess', 'setWalletBalance', 'load']) {
        assert.equal(names(h.calls).includes(n), false, `${n} was called for a payment that was refused`);
      }
    });

    test('the button is usable again: after dismissal a second attempt runs; and a tap WHILE one is running is ignored', async () => {
      let release!: () => void;
      let n = 0;
      const h = make(() => { n++; return n === 1 ? new Promise((_, rej) => { release = () => rej(new WalletUnavailableError('x', true)); }) : Promise.resolve({ ok: true, balance_pence: 400 }); });
      const first = h.run(...r.args);
      await h.run(...r.args);                       // a second tap while the first is in flight
      assert.equal(h.walletCalls(), 1, 'a second submission was sent while the first was in flight');
      release(); await first;
      assert.equal(h.inFlight.current, false);
      await h.run(...r.args);                       // after the notice, the donor tries again
      assert.equal(h.walletCalls(), 2);
    });

    test('starting an attempt clears any notice left from the last one', async () => {
      const h = make(() => Promise.resolve({ ok: true }));
      await h.run(...r.args);
      const firstNotice = h.calls.find((c) => c.name === 'setPayNotice');
      assert.deepEqual(firstNotice?.args[0], null);
    });
  });

  describe(`${r.key}: success is unchanged`, () => {
    test('balance updated, sheet closed, result shown inline, no notice, no alert', async () => {
      const h = make(() => Promise.resolve({ ok: true, balance_pence: 400 }));
      await h.run(...r.args);
      r.success(h.calls);
      assert.deepEqual(last(h.calls, 'setWalletBalance'), 400);
      assert.equal(names(h.calls).includes('alert'), false);
      const notices = h.calls.filter((c) => c.name === 'setPayNotice').map((c) => c.args[0]);
      assert.deepEqual(notices, [null], 'a successful payment left a notice behind');
      assert.equal(h.inFlight.current, false);
    });
  });

  describe(`${r.key}: an ordinary server or payment error keeps its normal treatment`, () => {
    test(`"${r.failedTitle}" with the server's own message — in the sheet, never the root alert, sheet left open`, async () => {
      const h = make(() => Promise.reject(new Error('Insufficient balance — top up first')));
      await h.run(...r.args);
      assert.deepEqual(last(h.calls, 'setPayNotice'), { tone: 'error', title: r.failedTitle, message: 'Insufficient balance — top up first' });
      assert.equal(names(h.calls).includes('alert'), false);
      assert.equal(names(h.calls).filter((x) => x === 'setConfirming' || x === 'setPayingType').length, 0);
      assert.equal(h.inFlight.current, false);
    });

    test('a RESUMED attempt is described truthfully: not "no money taken"', async () => {
      const h = make(() => Promise.reject(new WalletUnavailableError('Your wallet payment is still being completed. Nothing more has been taken — please try again shortly.', false)));
      await h.run(...r.args);
      const n = last(h.calls, 'setPayNotice') as { title: string; message: string };
      assert.equal(n.title, 'Payment still being completed');
      assert.doesNotMatch(n.message, /No money has been taken/);
    });
  });
}

/* ── the sheet itself, and the pattern, pinned out of every screen ─────────── */

describe('the sheet shows the notice itself, as a single modal', () => {
  const sheet = code(read('components/ConfirmPaymentSheet.tsx'));

  test('there is exactly ONE <Modal> in the sheet, and the notice is rendered inside it', () => {
    assert.equal((sheet.match(/<Modal\b/g) ?? []).length, 1);
    const modal = sheet.slice(sheet.indexOf('<Modal'), sheet.indexOf('</Modal>'));
    assert.match(modal, /\{notice \? \(/);
    assert.match(modal, /notice\.title/);
    assert.match(modal, /notice\.message/);
    assert.doesNotMatch(sheet, /useAlert|Alert\.alert/);
  });

  test('the notice can be dismissed WITHOUT closing the sheet, and the pay buttons stay usable', () => {
    assert.match(sheet, /onPress=\{onDismissNotice\}/);
    assert.match(sheet, /accessibilityLabel="Dismiss message"/);
    // the notice does not disable payment: only `loading` does
    assert.doesNotMatch(sheet, /disabled=\{[^}]*notice/);
  });

  test('Cancel and a scrim tap still close the sheet whenever it is not loading', () => {
    assert.match(sheet, /onPress=\{loading \? undefined : onCancel\}/);
    assert.match(sheet, /onRequestClose=\{onCancel\}/);
  });
});

describe('REGRESSION GUARD: no Wallet flow may put the root alert over — or alongside the closing of — the confirm sheet', () => {
  const files = (dir: string): string[] => readdirSync(join(REPO, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(join(REPO, rel)).isDirectory() ? files(rel) : /\.tsx$/.test(n) ? [rel] : [];
  });
  const sheetScreens = files('app').filter((f) => /<ConfirmPaymentSheet\b/.test(read(f)) && /onConfirmWallet=/.test(read(f)));

  test('the audit finds all five screens that offer a Wallet option in the sheet', () => {
    assert.deepEqual(sheetScreens.sort(), [
      'app/event-ticket-checkout.tsx', 'app/hub-donate.tsx', 'app/hubs/[id].tsx', 'app/local-buy-unit.tsx', 'app/local-gift.tsx',
    ]);
  });

  test('every such screen hands the sheet a notice and a way to dismiss it — a new screen without them fails here', () => {
    for (const f of sheetScreens) {
      const s = code(read(f));
      assert.match(s, /\bnotice=\{payNotice\}/, `${f} does not give the sheet a notice`);
      assert.match(s, /onDismissNotice=\{\(\) => setPayNotice\(null\)\}/, `${f} cannot dismiss the notice`);
      assert.match(s, /walletInFlight = useRef\(false\)/, `${f} has no guard against a double submission`);
    }
  });

  test('the Wallet runner of every such screen never calls the root alert and never closes the sheet in `finally`', () => {
    const runners: Record<string, [string, string]> = {
      'app/hub-donate.tsx': ['runDonationWallet', 'async () =>'],
      'app/hubs/[id].tsx': ['runMembershipWallet', 'async (type: HubMembershipType) =>'],
      'app/local-buy-unit.tsx': ['runBuyWallet', 'async () =>'],
      'app/event-ticket-checkout.tsx': ['runPurchaseWallet', 'async () =>'],
    };
    for (const [f, [name, header]] of Object.entries(runners)) {
      const fn = code(runnerSource(f, name, header));
      assert.doesNotMatch(fn, /\balert\(/, `${f}: ${name} calls the root alert from a Wallet flow`);
      const fin = fn.slice(fn.indexOf('finally'));
      assert.doesNotMatch(fin, /setConfirming\(|setPayingType\(/, `${f}: ${name} closes the sheet in finally`);
    }
    // the gift runner serves card AND wallet: its WALLET branch must use the notice, and must not close the sheet on failure
    const gift = code(runnerSource('app/local-gift.tsx', 'runGift', 'async (viaWallet = false) =>'));
    assert.match(gift, /if \(viaWallet\) \{[\s\S]*walletFailed = true;[\s\S]*setPayNotice\(walletFailureNotice\(e, 'Gift failed'\)\);[\s\S]*\} else \{[\s\S]*alert\(/);
    assert.match(gift, /if \(!walletFailed\) setConfirming\(false\);/);
  });

  test('no screen presents the root alert while a Wallet payment is running (no `alert(` between the call and its settlement)', () => {
    for (const f of ['app/hub-donate.tsx', 'app/local-buy-unit.tsx', 'app/hubs/[id].tsx']) {
      const s = code(read(f));
      assert.doesNotMatch(s, /walletFailureAlert/, `${f} still uses the alert-based helper`);
    }
    assert.doesNotMatch(code(read('lib/local-api.ts')), /walletFailureAlert/);
  });
});
