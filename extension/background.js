// ClawBrowse background service worker.
// Connects to the local clawbrowse MCP bridge over WebSocket and drives the user's
// real tabs via chrome.debugger (CDP) — no remote debug port, no relaunch needed.
//
// The element-table perception and action-execution techniques (accessible-name
// resolution, checkVisibility filtering, viewport-center hit-testing, stable node
// identity, robust fill) are adapted from browser-use/jev-ultrafast (MIT License).

const DEFAULT_PORT = 10577;
const IS_MAC = (navigator.userAgent || '').indexOf('Macintosh') >= 0;
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

/* ------------------------------ Perception -------------------------------- *
 * Adapted from browser-use/jev-ultrafast (MIT): accessible-name resolution,
 * native checkVisibility, viewport-center filtering, stable WeakMap identity,
 * select-options-as-actions, and in-viewport page text. Each snapshot re-numbers
 * displayed ids (e1..) but backs them with stable node ids (cache.byId) so an
 * action re-resolves the exact element it was chosen from.
 * -------------------------------------------------------------------------- */

const SNAPSHOT = `(function(){
  if(!document.body) return null;
  var cache = window.__clawbrowse || (window.__clawbrowse = {ids:new WeakMap(), nodes:new Map(), next:1, byId:{}});
  function identity(e){ if(!cache.ids.has(e)) cache.ids.set(e, cache.next++); var id=cache.ids.get(e); cache.nodes.set(id,e); return id; }
  cache.nodes.forEach(function(e,id){ if(!e.isConnected) cache.nodes.delete(id); });
  function safe(e){ return ['password','file','hidden'].indexOf(e.type)<0; }
  function visible(e){ return !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}); }
  function name(e,seen){
    seen=seen||new Set();
    if(!e||seen.has(e)) return '';
    seen.add(e);
    var ref=(e.getAttribute('aria-labelledby')||'').split(/\\s+/).map(function(id){return name(document.getElementById(id),seen);}).filter(Boolean).join(' ');
    if(ref) return ref;
    if(e.getAttribute('aria-label')) return e.getAttribute('aria-label');
    var labs=[].slice.call(e.labels||[]).map(function(l){return name(l,seen);}).filter(Boolean).join(' ');
    if(labs) return labs;
    if(['button','submit','reset'].indexOf(e.type)>=0 && e.value) return e.value;
    if(e.getAttribute('alt')) return e.getAttribute('alt');
    var txt = e.tagName==='INPUT' ? '' : [].map.call(e.childNodes,function(n){ return n.nodeType===3 ? n.textContent : (n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : ''); }).join(' ').trim();
    if(txt) return txt;
    return e.getAttribute('title')||e.getAttribute('placeholder')||'';
  }
  var roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio','option','gridcell','combobox','textbox','searchbox','spinbutton'];
  var selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+roles.map(function(r){return '[role="'+r+'"]';}).join(',');
  function role(e){
    var explicit=e.getAttribute('role');
    if(roles.indexOf(explicit)>=0) return explicit;
    if(e.tagName==='BUTTON'||e.tagName==='SUMMARY') return 'button';
    if(e.tagName==='A') return 'link';
    if(e.tagName==='SELECT') return 'combobox';
    if(e.tagName==='TEXTAREA'||e.isContentEditable) return 'textbox';
    if(e.tagName==='INPUT'){
      if(['checkbox','radio'].indexOf(e.type)>=0) return e.type;
      if(['button','submit','reset','image'].indexOf(e.type)>=0) return 'button';
      if(e.type==='search') return 'searchbox';
      if(e.type==='number') return 'spinbutton';
      if(['text','email','url','tel'].indexOf(e.type)>=0) return 'textbox';
    }
    return null;
  }
  var actions=[], nodes=document.querySelectorAll(selector);
  for(var i=0;i<nodes.length;i++){
    var e=nodes[i];
    if(!safe(e)||!visible(e)||e.matches(':disabled')||e.closest('[aria-disabled="true"]')) continue;
    var r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if(!rname||r.width<=0||r.height<=0||x<0||y<0||x>=innerWidth||y>=innerHeight) continue;
    if(rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    var base={node:identity(e), role:rname, label:(name(e)||rname).replace(/\\s+/g,' ').trim().slice(0,120), x:Math.round(x), y:Math.round(y)};
    var achecked=e.getAttribute('aria-checked');
    if(['checkbox','radio'].indexOf(e.type)>=0) base.checked=!!e.checked;
    else if(achecked!=null) base.checked=(achecked==='true');
    if(e.tagName==='SELECT'){
      base.kind='select';
      base.value=[].map.call(e.selectedOptions,function(o){return o.label;}).join(', ');
      base.options=[].filter.call(e.options,function(o){return !o.disabled;}).map(function(o){return o.label;}).slice(0,15);
      actions.push(base);
    } else {
      var editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' && (['textbox','searchbox','spinbutton'].indexOf(rname)>=0 || (rname==='combobox' && ['INPUT','TEXTAREA'].indexOf(e.tagName)>=0));
      var value = ('value' in e) ? String(e.value) : ((e.isContentEditable||rname==='combobox') ? e.innerText.trim() : '');
      if(value) base.value=value.slice(0,80);
      base.kind=editable?'fill':'click';
      actions.push(base);
    }
  }
  var words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT), range=document.createRange(), node, length=0;
  while((node=walker.nextNode()) && length<4000){
    var v=node.textContent.trim(), p=node.parentElement;
    if(!v||!p||p.closest('script,style,noscript,template')||!visible(p)) continue;
    range.selectNodeContents(node); var tr=range.getBoundingClientRect();
    if(tr.width>0&&tr.height>0&&tr.bottom>0&&tr.top<innerHeight&&tr.right>0&&tr.left<innerWidth){ words.push(v); length+=v.length; }
  }
  var text=words.join('\\n').slice(0,4000);
  var omitted=Math.max(0, actions.length-250); actions.splice(250);
  cache.byId={}; for(var j=0;j<actions.length;j++){ actions[j].id='e'+(j+1); cache.byId[actions[j].id]=actions[j].node; }
  return {url:location.href, title:document.title, scrollY:Math.round(scrollY), scrollH:Math.round(document.documentElement.scrollHeight), text:text, omitted:omitted, actions:actions};
})()`;

