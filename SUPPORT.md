# Support

Need help with JevBridge? Here's where to go.

- **Setup and usage questions** — read the [README](README.md) first; it covers install and
  the tool reference. If you're still stuck, open a [GitHub Discussion] or a question issue.
- **Something's broken** — open a [bug report](https://github.com/ItaiZeilig/jevbridge/issues/new/choose).
- **Feature ideas** — open a [feature request](https://github.com/ItaiZeilig/jevbridge/issues/new/choose).
- **Security issues** — do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Common issues

- **Extension badge isn't green** — the MCP server isn't running or the port doesn't match.
  Claude Code launches the server when it starts; confirm the port in the extension options
  matches `JEVBRIDGE_PORT` (default `10577`).
- **"Another debugger is already attached"** — the target tab has DevTools open or is being
  driven by another extension. Only one debugger client per tab; switch tabs or close DevTools.
- **A tab can't be driven** — `chrome://` pages, the Web Store, and other browser pages are
  off-limits by design. Use a normal web page.

[GitHub Discussions]: https://github.com/ItaiZeilig/jevbridge/discussions
