// Real-browser harness for the extension's perception + action code. Zero-dependency.
//
// Loads the UNMODIFIED extension/background.js into a vm context with a small `chrome.*` shim whose
// chrome.debugger forwards to a headless Chrome over CDP (flat sessions, one per tab). So the
// exact SNAPSHOT / resolveHit / runOp / handleCommand code that ships is what gets exercised.
//
// Fixtures are served twice: on 127.0.0.1 (the "main" origin) and on localhost (a different SITE,
// so iframes from it are genuinely cross-origin out-of-process frames under site isolation).

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const BACKGROUND = process.env.PAWBROWSE_BG || path.join(__dirname, '..', '..', 'extension', 'background.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const c = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  }[process.platform] || [];
  return c.find((p) => fs.existsSync(p)) || null;
}

export function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const file = path.join(FIXTURES, path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, ''));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    const delay = Number(u.searchParams.get('delay') || 0);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    }, delay);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.listeners = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res; this.ws.onerror = rej;
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id != null && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        } else if (m.method) for (const l of this.listeners) l(m);
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch {} }
}

export async function launch(opts = {}) {
  const exe = chromePath();
  if (!exe) throw new Error('Chrome not found (set CHROME_PATH)');
  const server = await serve();
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pawbrowse-e2e-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1200,800', '--site-per-process',
    ...(process.env.CI ? ['--no-sandbox'] : []), ...(process.env.PAW_CHROME_ARGS ? process.env.PAW_CHROME_ARGS.split(' ') : []), ...(opts.args || []), 'about:blank'],
  { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const [dport, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = new Cdp(`ws://127.0.0.1:${dport}${wsPath}`);
  await cdp.open();

  const tabs = new Map(); // tabId -> { targetId, sessionId }
  let nextTab = 1, activeTabId = null;

  async function newTab(url = 'about:blank') {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const id = nextTab++;
    tabs.set(id, { targetId, sessionId });
    activeTabId = id;
    return id;
  }
  async function tabInfo(id) {
    const t = tabs.get(id); if (!t) throw new Error('no tab');
    const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId: t.targetId });
    return { id, url: targetInfo.url, title: targetInfo.title, active: id === activeTabId, windowId: 1 };
  }

  // ---- chrome.* shim ----
  const lastErr = { value: undefined };
  const noopEvent = { addListener() {} };
  // chrome.debugger.onEvent: route flat-session CDP events back to the tab that owns the session.
  const eventListeners = [];
  const childToTab = new Map(); // auto-attached child (iframe) session -> tabId
  cdp.listeners.push((m) => {
    let src = null;
    for (const [tabId, t] of tabs) if (t.sessionId === m.sessionId) src = { tabId };
    if (!src && childToTab.has(m.sessionId)) src = { tabId: childToTab.get(m.sessionId), sessionId: m.sessionId };
    if (!src) return;
    if (process.env.PAW_TRACE && /^Page\.|Target\.attached|^WebMCP/.test(m.method) && !src.sessionId) console.error(Date.now() % 100000, m.method, JSON.stringify(m.params).slice(0, 140));
    if (m.method === 'Target.attachedToTarget') childToTab.set(m.params.sessionId, src.tabId);
    for (const l of eventListeners) l(src, m.method, m.params);
  });
  const chrome = {
    runtime: {
      get lastError() { return lastErr.value; }, id: 'e2e', getManifest: () => ({ version: 'e2e' }),
      onStartup: noopEvent, onInstalled: noopEvent, onMessage: noopEvent,
    },
    debugger: {
      attach(_t, _v, cb) { cb(); },
      detach(_t, cb) { cb && cb(); },
      sendCommand({ tabId, sessionId }, method, params, cb) {
        const t = tabs.get(tabId);
        if (!t) { lastErr.value = { message: 'No tab with given id' }; cb(); lastErr.value = undefined; return; }
        cdp.send(method, params, sessionId || t.sessionId).then(
          (r) => { cb(r); },
          (e) => { lastErr.value = { message: e.message }; try { cb(); } finally { lastErr.value = undefined; } },
        );
      },
      onDetach: noopEvent,
      onEvent: { addListener(fn) { eventListeners.push(fn); } },
    },
    tabs: {
      async query() { return activeTabId ? [await tabInfo(activeTabId)] : []; },
      get: tabInfo,
      async create({ url }) { return tabInfo(await newTab(url)); },
      async remove() {},
      async group() { return 1; },
      async ungroup() {},
      onRemoved: noopEvent,
    },
    tabGroups: { async update() {} },
    storage: { session: { async get() { return {}; }, async set() {} }, local: { async get() { return {}; } } },
    alarms: { create() {}, onAlarm: noopEvent },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  class FakeWS { static CONNECTING = 0; static OPEN = 1; constructor() { this.readyState = 0; } send() {} close() {} }
  const ctx = vm.createContext({
    chrome, WebSocket: FakeWS, navigator: { userAgent: 'Macintosh' }, URL,
    setTimeout, clearTimeout, setInterval, clearInterval, console, JSON, Promise, Error, Math, Number, String, Object, Array, Map, Set,
  });
  vm.runInContext(fs.readFileSync(BACKGROUND, 'utf8'), ctx, { filename: 'background.js' });
  // Tolerant export so older background.js versions (for before/after comparisons) still load.
  const ext = vm.runInContext(`({ ${['handleCommand', 'SNAPSHOT', 'evaluate', 'snapshot', 'childSessions', 'readFrames', 'remoteFrameIds', 'frameOffset']
    .map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} })`, ctx);

  const tab0 = await newTab();
  const h = {
    port,
    url: (p) => `http://127.0.0.1:${port}/${p}`,
    xurl: (p) => `http://localhost:${port}/${p}`, // cross-site origin
    cmd: (name, args = {}) => ext.handleCommand(name, args, { cancelled: false }, 's1'),
    async goto(p) { return h.cmd('navigate', { url: p.startsWith('http') ? p : h.url(p) }); },
    observe: () => h.cmd('observe'),
    act: (...ops) => h.cmd('act', { ops }),
    snap: () => ext.snapshot(activeTabId),
    // Ground truth straight from the page (NOT through PawBrowse's code).
    async js(expr) {
      const t = tabs.get(activeTabId);
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, t.sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    cdp: (m, p) => cdp.send(m, p, tabs.get(activeTabId).sessionId),
    // Evaluate inside PawBrowse's isolated world (what the snapshot sees).
    ev: (expr) => ext.evaluate(activeTabId, expr),
    ext,
    get tabId() { return activeTabId; },
    tab0,
    async close() { cdp.close(); proc.kill('SIGKILL'); server.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
  return h;
}

// Find the ref of the first table row whose label matches (string = exact-insensitive, RegExp).
export function ref(table, label, kind) {
  for (const line of String(table).split('\n')) {
    const m = line.match(/^((?:f\d+\.)?e\d+(?:_\d+)?)\s+(\w+)\s*\S?\s+"(.*?)"/);
    if (!m) continue;
    if (kind && m[2] !== kind) continue;
    const ok = label instanceof RegExp ? label.test(m[3]) : m[3].toLowerCase() === String(label).toLowerCase();
    if (ok) return m[1];
  }
  return null;
}
