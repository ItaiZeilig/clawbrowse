// End-to-end perception + action tests against a real headless Chrome, driving the shipped
// extension/background.js through a chrome.debugger shim (see harness.mjs). Every outcome is checked
// against GROUND TRUTH read straight from the page — never PawBrowse's own report of success.
//
//   npm run test:e2e          (needs Chrome; set CHROME_PATH if it isn't in the default location)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, chromePath, ref } from './harness.mjs';

const skip = chromePath() ? false : 'Chrome not found (set CHROME_PATH)';
let h;
before(async () => { if (!skip) h = await launch(); });
after(async () => { if (h) await h.close(); });

const out = () => h.js(`document.getElementById('out')?.textContent || ''`);
function mustRef(table, label, kind) {
  const r = ref(table, label, kind);
  assert.ok(r, `no row "${label}"${kind ? ` (${kind})` : ''} in:\n${table}`);
  return r;
}

/* ------------------------------ styled widgets ----------------------------- */

test('styled checkboxes/radios/switch/file are perceived (hidden native inputs)', { skip }, async () => {
  const t = await h.goto('widgets.html');
  for (const l of ['Free WiFi', 'Pool', 'Dark mode', 'Economy class', 'Business class']) mustRef(t, l, 'click');
  mustRef(t, 'Upload CV', 'upload');
  assert.doesNotMatch(t, /"Pool".*covered/, 'sr-only checkbox must be clickable via its label, not flagged covered');
});

for (const [label, id] of [['Free WiFi', 'wifi'], ['Pool', 'pool'], ['Dark mode', 'dark'], ['Business class', 'biz']]) {
  test(`clicking styled control "${label}" really toggles the native input`, { skip }, async () => {
    const t = await h.goto('widgets.html');
    const r = await h.act({ op: 'click', ref: mustRef(t, label) });
    assert.match(r, /page changed/);
    assert.equal(await h.js(`document.getElementById('${id}').checked`), true, r);
    assert.match(r, new RegExp(`✓ "${label}"`), 'table should now show it checked');
  });
}

test('date/time/month/week/color/range inputs are fillable with a format hint', { skip }, async () => {
  const t = await h.goto('widgets.html');
  for (const [l, f] of [['Departure', 'YYYY-MM-DD'], ['Time', 'HH:MM'], ['Local', 'YYYY-MM-DDTHH:MM'], ['Month', 'YYYY-MM'], ['Week', 'YYYY-Www'], ['Color', '#rrggbb'], ['Budget', '0..1000 step 50']]) {
    const line = t.split('\n').find((x) => x.includes(`"${l}"`));
    assert.ok(line && line.includes(' fill ') && line.includes(`fmt{${f}}`), `bad row for ${l}: ${line}`);
  }
});

test('typing a date sets it, fires page events, and survives form submit', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Departure'), text: '2026-12-25' });
  assert.match(r, /set to "2026-12-25"/);
  assert.equal(await h.js(`document.getElementById('when').value`), '2026-12-25');
  assert.equal(await out(), 'date:2026-12-25', 'page input listener must see the change');
  const t2 = await h.observe();
  await h.act({ op: 'click', ref: mustRef(t2, 'Search') });
  // The email field is invalid, so native validation blocks submit — fix it, then submit.
  const t3 = await h.observe();
  await h.act({ op: 'type', ref: mustRef(t3, 'Email'), text: 'a@b.co' }, { op: 'click', ref: mustRef(t3, 'Search') });
  assert.equal(await out(), 'submitted 2026-12-25');
});

test('an invalid date is rejected with a clear error, not silently blanked', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Departure'), text: 'next friday' });
  assert.match(r, /rejected by the date field/);
});

test('range input reports the browser-clamped value', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Budget'), text: '5000' });
  assert.match(r, /set to "1000"/);
  assert.equal(await h.js(`document.getElementById('budget').value`), '1000');
});

test('file upload through a hidden input behind a label', { skip }, async () => {
  const f = path.join(os.tmpdir(), `pawbrowse-cv-${process.pid}.txt`);
  fs.writeFileSync(f, 'hello');
  try {
    const t = await h.goto('widgets.html');
    const r = await h.act({ op: 'upload', ref: mustRef(t, 'Upload CV'), paths: [f] });
    assert.match(r, /upload e\d+ \(1 file\)/, r);
    assert.equal(await out(), `file:${path.basename(f)}`);
    assert.match(r, new RegExp(`"Upload CV"\\s+▸ "${path.basename(f)}"`));
  } finally { fs.rmSync(f, { force: true }); }
});

