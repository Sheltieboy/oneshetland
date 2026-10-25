/**
 * _support/fetch-v2-world.ts — one throwaway Fetch v2 world for whole-product isolated suites (Step 13): every migration replayed
 * (Steps 0–11 included), a Shetland of six regions, priced like production, approved and verified drivers, and in-memory fakes for
 * everything that would otherwise leave the machine — Stripe (manual capture, 3DS, idempotency keys, expiry), storage (signed
 * uploads, signed links) and push (Expo). Geocoding is not needed: the service function takes server-resolved coordinates, exactly as
 * the edge function passes them after its own (mocked elsewhere) lookup.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN, via createReplayDb). Fake users, fake Stripe, fake storage, fake push. No network:
 * the fake storage hands out https://storage.test/… addresses that nothing ever fetches.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './replay-db.ts';
import { type PaymentDeps } from '../../functions/_shared/fetch-v2-payments.ts';
import { type PaymentIntent, type StripeGateway, StripeDeclined, StripeRejected, StripeUnavailable } from '../../functions/_shared/fetch-v2-stripe.ts';
import { type PhotoDeps, type PhotoStorage } from '../../functions/_shared/fetch-v2-photos.ts';
import { type PushAttempt, type PushGateway, type PushMessage } from '../../functions/_shared/fetch-v2-notify.ts';

export const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',       // Yell requester, saved card
  REQ_SCA: 'a2000000-0000-4000-8000-000000000002',   // card that needs the bank's check (3DS)
  REQ_UNST: 'a3000000-0000-4000-8000-000000000003',  // Unst requester
  REQ_NOCUS: 'a4000000-0000-4000-8000-000000000004', // no Stripe Customer at all
  MEMBER: 'a5000000-0000-4000-8000-000000000005',    // an unrelated member
  D_VAN: 'd1000000-0000-4000-8000-000000000001',     // van, journey Lerwick → Yell
  D_CAR: 'd2000000-0000-4000-8000-000000000002',     // car, area Lerwick
  D_B: 'd3000000-0000-4000-8000-000000000003',       // van, competing driver
  D_EXP: 'd4000000-0000-4000-8000-000000000004',     // van whose insurance will lapse mid-job
} as const;
export type Id = keyof typeof ids;
export const nameOf = (u: string) => (Object.keys(ids) as Id[]).find((k) => ids[k] === u) ?? u;

const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
export const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE|^WARNING/.test(l));
export const lastRow = (o: string) => rowsOf(o).pop() ?? '';
export const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
export const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);
export const lit = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// ── fake Stripe (the parts Fetch relies on) ───────────────────────────────────────────────────────────────────────────────────
type FakePI = PaymentIntent & { customer: string; destination: string; applicationFee: number; paymentMethod: string | null; key: string; feeCaptured?: number };
let piSeq = 0;
export class FakeStripe implements StripeGateway {
  intents = new Map<string, FakePI>();
  byKey = new Map<string, string>();
  calls: { op: string; id?: string; key?: string; amount?: number; fee?: number }[] = [];
  behaviour: Record<string, 'ok' | 'sca'> = {};
  captureBeforeSecs = 7 * 86400;
  private clone = (p: FakePI): PaymentIntent => ({ ...p, metadata: { ...p.metadata } });
  async createHold(p: Parameters<StripeGateway['createHold']>[0]) {
    this.calls.push({ op: 'create', key: p.idempotencyKey, amount: p.amount, fee: p.applicationFee });
    const existing = this.byKey.get(p.idempotencyKey);
    if (existing) return this.clone(this.intents.get(existing)!);
    const id = `pi_world_${++piSeq}`;
    const mode = p.paymentMethod ? (this.behaviour[p.customer] ?? 'ok') : 'nocard';
    const pi: FakePI = { id, amount: p.amount, amount_received: 0, metadata: p.metadata, customer: p.customer, destination: p.destination,
      applicationFee: p.applicationFee, paymentMethod: p.paymentMethod, key: p.idempotencyKey, client_secret: `${id}_secret_fake`,
      status: mode === 'ok' ? 'requires_capture' : mode === 'sca' ? 'requires_action' : 'requires_payment_method',
      amount_capturable: mode === 'ok' ? p.amount : 0, capture_before: mode === 'ok' ? Math.floor(Date.now() / 1000) + this.captureBeforeSecs : null };
    this.intents.set(id, pi); this.byKey.set(p.idempotencyKey, id);
    return this.clone(pi);
  }
  async retrieve(id: string) { this.calls.push({ op: 'retrieve', id }); return this.clone(this.intents.get(id)!); }
  async cancel(id: string, key: string) {
    this.calls.push({ op: 'cancel', id, key });
    const pi = this.intents.get(id)!;
    if (pi.status === 'succeeded') throw new StripeRejected('payment_intent_unexpected_state');
    pi.status = 'canceled'; pi.amount_capturable = 0;
    return this.clone(pi);
  }
  async capture(id: string, amount: number, fee: number, key: string) {
    this.calls.push({ op: 'capture', id, key, amount, fee });
    const done = this.byKey.get(key);
    if (done) return this.clone(this.intents.get(done)!);
    const pi = this.intents.get(id)!;
    if (pi.status !== 'requires_capture') throw new StripeRejected('payment_intent_unexpected_state');
    if (amount > pi.amount_capturable) throw new StripeRejected('amount_too_large');
    pi.status = 'succeeded'; pi.amount_received = amount; pi.feeCaptured = fee; pi.amount_capturable = 0;
    this.byKey.set(key, id);
    return this.clone(pi);
  }
  complete(id: string) { const pi = this.intents.get(id)!; pi.status = 'requires_capture'; pi.amount_capturable = pi.amount; pi.capture_before = Math.floor(Date.now() / 1000) + this.captureBeforeSecs; }
  allFor(requestId: string) { return [...this.intents.values()].filter((p) => p.metadata.fetch_v2_request_id === requestId); }
  captures(requestId: string) { const pis = new Set(this.allFor(requestId).map((p) => p.id)); return this.calls.filter((c) => c.op === 'capture' && pis.has(c.id!)); }
}
export { StripeDeclined, StripeUnavailable };

// ── fake storage ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export class FakeStorage implements PhotoStorage {
  objects = new Map<string, Uint8Array>();
  tokens = new Map<string, string>();
  async signedUpload(path: string) { const token = randomUUID(); this.tokens.set(token, path); return { url: `https://storage.test/upload?token=${token}`, token }; }
  clientUpload(token: string, b: Uint8Array) { const p = this.tokens.get(token); if (!p) return 'invalid_token'; this.tokens.delete(token); this.objects.set(p, b); return 'ok'; }
  async read(path: string) { return this.objects.get(path) ?? null; }
  async write(path: string, b: Uint8Array) { this.objects.set(path, b); }
  async signedUrl(_path: string, ttl: number) { return `https://storage.test/object/sign/${randomUUID()}?expires_in=${ttl}`; }
  async remove(path: string) { this.objects.delete(path); }
}
const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
const txt = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** A minimal JPEG with GPS EXIF and a comment — the server must strip both before registering it. */
export const JPEG = new Uint8Array([0xff, 0xd8, ...seg(0xe0, txt('JFIF')), ...seg(0xe1, [...txt('Exif'), 0, 0, ...txt('GPS 60.155N 1.145W')]), ...seg(0xfe, txt('12 Hillhead')), 0xff, 0xda, 0, 2, 7, 7, 0xff, 0xd9]);

