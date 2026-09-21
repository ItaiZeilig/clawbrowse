// JevBridge background service worker.
// Connects to the local jevbridge MCP bridge over WebSocket and drives the user's
// real tabs via chrome.debugger (CDP) — no remote debug port, no relaunch needed.

const DEFAULT_PORT = 10577;
let ws = null;
let attachedTabId = null;
let reconnectTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPort() {
  try { const { port } = await chrome.storage.local.get('port'); return port || DEFAULT_PORT; }
  catch { return DEFAULT_PORT; }
}

/* ------------------------- WebSocket to the bridge ------------------------- */

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const port = await getPort();
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch { scheduleReconnect(); return; }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', ext: chrome.runtime.id }));
    setBadge('on');
  };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.cmd) return;
    try {
      const result = await handleCommand(msg.cmd, msg.args || {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) }));
    }
  };
  ws.onclose = () => { setBadge('off'); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

function setBadge(state) {
  try {
    chrome.action.setBadgeText({ text: state === 'on' ? '●' : '' });
    chrome.action.setBadgeBackgroundColor({ color: state === 'on' ? '#16a34a' : '#999999' });
  } catch {}
}

/* ------------------------------- CDP helpers ------------------------------ */

function sendCdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    });
  });
}

async function evaluate(tabId, expression) {
  const r = await sendCdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluation error');
  }
  return r.result.value;
}

async function attach(tabId) {
  if (attachedTabId === tabId) return;
  if (attachedTabId != null) { try { await detach(attachedTabId); } catch {} }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve();
    });
  });
  attachedTabId = tabId;
  await sendCdp(tabId, 'Runtime.enable', {}).catch(() => {});
  await sendCdp(tabId, 'Page.enable', {}).catch(() => {});
  await sendCdp(tabId, 'DOM.enable', {}).catch(() => {});
}

function detach(tabId) {
  return new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
}

chrome.debugger.onDetach.addListener((source) => { if (source.tabId === attachedTabId) attachedTabId = null; });

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}

async function resolveTabId(args) {
  if (args.tabId != null) return args.tabId;
  const t = await activeTab();
  if (!t) throw new Error('no active tab found');
  if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(t.url || '')) {
    throw new Error(`the active tab (${t.url}) is a browser page that cannot be driven; switch to a normal web page`);
  }
  return t.id;
}

/* ------------------------------ Perception -------------------------------- */

const PERCEPTION = `(function(){
  var seen = window.__jevSeen || (window.__jevSeen = {n:0});
  function refFor(el){ var r = el.getAttribute('data-jev-ref'); if(!r){ r='e'+(++seen.n); el.setAttribute('data-jev-ref', r); } return r; }
  function labelFor(el){
    var aria = el.getAttribute('aria-label'); if(aria) return aria.trim().slice(0,120);
    var t = (el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ');
    if(!t){ t = el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || ''; }
    return (t||'').slice(0,120);
  }
  function kindOf(el){
    var tag = el.tagName.toLowerCase();
    var role = (el.getAttribute('role')||'').toLowerCase();
    if(tag==='a'||role==='link') return 'lnk';
    if(tag==='select') return 'sel';
    if(tag==='textarea') return 'inp';
    if(tag==='input'){ var ty=(el.type||'text').toLowerCase(); if(ty==='checkbox'||ty==='radio') return 'chk'; if(ty==='hidden') return null; return 'inp'; }
    if(role==='checkbox'||role==='radio') return 'chk';
    if(tag==='button'||role==='button'||el.type==='submit'||el.type==='button') return 'btn';
    if(el.isContentEditable) return 'inp';
    return 'btn';
  }
  var sel='a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[onclick],[contenteditable=""],[contenteditable=true]';
  var out=[], nodes=document.querySelectorAll(sel);
  for(var i=0;i<nodes.length;i++){
    var el=nodes[i];
    var kind=kindOf(el); if(!kind) continue;
    var rect=el.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0) continue;
    var st=getComputedStyle(el);
    if(st.visibility==='hidden'||st.display==='none'||Number(st.opacity)===0) continue;
    var inView = rect.bottom>0 && rect.right>0 && rect.top<innerHeight && rect.left<innerWidth;
    var item={ ref:refFor(el), kind:kind, label:labelFor(el), inView:inView };
    if(el.disabled) item.disabled=true;
    if(kind==='inp'||kind==='sel'){ var v=(el.value!=null)?String(el.value):''; if(v) item.value=v.slice(0,80); }
    if(kind==='chk') item.checked=!!el.checked;
    if(kind==='sel'){ item.options=Array.prototype.slice.call(el.options||[]).map(function(o){return o.text;}).slice(0,12); }
    out.push(item);
  }
  return { url:location.href, title:document.title, scrollY:Math.round(scrollY), scrollH:Math.round(document.documentElement.scrollHeight), viewportH:Math.round(innerHeight), count:out.length, elements:out };
})()`;

