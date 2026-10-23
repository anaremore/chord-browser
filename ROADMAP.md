# Chord — Roadmap

Status: **draft for review** · Last updated 2026-10-22 · Companions: [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md)

Every milestone ends with something you can actually use, on all three operating systems. Dates are targets, not promises. The one hard date is Arc's shutdown on **Tue 2026-12-22**, and Phase 1 is sized to ship a public preview eight days before it.

---

## How we work (agreed 2026-10-22)

- **Windows first.** Windows is your daily driver. Every feature is built and verified by hand on Windows first; macOS and Linux stay green in CI throughout.
- **Parity at the end of each phase.** Full parity on all three OSes (the brief's rule) is required before each phase closes, so M1.6 includes a parity pass.
- **Push to `main` after each significant change.** CI runs the full OS matrix on every push.
- **Hands-on testing:**
  - Windows: on this machine, with its 144 Hz display.
  - macOS: on your Apple Silicon MacBook.
  - Linux: in your VM, plus WSLg and CI (X11 and Wayland).

## Definition of done (every milestone)

A milestone is done when all of these hold:

1. **It works on every target.**
   - macOS: arm64 and x64.
   - Windows: x64 and arm64.
   - Linux: x64 and arm64, on both **X11 and Wayland**.
   - CI is green across that whole matrix.
2. **It's tested.** Unit tests cover the logic; E2E tests cover the milestone's flows.
3. **The UI passed design QA** (DESIGN.md §12):
   - Captures from every OS × light/dark × 3 themes.
   - I critique those captures against DESIGN.md and fix what fails before you see anything.
   - New interactions get trace tests and a 144 Hz screen recording.
4. **Performance budgets are checked** (ARCHITECTURE.md §1) for every surface the milestone touches.
5. **The basics are respected in new UI:**
   - Undo for destructive actions.
   - Keyboard access, with a registered shortcut where DESIGN.md §14 lists one.
   - Reduced motion and reduced transparency.
   - Every new animation has its switch in Settings → Motion (DESIGN.md §6.8).
6. **You get a handoff note**:
   - What to try.
   - What to verify by hand, split by platform where behavior differs.
   - What's known to be missing.

---

## At a glance

| Phase | Milestone | Target | When it's done, you can… |
|---|---|---|---|
| **1 · Daily driver** | M1.0 Foundations | Oct 23 → Oct 30 | launch a themed Chord window that browses one page, on all three OSes |
| | M1.1 Browsing shell | → Nov 6 | browse with real tabs, search Google from ⌘T, quit and find your tabs again |
| | M1.2 Sidebar | → Nov 16 | pin, fold, drag, close, and undo the Arc way; collapse to the Dia-style bar |
| | M1.3 Chords | → Nov 23 | keep separate colorful chords, optionally with separate sign-ins, and swipe between them |
| | M1.4 Command bar + archive | → Nov 30 | find any tab, page, or action from ⌘T; idle tabs tidy themselves away |
| | M1.5 Extensions + essentials | → Dec 7 | use your password manager and Chrome extensions; videos pop out when you switch away; Chord is your default browser |
| | M1.6 First run + preview | → **Mon Dec 14** | install Chord 0.1 from GitHub on any machine and switch from Arc |
| **2 · Side by side** | — | Jan 2027 | work in splits, hover-preview pinned tabs and folders, and chat with Duet about your tabs |
| **3 · Links from everywhere** | — | Feb 2027 | open links from other apps in a mini window, Peek from pinned tabs, install from Flathub or apt/dnf, update in place |
| **4 · Deeper** | — | Mar 2027 + | use Duet in developer mode, your own API keys or local models, and signed builds |

## Where we are (updated 2026-10-22)

Phase 1 is well ahead of the dates above. Every item marked done is on `main`, with unit and E2E tests, and the six release targets build and pass their smoke tests.

| Milestone | Done | In progress | Left |
|---|---|---|---|
| M1.0 Foundations | all | | |
| M1.1 Browsing shell | tabs, find, downloads, permission prompts, error and crash pages, sign-in popups, session restore, keyboard routing (S8) | | |
| M1.2 Sidebar | Pinned/Today, folders, Favorites, drag and drop, resize, Clear Today, keyboard navigation, minimal bar with peek | | arc animation on archive |
| M1.3 Chords | chords, icons, themes and the theme library, separate sign-ins, moving tabs across chords | trackpad swipe, color wheel and *Surprise me* | |
| M1.4 Command bar + archive | ranking with learned picks, history, completion, suggestions, site keywords, `@` filters, archive, sleeping tabs, ⌘⇧T | | |
| M1.5 Extensions + essentials | Chrome extensions (sidebar shelf), auto picture-in-picture, default browser, several windows, private windows | PDFs, spellcheck, screen sharing, site permissions page, **editable shortcuts** (moved up from Phase 3) | real password-manager sign-in checks |
| M1.6 First run + preview | first run, unsigned packaging for six targets, install notes, update check | CI green on every OS, macOS hands-on on your MacBook | accessibility pass, design QA sweep, performance budgets, the 0.1 release |
| Phase 2 | | Duet browse mode | split view, hover previews, Connect an agent, Electron 46 |

---

## Before we start

**Answered 2026-10-22:**
- **Q1:** Push to `main` after each significant change.
- **Q2:** App ID `com.chordbrowser.Chord`.
- **Q3:** You test on an Apple Silicon MacBook and a Linux VM; Windows is the primary platform (see *How we work*).

**Needed by a specific milestone:**

| # | Question | Needed by | My default |
|---|---|---|---|
| Q4 | Google search suggestions while typing. They make the command bar feel faster, but every keystroke goes to Google. | M1.1 | **On**, with a clear switch in Settings |
| Q5 | Favorites: the row of app tiles at the top of the sidebar, shared across chords. Arc had them and your Dia screenshot shows them. | M1.2 | **Yes**, in M1.2 |
| Q6 | Sidebar toggle shortcut: ⌘S / Ctrl+S (matches Arc, shadows "Save page") or ⌘⇧S / Ctrl+Shift+S | M1.2 | ⌘S, with Save page on ⌘⇧S |
| D1 | Extension library license (ARCHITECTURE.md §16) | M1.5 | **Decided:** GPL-3 combined binaries; source is MIT |
| D4 | DRM for Netflix and Spotify (ARCHITECTURE.md §16) | M1.6 | Stock Electron in v1, no DRM |

**Defaults I'll use from DESIGN.md §13 unless you object:**
- Duet on ⌘E / Ctrl+E.
- Domain-only top strip on Windows/Linux.
- Grain at 0.35.
- Compact density deferred.
- No sounds.
- Peek-on-hover on in minimal mode.

---

## Phase 1 — Daily driver

**Goal:** a browser an Arc user can switch to and live in every day, on macOS, Windows, and Linux, before Arc goes dark.

### M1.0 Foundations · Oct 23 → Oct 30

- **Monorepo scaffold:**
  - pnpm workspaces, TypeScript strict, React 19 + React Compiler.
  - electron-vite 6 on **Electron 45**. Its Electron 45 support is unverified, so the first commit proves it; the fallback is ejecting to plain Vite.
  - Packages: `@chord/core`, `ipc`, `db`, `tokens`, `ui`.
- **Quality gates:**
  - ESLint plus the token-enforcing stylelint rules (DESIGN.md §4.1).
  - Vitest.
  - A Playwright `_electron` harness with test-only IPC.
- **CI matrix:**
  - `macos-26`, `macos-15-intel`, `windows-latest`, `windows-11-arm`, `ubuntu-24.04` (Xvfb and Weston-headless Wayland), and `ubuntu-24.04-arm`.
  - Visual captures are uploaded as artifacts on every PR.
- **Repo hygiene:**
  - `LICENSE` (MIT), README, CONTRIBUTING, CODE_OF_CONDUCT.
  - SECURITY.md, with a temporary contact until `security@chordbrowser.com` exists.
  - Renovate config and the `electron-watch` workflow (ARCHITECTURE.md §14).
- **Foundations:**
  - The `tokens` package with `createChordTheme()` and its 10,000-input contrast test.
  - The `core` reducer with undo round-trip property tests.
  - The `chord-data` utility process with `node:sqlite`, migrations, and backups.
- **Spikes**, each about a day, with results written up in `docs/decisions/`:
  - **S1** `node:sqlite` with FTS5 in utilityProcess on every OS.
  - **S2** sign-in and bot-check matrix: Google, Microsoft, Apple, GitHub, Cloudflare Turnstile. This is the biggest risk.
  - **S3** the macOS default-browser prompt.
  - **S4** blur over a tab view.
  - **S6** trackpad gesture phases per OS.
  - **S7** auto picture-in-picture controls and *back to tab* routing.
  - **S8** keyboard routing: reserved keys caught before the page, page-first keys that defer to it (DESIGN.md §14).

### M1.1 Browsing shell · → Nov 6

- **Window:**
  - Composition: shell, tab, popover, and overlay views (ARCHITECTURE.md §5).
  - Materials: vibrancy, Mica, or solid.
  - Native window controls: traffic lights on macOS, Window Controls Overlay on Windows and Linux.
  - The inset, rounded content frame, with layout sync.
- **Tabs:**
  - Open, close, activate, and navigate, with history recording and favicons (including fallback monograms).
  - Sleeping tabs.
  - OAuth-capable popups.
- **Browser basics:**
  - Native context menus, find in page, fullscreen.
  - Downloads, permission prompts.
  - Certificate interstitial, crash page.
- **Command bar v0:** always mounted; URL, Google search, open tabs. ⌘T opens it centered; **⌘L / Ctrl+L edits the address in place** in the URL pill.
- **Keyboard:** the shortcut registry and every Phase 1 shortcut in DESIGN.md §14 that has an action by then; the rest are added as their features land. Includes the cheat sheet (⌘⌥/ / Ctrl+Alt+/).
- **Persistence:** session restore on relaunch.

### M1.2 Sidebar · → Nov 16

- **Structure:**
  - Pinned and Today sections.
  - Nestable, collapsible folders.
  - Pinned tabs reset to their URL.
  - *Clear* Today.
  - Favorites, if Q5 is yes.
- **Drag and drop** with live make-room animation and the drop settle (`@dnd-kit/react` wrapped in `SortableTree`).
- **Choreography:** distinct close, archive, and pin motions (DESIGN.md §6.5), with undo toasts for every destructive action.
- **Collapse to minimal mode** (DESIGN.md §3.3), with peek-on-hover.
- **Polish:** sidebar resize with detent; full keyboard tree navigation and keyboard drag-and-drop.

### M1.3 Chords · → Nov 23

- **Chords:** create, rename, reorder, delete with undo; icons.
- **ThemePicker:** wheel, swatches, presets, grain, light/dark/auto, *Surprise me*.
- **Switching:**
  - ⌘/Ctrl+1–9 and clicking the switcher.
  - **1:1 trackpad swipe**, interruptible, on both the sidebar and the minimal bar.
  - Theme crossfade.
- **Keep sign-ins separate:** per-chord profiles and session partitions. Moving a tab across a profile boundary is handled explicitly.

### M1.4 Command bar + archive · → Nov 30

- **Unified search:**
  - Sources: open tabs in every chord, pinned tabs, history (FTS5), archive, actions.
  - Ranking ported from Crest's tested scoring, with learned picks per chord. Inline autocomplete, and Google suggestions (per Q4).
  - `@tabs`/`@history`/… filters, site keywords (`yt`+Tab), and Enter variants that choose where a result opens (DESIGN.md §7.3).
  - **Budgets measured:** under 50 ms to open, and results on the same frame as each keystroke.
- **Archive:**
  - The auto-archive policy, per-chord idle time (default 12 h).
  - `chord://archive` with restore.
  - ⌘⇧T walks the archive.

### M1.5 Extensions + essentials · → Dec 7

- **Chrome extensions:**
  - Install, update, and remove from the Chrome Web Store, per profile.
  - Toolbar action buttons and popups, in the sidebar URL pill, the minimal bar, and the Windows/Linux strip.
  - Extension context-menu items.
  - Security fixes applied to the Web Store installer.
  - **Acceptance suite:** Bitwarden, 1Password, Proton Pass, Dark Reader, uBO Lite smoke test.
- **Auto picture-in-picture**, as in your Dia screenshots (ARCHITECTURE.md §9). It depends on S7.
- **Password-manager desktop links:** let 1Password and Bitwarden extensions reach their desktop apps through native messaging. This is Crest's fix: also look in Chrome's `NativeMessagingHosts` locations, the registry on Windows.
- **Resilience:** crashed pages reload themselves at most twice; playing, PiP and screen-sharing tabs are never slept or archived.
- **Private windows.**
- **Default browser** on all three OSes:
  - Windows: the NSIS include that writes the registry keys, plus a deep link to Settings.
  - macOS: `Info.plist` and the system prompt.
  - Linux: `.desktop` plus GIO and `xdg-settings`.
  - For now, links from other apps open in the active window; the mini window arrives in Phase 3.
- **`chord://settings`:** search engine, auto-archive, appearance, PiP, extensions, default browser, update channel.

### M1.6 First run + preview release · → Mon Dec 14

- **First run:** the onboarding flow from DESIGN.md §8.1, under 60 s to your first chord. Empty states and a copy pass.
- **Accessibility pass:**
  - Every flow completed keyboard-only.
  - Screen-reader smoke test.
  - Reduced motion, reduced transparency, Windows High Contrast.
- **Full design QA sweep** across the capture matrix.
- **Unsigned packaging** (ARCHITECTURE.md §15.2):
  - macOS: universal `.dmg` + `.zip`. ⚠ Verify the ad-hoc signature that Apple Silicon needs.
  - Windows: NSIS x64 + arm64.
  - Linux: AppImage (refuses to run unsandboxed), `.deb`, `.rpm`.
- **Install guides** covering Gatekeeper *Open Anyway* and SmartScreen *Run anyway*.
- **Releases:** a notify-only update check, and the tag-driven release workflow. **Chord 0.1 "preview" on GitHub Releases.**

### Phase 1 exit criteria

- Every Phase 1 feature from the brief works on all targets: sidebar, pinned/Today, folders, auto-archive, chords, command bar, first run, collapsible sidebar. So do Chrome extensions, default-browser registration, and auto-PiP.
- Spike S2 is resolved: Google sign-in works in Chord.
- Performance budgets are met on reference hardware: cold launch < 1.5 s, command bar < 50 ms, 120 fps shell where the display supports it.
- You've used it as your main browser for at least a few days without going back to Arc.

**Explicitly not in Phase 1:**
- Split view, Peek, mini window, hover previews.
- Duet.
- In-app update installs, Flatpak, package repos.
- Ad blocking, Safe Browsing.
- Code signing.

---

## Phase 2 — Side by side · January 2027

- **Electron 46 upgrade** first (stable Jan 5, 2027). It's our first major upgrade and the rehearsal for the 8-week cadence.
- **Split view:** 2–4 panes, drag-to-split drop zones, saved as one unit in the sidebar, dividers, focus ring (DESIGN.md §7.9 and §8.4).
- **Hover previews** for pinned tabs and folders, with the capture cache.
- **Connect an agent** (from Crest): the Chord MCP server, reachable by the user's own Claude Code or Codex through a one-line `claude mcp add` setup, with a badge and a Stop button on every tab an agent touches.
- **Duet, browse mode** (ARCHITECTURE.md §11), as one client of that server:
  - **Setup:** detects your `claude` / `codex`; "Sign in" runs `claude auth login` or `codex login` for you.
  - **Adapters:** Claude Code (`--restricted --tools ""`) and Codex app-server.
  - **Tools:** the Chord MCP server with context and organize tiers, approval cards, and citations that highlight the quote on the page.
  - **Threads:** one per chord.
  - **Controls:** exclusions, plus per-chord and global off.
  - Spike S5, for Codex tool restriction, runs at the start of this work.

## Phase 3 — Links from everywhere · February 2027

- **Mini window** for links from other apps, promotable into a chord. On Wayland the compositor places it.
- **Link routes** (from Crest): rules that send a site's links to a chosen chord, and Chord remembering which chord a site belongs in.
- **Rebindable shortcuts** with conflict detection.
- **Peek** for links clicked inside pinned tabs.
- **Distribution:**
  - **Flathub:** a from-source manifest; app ID verified through chordbrowser.com.
  - **Cloudsmith** apt and dnf repos, GPG-signed.
  - **In-app updates** on Windows and AppImage, gated by Ed25519-signed manifests.
  - The **72-hour patch runbook** rehearsed end to end.
- **D5** ad blocking and **D7** Safe Browsing, if you choose them.
- **Google-free mode** (requested 2026-10-22).
  - *Why not ungoogled-chromium itself:* it's a set of patches, domain substitutions and build flags for Chromium's source. Chord runs on Electron, which builds its own Chromium, so using it would mean building Electron from source with those patches applied. That's hours of build per OS and architecture for every security release, and no maintained project does it today.
  - *What we can do instead:* first, an **audit spike** that runs a Chord session with a network log (`--log-net-log`) and lists every Google host Chord itself contacts, apart from pages you visit. Then a switch in Settings:
    - a non-Google default search;
    - no search suggestions;
    - spellcheck dictionaries from a non-Google host (`session.setSpellCheckerDictionaryDownloadURL`), or local only;
    - plus anything else the audit finds.
  - *Kept honest by a test:* CI fails if a fresh session in this mode contacts a Google domain on its own.

## Phase 4 — Deeper · March 2027 onward

- **Duet developer mode:**
  - Attach a project folder to a chord.
  - Console and network context from a localhost tab.
  - The provider's own file and shell tools, behind Chord's approval UI.
- **More Duet providers:** your own API keys, and local models through OpenAI-compatible endpoints.
- **Code signing and notarization.** This unlocks macOS auto-update and removes the Gatekeeper and SmartScreen steps. An optional Microsoft Store (MSIX) channel.
- **Electron 47** (around March 2027), compact density, and whatever Phase 1–3 use teaches us.

---

## Borrowed from Crest

[Crest](https://github.com/pauljoda/Crest) is MPL-2.0. Ideas are reimplemented freely under Chord's MIT license. Any file *ported* from Crest keeps the MPL-2.0 header and adds "Portions derived from Crest, © 2026 Paul Davis". MPL-2.0 applies per file, so it doesn't spread to the rest of Chord.

| From Crest | Where it lands |
|---|---|
| No app token in the user agent; Chrome-style reduced version | Done (S2) |
| Command bar scoring, top-hit and completion rules, learned picks | M1.4 |
| `@` filters, site keywords, Enter variants | M1.4 |
| Never sleep or archive playing/PiP/sharing tabs; at most 2 crash reloads | M1.5 |
| Native-messaging lookup for password managers | M1.5 |
| Per-animation switches with ↺ reset, and ↺ on every changed setting | Each animation as it ships (DESIGN.md §6.8) |
| Connect an agent: MCP helper, chrome-devtools-mcp tool names, badge and Stop | Phase 2 |
| Link routes, remembered chord per site | Phase 3 |
| Import guardrails with written exemptions, AGENTS.md, append-only release notes | Process, M1.1 |

Skipped on purpose: Crest Passwords (we use extensions), its 19-host blocklist, memory-pressure unloading (Electron has no pressure event), and its heraldic visual identity (trademarked).

## Schedule risks

| Risk | Effect | Mitigation |
|---|---|---|
| S2 shows Google blocks sign-in | Without Google sign-in this isn't a daily driver | It's the first spike. Fallbacks: a user-agent and client-hints strategy, and tracking Electron PR #53519. Result is reported by Oct 30. |
| Review turnaround | Each milestone waits on your merge | Handoffs are small. A one-day turnaround keeps Dec 14; slips push 0.1 day for day, and Dec 22 has 8 days of slack. |
| Extension license (D1) unanswered by Nov 30 | M1.5 extensions slip | Core work doesn't depend on it; only the integration does. |
| macOS issues found late (no local Mac) | Late polish on vibrancy, gestures, ProMotion | CI captures from day one, plus your by-hand checklist each milestone. |
| Electron 46 lands mid-Phase 2 | Upgrade churn | Scheduled as the first task of Phase 2, not mid-feature. |
