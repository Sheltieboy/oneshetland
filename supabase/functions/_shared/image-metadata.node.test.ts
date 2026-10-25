/**
 * image-metadata.node.test.ts — metadata removal from JPEG / PNG / WEBP bytes. No network.
 * Run: node --test supabase/functions/_shared/image-metadata.node.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripJpeg, stripPng, stripWebp } from './image-metadata.ts';

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, 'latin1'));
const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
const exif = (orientation: number) => {                      // little-endian TIFF: Orientation + a GPS pointer + "GPS 60.15N" text
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 2, 0,
    0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0,
    0x25, 0x88, 4, 0, 1, 0, 0, 0, 38, 0, 0, 0,
    0, 0, 0, 0, ...[...'GPS 60.155N 1.145W'].map((c) => c.charCodeAt(0))];
  return [...[...'Exif'].map((c) => c.charCodeAt(0)), 0, 0, ...tiff];
};

test('JPEG: EXIF (with location), XMP, IPTC and comments go; JFIF, ICC and the image data stay; orientation is kept', () => {
  const src = bytes([0xff, 0xd8], seg(0xe0, [...'JFIF'].map((c) => c.charCodeAt(0))), seg(0xe1, exif(6)),
    seg(0xe2, [...'ICC_PROFILE'].map((c) => c.charCodeAt(0))), seg(0xed, [...'Photoshop IPTC Mrs Isbister'].map((c) => c.charCodeAt(0))),
    seg(0xfe, [...'shot at 7 Westerloch'].map((c) => c.charCodeAt(0))), [0xff, 0xda, 0, 2, 1, 2, 3, 4, 0xff, 0xd9]);
  const out = stripJpeg(src);
  for (const s of ['GPS', '60.155', 'IPTC', 'Isbister', 'Westerloch']) assert.ok(!has(out, s), s);
  for (const s of ['JFIF', 'ICC_PROFILE']) assert.ok(has(out, s), s);
  assert.deepEqual([...out.subarray(out.length - 10)], [0xff, 0xda, 0, 2, 1, 2, 3, 4, 0xff, 0xd9]);
  const app1 = out.indexOf(0xe1, 2) - 1;
  assert.equal(out[app1], 0xff);
  assert.ok(has(out, 'Exif') && out.length < src.length);
  assert.equal(out[app1 + 4 + 6 + 8 + 2 + 9], 6, 'Orientation 6 carried over');
  const plain = stripJpeg(bytes([0xff, 0xd8], seg(0xe1, exif(1)), [0xff, 0xda, 0, 2, 9, 0xff, 0xd9]));
  assert.ok(!has(plain, 'Exif'), 'upright photos need no EXIF at all');
});
test('PNG: text and EXIF chunks go; image chunks stay', () => {
  const chunk = (type: string, data: string) => { const d = [...data].map((c) => c.charCodeAt(0)); return [0, 0, 0, d.length, ...[...type].map((c) => c.charCodeAt(0)), ...d, 1, 2, 3, 4]; };
  const src = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', 'abcdefghijklm'), chunk('tEXt', 'Comment Lerwick'),
    chunk('eXIf', 'GPS'), chunk('iTXt', 'XMP data'), chunk('IDAT', 'pixels'), chunk('IEND', ''));
  const out = stripPng(src);
  for (const s of ['Lerwick', 'GPS', 'XMP', 'tEXt', 'eXIf']) assert.ok(!has(out, s), s);
  for (const s of ['IHDR', 'IDAT', 'pixels', 'IEND']) assert.ok(has(out, s), s);
});
test('WEBP: EXIF and XMP chunks go, their VP8X flags are cleared, the RIFF size is right', () => {
  const chunk = (type: string, data: number[]) => [...[...type].map((c) => c.charCodeAt(0)), data.length, 0, 0, 0, ...data, ...(data.length % 2 ? [0] : [])];
  const src = bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk('VP8X', [0x0c, 0, 0, 0, 1, 0, 0, 1, 0, 0]), chunk('VP8 ', [1, 2, 3, 4]),
    chunk('EXIF', [...'GPS 60N'].map((c) => c.charCodeAt(0))), chunk('XMP ', [...'<x:xmpmeta/>'].map((c) => c.charCodeAt(0))));
  const out = stripWebp(src);
  assert.ok(!has(out, 'GPS') && !has(out, 'xmpmeta') && !has(out, 'EXIF'));
  assert.equal(out[20] & 0x0c, 0, 'flags cleared');
  assert.equal(out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24), out.length - 8);
  assert.ok(has(out, 'VP8 '));
});
test('unrecognised bytes are returned unchanged', () => {
  const x = bytes('not an image');
  assert.equal(stripJpeg(x), x); assert.equal(stripPng(x), x); assert.equal(stripWebp(x), x);
});
