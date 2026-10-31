/**
 * notices-alerts-app-member.node.test.ts - the app half of MEMBER notice publishing (LOCAL; pure unit tests, no network, no database).
 * The real lib/member-notices.ts and lib/member-notices-api.ts run under node with a fake Supabase client that records every RPC; the screens (JSX) are
 * pinned by source checks. The database rules themselves are proven in notices-alerts-member.node.test.ts (isolated Postgres) and on the acceptance backend.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, readRepo } from './_support/load-source.ts';

const mn = loadModule('lib/member-notices.ts') as any;
const calls: { fn: string; args: any }[] = [];
let respond: Record<string, any> = {};
const client = { rpc: async (fn: string, args: any = {}) => { calls.push({ fn, args }); const r = respond[fn]; return r instanceof Error ? { data: null, error: r } : { data: r ?? null, error: null }; } };
const api = loadModule('lib/member-notices-api.ts', { './supabase': { supabase: client }, './member-notices': mn }) as any;

const CATS = [{ id: 'community' }, { id: 'lost_found' }];
const NOW = new Date('2026-11-01T10:00:00');
const ok = (o: Partial<any> = {}) => ({ ...mn.EMPTY_NOTICE_FORM, title: 'Lost: grey cat near the Co-op', body: 'A grey cat with a white paw, last seen on Tuesday.', category: 'lost_found', scope: 'wide', ...o });

describe('form validation mirrors the server', () => {
  test('a complete Shetland-wide form is ready; the empty form lists every missing piece in order', () => {
    assert.deepEqual(mn.validateNoticeForm(ok(), CATS, NOW), []);
    const p = mn.validateNoticeForm(mn.EMPTY_NOTICE_FORM, CATS, NOW);
    assert.equal(p.length, 4); assert.match(p[0], /title/); assert.match(p[1], /what is happening|Say what/i); assert.match(p[2], /category/i); assert.match(p[3], /where/i);
  });
  test('title and text lengths, an unlisted category, and the area rules', () => {
    assert.equal(mn.validateNoticeForm(ok({ title: 'Hi' }), CATS, NOW).length, 1);
    assert.equal(mn.validateNoticeForm(ok({ title: 'x'.repeat(121) }), CATS, NOW).length, 1);
    assert.equal(mn.validateNoticeForm(ok({ body: 'short' }), CATS, NOW).length, 1);
    assert.equal(mn.validateNoticeForm(ok({ body: 'x'.repeat(2001) }), CATS, NOW).length, 1);
    assert.match(mn.validateNoticeForm(ok({ category: 'not_a_category' }), CATS, NOW)[0], /category/i);
    assert.match(mn.validateNoticeForm(ok({ scope: 'specific', areaIds: [] }), CATS, NOW)[0], /at least one place/);
    assert.match(mn.validateNoticeForm(ok({ scope: 'specific', areaIds: Array.from({ length: 9 }, (_, i) => 'a' + i) }), CATS, NOW)[0], /at most 8/);
    assert.deepEqual(mn.validateNoticeForm(ok({ scope: 'specific', areaIds: ['voe', 'brae'] }), CATS, NOW), []);
  });
  test('the end date: blank is fine; DD/MM/YYYY only; future; at most 90 days', () => {
    assert.deepEqual(mn.validateNoticeForm(ok({ expiry: '' }), CATS, NOW), []);
    assert.deepEqual(mn.validateNoticeForm(ok({ expiry: '20/11/2026' }), CATS, NOW), []);
    assert.match(mn.validateNoticeForm(ok({ expiry: '2026-11-20' }), CATS, NOW)[0], /DD\/MM\/YYYY/);
    assert.match(mn.validateNoticeForm(ok({ expiry: '31/02/2026' }), CATS, NOW)[0], /DD\/MM\/YYYY/, 'not a real date');
    assert.match(mn.validateNoticeForm(ok({ expiry: '01/10/2026' }), CATS, NOW)[0], /future/);
    assert.match(mn.validateNoticeForm(ok({ expiry: '01/04/2027' }), CATS, NOW)[0], /90 days/);
    assert.equal(mn.parseExpiry('20/11/2026').getHours(), 23, 'until the END of the chosen day');
  });
});

describe('payloads: what is sent', () => {
  test('Shetland-wide sends exactly [shetland_wide]; specific sends the chosen areas, de-duplicated and sorted; the form can never send unspecified', () => {
    assert.deepEqual(mn.buildSubmitArgs(ok({ scope: 'wide', areaIds: ['voe'] })).p_area_ids, ['shetland_wide'], 'wide wins over any stale selection and is never mixed');
    assert.deepEqual(mn.buildSubmitArgs(ok({ scope: 'specific', areaIds: ['voe', 'brae', 'voe'] })).p_area_ids, ['brae', 'voe']);
    assert.deepEqual(mn.buildSubmitArgs(ok({ scope: null })).p_area_ids, [], 'unreachable from the screen (validation requires a choice)');
    assert.deepEqual(mn.validateNoticeForm(ok({ scope: null }), CATS, NOW).filter((x: string) => /where/i.test(x)).length, 1);
  });
  test('only title, text, category, areas and expiry exist in the payload: no severity, essential, hub, business, event, author or status field', () => {
    const a = mn.buildSubmitArgs(ok({ title: '  Padded title  ', expiry: '20/11/2026' }));
    assert.deepEqual(Object.keys(a).sort(), ['p_area_ids', 'p_body', 'p_category', 'p_expires_at', 'p_title']);
    assert.equal(a.p_title, 'Padded title'); assert.match(a.p_expires_at, /^2026-11-20T/); assert.equal(mn.buildSubmitArgs(ok()).p_expires_at, null);
    assert.deepEqual(Object.keys(mn.buildEditArgs('n1', ok())).sort(), ['p_area_ids', 'p_body', 'p_category', 'p_expires_at', 'p_notice', 'p_title']);
  });
});

describe('labels and mapping', () => {
  test('area labels keep the three states apart: unspecified has NO label, Shetland-wide says so, specific lists names', () => {
    assert.equal(mn.areaScopeLabel([], []), null); assert.equal(mn.areaScopeLabel(undefined, undefined), null);
    assert.equal(mn.areaScopeLabel(['shetland_wide'], ['Shetland-wide']), 'Shetland-wide'); assert.equal(mn.areaScopeLabel(['shetland_wide'], []), 'Shetland-wide');
    assert.equal(mn.areaScopeLabel(['voe'], ['Voe']), 'Voe'); assert.equal(mn.areaScopeLabel(['voe', 'brae', 'toft'], ['Brae', 'Toft', 'Voe']), 'Brae, Toft +1');
    assert.equal(mn.areaScopeLabel(['voe'], []), null, 'never invents a name');
  });
  test('every state has a label, help text and tone; "declined" reads as Not approved; pending is Awaiting approval', () => {
    for (const s of ['pending', 'published', 'expired', 'withdrawn', 'declined', 'resolved']) { assert.ok(mn.STATE_LABEL[s] && mn.STATE_HELP[s] && mn.STATE_TONE[s], s); }
    assert.equal(mn.STATE_LABEL.pending, 'Awaiting approval'); assert.equal(mn.STATE_LABEL.declined, 'Not approved');
  });
  test('mapMyNoticeRow is defensive and the edit form is pre-filled from the row (wide / specific / unspecified)', () => {
    const row = { id: 'n1', title: 'T', body: 'B', category: 'community', category_label: 'Community', state: 'published', created_at: '2026-11-01T09:00:00Z', published_at: '2026-11-01T09:30:00Z', expires_at: '2026-11-20T23:59:00', area_ids: ['voe'], area_names: ['Voe'], decline_reason: null, can_edit: true, can_withdraw: true };
    const m = mn.mapMyNoticeRow(row); assert.deepEqual([m.state, m.canEdit, m.areaIds], ['published', true, ['voe']]);
    assert.equal(mn.mapMyNoticeRow({ ...row, state: 'weird' }).state, 'pending'); assert.equal(mn.mapMyNoticeRow({ ...row, can_edit: 'yes' }).canEdit, false);
    assert.deepEqual([mn.formFromNotice(m).scope, mn.formFromNotice(m).areaIds, mn.formFromNotice(m).expiry], ['specific', ['voe'], '20/11/2026']);
    assert.equal(mn.formFromNotice(mn.mapMyNoticeRow({ ...row, area_ids: ['shetland_wide'] })).scope, 'wide');
    assert.equal(mn.formFromNotice(mn.mapMyNoticeRow({ ...row, area_ids: [] })).scope, null, 'an unspecified notice must be given a choice before it can be saved again');
  });
  test('server refusals are shown in words; nothing technical reaches the member', () => {
    assert.match(mn.friendlyError('You already have 5 notices awaiting review'), /5 notices awaiting approval/);
    assert.equal(mn.friendlyError('new row for relation "notices" violates check constraint'), 'Something went wrong. Please try again.');
    assert.equal(mn.friendlyError(undefined), 'Something went wrong. Please try again.');
    assert.equal(mn.friendlyError('Choose one of the listed categories'), 'Choose one of the listed categories');
  });
});

describe('RPC wrappers', () => {
  test('submit / edit / withdraw / list call the member functions with exactly the built arguments, and throw server errors', async () => {
    calls.length = 0; respond = { submit_person_notice: 'new-id', my_person_notices: [{ id: 'a', title: 'A', state: 'pending', can_edit: true, can_withdraw: true, area_ids: [], area_names: [] }] };
    assert.equal(await api.submitMyNotice(ok({ scope: 'specific', areaIds: ['voe'] })), 'new-id');
    await api.editMyNotice('n1', ok()); await api.withdrawMyNotice('n1'); const list = await api.loadMyNotices();
    assert.deepEqual(calls.map((c) => c.fn), ['submit_person_notice', 'edit_my_person_notice', 'withdraw_my_person_notice', 'my_person_notices']);
    assert.deepEqual(calls[2].args, { p_notice: 'n1' }); assert.equal(list[0].state, 'pending');
    respond = { submit_person_notice: Object.assign(new Error('You already have 5 notices awaiting review'), { code: '54000' }) };
    await assert.rejects(() => api.submitMyNotice(ok()), /5 notices/);
    respond = { my_person_notices: null }; assert.deepEqual(await api.loadMyNotices(), []);
  });
});

describe('screens (source)', () => {
  test('the form offers no urgent / essential / hub / business / event choice, requires an explicit area choice, and says what happens next', () => {
    const s = readRepo('app/notice-submit.tsx');
    assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ''), /severity|is_essential|isEssential|publisher_hub|publisher_business|event_id|campaign|Switch/, 'no control for any of them');
    assert.match(s, /Shetland-wide/); assert.match(s, /Particular places/); assert.match(s, /goes back to our team/); assert.match(s, /Posted by/); assert.match(s, /EXPIRY_DEFAULT_DAYS/);
    assert.match(s, /submitMyNotice\(f\)/); assert.match(s, /editMyNotice\(editId, f\)/); assert.match(s, /\/\(auth\)\/sign-in/, 'signed-out visitors are sent to sign in');
    assert.doesNotMatch(s, /from\('notices'\)|\.insert\(/, 'never writes the table directly');
  });
  test('my notices: states, decline reason, edit / withdraw (with a confirmation), empty / error / signed-out states', () => {
    const s = readRepo('app/my-notices.tsx');
    for (const k of ['STATE_LABEL', 'declineReason', 'withdrawMyNotice', 'Keep it', 'You have not posted a notice', 'did not load', 'Sign in to see your notices', 'RefreshControl', '/notice-submit']) assert.match(s, new RegExp(k), k);
    assert.match(s, /areaScopeLabel/);
  });
  test('the Notices screen links to both from every tab but Deaths & funeral, which keeps its own actions; the homepage banner is untouched', () => {
    const s = readRepo('app/notices.tsx');
    assert.match(s, /!isFuneral \? \(\s*<View style=\{styles\.funeralActions\}>[\s\S]*?\/notice-submit[\s\S]*?\/my-notices/);
    assert.match(s, /\/funeral-notice-submit/);
    assert.match(readRepo('components/notices/EssentialAlerts.tsx'), /Dismiss Essential Alert/);
  });
});
