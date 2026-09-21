# Contributing to PawBrowse

Thanks for your interest in improving PawBrowse! This project pairs a Chrome MV3
extension with a zero-dependency MCP server. Contributions of all kinds are welcome:
bug reports, docs, and code.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an issue with the *Bug report* template.
- **Suggest a feature** — open an issue with the *Feature request* template.
- **Improve docs** — typo fixes and clarifications are always welcome.
- **Submit code** — see the workflow below.

## Development setup

You need **Node.js ≥ 18** (Node ≥ 22 recommended so the test's global `WebSocket` client
works) and a Chromium-family browser.

```bash
git clone https://github.com/ItaiZeilig/pawbrowse.git
cd pawbrowse

# 1. Run the MCP server (Claude Code normally launches this for you)
node mcp/server.mjs

# 2. Load the extension: chrome://extensions → Developer mode → Load unpacked → extension/
# 3. Register with Claude Code:
claude mcp add --scope user pawbrowse -- node "$(pwd)/mcp/server.mjs"
```

See the [README](README.md#install-developer--unpacked) for the full install flow.

## Running tests

```bash
npm test        # end-to-end stdio + WebSocket round-trip test (no browser needed)
```

The test spawns the MCP server, connects a fake extension over the bridge, and drives it
through the MCP interface. CI runs this on every push and PR.

## Code style

- Plain modern JavaScript (ESM), no build step, **no runtime dependencies** — keep it that way.
  Zero-dependency is a feature: it keeps the whole thing auditable.
- Match the surrounding style (2-space indent, semicolons).
- Keep the MCP server (`mcp/server.mjs`) and the extension (`extension/`) independently readable.

## Pull request process

1. Fork the repo and create a branch from `main` (`git checkout -b fix/short-description`).
2. Make your change; add or update tests where it makes sense.
3. Run `npm test` and confirm it passes.
4. Open a PR using the template. Describe **what** changed and **why**, and note how you
   verified it (including manual browser testing if it touches the extension).
5. Keep PRs focused; one logical change per PR is easier to review.

## Reporting security issues

Please do **not** file public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
