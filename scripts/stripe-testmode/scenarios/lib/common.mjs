// Shared harness for the Editions Stripe test-mode scenarios. NOT to be run by itself: the E0..E5 scripts import it.
//
// Safety properties enforced here:
//  * live runs refuse to start unless `webhook-guard.mjs verify-isolated --allow FILE` passes (the allow file is --allow or $STRIPE_TESTMODE_ALLOW);
//  * the database is the LOCAL container editions-11-pg only (docker exec, owner role, password read INSIDE the container: never handled here);
//  * Stripe is reached ONLY through lib/stripe-cli.mjs (test mode, project default) or through the forwarder (same CLI) / stripe-mock (--dry-run);
//  * --dry-run: NOTHING reaches the real Stripe account. Every Stripe call is printed as the exact `stripe ...` command it would run and is answered by the local stripe-mock;
//    the local database and the real functions still run, so the whole path is exercised. Assertions are listed but not enforced (stripe-mock returns fixtures, not real money).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { stripe, assertTestMode } from '../../lib/stripe-cli.mjs';
import { main as guardMain } from '../../webhook-guard.mjs';
import { feeParts, feePercent, stripePercentFee, signForTest, commissionRefundedCumulative } from '../../../../supabase/functions/_shared/editions-commerce-core.ts';

const HERE = dirname(fileURLToPath(import.meta.url)); export const TM = join(HERE, '..', '..');
export const MOCK = process.env.STRIPE_MOCK_URL ?? 'http://127.0.0.1:12111';
export const CFG = { commission_percent: 2, commission_fixed_pence: 0, commission_min_pence: 0, commission_cap_pence: null, stripe_cost_percent: 1.5, stripe_cost_fixed_pence: 20 };   // the placeholder estimate rates
export const ASSUMED_S = { domestic: (c) => Math.round(c * 0.016) + 20, premium: (c) => Math.round(c * 0.025) + 20 };   // the fee demo's ASSUMED actual-fee model (not Stripe's published rates)
export const CARDS = { uk: { pm: 'pm_card_gb', number: '4000008260000000', model: 'domestic' }, intl: { pm: 'pm_card_br', number: '4000000760000002', model: 'premium' }, dispute: { pm: 'pm_card_createDispute', number: '4000000000000259', model: 'domestic' } };
export { feeParts, feePercent, stripePercentFee, commissionRefundedCumulative };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const gbp = (p) => (p == null ? '   n/a ' : `${p < 0 ? '-' : ''}${(Math.abs(p) / 100).toFixed(2)}`);

export async function init(name, argv, { needsAccount = true, nAccounts = 1 } = {}) {
  const a = argv.slice(2); const flag = (f) => a.includes(f); const val = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const run = { name, dry: flag('--dry-run'), keep: flag('--keep'), id: val('--run-id', `tr-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`), allow: val('--allow', process.env.STRIPE_TESTMODE_ALLOW), accountArg: val('--account'), a, flag, val,
    results: [], table: [], cleanups: [], known: new Set(), delivered: new Set(), start: Math.floor(Date.now() / 1000) - 5, procs: [] };
  console.log(`\n=== ${name}  run=${run.id}  ${run.dry ? 'DRY RUN (stripe-mock only; nothing reaches Stripe)' : 'LIVE TEST MODE (read-write Stripe test account via the CLI)'}`);
  if (!run.dry) {
    if (!run.allow) { console.error('REFUSING: --allow FILE (or $STRIPE_TESTMODE_ALLOW) is required for a live run: the webhook isolation check needs it.'); process.exit(2); }
    const g = guardMain(['verify-isolated', '--allow', run.allow]); if (g !== 0) { console.error(`REFUSING: webhook-guard verify-isolated failed (exit ${g}). Run inside run-with-guard.mjs after Darren has approved the endpoint ids.`); process.exit(2); }
  }
  run.local = loadLocalEnv(); 
  // ---- Stripe access
  run.api = (method, path, o = {}) => {
    const data = o.data ?? []; const argvShow = stripe(method, path, { ...o, data, dryRun: true }).argv.join(' ');
    if (run.dry) { console.log(`   PLAN  ${argvShow}`); return mockCall(method, path, o); }
    const r = stripe(method, path, { ...o, data }); log(`   stripe ${method} ${path} -> ${r.status}`); if (r.body && typeof r.body === 'object') collectIds(run, r.body); return r;
  };
  run.must = (r, what) => { if (!r.ok) throw new Error(`${what} failed (${r.status}): ${r.body?.error?.message ?? ''}`); return r.body; };
  // ---- assertions
  run.check = (label, cond, detail = '') => { const ok = !!cond; run.results.push({ label, ok, detail, enforced: !run.dry }); console.log(`   ${run.dry ? (ok ? 'ok?  ' : 'n/a  ') : ok ? 'PASS ' : 'FAIL '} ${label}${detail ? `  (${detail})` : ''}`); return ok; };
  run.warn = (label, ok, detail = '') => console.log(`   ${ok ? 'ok   ' : 'WARN '} ${label}${detail ? `  (${detail})` : ''}`);
  // ---- accounts
  if (needsAccount) run.accounts = pickAccounts(run, nAccounts);
  // ---- stack
  run.stack = await startStack(run);
  run.cleanups.push(async () => stopStack(run));
  return run;
}
const log = (s) => { if (process.env.SCENARIO_VERBOSE) console.log(s); };

