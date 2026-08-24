/**
 * gift-recipient-verification.node.test.ts — the right person, the right account.
 *
 * WHAT WAS WRONG
 *
 * claim_gift() never checked WHO was claiming. Any signed-in person holding the
 * code could take the gift — a forwarded link transferred ownership.
 *
 * The obvious repair is worse than the bug: requiring
 * auth.users.email = book_gifts.recipient_email would make a gift sent to
 * john.work@gmail.com unclaimable by John's existing account at
 * john@hotmail.com, and the only way through would be a SECOND OneShetland
 * account. Duplicate accounts, split history, split wallet.
 *
 * SO THE TWO FACTS ARE SEPARATED
 *
 *   the recipient EMAIL   proves control of the address it was sent to
 *   the OneShetland ACCOUNT decides which account ends up owning it
 *
 * recipient_email never becomes a login. A gift is claimable when the caller's
 * CONFIRMED auth email already matches, or when they pass a one-time challenge
 * emailed to that address — bound to that gift and that auth.uid(), and to
 * nothing else.
 *
 * WHAT IS ASSERTED
 *   · claim is gated on auth.uid() AND the recipient rule, at the database
 *   · the token-issuing function is service_role only — it returns the secret
 *   · the verification table has RLS and NOT ONE policy
 *   · proof binds to (gift, user), is single use, expires, and locks out
 *   · a wrong guess actually increments the counter (it did not, at first)
 *   · nothing anywhere answers "does this email have an account?"
 *   · the identity a client sends is never trusted
 *   · preview, sent/received classification and payment are untouched
 *
 * The live behaviour — including the different-email journey creating NO second
 * account — was exercised against production with disposable accounts and
 * gifts, all removed afterwards.
 *
 * SAFETY
 * Source inspection only. No network, no database, no payment, no email.
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

const mig = read('supabase/migrations/20260824100000_gift_recipient_verification.sql');
const migFix = read('supabase/migrations/20260824110000_gift_verification_attempts_persist.sql');
const fnSrc = read('supabase/functions/verify-gift-recipient/index.ts');
const appScreen = read('app/g/[code].tsx');
const appLib = read('lib/local-api.ts');
const webClient = web('app/g/[code]/GiftClaimClient.tsx');
const webLib = web('lib/local-commerce-client.ts');

const sqlFn = (src: string, name: string) =>
  src.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\n\\$\\$;`))?.[0] ?? '';

/* ── 1. The claim gate ────────────────────────────────────────────────────── */

describe('claiming is gated at the database, on identity it controls', () => {
  const claim = sqlFn(mig, 'claim_gift');

  test('auth.uid() is still required', () => {
    assert.match(claim, /v_user_id\s+UUID := auth\.uid\(\);/);
    assert.match(claim, /IF v_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'auth_required';/);
  });

  test('and the recipient rule now guards a first-time claim', () => {
    assert.match(claim, /NOT public\.gift_recipient_ok\(v_gift\.id, v_user_id\)/);
    assert.match(claim, /RAISE EXCEPTION 'gift_recipient_verification_required'/);
  });

  test('re-claiming your own gift is not blocked by the gate', () => {
    assert.match(claim, /IF v_gift\.claimed_by_user_id IS NULL\s*\n\s*AND NOT public\.gift_recipient_ok/);
  });

  test('concurrency and the existing state checks survive', () => {
    assert.match(claim, /WHERE code = p_code FOR UPDATE/);
    for (const e of ['gift_not_found', 'gift_not_paid', 'gift_cancelled', 'gift_expired', 'gift_already_claimed']) {
      assert.ok(claim.includes(e), `claim_gift lost ${e}`);
    }
  });

  test('claim_gift takes only the code — no caller-supplied identity', () => {
    assert.match(mig, /create or replace function public\.claim_gift\(p_code text\)/);
    assert.ok(!/claim_gift\([^)]*email/i.test(mig), 'claim_gift accepts an email from the caller');
  });
});

