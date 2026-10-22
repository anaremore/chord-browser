# S2: Google sign-in

**Result: pass for Google on Windows. Decision: ship a standard Chromium user agent.**

## Evidence (2026-10-22, Windows 11, Electron 45.0.0)

- Electron's default user agent is
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ChordDev/0.0.0 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36`.
  It names both the app and Electron. `navigator.userAgentData.brands` lists only `Not:A-Brand` and `Chromium`.
- **Automated probe, fresh profile:** Google refused with "Couldn't sign you in. This browser or app may not be secure."
  - The probe drives Chord through Playwright, which attaches a DevTools debugger. Google flags automated browsers.
  - The manual results below show that automation, not Electron, triggered the block.
- **Manual sign-in by the project owner, fresh profiles:** succeeded with **both** user agents:
  - A: Electron's default.
  - B: the default minus the `Electron/…` and app-name tokens.

## Decision

Ship B: the standard Chromium user agent, the same format other Chromium browsers send (`src/main/user-agent.ts`).

- **Why, when A also works for Google:** some sites sniff "Electron" and serve degraded or blocked pages, and the extra tokens buy nothing.
- **This is not impersonation:**
  - The string is Chromium's own format.
  - Client-hint brands still say `Chromium`, not `Google Chrome`.
- An E2E test asserts that pages see no `Electron/` or `Chord` token.
- Development builds can compare against Electron's default with `CHORD_UA=electron`.

## Still to check (by hand, once M1.1 adds an address bar)

- Google on macOS and Linux.
- Microsoft, Apple, and GitHub sign-in.
- A Cloudflare Turnstile page. Electron sends no `Sec-CH-UA` headers on navigations (Electron PR #53519), which bot checks may notice.
- Automated tests must never be used to judge sign-in. Google blocks them by design.
