# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ItaiZeilig/jevbridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ItaiZeilig/jevbridge/releases/tag/v0.1.0