function formatTable(snap) {
  const lines = [];
  lines.push(`${snap.title || '(untitled)'}  —  ${snap.url}`);
  lines.push(`scroll ${snap.scrollY}/${snap.scrollH}  ·  ${snap.count} controls`);
  for (const e of snap.elements) {
    let flag = ' ';
    if (e.kind === 'chk') flag = e.checked ? '✓' : '·';
    if (e.disabled) flag = '⊘';
    let line = `${e.ref.padEnd(4)} ${e.kind}${flag} "${e.label}"`;
    if (e.value) line += `  ▸ "${e.value}"`;
    if (e.options && e.options.length) line += `  opts{${e.options.join(' | ')}}`;
    if (!e.inView) line += `  (off-screen)`;
    lines.push(line);
  }
  return lines.join('\n');
}

async function observe(tabId) {
  const snap = await evaluate(tabId, PERCEPTION);
  return formatTable(snap);
}

/* -------------------------------- Actions --------------------------------- */

async function centerOf(tabId, ref) {
  return evaluate(tabId, `(function(){var el=document.querySelector('[data-jev-ref="${ref}"]'); if(!el) return null; el.scrollIntoView({block:'center',inline:'center'}); var r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
}

// Find the most specific (smallest) visible element whose text matches, scroll it into
// view, and return its center. For widgets whose options aren't standard controls
// (custom dropdowns, flair pickers, menus) that the element table can't reference.
async function centerOfText(tabId, text) {
  return evaluate(tabId, `(function(){
    var target=${JSON.stringify(String(text))}.trim().toLowerCase();
    if(!target) return null;
    var nodes=document.querySelectorAll('a,button,li,span,div,p,label,td,th,[role=button],[role=option],[role=menuitem],[role=tab],[role=radio]');
    var exact=[], partial=[];
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i];
      if(el.querySelector && el.querySelector('a,button,li,input,textarea,select')) { /* prefer leaf-ish, but still allow */ }
      var r=el.getBoundingClientRect();
      if(r.width<=0||r.height<=0) continue;
      var st=getComputedStyle(el);
      if(st.visibility==='hidden'||st.display==='none'||Number(st.opacity)===0) continue;
      var txt=(el.innerText||el.textContent||'').trim();
      if(!txt) continue;
      var low=txt.toLowerCase();
      var area=r.width*r.height;
      if(low===target) exact.push({el:el,area:area});
      else if(low.indexOf(target)>=0) partial.push({el:el,area:area});
    }
    var pool=exact.length?exact:partial;
    if(!pool.length) return null;
    pool.sort(function(a,b){return a.area-b.area;});
    var chosen=pool[0].el;
    chosen.scrollIntoView({block:'center',inline:'center'});
    var rr=chosen.getBoundingClientRect();
    return {x:Math.round(rr.left+rr.width/2), y:Math.round(rr.top+rr.height/2)};
  })()`);
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
};

async function runOp(tabId, op) {
  switch (op.op) {
    case 'click': {
      const c = await centerOf(tabId, op.ref);
      if (!c) return `${op.ref}: not found`;
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      return `click ${op.ref}`;
    }
    case 'click_text': {
      const c = await centerOfText(tabId, op.text);
      if (!c) return `click_text "${op.text}": not found`;
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      return `click_text "${op.text}"`;
    }
    case 'type': {
      const ok = await evaluate(tabId, `(function(){var el=document.querySelector('[data-jev-ref="${op.ref}"]'); if(!el) return false; el.focus(); if('value' in el){el.value='';} return true;})()`);
      if (!ok) return `${op.ref}: not found`;
      await sendCdp(tabId, 'Input.insertText', { text: String(op.text ?? '') });
      await evaluate(tabId, `(function(){var el=document.querySelector('[data-jev-ref="${op.ref}"]'); if(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
      return `type ${op.ref}`;
    }
    case 'select': {
      const matched = await evaluate(tabId, `(function(){var el=document.querySelector('[data-jev-ref="${op.ref}"]'); if(!el) return null; var val=${JSON.stringify(String(op.value ?? ''))}; var m=false; for(var i=0;i<el.options.length;i++){var o=el.options[i]; if(o.value===val||o.text===val){el.selectedIndex=i;m=true;break;}} el.dispatchEvent(new Event('change',{bubbles:true})); return m;})()`);
      return matched === null ? `${op.ref}: not found` : (matched ? `select ${op.ref}` : `${op.ref}: option "${op.value}" not found`);
    }
    case 'key': {
      const k = KEYMAP[op.key];
      if (!k) return `key "${op.key}" not supported`;
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k });
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      return `key ${op.key}`;
    }
    case 'scroll': {
      const dy = Number(op.dy ?? 600);
      await evaluate(tabId, `window.scrollBy(0, ${dy})`);
      return `scroll ${dy}`;
    }
    case 'wait': {
      await sleep(Math.min(Number(op.ms ?? 300), 10000));
      return `wait ${op.ms ?? 300}`;
    }
    default:
      return `unknown op "${op.op}"`;
  }
}

