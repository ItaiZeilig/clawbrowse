<p align="center">
  <img src="assets/hero.png" alt="ClawBrowse — Claude Code drives your real Chrome" width="100%">
</p>

<h1 align="center">
  <img src="extension/icons/icon-48.png" width="28" align="top" alt=""> ClawBrowse
</h1>

<p align="center"><strong>Let Claude Code drive your real, logged-in Chrome — open source, no keys, no second model.</strong></p>

<p align="center">
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT"></a>
<a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
<a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node >=18"></a>
<img src="https://img.shields.io/badge/deps-zero-brightgreen.svg" alt="zero dependencies">
<a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/for-Claude%20Code-8A63D2.svg" alt="for Claude Code"></a>
<a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-blue.svg" alt="MCP"></a>
</p>

ClawBrowse is a **Chrome MV3 extension + a tiny zero-dependency MCP server** that lets your
local AI coding agent (like **Claude Code**) read and act on your **actual, logged-in
browser tabs** — your profile, your sessions, your open pages — with **no remote-debug port,
no browser relaunch, and no separate AI model or API key.**

It's the open, self-owned answer to "I wish my agent could just use my real browser." Same
capability as the first-party Claude-in-Chrome extension, but **yours, auditable, and MCP-native
(works with any MCP client, not just one vendor).**

```
Claude Code ──stdio (MCP)──▶ mcp/server.mjs ──ws://127.0.0.1:10577──▶ Chrome extension ──CDP──▶ your real tabs
```

- **Your real browser.** Uses Chrome's built-in `chrome.debugger` (CDP) on the tabs you already
  have open and logged into. No `--remote-debugging-port`, no relaunch, no separate profile.
- **The agent is the policy.** No second model, no `TYPESAFE_API_KEY`, no OpenRouter — *you*
  (Claude) decide every action. Page content flows up to your agent as normal tool results and
  **never leaves for any third-party server.**
- **Reads pages as an element table, not screenshots.** A compact, numbered list of the
  actionable controls in view — cheap in tokens, fast to reason over, and precise to act on.
- **Zero dependencies.** The whole server is one auditable `.mjs` file; the extension is plain JS.
- **MIT. Open. Extensible.** Add a tool or an op in minutes.

---

## The element table

Every observation returns a compact, numbered table of the **in-viewport, actionable** controls
— with proper accessible names, current values, and state flags — instead of a screenshot:

```
Web browser - Wikipedia  —  https://en.wikipedia.org/wiki/Web_browser
scroll 0/6361  ·  83 controls
e2   fill    "Search Wikipedia"
e6   click   "Log in"
e10  click   "2 History"
e13  click ▾ "Toggle Browser market subsection"
e9   click✓  "Remember me"
e3   select  "Country"  opts{US | UK | ...}
```

Flags after the kind: `✓`/`·` checked/unchecked · `▾`/`▸` expanded/collapsed (open vs closed
menu, combobox, accordion) · `◉` selected (active tab/option). Refs like `e10` derive from a
**stable node identity**, so the agent can act on a control by ref in **one round trip**.

---

## Benchmark: ~2.2× faster per action than Claude-in-Chrome

Because ClawBrowse keeps **stable element refs** and its `navigate`/`act` already return the fresh
table, the agent can click a known target in **one** round trip. Screenshot/accessibility-tree
drivers do **perceive-then-act** — a read (or screenshot) *then* a click — paying an extra agent
round trip and a larger payload every action.

Measured task: click 5 different section links on the same Wikipedia page, averaged, same machine,
same agent (Claude):

| | ClawBrowse | Claude-in-Chrome |
| --- | --- | --- |
| Calls per click | **1** (`act` by stable ref) | 2 (`read_page` → click) |
| Avg wall-clock per click | **~7.6 s** | ~17.0 s |
| Perception payload | compact, viewport-only | full a11y tree w/ URLs (up to 50 KB) |

