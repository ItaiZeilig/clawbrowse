// End-to-end round-trip test for the clawbrowse MCP server.
// Spawns the server, connects a fake extension over the WebSocket bridge, and drives it
// through the MCP stdio interface. No browser required. Requires Node >= 22 (global WebSocket).
//
// Exit code 0 = pass, 1 = fail.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'mcp', 'server.mjs');
const PORT = 10599;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn('node', [SERVER], {
  env: { ...process.env, CLAWBROWSE_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const out = [];
srv.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) if (line.trim()) out.push(JSON.parse(line));
});
const send = (o) => srv.stdin.write(JSON.stringify(o) + '\n');

function fail(msg) { console.error('FAIL ❌', msg); srv.kill(); process.exit(1); }

await sleep(500);

if (typeof WebSocket === 'undefined') {
  console.error('This test needs a Node with a global WebSocket client (Node >= 22).');
  srv.kill();
  process.exit(1);
}

// Fake extension: answers every command it receives.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let lastCmd = null;
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }).catch(() => fail('extension could not connect to bridge'));
ws.send(JSON.stringify({ type: 'hello', ext: 'fake-extension' }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  lastCmd = msg;
  ws.send(JSON.stringify({ id: msg.id, ok: true, result: `FAKE ${msg.cmd}` }));
};

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
await sleep(150);
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
await sleep(150);
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } });
await sleep(400);

const init = out.find((o) => o.id === 1);
const list = out.find((o) => o.id === 2);
const call = out.find((o) => o.id === 3);

if (init?.result?.serverInfo?.name !== 'clawbrowse') fail('initialize did not return serverInfo.name=clawbrowse');
if (list?.result?.tools?.length !== 7) fail(`expected 7 tools, got ${list?.result?.tools?.length}`);
if (lastCmd?.cmd !== 'observe') fail(`extension did not receive the observe command (got ${lastCmd?.cmd})`);
if (call?.result?.content?.[0]?.text !== 'FAKE observe') fail('tool result did not round-trip from the extension');

console.log('PASS ✅  initialize + tools/list + observe round-trip');
console.log('       tools:', list.result.tools.map((t) => t.name).join(', '));
ws.close();
srv.kill();
process.exit(0);
