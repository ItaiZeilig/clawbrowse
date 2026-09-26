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

const lineOf = (t, r) => String(t).split('\n').find((l) => l.startsWith(`${r} `)) || '';
async function act(step, table, label, op, kind) {
  const r = ref(table, label, kind);
  if (!r) throw new Error(`step "${step}": no row ${label} in:\n${table}`);
  const shown = lineOf(table, r).replace(/\s+/g, ' ').slice(0, 70);
  const start = now();
  const res = await h.act({ ...op, ref: r });
  fs.writeFileSync(path.join(out, `action-${String(state.actions.length + 1).padStart(2, '0')}.txt`), res); // what the agent got back
  const rows = res.split('\n').filter((l) => /^(f\d+\.)?e\d/.test(l)).length;
  state.actions.push({ step, start, end: now(), op: op.op, ref: r, row: shown, text: op.text || null, rows, delta: /only changes shown/.test(res), changed: /\[page changed\]/.test(res) });
  return res;
}

try {
  const first = await h.goto('https://www.google.com/travel/flights?hl=en&gl=US&curr=USD');
  await h.cdp('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const shot = await h.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
  fs.writeFileSync(path.join(out, 'frames', 'start.jpg'), Buffer.from(shot.data, 'base64'));
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
    const s = now();
    // Type the date and close the picker with Escape (keeps the date; Google's "Done" is flaky under automation).
    r = await h.act({ op: 'type', ref: ref(t, 'Departure', 'fill'), text: DATE_LABEL }, { op: 'key', key: 'Enter' }, { op: 'key', key: 'Escape' });
    state.actions.push({ step: DATE_LABEL, start: s, end: now(), op: 'type', ref: ref(t, 'Departure', 'fill'), row: 'fill "Departure"', text: `${DATE_LABEL} ⏎ Esc`, rows: 0, changed: true });
  });
  await step('Search', async () => {
    t = await h.observe();
    r = await act('Search', t, /^Search$/, { op: 'click' });
  });
  state.elapsed_ms = now();
  await new Promise((z) => setTimeout(z, 600)); // a few frames of the result
  await h.cdp('Page.stopScreencast', {});

  // Independent verification: read the page itself, not the action log.
  const page = await h.cmd('observe', { text: true });
  const text = page.slice(page.indexOf('visible text'));
  const url = await h.js('location.href');
  const checks = {
    results_page: /\/travel\/flights\/search/.test(url),
    route: /^Zürich to London \| Google Flights/.test(page),
    from_field: /"Where from\?"\s+▸ "Zürich"/.test(page),
    to_field: /"Where to\?"\s+▸ "London"/.test(page),
    one_way: /"Change ticket type\. One way"/.test(page),
    date: new RegExp(`"Departure"\\s+▸ "${DATE_LABEL}"`).test(page),
    flights_listed: /\d+ results returned/.test(text) && /\$\d+/.test(text),
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