> **Honest caveat:** with Claude as the shared brain, absolute wall-clock is dominated by agent
> latency and is noisy — treat the **~2.2× ratio** as the signal, not the exact seconds. The win is
> *structural* (fewer round trips + smaller payloads), and it also means fewer tokens per step.
> This is **not** the sub-second speed of a dedicated click-picking model like
> [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)'s — ClawBrowse trades that raw
> speed for a smart, general brain (Claude) with no keys and no per-click cost.

---

## How it compares

| | Claude-in-Chrome | jev-ultrafast | **ClawBrowse** |
| --- | --- | --- | --- |
| Drives your real, logged-in Chrome | ✅ | ❌ (own browser / debug port) | ✅ (`chrome.debugger`, no port) |
| Decision model | Claude | jev-ultrafast's model (**paid, per click**) | **Claude — no second model, no key** |
| Perception | screenshots + a11y tree | element table | **element table** |
| Round trips per action | 2 (perceive → act) | 1 | **1** (stable refs) |
| Page data to a third party | no | **yes** (to the model API) | **no** |
| Per-site permission gate | yes (allowlist) | n/a | no |
| Open source / self-owned | ❌ | partial | **✅ MIT, zero-dep** |
| Works with any MCP client | ❌ | via its own server | **✅** |

ClawBrowse borrows jev-ultrafast's excellent **perception + execution engineering** (see
[Credits](#credits)) but swaps the paid decision-model for your own agent.

---

## Getting started

**You'll need:** Google Chrome (or Edge/Brave), **Node.js ≥ 18**, and **Claude Code** (or any MCP client).

### 1. Get the code
```bash
git clone https://github.com/ItaiZeilig/clawbrowse.git
```

### 2. Load the extension into Chrome
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the **`clawbrowse/extension`** folder.
4. You'll see a **ClawBrowse** card with a small badge icon. (It turns **green ●** once it's
   connected to the server in step 3 — grey until then, that's normal.)

### 3. Connect it to Claude Code
Register the local server (one time), using the **full path** to where you cloned it:
```bash
claude mcp add --scope user clawbrowse -- node /full/path/to/clawbrowse/mcp/server.mjs
```

### 4. Restart Claude Code
**Fully quit and reopen Claude Code** (not just `/mcp`) so it starts the server and loads the
tools. When it's back, the extension badge should be **green ●**.

> ✅ **Check it's working:** ask Claude Code *"use clawbrowse: what's my browser status?"* — it
> should report `extension_connected: true`.

## Using it

You don't call the tools yourself — you just **ask Claude Code in plain language**, and it uses
ClawBrowse to drive whatever tab you point it at. Some things to try:

- *"Open news.ycombinator.com and give me the top 5 story titles."*
- *"On this tab, search for 'open source license' and open the first result."*
- *"Fill the signup form on the current page with my name and email, but don't submit."*
- *"Go to my GitHub notifications and tell me what's new."*

Tips:
- It acts on the **tab you have open and are logged into** — no separate window, no re-login.
- Point it at a specific tab by saying which one, or it uses the active tab.
- It reads the page as a list of controls and clicks/types precisely — no screenshots needed.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Badge never turns green | The server isn't running — make sure you **fully restarted** Claude Code after `claude mcp add` (a `/mcp` reconnect alone won't relaunch it). |
| "No extension connected" | Reload the extension at `chrome://extensions`, then re-run `browser_status`. |
| "Another debugger is already attached" | That tab has DevTools open or another extension driving it — close DevTools or switch tabs. |
| A `chrome://` / Web Store page won't drive | Those are browser pages Chrome blocks from automation — use a normal web page. |
| Changed the port | Set the same port in the extension's **Options** and in `--env CLAWBROWSE_PORT=…`. |

> Requires **Node ≥ 18** (≥ 22 to run the test suite). Works on Chrome, Edge, and Brave.