function formatTable(snap) {
  if (!snap) return '(page not ready)';
  const lines = [];
  lines.push(`${snap.title || '(untitled)'}  —  ${snap.url}`);
  lines.push(`scroll ${snap.scrollY}/${snap.scrollH}  ·  ${snap.actions.length} controls${snap.omitted ? ` (+${snap.omitted} more; scroll to reveal)` : ''}`);
  for (const a of snap.actions) {
    let flag = ' ';
    if (a.kind === 'select') flag = '▾';
    else if (typeof a.checked === 'boolean') flag = a.checked ? '✓' : '·';
    let line = `${a.id.padEnd(4)} ${a.kind.padEnd(6)}${flag} "${a.label}"`;
    if (a.value && a.kind !== 'select') line += `  ▸ "${a.value}"`;
    if (a.kind === 'select') {
      if (a.value) line += `  ▸ "${a.value}"`;
      if (a.options && a.options.length) line += `  opts{${a.options.join(' | ')}}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// A cheap page signature to detect whether an action actually changed the page.
const SIG = `JSON.stringify([location.href, document.title, (document.body?document.body.innerText.length:0), document.querySelectorAll('a,button,input,select,textarea,summary,[role]').length])`;

// Retry through transient "document is navigating" states so a snapshot taken
// during a transition settles instead of failing.
async function snapshot(tabId) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      const snap = await evaluate(tabId, SNAPSHOT);
      if (snap) return snap;
    } catch (e) { last = e; }
    await sleep(120);
  }
  if (last) throw last;
  return null;
}

async function observe(tabId) {
  return formatTable(await snapshot(tabId));
}

/* -------------------------------- Actions --------------------------------- */

// Re-resolve a ref to its live element, re-check it, and hit-test the center
// (elementFromPoint containment) so we never click a stale/covered/wrong target.
async function resolveHit(tabId, ref) {
  return evaluate(tabId, `(function(){
    var c=window.__clawbrowse; if(!c||!c.byId) return {error:'no snapshot yet; observe first'};
    var node=c.byId[${JSON.stringify(String(ref))}];
    if(node==null) return {error:'unknown ref (observe again)'};
    var e=c.nodes.get(node);
    if(!e||!e.isConnected) return {error:'element no longer on page (observe again)'};
    if(e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]')) return {error:'element is disabled'};
    if(!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return {error:'element not visible'};
    e.scrollIntoView({block:'center',inline:'center'});
    var r=e.getBoundingClientRect(); if(!r.width||!r.height) return {error:'element has no size'};
    var x=Math.round(r.x+r.width/2), y=Math.round(r.y+r.height/2);
    if(x<0||y<0||x>=innerWidth||y>=innerHeight) return {error:'element off-screen after scroll'};
    if(!e.contains(document.elementFromPoint(x,y))) return {error:'element is covered by another element'};
    return {x:x, y:y};
  })()`);
}

// Click the most specific visible element matching text, for custom widgets/menus
// (dropdowns, flair pickers) whose options aren't standard controls in the table.
async function centerOfText(tabId, text) {
  return evaluate(tabId, `(function(){
    var target=${JSON.stringify(String(text))}.trim().toLowerCase();
    if(!target) return null;
    var nodes=document.querySelectorAll('a,button,li,span,div,p,label,td,th,[role=button],[role=option],[role=menuitem],[role=tab],[role=radio]');
    var exact=[], partial=[];
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i];
      var r=el.getBoundingClientRect();
      if(r.width<=0||r.height<=0) continue;
      if(!el.checkVisibility||!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
      var txt=(el.innerText||el.textContent||'').trim();
      if(!txt) continue;
      var low=txt.toLowerCase(), area=r.width*r.height;
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

async function clickAt(tabId, x, y) {
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// Wait for the page to settle: two animation frames, or up to ms, whichever first.
async function settle(tabId, ms) {
  try {
    await evaluate(tabId, `new Promise(function(res){var f=0;function step(){if(++f>=2)return res(1);requestAnimationFrame(step);}requestAnimationFrame(step);setTimeout(function(){res(1);}, ${Number(ms) || 300});})`);
  } catch { await sleep(Number(ms) || 300); }
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
      const r = await resolveHit(tabId, op.ref);
      if (r.error) return `${op.ref}: ${r.error}`;
      await clickAt(tabId, r.x, r.y);
      return `click ${op.ref}`;
    }
    case 'click_text': {
      const c = await centerOfText(tabId, op.text);
      if (!c) return `click_text "${op.text}": not found`;
      await clickAt(tabId, c.x, c.y);
      return `click_text "${op.text}"`;
    }
    case 'type': {
      const r = await resolveHit(tabId, op.ref);
      if (r.error) return `${op.ref}: ${r.error}`;
      await clickAt(tabId, r.x, r.y); // focus the field with a trusted click
      // Select-all then insert — robust for React/controlled inputs.
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: IS_MAC ? 4 : 2, commands: ['selectAll'] });
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: IS_MAC ? 4 : 2 });
      await sendCdp(tabId, 'Input.insertText', { text: String(op.text ?? '') });
      return `type ${op.ref}`;
    }
    case 'select': {
      const res = await evaluate(tabId, `(function(){
        var c=window.__clawbrowse; var node=(c&&c.byId)?c.byId[${JSON.stringify(String(op.ref))}]:null;
        var e=node!=null?c.nodes.get(node):null;
        if(!e) return 'unknown ref (observe again)';
        if(e.tagName!=='SELECT') return 'not a dropdown';
        var val=${JSON.stringify(String(op.value ?? ''))}, m=false;
        for(var i=0;i<e.options.length;i++){var o=e.options[i]; if(!o.disabled && (o.value===val||o.label===val||o.text===val)){e.selectedIndex=i;m=true;break;}}
        if(!m) return 'option not found';
        e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
        return 'ok';
      })()`);
      return res === 'ok' ? `select ${op.ref}` : `${op.ref}: ${res}`;
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
      await settle(tabId, 400);
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
      const before = await evaluate(tabId, SIG).catch(() => null);
      const logLines = [];
      for (const op of (args.ops || [])) {
        try { logLines.push('  ' + await runOp(tabId, op)); }
        catch (e) { logLines.push(`  ${op.op} ${op.ref || ''}: ERROR ${e.message}`); }
        await settle(tabId, 250);
      }
      await settle(tabId, 450);
      const after = await evaluate(tabId, SIG).catch(() => null);
      const changed = before == null || after == null || before !== after;
      const note = changed ? 'page changed' : 'page did NOT change (if you expected an effect, the action may not have worked — try a different target)';
      const table = await observe(tabId);
      return `ran ${(args.ops || []).length} op(s) [${note}]:\n${logLines.join('\n')}\n\n${table}`;
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
        const r = await resolveHit(tabId, args.ref_visible);
        return { pass: !r.error, kind: 'ref_visible', ref: args.ref_visible, note: r.error };
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
chrome.alarms.create('clawbrowse-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'clawbrowse-keepalive') connect(); });
connect();