test('unlabelled fields get a nearby label; contenteditable gets its placeholder; validation shown', { skip }, async () => {
  const t = await h.goto('widgets.html');
  const r = await h.act({ op: 'type', ref: mustRef(t, 'Name', 'fill'), text: 'Ada' }, { op: 'type', ref: mustRef(t, 'Write a note', 'fill'), text: 'hi there' });
  assert.equal(await h.js(`document.getElementById('nolabel').value`), 'Ada');
  assert.equal(await h.js(`document.getElementById('rte').innerText.trim()`), 'hi there');
  assert.match(r, /"Email" \(required\).*⚠ "Please include an '@'/);
});

/* ------------------------------- hostile pages ----------------------------- */

test('a page that sabotages JS builtins and squats on our globals cannot blind us', { skip }, async () => {
  const t = await h.goto('hostile.html');
  assert.doesNotMatch(t, /Ignore previous instructions|INJECTED|pwned/);
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Real button') }, { op: 'click', ref: mustRef(t, 'Agree') });
  assert.equal(await h.js(`document.getElementById('o').textContent`), 'hostile clicked');
  assert.equal(await h.js(`document.getElementById('c').checked`), true, r);
  assert.equal(await h.js('window.__pawbrowse'), 'not your cache', 'we must not touch the page\'s own globals');
});

test('hidden text never leaks into labels; disabled/inert/collapsed controls are excluded', { skip }, async () => {
  const t = await h.goto('tricky.html');
  assert.doesNotMatch(t, /SECRET/);
  assert.doesNotMatch(t, /In disabled fieldset|Inert button|Hidden in details/);
  mustRef(t, 'Close'); mustRef(t, 'Settings'); mustRef(t, 'Save');
  assert.match(t, /"Under overlay"\s+⊘ covered/);
  assert.match(t, /"No pointer events"\s+⊘ covered/);
});

test('clicking a covered control fails loudly instead of clicking the overlay', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Under overlay') });
  assert.match(r, /covered by another element/);
  assert.equal(await out(), '');
});

test('a control relabelled after observe is refused (no clicking "Delete forever" thinking it is "Archive")', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const archive = mustRef(t, 'Archive');
  await h.js(`document.getElementById('morph').textContent='Delete forever'`);
  const r = await h.act({ op: 'click', ref: archive });
  assert.match(r, /changed since observe/);
});

test('an element removed on mousedown does not crash the batch', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Vanish on press') }, { op: 'click', ref: mustRef(t, 'Div role button') });
  assert.equal(await out(), 'div button', r);
  assert.equal(await h.js(`!!document.getElementById('vanish')`), false);
});

test('RTL / non-latin labels round-trip', { skip }, async () => {
  const t = await h.goto('nav.html');
  mustRef(t, 'אשר', 'click');
});

/* ---------------------------- shadow DOM & frames --------------------------- */

test('open, nested and slotted shadow content is perceived and clickable', { skip }, async () => {
  const t = await h.goto('shadow.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Deep nested button') });
  assert.equal(await out(), 'deep clicked');
  const t2 = await h.observe();
  await h.act({ op: 'click', ref: mustRef(t2, 'Slotted action') }, { op: 'type', ref: mustRef(t2, 'Shadow field'), text: 'in shadow' });
  assert.equal(await out(), 'slotted clicked');
  assert.equal(await h.js(`document.querySelector('x-open').shadowRoot.getElementById('i').value`), 'in shadow');
});

test('read includes shadow-DOM, slotted and same-origin iframe text', { skip }, async () => {
  await h.goto('shadow.html');
  const r = await h.cmd('read');
  for (const s of ['Inside open shadow text', 'Deep nested button', 'Slotted action']) assert.ok(r.includes(s), `missing "${s}":\n${r}`);
  await h.goto('frames.html');
  const f = await h.cmd('read');
  assert.ok(f.includes('Inner frame text'), f);
});

test('same-origin iframe (border + padding offset) click lands on the right element', { skip }, async () => {
  const t = await h.goto('frames.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Inner button') }, { op: 'click', ref: mustRef(t, 'Inner check') });
  const inner = `document.getElementById('same').contentDocument`;
  assert.equal(await h.js(`${inner}.getElementById('o').textContent`), 'inner clicked');
  assert.equal(await h.js(`${inner}.getElementById('ic').checked`), true);
});

test('a control scrolled out of its iframe is reachable', { skip }, async () => {
  const t = await h.goto('frames.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Low inner button') });
  assert.equal(await h.js(`document.getElementById('same').contentDocument.getElementById('o').textContent`), 'low clicked', r);
});

