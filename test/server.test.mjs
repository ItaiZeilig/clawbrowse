// Adversarial + regression suite for the pawbrowse MCP server and WebSocket bridge.
// No browser required (a fake extension stands in). Run with: node --test
// Requires Node >= 22 (global WebSocket for the fake extension).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, initialize, fakeExtension, freePort, sleep, waitPort,
  rawHandshake, maskedFrame, waitClosed,
} from './helpers.mjs';

const READONLY = ['browser_status', 'browser_tabs', 'browser_observe', 'browser_read', 'browser_assert'];
const WRITE = ['browser_navigate', 'browser_act'];

/* ------------------------------- MCP protocol ------------------------------ */

test('initialize returns pawbrowse serverInfo and echoes protocolVersion', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    srv.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2030-01-01' } });
    const r = (await srv.waitFor(1)).result;
    assert.equal(r.serverInfo.name, 'pawbrowse');
    assert.ok(r.serverInfo.version, 'serverInfo.version present');
    assert.equal(r.protocolVersion, '2030-01-01', 'echoes client protocolVersion');
    assert.ok(r.capabilities && r.capabilities.tools, 'advertises tools capability');
  } finally { srv.kill(); }
});

test('tools/list returns 7 tools with valid annotations and correct hints', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (await srv.waitFor(2)).result.tools;
    assert.equal(tools.length, 7);
    for (const t of tools) {
      assert.ok(t.name && t.description && t.inputSchema, `${t.name} has core fields`);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.annotations && typeof t.annotations.title === 'string', `${t.name} has annotation title`);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of READONLY) assert.equal(byName[n].annotations.readOnlyHint, true, `${n} readOnlyHint`);
    for (const n of WRITE) assert.notEqual(byName[n].annotations.readOnlyHint, true, `${n} not read-only`);
    assert.equal(byName.browser_act.annotations.destructiveHint, true, 'act is destructive');
  } finally { srv.kill(); }
});

test('ping returns an empty result', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
    const r = await srv.waitFor(3);
    assert.deepEqual(r.result, {});
  } finally { srv.kill(); }
});

test('unknown method returns -32601', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 4, method: 'no/such/method' });
    const r = await srv.waitFor(4);
    assert.equal(r.error.code, -32601);
  } finally { srv.kill(); }
});

test('malformed tools/call (missing name) returns -32602', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} });
    const r = await srv.waitFor(5);
    assert.equal(r.error.code, -32602);
  } finally { srv.kill(); }
});

test('unknown tool name returns an isError tool result', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'browser_nope', arguments: {} } });
    const r = await srv.waitFor(6);
    assert.equal(r.result.isError, true);
  } finally { srv.kill(); }
});

test('notifications (no id) never get a reply', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // If it wrongly replied, the next id would collide; just assert a normal call still works.
    srv.rpc({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepEqual((await srv.waitFor(7)).result, {});
  } finally { srv.kill(); }
});

/* ------------------------------- no extension ------------------------------ */

test('browser_status works with no extension and does not hang', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'browser_status', arguments: {} } });
    const r = await srv.waitFor(8, 3000);
    const body = JSON.parse(r.result.content[0].text);
    assert.equal(body.extension_connected, false);
    assert.match(body.bridge, /127\.0\.0\.1/);
  } finally { srv.kill(); }
});

test('a driving tool with no extension errors clearly and fast', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } });
    const r = await srv.waitFor(9, 3000);
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /extension/i);
  } finally { srv.kill(); }
});

/* --------------------------- round-trip w/ extension ----------------------- */

test('observe round-trips through the extension', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  const ext = fakeExtension(port, (m) => ({ result: `FAKE ${m.cmd}` }));
  try {
    await ext.ready; await sleep(50);
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } });
    const r = await srv.waitFor(10);
    assert.equal(r.result.content[0].text, 'FAKE observe');
    assert.ok(ext.received.some((m) => m.cmd === 'observe'));
  } finally { ext.close(); srv.kill(); }
});

test('an extension-side error propagates as isError', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  const ext = fakeExtension(port, () => ({ ok: false, error: 'boom from extension' }));
  try {
    await ext.ready; await sleep(50);
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'browser_act', arguments: { ops: [] } } });
    const r = await srv.waitFor(11);
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /boom from extension/);
  } finally { ext.close(); srv.kill(); }
});

test('concurrent calls are correlated to their own results (even replied out of order)', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  // Reply to the first-seen command LAST, to force out-of-order replies.
  const queue = [];
  const ext = fakeExtension(port, (m, ws) => {
    queue.push(m);
    if (queue.length === 2) {
      // reply in reverse order
      ws.send(JSON.stringify({ id: queue[1].id, ok: true, result: `R:${queue[1].cmd}` }));
      ws.send(JSON.stringify({ id: queue[0].id, ok: true, result: `R:${queue[0].cmd}` }));
    }
    return null;
  });
  try {
    await ext.ready; await sleep(50);
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } });
    srv.rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } });
    const [a, b] = await Promise.all([srv.waitFor(20), srv.waitFor(21)]);
    assert.equal(a.result.content[0].text, 'R:tabs');
    assert.equal(b.result.content[0].text, 'R:observe');
  } finally { ext.close(); srv.kill(); }
});

/* ------------------------------- the fixes -------------------------------- */