export function loadLocalEnv(file = process.env.EDITIONS_LOCAL_ENV ?? '/tmp/editions-11.env') {
  const e = Object.fromEntries(readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/^export\s+/, '').match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(e.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('the Supabase URL is not loopback: refusing');
  return { url: e.NEXT_PUBLIC_SUPABASE_URL, anon: e.NEXT_PUBLIC_SUPABASE_ANON_KEY, jwtSecret: e.SUPABASE_JWT_SECRET, container: e.EDITIONS_LOCAL_PSQL_CONTAINER ?? 'editions-11-pg' };
}

/* ───── stripe-mock for dry runs (answers in the CLI's shape) ───── */
async function mockCallAsync(method, path, o) {
  const q = new URLSearchParams(); for (const [k, v] of o.data ?? []) q.append(k, v);
  const headers = { Authorization: 'Bearer sk_test_mock', ...(o.idempotencyKey ? { 'Idempotency-Key': o.idempotencyKey } : {}), ...(o.account ? { 'Stripe-Account': o.account } : {}) };
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const url = `${MOCK}${path}${method !== 'POST' && [...q].length ? `?${q}` : ''}`;
  const r = await fetch(url, { method, headers, body: method === 'POST' ? q.toString() : undefined }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = { error: { message: t } }; }
  return { ok: r.ok, status: r.status, body: b };
}
// run.api is synchronous for the CLI; in a dry run the mock needs await, so scenarios always `await run.api(...)`.
const mockCall = (method, path, o) => mockCallAsync(method, path, o);

function collectIds(run, body) { const s = JSON.stringify(body); for (const m of s.matchAll(/"((?:pi|ch|re|fee|fr|tr|trr|dp|du|in|sub|cus|prod|price|py|pyr|clock|evt)_[A-Za-z0-9]+)"/g)) run.known.add(m[1]); }

/* ───── accounts: reuse EXISTING Express test accounts, never create one, never Scalloway Boating Club ───── */
function pickAccounts(run, n) {
  if (run.dry) { run.chosen = Array.from({ length: n }, (_, i) => ({ id: `acct_DRYRUN${i + 1}`, name: 'dry-run placeholder' })); console.log(`   accounts (dry run): ${run.chosen.map((c) => c.id).join(', ')}`); return run.chosen.map((c) => c.id); }
  const r = stripe('GET', '/v1/accounts', { query: [['limit', '100']] }); if (!r.ok) throw new Error(`cannot read accounts (${r.status}): ${r.body?.error?.message}`);
  assertTestMode(r.body, 'account list');
  const nameOf = (x) => [x.business_profile?.name, x.company?.name, x.settings?.dashboard?.display_name, x.email, x.individual?.first_name, x.metadata?.name].filter(Boolean).join(' | ');
  const ok = (x) => x.type === 'express' && x.capabilities?.transfers === 'active' && x.payouts_enabled === true && x.details_submitted !== false && !/scalloway/i.test(nameOf(x) + JSON.stringify(x.metadata ?? {}));
  const all = (r.body.data ?? []).filter(ok);
  if (!run.accountArg) { console.error(`REFUSING: a live run needs an explicit --account acct_... (name-based exclusion of the Scalloway Boating Club profile cannot be proven from the API fields). Eligible Express test accounts (transfers active, payouts enabled): ${all.map((x) => x.id).join(', ')}`); process.exit(2); }
  const want = all.filter((x) => x.id === run.accountArg);
  if (run.accountArg && !want.length) throw new Error(`--account ${run.accountArg} is not an eligible Express account (needs transfers active, payouts enabled, not the Scalloway Boating Club profile)`);
  if (want.length < n) throw new Error(`need ${n} eligible Express test account(s), found ${want.length}`);
  run.chosen = want.slice(0, n).map((x) => ({ id: x.id, name: nameOf(x) || '(unnamed)', capabilities: x.capabilities }));
  console.log(`   connected accounts chosen (existing, not created): ${run.chosen.map((c) => `${c.id} [${c.name}]`).join('; ')}`);
  return run.chosen.map((c) => c.id);
}

/* ───── local stack: forwarder + the real functions ───── */
async function startStack(run) {
  const f = spawn(process.execPath, [join(TM, 'stripe-forwarder.mjs'), '--target', run.dry ? 'mock' : 'cli', '--tag', run.id, ...(run.dry ? ['--print-plan'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] }); run.procs.push(f);
  let fwdLog = ''; f.stdout.on('data', (d) => { fwdLog += d; if (process.env.SCENARIO_VERBOSE || (run.dry && /PLAN/.test(String(d)))) process.stdout.write(`   [fn->stripe] ${d}`); });
  for (let i = 0; i < 50 && !/FORWARDER_URL=/.test(fwdLog); i++) await sleep(100);
  const fwd = /FORWARDER_URL=(\S+)/.exec(fwdLog)?.[1]; if (!fwd) throw new Error('forwarder did not start');
  const dir = join('/Users/darrenfullerton/Claude/safe-test/run', run.id);
  const s = spawnSync(join(TM, 'run-functions-local.sh'), ['start', fwd, dir], { encoding: 'utf8' }); if (s.status !== 0) throw new Error(`functions did not start: ${s.stdout}${s.stderr}`);
  const ports = Object.fromEntries(readFileSync(join(dir, 'ports.env'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const secrets = Object.fromEntries(readFileSync(join(dir, 'secrets.env'), 'utf8').trim().split('\n').map((l) => l.split('=')));
  const serviceJwt = readFileSync(join(dir, 'service.jwt'), 'utf8').trim();
  console.log(`   local stack: forwarder ${fwd} (${run.dry ? 'stripe-mock' : 'Stripe test mode via CLI'}); functions ${Object.values(ports).join(', ')}`);
  return { fwd, dir, ports, secrets, serviceJwt, forwarder: f };
}
async function stopStack(run) {
  const s = run.stack; if (!s) return; spawnSync(join(TM, 'run-functions-local.sh'), ['stop', s.dir]); try { s.forwarder.kill(); } catch { /* */ }
  try { const j = await (await fetch(`${s.fwd}/__forwarder/journal`)).json(); void j; } catch { /* already stopped */ }
}
export const journal = async (run) => (await (await fetch(`${run.stack.fwd}/__forwarder/journal`)).json()).journal;

/* ───── local database (container only) ───── */
export function psql(run, input) {
  if (run.local.container !== 'editions-11-pg') throw new Error('only the local container editions-11-pg may be used');
  const r = spawnSync('docker', ['exec', '-i', 'editions-11-pg', 'sh', '-c', 'PGPASSWORD=$POSTGRES_PASSWORD psql -U supabase_admin -d postgres -X -q -At -v ON_ERROR_STOP=0'], { input, encoding: 'utf8', maxBuffer: 1 << 26 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const tags = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|CREATE .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
export const lastRow = (o) => o.split('\n').map((l) => l.trim()).filter((l) => l && !tags.test(l) && !/^(ERROR|psql:|LINE |DETAIL|HINT|CONTEXT|NOTICE|WARNING)/.test(l)).pop() ?? '';
export const failedSql = (o) => /^ERROR:/m.test(o);
const claims = (id) => `set local request.jwt.claims = '{"sub":"${id}","role":"authenticated"}'; set local request.jwt.claim.sub = '${id}'; set local role authenticated;`;
export const sql = (run, q) => lastRow(psql(run, q));
export const asUser = (run, id, q) => { const o = psql(run, `begin; ${claims(id)} ${q}; commit;`); if (failedSql(o)) throw new Error(`SQL as ${id.slice(0, 8)} failed: ${o.split('\n').find((l) => /^ERROR/.test(l))}`); return lastRow(o); };
export const asService = (run, q) => { const o = psql(run, `begin; set local role service_role; ${q}; commit;`); if (failedSql(o)) throw new Error(`SQL as service failed: ${o.split('\n').find((l) => /^ERROR/.test(l))}`); return lastRow(o); };
export const q = (run, text) => sql(run, text);

/* ───── local GoTrue users and tokens ───── */
export async function makeUser(run, label, role = 'customer') {
  const email = `${run.id}-${String(run.name ?? 'x').replace(/[^a-z0-9]+/gi, '')}-${label}@zz-test.invalid`.toLowerCase(), password = `pw-${randomBytes(12).toString('hex')}`;
  const svc = run.stack.serviceJwt; const H = { 'Content-Type': 'application/json', apikey: run.local.anon, Authorization: `Bearer ${svc}` };
  const c = await fetch(`${run.local.url}/auth/v1/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ email, password, email_confirm: true }) }); const cj = await c.json(); if (!cj.id) throw new Error(`local user create failed: ${c.status}`);
  const t = await fetch(`${run.local.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: run.local.anon }, body: JSON.stringify({ email, password }) }); const tj = await t.json(); if (!tj.access_token) throw new Error('local sign-in failed');
  psql(run, `insert into profiles (id, role, full_name) values ('${cj.id}','${role}','ZZ ${label}') on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;`);
  return { id: cj.id, email, token: tj.access_token, label };
}

/* ───── fixtures (the same recipe as the isolated suites, over the local stack) ───── */
export async function setup(run, { acct, memberships = false, tag = 'a' } = {}) {
  psql(run, `insert into admin_config (key, value, category) values ('editions.enabled','true','features'),('editions.commerce.enabled','true','editions') on conflict (key) do update set value = 'true';`);
  const admin = await makeUser(run, `admin-${tag}`, 'admin'), owner = await makeUser(run, `owner-${tag}`);
  const biz = sql(run, `insert into local_businesses (owner_id, name, category, address, is_active) values ('${owner.id}','ZZ ${run.id} Organiser ${tag}','food_drink','1 Commercial Street, Lerwick',true) returning id`);
  const org = asUser(run, owner.id, `select (public.edition_ensure_organiser('business','${biz}') ->> 'id')`);
  for (const f of ['collect_payments', 'memberships', 'offline_records', 'participation_fees']) asUser(run, admin.id, `select public.admin_grant_edition_org_entitlement('${org}','${f}',null,now() + interval '90 days','ZZ ${run.id}')`);
  asUser(run, owner.id, `select public.edition_accept_commerce_terms('${org}','draft-1')`);
  psql(run, `delete from edition_payout_accounts where stripe_account_id = '${acct}'`);   // LOCAL db only: an earlier run may still hold this connected account
  asService(run, `select public.edition_payout_account_sync('${org}','${acct}',true,true,true,'[]'::jsonb)`);
  const S = { admin, owner, biz, org, acct, tag, payers: [] };
  S.newEdition = (slug, publish = true) => {
    const ed = asUser(run, owner.id, `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${org}','${slug}-${String(run.name ?? 'x').slice(0, 2).toLowerCase()}-${run.id.slice(-6).replace(/[^a-z0-9]/gi, 'x').toLowerCase()}','ZZ ${slug}','A festival','multi_day',current_date + 20,current_date + 22) returning id`);
    psql(run, `insert into public.edition_pages (edition_id, slug, nav_label, title, body, position, in_nav, is_home) values ('${ed}','welcome','Welcome','Welcome','Hello',0,true,true)`);
    asUser(run, owner.id, `select public.edition_submit_for_review('${ed}')`); asUser(run, admin.id, `select public.admin_review_edition('${ed}','approve','ZZ test run')`);
    if (publish) { asUser(run, admin.id, `select public.admin_grant_edition_entitlement('${ed}','publish',now(),now() + interval '90 days','ZZ ${run.id}')`); asUser(run, owner.id, `select public.edition_set_status('${ed}','published')`); }
    return ed;
  };
  S.newPayer = async (label) => {   // a paying Business: its own user (so each payment has its own customer and link)
    const u = await makeUser(run, `payer-${tag}-${label}`); const b = sql(run, `insert into local_businesses (owner_id, name, category, address, is_active, subscription_tier, subscription_until) values ('${u.id}','ZZ ${run.id} Payer ${label}','food_drink','x',true,'pro', now() + interval '90 days') returning id`);
    const p = { ...u, biz: b }; S.payers.push(p); return p;
  };
  S.base = S.newEdition('base');   // approving an Edition is what makes the organiser 'verified' (memberships and collection need that)
  S.editions = {};   // the fee terms are frozen once anyone pays, so each price gets its own published Edition
  S.editionFor = (price) => { if (!S.editions[price]) { const ed = S.newEdition(`fee-${price}`); asUser(run, owner.id, `select public.edition_set_participation_terms('${ed}','fee_required',${price},'none','full',null,null,null)`); S.editions[price] = ed; } return S.editions[price]; };
  S.newLink = async (price, label) => {
    const p = await S.newPayer(label); const edition = S.editionFor(price);
    const link = asUser(run, owner.id, `select public.edition_invite_partner('${edition}','business','${p.biz}')`); asUser(run, p.id, `select public.edition_link_act('${link}','approve',null)`);
    return { payer: p, link, edition };
  };
  return S;
}

/* ───── calls to the REAL functions ───── */
export async function callFn(run, fn, body, bearer) {
  const r = await fetch(`${run.stack.ports[fn]}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; } return { status: r.status, body: j };
}
export const checkout = (run, user, body) => callFn(run, 'create-edition-checkout', body, user.token);
export const cron = (run, action, extra = {}) => callFn(run, 'editions-commerce-cron', { action, ...extra }, run.stack.serviceJwt);

/* ───── events: fetch from Stripe, deliver to the LOCAL webhook function, signed with the local random secret ───── */
export async function fetchEvents(run, { wait = null, timeoutMs = 25000 } = {}) {
  const t0 = Date.now(); let evs = [];
  do {
    const r = await run.api('GET', '/v1/events', { query: [['limit', '100'], ['created[gte]', String(run.start)]] });
    if (r.ok) { evs = (r.body.data ?? []).filter((e) => run.dry ? true : [...run.known].some((k) => JSON.stringify(e.data?.object ?? {}).includes(k)) || JSON.stringify(e.data?.object ?? {}).includes(run.id)); }
    if (!wait || run.dry || wait(evs)) break; await sleep(1500);
  } while (Date.now() - t0 < timeoutMs);
  const vers = [...new Set(evs.map((e) => e.api_version))]; run.eventVersions = vers;
  if (!run.dry && vers.some((v) => v !== '2023-10-16') && !run.warnedVersion) { run.warnedVersion = true; console.log(`   WARNING event api_version(s) ${vers.join(', ')}: the Editions functions were written against 2023-10-16 (invoice.charge / invoice.payment_intent, subscription current_period_end). Events in a newer version may not route or enrich as designed: a finding, not a harness fault.`); }
  return evs.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}
export async function deliver(run, ev, { connect = false } = {}) {
  const body = JSON.stringify(ev); const secret = connect || ev.account ? run.stack.secrets.EDITIONS_STRIPE_CONNECT_WEBHOOK_SECRET : run.stack.secrets.EDITIONS_STRIPE_WEBHOOK_SECRET;
  const sig = await signForTest(body, secret, Math.floor(Date.now() / 1000));
  const r = await fetch(`${run.stack.ports['editions-stripe-webhook']}/`, { method: 'POST', headers: { 'stripe-signature': sig, 'Content-Type': 'application/json' }, body });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; } (run.deliveries ??= {})[ev.id] = [...((run.deliveries ?? {})[ev.id] ?? []), { status: r.status, body: j }]; return { status: r.status, body: j };
}
/** deliver every not-yet-delivered known event once, oldest first; returns the delivered events */
export async function sync(run, wait) {
  const evs = (await fetchEvents(run, { wait })).filter((e) => !run.delivered.has(e.id)); const out = [];
  for (const e of evs) { const r = await deliver(run, e); run.delivered.add(e.id); out.push({ type: e.type, id: e.id, status: r.status, body: r.body }); log(`   webhook ${e.type} -> ${r.status}`); }
  return out;
}
/** DRY RUN ONLY: stripe-mock cannot produce real events, so the scenario fabricates the event Stripe WOULD send and delivers it (signed) to the real local webhook function. Never used live. */
export async function simulate(run, type, object, { account } = {}) {
  if (!run.dry) return null;
  const ev = { id: `evt_sim_${randomBytes(6).toString('hex')}`, object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false, api_version: '2023-10-16', data: { object }, ...(account ? { account } : {}) };
  const r = await deliver(run, ev); run.delivered.add(ev.id); console.log(`   SIMULATED ${type} -> webhook ${r.status} ${JSON.stringify(r.body)}`); return r;
}
export const hasType = (types) => (evs) => types.every((t) => evs.some((e) => e.type === t));

/* ───── stripe helpers ───── */
export async function confirmPi(run, pi, pm) {
  const r = await run.api('POST', `/v1/payment_intents/${pi}/confirm`, { data: [['payment_method', pm], ['return_url', 'https://example.test/return']], idempotencyKey: `${run.id}-confirm-${pi}` }); return run.must(r, `confirm ${pi}`);
}
export async function readCharge(run, chargeId) {
  const r = await run.api('GET', `/v1/charges/${chargeId}`, { query: [['expand[]', 'balance_transaction'], ['expand[]', 'application_fee'], ['expand[]', 'transfer']] }); const c = run.must(r, `read charge ${chargeId}`);
  return { id: c.id, amount: c.amount, refunded: c.amount_refunded, application_fee_amount: c.application_fee_amount ?? null, fee: c.balance_transaction?.fee ?? null, fee_details: c.balance_transaction?.fee_details ?? [], net: c.balance_transaction?.net ?? null,
    app_fee: c.application_fee && typeof c.application_fee === 'object' ? { id: c.application_fee.id, amount: c.application_fee.amount, refunded: c.application_fee.amount_refunded } : null,
    transfer: c.transfer && typeof c.transfer === 'object' ? { id: c.transfer.id, amount: c.transfer.amount, reversed: c.transfer.amount_reversed, destination: c.transfer.destination } : null, pi: c.payment_intent, invoice: c.invoice, raw: c };
}
export const latestCharge = async (run, pi) => { const r = run.must(await run.api('GET', `/v1/payment_intents/${pi}`), `read ${pi}`); return typeof r.latest_charge === 'string' ? r.latest_charge : r.latest_charge?.id; };

/* ───── reporting and finish ───── */
export const addRow = (run, row) => run.table.push(row);
export function printTable(run, title, cols) {
  console.log(`\n${title}  (MEASURED vs MODEL; amounts in GBP; model fee S uses the fee demo's ASSUMED rates)`);
  const w = cols.map((c) => Math.max(c.h.length, ...run.table.map((r) => String(c.f(r)).length))); console.log('  ' + cols.map((c, i) => c.h.padEnd(w[i])).join('  ')); for (const r of run.table) console.log('  ' + cols.map((c, i) => String(c.f(r)).padEnd(w[i])).join('  '));
}
export async function finish(run, fn) {
  let crashed = null; try { await fn(); } catch (e) { crashed = e; console.error(`\nSCENARIO ERROR: ${e.stack ?? e}`); }
  for (const c of run.cleanups.reverse()) { try { await c(); } catch (e) { console.error(`cleanup error: ${e.message}`); } }
  const failed = run.results.filter((r) => !r.ok && r.enforced); const pass = run.results.filter((r) => r.ok).length;
  console.log(`\n${run.name}: ${run.dry ? `DRY RUN complete (${run.results.length} assertions listed, not enforced)` : `${pass} passed, ${failed.length} failed`}${crashed ? ', CRASHED' : ''}`);
  writeFileSync(join('/Users/darrenfullerton/Claude/safe-test/run', `${run.id}-${run.name}.json`), JSON.stringify({ run: run.id, name: run.name, dry: run.dry, accounts: run.chosen, results: run.results, table: run.table }, null, 2));
  process.exit(crashed || failed.length ? 1 : 0);
}
/** register a Stripe cleanup (live runs only): executed at the end, errors reported, never fatal */
export const onCleanup = (run, label, fn) => run.cleanups.push(async () => { if (run.keep) return; try { await fn(); console.log(`   cleaned up: ${label}`); } catch (e) { console.log(`   cleanup of ${label} failed: ${e.message}`); } });
void existsSync; void mkdirSync;

/** one participation payment end to end (real checkout function, confirm with a test card, events synced). Returns ids and the platform charge reading. */
export async function payParticipation(run, S, { C, card = 'uk', label, deliverEvents = true }) {
  const { payer, link, edition } = await S.newLink(C, label); const model = feeParts(C, CFG);
  const co = await checkout(run, payer, { kind: 'participation', id: link, attempt: `attempt-${String(run.name ?? 'x').slice(0, 2)}-${run.id.slice(-6)}-${label}` });
  run.check(`${label}: checkout accepted (HTTP 200)`, co.status === 200 && co.body.payment_intent_id, `${co.status} ${JSON.stringify(co.body).slice(0, 120)}`);
  const pi = co.body.payment_intent_id; const po = (await run.api('GET', `/v1/payment_intents/${pi}`)).body;
  if (po.customer) onCleanup(run, `customer ${po.customer}`, () => run.api('DELETE', `/v1/customers/${po.customer}`));
  await confirmPi(run, pi, CARDS[card].pm);
  if (!deliverEvents) return { pi, payer, link, edition, model, po };
  const want = card === 'dispute' ? ['payment_intent.succeeded', 'charge.dispute.created'] : ['payment_intent.succeeded'];
  await sync(run, hasType(want));
  await simulate(run, 'payment_intent.succeeded', { id: pi, object: 'payment_intent', amount: C, amount_received: C, latest_charge: 'ch_sim_1', metadata: { kind: 'edition_participation', link_id: link, organiser_id: S.org, business_id: payer.biz, edition_id: edition, buyer_id: payer.id } });
  const chId = (await latestCharge(run, pi)) ?? 'ch_123'; const ch = await readCharge(run, chId);
  const paymentId = q(run, `select id from edition_payments where stripe_payment_intent_id='${pi}'`);
  return { pi, ch, chId, payer, link, edition, model, paymentId };
}
export const dbPay = (run, paymentId) => { const r = q(run, `select refunded_pence || '|' || commission_refunded_pence || '|' || coalesce(stripe_fee_pence::text,'-') || '|' || coalesce(dispute_state,'-') || '|' || dispute_lost_pence || '|' || dispute_recovered_pence || '|' || status from edition_payments where id='${paymentId}'`).split('|'); return { refunded: Number(r[0]), commissionRefunded: Number(r[1]), stripeFee: r[2] === '-' ? null : Number(r[2]), dispute: r[3], lost: Number(r[4]), recovered: Number(r[5]), status: r[6] }; };
