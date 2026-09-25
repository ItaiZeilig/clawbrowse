// The REAL thing: Chrome for Testing loads the unpacked extension/ (branded Chrome no longer allows
// --load-extension) and we drive it through the real MCP server over stdio, exactly like Claude Code.
// This covers what the chrome.debugger shim can't: the extension API's own rules (child-frame
// sessionId, setFileInputFiles permissions, service-worker OffscreenCanvas...).
//
//   CFT_PATH="/path/to/Google Chrome for Testing" npm run test:e2e
//   (npx @puppeteer/browsers install chrome@stable  prints that path)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './harness.mjs';
import { startServer, initialize, freePort, sleep } from '../helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, '..', '..', 'extension');
const CFT = process.env.CFT_PATH && fs.existsSync(process.env.CFT_PATH) ? process.env.CFT_PATH : null;
const skip = CFT ? false : 'set CFT_PATH to a Chrome for Testing binary to run the real-extension suite';

let chrome, profile, server, srv, port, base, xbase, rpcId = 100;

async function cdpConnect(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  return { send: (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, sessionId })); return new Promise((res, rej) => pend.set(i, { res, rej })); }, close: () => ws.close() };
}

async function call(name, args = {}, ms = 30000) {
  const id = ++rpcId;
  srv.rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const r = (await srv.waitFor(id, ms)).result;
  if (r.isError) throw new Error(r.content[0].text);
  return r.content;
}
const text = async (name, args) => (await call(name, args)).map((c) => c.text || '').join('\n');
const refOf = (t, label) => { const l = String(t).split('\n').find((x) => x.includes(`"${label}"`)); assert.ok(l, `no "${label}" in:\n${t}`); return l.trim().split(/\s+/)[0]; };
const contains = async (s) => JSON.parse(await text('browser_assert', { contains: s })).pass;

before(async () => {
  if (skip) return;
  server = await serve();
  const p = server.address().port; base = `http://127.0.0.1:${p}/`; xbase = `http://localhost:${p}/`;
  port = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pawbrowse-ext-'));
  chrome = spawn(CFT, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,800', '--site-per-process', '--enable-features=WebMCPTesting', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'], { stdio: 'ignore' });
  const pf = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(pf); i++) await sleep(100);
  const [dport, wsPath] = fs.readFileSync(pf, 'utf8').trim().split('\n');
  const cdp = await cdpConnect(`ws://127.0.0.1:${dport}${wsPath}`);
  // Point the extension at our private port (so it never touches a real PawBrowse on 10577).
  // Find OUR service worker (Chrome for Testing has a component extension with a background.js too).
  let sessionId;
  for (let i = 0; i < 50 && !sessionId; i++) {
    for (const t of (await cdp.send('Target.getTargets')).targetInfos) {
      if (t.type !== 'service_worker' || !t.url.startsWith('chrome-extension://')) continue;
      const s = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      const r = await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, s).catch(() => null);
      if (r && /PawBrowse/i.test(String(r.result.value))) { sessionId = s; break; }
    }
    if (!sessionId) await sleep(100);
  }
  assert.ok(sessionId, 'PawBrowse service worker not found');
  // The service worker is an ES module (its bindings aren't globals): store the port, then reload the
  // extension so it starts fresh and connects to it.
  await cdp.send('Runtime.evaluate', { expression: `chrome.storage.local.set({port:${port}})`, awaitPromise: true }, sessionId);
  await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, sessionId).catch(() => {});
  cdp.close();
  srv = startServer({ PAWBROWSE_PORT: String(port) });
  await initialize(srv);
  for (let i = 0; i < 60; i++) { const s = JSON.parse(await text('browser_status')); if (s.extension_connected && s.ext_version) break; await sleep(250); }
});
after(async () => { try { srv && srv.kill(); } catch {} try { chrome && chrome.kill('SIGKILL'); } catch {} try { server && server.close(); } catch {} });

test('real extension: connects through the real MCP server', { skip }, async () => {
  const s = JSON.parse(await text('browser_status'));
  assert.equal(s.extension_connected, true, JSON.stringify(s));
});

