// PawBrowse background service worker.
// Connects to the local pawbrowse broker over WebSocket and drives the user's real tabs via
// chrome.debugger (CDP) — no remote debug port, no relaunch needed.
//
// MULTI-SESSION: the broker multiplexes many editor/Claude sessions over this one connection.
// Every command carries a `session` id; each session gets its OWN tab group (🐾 PawBrowse,
// with its own color) and drives only its own tab, so sessions run concurrently without
// fighting over one tab. Commands are serialized PER SESSION (not globally), so different
// sessions' tabs are driven in parallel.
//
// The element-table perception and action-execution techniques (accessible-name
// resolution, checkVisibility filtering, viewport-center hit-testing, stable node
// identity, robust fill) are adapted from browser-use/jev-ultrafast (MIT License).

const DEFAULT_PORT = 10577;
const IS_MAC = (navigator.userAgent || '').indexOf('Macintosh') >= 0;
let ws = null;
let reconnectTimer = null;

// Per-session state. Each session drives its own tab(s) inside its own tab group.
const attachedTabs = new Set();           // tabIds we currently hold a debugger on
const sessions = new Map();               // sessionId -> { activeTabId, createdTabs:Set, groupId, num, color }
const tabOwner = new Map();               // tabId -> sessionId (so sessions don't steal each other's tabs)
const chains = new Map();                 // sessionId -> Promise (serialize commands within a session)
let sessionCounter = 0;
let colorCursor = 0;
// PawBrowse's own group identity — deliberately NOT Claude-in-Chrome's blue "Claude" group.
// Distinct emoji (🐾) + a rotating non-blue palette so concurrent sessions are visually distinct.
const GROUP_COLORS = ['orange', 'cyan', 'purple', 'pink', 'green', 'yellow', 'red', 'grey'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------- persistence across service-worker restarts (avoid orphan tabs/groups) --------- *
 * MV3 kills the service worker under memory pressure, wiping the maps above. Without this, a
 * restart would abandon each session's tab + "🐾 PawBrowse" group (and endSession would no-op),
 * leaking one tab/group per session. We mirror the minimal session→tab/group map to
 * chrome.storage.session (cleared when the browser closes) and rehydrate on startup. All of it is
 * best-effort: if storage is unavailable, behaviour degrades to in-memory only.                */
let persistTimer = null;
function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const ser = {};
      for (const [k, v] of sessions) ser[k] = { activeTabId: v.activeTabId, createdTabs: [...v.createdTabs], groupId: v.groupId, num: v.num, color: v.color };
      await chrome.storage.session.set({ pawbrowse_state: { sessions: ser, tabOwner: [...tabOwner], sessionCounter, colorCursor } });
    } catch {}
  }, 250);
  persistTimer.unref?.();
}
const rehydrated = (async () => {
  try {
    const { pawbrowse_state: st } = await chrome.storage.session.get('pawbrowse_state');
    if (!st) return;
    for (const [k, v] of Object.entries(st.sessions || {})) {
      if (!sessions.has(k)) sessions.set(k, { activeTabId: v.activeTabId, createdTabs: new Set(v.createdTabs || []), groupId: v.groupId, num: v.num, color: v.color });
    }
    for (const [t, sess] of (st.tabOwner || [])) if (!tabOwner.has(t)) tabOwner.set(t, sess);
    if (typeof st.sessionCounter === 'number') sessionCounter = Math.max(sessionCounter, st.sessionCounter);
    if (typeof st.colorCursor === 'number') colorCursor = Math.max(colorCursor, st.colorCursor);
  } catch {}
})();

function sessionState(session) {
  const key = session || '_default';
  let s = sessions.get(key);
  if (!s) {
    s = { activeTabId: null, createdTabs: new Set(), groupId: null, num: ++sessionCounter, color: GROUP_COLORS[colorCursor++ % GROUP_COLORS.length] };
    sessions.set(key, s);
    persistState();
  }
  return s;
}

