// Live pitfall checks against UI Testing Playground (uitestingplayground.com, Apache-2.0, built by
// the Rapise team specifically to break test/automation tools). Each scenario acts through the
// shipped PawBrowse engine and checks the outcome from the page itself.
//
//   node scripts/hunt/playground.mjs [scenario ...]

import { launch, ref } from '../../test/e2e/harness.mjs';

const BASE = 'http://uitestingplayground.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (t, re) => String(t).split('\n').find((l) => /^(f\d+\.)?e\d/.test(l) && re.test(l)); // table rows only
const id = (l) => l && l.split(/\s+/)[0];
const must = (t, re) => { const l = row(t, re); if (!l) throw new Error(`no row ${re} in:\n${String(t).slice(0, 1200)}`); return id(l); };

const SCENARIOS = {
  // A covering layer appears after the first click: the second click must NOT reach the green button.
  async hiddenlayers(h) {
    const t = await h.goto(`${BASE}/hiddenlayers`);
    const g = must(t, /click\s+"Button"/);
    const r1 = await h.act({ op: 'click', ref: g });
    const r2 = await h.act({ op: 'click', ref: g });
    const warned = await h.js(`!!document.querySelector('.bg-warning')`);
    if (warned) throw new Error(`the covered green button was clicked a second time:\n${r2.split('\n').slice(0, 3).join('\n')}`);
    return `second click refused: ${(r2.split('\n')[1] || '').trim()}`; void r1;
  },
  // The button ignores DOM click() and needs a real mouse event sequence.
  async click(h) {
    const t = await h.goto(`${BASE}/click`);
    await h.act({ op: 'click', ref: must(t, /"Button That Ignores DOM Click Event"/) });
    if (!(await h.js(`document.querySelector('#badButton').classList.contains('btn-success')`))) throw new Error('button did not register a physical click');
    return 'physical click registered';
  },
  // Typing must fire real input events: the button takes the typed name.
  async textinput(h) {
    const t = await h.goto(`${BASE}/textinput`);
    const r = await h.act({ op: 'type', ref: must(t, /fill\s+"Set New Button Name"/), text: 'PawBrowse' }, { op: 'click', ref: must(t, /"Button That Should Change it's Name Based on Input Value"/) });
    const txt = await h.js(`document.querySelector('#updatingButton').textContent`);
    if (txt !== 'PawBrowse') throw new Error(`button text is "${txt}"`); void r;
    return 'button renamed from typed input';
  },
  // A button hidden inside a scrollable container.
  async scrollbars(h) {
    const t = await h.goto(`${BASE}/scrollbars`);
    await h.act({ op: 'click', ref: must(t, /"Hiding Button"/) });
    return 'clicked inside scroll area';
  },
  // After "Hide", each button is hidden a different way. Only the offscreen one may stay listed
  // (as off-screen), the overlapped one must be flagged covered, and none may be plain clickable.
  async visibility(h) {
    const t = await h.goto(`${BASE}/visibility`);
    const r = await h.act({ op: 'click', ref: must(t, /click\s+"Hide"/) });
    const table = await h.observe();
    const bad = [];
    for (const name of ['Removed', 'Zero Width', 'Opacity 0', 'Visibility Hidden', 'Display None']) {
      const l = row(table, new RegExp(`"${name}"`)); if (l) bad.push(`listed after hiding: ${l.trim()}`);
    }
    const ov = row(table, /"Overlapped"/); if (ov && !/covered/.test(ov)) bad.push(`overlapped not flagged: ${ov.trim()}`);
    const off = row(table, /"Offscreen"/); if (off && !/[↑↓↕]|covered/.test(off)) bad.push(`offscreen listed as on-screen: ${off.trim()}`);
    if (bad.length) throw new Error(bad.join('\n')); void r;
    return 'every hiding technique handled';
  },
  // The link is re-rendered on hover (DOM replaced): two clicks must both count.
  async mouseover(h) {
    const t = await h.goto(`${BASE}/mouseover`);
    const l = must(t, /"Click me"/);
    await h.act({ op: 'click', ref: l }, { op: 'click', ref: l });
    const n = await h.js(`document.querySelector('#clickCount').textContent`);
    if (n !== '2') throw new Error(`click count is ${n}`);
    return 'two clicks counted across hover re-render';
  },
  async nbsp(h) {
    const t = await h.goto(`${BASE}/nbsp`);
    if (!row(t, /"My Button"/)) throw new Error('button with non-breaking space not found by its visible text');
    return 'nbsp label normalized';
  },
  // An input half-covered by another element inside a scroll box.
  async overlapped(h) {
    const t = await h.goto(`${BASE}/overlapped`);
    await h.act({ op: 'type', ref: must(t, /fill\s+"Name"/), text: 'Paw' });
    const v = await h.js(`document.querySelector('#name').value`);
    if (v !== 'Paw') throw new Error(`name field value is "${v}"`);
    return 'typed into partially overlapped input';
  },
  async shadowdom(h) {
    const t = await h.goto(`${BASE}/shadowdom`);
    await h.act({ op: 'click', ref: must(t, /click\s+"(button|icon:.*|Generate.*)"|"#buttonGenerate"|generate/i) });
    const v = await h.js(`document.querySelector('guid-generator').shadowRoot.querySelector('#editField').value`);
    if (!/^[0-9a-f-]{36}$/i.test(v)) throw new Error(`guid field is "${v}"`);
    return `guid generated in shadow DOM (${v.slice(0, 8)}…)`;
  },
  async alerts(h) {
    const t = await h.goto(`${BASE}/alerts`);
    const r = await h.act({ op: 'click', ref: must(t, /"Alert"/) }, { op: 'click', ref: must(t, /"Confirm"/) }, { op: 'click', ref: must(t, /"Prompt"/), dialog: 'accept', dialog_text: 'Paw' });
    await sleep(1200);
    const after = await h.observe(); // the page raises a follow-up alert once the confirm is answered
    const lines = r.split('\n').filter((l) => /dialog:/.test(l)).length + after.split('\n').filter((l) => /dialog:/.test(l)).length;
    if (lines < 4) throw new Error(`expected dialogs answered, got:\n${r.split('\n').slice(0, 8).join('\n')}`);
    return `${lines} dialogs answered without hanging`;
  },
  // The target spins after "Start Animation"; clicking it after the animation must hit.
  async animation(h) {
    const t = await h.goto(`${BASE}/animation`);
    await h.act({ op: 'click', ref: must(t, /"Start Animation"/) });
    const t2 = await h.observe();
    await h.act({ op: 'click', ref: must(t2, /"Moving Target"/) });
    const cls = await h.js(`document.querySelector('#movingTarget').className`);
    if (/spin/.test(cls)) throw new Error(`clicked while still animating: class "${cls}"`);
    return 'clicked after the animation finished';
  },
  // The input is enabled 5s after the button: typing early must be refused, typing later must work.
  async disabledinput(h) {
    const t = await h.goto(`${BASE}/disabledinput`);
    const early = await h.act({ op: 'click', ref: must(t, /"Enable Edit Field with 5 seconds delay"/) });
    const t2 = await h.observe();
    const inputRow = row(t2, /fill\s+"Edit Field"|"inputField"/);
    if (inputRow) throw new Error(`disabled field listed as fillable: ${inputRow}`);
    await sleep(5500);
    const t3 = await h.observe();
    await h.act({ op: 'type', ref: must(t3, /fill\s+"(Edit Field|inputField)"/), text: 'ok' });
    const v = await h.js(`document.querySelector('#inputField').value`);
    if (v !== 'ok') throw new Error(`field value "${v}"`); void early;
    return 'disabled field hidden until enabled, then typed';
  },
  async scrolltoclick(h) {
    const t = await h.goto(`${BASE}/scrolltoclick`);
    const f = await h.cmd('observe', { find: 'Button 1' });
    await h.act({ op: 'click', ref: must(f, /"Button 1"/) });
    if (!(await h.js(`document.querySelector('#scrollTarget1').classList.contains('btn-success')`))) throw new Error('button 1 not clicked');
    return 'far-below button found with find and clicked';
  },
  async clearinput(h) {
    const t = await h.goto(`${BASE}/clearinput`);
    await h.act({ op: 'type', ref: must(t, /fill\s+/), text: 'fresh' });
    const v = await h.js(`document.querySelector('input').value`);
    if (v !== 'fresh') throw new Error(`value "${v}" (old text not replaced)`);
    return 'existing text replaced';
  },
  async frames(h) {
    const t = await h.goto(`${BASE}/frames`);
    // Same-origin frames are read inline (plain refs); cross-origin ones as f<N>.e<K>.
    const buttons = String(t).split('\n').filter((l) => /^(f\d+\.)?e\d+\s+click\s+.?\s*"(Edit|Submit|Click me|Primary)"/.test(l));
    if (!buttons.length) throw new Error(`no buttons read inside frames:\n${t.slice(0, 800)}`);
    await h.act({ op: 'click', ref: id(buttons[0]) });
    return `${buttons.length} controls read inside frames; clicked one`;
  },
  // The table's column order changes on every load: read must report the right value.
  async dynamictable(h) {
    await h.goto(`${BASE}/dynamictable`);
    const read = await h.cmd('read');
    const expect = await h.js(`document.querySelector('.bg-warning').textContent.replace('Chrome CPU: ','')`);
    if (!read.includes(expect)) throw new Error(`read lacks the Chrome CPU value ${expect}`);
    return `read shows Chrome CPU ${expect}`;
  },
  async loaddelay(h) {
    const t = await h.goto(`${BASE}/home`);
    const r = await h.act({ op: 'click', ref: must(t, /"Load Delay"/) });
    if (!row(r, /"Button Appearing After Delay"/)) throw new Error('act returned before the delayed page arrived');
    return 'slow page awaited';
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
const h = await launch();
let failed = 0;
try {
  for (const n of names) {
    const t0 = Date.now();
    try { const msg = await SCENARIOS[n](h); console.log(`PASS ${n.padEnd(14)} ${String(Date.now() - t0).padStart(5)}ms  ${msg}`); }
    catch (e) { failed++; console.log(`FAIL ${n.padEnd(14)} ${String(Date.now() - t0).padStart(5)}ms  ${String(e.message || e).split('\n').slice(0, 4).join(' | ')}`); }
  }
} finally { await h.close(); }
process.exitCode = failed ? 1 : 0;
