# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

Renamed **JevBridge → ClawBrowse**, plus a second, deeper pass over
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT) driven by a
multi-agent audit. Closes the remaining correctness, robustness, and hardening gaps.

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
- jev-style **element-table** perception: pages are read as numbered, stable-ref controls
  instead of screenshots.
- Options page to configure the bridge port and check connection status.
- End-to-end round-trip test (`npm test`) and CI.

[Unreleased]: https://github.com/ItaiZeilig/clawbrowse/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/ItaiZeilig/clawbrowse/releases/tag/v0.3.1
[0.3.0]: https://github.com/ItaiZeilig/clawbrowse/releases/tag/v0.3.0
[0.2.0]: https://github.com/ItaiZeilig/clawbrowse/releases/tag/v0.2.0
[0.1.2]: https://github.com/ItaiZeilig/clawbrowse/releases/tag/v0.1.2
[0.1.1]: https://github.com/ItaiZeilig/clawbrowse/releases/tag/v0.1.1
[0.1.0]: https://github.com/ItaiZeilig/clawbrowse/releases/tag/v0.1.0
