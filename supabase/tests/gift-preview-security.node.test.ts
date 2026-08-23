/**
 * gift-preview-security.node.test.ts — the /g/<code> bearer link.
 *
 * WHAT WAS WRONG
 *
 * Both clients previewed a gift BEFORE authentication and said so in their own
 * comments — the app's screen: "Public preview — runs even when not signed in,
 * so the user can see what they're about to claim before being asked to log
 * in." But book_gifts has no public SELECT policy: its three policies are
 * purchaser, claimer and business owner, all authenticated. The preview
 * returned nothing to the one visitor it was written for. Not a Step 8
 * regression — it had never worked.
 *
 * The tempting repair, a public SELECT policy on book_gifts, would have let
 * anyone list every gift, purchaser name and private message. The access rule
 * is possession of the code, and a row policy cannot say that without also
 * permitting `select *`.
 *
 * Worse, the code was not fit to be a credential. generate_gift_code() drew 8
 * characters from a 31-character alphabet using random() — Postgres's
 * non-cryptographic PRNG — for ~39.6 bits. Production held ZERO gifts, so it
 * could be replaced outright with no legacy codes to keep working.
 *
 * WHAT IS ASSERTED
 *   · the code is a real credential: pgcrypto, rejection-sampled, 14 chars
 *   · only the server can mint one
 *   · book_gifts stays unreadable to anon, and this migration touches no policy
 *   · the preview returns a whitelist — no id, no purchaser/recipient identity,
 *     no payment field — and at most one row
 *   · an invalid or partial code yields nothing
 *   · previewing is not claiming: claim_gift needs auth.uid()
 *   · two simultaneous claims cannot both win
 *   · the gift code survives the sign-in round trip on both clients
 *   · the purchaser's and business's own views are untouched
 *
 * The live half runs as anon against production and needs no gift to exist —
 * it exercises the refusals. The positive path was verified separately against
 * a disposable gift that was created, exercised and deleted.
 *
 * SAFETY
 * Read-only. Anonymous requests only. No writes, no payment, no gift created.
 * No gift code is ever printed.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const migration = read('supabase/migrations/20260823200000_public_gift_preview.sql');
const baseline = read('supabase/migrations/20260623000000_baseline_remote_schema.sql');
const mobileScreen = read('app/g/[code].tsx');
const webLib = web('lib/passes-data.ts');
const webClient = web('app/g/[code]/GiftClaimClient.tsx');

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled by the null return */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();
const skip = cfg ? false : 'no anon config (.env)';

