/**
 * editions-branding.node.test.ts — ISOLATED Postgres only. R6: the cover focus point on organisers and Editions.
 * Run: ISOLATED_ONLY=editions-branding npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Env, USERS, seed, enter, last } from './_support/editions-env.ts';

// ORG = the Hub's owner (an organiser admin through the Hub); OTHER = a stranger; EDITOR = an invited helper
const KEY = { ADMIN: 'ADMIN', ORG: 'HUB_OWNER', OTHER: 'STRANGER', EDITOR: 'EDITOR' } as const;
type Who = keyof typeof KEY | 'anon';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates/im.test(o);
let E: Env; let ORG = '', ED = '';
const run = (w: Who, sql: string, commit = false) => (w === 'anon' ? E.db.raw(`begin; set local role anon; ${sql}; rollback;`) : commit ? E.do(KEY[w], sql) : E.try(KEY[w], sql));
const q = (sql: string) => E.q(sql);
const db = { raw: (sql: string) => E.sup(sql) };

before(() => {
  E = new Env('editionsbranding');
  const S = seed(E);
  ORG = enter(E, 'HUB_OWNER', 'hub', S.HUB);
  E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${USERS.EDITOR}','editor') on conflict do nothing`);
  ED = last(run('ORG', `insert into public.editions (organiser_id, slug, title, kind, starts_on, ends_on, cover_focus) values ('${ORG}','zz-brand-fest','ZZ Brand Fest','multi_day',current_date+10,current_date+12,'30% 20%') returning id`, true));
});
after(() => E?.drop());

describe('cover focus point', () => {
  test('the columns exist, are nullable and default to null', () => {
    assert.equal(q(`select count(*) from information_schema.columns where table_name in ('edition_organisers','editions') and column_name='cover_focus' and is_nullable='YES'`), '2');
    assert.equal(q(`select cover_focus is null from public.edition_organisers where id='${ORG}'`), 't');
  });
  test('only a "x% y%" pair between 0 and 100 is accepted', () => {
    for (const ok of ['0% 0%', '50% 50%', '100% 100%', '7% 93%']) assert.ok(!failed(run('ORG', `update public.edition_organisers set cover_focus='${ok}' where id='${ORG}'`)), ok);
    for (const bad of ['101% 50%', '50%', '50% 50', 'center', '1px 2px', '-5% 10%', "50% 50%'; drop table x; --", '999% 10%']) assert.ok(failed(run('ORG', `update public.edition_organisers set cover_focus='${bad.replace(/'/g, "''")}' where id='${ORG}'`)), bad);
  });
  test('an organiser administrator can set it on the organiser and on their Edition', () => {
    run('ORG', `update public.edition_organisers set cover_focus='25% 60%' where id='${ORG}'`, true);
    assert.equal(q(`select cover_focus from public.edition_organisers where id='${ORG}'`), '25% 60%');
    run('ORG', `update public.editions set cover_focus='80% 10%' where id='${ED}'`, true);
    assert.equal(q(`select cover_focus from public.editions where id='${ED}'`), '80% 10%');
  });
  test('someone outside the organiser cannot change it, and neither can signed-out visitors', () => {
    run('OTHER', `update public.edition_organisers set cover_focus='1% 1%' where id='${ORG}'`, true);
    run('OTHER', `update public.editions set cover_focus='1% 1%' where id='${ED}'`, true);
    assert.equal(q(`select cover_focus from public.edition_organisers where id='${ORG}'`), '25% 60%');
    assert.equal(q(`select cover_focus from public.editions where id='${ED}'`), '80% 10%');
    assert.ok(failed(run('anon', `update public.edition_organisers set cover_focus='1% 1%' where id='${ORG}'`)));
  });
  test('it is readable on the public page like the rest of the branding (published Edition, anon)', () => {
    assert.ok(!failed(run('anon', `select cover_focus from public.edition_organisers limit 1`)));
  });
});

describe('update photograph (R8)', () => {
  test('an organiser administrator can add an https photograph to an update; the public reads it; anything else is refused', () => {
    const U1 = last(run('ORG', `insert into public.edition_updates (edition_id, title, body, published_at, image_url) values ('${ED}','ZZ Photo news','b', now(), 'https://example.test/p.jpg') returning id`, true));
    assert.equal(q(`select image_url from public.edition_updates where id='${U1}'`), 'https://example.test/p.jpg');
    assert.equal(q(`select has_column_privilege('anon', 'public.edition_updates', 'image_url', 'select')`), 't', 'the public can read it (on a published Edition)');
    assert.equal(q(`select has_column_privilege('anon', 'public.edition_updates', 'created_by', 'select')`), 'f', 'while author ids stay private');
    for (const bad of ['http://example.test/p.jpg', 'javascript:alert(1)', 'https://x.test/a b.jpg', "https://x.test/'q"]) assert.ok(failed(run('ORG', `update public.edition_updates set image_url='${bad.replace(/'/g, "''")}' where id='${U1}'`)), bad);
    run('OTHER', `update public.edition_updates set image_url='https://evil.test/x.jpg' where id='${U1}'`, true);
    assert.equal(q(`select image_url from public.edition_updates where id='${U1}'`), 'https://example.test/p.jpg', 'an outsider cannot change it');
  });
  test('rollback removes only the column and is safe to run twice', () => {
    const sql = readFileSync(new URL('../rollbacks/20270102090000_editions_update_images.rollback.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(db.raw(sql), /ERROR/); assert.doesNotMatch(db.raw(sql), /ERROR/);
    assert.equal(q(`select count(*) from information_schema.columns where table_name='edition_updates' and column_name='image_url'`), '0');
    assert.equal(q(`select count(*) from information_schema.columns where table_name='edition_updates' and column_name in ('title','body','pinned','published_at')`), '4');
  });
});

describe('rollback', () => {
  test('removes only the two columns and is safe to run twice', () => {
    const sql = readFileSync(new URL('../rollbacks/20270102070000_editions_branding.rollback.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(db.raw(sql), /ERROR/);
    assert.doesNotMatch(db.raw(sql), /ERROR/);
    assert.equal(q(`select count(*) from information_schema.columns where table_name in ('edition_organisers','editions') and column_name='cover_focus'`), '0');
    assert.equal(q(`select count(*) from information_schema.columns where table_name='edition_organisers' and column_name in ('logo_url','cover_url','brand_color','tagline')`), '4');
  });
});