describe('the recipient rule itself', () => {
  const ok = sqlFn(mig, 'gift_recipient_ok');

  test('the matching-email path reads the CONFIRMED auth address', () => {
    assert.match(ok, /from auth\.users u/);
    assert.match(ok, /u\.email_confirmed_at is not null/);
  });

  test('comparison is case- and whitespace-insensitive', () => {
    assert.match(ok, /lower\(btrim\(recipient_email\)\)/);
    assert.match(ok, /lower\(btrim\(u\.email\)\)/);
  });

  test('otherwise it needs a consumed challenge for THIS gift and THIS user', () => {
    assert.match(ok, /v\.gift_id = p_gift/);
    assert.match(ok, /v\.user_id = p_user/);
    assert.match(ok, /v\.consumed_at is not null/);
    // and for the address that gift was actually sent to
    assert.match(ok, /v\.email = v_recipient/);
  });

  test('a gift with no recipient address fails closed', () => {
    assert.match(ok, /if v_recipient is null or v_recipient = ''\s*then\s*[\s\S]*?return false;/);
  });

  test('it is not reachable by any client role', () => {
    assert.match(mig, /revoke all on function public\.gift_recipient_ok\(uuid, uuid\) from public, anon, authenticated;/);
  });
});

/* ── 2. The secret stays secret ───────────────────────────────────────────── */

describe('only the server can mint a challenge', () => {
  test('the issuing function returns the plaintext token', () => {
    assert.match(sqlFn(mig, 'issue_gift_recipient_challenge'), /'token',\s+v_token/);
  });

  test('so it is service_role only — never anon, never authenticated', () => {
    assert.match(mig, /revoke all on function public\.issue_gift_recipient_challenge\(text, uuid\) from public, anon, authenticated;/);
    assert.match(mig, /grant execute on function public\.issue_gift_recipient_challenge\(text, uuid\) to service_role;/);
  });

  test('the edge function derives the user from a verified JWT, not the body', () => {
    assert.match(fnSrc, /auth\.getUser\(\)/);
    assert.match(fnSrc, /p_user: user\.id/);
    assert.ok(!/p_user:\s*body\./.test(fnSrc), 'the edge function trusts a body-supplied identity');
  });

  test('and never returns the token to the caller', () => {
    const resp = fnSrc.match(/return json\(\{\s*ok: true[\s\S]*?\}\);/)?.[0] ?? '';
    assert.ok(resp.length > 0, 'success response not found');
    assert.ok(!/token/.test(resp), 'the edge function hands the token back to the client');
  });
});

describe('the challenge table is server-only', () => {
  test('RLS is on and no policy exists', () => {
    assert.match(mig, /alter table public\.gift_recipient_verifications enable row level security;/);
    assert.ok(!/create policy[\s\S]*gift_recipient_verifications/i.test(mig.replace(/^\s*--.*$/gm, '')));
    assert.match(mig, /revoke all on table public\.gift_recipient_verifications from anon, authenticated;/);
  });

  test('the token is stored hashed, never in plain text', () => {
    const issue = sqlFn(mig, 'issue_gift_recipient_challenge');
    assert.match(issue, /encode\(extensions\.digest\(v_token, 'sha256'\), 'hex'\)/);
    assert.ok(!/values\s*\([^)]*v_token[^)]*\)\s*;/.test(issue.replace(/encode\([^)]*\)/g, '')),
      'the plaintext token is inserted');
  });

  test('the token is drawn from pgcrypto with rejection sampling', () => {
    const issue = sqlFn(mig, 'issue_gift_recipient_challenge');
    assert.match(issue, /extensions\.gen_random_bytes\(1\)/);
    assert.match(issue, /limit_\s+constant int\s+:=\s*248/);
    assert.ok(!/random\(\)/.test(issue));
  });
});

/* ── 3. Binding, expiry, single use, lock ─────────────────────────────────── */

