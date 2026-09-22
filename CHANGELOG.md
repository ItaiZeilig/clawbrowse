# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.4] - 2026-09-22

Release-readiness hardening from a three-part production review (extension, MCP server, packaging).

### Fixed
- **Timed-out commands can no longer leak and race the next one.** A large `act` batch that hit
  the 25s bound used to keep running after the queue advanced, issuing CDP against the tab
  concurrently with the following command (and risking double execution on agent retry). Commands
  now carry a cancellation token; `act`/`navigate` stop issuing further ops once it fires.
- **In-flight tool calls no longer hang for the full timeout when the extension disconnects.** The
  MCP server now rejects all pending requests immediately when the extension socket closes or is
  replaced, instead of waiting out `CMD_TIMEOUT_MS`.
- **Port-in-use no longer kills the MCP server.** If another PawBrowse instance already owns the
  bridge port, the stdio server stays up and reports a clear reason via `browser_status` /tool
  errors, rather than the client showing "server failed / all tools unavailable".
- **An explicitly-passed `tabId` is now validated** against restricted pages (`chrome://`,
  `devtools://`, the Chrome Web Store, …), same as the active-tab path; `navigate` only accepts
  http(s) URLs (bare domains are prefixed with `https://`), refusing `javascript:`/`chrome:` targets.
- **A throw in the page-text walker or id-building no longer blanks the element table** — those
  steps are wrapped so the already-computed controls are still returned.
- **Options "Save & reconnect" now actually reconnects** on a port change (previously it kept the
  old socket until it happened to drop).
- **Clearing a field works** (`type` with empty text now sends Backspace after select-all instead
  of a no-op `insertText('')`).
- WebSocket bridge hardening: reject malformed/oversized control frames, cap reassembled
  fragmented messages, validate `PAWBROWSE_PORT`/`PAWBROWSE_TIMEOUT_MS` (bad values fall back to
  defaults), return `-32602` for a malformed `tools/call`, and add last-resort
  `uncaughtException`/`unhandledRejection` guards so a stray throw can't drop the bridge.

### Tests
- Replaced the single round-trip script with a **21-case adversarial suite** (`node --test`, still
  zero-dependency): MCP protocol (initialize/tools/list/annotations/ping/`-32601`/`-32602`/unknown
  tool/notifications), no-extension errors, round-trip + error propagation + out-of-order id
  correlation, and regressions for every fix above (disconnect fast-fail, last-wins takeover,
  port-in-use stays alive, bad env vars) — plus raw-socket attacks (web-origin rejection, oversized
  frame, malformed control frame, non-JSON garbage) and stdin-close shutdown.

### Known limitations (documented, not yet supported)
- Controls inside **shadow DOM** and **same-origin iframes** are not yet enumerated; the bridge
  trusts any **local process** on `127.0.0.1` (no shared token yet). See the README.

## [0.3.3] - 2026-09-22

Follow-ups from live testing + grounding the approach in the CDP/MV3 docs (rather than guessing).

### Added
- `Emulation.setFocusEmulationEnabled` on attach, so a background tab keeps focus/blur,
  rendering, and focus-dependent menus/dropdowns behaving while driving (the same approach
  Playwright uses). Note: a hidden tab still throttles `requestAnimationFrame`, so all waits
  use `setTimeout`/`setInterval`, never rAF.

### Fixed
- **A single hung command can no longer wedge the whole extension**: each queued command is
  bounded (25s) so the serialized queue always advances, even if the underlying work stalls.
- **Extension reload always reconnects**: the bridge now accepts the newest connection and
  drops the previous one (last-wins), instead of rejecting a second connection while an old
  socket lingers (which could lock the reloaded extension out). Only the current socket is
  trusted for replies; the origin check still blocks web pages.

## [0.3.2] - 2026-09-22

### Fixed
- **Actions no longer hang when driving a background tab** (the normal case). The
  combobox-suggestion wait used `requestAnimationFrame`, which Chrome pauses in background
  tabs, and had no `setTimeout` fallback — so `browser_act` could hang until the 30s command
  timeout. It now polls with `setInterval` + a hard `setTimeout` cap, which fire in background
  tabs. Found by live testing.

## [0.3.1] - 2026-09-22

Hardening from a second multi-agent review (bug-hunt on the v0.3.0 code itself).

### Fixed
- **Perception never blanks a whole page**: the in-page snapshot now wraps each element and the
  outer pass in try/catch, so one quirky element (throwing getter, overridden DOM method) can no
  longer abort the entire observation.
- **Stable element refs**: displayed ids derive from the stable node identity (`e<node>`), so a
  reused number can never silently retarget a different control across observations.
- **Semantic guard narrowed to role + accessible name**, removing false "element changed"
  positives on benign value/state churn and same-element multi-op batches (still catches relabels).
- **Options page status** no longer opens a competing socket (which the single-connection guard
  rejected, inverting the readout); it now asks the background worker for live status.
- `type` rejects a de-editable contenteditable; checkbox/radio no longer show a cosmetic `"on"`;
  `click_text` pre-filters by text to avoid layout thrash on large pages.

### Changed
- Commands are **serialized** in the extension so overlapping tool calls can't race the shared
  debugger session.