test('real extension: styled checkbox, date field and hidden-text-free labels', { skip }, async () => {
  const t = await text('browser_navigate', { url: base + 'widgets.html' });
  const r = await text('browser_act', { ops: [{ op: 'click', ref: refOf(t, 'Free WiFi') }, { op: 'type', ref: refOf(t, 'Departure'), text: '2026-12-25' }] });
  assert.match(r, /set to "2026-12-25"/);
  assert.ok(await contains('date:2026-12-25'));
  assert.match(await text('browser_observe'), /✓ "Free WiFi"/);
});

test('real extension: cross-site iframe (child session via chrome.debugger sessionId)', { skip }, async () => {
  const t = await text('browser_navigate', { url: base + 'frames.html' });
  assert.match(t, /frame f\d+ "localhost:\d+"/, t);
  const line = t.split('\n').find((l) => /^f\d+\.e\d+/.test(l) && l.includes('"Cross button"'));
  await text('browser_act', { ops: [{ op: 'click', ref: line.split(/\s+/)[0] }] });
  assert.ok(await contains('cross clicked'), 'click inside the OOPIF reached it');
});

test('real extension: dialogs are answered, not hung', { skip }, async () => {
  const t = await text('browser_navigate', { url: base + 'dialogs.html' });
  const r = await text('browser_act', { ops: [{ op: 'click', ref: refOf(t, 'Delete account') }] });
  assert.match(r, /confirm "Really delete\?" → dismissed/);
});

test('real extension: closed shadow root, hover menu, html5 drag', { skip }, async () => {
  let t = await text('browser_navigate', { url: base + 'shadow.html' });
  await text('browser_act', { ops: [{ op: 'click', ref: refOf(t, 'Closed shadow button') }] });
  assert.ok(await contains('closed clicked'));
  t = await text('browser_navigate', { url: base + 'interact.html' });
  const r = await text('browser_act', { ops: [{ op: 'hover', ref: refOf(t, 'Account') }] });
  await text('browser_act', { ops: [{ op: 'click', ref: refOf(r, 'Settings item') }] });
  assert.ok(await contains('settings'));
  const t2 = await text('browser_observe');
  const d = await text('browser_act', { ops: [{ op: 'drag', ref: refOf(t2, 'Card A'), to_text: 'Done column' }] });
  assert.ok(await contains('dropped cardA'), d);
});

test('real extension: WebMCP tools listed and called', { skip }, async () => {
  const t = await text('browser_navigate', { url: base + 'webmcp.html' });
  assert.match(t, /tool add_to_cart\(sku\*: string, qty: number\)/, t);
  const r = await text('browser_act', { ops: [{ op: 'tool', name: 'add_to_cart', input: { sku: 'Z-9' } }] });
  assert.match(r, /Completed/);
  assert.ok(await contains('cart Z-9 x1'));
});

test('real extension: screenshot comes back as an image with ref labels', { skip }, async () => {
  await text('browser_navigate', { url: base + 'tricky.html' });
  const c = await call('browser_screenshot', {});
  assert.equal(c[0].type, 'image');
  assert.match(c[1].text, /controls labelled with their refs/, c[1].text);
  if (process.env.SHOT_OUT) fs.writeFileSync(process.env.SHOT_OUT, Buffer.from(c[0].data, 'base64'));
});

test('real extension: file upload (reports Chrome\'s file-URL permission clearly if blocked)', { skip }, async () => {
  const f = path.join(os.tmpdir(), `pawbrowse-up-${process.pid}.txt`); fs.writeFileSync(f, 'x');
  try {
    const t = await text('browser_navigate', { url: base + 'widgets.html' });
    const r = await text('browser_act', { ops: [{ op: 'upload', ref: refOf(t, 'Upload CV'), paths: [f] }] });
    if (/Allow access to file URLs/.test(r)) return; // expected without that extension setting
    assert.match(r, /upload e\d+ \(1 file\)/, r);
    assert.ok(await contains(`file:${path.basename(f)}`));
  } finally { fs.rmSync(f, { force: true }); }
});
