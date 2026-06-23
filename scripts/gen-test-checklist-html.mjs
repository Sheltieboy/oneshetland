/**
 * gen-test-checklist-html.mjs — turn PAYMENTS-TEST-PLAN.md into a clickable,
 * self-contained HTML checklist. Open the .html in any browser: click Pass/Fail,
 * type notes, progress + state auto-save in the browser (localStorage). No server.
 *
 * Usage (from oneshetland-delivers):
 *   node scripts/gen-test-checklist-html.mjs
 *   open PAYMENTS-TEST-PLAN.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'PAYMENTS-TEST-PLAN.md');
const OUT = join(ROOT, 'PAYMENTS-TEST-PLAN.html');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/_Notes:_.*$/, ''); // the note input replaces this
  return s;
}

const md = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const lines = md.split('\n');
const out = [];
let listOpen = null; // 'ul' | 'ol' | null
let tbl = null;      // collecting table rows
let k = 0;           // unique key for stateful controls

const closeList = () => { if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; } };
const flushTable = () => {
  if (!tbl) return;
  const [head, , ...body] = tbl;
  out.push('<table>');
  out.push('<thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead>');
  out.push('<tbody>' + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>');
  out.push('</table>');
  tbl = null;
};

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const t = raw.trim();

  if (t.startsWith('|')) { closeList(); (tbl ??= []).push(t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())); continue; }
  else if (tbl) flushTable();

  if (t === '') { closeList(); continue; }
  if (t === '---') { closeList(); out.push('<hr>'); continue; }
  if (t.startsWith('### ')) { closeList(); out.push(`<h3>${inline(t.slice(4))}</h3>`); continue; }
  if (t.startsWith('## ')) { closeList(); out.push(`<h2>${inline(t.slice(3))}</h2>`); continue; }
  if (t.startsWith('# ')) { closeList(); out.push(`<h1>${inline(t.slice(2))}</h1>`); continue; }
  if (t.startsWith('> ')) { closeList(); out.push(`<blockquote>${inline(t.slice(2))}</blockquote>`); continue; }

  // Pass/Fail verdict row → interactive control
  if (/^- ⬜ Pass ⬜ Fail/.test(t)) {
    closeList();
    const id = `v${k++}`;
    out.push(`<div class="verdict" data-k="${id}">
      <button class="pass" data-v="pass">✓ Pass</button>
      <button class="fail" data-v="fail">✗ Fail</button>
      <input class="note" data-k="${id}n" placeholder="Notes…">
    </div>`);
    continue;
  }

  // GitHub task list checkbox
  const task = t.match(/^- \[( |x)\]\s+(.*)$/i);
  if (task) {
    if (listOpen !== 'ul') { closeList(); out.push('<ul class="tasks">'); listOpen = 'ul'; }
    const id = `c${k++}`;
    out.push(`<li class="task"><label><input type="checkbox" data-k="${id}"${task[1].toLowerCase() === 'x' ? ' checked' : ''}> <span>${inline(task[2])}</span></label></li>`);
    continue;
  }

  // Bullet
  if (t.startsWith('- ')) {
    if (listOpen !== 'ul') { closeList(); out.push('<ul>'); listOpen = 'ul'; }
    out.push(`<li>${inline(t.slice(2))}</li>`);
    continue;
  }
  // Numbered
  const num = t.match(/^(\d+)\.\s+(.*)$/);
  if (num) {
    if (listOpen !== 'ol') { closeList(); out.push('<ol>'); listOpen = 'ol'; }
    out.push(`<li>${inline(num[2])}</li>`);
    continue;
  }

  // Test-title line: starts with **Xn — ...**
  closeList();
  if (/^\*\*[A-Z]?\d/.test(t)) out.push(`<p class="test">${inline(t)}</p>`);
  else out.push(`<p>${inline(t)}</p>`);
}
closeList();
flushTable();

const body = out.join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OneShetland — Payments Test Plan</title>
<style>
  :root{--navy:#032f4c;--accent:#0e6e8c;--pass:#1a8f7a;--fail:#c0392b;--line:#e3e8ec;--ink:#1f2d36;--muted:#5b6b75;}
  *{box-sizing:border-box}
  body{font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);max-width:860px;margin:0 auto;padding:0 18px 120px;background:#fafbfc}
  h1{color:var(--navy);font-size:30px;margin:24px 0 4px}
  h2{color:var(--navy);font-size:22px;margin:34px 0 10px;padding-top:12px;border-top:2px solid var(--line)}
  h3{color:var(--accent);font-size:17px;margin:20px 0 6px}
  hr{border:0;border-top:1px solid var(--line);margin:18px 0}
  code{background:#eef2f4;padding:1px 5px;border-radius:5px;font-size:13px}
  blockquote{margin:10px 0;padding:8px 14px;background:#eef6f9;border-left:3px solid var(--accent);border-radius:6px;color:#274b58}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
  th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
  th{background:var(--navy);color:#fff}
  ul,ol{margin:6px 0 12px;padding-left:22px}
  li{margin:3px 0}
  ul.tasks{list-style:none;padding-left:2px}
  ul.tasks li{margin:6px 0}
  ul.tasks label{display:flex;gap:9px;align-items:flex-start;cursor:pointer}
  ul.tasks input{margin-top:4px;width:18px;height:18px;flex:0 0 auto;accent-color:var(--accent)}
  ul.tasks input:checked + span{color:var(--muted);text-decoration:line-through}
  p.test{margin:18px 0 4px;font-size:15px}
  .verdict{display:flex;gap:8px;align-items:center;margin:4px 0 14px;flex-wrap:wrap}
  .verdict button{border:1.5px solid var(--line);background:#fff;border-radius:999px;padding:5px 14px;font-weight:700;font-size:13px;cursor:pointer;color:var(--muted)}
  .verdict button.pass.on{background:var(--pass);border-color:var(--pass);color:#fff}
  .verdict button.fail.on{background:var(--fail);border-color:var(--fail);color:#fff}
  .verdict .note{flex:1;min-width:160px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px}
  .bar{position:sticky;top:0;z-index:5;background:rgba(250,251,252,.95);backdrop-filter:blur(6px);padding:12px 0;margin:0 -18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;padding-left:18px;padding-right:18px;flex-wrap:wrap}
  .bar .track{flex:1;min-width:140px;height:10px;background:#e3e8ec;border-radius:999px;overflow:hidden}
  .bar .fill{height:100%;width:0;background:linear-gradient(90deg,var(--pass),var(--accent));transition:width .25s}
  .bar .stat{font-size:13px;font-weight:700;color:var(--navy)}
  .bar button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 11px;font-size:13px;font-weight:600;cursor:pointer;color:var(--navy)}
</style></head>
<body>
<div class="bar">
  <div class="track"><div class="fill" id="fill"></div></div>
  <span class="stat" id="stat">0 / 0</span>
  <button id="export">Copy results</button>
  <button id="reset">Reset</button>
</div>
${body}
<script>
  const KEY = 'onesh-payments-test-v1';
  const state = JSON.parse(localStorage.getItem(KEY) || '{}');
  const save = () => localStorage.setItem(KEY, JSON.stringify(state));

  // checkboxes
  document.querySelectorAll('input[type=checkbox][data-k]').forEach(el=>{
    const k=el.dataset.k; if(state[k]) el.checked=true;
    el.addEventListener('change',()=>{state[k]=el.checked;save();tally();});
  });
  // verdict buttons + notes
  document.querySelectorAll('.verdict').forEach(v=>{
    const k=v.dataset.k;
    v.querySelectorAll('button').forEach(b=>{
      if(state[k]===b.dataset.v) b.classList.add('on');
      b.addEventListener('click',()=>{
        state[k] = state[k]===b.dataset.v ? null : b.dataset.v;
        v.querySelectorAll('button').forEach(x=>x.classList.toggle('on', x.dataset.v===state[k]));
        save();tally();
      });
    });
    const note=v.querySelector('.note'); const nk=note.dataset.k;
    if(state[nk]) note.value=state[nk];
    note.addEventListener('input',()=>{state[nk]=note.value;save();});
  });

  const verdicts=[...document.querySelectorAll('.verdict')].map(v=>v.dataset.k);
  const checks=[...document.querySelectorAll('input[type=checkbox][data-k]')].map(e=>e.dataset.k);
  function tally(){
    const total=verdicts.length+checks.length;
    const done=verdicts.filter(k=>state[k]).length + checks.filter(k=>state[k]).length;
    document.getElementById('fill').style.width=(total?done/total*100:0)+'%';
    const fails=verdicts.filter(k=>state[k]==='fail').length;
    document.getElementById('stat').textContent=done+' / '+total+(fails?'  ·  '+fails+' fail':'');
  }
  document.getElementById('reset').onclick=()=>{ if(confirm('Clear all results?')){localStorage.removeItem(KEY);location.reload();} };
  document.getElementById('export').onclick=()=>{
    const out=[];
    document.querySelectorAll('.verdict').forEach(v=>{
      const title=(v.previousElementSibling&&v.previousElementSibling.classList.contains('test'))?v.previousElementSibling.textContent.trim():'';
      const k=v.dataset.k, verdict=state[k]||'—', note=state[k+'n']||'';
      out.push((verdict==='pass'?'✓':verdict==='fail'?'✗':'·')+' '+title+(note?'  — '+note:''));
    });
    navigator.clipboard.writeText(out.join('\\n')).then(()=>alert('Results copied to clipboard.'));
  };
  tally();
</script>
</body></html>`;

writeFileSync(OUT, html);
console.log(`Wrote ${OUT} (${(html.length / 1024).toFixed(1)} KB)`);
