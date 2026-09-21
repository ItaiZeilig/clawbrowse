# Chrome Web Store listing — PawBrowse

Copy-paste content and a step-by-step for submitting the extension. Assets are in
`assets/store/`, the upload package is `dist/pawbrowse-extension-v0.3.1.zip`.

---

## Product name
```
PawBrowse
```

## Summary (max 132 chars)
```
Let your local AI coding agent (Claude Code) drive your real Chrome tabs. Fast element-table control. Open source, no keys.
```

## Category
`Developer Tools`

## Language
`English`

## Detailed description
```
PawBrowse connects your local AI coding agent — such as Claude Code — to your real,
logged-in Chrome so it can read and act on web pages the way you would.

Instead of screenshots, PawBrowse reads each page as a compact, numbered element table
(e12 "Sign in", e7 "Email", ...), so your agent can click, type, select, navigate and
verify quickly and reliably.

The agent is the policy. PawBrowse does not run its own AI model and requires no API key.
It talks only to a local bridge on your own machine (127.0.0.1). Page content is passed to
the agent you are running and is never sent to the developer or any third-party server.

WHAT YOU NEED
- The open-source PawBrowse MCP server running locally (Node.js). See the project page.
- An MCP client such as Claude Code.

HOW IT WORKS
1. Run the PawBrowse MCP server (your AI client launches it).
2. This extension connects to it over a local WebSocket (127.0.0.1).
3. Your agent calls tools: observe (element table), act (click/type/select/scroll),
   navigate, and assert.

FEATURES
- Drives your real, logged-in browser via the Chrome DevTools Protocol — no separate
  debug port and no browser relaunch.
- Element-table perception with stable refs (numbered controls, not screenshots).
- No external model, no API keys, no telemetry.
- Fully open source (MIT).

Source, docs and issues: https://github.com/ItaiZeilig/pawbrowse
Privacy policy: https://github.com/ItaiZeilig/pawbrowse/blob/main/PRIVACY.md

PawBrowse is an independent open-source project and is not affiliated with or endorsed by
Google or Anthropic.
```

## Privacy policy URL
```
https://github.com/ItaiZeilig/pawbrowse/blob/main/PRIVACY.md
```

## Homepage / support URL
```
https://github.com/ItaiZeilig/pawbrowse
```

---

## Permission justifications (Privacy practices tab)

The dashboard asks you to justify each permission. Use these:

- **debugger** — "The extension drives web pages on the user's behalf via the Chrome
  DevTools Protocol (reading page elements, clicking, typing, navigating) as requested by
  the user's local AI agent. The debugger API is the mechanism that performs these actions
  in the user's existing tabs without a separate remote-debugging port."
- **host permissions** — Not requested. The extension acts on pages via the `chrome.debugger`
  API, which does not require host permissions for regular tabs, so no broad host access is
  declared. (If the dashboard still shows a host-permission field, leave it blank.)
- **tabs** — "To list open tabs and target the correct tab for an action."
- **storage** — "To store the local bridge port number the user configures. Stored locally;
  never transmitted."
- **alarms** — "To periodically re-establish the local WebSocket connection to the bridge
  (MV3 service workers are short-lived)."

- **Remote code**: "No. All code is contained in the package; nothing is fetched and executed
  at runtime."
- **Data usage disclosures**: Check **"Website content"** (page content is read on demand).
  Certify that data is **not** sold, **not** used for purposes unrelated to the core
  function, and **not** used for creditworthiness/lending. Data is sent only to the user's
  own local bridge.

---

## Assets checklist (in `assets/store/`)

| Asset | Size | File | Required |
| --- | --- | --- | --- |
| Store icon | 128×128 | `icon-128.png` | ✅ |
| Screenshot | 1280×800 | `screenshot-1280x800.png` | ✅ (at least 1) |
| Small promo tile | 440×280 | `promo-small-440x280.png` | ✅ |
| Marquee promo | 1400×560 | `promo-marquee-1400x560.png` | optional |

> The generated screenshot is a brand image. For a stronger listing, add a real screenshot
> (1280×800) of Claude Code using PawBrowse — e.g. an element table being read and an action
> run. Up to 5 screenshots are allowed.

---

## Submission steps (only you can do these — needs your Google account)

1. Enable **2-Step Verification** on your Google account (required to publish).
2. Go to the **Chrome Web Store Developer Dashboard**
   (https://chrome.google.com/webstore/devconsole), sign in, pay the **one-time US$5**
   registration fee, verify your contact email, and accept the developer agreement.
3. Click **Add new item** → upload `dist/pawbrowse-extension-v0.3.1.zip`.
4. Fill the **Store listing** tab with the name, summary, description, category, and URLs
   above; upload the icon, screenshot, and promo tiles from `assets/store/`.
5. Fill the **Privacy practices** tab: single purpose, the permission justifications above,
   the data-usage disclosures, and the privacy policy URL.
6. Set **Visibility** (Public, or Unlisted if you want a link-only release first — Unlisted
   is a good way to dogfood before a public launch).
7. **Submit for review.** Expect extra scrutiny because of the `debugger` permission (no host
   permissions are requested); reviews can take from a day to a couple of weeks and may come
   back with questions. Answer with the justifications above.

## Note on the published extension ID
When published, Google assigns a new extension ID (different from the unpacked dev ID). The
PawBrowse MCP server does not pin a specific extension ID, so nothing needs to change after
publishing.