// Put a tab into this session's tab group, creating the group (with PawBrowse's own name +
// color + 🐾) on first use. Best-effort: grouping can fail across windows — never fatal.
async function ensureGroup(s, tabId) {
  try {
    if (s.groupId != null) {
      try { await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] }); return; }
      catch { s.groupId = null; } // stale group (e.g. all its tabs closed) — recreate below
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    s.groupId = groupId; persistState();
    const title = s.num > 1 ? `🐾 PawBrowse ${s.num}` : '🐾 PawBrowse';
    await chrome.tabGroups.update(groupId, { title, color: s.color });
  } catch {}
}

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
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.cmd) return;
    const sock = ws;
    const session = msg.session || '_default';
    // Serialize commands PER SESSION (overlapping calls in one session queue instead of racing
    // that session's tab); different sessions run concurrently on their own tabs. Each command is
    // bounded by a 25s timeout AND a cancellation token so a stalled multi-step command (act/
    // navigate) stops issuing further CDP ops instead of leaking work into the next one.
    const token = { cancelled: false };
    const prev = chains.get(session) || Promise.resolve();
    const run = prev.then(async () => {
      let timer;
      try {
        const result = await Promise.race([
          handleCommand(msg.cmd, msg.args || {}, token, session),
          new Promise((_, rej) => { timer = setTimeout(() => { token.cancelled = true; rej(new Error('command timed out in extension after 25s')); }, 25000); }),
        ]);
        clearTimeout(timer);
        sock.send(JSON.stringify({ id: msg.id, ok: true, result }));
      } catch (e) {
        clearTimeout(timer);
        try { sock.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) })); } catch {}
      }
    });
    chains.set(session, run.catch(() => {}));
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

// Attach to a SPECIFIC tab and keep it attached (many tabs can be attached at once, one per
// concurrent session). We never detach another tab here — that would break a sibling session.
async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  // "Already attached" can mean OUR own attachment survived a service-worker restart (fine) OR a
  // FOREIGN debugger owns the tab — DevTools or another extension (not fine: we can't drive it).
  const already = await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (/already attached/i.test(err.message)) { resolve(true); return; }
        reject(new Error(err.message)); return;
      }
      resolve(false);
    });
  });
  attachedTabs.add(tabId);
  if (already) {
    // Probe: if we truly hold the session this succeeds; if a foreign debugger owns it, it throws.
    try { await sendCdp(tabId, 'Runtime.evaluate', { expression: '1', returnByValue: true }); }
    catch { attachedTabs.delete(tabId); throw new Error('another debugger is attached to this tab (close DevTools or another extension) so PawBrowse cannot drive it'); }
  }
  await sendCdp(tabId, 'Runtime.enable', {}).catch(() => {});
  await sendCdp(tabId, 'Page.enable', {}).catch(() => {});
  await sendCdp(tabId, 'DOM.enable', {}).catch(() => {});
  // Make the tab behave as focused even when it's a background tab, so focus/blur, rendering,
  // and focus-dependent menus/dropdowns work while driving (the same approach Playwright uses for
  // backgrounded pages). A hidden tab still throttles requestAnimationFrame, so our waits use
  // setTimeout/setInterval, not rAF.
  await sendCdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

function detach(tabId) {
  return new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; attachedTabs.delete(tabId); resolve(); }));
}

chrome.debugger.onDetach.addListener((source) => { if (source.tabId != null) attachedTabs.delete(source.tabId); });

// If a driven tab is closed (by the user or by us), forget it everywhere so a session doesn't
// keep pointing at a dead tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  const owner = tabOwner.get(tabId);
  tabOwner.delete(tabId);
  if (owner != null) {
    const s = sessions.get(owner);
    if (s) { s.createdTabs.delete(tabId); if (s.activeTabId === tabId) s.activeTabId = null; }
  }
  persistState();
});

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}

// Browser-internal pages and the Web Store forbid CDP/debugger driving. Applied to BOTH the
// active tab and an explicitly-passed tabId so neither path can attach to a restricted page.
function restrictedPage(url) {
  url = url || '';
  return /^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url)
    || /^https?:\/\/chromewebstore\.google\.com/i.test(url)
    || /^https?:\/\/chrome\.google\.com\/webstore/i.test(url);
}

