/**
 * gen-test-checklist-pdf.mjs — turn PAYMENTS-TEST-PLAN.md into a tick-box PDF.
 * Checkboxes are real PDF form fields: click them in Preview/Acrobat, or print
 * and tick by hand. Each test has Pass / Fail boxes + a Notes line.
 *
 * Usage (from oneshetland-delivers):
 *   npm install pdfkit --no-save
 *   node scripts/gen-test-checklist-pdf.mjs
 *   open PAYMENTS-TEST-PLAN.pdf
 */
import { readFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PDFDocumentImport from 'pdfkit';
const PDFDocument = PDFDocumentImport.default || PDFDocumentImport;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'PAYMENTS-TEST-PLAN.md');
const OUT = join(ROOT, 'PAYMENTS-TEST-PLAN.pdf');

const NAVY = '#032f4c', ACCENT = '#0e6e8c', INK = '#1f2d36', MUTED = '#5b6b75', LINE = '#d7e0e6';
const clean = (s) => s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').replace(/_Notes:_.*$/, '').replace(/_/g, '').trim();

const md = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const lines = md.split('\n');

const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 54, left: 48, right: 48 } });
doc.pipe(createWriteStream(OUT));
doc.initForm();

const M = 48;
const RIGHT = doc.page.width - M;
const W = RIGHT - M;
let y = M;
let cb = 0;

function need(h) { if (y + h > doc.page.height - M) { doc.addPage(); y = M; } }
function gap(h) { y += h; }
function hr() { need(10); doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LINE).stroke(); gap(10); }

function text(str, { size = 10.5, color = INK, bold = false, indent = 0, gapAfter = 3 } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const w = W - indent;
  const h = doc.heightOfString(str, { width: w });
  need(h + gapAfter);
  doc.text(str, M + indent, y, { width: w });
  y += h + gapAfter;
}

function checkRow(label, { bold = false, size = 10.5, color = INK } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const tx = M + 20;
  const w = W - 20;
  const h = Math.max(13, doc.heightOfString(label, { width: w }));
  need(h + 5);
  doc.formCheckbox('c' + cb++, M, y, 12, 12, { borderColor: '#8aa0ad', borderWidth: 1 });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(label, tx, y, { width: w });
  y += h + 5;
}

function verdictRow() {
  need(20);
  const yb = y;
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  doc.formCheckbox('p' + cb, M + 20, yb, 12, 12, { borderColor: ACCENT, borderWidth: 1 });
  doc.text('Pass', M + 36, yb + 1);
  doc.formCheckbox('f' + cb, M + 90, yb, 12, 12, { borderColor: '#c0392b', borderWidth: 1 });
  doc.text('Fail', M + 106, yb + 1);
  cb++;
  doc.fillColor(MUTED).text('Notes:', M + 160, yb + 1);
  doc.moveTo(M + 200, yb + 12).lineTo(RIGHT, yb + 12).lineWidth(0.5).strokeColor(LINE).stroke();
  y = yb + 22;
}

let tbl = null;
function flushTable() {
  if (!tbl) return;
  const rows = tbl; tbl = null;
  rows.forEach((cells, idx) => {
    const sep = idx === 1 && cells.every((c) => /^-+$/.test(c));
    if (sep) return;
    text(cells.map(clean).join('  ·  '), { size: 9.5, color: idx === 0 ? NAVY : INK, bold: idx === 0, indent: 6, gapAfter: 2 });
  });
  gap(4);
}

for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();

  if (t.startsWith('|')) { (tbl ??= []).push(t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())); continue; }
  else if (tbl) flushTable();

  if (t === '') { gap(3); continue; }
  if (t === '---') { hr(); continue; }
  if (t.startsWith('### ')) { gap(6); text(clean(t.slice(4)), { size: 12, bold: true, color: ACCENT, gapAfter: 4 }); continue; }
  if (t.startsWith('## ')) { need(40); gap(8); text(clean(t.slice(3)), { size: 15, bold: true, color: NAVY, gapAfter: 5 }); continue; }
  if (t.startsWith('# ')) { text(clean(t.slice(2)), { size: 20, bold: true, color: NAVY, gapAfter: 8 }); continue; }
  if (t.startsWith('> ')) { text(clean(t.slice(2)), { size: 9.5, color: MUTED, indent: 6, gapAfter: 4 }); continue; }

  if (/^- \[( |x)\]/i.test(t)) { checkRow(clean(t.replace(/^- \[( |x)\]\s*/i, '')), { size: 10.5 }); continue; }
  if (/^- ⬜ Pass ⬜ Fail/.test(t)) { verdictRow(); continue; }
  if (t.startsWith('- ')) { text('•  ' + clean(t.slice(2)), { size: 10, indent: 12, gapAfter: 2 }); continue; }
  const num = t.match(/^(\d+)\.\s+(.*)$/);
  if (num) { text(num[1] + '.  ' + clean(num[2]), { size: 10, indent: 12, gapAfter: 2 }); continue; }

  // Test title (**Xn — ...**) → bold lead-in
  if (/^\*\*[A-Z]?\d/.test(t)) { gap(4); text(clean(t), { size: 11, bold: true, color: NAVY, gapAfter: 2 }); continue; }
  text(clean(t), { size: 10.5 });
}
flushTable();

doc.end();
doc.on('end', () => {});
await new Promise((res) => doc.on('end', res));
console.log(`Wrote ${OUT}`);