// ── fake push ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export class FakePush implements PushGateway {
  sent: { user: string; m: PushMessage }[] = [];
  async tokens(userId: string) { return [`ExponentPushToken[${userId.slice(0, 8)}]`]; }
  async send(token: string, m: PushMessage): Promise<PushAttempt> {
    const user = Object.values(ids).find((u) => token.includes(u.slice(0, 8)))!;
    this.sent.push({ user, m }); return { ok: true };
  }
  async prune() { /* nothing to prune */ }
}

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const PLACE = {
  lerwick: { region: 'lerwick', lat: 60.155, lng: -1.145, addr: '1 Example Quay, Lerwick' },
  scalloway: { region: 'scalloway', lat: 60.137, lng: -1.276, addr: '3 Main Street, Scalloway' },
  midyell: { region: 'yell', lat: 60.600, lng: -1.060, addr: 'Example Cottage, Mid Yell' },
  baltasound: { region: 'unst', lat: 60.757, lng: -0.835, addr: 'Example House, Baltasound' },
  brae: { region: 'north-mainland', lat: 60.396, lng: -1.353, addr: '7 Westerloch, Brae' },
} as const;
export type Place = keyof typeof PLACE;
const SETOF = new Set(['fetch_v2_claim_authorisation', 'fetch_v2_release_unpaid_due', 'fetch_v2_payment_work', 'fetch_v2_hold_ready', 'claim_fetch_capture',
  'fetch_v2_claim_notifications', 'fetch_v2_select_recipients', 'fetch_v2_stale_photo_uploads']);

export interface World {
  db: ReplayDb;
  RG: Record<string, string>;
  stripe: FakeStripe; storage: FakeStorage; push: FakePush;
  scalar(sql: string): string;
  asClient(w: Id, stmt: string): string;
  call<T = Record<string, unknown>>(w: Id, fn: string): T;
  svc(fn: string): string;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
  payDeps(): PaymentDeps;
  photoDeps(): PhotoDeps;
  job(who: Id, from: Place, to: Place, o?: Record<string, unknown>): string;
  run(w: Id, from: Place, to: Place): string;
  freshStripe(): void;
  drop(): void;
}

