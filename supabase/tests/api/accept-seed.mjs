// accept-seed.mjs — creates the FICTIONAL accounts for the acceptance backend through the real GoTrue sign-up, then gives them their roles/ownership in the
// database (this is set-up, done as the database owner, exactly like a migration; every test action afterwards is made as the user, with their own JWT and RLS).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const URL_ = process.env.ACCEPT_URL ?? 'http://127.0.0.1:54800', ANON = process.env.ACCEPT_ANON;
if (!ANON) { console.error('ACCEPT_ANON (the anon key printed by accept-env.sh) is required'); process.exit(1); }
const PW = 'Accept-Test-1';
const USERS = [
  ['member', 'Morag Member'], ['member2', 'Magnus Member'], ['hubowner', 'Hamish Hall'], ['bizowner', 'Bella Baker'], ['official', 'Olive Official'],
  ['unverified', 'Una Unverified'], ['moderator', 'Moira Moderator'], ['admin', 'Ada Admin'], ['funeralrep', 'Fraser Funeral'],
];
const sql = (q) => execFileSync('docker', ['exec', '-i', 'notices-accept-pg', 'psql', '-U', 'postgres', '-h', 'localhost', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
const ids = {};
for (const [k, name] of USERS) {
  const email = `${k}@accept.test`;
  const r = await fetch(`${URL_}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW, data: { full_name: name } }) });
  const j = await r.json();
  if (!r.ok) { // already exists: sign in instead
    const s = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).json();
    if (!s.user) throw new Error(`${k}: ${JSON.stringify(j)}`); ids[k] = s.user.id;
  } else ids[k] = (j.user ?? j).id;
}
const role = { moderator: 'moderator', admin: 'admin' };
for (const [k, name] of USERS) sql(`insert into profiles (id, role, display_name, full_name, onboarding_completed_at) values ('${ids[k]}', '${role[k] ?? 'customer'}', '${name}', '${name}', now()) on conflict (id) do update set role=excluded.role, display_name=excluded.display_name, full_name=excluded.full_name, onboarding_completed_at=coalesce(profiles.onboarding_completed_at, now())`);
// a hub and a business, owned by the fictional hub owner / business owner; the hub owner is a hub admin through the real ownership trigger
sql(`insert into hubs (id, owner_id, name, slug) values ('aaaaaaaa-0000-4000-8000-000000000001','${ids.hubowner}','ZZ Test Community Hall','zz-test-hall') on conflict do nothing`);
sql(`insert into local_businesses (id, owner_id, name, slug) values ('bbbbbbbb-0000-4000-8000-000000000001','${ids.bizowner}','ZZ Test Bakery','zz-test-bakery') on conflict do nothing`);
sql(`insert into hub_members (hub_id, user_id, role) values ('aaaaaaaa-0000-4000-8000-000000000001','${ids.member}','member') on conflict do nothing`);
writeFileSync('/tmp/accept-users.json', JSON.stringify({ password: PW, ids, hub: 'aaaaaaaa-0000-4000-8000-000000000001', business: 'bbbbbbbb-0000-4000-8000-000000000001' }, null, 2));
console.log(JSON.stringify(ids, null, 1));
