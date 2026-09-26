// Record a real PawBrowse run on live Google Flights for the README demo.
//
// Drives the SHIPPED extension/background.js (via the e2e harness) in headless Chrome, captures a
// CDP screencast with original timestamps, logs every action, and verifies the outcome from the
// page itself. The plan is scripted (find the row by its label, act) — it shows the browser side of
// an agent run; an LLM's thinking time is deliberately not part of this recording.
//
//   node scripts/demo/record.mjs <out-dir>     then     python3 scripts/demo/render.py <out-dir>

import fs from 'node:fs';
import path from 'node:path';
import { launch, ref } from '../../test/e2e/harness.mjs';

const out = path.resolve(process.argv[2] || 'demo-recording');
if (fs.existsSync(out)) throw new Error(`${out} exists; use a new folder`);
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });

const DATE_LABEL = process.env.DEMO_DATE || 'Tue, Oct 20';
const h = await launch();
const state = { steps: [], actions: [], frames: [], verification: null, errors: [] };
let t0 = null;
const now = () => (t0 == null ? 0 : Date.now() - t0);

// Screencast: every frame keeps the page's own timestamp.
let n = 0;
h.onEvent((method, p) => {
  if (method !== 'Page.screencastFrame') return;
  h.cdp('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  if (t0 == null) return;
  const ms = Math.round(p.metadata.timestamp * 1000 - t0);
  const f = `${String(n++).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(out, 'frames', f), Buffer.from(p.data, 'base64'));
  state.frames.push({ file: f, ms });
});

// Where the target is on screen (CSS px of the viewport) — drawn as the highlight in the video.
const targetRect = (r) => h.ev(`(function(){ var c=window.__pawbrowse, e=c&&c.get(${JSON.stringify(r)}); var s=e&&(c.surface?c.surface(e):e); if(!s) return null; var q=s.getBoundingClientRect(); return [q.x,q.y,q.width,q.height].map(Math.round); })()`).catch(() => null);
// The rows that are NEW in `res` compared with `before` (ignoring ref numbers): what the action
// revealed or changed — suggestions appearing, a checkbox flipping, results arriving.
const body = (l) => l.replace(/^(f\d+\.)?e\d+(_\d+)?\s+/, '').replace(/\s+/g, ' ');
const seenRows = new Set(); // every row the agent has been shown so far in this run
function newRows(before, res) {
  for (const l of String(before).split('\n')) seenRows.add(body(l));
  const fresh = res.split('\n').filter((l) => /^(f\d+\.)?e\d/.test(l) && !/[↕↓↑]/.test(l) && !seenRows.has(body(l)));
  for (const l of res.split('\n')) seenRows.add(body(l));
  fresh.sort((a, b) => /\$\d/.test(b) - /\$\d/.test(a)); // prices first: results are the interesting part
  return fresh.slice(0, 5).map((l) => l.replace(/\s+/g, ' ').slice(0, 58));
}
const lineOf = (t, r) => String(t).split('\n').find((l) => l.startsWith(`${r} `)) || '';
async function act(step, table, label, op, kind) {
  const r = ref(table, label, kind);
  if (!r) throw new Error(`step "${step}": no row ${label} in:\n${table}`);
  const shown = lineOf(table, r).replace(/\s+/g, ' ').slice(0, 70);
  const rect = await targetRect(r);
  const start = now();
  const res = await h.act({ ...op, ref: r });
  fs.writeFileSync(path.join(out, `action-${String(state.actions.length + 1).padStart(2, '0')}.txt`), res); // what the agent got back
  const rows = res.split('\n').filter((l) => /^(f\d+\.)?e\d/.test(l)).length;
  const preview = newRows(table, res);
  state.actions.push({ step, start, end: now(), op: op.op, ref: r, row: shown, text: op.text || null, rect, rows, preview, delta: /only changes shown/.test(res), changed: /\[page changed\]/.test(res) });
  return res;
}

try {
  const first = await h.goto('https://www.google.com/travel/flights?hl=en&gl=US&curr=USD');
  newRows(first, '');
  await h.cdp('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const shot = await h.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
  fs.writeFileSync(path.join(out, 'frames', 'start.jpg'), Buffer.from(shot.data, 'base64'));
  state.viewport = await h.js('[innerWidth, innerHeight]');
  state.version = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url))).version;
  t0 = Date.now(); // the clock starts at the first action (page load excluded, as in jev's demo)
  let t = first, r;
  const step = async (name, fn) => { const s = now(); await fn(); state.steps.push({ name, start: s, end: now() }); };

  await step('One way', async () => {
    r = await act('One way', t, /^Change ticket type/, { op: 'click' });
    r = await act('One way', r, 'One way', { op: 'click' });
  });
  await step('Zürich', async () => {
    t = await h.observe();
    r = await act('Zürich', t, 'Where from?', { op: 'type', text: 'Zürich' }, 'fill');
    r = await act('Zürich', r, 'Zürich, Switzerland', { op: 'click' });
  });
  await step('London', async () => {
    t = await h.observe();
    r = await act('London', t, 'Where to?', { op: 'type', text: 'London' }, 'fill');
    r = await act('London', r, 'London, United Kingdom', { op: 'click' });
  });
  await step(DATE_LABEL, async () => {
    t = await h.observe();
    r = await act(DATE_LABEL, t, 'Departure', { op: 'click' }, 'fill');
    t = await h.observe();
    // Type the date and close the picker with Escape (keeps the date; Google's "Done" is flaky under automation).
    const dep = ref(t, 'Departure', 'fill'), rect = await targetRect(dep), s = now();
    r = await h.act({ op: 'type', ref: dep, text: DATE_LABEL }, { op: 'key', key: 'Enter' }, { op: 'key', key: 'Escape' });
    const preview = newRows(t, r);
    state.actions.push({ step: DATE_LABEL, start: s, end: now(), op: 'type', ref: dep, row: 'fill "Departure"', text: `${DATE_LABEL} ⏎ Esc`, rect, rows: 0, preview, changed: true });
  });
  await step('Search', async () => {
    t = await h.observe();
    r = await act('Search', t, /^Search$/, { op: 'click' });
  });
  await step('Open cheapest', async () => {
    // The "Cheapest" tab's price is in the table: open the first nonstop result at that price.
    const cheapest = (r.match(/Cheapest from (\d+) US dollars/) || [])[1];
    r = await act('Open cheapest', r, new RegExp(`^From ${cheapest || '\\d+'} US dollars.*Nonstop flight`), { op: 'click' });
  });
  state.elapsed_ms = now();
  await new Promise((z) => setTimeout(z, 600)); // a few frames of the result
  await h.cdp('Page.stopScreencast', {});

  // Independent verification: read the page itself, not the action log.
  const page = await h.cmd('observe', { text: true });
  const text = page.slice(page.indexOf('visible text'));
  const url = await h.js('location.href');
  const checks = {
    booking_page: /\/travel\/flights\/booking/.test(url),
    route: /Zürich London \$\d+/.test(text),
    one_way: /One way Economy 1 passenger/.test(text),
    date: new RegExp(DATE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text),
    nonstop: /Nonstop/.test(text),
    booking_options: /Booking options/.test(text),
  };
  state.verification = { url, checks, passed: Object.values(checks).every(Boolean) };
  fs.writeFileSync(path.join(out, 'final-table.txt'), page);
} catch (e) {
  state.errors.push(String(e && e.stack || e));
} finally {
  fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(state, null, 2));
  await h.close();
}
console.log(JSON.stringify({ elapsed_ms: state.elapsed_ms, frames: state.frames.length, actions: state.actions.length, verification: state.verification, errors: state.errors.map((x) => x.split('\n')[0]) }, null, 2));