---

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Connection + attached-tab diagnostics. Call first if anything's off. |
| `browser_tabs` | List open tabs (`id`, `title`, `url`, `active`). |
| `browser_navigate` | `{ url, tabId? }` → element table after load. |
| `browser_observe` | `{ tabId? }` → the element table. |
| `browser_read` | `{ tabId?, max_chars? }` → the page's readable prose (articles, docs, rules). |
| `browser_act` | `{ ops: [...], tabId? }` → runs ops in order, returns a fresh table + a "page changed?" signal. |
| `browser_assert` | `{ contains? \| url_includes? \| ref_visible?, tabId? }` → prove an outcome (pass/fail). |

**Ops for `browser_act`:** `{op:"click",ref:"e12"}` · `{op:"click_text",text:"..."}` (for custom
widgets/menus not in the table) · `{op:"type",ref:"e7",text:"..."}` · `{op:"select",ref:"e8",value:"..."}`
· `{op:"key",key:"Enter"}` · `{op:"scroll",dy:600}` · `{op:"wait",ms:500}`.

---

## Reliability & safety engineering

ClawBrowse was hardened through two multi-agent code audits **and** live testing on real sites:

- **Hit-tested clicks.** Before every click it re-resolves the element live and verifies the
  center isn't covered (`elementFromPoint`), so it never clicks a stale, moved, or occluded target.
- **Semantic freshness guard.** An element's role + accessible name is fingerprinted at observe
  time and re-checked before acting — a silently relabeled target is rejected ("observe again")
  instead of mis-clicked.
- **Robust fill.** Select-all + `insertText`, which works with React/controlled inputs; typed
  comboboxes wait for their autocomplete options to actually render.
- **Background-tab safe.** Uses `Emulation.setFocusEmulationEnabled` and `setTimeout`-based waits
  (never `requestAnimationFrame`, which Chrome pauses in background tabs) so driving a tab you
  aren't looking at doesn't hang.
- **No double-execution.** If a post-action read fails because the page is navigating, the ops are
  reported as executed ("call observe next") rather than surfaced as a failure to retry.
- **Serialized, unwedgeable command queue** — overlapping calls can't race the debugger, and one
  hung command can't block the rest.

---

## Security & privacy

- **No data leaves your machine.** There's no model and no API key; page content goes only to the
  agent you run locally. `password`, `file`, and `hidden` inputs are excluded and their values are
  never exposed.
- **Local-only bridge.** The WebSocket binds to `127.0.0.1`, rejects non-`chrome-extension://`
  origins (so a web page can't connect), trusts only the current extension socket, and caps
  inbound frame size.
- **One powerful permission, no host permissions.** The extension declares `debugger` (plus
  `tabs`, `storage`, `alarms`) and **no** host permissions — `chrome.debugger` doesn't need them.
  That's the same capability class as any real-browser agent; use it deliberately.
- **Fully auditable.** The server is one zero-dependency file; the extension is plain JS.

Found a vulnerability? See **[SECURITY.md](SECURITY.md)** — please don't open a public issue.

---

## Notes & limits

- Attaching shows Chrome's "ClawBrowse is debugging this browser" banner — expected.
- One debugger client per tab: a tab with DevTools open (or driven by another extension) can't be
  attached — switch tabs or close DevTools.
- `chrome://`, the Chrome Web Store, and other browser pages can't be driven.
- No cross-origin iframe traversal, canvas, or file uploads yet.

---

## Contributing

Contributions welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup, tests (`npm test`),
and the PR process. By participating you agree to the **[Code of Conduct](CODE_OF_CONDUCT.md)**.
Questions? **[SUPPORT.md](SUPPORT.md)**.

## Credits

ClawBrowse's element-table perception and action-execution techniques — accessible-name resolution,
`checkVisibility` filtering, viewport-center hit-testing, stable node identity, robust fill, and
focus emulation for background tabs — are adapted from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT). ClawBrowse is an
independent reimplementation as a Chrome extension + MCP server, with the calling agent (not a
separate model) as the decision-maker. Built with [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE) © ClawBrowse contributors.
