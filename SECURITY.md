# Security Policy

ClawBrowse's extension holds powerful permissions (`debugger` + host access to all sites),
which is exactly why we take security reports seriously. Thank you for helping keep users safe.

## Supported versions

The project is pre-1.0. Security fixes are applied to the latest `main` and the most recent
release only.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions,
or pull requests.**

Instead, use one of these private channels:

1. **GitHub Private Vulnerability Reporting** (preferred) — go to the repository's
   **Security** tab → **Report a vulnerability**. This opens a private advisory visible only
   to the maintainers.
2. **Email** — **itaizeilig1@gmail.com** with the subject line `ClawBrowse security`.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof-of-concept helps).
- The affected version/commit and your environment (OS, Chrome version).

## What to expect

- We aim to acknowledge reports within **7 days**.
- We will keep you updated on progress and coordinate a disclosure timeline with you.
- With your permission, we will credit you in the release notes for the fix.

## Scope & hardening notes

Because the extension can read and act on any page in your profile:

- The MCP bridge binds to **`127.0.0.1` only** and is not exposed to the network.
- There is **no external model and no API key**: page snapshots are returned to the calling
  agent as tool results and are not sent to any third-party service.
- Only install the extension from source you have reviewed, and only load it in a profile
  you're comfortable granting that access.

Reports about these boundaries being broken (e.g. the bridge accepting non-local connections,
data being sent off-device) are especially welcome.