// Resolve which tab THIS session should drive, keeping sessions isolated:
//   - explicit tabId  -> use it (validated), adopt into the session's group.
//   - session already has a live tab -> reuse it.
//   - mode 'inspect' (observe/read/act/assert), first tab -> adopt the current active page if it's
//     free (not owned by another session); this preserves "read what I have open" for one session.
//   - otherwise (incl. mode 'navigate' first tab) -> create a NEW tab in the session's group, so we
//     never clobber the user's current page and concurrent sessions never share a tab.
async function resolveTabId(session, args, mode) {
  const s = sessionState(session);
  if (args.tabId != null) {
    let t;
    try { t = await chrome.tabs.get(args.tabId); }
    catch { throw new Error(`tab ${args.tabId} not found (list tabs with browser_tabs)`); }
    if (restrictedPage(t.url)) throw new Error(`that tab (${t.url}) is a browser page that cannot be driven; use a normal web page`);
    s.activeTabId = t.id; tabOwner.set(t.id, session); persistState();
    await ensureGroup(s, t.id);
    return t.id;
  }
  if (s.activeTabId != null) {
    try { const t = await chrome.tabs.get(s.activeTabId); if (t) return s.activeTabId; }
    catch { s.activeTabId = null; }
  }
  if (mode === 'inspect') {
    const t = await activeTab();
    // Read-and-claim must stay synchronous (no await between the owner read and the set below), so
    // two concurrent sessions can't both adopt the same tab: whichever runs first claims it, and the
    // other sees the claim and falls through to create its own tab.
    const owner = t ? tabOwner.get(t.id) : undefined;
    if (t && !restrictedPage(t.url) && (owner == null || owner === session)) {
      s.activeTabId = t.id; tabOwner.set(t.id, session); persistState();
      await ensureGroup(s, t.id);
      return t.id;
    }
  }
  const nt = await chrome.tabs.create({ url: 'about:blank', active: false });
  s.activeTabId = nt.id; s.createdTabs.add(nt.id); tabOwner.set(nt.id, session); persistState();
  await ensureGroup(s, nt.id);
  return nt.id;
}

// End a session (its controller disconnected): close only the tabs WE created for it, ungroup any
// tab we merely adopted (the user's own), and drop the group. Never closes the user's tabs.
async function endSession(session) {
  const s = sessions.get(session || '_default');
  if (!s) return { ended: true };
  for (const tid of s.createdTabs) {
    try { if (attachedTabs.has(tid)) await detach(tid); } catch {}
    try { await chrome.tabs.remove(tid); } catch {}
    attachedTabs.delete(tid); tabOwner.delete(tid);
  }
  if (s.activeTabId != null && !s.createdTabs.has(s.activeTabId)) {
    const tid = s.activeTabId;
    try { if (attachedTabs.has(tid)) await detach(tid); } catch {}
    try { await chrome.tabs.ungroup([tid]); } catch {}
    tabOwner.delete(tid);
  }
  sessions.delete(session || '_default');
  chains.delete(session || '_default');
  persistState();
  return { ended: true };
}

/* ------------------------------ Perception -------------------------------- *
 * Accessible-name resolution, native checkVisibility, viewport-center filtering,
 * stable WeakMap identity, select-options-as-actions, and in-viewport page text.
 * (Techniques credited in the file header.) Each snapshot re-numbers
 * displayed ids (e1..) but backs them with stable node ids (cache.byId) so an
 * action re-resolves the exact element it was chosen from.
 * -------------------------------------------------------------------------- */

