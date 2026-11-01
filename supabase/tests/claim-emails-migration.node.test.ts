/**
 * claim-emails-migration.node.test.ts — migration 20261203000000 on an ISOLATED Postgres: four templates added, re-runnable, nothing else touched.
 * ISOLATED DATABASE ONLY.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSN = process.env.PASS_PROOF_DSN ?? '', PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only): run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');
const MIG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '20261203000000_business_claim_emails.sql'), 'utf8');
const file = (q: string) => execFileSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8' });
const sql = (q: string) => execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();

before(() => file(`drop schema if exists public cascade; create schema public;
  create table public.email_templates (id uuid primary key default gen_random_uuid(), key text unique not null, category text not null, label text not null, description text, enabled boolean not null default true,
    subject text not null, body_html text not null, body_text text, variables text[] not null default '{}', requires_optin boolean not null default false, postmark_stream text default 'outbound', created_at timestamptz default now(), updated_at timestamptz default now());
  insert into public.email_templates (key, category, label, subject, body_html) values ('account.business_approved','account','Business listing approved','Your business is now verified','<h2>old</h2>'), ('local.booking_confirmed','local','Booking','b','<p>b</p>');`));

test('adds the four templates, enabled, on the outbound stream; existing templates are untouched; re-running changes nothing', () => {
  const before = sql(`select md5(string_agg(t::text, '|' order by key)) from public.email_templates t where key in ('account.business_approved','local.booking_confirmed')`);
  file(MIG);
  assert.equal(sql(`select string_agg(key, ',' order by key) from public.email_templates where key like 'business.claim_%' or key = 'admin.business_claim_received'`), 'admin.business_claim_received,business.claim_approved,business.claim_received,business.claim_rejected');
  assert.equal(sql(`select count(*) from public.email_templates where key in ('business.claim_received','business.claim_approved','business.claim_rejected','admin.business_claim_received') and enabled and postmark_stream = 'outbound' and not requires_optin`), '4');
  assert.equal(sql(`select md5(string_agg(t::text, '|' order by key)) from public.email_templates t where key in ('account.business_approved','local.booking_confirmed')`), before);
  const snap = sql(`select md5(string_agg(t::text, '|' order by key)) from public.email_templates t`);
  file(MIG); assert.equal(sql(`select md5(string_agg(t::text, '|' order by key)) from public.email_templates t`), snap); assert.equal(sql(`select count(*) from public.email_templates`), '6');
});