export function createFetchWorld(name: string): World {
  const db = createReplayDb(name);
  const scalar = (sql: string) => lastRow(db.raw(sql));
  const asClient = (w: Id, stmt: string) => db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; ${stmt}; commit;`);
  const call = <T,>(w: Id, fn: string) => JSON.parse(lastRow(asClient(w, `select ${fn}`)) || 'null') as T;
  const svc = (fn: string) => lastRow(db.raw(`begin; set local role service_role; select ${fn}; commit;`));
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
    const sql = SETOF.has(fn) ? `coalesce(jsonb_agg(t), '[]'::jsonb) from public.${fn}(${named}) t` : `to_json(public.${fn}(${named}))`;
    const o = db.raw(`begin; set local role service_role; select ${sql}; commit;`);
    if (/ERROR/.test(o)) return { data: null, error: { message: o } };
    return { data: JSON.parse(lastRow(o)), error: null };
  };
  const RG: Record<string, string> = {};
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'north-mainland', 'yell', 'unst', 'bressay'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    update public.profiles set full_name = 'Morag Example' where id = '${ids.REQ}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug in ('yell','unst','bressay') then slug else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel'), ('furniture', 'Furniture') on conflict do nothing;
    update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience';
    update public.admin_config set value = '1000' where key in ('fetch.notify.opportunity_hourly_max', 'fetch.notify.opportunity_daily_max');`));
  for (const s of slugs) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  for (const w of Object.keys(ids) as Id[]) assert.match(lastRow(asClient(w, `select public.fetch_v2_confirm_adult('fetch-18plus-v1')`)), /"ok": true/);
  const drivers: [Id, string, string, string[]][] = [['D_VAN', 'van', 'bulky', []], ['D_CAR', 'car', 'medium', ['lerwick']], ['D_B', 'van', 'bulky', []], ['D_EXP', 'van', 'bulky', []]];
  for (const [w, cls, max, areas] of drivers) ok(db.raw(`
    insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, vehicle_reg, can_two_person_lift, areas, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled)
    values ('${ids[w]}', 'approved', '${cls}', '${max}', 'ZE1 ${w}', true, array[${areas.map((a) => `'${RG[a]}'::uuid`).join(',')}]::uuid[], 'acct_${w}', true, true);
    insert into public.driver_verification_items (driver_id, kind, status, verified_by, verified_at, expires_at)
    select '${ids[w]}', k, 'verified', '${ids.ADMIN}', now(), case when k in ('licence', 'insurance') then now() + interval '200 days' end
      from unnest(array['identity_check', 'licence', 'vehicle', 'insurance']) k;`));

  const w: World = {
    db, RG, stripe: new FakeStripe(), storage: new FakeStorage(), push: new FakePush(),
    scalar, asClient, call, svc, rpc,
    payDeps: () => ({
      rpc, stripe: w.stripe,
      customerCard: async (userId) => {
        const who = nameOf(userId);
        if (who === 'REQ_NOCUS') return null;
        return { customerId: `cus_${who}`, paymentMethodId: `pm_${who}` };
      },
      driverAccount: async (driverId) => ({ accountId: `acct_${nameOf(driverId)}`, payoutsEnabled: true }),
      isAdmin: async (userId) => userId === ids.ADMIN,
      limit: async () => true,
    }),
    photoDeps: () => ({ rpc, storage: w.storage, limit: async () => true }),
    job: (who, from, to, o = {}) => {
      const a = PLACE[from], b = PLACE[to];
      const p = { idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Box of books', size_class: 'small',
        pickup_region_id: RG[a.region], pickup_name: 'Harbour Furniture', pickup_location: a.addr, pickup_lat: a.lat, pickup_lng: a.lng,
        pickup_notes: 'Ask at the back door', destination_region_id: RG[b.region], destination_address: b.addr, dest_lat: b.lat, dest_lng: b.lng,
        delivery_notes: 'Track past the kirk', contact_phone: '07000 000000', scheduling_mode: 'flexible',
        flexible_until: new Date(Date.now() + 3 * 86400_000).toISOString(), ...o };
      const out = JSON.parse(svc(`public.fetch_v2_create_request('${ids[who]}', ${lit(p)})`));
      assert.equal(out.ok, true, JSON.stringify(out));
      return out.request_id;
    },
    run: (who, from, to) => {
      const d = new Date(Date.now() + 86400_000); d.setUTCHours(9, 0, 0, 0);
      const e = new Date(d.getTime() + 4 * 3600_000);
      const out = call<{ ok: boolean; run_id: string }>(who, `public.fetch_v2_create_run('${RG[PLACE[from].region]}', '${RG[PLACE[to].region]}', '${d.toISOString()}', '${e.toISOString()}', '{}'::text[], null)`);
      assert.equal(out?.ok, true, JSON.stringify(out));
      return out.run_id;
    },
    freshStripe: () => { w.stripe = new FakeStripe(); },
    drop: () => db.drop(),
  };
  return w;
}