const SNAPSHOT = `(function(){
  try{
  if(!document.body) return null;
  var cache = window.__pawbrowse || (window.__pawbrowse = {ids:new WeakMap(), nodes:new Map(), next:1, byId:{}});
  function identity(e){ if(!cache.ids.has(e)) cache.ids.set(e, cache.next++); var id=cache.ids.get(e); cache.nodes.set(id,e); return id; }
  cache.nodes.forEach(function(e,id){ if(!e.isConnected) cache.nodes.delete(id); });
  function safe(e){ return ['password','file','hidden'].indexOf(e.type)<0; }
  function visible(e){ return !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}); }
  function name(e,seen){
    seen=seen||new Set();
    if(!e||seen.has(e)) return '';
    seen.add(e);
    var rt=(e.getRootNode&&e.getRootNode())||document; var gid=function(id){try{return rt.getElementById?rt.getElementById(id):document.getElementById(id);}catch(_){return null;}};
    var ref=(e.getAttribute('aria-labelledby')||'').split(/\\s+/).map(function(id){return name(gid(id),seen);}).filter(Boolean).join(' ');
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
  var roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio','menuitemcheckbox','option','gridcell','combobox','textbox','searchbox','spinbutton','slider','treeitem'];
  // Semantic controls + custom clickables: any contenteditable, an inline onclick, or a
  // keyboard-focusable [tabindex] (framework buttons — React-Native-Web Pressables, design-system
  // divs — often expose only these). cursor:pointer clickables are added separately in collect().
  var selector='a[href],button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[onclick],[tabindex]:not([tabindex="-1"]),'+roles.map(function(r){return '[role="'+r+'"]';}).join(',');
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
  // Semantic guard: a stable fingerprint of an element's MEANING (role/name/value/state).
  // Compared at action time so a silently-relabeled or changed target is rejected.
  // Identity-focused: role + accessible name. Catches a target silently becoming a different
  // control (relabel), while tolerating benign value/checked/expanded churn and same-element
  // multi-op batches.
  cache.guard=function(el){ if(!el) return ''; try{ return [role(el),(name(el)||'').replace(/\\s+/g,' ').trim()].join(String.fromCharCode(1)); }catch(_){ return ''; } };
  // Collect actionable elements across the top document, OPEN shadow roots, and SAME-ORIGIN
  // iframes. dx/dy translate each element's frame-local rect into top-level viewport coordinates
  // (shadow roots share the frame's coords so dx/dy carry through unchanged; iframes add offset).
  function collect(){
    var out=[], seen=new Set(), scanned=0;
    function add(el, dx, dy, clk){ if(seen.has(el)) return; seen.add(el); out.push({el:el, dx:dx, dy:dy, clk:clk}); }
    function walk(root, dx, dy, depth){
      if(depth>12) return;
      var els; try{ els=root.querySelectorAll(selector); }catch(_){ els=[]; }
      for(var a=0;a<els.length;a++) add(els[a], dx, dy, false);
      var all; try{ all=root.querySelectorAll('*'); }catch(_){ all=[]; }
      for(var b=0;b<all.length;b++){
        var n=all[b];
        // Custom/framework clickables (e.g. React-Native-Web Pressable/Touchable, many design
        // systems) render as role-less <div>s but get cursor:pointer. Include the ROOT of each
        // pointer region (its parent is NOT pointer) so we capture the pressable itself, not its
        // inherited-cursor text children. Bounded scan so huge DOMs stay fast.
        if(!seen.has(n) && scanned<8000){
          scanned++;
          try{
            var view=(n.ownerDocument&&n.ownerDocument.defaultView)||window;
            if(view.getComputedStyle(n).cursor==='pointer'){
              var pe=n.parentElement;
              if(!pe || view.getComputedStyle(pe).cursor!=='pointer') add(n, dx, dy, true);
            }
          }catch(_){}
        }
        if(n.shadowRoot) walk(n.shadowRoot, dx, dy, depth+1);
        if(n.tagName==='IFRAME'){ try{
          var idoc=n.contentDocument;
          if(idoc && idoc.body){
            var ir=n.getBoundingClientRect(), cs=(n.ownerDocument.defaultView||window).getComputedStyle(n);
            walk(idoc,
              dx+ir.left+(parseFloat(cs.borderLeftWidth)||0)+(parseFloat(cs.paddingLeft)||0),
              dy+ir.top+(parseFloat(cs.borderTopWidth)||0)+(parseFloat(cs.paddingTop)||0), depth+1);
          }
        }catch(_){} }
      }
    }
    walk(document, 0, 0, 0);
    return out;
  }
  var actions=[], nodes=collect();
  for(var i=0;i<nodes.length;i++){
    var e=nodes[i].el, ox=nodes[i].dx, oy=nodes[i].dy, clk=nodes[i].clk;
    try{
    if(!safe(e)||!visible(e)||e.matches(':disabled')||e.closest('[aria-disabled="true"]')) continue;
    var r=e.getBoundingClientRect(), x=r.x+r.width/2+ox, y=r.y+r.height/2+oy, rname=role(e);
    if(!rname){
      // Role-less custom clickable (cursor:pointer, inline onclick, or focusable [tabindex]).
      // Only accept it if it has a real label and isn't just a wrapper around an actual control,
      // so we don't flood the table with layout containers.
      var ti=e.getAttribute('tabindex');
      if(clk || e.hasAttribute('onclick') || (ti!==null && ti!=='-1')){
        if(!(name(e)||'').trim() || e.querySelector(selector)) continue;
        rname='button';
      }
    }
    if(!rname||r.width<=0||r.height<=0||x<0||y<0||x>=innerWidth||y>=innerHeight) continue;
    if(rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    var base={node:identity(e), role:rname, label:(name(e)||rname).replace(/\\s+/g,' ').trim().slice(0,120), x:Math.round(x), y:Math.round(y)};
    var achecked=e.getAttribute('aria-checked');
    if(['checkbox','radio'].indexOf(e.type)>=0) base.checked=!!e.checked;
    else if(achecked!=null) base.checked=(achecked==='true');
    var aexp=e.getAttribute('aria-expanded'); if(aexp!=null) base.expanded=(aexp==='true');
    var asel=e.getAttribute('aria-selected'); if(asel!=null) base.selected=(asel==='true');
    if(e.tagName==='SELECT'){
      base.kind='select';
      base.value=[].map.call(e.selectedOptions,function(o){return o.label;}).join(', ');
      base.options=[].filter.call(e.options,function(o){return !o.disabled && !(o.closest&&o.closest('optgroup[disabled]'));}).map(function(o){return o.label;}).slice(0,40);
      actions.push(base);
    } else {
      var editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' && (['textbox','searchbox','spinbutton'].indexOf(rname)>=0 || (rname==='combobox' && ['INPUT','TEXTAREA'].indexOf(e.tagName)>=0));
      var value = (['checkbox','radio'].indexOf(e.type)>=0) ? '' : (('value' in e) ? String(e.value) : ((e.isContentEditable||rname==='combobox') ? e.innerText.trim() : ''));
      if(value) base.value=value.slice(0,80);
      base.kind=editable?'fill':'click';
      actions.push(base);
      // For an editable combobox, also offer a plain click to open its popup (not just type).
      if(editable && rname==='combobox'){ actions.push({node:base.node, role:rname, label:'Open '+base.label, x:base.x, y:base.y, kind:'click', expanded:base.expanded}); }
    }
    }catch(_){ continue; }
  }
  // Page text is a best-effort extra — a failure here must NOT discard the element table
  // we already computed above.
  var text='';
  try{
    var words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT), range=document.createRange(), node, length=0;
    while((node=walker.nextNode()) && length<4000){
      var v=node.textContent.trim(), p=node.parentElement;
      if(!v||!p||p.closest('script,style,noscript,template')||!visible(p)) continue;
      range.selectNodeContents(node); var tr=range.getBoundingClientRect();
      if(tr.width>0&&tr.height>0&&tr.bottom>0&&tr.top<innerHeight&&tr.right>0&&tr.left<innerWidth){ words.push(v); length+=v.length; }
    }
    text=words.join('\\n').slice(0,4000);
  }catch(_){ text=''; }
  var omitted=Math.max(0, actions.length-250); actions.splice(250);
  // Displayed id derives from the STABLE node id (not position), so a reused number can never
  // remap to a different element across observations; duplicates (e.g. combobox Open) get a suffix.
  // Guarded so a getter/DOM quirk while building ids can't blank the whole table.
  try{
    cache.byId={}; cache.guards={}; var used={};
    for(var j=0;j<actions.length;j++){ var bid='e'+actions[j].node, id=bid, kk=2; while(used[id]){ id=bid+'_'+kk; kk++; } used[id]=1; actions[j].id=id; cache.byId[id]=actions[j].node; cache.guards[id]=cache.guard(cache.nodes.get(actions[j].node)); }
  }catch(_){}
  return {url:location.href, title:document.title, scrollY:Math.round(scrollY), scrollH:Math.round(document.documentElement.scrollHeight), text:text, omitted:omitted, actions:actions};
  }catch(_){ return {url:location.href, title:(document&&document.title)||'', scrollY:0, scrollH:0, text:'', omitted:0, actions:[]}; }
})()`;