async function anon(path: string, init?: RequestInit) {
  const res = await fetch(`${cfg!.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

/* ── 1. The code is a credential ──────────────────────────────────────────── */

describe('the gift code is strong enough to be the only thing guarding a gift', () => {
  test('it is drawn from pgcrypto, not random()', () => {
    const fn = migration.match(/create or replace function public\.generate_gift_code[\s\S]*?\$\$;/)?.[0] ?? '';
    assert.ok(fn.length > 0, 'generator not found');
    assert.match(fn, /extensions\.gen_random_bytes\(1\)/);
    assert.ok(!/random\(\)/.test(fn), 'the generator still uses the non-cryptographic random()');
  });

  test('rejection sampling, so the alphabet is not biased', () => {
    const fn = migration.match(/create or replace function public\.generate_gift_code[\s\S]*?\$\$;/)?.[0] ?? '';
    assert.match(fn, /limit_\s+constant int\s+:=\s*248/);
    assert.match(fn, /if b < limit_ then/);
  });

  test('14 characters of a 31-character alphabet — about 69 bits', () => {
    const fn = migration.match(/create or replace function public\.generate_gift_code[\s\S]*?\$\$;/)?.[0] ?? '';
    const len = Number(fn.match(/len\s+constant int\s+:=\s*(\d+)/)?.[1]);
    const alphabet = fn.match(/alphabet constant text := '([^']+)'/)?.[1] ?? '';
    assert.equal(alphabet.length, 31);
    assert.ok(len >= 12, `gift code length ${len} is too short for a bearer token`);
    const bits = len * Math.log2(alphabet.length);
    assert.ok(bits >= 64, `gift code entropy is only ${bits.toFixed(1)} bits`);
  });

  test('the alphabet still avoids the ambiguous characters', () => {
    const alphabet = migration.match(/alphabet constant text := '([^']+)'/)?.[1] ?? '';
    for (const ch of ['I', 'L', 'O', '0', '1']) {
      assert.ok(!alphabet.includes(ch), `${ch} is too easy to mistype`);
    }
  });

  test('only the server can mint a code', () => {
    assert.match(migration, /revoke all on function public\.generate_gift_code\(\) from public, anon, authenticated;/);
    assert.match(migration, /grant execute on function public\.generate_gift_code\(\) to service_role;/);
  });
});

describe('minting a code is refused to the public', { skip }, () => {
  test('anon cannot call generate_gift_code', async () => {
    const r = await anon('rpc/generate_gift_code', { method: 'POST', body: '{}' });
    assert.notEqual(r.status, 200, 'anon was allowed to mint a gift code');
  });
});

/* ── 2. The table stays shut ──────────────────────────────────────────────── */

describe('book_gifts is not opened up', () => {
  test('the migration contains no policy DDL whatsoever', () => {
    // Prose in the header explains why a book_gifts policy is the WRONG fix, so
    // this looks for statements rather than for the word appearing anywhere.
    const ddl = migration.replace(/^\s*--.*$/gm, '');
    assert.ok(!/\b(create|drop|alter)\s+policy\b/i.test(ddl), 'this migration touches an RLS policy');
    assert.ok(!/\bgrant\b[^;]*\bon\s+(table\s+)?public\.book_gifts/i.test(ddl), 'this migration grants on book_gifts');
  });

  test('the only SELECT policies on book_gifts remain the authenticated three', () => {
    const policies = [...baseline.matchAll(/CREATE POLICY "([^"]+)" ON public\.book_gifts FOR SELECT/g)].map((m) => m[1]);
    assert.equal(policies.length, 3);
    for (const p of policies) assert.match(p, /gifts/i);
  });
});

describe('anon still cannot read the table', { skip }, () => {
  test('a direct read of book_gifts is refused', async () => {
    const r = await anon('book_gifts?select=code&limit=1');
    assert.notEqual(r.status, 200, 'anon can read book_gifts directly');
  });

  test('and cannot reach it through a nested select either', async () => {
    const r = await anon('book_unit_purchases?select=id,gift:book_gifts(code)&limit=1');
    assert.notEqual(r.status, 200);
  });
});

/* ── 3. The preview says only what it must ────────────────────────────────── */

describe('the preview is a whitelist', () => {
  const fn = migration.match(/create or replace function public\.get_public_gift_preview[\s\S]*?\$\$;/)?.[0] ?? '';

  test('the return signature is exactly the seven safe fields', () => {
    const sig = fn.match(/returns table \(([\s\S]*?)\)\s*\n\s*language/)?.[1] ?? '';
    const cols = [...sig.matchAll(/^\s*(\w+)\s+/gm)].map((m) => m[1]);
    assert.deepEqual(
      cols.sort(),
      ['business_name', 'expires_at', 'item_name', 'kind', 'message', 'purchaser_name', 'status'].sort(),
    );
  });

  test('no identifier or payment field can be returned', () => {
    const sig = fn.match(/returns table \(([\s\S]*?)\)\s*\n\s*language/)?.[1] ?? '';
    for (const banned of [
      'id', 'business_id', 'unit_item_id', 'service_id', 'purchaser_id',
      'recipient_email', 'recipient_name', 'payment_intent_id',
      'price_paid_pence', 'claimed_by_user_id',
    ]) {
      assert.ok(!new RegExp(`\\b${banned}\\b`).test(sig), `the preview can return ${banned}`);
    }
  });

  test('it returns at most one gift, on an exact full-length code', () => {
    assert.match(fn, /limit 1;/);
    assert.match(fn, /g\.code = p_code/);
    assert.match(fn, /length\(p_code\) >= 8/);
    assert.ok(!/like|ilike|similar to/i.test(fn), 'a pattern match would allow prefix enumeration');
  });

  test('an unpaid gift is not previewable', () => {
    assert.match(fn, /g\.status <> 'pending_payment'/);
  });

  test('it is SECURITY DEFINER with a pinned search_path, and revoked from PUBLIC', () => {
    assert.match(fn, /security definer/);
    assert.match(fn, /set search_path = public, pg_temp/);
    assert.match(migration, /revoke all on function public\.get_public_gift_preview\(text\) from public;/);
    assert.match(migration, /grant execute on function public\.get_public_gift_preview\(text\) to anon, authenticated, service_role;/);
  });

  test('it takes no caller-supplied identity — only the code', () => {
    assert.match(fn, /get_public_gift_preview\(p_code text\)/);
    assert.ok(!/auth\.uid\(\)|p_user/.test(fn), 'the preview should not involve a user identity at all');
  });
});

describe('the preview refuses what it should', { skip }, () => {
  test('an unknown code returns no gift', async () => {
    const r = await anon('rpc/get_public_gift_preview?p_code=ZZZZZZZZZZZZZZ');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('a short probe returns no gift', async () => {
    const r = await anon('rpc/get_public_gift_preview?p_code=ABCD');
    assert.deepEqual(r.body, []);
  });

  test('an empty code returns no gift', async () => {
    const r = await anon('rpc/get_public_gift_preview?p_code=');
    assert.deepEqual(r.body, []);
  });

  test('it cannot be turned into a listing', async () => {
    // No filter, and a PostgREST-style filter on the result — neither yields rows.
    for (const p of [
      'rpc/get_public_gift_preview',
      'rpc/get_public_gift_preview?p_code=ZZZZZZZZZZZZZZ&limit=1000',
      'rpc/get_public_gift_preview?p_code=ZZZZZZZZZZZZZZ&status=neq.nothing',
    ]) {
      const r = await anon(p);
      const rows = Array.isArray(r.body) ? r.body : [];
      assert.equal(rows.length, 0, `${p} returned ${rows.length} gift(s)`);
    }
  });
});

/* ── 4. Previewing is not claiming ────────────────────────────────────────── */

describe('claiming stays authenticated and atomic', () => {
  const claim = baseline.match(/CREATE FUNCTION public\.claim_gift\(p_code text\)[\s\S]*?\n\$\$;/)?.[0] ?? '';

  test('claim_gift refuses a caller with no auth.uid()', () => {
    assert.match(claim, /v_user_id\s+UUID := auth\.uid\(\);/);
    assert.match(claim, /IF v_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'auth_required';/);
  });

  test('ownership binds to auth.uid(), never to anything the caller passes', () => {
    assert.match(claim, /claimed_by_user_id = v_user_id/);
    assert.equal(claim.match(/claim_gift\(p_code text\)/g)?.length, 1, 'claim_gift should take only the code');
  });

  test('the row is locked, so two simultaneous claims cannot both win', () => {
    assert.match(claim, /SELECT \* INTO v_gift FROM public\.book_gifts WHERE code = p_code FOR UPDATE;/);
    assert.match(claim, /v_gift\.claimed_by_user_id IS NOT NULL[\s\S]*?RAISE EXCEPTION 'gift_already_claimed'/);
  });

  test('unpaid, cancelled and expired gifts are refused by name', () => {
    for (const e of ['gift_not_paid', 'gift_cancelled', 'gift_expired', 'gift_not_found']) {
      assert.ok(claim.includes(e), `claim_gift does not handle ${e}`);
    }
  });
});

describe('a signed-out visitor cannot claim', { skip }, () => {
  test('claim_gift as anon is refused before anything is looked up', async () => {
    const r = await anon('rpc/claim_gift', { method: 'POST', body: JSON.stringify({ p_code: 'ZZZZZZZZZZZZZZ' }) });
    assert.notEqual(r.status, 200);
    const msg = JSON.stringify(r.body);
    assert.match(msg, /auth_required/);
    // The refusal must not disclose whether that code exists.
    assert.ok(!/gift_not_found/.test(msg), 'the anonymous refusal leaks whether the gift exists');
  });
});

/* ── 5. Both clients use the safe interface ───────────────────────────────── */

describe('the clients preview through the RPC, not the table', () => {
  test('web calls get_public_gift_preview', () => {
    const fn = webLib.match(/export async function fetchGiftPreview[\s\S]*?\n}/)?.[0] ?? '';
    assert.match(fn, /rpc\("get_public_gift_preview", \{ p_code: code \}\)/);
    assert.ok(!/from\("book_gifts"\)/.test(fn), 'web still reads book_gifts for the preview');
  });

  test('the app calls it too', () => {
    assert.match(mobileScreen, /rpc\('get_public_gift_preview', \{ p_code: code \}\)/);
    assert.ok(!/\.from\('book_gifts'\)/.test(mobileScreen), 'the app still reads book_gifts for the preview');
  });

  test('neither preview type carries an internal id any more', () => {
    for (const [name, src] of [['web', webLib], ['app', mobileScreen]] as const) {
      const iface = src.match(/interface GiftPreview \{[\s\S]*?\n\}/)?.[0] ?? '';
      assert.ok(iface.length > 0, `${name} GiftPreview not found`);
      for (const banned of ['business_id', 'unit_item_id', 'service_id', 'purchaser_id']) {
        assert.ok(!iface.includes(banned), `${name} preview still carries ${banned}`);
      }
      assert.ok(!/^\s*id:/m.test(iface), `${name} preview still carries id`);
    }
  });

  test('the app gets the gift id from the claim result instead', () => {
    assert.match(mobileScreen, /giftId:\s*result\.gift_id/);
  });

  test('a failed preview is logged rather than silently empty', () => {
    assert.match(webLib, /\[gift-preview\] lookup failed/);
    assert.match(mobileScreen, /\[gift-preview\] lookup failed/);
  });
});

describe('the gift code survives the sign-in round trip', () => {
  test('web sends the visitor back to the same gift link', () => {
    assert.match(webClient, /const signInHref = `\/sign-in\?next=\$\{encodeURIComponent\(`\/g\/\$\{code\}`\)\}`/);
  });

  test('the app returns to the same screen after sign-in', () => {
    assert.match(mobileScreen, /const goToSignIn = useGoToSignIn\(\)/);
    assert.match(mobileScreen, /goToSignIn\(\)/);
    // useGoToSignIn defaults `next` to the current pathname — /g/<code>.
    assert.match(read('hooks/useGoToSignIn.ts'), /params: \{ next: next \?\? pathname \}/);
  });
});

/* ── 6. Nothing else moved ────────────────────────────────────────────────── */

describe('the purchaser and business views are untouched', () => {
  test('the authenticated "my gifts" read still goes to the table', () => {
    assert.match(webLib, /from\("book_gifts"\)/);
    assert.match(webLib, /claimed_by_user_id/);
  });

  test('the migration changes exactly two functions and no table', () => {
    const created = [...migration.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(created.sort(), ['generate_gift_code', 'get_public_gift_preview']);
    assert.ok(!/alter table|drop table|create table/i.test(migration));
  });
});
