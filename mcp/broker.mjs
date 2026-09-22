#!/usr/bin/env node
// PawBrowse broker — the hub that lets MANY MCP-server sessions share ONE browser.
//
// Two faces:
//   1. A localhost WebSocket server on 127.0.0.1:PORT (default 10577) for the Chrome extension
//      (single connection, last-wins).
//   2. A local IPC server (unix socket / Windows named pipe) for MCP-server "controllers" —
//      one per Claude/editor session. Controllers speak newline-delimited JSON.
//
// The broker routes each session's commands to the extension tagged with the session id; the
// extension keeps a tab group per session, so sessions drive different tabs concurrently.
// Only the broker binds the port — MCP servers never contend for it (they use the IPC socket).

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const posInt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const PORT = posInt(process.env.PAWBROWSE_PORT, 10577);
const HOST = '127.0.0.1';
const MAX_FRAME = 8 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const IDLE_EXIT_MS = posInt(process.env.PAWBROWSE_IDLE_MS, 60000); // exit when no controllers for this long
// Broker-side safety net: drop a pending request if the extension never replies. Kept a margin
// above the controller's own command timeout so it only fires when the controller's is gone/stuck.
const PENDING_TTL_MS = posInt(process.env.PAWBROWSE_TIMEOUT_MS, 30000) + 10000;

