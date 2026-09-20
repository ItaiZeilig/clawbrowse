# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
