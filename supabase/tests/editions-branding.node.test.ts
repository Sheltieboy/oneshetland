/**
 * editions-branding.node.test.ts — ISOLATED Postgres only. R6: the cover focus point on organisers and Editions.
 * Run: ISOLATED_ONLY=editions-branding npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), ORG: id(3), OTHER: id(5), EDITOR: id(7) } as const;
type Who = keyof typeof U | 'anon';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates/im.test(o);
let db: ReplayDb; let ORG = '', ED = '';
const as = (w: Who) => w === 'anon' ? 'set local role anon;' : `set local request.jwt.claims = '{"sub":"${U[w]}","email":"${U[w]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[w]}'; set local role authenticated;`;
const run = (w: Who, sql: string, commit = false) => db.raw(`begin; ${as(w)} ${sql}; ${commit ? 'commit' : 'rollback'};`);
const q = (sql: string) => last(db.raw(sql));

before(() => {
  db = createReplayDb('editionsbranding');
  db.raw(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  db.raw(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array['${U.ADMIN}'::uuid,'${U.ORG}'::uuid,'${U.OTHER}'::uuid,'${U.EDITOR}'::uuid]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed'),('${U.ORG}','customer','Orla'),('${U.OTHER}','customer','Otto'),('${U.EDITOR}','customer','Edie') on conflict (id) do update set role = excluded.role;
    insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true';`);
  ORG = last(run('ORG', `select public.create_edition_organiser('ZZ Brand Org', 'zz-brand-org')`, true));
  db.raw(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${U.EDITOR}','editor') on conflict do nothing`);
  ED = last(run('ORG', `insert into public.editions (organiser_id, slug, title, kind, starts_on, ends_on, cover_focus) values ('${ORG}','zz-brand-fest','ZZ Brand Fest','multi_day',current_date+10,current_date+12,'30% 20%') returning id`, true));
});
after(() => { try { db?.drop(); } catch { /* */ } });

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