- Bridge `LIVE_MS` lowered 30s→15s (faster reconnect after an unclean disconnect); keepalive
  alarm set to 0.5 min (avoids Chrome's sub-30s clamp warning).

## [0.3.0] - 2026-09-22

Renamed **JevBridge → PawBrowse**, plus a second, deeper multi-agent audit that closes the
remaining correctness, robustness, and hardening gaps.

### Added
- **Semantic freshness guard**: an element's meaning (role/name/value/checked/selected/expanded)
  is fingerprinted at observe time and re-checked before acting, so a silently relabeled or
  changed target is rejected with "observe again" instead of mis-clicked.
- **`aria-expanded` / `aria-selected`** surfaced in the table (▾/▸ open/closed, ◉ selected) so
  the agent can tell an open menu / active tab from a closed one.
- **Combobox "Open" companion action** and a **targeted autocomplete wait** (polls for visible
  `[role=option]` after typing, instead of a fixed delay).

### Changed
- **Change-detection now includes per-input value/checked/selectedIndex**, fixing false
  "page did NOT change" after a successful fill/toggle/select (password values excluded).
- **Scroll uses a real wheel event** so overflow containers, virtualized lists, and infinite
  scroll fire.
- SELECT: raised option cap (15→40) and excludes `optgroup[disabled]`.

### Fixed
- **No more double-execution**: if the post-action observation fails (page navigating), ops are
  reported as executed with "call observe next," instead of throwing so the caller retries them.
- **`type` re-checks read-only at action time**; `select` runs the full live guard and returns a
  navigation-safe message if its change handler destroyed the context.
- **`click_text` now hit-tests** (elementFromPoint containment) so it can't hit a covered element.

### Security
- The bridge **rejects a second WebSocket while a live extension is attached** and **only trusts
  the current socket's replies**, closing the local takeover/forgery vector (a stale socket still
  ages out so a normal reload reconnects). Inbound frames are **size-capped** (8 MB) and
  `browser_act` caps ops per call (50).

### Docs
- Operational guidance baked into tool descriptions (WAIT discipline, "a matching result doesn't
  prove a filter applied," "a matching link isn't success — click through and assert," don't
  re-type an already-correct field).

## [0.2.0] - 2026-09-22

Perception + reliability overhaul, adapting techniques from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT).

### Added
- Proper **accessible-name resolution** (aria-labelledby → aria-label → `<label>` → alt →
  text → title) for far better element labels.
- Native **`checkVisibility`** filtering plus `aria-hidden`/`inert` exclusion.
- **Viewport-center filtering** — only currently-visible, hit-testable controls are listed.
- **Hit-testing before every click** (`elementFromPoint` containment) and **geometry
  re-resolved at action time**, so moving or covered targets never mis-click.
- Robust **fill** via select-all + `insertText` (works with React/controlled inputs).
- **Page-changed signal** on `browser_act` results (a "no change" hint when an action had
  no effect), and **observe retry** through page transitions.
- `select` matches by value/label/text and only among enabled options.
- Operational guidance + an untrusted-page-data warning baked into the tool descriptions.

### Security
- `password`, `file`, and `hidden` inputs are excluded and their values are never exposed.
- The local bridge now **rejects WebSocket connections from web-page origins** (only
  `chrome-extension://` or origin-less local tooling may connect), so a malicious page can't
  open `ws://127.0.0.1` and impersonate the extension.

## [0.1.2] - 2026-09-21

### Added
- `click_text` op for `browser_act`: clicks the most specific visible element matching a
  string, for custom widgets/menus (dropdowns, flair pickers) that aren't standard controls
  and so can't be referenced from the element table.

## [0.1.1] - 2026-09-21

### Added
- `browser_read` tool: returns a tab's readable text (prose/articles), for pages where the
  element table isn't enough.

### Changed
- Removed the `<all_urls>` host permission — `chrome.debugger` does not require it for regular
  tabs, which avoids the Chrome Web Store "broad host permissions" review delay.

### Fixed
- MCP server exits when the client closes the stdio pipe and fails loudly on a busy port, so
  it can no longer linger as a zombie holding the bridge port.

## [0.1.0] - 2026-09-20

### Added
- Zero-dependency MCP server (`mcp/server.mjs`) exposing a localhost WebSocket bridge and
  six tools: `browser_status`, `browser_tabs`, `browser_navigate`, `browser_observe`,
  `browser_act`, `browser_assert`.
- Chrome MV3 extension that drives the user's real, logged-in tabs via `chrome.debugger`
  (CDP) — no remote-debug port and no browser relaunch required.
- **Element-table** perception: pages are read as numbered, stable-ref controls
  instead of screenshots.
- Options page to configure the bridge port and check connection status.
- End-to-end round-trip test (`npm test`) and CI.

[Unreleased]: https://github.com/ItaiZeilig/pawbrowse/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.3
[0.3.2]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.2
[0.3.1]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.1
[0.3.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.3.0
[0.2.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.2.0
[0.1.2]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.1.2
[0.1.1]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.1.1
[0.1.0]: https://github.com/ItaiZeilig/pawbrowse/releases/tag/v0.1.0