function formatTable(snap) {
  if (!snap) return '(page not ready)';
  const lines = [];
  lines.push(`${snap.title || '(untitled)'}  —  ${snap.url}`);
  lines.push(`scroll ${snap.scrollY}/${snap.scrollH}  ·  ${snap.actions.length} controls${snap.omitted ? ` (+${snap.omitted} more; scroll to reveal)` : ''}`);
  for (const a of snap.actions) {
    let flag = ' ';
    if (typeof a.expanded === 'boolean') flag = a.expanded ? '▾' : '▸'; // open / closed
    else if (typeof a.checked === 'boolean') flag = a.checked ? '✓' : '·';
    else if (a.selected === true) flag = '◉';
    let line = `${a.id.padEnd(4)} ${a.kind.padEnd(6)}${flag} "${a.label}"`;
    if (a.value) line += `  ▸ "${a.value}"`;
    if (a.kind === 'select' && a.options && a.options.length) line += `  opts{${a.options.join(' | ')}}`;
    lines.push(line);
  }
  return lines.join('\n');
}

// A page signature to detect whether an action actually changed the page. Includes per-input
// value/checked/selectedIndex so fills, toggles, and selects register as changes (password
// values excluded).
const SIG = `JSON.stringify([location.href, document.title, [].map.call(document.querySelectorAll('input,textarea,select'),function(e){return e.type==='password'?'':(String(e.value)+'~'+(e.checked?1:0)+'~'+(e.selectedIndex==null?'':e.selectedIndex));}).join('|'), document.querySelectorAll('a,button,input,select,textarea,summary,[role]').length])`;

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
async function resolveHit(tabId, ref, opts) {
  const forFill = opts && opts.fill ? 'true' : 'false';
  const R = JSON.stringify(String(ref));
  return evaluate(tabId, `(function(){
    var c=window.__pawbrowse; if(!c||!c.byId) return {error:'no snapshot yet; observe first'};
    var node=c.byId[${R}];
    if(node==null) return {error:'unknown ref (observe again)'};
    var e=c.nodes.get(node);
    if(!e||!e.isConnected) return {error:'element no longer on page (observe again)'};
    if(c.guard && c.guards && c.guards[${R}]!=null && c.guard(e)!==c.guards[${R}]) return {error:'element changed since observe (observe again)'};
    if(e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]')) return {error:'element is disabled'};
    if(${forFill} && (e.readOnly||e.getAttribute('aria-readonly')==='true')) return {error:'field is read-only'};
    if(${forFill} && !('value' in e) && !e.isContentEditable) return {error:'not an editable field (observe again)'};
    if(!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return {error:'element not visible'};
    e.scrollIntoView({block:'center',inline:'center'});
    var r=e.getBoundingClientRect(); if(!r.width||!r.height) return {error:'element has no size'};
    // Frame-local center (in the element's own frame viewport)...
    var lx=r.x+r.width/2, ly=r.y+r.height/2;
    // ...plus the offset chain of any ancestor iframes, giving the TOP-LEVEL click point for CDP.
    var dx=0, dy=0, w=(e.ownerDocument&&e.ownerDocument.defaultView), g=0;
    while(w && w.frameElement && g++<12){
      var fe=w.frameElement, fr=fe.getBoundingClientRect(), fcs=fe.ownerDocument.defaultView.getComputedStyle(fe);
      dx+=fr.left+(parseFloat(fcs.borderLeftWidth)||0)+(parseFloat(fcs.paddingLeft)||0);
      dy+=fr.top+(parseFloat(fcs.borderTopWidth)||0)+(parseFloat(fcs.paddingTop)||0);
      w=fe.ownerDocument.defaultView;
    }
    var x=Math.round(lx+dx), y=Math.round(ly+dy);
    if(x<0||y<0||x>=innerWidth||y>=innerHeight) return {error:'element off-screen after scroll'};
    // Hit-test in the element's OWN root (document / shadow root / iframe doc) using frame-local
    // coords, so shadow-DOM and iframe elements aren't falsely reported as covered.
    var root=e.getRootNode(); var efp=(root&&root.elementFromPoint)?root.elementFromPoint(lx,ly):document.elementFromPoint(lx,ly);
    if(!e.contains(efp)) return {error:'element is covered by another element'};
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
      if((el.textContent||'').toLowerCase().indexOf(target)<0) continue; // cheap pre-filter, no reflow
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
    var cx=Math.round(rr.left+rr.width/2), cy=Math.round(rr.top+rr.height/2);
    if(cx<0||cy<0||cx>=innerWidth||cy>=innerHeight) return null;
    if(!chosen.contains(document.elementFromPoint(cx,cy))) return null;
    return {x:cx, y:cy};
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

// After typing into a combobox, wait for its autocomplete options to actually render
// (up to ms) before the next observation, instead of paying a fixed delay.
async function waitForOptions(tabId, ref, ms) {
  const R = JSON.stringify(String(ref));
  const cap = Number(ms) || 250;
  try {
    // Poll with setInterval + a hard setTimeout cap (NOT requestAnimationFrame): rAF is paused in
    // background tabs, which is the normal case when driving, so an rAF-only wait would hang.
    await evaluate(tabId, `new Promise(function(res){
      var done=false; function fin(){ if(done) return; done=true; try{clearInterval(iv);}catch(_){} res(1); }
      setTimeout(fin, ${cap});
      var c=window.__pawbrowse; var node=(c&&c.byId)?c.byId[${R}]:null; var e=node!=null?c.nodes.get(node):null;
      if(!e || (e.getAttribute('role')||'').toLowerCase()!=='combobox'){ return fin(); }
      var ids=(e.getAttribute('aria-controls')||e.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
      var iv=setInterval(function(){
        try{
          var roots=ids.length?ids.map(function(id){return document.getElementById(id);}).filter(Boolean):[document];
          var opts=roots.reduce(function(a,r){return a.concat([].slice.call(r.querySelectorAll('[role=option]')));},[]);
          var vis=opts.some(function(o){var b=o.getBoundingClientRect();return b.width&&b.height&&o.checkVisibility&&o.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});});
          if(vis) fin();
        }catch(_){ fin(); }
      }, 40);
    })`);
  } catch { await sleep(cap); }
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
      const r = await resolveHit(tabId, op.ref, { fill: true });
      if (r.error) return `${op.ref}: ${r.error}`;
      await clickAt(tabId, r.x, r.y); // focus the field with a trusted click
      // Select-all then insert — robust for React/controlled inputs.
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: IS_MAC ? 4 : 2, commands: ['selectAll'] });
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: IS_MAC ? 4 : 2 });
      const txt = String(op.text ?? '');
      if (txt === '') {
        // insertText('') is a no-op in many inputs; Backspace deletes the selected contents.
        await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...KEYMAP.Backspace });
        await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...KEYMAP.Backspace });
      } else {
        await sendCdp(tabId, 'Input.insertText', { text: txt });
      }
      await waitForOptions(tabId, op.ref, 250); // let autocomplete suggestions render
      return `type ${op.ref}`;
    }
    case 'select': {
      const R = JSON.stringify(String(op.ref));
      const V = JSON.stringify(String(op.value ?? ''));
      try {
        const res = await evaluate(tabId, `(function(){
          var c=window.__pawbrowse; var node=(c&&c.byId)?c.byId[${R}]:null;
          var e=node!=null?c.nodes.get(node):null;
          if(!e||!e.isConnected) return 'unknown ref (observe again)';
          if(e.tagName!=='SELECT') return 'not a dropdown';
          if(e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]')) return 'dropdown is disabled';
          if(!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return 'dropdown not visible';
          var val=${V}, m=false;
          for(var i=0;i<e.options.length;i++){var o=e.options[i]; if(!o.disabled && !(o.closest&&o.closest('optgroup[disabled]')) && (o.value===val||o.label===val||o.text===val)){e.selectedIndex=i;m=true;break;}}
          if(!m) return 'option not found';
          e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
          return 'ok';
        })()`);
        return res === 'ok' ? `select ${op.ref}` : `${op.ref}: ${res}`;
      } catch {
        // The change handler may have navigated and destroyed the context — do not blindly retry.
        return `select ${op.ref}: may have applied and navigated the page; observe again before retrying`;
      }
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
      // Real wheel event so overflow containers, virtualized lists, and infinite scroll fire.
      let cx = 400, cy = 400;
      try { const c = await evaluate(tabId, '[Math.round(innerWidth/2),Math.round(innerHeight/2)]'); if (Array.isArray(c)) { cx = c[0]; cy = c[1]; } } catch {}
      await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: dy });
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

async function handleCommand(cmd, args, token, session) {
  await rehydrated; // ensure persisted session→tab/group state is loaded before we resolve tabs
  const aborted = () => token && token.cancelled;
  switch (cmd) {
    case '__session_end':
      return endSession(session);
    case 'doctor': {
      const t = await activeTab();
      const s = sessions.get(session || '_default');
      return {
        ext_version: chrome.runtime.getManifest().version,
        extension_id: chrome.runtime.id,
        session,
        session_tab_id: s ? s.activeTabId : null,
        session_group_id: s ? s.groupId : null,
        attached_tab_ids: [...attachedTabs],
        active_sessions: sessions.size,
        active_tab: t ? { id: t.id, url: t.url, title: t.title } : null,
      };
    }
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }
    case 'navigate': {
      const tabId = await resolveTabId(session, args, 'navigate');
      let url = String(args.url || '').trim();
      if (!url) throw new Error('navigate needs a url');
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url; // bare domain -> https
      if (!/^https?:\/\//i.test(url)) throw new Error(`navigate only supports http(s) URLs (refusing "${url.split(':')[0]}:")`);
      await attach(tabId);
      await sendCdp(tabId, 'Page.navigate', { url });
      await sleep(350); // let the new document commit before polling, so we don't read the old page
      for (let i = 0; i < 75; i++) {
        if (aborted()) break;
        const rs = await evaluate(tabId, 'document.readyState').catch(() => null);
        if (rs === 'complete') break;
        await sleep(200);
      }
      await settle(tabId, 400);
      return observe(tabId);
    }
    case 'observe': {
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      return observe(tabId);
    }
    case 'read': {
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      const max = Math.min(Number(args.max_chars) || 12000, 50000);
      const text = await evaluate(tabId, `(function(){var el=document.querySelector('main')||document.body;var t=(el.innerText||'').replace(/\\n{3,}/g,'\\n\\n');return t.slice(0, ${max});})()`);
      return `${await evaluate(tabId, 'document.title')}  —  ${await evaluate(tabId, 'location.href')}\n\n${text}`;
    }
    case 'act': {
      const ops = args.ops || [];
      if (ops.length > 50) throw new Error('too many ops in one call (max 50); split into smaller batches');
      const tabId = await resolveTabId(session, args, 'inspect');
      await attach(tabId);
      const before = await evaluate(tabId, SIG).catch(() => null);
      const logLines = [];
      for (const op of ops) {
        if (aborted()) { logLines.push('  (aborted: command timed out; remaining ops not run)'); break; }
        try { logLines.push('  ' + await runOp(tabId, op)); }
        catch (e) { logLines.push(`  ${op.op} ${op.ref || ''}: ERROR ${e.message}`); }
        await settle(tabId, 250);
      }
      await settle(tabId, 450);
      const after = await evaluate(tabId, SIG).catch(() => null);
      const changed = before == null || after == null || before !== after;
      const note = changed ? 'page changed' : 'page did NOT change (if you expected an effect, the action may not have worked — try a different target)';
      // The ops already executed; a failed post-action read (page navigating) must NOT make
      // the caller think they failed and retry them.
      let table;
      try { table = await observe(tabId); }
      catch {
        return `ran ${ops.length} op(s) [${note}]:\n${logLines.join('\n')}\n\n(ops executed; the page is navigating and could not be read yet — call browser_observe next. Do NOT re-run these ops.)`;
      }
      return `ran ${ops.length} op(s) [${note}]:\n${logLines.join('\n')}\n\n${table}`;
    }
    case 'assert': {
      const tabId = await resolveTabId(session, args, 'inspect');
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
chrome.alarms.create('pawbrowse-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pawbrowse-keepalive') connect(); });
// Let the options page read live connection status without opening a competing socket
// (which the bridge's single-connection guard would reject).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'status') { sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) }); return true; }
  if (msg && msg.type === 'reconnect') {
    // The options page changed the port: drop the current socket and reconnect on the new one.
    try { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } } catch {}
    try { if (ws) ws.close(); } catch {}
    ws = null;
    connect();
    sendResponse({ ok: true });
    return true;
  }
  return true;
});
connect();
