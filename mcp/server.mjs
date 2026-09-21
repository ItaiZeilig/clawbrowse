#!/usr/bin/env node
// jevbridge MCP server — zero-dependency.
//
// Two faces:
//   1. An MCP server over stdio (newline-delimited JSON-RPC 2.0) that Claude Code talks to.
//   2. A localhost-only WebSocket bridge (default 127.0.0.1:10577) that the Chrome
//      extension connects to. The extension does the actual CDP driving of your real tabs.
//
// The calling agent (Claude) is the policy. There is no second model and no API key:
// page snapshots flow up to Claude as tool results, nothing is sent to any third party.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.JEVBRIDGE_PORT || 10577);
const HOST = '127.0.0.1';
const CMD_TIMEOUT_MS = Number(process.env.JEVBRIDGE_TIMEOUT_MS || 30000);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const log = (...a) => process.stderr.write(`[jevbridge] ${a.join(' ')}\n`);

/* ------------------------------------------------------------------ *
 * WebSocket bridge (minimal RFC6455: text frames, ping/pong, close)  *
 * ------------------------------------------------------------------ */

let extension = null;          // the currently connected extension socket wrapper
const pending = new Map();     // id -> { resolve, reject, timer }
let nextId = 1;

function makeWs(socket) {
  let buf = Buffer.alloc(0);
  let fragOpcode = null;
  let fragChunks = [];

  const send = (str) => {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    socket.write(Buffer.concat([header, payload]));
  };

  const sendCtl = (opcode, payload = Buffer.alloc(0)) => {
    socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset); offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const hi = buf.readUInt32BE(offset), lo = buf.readUInt32BE(offset + 4);
        len = hi * 2 ** 32 + lo; offset += 8;
      }
      let mask;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.slice(offset, offset + 4); offset += 4;
      }
      if (buf.length < offset + len) return;
      let payload = buf.slice(offset, offset + len);
      if (masked) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.slice(offset + len);

      if (opcode === 0x8) { sendCtl(0x8); socket.end(); return; }      // close
      if (opcode === 0x9) { sendCtl(0xA, payload); continue; }          // ping -> pong
      if (opcode === 0xA) { continue; }                                 // pong
      if (opcode === 0x0) {                                             // continuation
        fragChunks.push(payload);
        if (fin) { handleMessage(Buffer.concat(fragChunks).toString('utf8')); fragOpcode = null; fragChunks = []; }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {                           // text / binary
        if (fin) { handleMessage(payload.toString('utf8')); }
        else { fragOpcode = opcode; fragChunks = [payload]; }
        continue;
      }
    }
  });

  return { send, socket };
}

function handleMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === 'hello') { log(`extension connected (${msg.ext || 'unknown'})`); return; }
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || 'extension error'));
}

function callExtension(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    if (!extension) { reject(new Error('No Chrome extension connected. Load the jevbridge extension in Chrome and make sure it shows "connected".')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`command "${cmd}" timed out after ${CMD_TIMEOUT_MS}ms`)); }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try { extension.send(JSON.stringify({ id, cmd, args })); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}

const httpServer = http.createServer((req, res) => { res.writeHead(426); res.end('Upgrade required'); });

httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = makeWs(socket);
  extension = ws;
  socket.on('close', () => { if (extension === ws) { extension = null; log('extension disconnected'); } });
  socket.on('error', () => {});
});

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`ERROR: port ${PORT} is already in use — a previous jevbridge server may still be running. Exiting.`);
    process.exit(1);
  }
  log(`bridge error: ${e.message}`);
  process.exit(1);
});
httpServer.listen(PORT, HOST, () => log(`bridge listening on ws://${HOST}:${PORT}`));

/* ------------------------------------------------------------------ *
 * MCP server over stdio (newline-delimited JSON-RPC 2.0)             *
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'browser_status',
    description: 'Report bridge + extension connection state and the currently targeted tab. Call this first if anything behaves unexpectedly: it distinguishes "no extension connected" from "no tab attached".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_tabs',
    description: 'List open tabs in the real browser (id, title, url, active). Use a tab id with the other tools to target a specific tab; omit to use the active tab.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the target tab to a URL and return the element table once loaded.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' } }, required: ['url'] },
  },
  {
    name: 'browser_observe',
    description: 'Read the target tab as an element table: one numbered, actionable control per line (e12 btn "Sign in"). Refs (e12) stay stable across observations of the same page. Read this, then act on the refs.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  {
    name: 'browser_read',
    description: 'Read the target tab as plain readable text (article/prose content), for pages where you need the text itself — rules, docs, articles — rather than the element table.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, max_chars: { type: 'number' } } },
  },
  {
    name: 'browser_act',
    description: 'Run a list of operations on the target tab in order, then return the fresh element table. ops: [{op:"click",ref:"e12"} | {op:"click_text",text:"Built with Claude"} (click the most specific visible element matching text, for custom widgets/menus the element table cannot reference) | {op:"type",ref:"e7",text:"..."} | {op:"select",ref:"e8",value:"..."} | {op:"key",key:"Enter"} | {op:"scroll",dy:600} | {op:"wait",ms:500}].',
    inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object' } }, tabId: { type: 'number' } }, required: ['ops'] },
  },
  {
    name: 'browser_assert',
    description: 'Prove an outcome instead of inferring it. Provide one of: contains (page text includes string), url_includes (current url contains string), ref_visible (a ref is present and visible). Returns pass/fail.',
    inputSchema: { type: 'object', properties: { contains: { type: 'string' }, url_includes: { type: 'string' }, ref_visible: { type: 'string' }, tabId: { type: 'number' } } },
  },
];

function textResult(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function callTool(name, args) {
  switch (name) {
    case 'browser_status': {
      const base = { bridge: `ws://${HOST}:${PORT}`, extension_connected: !!extension };
      if (!extension) return textResult(base);
      try { const d = await callExtension('doctor', {}); return textResult({ ...base, ...d }); }
      catch (e) { return textResult({ ...base, note: e.message }); }
    }
    case 'browser_tabs':    return textResult(await callExtension('tabs', {}));
    case 'browser_navigate':return textResult(await callExtension('navigate', args));
    case 'browser_observe': return textResult(await callExtension('observe', args));
    case 'browser_read':    return textResult(await callExtension('read', args));
    case 'browser_act':     return textResult(await callExtension('act', args));
    case 'browser_assert':  return textResult(await callExtension('assert', args));
    default: throw new Error(`unknown tool: ${name}`);
  }
}

function reply(id, result) { if (id !== undefined && id !== null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyError(id, code, message) { if (id !== undefined && id !== null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handleRpc(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'jevbridge', version: '0.1.0' },
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification, no reply
    } else if (method === 'ping') {
      reply(id, {});
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments || {});
        reply(id, result);
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    } else if (id !== undefined && id !== null) {
      replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    replyError(id, -32603, e.message);
  }
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleRpc(msg);
  }
});
// Exit when Claude Code closes the stdio pipe, so the server never lingers as a
// zombie holding the bridge port after the client disconnects.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

log('MCP server ready (stdio)');