test('cross-origin iframes are reported, not silently dropped', { skip }, async () => {
  const t = await h.goto('frames.html');
  assert.match(t, /cross-origin frames \(content not readable\): "localhost:\d+"/);
});

/* -------------------------- scrolling, overlays, nav ------------------------ */

test('controls below the fold / inside scroll boxes are flagged and clickable', { skip }, async () => {
  const t = await h.goto('layout.html');
  assert.match(t, /\+1 more; scroll to reveal/);
  assert.match(t, /"Inside scroll box"\s+↕/);
  await h.act({ op: 'click', ref: mustRef(t, 'Inside scroll box') });
  assert.equal(await out(), 'inbox');
  const t2 = await h.act({ op: 'scroll', dy: 1400 });
  await h.act({ op: 'click', ref: mustRef(t2, 'Far below button') });
  assert.equal(await out(), 'below');
});

test('a modal dialog covers the page behind it; its own button works', { skip }, async () => {
  const t = await h.goto('layout.html');
  const t2 = await h.act({ op: 'click', ref: mustRef(t, 'Open dialog') });
  assert.match(t2, /"Top button"\s+⊘ covered/);
  const bad = await h.act({ op: 'click', ref: mustRef(t2, 'Top button') });
  assert.match(bad, /covered|disabled/);
  await h.act({ op: 'click', ref: mustRef(t2, 'Confirm') });
  assert.equal(await out(), 'confirmed');
});

test('refs from a previous page fail cleanly after navigation; the next observe works', { skip }, async () => {
  const t = await h.goto('nav.html');
  const old = mustRef(t, 'JS navigate');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Go to tricky') });
  assert.match(r, /Tricky/);
  const r2 = await h.act({ op: 'click', ref: old });
  assert.match(r2, /unknown ref|no longer on page|no snapshot/);
  mustRef(await h.observe(), 'Archive');
});

test('JS navigation and pushState inside one act batch', { skip }, async () => {
  const t = await h.goto('nav.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Push state') });
  assert.match(r, /Routed/);
  const r2 = await h.act({ op: 'click', ref: mustRef(r, 'JS navigate') });
  assert.match(r2, /Layout/);
});

/* ------------------------------ dynamic / scale ----------------------------- */

test('autocomplete on a page that re-renders every keystroke', { skip }, async () => {
  const t = await h.goto('spa.html');
  let r = await h.act({ op: 'type', ref: mustRef(t, 'City', 'fill'), text: 'Pa' });
  for (let i = 0; i < 5 && !ref(r, 'Paris'); i++) r = await h.observe();
  await h.act({ op: 'click', ref: mustRef(r, 'Paris') });
  assert.equal(await out(), 'picked Paris');
});

test('big page (3000 rows, 9000 controls) stays fast and bounded', { skip }, async () => {
  await h.goto('big.html');
  const t0 = performance.now();
  const t = await h.observe();
  const ms = performance.now() - t0;
  const rows = t.split('\n').filter((l) => /^e\d/.test(l)).length;
  assert.ok(rows > 20 && rows <= 290, `rows=${rows}`);
  assert.ok(ms < 1500, `observe took ${ms.toFixed(0)}ms`);
});

test('about:blank and a page with no body do not throw', { skip }, async () => {
  await h.cdp('Page.navigate', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 300));
  const t = await h.observe();
  assert.equal(typeof t, 'string');
});

/* ------------------------- round 2: layout & dialogs ------------------------ */

for (const [label, want] of [['Zoomed button', 'zoomed'], ['Scaled button', 'scaled'], ['Moving button', 'mover'], ['Fading button', 'faded in']]) {
  test(`click lands on a ${label.split(' ')[0].toLowerCase()} element`, { skip }, async () => {
    const t = await h.goto('round2.html');
    await h.act({ op: 'click', ref: mustRef(t, label) });
    assert.equal(await out(), want);
  });
}

test('repeated labels are disambiguated by their row, and the right row is hit', { skip }, async () => {
  const t = await h.goto('round2.html');
  assert.match(t, /"Delete" in "Invoice #1002 — Globex"/);
  assert.match(t, /"Edit" in "Bob"/);
  const row = t.split('\n').find((l) => l.includes('Globex')).split(/\s+/)[0];
  await h.act({ op: 'click', ref: row });
  assert.equal(await out(), 'del 1002');
});

test('scroll with a ref scrolls that panel, not the page', { skip }, async () => {
  const t = await h.goto('round2.html');
  assert.match(t, /"Open row 20"\s+↕/, 'rows in the fixed panel are scrolled out of their box, not below the page');
  assert.equal(ref(t, 'Open row 55'), null);
  const r = await h.act({ op: 'scroll', ref: mustRef(t, 'Open row 0'), dy: 1500 });
  assert.ok(await h.js(`document.getElementById('panel').scrollTop`) > 1000);
  await h.act({ op: 'click', ref: mustRef(r, 'Open row 55') });
  assert.equal(await out(), 'row 55');
});