describe('a proof is good for one gift, one account, one time', () => {
  const confirm = sqlFn(migFix, 'confirm_gift_recipient_verification');

  test('it binds to auth.uid(), which the client cannot forge', () => {
    assert.match(confirm, /v_user uuid := auth\.uid\(\);/);
    assert.match(confirm, /user_id = v_user/);
    assert.match(migFix, /confirm_gift_recipient_verification\(p_code text, p_token text\)/);
  });

  test('it binds to the exact gift', () => {
    assert.match(confirm, /where gift_id = v_gift and user_id = v_user/);
  });

  test('single use — only an unconsumed row is eligible, and it is locked', () => {
    assert.match(confirm, /consumed_at is null/);
    assert.match(confirm, /for update/);
    assert.match(confirm, /set consumed_at = now\(\)/);
  });

  test('it expires', () => {
    assert.match(sqlFn(mig, 'issue_gift_recipient_challenge'), /now\(\) \+ interval '15 minutes'/);
    assert.match(confirm, /v_row\.expires_at < now\(\)/);
  });

  test('a wrong guess RETURNS rather than raises, so the counter survives', () => {
    // The original raised, which rolled the increment back and made the lock
    // decorative. This is the regression guard for that.
    assert.match(confirm, /update public\.gift_recipient_verifications\s*\n\s*set attempts = attempts \+ 1/);
    const wrongBranch = confirm.match(/if p_token is null[\s\S]*?end if;/)?.[0] ?? '';
    assert.ok(wrongBranch.length > 0, 'wrong-token branch not found');
    assert.ok(!/raise exception/i.test(wrongBranch), 'a wrong guess still raises, so attempts roll back');
    assert.match(wrongBranch, /return jsonb_build_object/);
  });

  test('five wrong answers lock it, and the right code no longer helps', () => {
    assert.match(confirm, /max_attempts constant int := 5;/);
    assert.match(confirm, /if v_row\.attempts >= max_attempts then[\s\S]*?'verification_locked'/);
  });

  test('a fresh challenge retires the previous one', () => {
    assert.match(sqlFn(mig, 'issue_gift_recipient_challenge'),
      /delete from public\.gift_recipient_verifications\s*\n\s*where gift_id = v_gift\.id and user_id = p_user and consumed_at is null;/);
  });
});

/* ── 4. No account enumeration ────────────────────────────────────────────── */

