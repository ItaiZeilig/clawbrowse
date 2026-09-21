# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