test('alert is accepted and reported instead of freezing the tab', { skip }, async () => {
  const t = await h.goto('dialogs.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Save') });
  assert.match(r, /dialog: alert "Saved!" → accepted/);
  assert.equal(await out(), 'after alert');
});

test('a destructive confirm is dismissed by default, accepted only on request', { skip }, async () => {
  let t = await h.goto('dialogs.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Delete account') });
  assert.match(r, /confirm "Really delete\?" → dismissed/);
  assert.equal(await out(), 'cancelled');
  t = await h.observe();
  await h.act({ op: 'click', ref: mustRef(t, 'Delete account'), dialog: 'accept' });
  assert.equal(await out(), 'confirmed');
});

test('prompt gets the requested answer', { skip }, async () => {
  const t = await h.goto('dialogs.html');
  await h.act({ op: 'click', ref: mustRef(t, 'Ask name'), dialog: 'accept', dialog_text: 'Ada' });
  assert.equal(await out(), 'prompt:Ada');
});

test('a dialog left open while idle gives a clear error, and {op:"dialog"} clears it', { skip }, async () => {
  await h.goto('dialogs.html');
  await h.js(`setTimeout(()=>alert('from the user'),10)`);
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(h.observe(), /showing an alert dialog "from the user"/);
  const r = await h.act({ op: 'dialog', accept: true });
  assert.match(r, /alert "from the user" → accepted/);
  mustRef(await h.observe(), 'Save');
});

test('change detection: a dead click says "did NOT change"; a scroll says "changed"', { skip }, async () => {
  const t = await h.goto('tricky.html');
  const dead = await h.act({ op: 'click', ref: mustRef(t, 'Settings') }); // no handler
  assert.match(dead, /page did NOT change/);
  const t2 = await h.goto('layout.html');
  const moved = await h.act({ op: 'scroll', dy: 500 });
  assert.match(moved, /\[page changed\]/, moved.split('\n')[0]);
  void t2;
});

test('a select whose change navigates is applied exactly once and reported honestly', { skip }, async () => {
  const t = await h.goto('nav.html');
  const line = t.split('\n').find((l) => l.includes(' select '));
  assert.ok(line, t);
  const r = await h.act({ op: 'select', ref: line.split(/\s+/)[0], value: 'Tricky' });
  assert.doesNotMatch(r, /unknown ref|option not found/, r);
  assert.match(r, /Tricky/);
});

/* ------------------------------- waiting (settle) ---------------------------- */

for (const q of ['', '?clock']) {
  const tag = q ? ' (page with a ticking clock)' : '';
  test(`a click that fetches returns the fetched results, not a stale table${tag}`, { skip }, async () => {
    const t = await h.goto('async.html' + q);
    const r = await h.act({ op: 'click', ref: mustRef(t, 'Load results') });
    mustRef(r, 'Lyon');
  });
  test(`typing into a debounced search returns its results${tag}`, { skip }, async () => {
    const t = await h.goto('async.html' + q);
    const r = await h.act({ op: 'type', ref: mustRef(t, 'Search'), text: 'Ly' });
    mustRef(r, 'Lyon');
    assert.equal(ref(r, 'London'), null, 'results must be the filtered ones');
  });
  test(`a click that does nothing returns fast${tag}`, { skip }, async () => {
    const t = await h.goto('async.html' + q);
    const t0 = performance.now();
    await h.act({ op: 'click', ref: mustRef(t, 'Search') });
    const ms = performance.now() - t0;
    assert.ok(ms < (q ? 400 : 150), `took ${ms.toFixed(0)}ms`);
  });
}

test('a link to a slow page returns the NEW page', { skip }, async () => {
  const t = await h.goto('async.html');
  const r = await h.act({ op: 'click', ref: mustRef(t, 'Slow page') });
  mustRef(r, 'Slow page button');
});

test('navigate waits for a slow page, returns fast for a fast one, and reports network errors', { skip }, async () => {
  const t = await h.goto('slow.html?delay=900');
  mustRef(t, 'Slow page button');
  const t0 = performance.now();
  await h.goto('widgets.html');
  assert.ok(performance.now() - t0 < 300, `fast navigate took ${(performance.now() - t0).toFixed(0)}ms`);
  await assert.rejects(h.goto('http://127.0.0.1:1/'), /navigation failed: net::ERR_/);
});
