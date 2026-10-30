/**
 * geography-contract.node.test.ts — the client side of the canonical geography contract (lib/geography.ts), offline.
 * The database half is proven in geography-foundation.node.test.ts (isolated Postgres). No network, no database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../../lib/geography.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('normaliseGeoText', () => {
  test('trims, folds case, collapses whitespace and punctuation', () => {
    assert.equal(G.normaliseGeoText('  Whalsay  &   Skerries '), 'whalsay and skerries');
    assert.equal(G.normaliseGeoText('Remote / hybrid'), 'remote hybrid');
    assert.equal(G.normaliseGeoText("St Ninian’s Isle"), 'st ninians isle');
    assert.equal(G.normaliseGeoText('Café'), 'cafe');
  });
  test('drops only a trailing ", Shetland[ Islands][, Scotland|UK]" qualifier', () => {
    assert.equal(G.normaliseGeoText('Lerwick, Shetland'), 'lerwick');
    assert.equal(G.normaliseGeoText('Lerwick, Shetland Islands, Scotland'), 'lerwick');
    assert.equal(G.normaliseGeoText('Shetland, Lerwick'), 'shetland lerwick');
    assert.equal(G.normaliseGeoText('Shetland'), 'shetland');
    assert.equal(G.normaliseGeoText('Shetland-wide'), 'shetland wide');
  });
  test('non-strings and empties normalise to the empty string (never throw)', () => {
    for (const v of [null, undefined, 42, {}, '', '   ', '!!!']) assert.equal(G.normaliseGeoText(v), '');
  });
});

describe('contract helpers', () => {
  const base = { input: 'x', normalised: 'x', reason: '', area_id: null, area_type: null, locality_id: null, is_shetland_wide: false, confidence: null, kind: null, alias_id: null, candidate_ids: [] } as const;
  test('only a resolved answer is a location; shetland_wide is a scope, distinct from everything unresolved', () => {
    const wide = { ...base, status: 'resolved', area_id: G.SHETLAND_WIDE, area_type: 'shetland', is_shetland_wide: true } as G.GeoResolution;
    const place = { ...base, status: 'resolved', area_id: 'unst', area_type: 'island', locality_id: 'yell_unst_fetlar' } as G.GeoResolution;
    assert.equal(G.geographyScope(wide), 'shetland_wide');
    assert.equal(G.geographyScope(place), 'area');
    for (const status of ['unresolved', 'ambiguous', 'invalid', 'non_geographic'] as const) assert.equal(G.geographyScope({ ...base, status } as G.GeoResolution), null, status);
    assert.equal(G.geographyScope(null), null);
    assert.equal(G.isResolvedGeography({ ...base, status: 'unresolved', candidate_ids: ['burra'] } as G.GeoResolution), false);
  });
  test('the seven locality IDs are the stable, verified ones', () => {
    assert.deepEqual([...G.GEO_LOCALITIES], ['lerwick_bressay', 'shetland_central', 'shetland_north', 'shetland_south', 'shetland_west', 'whalsay_skerries', 'yell_unst_fetlar']);
  });
});

describe('resolveGeography', () => {
  test('passes the value to the database resolver and returns its answer, preserving the original input', async () => {
    let seen: unknown;
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { seen = { fn, args }; return { data: { input: args.p_input, status: 'resolved', area_id: 'shetland_west', normalised: 'westside' }, error: null }; } };
    const r = await G.resolveGeography(client, 'Westside');
    assert.deepEqual(seen, { fn: 'resolve_geography', args: { p_input: 'Westside' } });
    assert.equal(r.area_id, 'shetland_west'); assert.equal(r.input, 'Westside');
  });
  test('if the database cannot answer, the result is "unresolved" — never a guess', async () => {
    for (const client of [{ rpc: async () => ({ data: null, error: { message: 'down' } }) }, { rpc: async () => { throw new Error('network'); } }, { rpc: async () => ({ data: 'nonsense', error: null }) }]) {
      const r = await G.resolveGeography(client as G.GeoRpcClient, 'Westside');
      assert.equal(r.status, 'unresolved'); assert.equal(r.area_id, null); assert.equal(r.reason, 'resolver_unavailable'); assert.equal(r.input, 'Westside');
    }
  });
});

test('the edge-function copy is byte-identical to the app copy', () => {
  assert.equal(readFileSync(join(ROOT, 'supabase/functions/_shared/geography.ts'), 'utf8'), readFileSync(join(ROOT, 'lib/geography.ts'), 'utf8'));
});
