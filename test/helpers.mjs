// Shared test helpers for the pawbrowse MCP server + WebSocket bridge.
// Zero-dependency. Requires Node >= 22 (global WebSocket client) for the fake-extension helper;
// the raw-socket helpers use only node:net so they work anywhere.

import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(__dirname, '..', 'mcp', 'server.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Grab a currently-free TCP port on loopback.
export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// Spawn the MCP server. Talk MCP over stdio; collect JSON-RPC replies by id.
export function startServer(env = {}) {
  const proc = spawn('node', [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const byId = new Map();
  const waiters = new Map();
  let obuf = '';
  proc.stdout.on('data', (d) => {
    obuf += d.toString();
    let nl;
    while ((nl = obuf.indexOf('\n')) >= 0) {
      const line = obuf.slice(0, nl).trim(); obuf = obuf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && msg.id !== null) {
        byId.set(msg.id, msg);
        const w = waiters.get(msg.id);
        if (w) { clearTimeout(w.timer); w.resolve(msg); waiters.delete(msg.id); }
      }
    }
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  let exited = null;
  proc.on('exit', (code) => { exited = code; });

  const rpc = (msg) => { try { proc.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
  const waitFor = (id, ms = 4000) => {
    if (byId.has(id)) return Promise.resolve(byId.get(id));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`timeout waiting for reply id=${id}`)); }, ms);
      waiters.set(id, { resolve, timer });
    });
  };
  return {
    proc, rpc, waitFor,
    stderr: () => stderr,
    exitCode: () => exited,
    kill: () => { try { proc.kill('SIGKILL'); } catch {} },
  };
}

// initialize + wait, returns the initialize result.
export async function initialize(srv, id = 1) {
  srv.rpc({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  return (await srv.waitFor(id)).result;
}

// Wait until the bridge is accepting TCP connections (the server takes ~300ms to boot).
export function waitPort(port, ms = 5000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`bridge never came up on port ${port}`));
        else setTimeout(tryOnce, 50);
      });
    };
    tryOnce();
  });
}

// Fake extension over the WS bridge. handler(msg, ws) -> {result} | {ok:false,error} | null (no reply).
// `ready` waits for the bridge to be up first, so tests can create it right after startServer.
export function fakeExtension(port, handler) {
  const state = { ws: null, received: [], closed: false };
  state.ready = (async () => {
    await waitPort(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    state.ws = ws;
    await new Promise((res, rej) => {
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', ext: 'fake' })); res(); };
      ws.onerror = () => rej(new Error('fake extension ws error'));
    });
    ws.onclose = () => { state.closed = true; };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      state.received.push(msg);
      const r = handler ? handler(msg, ws) : { result: `FAKE ${msg.cmd}` };
      if (r) ws.send(JSON.stringify({ id: msg.id, ok: r.ok !== false, result: r.result, error: r.error }));
    };
  })();
  state.close = () => { try { state.ws && state.ws.close(); } catch {} };
  return state;
}

// Raw WebSocket handshake over a TCP socket, so we can set Origin and send crafted frames.
// Resolves { sock, upgraded, head }.
export function rawHandshake(port, { origin } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      let req =
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      if (origin) req += `Origin: ${origin}\r\n`;
      req += '\r\n';
      sock.write(req);
    });
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (upgraded, head) => { if (!settled) { settled = true; resolve({ sock, upgraded, head }); } };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx >= 0) done(/101 Switching Protocols/.test(buf.slice(0, idx).toString()), buf.slice(0, idx).toString());
    });
    sock.on('error', () => done(false, '(error)'));
    sock.on('close', () => done(false, '(closed)'));
    setTimeout(() => done(settled, '(timeout)'), 1500);
  });
}

// Build a masked client WS frame. `declaredLen` overrides the length field (for attack frames).
export function maskedFrame(opcode, payload = Buffer.alloc(0), { fin = true, declaredLen = null } = {}) {
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf8');
  const len = declaredLen != null ? declaredLen : payload.length;
  const b0 = (fin ? 0x80 : 0) | opcode;
  let header;
  if (len < 126) header = Buffer.from([b0, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = b0; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = b0; header[1] = 0x80 | 127; header.writeUInt32BE(Math.floor(len / 2 ** 32), 2); header.writeUInt32BE(len >>> 0, 6); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Wait for a socket to close (attack frames should make the server destroy it).
export function waitClosed(sock, ms = 2000) {
  return new Promise((res) => {
    if (sock.destroyed) return res(true);
    const t = setTimeout(() => res(false), ms);
    sock.on('close', () => { clearTimeout(t); res(true); });
    sock.on('error', () => { clearTimeout(t); res(true); });
  });
}
