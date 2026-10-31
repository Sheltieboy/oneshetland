/**
 * send-push-callers-contract.node.test.ts — static contract over EVERY Edge Function that sends a push.
 * PROVES (offline, source only): the shared sender is the only place that asks should_notify; every sendUserPush caller names a module; `urgent` is set only in the
 * reviewed allow-list; the only raw-token sendPush bypasses are the two reviewed admin alerts; reminder-runner never stamps a reminder as sent when the preference
 * check could not be read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FN = join(import.meta.dirname, '..', 'functions');
const files: Record<string, string> = {};
for (const d of readdirSync(FN)) { const p = join(FN, d, 'index.ts'); if (existsSync(p)) files[`${d}/index.ts`] = readFileSync(p, 'utf8'); }
for (const f of readdirSync(join(FN, '_shared'))) if (f.endsWith('.ts')) files[`_shared/${f}`] = readFileSync(join(FN, '_shared', f), 'utf8');
const senders = Object.keys(files).filter(f => !f.startsWith('_shared/send-push') && /\bsendUserPush(Bulk)?\s*\(/.test(files[f]));

test('1 there are 41 sendUserPush / sendUserPushBulk caller files', () => assert.equal(senders.length, 41, senders.join(',')));
test('2 only the shared sender asks should_notify', () => {
  const asks = Object.keys(files).filter(f => /rpc\(\s*['"]should_notify['"]/.test(files[f]));
  assert.deepEqual(asks, ['_shared/send-push.ts']);
});
test('3 every caller names a module', () => {
  for (const f of senders) assert.match(files[f], /module\s*:/, f);
});
test('4 urgent is set only in the reviewed allow-list', () => {
  const urgent = Object.keys(files).filter(f => /\burgent\s*:\s*(true|msg\.urgent)/.test(files[f]) && !f.startsWith('_shared/send-push')).sort();
  assert.deepEqual(urgent, ['fetch-hold-check/index.ts', 'notify-community-notice/index.ts', 'notify-job/index.ts', 'notify-shift-status/index.ts', 'stripe-webhook/index.ts', 'wallet-charge-request/index.ts']);
});
test('5 member notices and funeral/hub paths are never urgent', () => {
  for (const f of ['_shared/notice-audience.ts', '_shared/notice-dispatch.ts', 'notify-funeral-notice/index.ts', 'notify-hub-content/index.ts', 'notify-notice-audience/index.ts'])
    if (files[f]) assert.doesNotMatch(files[f], /urgent\s*:\s*true/, f);
});
test('6 raw sendPush bypasses are exactly the two reviewed admin alerts', () => {
  const raw = Object.keys(files).filter(f => /\bsendPush\s*\(/.test(files[f]) && !f.startsWith('_shared/send-push')).sort();
  assert.deepEqual(raw, ['notify-business-claim/index.ts', 'wallet-liquidity-monitor/index.ts']);
});
test('7 reminder-runner leaves reminders unstamped when the preference check failed', () => {
  const s = files['reminder-runner/index.ts'];
  assert.ok((s.match(/preference_check_failed/g) ?? []).length >= 3);
  assert.ok((s.match(/checkFailed > 0/g) ?? []).length >= 4);
  assert.match(s, /deferred_preference_check/);
});
test('8 the two raw sendPush callers only ever address platform ADMIN devices (staff operational alerts), never members', () => {
  for (const f of ['wallet-liquidity-monitor/index.ts', 'notify-business-claim/index.ts']) {
    assert.match(files[f], /\.eq\(\s*'role'\s*,\s*'admin'\s*\)/, f);
    assert.doesNotMatch(files[f], /sendUserPush/, f);
    assert.doesNotMatch(files[f], /\.from\(\s*'(?:push_tokens|notice_notification_prefs|hub_members|event_tickets)'/, f);
  }
});
test('9 every file that calls sendUserPush / sendUserPushBulk imports it (a missing import is a ReferenceError for every recipient: notify-hub-content once had this)', () => {
  for (const f of senders) {
    for (const fn of ['sendUserPush', 'sendUserPushBulk']) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(files[f])) assert.match(files[f], new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*'[^']*send-push\\.ts'`), `${f} uses ${fn} without importing it`);
    }
  }
});