test('extension disconnecting mid-command fails the call fast (not after the 30s timeout)', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  // On receiving a command, close the socket WITHOUT replying.
  const ext = fakeExtension(port, (_m, ws) => { setTimeout(() => { try { ws.close(); } catch {} }, 20); return null; });
  try {
    await ext.ready; await sleep(50);
    await initialize(srv);
    const t0 = Date.now();
    srv.rpc({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } });
    const r = await srv.waitFor(30, 8000);
    const dt = Date.now() - t0;
    assert.equal(r.result.isError, true);
    assert.ok(dt < 5000, `should fail fast on disconnect, took ${dt}ms`);
    assert.match(r.result.content[0].text, /disconnect/i);
  } finally { ext.close(); srv.kill(); }
});

test('last-wins: a newly connected extension takes over command delivery', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  const extA = fakeExtension(port, () => ({ result: 'A' }));
  await extA.ready; await sleep(50);
  const extB = fakeExtension(port, () => ({ result: 'B' }));
  await extB.ready; await sleep(100);
  try {
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } });
    const r = await srv.waitFor(40);
    assert.equal(r.result.content[0].text, 'B', 'newest extension handles commands');
    assert.ok(extB.received.some((m) => m.cmd === 'observe'));
  } finally { extA.close(); extB.close(); srv.kill(); }
});

test('port already in use: second server stays alive and reports bridge_error', async () => {
  const port = await freePort();
  const srv1 = startServer({ PAWBROWSE_PORT: String(port) });
  await waitPort(port); // srv1 owns the port
  const srv2 = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    // srv2 must still answer MCP even though the bridge port is taken.
    await initialize(srv2);
    srv2.rpc({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'browser_status', arguments: {} } });
    const r = await srv2.waitFor(50, 3000);
    const body = JSON.parse(r.result.content[0].text);
    assert.ok(body.bridge_error, 'browser_status reports a bridge_error');
    assert.match(body.bridge_error, /in use|another/i);
    assert.equal(srv2.exitCode(), null, 'second server did not exit');
  } finally { srv1.kill(); srv2.kill(); }
});

test('invalid env vars fall back to defaults instead of breaking the server', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port), PAWBROWSE_TIMEOUT_MS: 'not-a-number' });
  try {
    const r = await initialize(srv);
    assert.equal(r.serverInfo.name, 'pawbrowse');
    // and tools still list
    srv.rpc({ jsonrpc: '2.0', id: 60, method: 'tools/list' });
    assert.equal((await srv.waitFor(60)).result.tools.length, 7);
  } finally { srv.kill(); }
});

/* ------------------------ adversarial WS bridge (raw) ---------------------- */

test('rejects a web-page Origin, accepts empty and chrome-extension origins', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await waitPort(port);
    const evil = await rawHandshake(port, { origin: 'https://evil.example.com' });
    assert.equal(evil.upgraded, false, 'web origin must be rejected');
    evil.sock.destroy();
    const none = await rawHandshake(port, {});
    assert.equal(none.upgraded, true, 'empty origin (local tooling) accepted');
    none.sock.destroy();
    const ext = await rawHandshake(port, { origin: 'chrome-extension://abcdefghijklmnop' });
    assert.equal(ext.upgraded, true, 'chrome-extension origin accepted');
    ext.sock.destroy();
  } finally { srv.kill(); }
});

test('an oversized frame closes the connection', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await waitPort(port);
    const { sock, upgraded } = await rawHandshake(port, {});
    assert.equal(upgraded, true);
    sock.write(maskedFrame(0x1, Buffer.alloc(0), { declaredLen: 9 * 1024 * 1024 })); // > 8MB cap
    assert.equal(await waitClosed(sock), true, 'server should destroy the socket');
  } finally { srv.kill(); }
});

test('a malformed control frame (ping > 125 bytes) closes the connection', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await waitPort(port);
    const { sock, upgraded } = await rawHandshake(port, {});
    assert.equal(upgraded, true);
    sock.write(maskedFrame(0x9, Buffer.alloc(0), { declaredLen: 200 })); // control frames must be <=125
    assert.equal(await waitClosed(sock), true, 'server should destroy the socket');
  } finally { srv.kill(); }
});

test('non-JSON garbage from the extension is ignored; commands still work', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  const ext = fakeExtension(port, () => ({ result: 'ok' }));
  try {
    await ext.ready;
    // Send malformed (non-JSON) data over the extension's own socket — must be ignored, not crash.
    ext.ws.send('this is not json at all {{{');
    ext.ws.send('{"partial": ');
    await sleep(150);
    await initialize(srv);
    srv.rpc({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } });
    const r = await srv.waitFor(70, 3000);
    assert.equal(r.result.content[0].text, 'ok', 'server still serves commands after garbage input');
  } finally { ext.close(); srv.kill(); }
});

/* -------------------------------- lifecycle ------------------------------- */

test('closing stdin exits the server (no zombie holding the port)', async () => {
  const port = await freePort();
  const srv = startServer({ PAWBROWSE_PORT: String(port) });
  try {
    await initialize(srv);
    const exited = new Promise((res) => srv.proc.on('exit', () => res(true)));
    srv.proc.stdin.end();
    const ok = await Promise.race([exited, sleep(3000).then(() => false)]);
    assert.equal(ok, true, 'server should exit when stdin closes');
  } finally { srv.kill(); }
});
