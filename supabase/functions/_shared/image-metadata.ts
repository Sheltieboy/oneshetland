/**
 * image-metadata.ts — remove embedded metadata (location, device, timestamps, comments) from JPEG, PNG and WEBP bytes.
 * Pure byte manipulation; the pixels are never decoded or changed.
 *
 *   JPEG  drops APP1 (EXIF/XMP — where GPS lives), APP3–APP13 and APP15 (maker and IPTC data) and COM segments; keeps APP0 (JFIF),
 *         APP2 (ICC colour profile) and APP14 (Adobe colour transform). The EXIF Orientation value, if present, is carried over in
 *         a new minimal EXIF block holding only that tag, so phone photos are not shown sideways.
 *   PNG   drops eXIf, tEXt, zTXt, iTXt and tIME chunks.
 *   WEBP  drops EXIF and XMP chunks and clears their flags in the VP8X header; the RIFF size is recomputed.
 * Anything it does not recognise is returned unchanged (callers have already checked the type from the bytes).
 */

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];

/** The EXIF Orientation (1–8) from an APP1 segment body ("Exif\0\0" + TIFF), or null. */
function exifOrientation(seg: Uint8Array): number | null {
  if (seg.length < 14 || String.fromCharCode(...seg.subarray(0, 4)) !== 'Exif') return null;
  const t = seg.subarray(6);
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const u16 = (i: number) => (le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1]);
  const u32 = (i: number) => (le ? (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16)) + t[i + 3] * 0x1000000 : t[i] * 0x1000000 + ((t[i + 1] << 16) | (t[i + 2] << 8) | t[i + 3]));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : null; }
  }
  return null;
}

/** A minimal APP1 segment holding only Orientation (big-endian TIFF, one IFD0 entry). */
function orientationApp1(o: number): Uint8Array {
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0,             // "Exif\0\0"
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8,                          // MM, 42, IFD0 at 8
    0, 1,                                                     // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0,                 // Orientation, SHORT, count 1, value
    0, 0, 0, 0];                                              // no next IFD
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

export function stripJpeg(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let i = 2;
  let insertAt = 1;                                           // after SOI, or after APP0 when there is one
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { parts.push(b.subarray(i)); i = b.length; break; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }                        // fill byte
    if (m === 0xda || m === 0xd9) { parts.push(b.subarray(i)); i = b.length; break; }   // image data follows: copy the rest
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = be16(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) { parts.push(b.subarray(i)); i = b.length; break; }
    const seg = b.subarray(i, i + 2 + len);
    if (m === 0xe1) { orientation ??= exifOrientation(seg.subarray(4)); }
    const drop = m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;
    if (!drop) { parts.push(seg); if (m === 0xe0) insertAt = parts.length; }
    i += 2 + len;
  }
  if (orientation && orientation !== 1) parts.splice(insertAt, 0, orientationApp1(orientation));
  return concat(parts);
}

export function stripPng(b: Uint8Array): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 8 || sig.some((x, k) => b[k] !== x)) return b;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) { parts.push(b.subarray(i)); break; }
    if (!['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'].includes(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return concat(parts);
}

export function stripWebp(b: Uint8Array): Uint8Array {
  const ascii = (i: number) => String.fromCharCode(...b.subarray(i, i + 4));
  if (b.length < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WEBP') return b;
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(i);
    const len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    const end = i + 8 + len + (len % 2);
    if (len < 0 || end > b.length) { chunks.push(b.subarray(i)); break; }
    if (type !== 'EXIF' && type !== 'XMP ') {
      const c = b.slice(i, end);
      if (type === 'VP8X' && c.length > 8) c[8] &= ~(0x08 | 0x04);   // no EXIF, no XMP
      chunks.push(c);
    }
    i = end;
  }
  const body = concat(chunks);
  const size = body.length + 4;
  return concat([new Uint8Array([0x52, 0x49, 0x46, 0x46, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50]), body]);
}

export function stripImageMetadata(bytes: Uint8Array, mime: string): Uint8Array {
  if (mime === 'image/jpeg') return stripJpeg(bytes);
  if (mime === 'image/png') return stripPng(bytes);
  if (mime === 'image/webp') return stripWebp(bytes);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
