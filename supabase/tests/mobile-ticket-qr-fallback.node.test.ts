/**
 * mobile-ticket-qr-fallback.node.test.ts — a code you can scan, however you bought it.
 *
 * WHAT WAS WRONG
 *
 * A ticket bought in the app keeps its raw_token in SecureStore, and the QR
 * carried that. A ticket bought on the web was never issued to the handset, so
 * the token was not there and never would be — and app/my-event-ticket.tsx said
 * "QR not available", leaving the holder to read an eight-character code aloud
 * at a door. The backup code was already a real credential: the web ticket page
 * has always put exactly it in a QR, and validate-event-ticket already routes a
 * short scanned value to validate_backup_code.
 *
 * WHAT IS ASSERTED
 *   · a raw token, when present, is still what the QR carries
 *   · a valid web-bought ticket falls back to its backup code
 *   · used, refunded, cancelled and pending tickets get NO scannable code —
 *     including one that still has a raw token in SecureStore
 *   · the human-readable backup code stays on screen
 *   · the door accepts both payload shapes, proven against the real routing
 *     function rather than by reading its name
 *
 * SAFETY
 * Reads source and executes the real helpers. No database, no network, no
 * writes, no scan.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREEN = join(REPO_ROOT, 'app/my-event-ticket.tsx');
const SCANNER = join(REPO_ROOT, 'app/event-scanner.tsx');
const EDGE = join(REPO_ROOT, 'supabase/functions/validate-event-ticket/index.ts');

const src = (p: string) => readFileSync(p, 'utf8');
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Slice one function out of a file by name and hand back its source. */
function lift(file: string, decl: string): string {
  const s = src(file);
  const start = s.indexOf(decl);
  assert.notEqual(start, -1, `${decl} is gone from ${file}`);
  const open = s.indexOf('{', s.indexOf(')', start));
  let depth = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `could not find the end of ${decl}`);
  return s.slice(start, end + 1);
}

/** Transpile and run it, so the assertions exercise behaviour, not wording. */
function run<T>(source: string, name: string): T {
  const js = ts.transpileModule(source.replace(/^export /, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)() as T;
}

type Cred = { kind: 'token' | 'backup'; value: string } | null;
const ticketQrCredential = run<(s: string | null, r: string | null, b: string | null) => Cred>(
  lift(SCREEN, 'export function ticketQrCredential('), 'ticketQrCredential',
);
const looksLikeBackupCode = run<(s: string) => boolean>(
  lift(EDGE, 'function looksLikeBackupCode('), 'looksLikeBackupCode',
);

const TOKEN = 'b7c1e0a4f39d4a6e8c2b5d7f1a3e9c4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c';
const BACKUP = 'K7QM-3XPA';

describe('a ticket bought in the app is unchanged', () => {
  test('the raw token is what the QR carries', () => {
    assert.deepEqual(ticketQrCredential('valid', TOKEN, BACKUP), { kind: 'token', value: TOKEN });
  });

  test('the token wins even when a backup code is also present', () => {
    assert.equal(ticketQrCredential('valid', TOKEN, BACKUP)!.kind, 'token');
  });
});

describe('a ticket bought on the web now scans', () => {
  test('no token on this device falls back to the backup code', () => {
    assert.deepEqual(ticketQrCredential('valid', null, BACKUP), { kind: 'backup', value: BACKUP });
  });

  test('the fallback is the code itself, not a rewritten one', () => {
    assert.equal(ticketQrCredential('valid', null, BACKUP)!.value, BACKUP);
  });

  test('a valid ticket with neither credential still offers nothing', () => {
    assert.equal(ticketQrCredential('valid', null, null), null);
  });
});

describe('only a live ticket gets a scannable code', () => {
  for (const status of ['used', 'refunded', 'cancelled', 'pending_payment']) {
    test(`${status}: no QR from a backup code`, () => {
      assert.equal(ticketQrCredential(status, null, BACKUP), null);
    });
    test(`${status}: no QR even with a raw token still in SecureStore`, () => {
      assert.equal(ticketQrCredential(status, TOKEN, BACKUP), null);
    });
  }

  test('an unknown status is not treated as valid', () => {
    assert.equal(ticketQrCredential('something_new', TOKEN, BACKUP), null);
    assert.equal(ticketQrCredential(null, TOKEN, BACKUP), null);
  });
});

describe('the door accepts both payload shapes', () => {
  test('a scanned backup code routes to the backup-code path', () => {
    assert.equal(looksLikeBackupCode(BACKUP), true);
    assert.equal(looksLikeBackupCode('K7QM3XPA'), true, 'a QR without the dash must still route');
  });

  test('a scanned raw token does not', () => {
    assert.equal(looksLikeBackupCode(TOKEN), false);
  });

  test('the boundary is length, and the backup code sits well inside it', () => {
    assert.equal(BACKUP.replace(/[^A-Z0-9]/g, '').length, 8);
    assert.equal(looksLikeBackupCode('A'.repeat(12)), true);
    assert.equal(looksLikeBackupCode('A'.repeat(13)), false);
  });

  test('the scanner still sends whatever it read as raw_token', () => {
    const c = code(SCANNER);
    assert.match(c, /body\.raw_token = rawToken/);
    assert.match(c, /body\.backup_code = backup/);
  });
});

describe('the screen wires the decision in, and keeps the code readable', () => {
  const c = code(SCREEN);

  test('the QR renders from the credential, never from rawToken directly', () => {
    assert.match(c, /value=\{credential\.value\}/);
    assert.doesNotMatch(c, /value=\{rawToken\}/, 'the raw token must not bypass the gate');
    assert.match(c, /const credential\s+= ticketQrCredential\(ticket\.status, rawToken, ticket\.backup_code\)/);
  });

  test('the human-readable backup code is still shown', () => {
    assert.match(c, /styles\.backupCode[^}]*\}>\{ticket\.backup_code\}/);
    assert.match(c, /Backup code/);
  });

  test('a used ticket says so instead of showing a code', () => {
    assert.match(c, /isUsed \? \(\s*<View style=\{styles\.qrPending\}>/);
    assert.match(c, /Already used at entry/);
  });

  test('the backup-code QR says what it carries', () => {
    assert.match(c, /it carries your backup code/);
  });

  test('nothing about SecureStore persistence moved', () => {
    assert.match(c, /SecureStore\.setItemAsync\(ticketTokenKey\(ticketId\), rawToken\)/);
    assert.match(c, /SecureStore\.getItemAsync\(ticketTokenKey\(id\)\)/);
  });
});