export function brokerSock(port) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\pawbrowse-${port}`
    : path.join(os.tmpdir(), `pawbrowse-${port}.sock`);
}
const SOCK = brokerSock(PORT);
const log = (...a) => process.stderr.write(`[pawbrowse-broker] ${a.join(' ')}\n`);

/* ------------------------------- state ------------------------------- */
let extension = null;                 // { send, socket }
const controllers = new Map();        // ctrlSocket -> { session }
const pending = new Map();            // brokerReqId -> { ctrlSocket, ctrlId }
let nextReqId = 1;
let idleTimer = null;
let ownsSock = false; // set once we successfully bind the IPC socket, so only the owner unlinks it

// Reap the broker when there are NO sessions (controllers) for a while — even if the Chrome
// extension is still connected. Otherwise the broker would live for as long as Chrome is open.
// When the next session starts it spawns a fresh broker and the extension reconnects to it.
function scheduleIdleExit() {
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (controllers.size === 0) { log('idle (no sessions); exiting'); cleanupAndExit(0); }
  }, IDLE_EXIT_MS);
  idleTimer.unref?.();
}
function cancelIdleExit() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

function cleanupAndExit(code) {
  try { if (ownsSock && process.platform !== 'win32') fs.unlinkSync(SOCK); } catch {}
  process.exit(code);
}

/* --------------------------- WebSocket (extension) --------------------------- */

function makeWs(socket) {
  let buf = Buffer.alloc(0), fragChunks = [], fragLen = 0;
  const send = (str) => {
    const payload = Buffer.from(str, 'utf8'); const len = payload.length; let header;
    if (len < 126) header = Buffer.from([0x81, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(Math.floor(len / 2 ** 32), 2); header.writeUInt32BE(len >>> 0, 6); }
    try { socket.write(Buffer.concat([header, payload])); } catch {}
  };
  const sendCtl = (opcode, payload = Buffer.alloc(0)) => { try { socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])); } catch {} };
  const self = { send, socket, ping: () => sendCtl(0x9) };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1], fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (buf.length < offset + 2) return; len = buf.readUInt16BE(offset); offset += 2; }
      else if (len === 127) { if (buf.length < offset + 8) return; len = buf.readUInt32BE(offset) * 2 ** 32 + buf.readUInt32BE(offset + 4); offset += 8; }
      let mask; if (masked) { if (buf.length < offset + 4) return; mask = buf.slice(offset, offset + 4); offset += 4; }
      if ((opcode & 0x8) && (len > 125 || !fin)) { socket.destroy(); return; }
      if (len > MAX_FRAME) { socket.destroy(); return; }
      if (buf.length < offset + len) return;
      let payload = buf.slice(offset, offset + len);
      if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      buf = buf.slice(offset + len);
      if (opcode === 0x8) { sendCtl(0x8); socket.end(); return; }
      if (opcode === 0x9) { sendCtl(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x0) { fragChunks.push(payload); fragLen += len; if (fragLen > MAX_FRAME) { socket.destroy(); return; } if (fin) { onExtensionMessage(Buffer.concat(fragChunks).toString('utf8'), self); fragChunks = []; fragLen = 0; } continue; }
      if (opcode === 0x1 || opcode === 0x2) { if (fin) onExtensionMessage(payload.toString('utf8'), self); else { fragChunks = [payload]; fragLen = len; } continue; }
    }
  });
  return self;
}

function onExtensionMessage(text, wsObj) {
  if (wsObj !== extension) return; // trust only the current extension socket
  let msg; try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === 'hello') { log(`extension connected (${msg.ext || 'unknown'})`); return; }
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  sendToController(p.ctrlSocket, { t: 'res', id: p.ctrlId, ok: !!msg.ok, result: msg.result, error: msg.error });
}

const httpServer = http.createServer((req, res) => { res.writeHead(426); res.end('Upgrade required'); });
httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const origin = req.headers.origin || '';
  if (origin && !origin.startsWith('chrome-extension://')) { log(`rejected WS origin: ${origin}`); socket.destroy(); return; }
  const prev = extension;
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = makeWs(socket);
  extension = ws;
  if (prev && prev.socket && prev.socket !== socket) {
    try { prev.socket.destroy(); } catch {}
    // The old extension owned the in-flight broker req ids; the new one won't know them and will
    // never reply. Fail those now so callers fail fast instead of waiting out the 30s timeout.
    failAllPending('extension reconnected (previous connection replaced)');
  }
  broadcastStatus();
  socket.on('close', () => { if (extension === ws) { extension = null; failAllPending('extension disconnected'); log('extension disconnected'); broadcastStatus(); } });
  socket.on('error', () => {});
});
setInterval(() => { if (extension) extension.ping(); }, 10000).unref?.();

/* ----------------------------- IPC (controllers) ----------------------------- */

function sendToController(sock, obj) { try { sock.write(JSON.stringify(obj) + '\n'); } catch {} }
function broadcastStatus() {
  for (const [sock] of controllers) sendToController(sock, { t: 'status', extension_connected: !!extension });
}
function failAllPending(reason) {
  for (const [, p] of pending) { clearTimeout(p.timer); sendToController(p.ctrlSocket, { t: 'res', id: p.ctrlId, ok: false, error: reason }); }
  pending.clear();
}

const ipcServer = net.createServer((sock) => {
  cancelIdleExit();
  controllers.set(sock, { session: null });
  let sbuf = '';
  sock.on('data', (d) => {
    sbuf += d.toString();
    let nl;
    while ((nl = sbuf.indexOf('\n')) >= 0) {
      const line = sbuf.slice(0, nl).trim(); sbuf = sbuf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      handleController(sock, msg);
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    const info = controllers.get(sock);
    controllers.delete(sock);
    // Drop any of this controller's in-flight requests so we don't leak them or reply to a dead socket.
    for (const [rid, p] of pending) if (p.ctrlSocket === sock) { clearTimeout(p.timer); pending.delete(rid); }
    // Tell the extension to clean up this session's tab group (its own created tabs).
    if (info && info.session && extension) {
      try { extension.send(JSON.stringify({ id: nextReqId++, cmd: '__session_end', args: {}, session: info.session })); } catch {}
    }
    if (controllers.size === 0) scheduleIdleExit();
  });
});

function handleController(sock, msg) {
  if (msg.t === 'hello') {
    const info = controllers.get(sock); if (info) info.session = msg.session || `s${Math.random().toString(36).slice(2, 8)}`;
    sendToController(sock, { t: 'welcome', session: info?.session, extension_connected: !!extension });
    return;
  }
  if (msg.t === 'cmd') {
    const info = controllers.get(sock);
    if (!extension) { sendToController(sock, { t: 'res', id: msg.id, ok: false, error: 'No Chrome extension connected. Load the PawBrowse extension in Chrome.' }); return; }
    const brokerReqId = nextReqId++;
    const timer = setTimeout(() => {
      const p = pending.get(brokerReqId);
      if (!p) return;
      pending.delete(brokerReqId);
      sendToController(p.ctrlSocket, { t: 'res', id: p.ctrlId, ok: false, error: 'extension did not reply in time' });
    }, PENDING_TTL_MS);
    timer.unref?.();
    pending.set(brokerReqId, { ctrlSocket: sock, ctrlId: msg.id, timer });
    try { extension.send(JSON.stringify({ id: brokerReqId, cmd: msg.cmd, args: msg.args || {}, session: info?.session })); }
    catch (e) { clearTimeout(timer); pending.delete(brokerReqId); sendToController(sock, { t: 'res', id: msg.id, ok: false, error: String(e && e.message || e) }); }
  }
}

/* --------------------------------- startup --------------------------------- */

function startIpc() {
  // Remove a stale socket file, then listen.
  try { if (process.platform !== 'win32' && fs.existsSync(SOCK)) fs.unlinkSync(SOCK); } catch {}
  ipcServer.on('error', (e) => { log(`ipc error: ${e.message}`); cleanupAndExit(1); });
  ipcServer.listen(SOCK, () => {
    ownsSock = true;
    try { if (process.platform !== 'win32') fs.chmodSync(SOCK, 0o600); } catch {} // owner-only
    log(`controller socket at ${SOCK}`);
  });
}

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`port ${PORT} already in use — another broker is running; exiting`); process.exit(0); }
  log(`bridge error: ${e.message}`); cleanupAndExit(1);
});
httpServer.listen(PORT, HOST, () => { log(`broker listening on ws://${HOST}:${PORT}`); startIpc(); });

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('uncaughtException', (e) => log(`uncaughtException: ${(e && e.stack) || e}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${(e && e.stack) || e}`));
scheduleIdleExit();
