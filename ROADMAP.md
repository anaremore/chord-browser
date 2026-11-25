# Chord — Roadmap

Last updated 2026-11-25 · Latest release: **0.14.1** (2026-11-24, security) · Companions: [README.md](README.md), [RELEASE_NOTES.md](RELEASE_NOTES.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md)

Chord is a calm, fast, private desktop browser for Windows, macOS, and Linux (X11 and Wayland). Every milestone here is framed as what changes for the person using Chord. For release-by-release history, see [RELEASE_NOTES.md](RELEASE_NOTES.md); for technical background and spikes, see [docs/decisions/](docs/decisions/).

---

## Done

Everything below is shipped in a preview release or merged on `main`.

- **Daily-driver browsing shell (0.1.0–0.10.0).** Vertical sidebar with pinned tabs, nestable folders, per-chord Favorites, auto-archiving unpinned tabs, and minimal mode; color-themed chords with optional separate sign-ins and per-chord proxies; instant command bar (`⌘T` / `Ctrl+T`); split view (up to four panes); Peek, mini windows, and link routes; Chrome extensions; built-in ad and tracker blocking ([S11](docs/decisions/S11-ad-blocking.md)), Google Safe Browsing, and Google-free mode ([S10](docs/decisions/S10-google-free.md)); reader view, built-in screenshots, media controls and auto picture-in-picture ([S7](docs/decisions/S7-auto-pip.md)), single-tab screen sharing with presenting mode, docked DevTools, and crash resilience; signed Windows builds and differential in-app updates on Windows and AppImage. See [RELEASE_NOTES.md](RELEASE_NOTES.md).
- **Effects and assistant form filling (0.3.0–0.4.0).** Restyle any site with your own CSS, hidden elements, presets, or assistant-written styles behind a Dry/Wet toggle; ask the assistant to fill a form after you review each field ([ARCHITECTURE.md §9](ARCHITECTURE.md#9-browser-engine-services), [§11](ARCHITECTURE.md#11-the-assistant-panel)).
- **Your data: import, export, and encrypted sync (0.2.0, 0.5.0–0.6.0).** Bring bookmarks, history, and Firefox open tabs in from Chrome, Edge, Brave, Firefox, and Safari; export everything to one plain or passphrase-encrypted file ([docs/data-format.md](docs/data-format.md)); sync your chords, pinned tabs, Favorites, themes, settings, link routes, and Effects end-to-end encrypted through a folder you already sync ([S15](docs/decisions/S15-your-data.md)).
- **Widevine streaming through Chord Player (0.7.0–0.8.0, Chord Player 0.1.1–0.3.0).** Optional companion app for Netflix, Spotify, and other DRM services—playing right inside the tab on Windows and in its own window on macOS and Linux—so Chord itself stays on stock Electron for fast security updates ([S12](docs/decisions/S12-widevine.md), [S14](docs/decisions/S14-widevine-player.md)).
- **Built-in passwords vault (0.11.0–0.13.0).** Local passphrase-locked vault with click-to-fill menus, save and update cards, HTTP sign-in prompts, CSV and encrypted Chord-file import/export, site-rule password generation, sign-up and change-password flows, and support for two-step sign-ins, single-page apps, open shadow roots, same-origin frames, and major identity providers ([S17](docs/decisions/S17-passwords.md)).
- **Outside agents reading pages (0.14.0).** Connect Claude Code, Codex, or Antigravity over Chord's local MCP endpoint so agents open and read pages in their own sidebar tabs, or read a tab you explicitly share, with connect cards and one-key Stop ([S18](docs/decisions/S18-agent-mcp.md), [#98](https://github.com/anaremore/chord-browser/pull/98), [#99](https://github.com/anaremore/chord-browser/pull/99)).
- **Electron 45.4.1 security update (0.14.1).** Upstream Chromium, V8, ANGLE, Dawn, FFmpeg, and PDFium security fixes, shipped on Chord's 72-hour patch clock from a branch cut at 0.14.0 ([#63](https://github.com/anaremore/chord-browser/issues/63), [#121](https://github.com/anaremore/chord-browser/pull/121)). `main` has since moved to Electron 45.5.0 ([#162](https://github.com/anaremore/chord-browser/pull/162)).
- **Outside agents acting on pages (merged on `main`, shipping in 0.15.0).** Agents click, type, choose options, navigate, and press safe keys from page snapshots, with per-site approval cards, always-ask cards for risky steps and outgoing data sends, and peer-process checks ([#103](https://github.com/anaremore/chord-browser/pull/103), [#104](https://github.com/anaremore/chord-browser/pull/104), [#110](https://github.com/anaremore/chord-browser/pull/110), [#112](https://github.com/anaremore/chord-browser/pull/112)). Clicks hold up on pages that redraw their controls ([#117](https://github.com/anaremore/chord-browser/pull/117), [#154](https://github.com/anaremore/chord-browser/pull/154)), and your hand comes first on an agent's tabs: close them as your own, and reloading or navigating one pauses the agent (S18 M2e-1, [#116](https://github.com/anaremore/chord-browser/pull/116)). See [S18](docs/decisions/S18-agent-mcp.md).
- **The assistant acting in your tab, first two slices (merged on `main`, off in release builds).** The tab on screen, the action's lease, the site, risky-step, and *Send data* cards in the chat, Settings → Assistant → *Click and type on pages*, the bar with Stop, and the 6-second catch after each step for pickers, passkeys, popups, downloads, the clipboard, and service workers (S18 M2e-2a and 2b, [#147](https://github.com/anaremore/chord-browser/pull/147), [#150](https://github.com/anaremore/chord-browser/pull/150)).
- **Faster checks and tiered CI (merged on `main`).** Oxlint ([#105](https://github.com/anaremore/chord-browser/pull/105)), TypeScript 7 ([#106](https://github.com/anaremore/chord-browser/pull/106)), sharded and balanced end-to-end suites ([#108](https://github.com/anaremore/chord-browser/pull/108), [#133](https://github.com/anaremore/chord-browser/pull/133), [#171](https://github.com/anaremore/chord-browser/pull/171)), on-demand Knip ([#111](https://github.com/anaremore/chord-browser/pull/111)), tiered CI with full cross-platform runs only where a PR needs them ([#113](https://github.com/anaremore/chord-browser/pull/113), [#118](https://github.com/anaremore/chord-browser/pull/118), [#153](https://github.com/anaremore/chord-browser/pull/153)), and contributor and agent guidelines in `AGENTS.md` with invariant tests ([#120](https://github.com/anaremore/chord-browser/pull/120), [#123](https://github.com/anaremore/chord-browser/pull/123)).
- **Windows updates with an agent connected.** Setup ends an agent's relay instead of failing on its files ([#149](https://github.com/anaremore/chord-browser/pull/149)).

---

## Now

Work actively in flight on open branches and pull requests.

- **The assistant clicks and types in your tab (S18 M2e-2c).** The last slice: the leaving-site card (every time, with the whole address, including a same-site link that redirects away), typing what it read elsewhere shown first, and the switch that turns acting on in release builds. In a full Claude and Neon security pass; it ships in 0.15.0 with the owner's OK ([#151](https://github.com/anaremore/chord-browser/pull/151), [S18](docs/decisions/S18-agent-mcp.md#m2e-plan-the-assistant-acts-in-your-tab)).
- **Acting docs and the 0.15.0 release (S18 M2f).** [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md), this roadmap, the release notes, and [chordbrowser.com](site/public/index.html) for page acting by outside agents and the assistant; the README and site screenshots are regenerated from fixtures in the Linux container before the release.

---

## Next

Planned in order after the work in flight lands.

- **Acting polish and context-based risk checks (S18 M2g).** Make acting hold up on real-world pages (same-site iframes, late-loading controls, duplicate labels, and the remaining M2d follow-ups in [#115](https://github.com/anaremore/chord-browser/issues/115)), and replace coarse word lists with context-based risk checks: page structure, payment context Chord observed on this computer, a per-site *No real money here* choice, and escalation-only hints from the model, for outside agents and the assistant alike ([S18](docs/decisions/S18-agent-mcp.md#risk-from-context-for-agents-and-the-assistant-the-owner-2026-11-24-in-m2g)).
- **Fewer steps and tokens per task (S18 M2g-2).** Find an element or read a page's text without a full snapshot, results that stay the same between calls so models can cache them, a smaller tool list, refusals that say what to do next, and the assistant matching outside agents' tools.

---

## Later

Queued work without fixed dates, grouped by what it unlocks.

### Engine, security, and distribution

- **Electron 46 upgrade (expected 2027-01-05).** Chord's first major Electron upgrade, rehearsing the 8-week cadence on the 72-hour security clock ([docs/releasing/patch-runbook.md](docs/releasing/patch-runbook.md)).
- **macOS signing, notarization, and in-app updates.** Remove first-launch Gatekeeper warnings and turn on automatic updates on macOS (plus Touch ID for passkeys and passwords) once an Apple Developer account is set up ([docs/releasing/signing.md](docs/releasing/signing.md)).
- **Linux package channels (Flathub, apt, and dnf).** Publish Chord on Flathub and turn on signed Cloudsmith apt and dnf repositories so Linux users update through their package manager ([docs/releasing/flathub.md](docs/releasing/flathub.md), [docs/releasing/linux-repos.md](docs/releasing/linux-repos.md)).

### Agents and the assistant

- **Share a tab and let an agent act in it.** Opt-in acting on a tab you explicitly share with an outside agent, extending today's read-only tab sharing ([S18](docs/decisions/S18-agent-mcp.md#owners-answers-2026-11-22)).
- **WebMCP pass-through.** Expose sites' own structured page tools (`document.modelContext`) to outside agents and the assistant through Chord's approval gate once Chromium ships WebMCP on by default ([S18](docs/decisions/S18-agent-mcp.md#webmcp-later)).
- **Optional extension-free profile for agents.** An opt-in setting to run agent tabs in a dedicated profile (you sign in there once) without user extensions, closing Electron's current limit where extension content scripts still run inside agent tabs ([S18](docs/decisions/S18-agent-mcp.md#m2d-as-built-2026-11-23)).
- **Antigravity as a built-in assistant app (on hold).** Revisit when `agy acp` can disable or gate its built-in web search, timers, and subagents; Antigravity remains supported as an outside agent ([S19](docs/decisions/S19-antigravity-assistant.md)).

### Browsing and passwords

- **Passwords follow-ups and optional sync.** Fix remaining form-detection, subframe, and generator edge cases ([#39](https://github.com/anaremore/chord-browser/issues/39), [#41](https://github.com/anaremore/chord-browser/issues/41), [#60](https://github.com/anaremore/chord-browser/issues/60), [#66](https://github.com/anaremore/chord-browser/issues/66), [#68](https://github.com/anaremore/chord-browser/issues/68), [#71](https://github.com/anaremore/chord-browser/issues/71)), and revisit opt-in encrypted password sync ([S17](docs/decisions/S17-passwords.md#15-build-plan)).
- **User scripts (Tampermonkey) and upstream engine gaps.** Enable `chrome.userScripts` upstream in Electron—or build Tampermonkey's subset in Chord if upstream stalls ([S16](docs/decisions/S16-user-scripts.md), [electron/electron#55337](https://github.com/electron/electron/issues/55337))—and track upstream back/forward cache support ([electron/electron#55333](https://github.com/electron/electron/issues/55333)).
- **Everyday browsing additions.** Full-text search of pages you've read, page translation, floating multi-video players, compact density, faster signed site-rule and UI updates, and remaining manual verification passes (real-cloud sync in [docs/testing/sync.md](docs/testing/sync.md), macOS hardware checks in [docs/testing/macos.md](docs/testing/macos.md), and screen readers).

### Tooling and maintenance

- **Code quality and dependency hygiene.** Adopt Oxfmt at 1.0, evaluate type-aware Oxlint (`oxlint-tsgolint`), run a Knip unused-code cleanup ([#111](https://github.com/anaremore/chord-browser/pull/111)), keep Renovate's automated update PRs (installed 2026-11-24) flowing, and close open bug, test, and CI follow-ups ([#27](https://github.com/anaremore/chord-browser/issues/27), [#44](https://github.com/anaremore/chord-browser/issues/44), [#64](https://github.com/anaremore/chord-browser/issues/64), [#80](https://github.com/anaremore/chord-browser/issues/80), [#85](https://github.com/anaremore/chord-browser/issues/85), [#87](https://github.com/anaremore/chord-browser/issues/87)).

---

## Not planned

Decisions already settled as out of scope:

- **A Chord account, telemetry, or a Chord sync server.** Your data stays on your computer or syncs encrypted through a folder you already control ([ARCHITECTURE.md §1](ARCHITECTURE.md#1-scope)).
- **Arc import.** Import covers Chrome, Edge, Brave, Firefox, and Safari ([ARCHITECTURE.md §9](ARCHITECTURE.md#9-browser-engine-services)).
- **Bring-your-own API keys or local models in the assistant.** The assistant uses the Claude Code or Codex app and subscription you already run ([ARCHITECTURE.md §16 D8](ARCHITECTURE.md#16-decisions)).
- **Automatic tab organizing by the assistant.** The assistant reads and acts in your tab when you ask; it does not rearrange your sidebar ([ARCHITECTURE.md §16 D8](ARCHITECTURE.md#16-decisions)).
