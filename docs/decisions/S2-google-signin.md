# S2: Google sign-in

**Status: in progress, waiting on a manual test.**

## What we know (2026-10-22, Windows 11, Electron 45.0.0)

- Electron's default user agent is
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ChordDev/0.0.0 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36`.
  It names both the app and Electron. `navigator.userAgentData.brands` lists only `Not:A-Brand` and `Chromium`.
- **Automated probe, fresh profile, default UA:** after entering an email, Google showed "Couldn't sign you in. This browser or app may not be secure."
  - Google served its "WebLiteSignIn" flow first, a reduced variant.
  - **Confounder:** the probe drives Chord through Playwright, which attaches a DevTools debugger. Google flags automated browsers regardless of user agent, so this result can't separate "automation" from "Electron".
- A developer profile that had been used by hand already held a Google session, which hints that manual sign-in may work.

## Next

1. A person signs in by hand in two builds: the default UA, and a Chromium UA without the `Electron/…` and app-name tokens (`CHORD_UA=chromium`, development builds only).
2. Repeat for Microsoft, Apple, GitHub and a Cloudflare Turnstile page.
3. Decide the shipping UA from those results.
4. Check whether Crest (MPL-2.0, Chromium engine) found a working approach.