describe('nothing reveals whether an address has an account', () => {
  const sources: [string, string][] = [
    ['migration', mig], ['fix', migFix], ['edge function', fnSrc],
    ['web lib', webLib], ['web page', webClient], ['app lib', appLib], ['app screen', appScreen],
  ];

  test('no lookup-user-by-email surface is added anywhere', () => {
    for (const [name, src] of sources) {
      for (const bad of ['user_exists', 'account_exists', 'find_user_by_email', 'lookup_user', 'has_account']) {
        assert.ok(!src.includes(bad), `${name} exposes ${bad}`);
      }
    }
  });

  test('the eligibility answer never mentions an account', () => {
    const e = sqlFn(mig, 'gift_claim_eligibility');
    const states = [...e.matchAll(/v_state := '([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(states.length >= 6, `expected the full state set, got ${states.join(',')}`);
    for (const s of states) {
      assert.ok(!/account|user|exists|email_taken/.test(s), `state "${s}" leaks account information`);
    }
  });

  test('only a MASKED address is ever returned', () => {
    for (const f of ['gift_claim_eligibility', 'issue_gift_recipient_challenge']) {
      assert.match(sqlFn(mig, f), /repeat\('•'/, `${f} does not mask the address`);
    }
    // The eligibility RPC — the one clients may call — returns masked only.
    const e = sqlFn(mig, 'gift_claim_eligibility');
    assert.match(e, /'masked_email', v_masked/);
    assert.ok(!/'recipient_email'/.test(e), 'eligibility returns the full address');
  });

  test('neither client renders a full recipient address', () => {
    for (const [name, src] of [['web', webClient], ['app', appScreen]] as const) {
      assert.match(src, /masked_email/, `${name} does not use the masked address`);
      // gift_has_no_recipient_email is an error CODE, not an address.
      const rendered = src.replace(/gift_has_no_recipient_email/g, '');
      assert.ok(!/recipient_email/.test(rendered), `${name} renders the full recipient address`);
    }
  });
});

/* ── 5. The journeys the UI has to offer ──────────────────────────────────── */

describe('both clients offer the three signed-in shapes', () => {
  for (const [name, src] of [['web', webClient], ['app', appScreen]] as const) {
    test(`${name} asks the database which shape to show`, () => {
      assert.match(src, /fetchGiftEligibility/);
    });

    test(`${name} offers verification when the emails differ`, () => {
      assert.match(src, /verification_required/);
      assert.match(src, /[Vv]erify recipient email/);
    });

    test(`${name} also offers switching account`, () => {
      assert.match(src, /switch account/i);
    });

    test(`${name} promises no second account`, () => {
      assert.match(src, /second account/i);
    });

    test(`${name} keeps the gift code across sign-in`, () => {
      if (name === 'web') assert.match(src, /\/sign-in\?next=\$\{encodeURIComponent\(`\/g\/\$\{code\}`\)\}/);
      else assert.match(src, /goToSignIn\(\)/);
    });
  }

  test('the signed-out page invites creating an account too', () => {
    assert.match(webClient, /Sign in or create an account/);
  });
});

/* ── 6. Nothing else moved ────────────────────────────────────────────────── */

describe('the surrounding gift system is untouched', () => {
  test('no client-callable function returns the full address or a payment field', () => {
    // issue_gift_recipient_challenge DOES return recipient_email — it has to,
    // something must address the email — but it is service_role only, which is
    // asserted above. These three are the ones a client can actually call.
    for (const name of ['gift_claim_eligibility', 'confirm_gift_recipient_verification', 'claim_gift']) {
      const body = sqlFn(mig, name) || sqlFn(migFix, name);
      assert.ok(body.length > 0, `${name} not found`);
      for (const banned of ['recipient_email', 'payment_intent_id']) {
        assert.ok(!body.includes(`'${banned}'`), `${name} returns ${banned}`);
      }
    }
  });

  test('sent/received classification is not touched', () => {
    for (const src of [mig, migFix]) {
      assert.ok(!/claimed_by_user_id\s*=\s*auth\.uid\(\)/.test(src.replace(/^\s*--.*$/gm, '')),
        'a migration redefines the received rule');
    }
  });

  test('no Stripe or payment object appears in any of this', () => {
    // claim_gift is carried over verbatim and legitimately copies
    // price_paid_pence into the unit purchase it spawns; that is the existing
    // behaviour being PRESERVED. The check is that nothing NEW touches payment.
    const newOnly = [
      ['gift_recipient_ok', sqlFn(mig, 'gift_recipient_ok')],
      ['issue_gift_recipient_challenge', sqlFn(mig, 'issue_gift_recipient_challenge')],
      ['gift_claim_eligibility', sqlFn(mig, 'gift_claim_eligibility')],
      ['confirm_gift_recipient_verification', sqlFn(migFix, 'confirm_gift_recipient_verification')],
      ['edge function', fnSrc],
    ] as const;
    for (const [name, src] of newOnly) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(--|\/\/|\*).*$/gm, '');
      for (const b of ['stripe', 'payment_intent', 'price_paid']) {
        assert.ok(!code.toLowerCase().includes(b), `${name} touches ${b}`);
      }
    }
    // And claim_gift's payment surface is unchanged from what it always did.
    assert.match(sqlFn(mig, 'claim_gift'), /v_gift\.price_paid_pence/);
  });

  test('the challenge has abuse ceilings of its own', () => {
    assert.match(mig, /'gift_verify_send'/);
    assert.match(mig, /'gift_verify_any'/);
    assert.match(fnSrc, /enforceRateLimit\(\s*\n?\s*'verify-gift-recipient'/);
  });
});
