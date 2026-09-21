# ClawBrowse Privacy Policy

_Last updated: 2026-09-20_

ClawBrowse is an open-source developer tool that lets a local AI coding agent (such as
Claude Code) read and act on web pages in your own browser. This policy explains what the
extension does and does not do with data.

## Summary

**ClawBrowse does not collect, store, transmit, or sell any personal data to us or to any
third party.** There are no analytics, no tracking, no telemetry, and no external servers
operated by the developer.

## How it works

The extension connects only to a **local bridge on your own computer** (`ws://127.0.0.1`,
i.e. `localhost`), which is the ClawBrowse MCP server that you run yourself. When your local
AI agent requests it, the extension reads the content of the active tab (as a list of page
elements and their text) and performs actions you or your agent direct (clicks, typing,
navigation). That page information is passed back **only** over the local connection to the
agent you are running. It is never sent to the ClawBrowse developer or to any remote service
by this extension.

## Data handled

- **Web page content** (text and form values of the pages you drive) — read on demand and
  sent only to your local bridge. Not stored by the extension beyond the current operation.
- **Extension settings** (the bridge port number) — stored locally in `chrome.storage.local`
  on your device. Never transmitted.

ClawBrowse does **not** handle or collect: personally identifiable information for the
developer's use, authentication credentials, financial or payment information, health
information, location, or browsing history for any purpose other than fulfilling your own
agent's immediate request on the current tab.

## Where your data goes

Your data goes only to software running on your own machine. Note that the AI agent you
connect ClawBrowse to (for example, Claude Code) has its own privacy terms governing what it
does with the page content you send it. ClawBrowse itself adds no additional destination.

## Permissions

- `debugger` — required to read and act on the pages you choose to drive, via the Chrome
  DevTools Protocol. Used solely to fulfill your agent's requests. (No broad host permission
  is requested; the debugger API operates on the tab you target.)
- `tabs` — to list and target tabs.
- `storage` — to save your bridge-port setting locally.
- `alarms` — to keep the local connection alive.

## Changes

Any changes to this policy will be published in this file in the public repository at
https://github.com/ItaiZeilig/clawbrowse.

## Contact

Questions about privacy: **itaizeilig1@gmail.com**.