/* ------------------------------ Command router ---------------------------- */

async function handleCommand(cmd, args) {
  switch (cmd) {
    case 'doctor': {
      const t = await activeTab();
      return {
        ext_version: chrome.runtime.getManifest().version,
        extension_id: chrome.runtime.id,
        attached_tab_id: attachedTabId,
        active_tab: t ? { id: t.id, url: t.url, title: t.title } : null,
      };
    }
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }
    case 'navigate': {
      const tabId = await resolveTabId(args);
      await attach(tabId);
      await sendCdp(tabId, 'Page.navigate', { url: args.url });
      for (let i = 0; i < 75; i++) {
        await sleep(200);
        const rs = await evaluate(tabId, 'document.readyState').catch(() => null);
        if (rs === 'complete') break;
      }
      await sleep(300);
      return observe(tabId);
    }
    case 'observe': {
      const tabId = await resolveTabId(args);
      await attach(tabId);
      return observe(tabId);
    }
    case 'read': {
      const tabId = await resolveTabId(args);
      await attach(tabId);
      const max = Math.min(Number(args.max_chars) || 12000, 50000);
      const text = await evaluate(tabId, `(function(){var el=document.querySelector('main')||document.body;var t=(el.innerText||'').replace(/\\n{3,}/g,'\\n\\n');return t.slice(0, ${max});})()`);
      return `${await evaluate(tabId, 'document.title')}  —  ${await evaluate(tabId, 'location.href')}\n\n${text}`;
    }
    case 'act': {
      const tabId = await resolveTabId(args);
      await attach(tabId);
      const logLines = [];
      for (const op of (args.ops || [])) {
        try { logLines.push('  ' + await runOp(tabId, op)); }
        catch (e) { logLines.push(`  ${op.op} ${op.ref || ''}: ERROR ${e.message}`); }
      }
      await sleep(350); // let the page settle
      const table = await observe(tabId);
      return `ran ${(args.ops || []).length} op(s):\n${logLines.join('\n')}\n\n${table}`;
    }
    case 'assert': {
      const tabId = await resolveTabId(args);
      await attach(tabId);
      if (args.contains != null) {
        const ok = await evaluate(tabId, `!!(document.body && document.body.innerText && document.body.innerText.indexOf(${JSON.stringify(args.contains)})>=0)`);
        return { pass: !!ok, kind: 'contains', value: args.contains };
      }
      if (args.url_includes != null) {
        const u = await evaluate(tabId, 'location.href');
        return { pass: String(u).indexOf(args.url_includes) >= 0, kind: 'url_includes', url: u };
      }
      if (args.ref_visible != null) {
        const c = await centerOf(tabId, args.ref_visible);
        return { pass: !!c, kind: 'ref_visible', ref: args.ref_visible };
      }
      return { pass: false, error: 'provide one of: contains, url_includes, ref_visible' };
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

/* --------------------------------- Wiring --------------------------------- */

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('jevbridge-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'jevbridge-keepalive') connect(); });
connect();
