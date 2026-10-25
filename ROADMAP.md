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
| **2 · Side by side** | — | Jan 2027 | work in splits, open links from other apps in a mini window, Peek from pinned tabs, hover-preview pinned tabs and folders, and chat with Duet about your tabs |
| **3 · Links from everywhere** | — | Feb 2027 | send a site's links to the right chord, install from Flathub or apt/dnf, update in place, go Google-free |
| **4 · Deeper** | — | Mar 2027 + | install signed builds that update themselves on every OS |
| **After 0.1** | 0.1.x | Nov 2026 | sign in to sites that ask for a password in a box, and trust that a force-quit loses nothing |
| | 0.2 · Cleaner pages | Dec 2026 | browse without ads or trackers, and bring your bookmarks and history from Chrome, Edge, Brave, Firefox or Safari |
| | 0.3 · Effects | next, after the performance plan (moved up 2026-10-25); Effects built 2026-10-25 | restyle a site by hand or by asking Duet, with a Dry/Wet switch; then Duet fills forms |
| | 0.4 · Your data | right after Effects (moved up 2026-10-25) | export everything, and sync your setup through a folder you already sync, end-to-end encrypted |

## Where we are (updated 2026-10-23)

Phase 1 and most of Phase 2 are on `main`, well ahead of the dates above. Every item marked done has unit and E2E tests, and the six release targets build and pass their smoke tests.

| Milestone | Done | In progress | Left |
|---|---|---|---|
| M1.0 Foundations | all | | |
| M1.1 Browsing shell | tabs, find, downloads, permission prompts, error and crash pages, sign-in popups, session restore, keyboard routing (S8) | | |
| M1.2 Sidebar | Pinned/Today, folders, Favorites, drag and drop, resize, Clear Today, keyboard navigation, minimal bar with peek, the archive arc, a windowed Today past 150 rows | | |
| M1.3 Chords | chords, icons, themes and the theme library, color wheel and *Surprise me*, separate sign-ins, moving tabs across chords, trackpad swipe | | trackpad swipe checked by hand on a Mac |
| M1.4 Command bar + archive | ranking with learned picks, history, completion, suggestions, site keywords, `@` filters, archive, sleeping tabs, ⌘⇧T | | |
| M1.5 Extensions + essentials | Chrome extensions (sidebar shelf), auto picture-in-picture, default browser, several windows, private windows, PDFs, spelling, screen sharing, site permissions, zoom per site, **editable shortcuts** | | real password-manager sign-in checks (by hand) |
| M1.6 First run + preview | first run, unsigned packaging for six targets, install notes, update check, macOS hands-on (2026-10-22 report), accessibility pass (automated), performance budgets (launch, command bar, history) the 200-tab sidebar inside the 16 ms task budget | CI green on every OS | the 8 ms frame budget on 120 Hz+ displays (Duet, drag, chord switch, Clear Today run 10–17 ms), the rest of the design QA sweep, macOS re-run, the 0.1 release |
| Phase 2 | Duet, split view, mini window, Peek, hover previews | Codex's live-turn checks (S5, after its usage limit resets Nov 16) | Electron 46 (stable 2027-01-05) |
| Phase 3 | link routes, in-app updates (Ed25519-signed manifests; needs your signing key), Google-free mode, a Flatpak built from source, the apt/dnf upload workflow (off until Cloudsmith is set up), `.rpm` builds (x64 and arm64, smoke-tested in Fedora), the 72-hour runbook (rehearsed up to publishing), **D7 Safe Browsing** (v5 Local List Mode; its key is in the release workflow) | | yours: the Flathub app ID and submission, the Cloudsmith repository and key, Safe Browsing checked by hand with the real key |
| Phase 4 | signing and notarization in the release workflow, off until your certificates exist; a Microsoft Store draft | | your certificates ([docs/releasing/signing.md](docs/releasing/signing.md)), Mac in-app updates, Electron 47, compact density |

---

## Before we start

**Answered 2026-10-22:**
- **Q1:** Push to `main` after each significant change.
- **Q2:** App ID `com.chordbrowser.Chord`.
- **Q3:** You test on an Apple Silicon MacBook and a Linux VM; Windows is the primary platform (see *How we work*).

**Needed by a specific milestone:**

| # | Question | Needed by | My default |
|---|---|---|---|
| Q4 | Google search suggestions while typing. They make the command bar feel faster, but every keystroke goes to Google. | M1.1 | **Decided:** on, with the switch in Settings → General (built) |
| Q5 | Favorites: the row of app tiles at the top of the sidebar, shared across chords. Arc had them and your Dia screenshot shows them. | M1.2 | **Decided:** yes (built) |
| Q6 | Sidebar toggle shortcut: ⌘S / Ctrl+S (matches Arc, shadows "Save page") or ⌘⇧S / Ctrl+Shift+S | M1.2 | **Decided:** ⌘S; Save page on ⌘⇧S (built; Save page itself is still to come) |
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
  - Links from other apps open in a mini window (Phase 2, below); Settings → General can make them tabs instead.
- **`chord://settings`:** search engine, auto-archive, appearance, PiP, extensions, default browser, update channel.
- **Rebindable shortcuts** with conflict detection (moved up from Phase 3 at your request, 2026-10-23). **Done:** every action's keys can be changed in Settings → Keyboard shortcuts (DESIGN.md §14.1).

### M1.6 First run + preview release · → Mon Dec 14

- **First run:** the onboarding flow from DESIGN.md §8.1, under 60 s to your first chord. Empty states and a copy pass.
- **Accessibility pass:** ✅ automated (DESIGN.md §10 *As built*, ARCHITECTURE.md §15.5).
  - Every flow completed keyboard-only: first run, tabs (F6 into the sidebar, move, reorder, pin, fold, close), chords, the command bar, Settings (change and reset), Duet, split view. `keyboard.spec.ts`.
  - Screen-reader structure checked by aria snapshots; axe clean (serious and critical) on every surface, light and dark, four themes. `a11y.spec.ts`.
  - Reduced motion (both ways), reduced transparency (wired to `nativeTheme.prefersReducedTransparency`, live), Windows High Contrast (`forced-colors`, with captures).
  - ⏳ By hand: a screen-reader smoke test with Narrator (Windows), VoiceOver (macOS, docs/testing/macos.md) and Orca (Linux); real Windows High Contrast themes. Text scaling is built: Settings → Appearance → Interface size, 90–150% (DESIGN.md §10 *As built*).
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

- **Electron 46 upgrade** as soon as it's stable (Jan 5, 2027). It's our first major upgrade and the rehearsal for the 8-week cadence.
- **Split view:** 2–4 panes, drag-to-split drop zones, saved as one unit in the sidebar, dividers, focus ring (DESIGN.md §7.9 and §8.4).
- **Mini window** for links from other apps, promotable into a chord. On Wayland the compositor places it. *(Moved up from Phase 3 on 2026-10-22: Chord can already be your default browser.)* **Built 2026-10-23** (DESIGN.md §7.9).
- **Peek** for links clicked inside pinned tabs. *(Moved up from Phase 3 on 2026-10-22.)* **Built 2026-10-23**, with *Open link in Peek* in any tab's menu, private windows included (DESIGN.md §8.5).
- **Hover previews** for pinned tabs and folders, with the capture cache. *(Built 2026-10-23: ARCHITECTURE.md §9, with a switch in Settings → Privacy.)*
- **Duet: conversations on the fly, optionally reading the browser** (ARCHITECTURE.md §11). Scope set 2026-10-22: *"basic chat is enough"*.
  - **Setup:** detects your `claude` / `codex`; "Sign in" runs `claude auth login` or `codex login` for you.
  - **Adapters:** Claude Code (the unmodified CLI) and Codex app-server.
  - **Reading:** tabs, selection, history and archive, scoped by a setting (default **Ask first**), with citations that highlight the quote.
  - **Threads:** one per chord, kept by Chord and resumed across restarts.
  - **Controls:** exclusions per site, plus per-chord and global off.
  - No organize actions: Duet reads, it doesn't rearrange your tabs.
  - **Built** (ARCHITECTURE.md §11 as built; spikes S10 pass, S5 partly verified). **Built 2026-10-23:** reading PDFs (with page citations), a context meter, and Claude Code or Codex installed only inside WSL. Still to do: the panel's slide-in animation.

## Phase 3 — Links from everywhere · February 2027

- **Link routes** (from Crest): rules that send a site's links to a chosen chord, and Chord remembering which chord a site belongs in. **Built 2026-10-23**, with the mini window: routes apply to links from other apps and to the command bar, and Chord offers a route rather than making one (DESIGN.md §8.5).
- **Distribution** (status 2026-10-23, [docs/releasing/](docs/releasing/patch-runbook.md)):
  - **Flathub:** a from-source build, app ID verified through chordbrowser.com.
    - *Done:* `flatpak/` builds Chord from source with no network, on the Electron BaseApp 26.08 ([flathub.md](docs/releasing/flathub.md)).
    - *Yours, by hand:* Flathub's AI policy forbids AI-written manifests and AI-opened PRs, so you write the manifest that's submitted, and the submission must disclose Chord's AI-written code; reviewers may weigh that against it.
    - *To decide:* the app ID. `com.chordbrowser.Chord` needs a page on chordbrowser.com over HTTPS for verification; `io.github.anaremore.chord-browser` works today.
  - **Cloudsmith** apt and dnf repos, GPG-signed.
    - *Done:* `release.yml` builds a `.deb` and an `.rpm` for each architecture, `linux-repos.yml` uploads each published release's packages, and the README has the install steps marked "coming soon".
    - *Yours:* the Cloudsmith repository and the `CLOUDSMITH_API_KEY` secret ([linux-repos.md](docs/releasing/linux-repos.md#switching-it-on)).
  - **In-app updates** on Windows and AppImage, gated by Ed25519-signed manifests. *Built:* download in the background, then "Restart to update"; it needs the signing key made once ([patch-runbook.md](docs/releasing/patch-runbook.md#update-signing-key)).
  - The **72-hour patch runbook** rehearsed end to end. *Done:* written ([patch-runbook.md](docs/releasing/patch-runbook.md)) and rehearsed on 2026-10-23 up to the publish step. The first real release completes the rehearsal.
- **D7 Safe Browsing.** **Decided and built 2026-10-23** (ARCHITECTURE.md §14.5): Google's Safe Browsing API v5 in Local List Mode, for pages, frames, redirects and downloads in every window, private ones too.
  - *Built:* the lists and hashing in a worker thread (a local check takes about 0.2 ms); the warning in the content frame, with *Back to safety*, *Visit anyway* behind Details (remembered until you quit), Google's learn-more pages and its attribution; held downloads kept as `.crdownload` until you keep or delete them; Settings → Privacy's switch with its notice; first run's step for new profiles, a one-time offer for older ones; off in Google-free mode.
  - *The key:* the `CHORD_SAFE_BROWSING_KEY` secret in the `release` environment, put into release builds at build time. Builds without it show Safe Browsing as unavailable.
  - *Yours:* restrict the key to the Safe Browsing API, and check it by hand against Google's test pages ([patch-runbook.md](docs/releasing/patch-runbook.md#safe-browsing-key)).
- **Google-free mode** (requested 2026-10-22).
  - *Why not ungoogled-chromium itself:* it's a set of patches, domain substitutions and build flags for Chromium's source. Chord runs on Electron, which builds its own Chromium, so using it would mean building Electron from source with those patches applied. That's hours of build per OS and architecture for every security release, and no maintained project does it today.
  - *What we can do instead:* first, an **audit spike** that runs a Chord session with a network log (`--log-net-log`) and lists every Google host Chord itself contacts, apart from pages you visit. Then a switch in Settings:
    - a non-Google default search;
    - no search suggestions;
    - spellcheck dictionaries from a non-Google host (`session.setSpellCheckerDictionaryDownloadURL`), or local only;
    - plus anything else the audit finds.
  - *Kept honest by a test:* CI fails if a fresh session in this mode contacts a Google domain on its own.
  - *Built:* the audit is [S10](docs/decisions/S10-google-free.md). The switch is in Settings → Privacy: a non-Google engine (your choice), so its suggestions too; spelling only with dictionaries already downloaded; no background Web Store update checks; Safe Browsing off. The test is `test/e2e/google-free.spec.ts`. A new profile's first tab is still Google, because the mode can't be on yet.

## Phase 4 — Deeper · March 2027 onward

- **Code signing and notarization.** This unlocks macOS auto-update and removes the Gatekeeper and SmartScreen steps. An optional Microsoft Store (MSIX) channel.
  - **Built 2026-10-23, off until your certificates exist** (ARCHITECTURE.md §15.2). Once the secrets are in the `release` environment, a tag build signs and checks itself, with no code change:
    - macOS: Developer ID and the hardened runtime, notarized with an App Store Connect API key.
    - Windows: Azure Artifact Signing, or a `.pfx`.
    - Checks that stop a release that should be signed and isn't. Unsigned builds stay exactly as they are, and so do their in-app updates.
  - **Your part:** [docs/releasing/signing.md](docs/releasing/signing.md) has the steps:
    - Apple Developer Program, US$99 a year: about two days for an individual, longer for an organization.
    - Artifact Signing, US$9.99 a month: 1–20 business days of identity validation. Individuals must be in the US or Canada.
  - **Still to do:** Mac in-app updates (what they'd take is in that doc), and a Store submission. The Store package is drafted and builds, but is off.
- **Electron 47** (around March 2027), compact density, and whatever Phase 1–3 use teaches us.

## After 0.1 (planned 2026-10-24)

Priorities: **P0** blocks testers, **P1** is the next release, **P2** is planned, **P3** is later or maybe. Decisions D5 and D12–D15 are in ARCHITECTURE.md §16.

### 0.1.0 · the preview
- **P0** CI green on every OS, then tag `v0.1.0` and publish the draft as a prerelease.

### 0.1.x · Daily-driver gaps · November
- **P1 DRM notice.** **Built 2026-10-24** (ARCHITECTURE.md §16 D4, `main/drm.ts`): on the top DRM services (Netflix, Spotify, Disney+, Prime Video, Max, Hulu, Apple Music and TV, Peacock, Paramount+, Tidal), a notice that the site needs Widevine, which Chord doesn't include yet, with *Open in…* the other browsers import finds (opening "externally" would come back to Chord when it's the default). Recognized by address: catching a page's own DRM request would need a script in every page.
- **P1 Spike S12, Widevine.** **Done 2026-10-24** (docs/decisions/S12-widevine.md): ECS trailed four of the last five CVE releases by 23 to 34 days, so D4 is decided as stock Electron for now.
- **P2 Spike S14, a Widevine player** (D4's path, chosen 2026-10-24): an optional companion app on castLabs ECS, installed from the DRM notice, that opens only the notice's services, in a window of its own; any other link opens in Chord. **Done 2026-10-25** (docs/decisions/S14-widevine-player.md, prototypes in `spikes/widevine-player/`):
  - **Plays:** ECS plays Widevine test streams on Windows, macOS and Linux, X11 and Wayland, up to 4K in software (L3), with picture-in-picture and fullscreen. The navigation lock and the control channel work.
  - **Recommends:** a window of its own on every OS, once the maintainer has an EVS account for production VMP.
  - **Glueing it over Chord's content area:** works on Windows as an owned window (under a frame of trail), trails on macOS, and is impossible on Wayland.

  It covered:
  - playback of Widevine test streams per OS, and which services refuse without VMP;
  - EVS signing of the companion in CI;
  - locking its navigation to the services;
  - how it is installed and updated;
  - what signing in feels like without Chord's extensions;
  - Google-free mode (its CDM comes from Google).
  - **Next: build it** (P2, started 2026-10-25). The maintainer's castLabs EVS account exists (2026-10-25). Production signing in CI needs two repository secrets the maintainer adds, `EVS_ACCOUNT_NAME` and `EVS_PASSWD`; code signing on Windows and macOS stays on the maintainer's track.
  - **Built 2026-10-25: Chord Player** (ARCHITECTURE.md §9 and D4, DESIGN.md §7.14). What it does:
    - It's `apps/player`, on castLabs ECS 44.9.3+wvcus, in a window of its own with a bar in the chord's colors. On Windows the window joins Chord's taskbar button.
    - The DRM notice offers it first: *Install Chord Player (about N MB)*, its progress, then *Open in Chord Player*.
    - Chord installs it per user from `player-v*` releases whose manifests Chord's update key signs, checks the zip's SHA-512, and unpacks it in a worker. Updates install beside the running version, and the previous one stays until the new one starts.
    - It opens only the services and the hosts S14's census found; every other link opens in Chord, over a versioned local channel. The tab stays in Chord as *Playing in Chord Player*, and the player is on the Now playing card with *Back to the player*.
    - It's hidden in Google-free mode and private windows.

    How it's built and tested:
    - `.github/workflows/player.yml` packages it for Windows x64, macOS x64 and arm64, and Linux x64 (no Linux arm64: no CDM S14 could test). It VMP-signs through EVS when the secrets exist, and smoke-tests each build by playing a Widevine test stream.
    - `player-release.yml` drafts releases from `player-v*` tags. `ecs-bump.yml` opens a pull request for each newer stable `+wvcus` build, and never merges it.
    - E2E: `player.spec.ts` drives the real player from Chord, in the Linux container and CI. Hand checks per service and OS, once production VMP is on: docs/testing/widevine-player.md.

    **Left:**
    - the maintainer's code-signing certificates (Windows, macOS);
    - moving the EVS secrets into the `release` environment;
    - Chord's update key, without which no build offers the player;
    - the hand checks;
    - Chord's shortcuts forwarded from the player;
    - an icon of its own.
- **P1 Now playing, second round.** **Built 2026-10-24** (DESIGN.md §7.10, ARCHITECTURE.md §9): the card offers media you left playing or played from it, not a background tab's own autoplay or what you paused before leaving; several at once stack (the newest in full, up to two more as one-line rows, then "and N more"), in an order that doesn't jump when one plays again. Play and Pause read and press the site's own button where its element isn't enough (Twitch, whose player pauses its element again; SoundCloud, whose player isn't in the page; Bandcamp); YouTube and YouTube Music follow their element. Hand checks: docs/testing/media-sites.md. Then (asked the same day): each video row has picture-in-picture, so you choose which video is out; another swaps them.
- **P2 Pop out every video** (asked 2026-10-24). Chromium has one picture-in-picture window, so "pop them all out" needs Chord's own floating players.
  - **Design:** an always-on-top frameless window per video, holding the tab's own page. Its video fills the window through in-window fullscreen, so the site's own controls work. The windows stack in a corner, and each can be moved.
  - **Returning:** *Back to the tab*, or closing the window, puts the page back in its tab. The tab's row says where it's playing meanwhile.
  - **Card:** *Pop out all* appears with two or more videos.
  - **Spike S13 first:** in-window fullscreen in a small always-on-top window on each OS (Wayland can't keep a window on top); what YouTube's, Twitch's and Jellyfin's players do in it; and the CPU cost of several videos decoding at once.
  - **Alternative:** one floating window with the videos in a grid.
- **P1 DevTools in the window** (asked 2026-10-24): DevTools open popped out today; dock it into the window beside the page (right or bottom, resizable), with a button to pop it out and back in, as Chrome does.
  - **Built 2026-10-25** (ARCHITECTURE.md §9, DESIGN.md §7.16). F12 docks a tab's DevTools on the right of its page, inside its frame or split pane, under a 32 px header of Chord's: the other side, pop out, close.
  - Drag the edge between page and DevTools to resize, live. The side and size are one setting, kept across launches.
  - *Pop out* moves them, as they are, into a window of their own; its bar's *Dock in the window* puts them back. New ones open the way you last chose. ⌘⇧D / Ctrl+Shift+D does both inside DevTools, as in Chrome.
  - Each tab keeps its own. They close with the tab, and a tab with them open doesn't sleep. They glide with the page when the frame changes size, and F6 reaches them.
  - They're a view of Chord's own: Electron's docking undocks them on Windows and Linux under Chord's caption controls, and the frame snapshot couldn't picture them inside the page's view. They load in a session of their own (a private window's in memory), never a profile's.
  - Peek's and mini windows' pages keep popped-out DevTools.
  - **Left:** remembering a DevTools window's size and place; a by-hand check on Windows and macOS (CI runs the journey on every OS).
- **P0 HTTP Basic Auth.** **Built 2026-10-24** (ARCHITECTURE.md §9): a sign-in box in the popover over the tab that asked, for sites and proxies (Basic, Digest, NTLM), with the site's realm, a note after a wrong answer and a warning on plain HTTP. Chromium remembers a sign-in that worked until you quit; Chord keeps nothing (D12). Peek too (its box shows over Peek); not yet mini windows, whose pages get the site's 401 page.
- **P0 Sign-in checks, by hand:** Google in a second chord on Windows, macOS and Linux; Microsoft, GitHub and Apple; 1Password, Bitwarden and KeePassXC-Browser (risk R2). No user-agent spoofing unless one fails (D15).
- **P1 Crash resilience.** **Built 2026-10-24** (ARCHITECTURE.md §6.2): open tabs now keep their back/forward history, scroll position and form fields across a restart or a crash (before, they came back as just their address). E2E tests kill Chord mid-session and check a tab comes back where it was, and that every window, chord and split comes back.
- **P0 Performance** (critical, the maintainer's call 2026-10-25). In this order, each measured before and after, and kept only if it wins:
  1. **Smaller updates:** differential downloads. **Built 2026-10-25** (ARCHITECTURE.md §14.4): releases publish the Windows installers' blockmaps (an AppImage carries its own), and updates fetch only the blocks that changed, checked against the signed manifest's SHA-512. With the app archive stored as it is in the installer, a change to Chord's code is a 0.38 MB update instead of 3.24 MB (or the whole 126+ MB). macOS updates wait on signing.
  2. **Preconnect from the command bar:** while you type, Chord connects to the top result's host (`session.preconnect`), as Chrome's address bar does, so the page starts sooner when you press Enter. **Built 2026-10-25** (ARCHITECTURE.md §9, Command bar).
  3. **Chord's own processes:** measure what each window's UI views cost (shell, command bar, popover, hover preview: a renderer each, `app.getAppMetrics()`), then make the rarely used ones only when first needed, or share them, if that wins. **Measured 2026-10-25** (Linux, one window, idle; private memory from `/proc/<pid>/smaps_rollup`): shell 30 MB, command bar 21, popover 21, hover preview 15, so 87 MB of Chord's own UI per window (155 MB counting each one's share of what's shared); a second window adds 90 MB in all. Main is 114 MB, the GPU process 56, one simple page 12. Decided: the command bar and popover stay warm (the popover holds find, so making it later would slow the first ⌘F); making the preview on the first hover would save 15 MB a window, a small win for its risk, so not now. The bigger target is main's 114 MB, in step 4.
  4. **The rest of the pass:**
     - cold launch, against the 1.5 s budget (worst CI run 1.03 s). *2026-10-25:* **Node's compile cache for main: not doing.** It keeps compiled code in a folder the user can write, so anything running as you could plant code main would run, past the app-archive integrity check the fuses turn on; a few tens of milliseconds aren't worth that. The database open that took 4.5 s on Windows CI: the launch timeline now says where (1.56 s of it creating and migrating a new database on a CI runner; 15 ms on a desk machine), so it's the runner's disk. Non-critical launch work (ad-blocking lists, Safe Browsing, sweeps) after the first page;
     - main's memory: 114 MB private, of which Chord's own JavaScript heap is 12 MB in use (measured 2026-10-25); the rest is Chromium's browser process, which every Electron app has;
     - Duet, the theme editor and Settings' code loaded when first opened;
     - the interactions over the 8 ms frame budget on 120 Hz displays. *2026-10-24:* CPU profiles (`CHORD_PERF_PROFILE=1`) found the costs. The frame snapshot's pictures now skip the preload and become bitmaps in a worker (collapse 17.1 → 8.1 ms worst frame, dock 14.5 → 6.3 ms, with 200 tabs), and dragging no longer hit-tests on every move (dnd-kit's AutoScroller replaced by `EdgeScroller`). *2026-10-25:* opening Duet no longer lays its panel out twice in its first frame. Tab and chord switches no longer force a layout. The active highlight slides on its own (`SlidingPill`, reading geometry only after the browser's own layout) in place of Motion's shared-layout measuring (about 3 ms a switch with 200 tabs). The address bar's anchor reports only when the frame around it moves (5.6 ms). The roving Tab stop is placed after paint (2.8 ms). With 200 tabs, the 95th-percentile frame is now 3.3 ms for a tab switch and 5 ms for a chord switch. The profiles' `layoutReads` show which callers still force a layout. Left: garbage on Clear Today, and the odd slow frame that the profiles put down to garbage collection;
     - memory from `app.getAppMetrics()`, and tabs sleep sooner when free memory runs low (Electron has no pressure event). **Low-memory sleeping built 2026-10-24** (ARCHITECTURE.md §9);
     - CI fails when launch time or memory grows past a set margin.
  5. **Battery:** on battery, hidden tabs sleep sooner and Chord's own timers (Now playing's reads, update checks) slow down.
  6. **Back and Forward** reload the page in Chord (checked 2026-10-25: `pageshow` not persisted), where Chrome restores it from its back/forward cache. Chromium needs its embedder to opt in (`WebContentsDelegate::IsBackForwardCacheSupported`), and Electron 45 doesn't. Ask Electron upstream (an issue, with a patch if wanted); nothing in Chord can turn it on.
  - Not doing: removing the app menu (shortcuts and the macOS Edit menu need it), or native modules (each Electron upgrade would need them rebuilt, against the 72-hour runbook).

### 0.2 · Cleaner pages · December
- **P1 Passkeys, properly** (asked 2026-10-24). **Built:** passkey autofill off, since it opened the system dialog by itself, and Chord's card for choosing between a key's passkeys; without it Electron cancelled every security-key sign-in. Hand checks: docs/testing/passkeys.md. **Next:** Touch ID on macOS once builds are signed (`app.configureWebAuthn`; the keychain entitlement is the maintainer's step). PIN entry, phones and autofill on macOS and Linux wait on Electron.
- **P1 Screenshots** (asked 2026-10-24, from the maintainer's Screenboard extension). **Built 2026-10-24** (DESIGN.md §7.12): ⌘⇧2 over the page, then an element (hover, ↑/↓), an area, what's on screen or the whole page; on the clipboard at once, with Save in a toast and a recent list in the downloads panel. Next: **Ask Duet** from the toast and the list (a screenshot attachment and a tool to view it).
- **P1 Ad and tracker blocking** (D5, reversed).
  - **First, spike S11:** measure main's time per page load on a set of ad-heavy pages two ways. (a) Ghostery's engine answering `webRequest` in main, where every request crosses main's JavaScript thread. (b) `declarativeNetRequest` rules compiled from the same lists, which Chromium applies in its network process. (b) can't reach private windows, since Electron won't load extensions into in-memory sessions; (a) can. Pick by the numbers, or combine them (rules for normal windows, the engine for private ones). See ARCHITECTURE.md's performance rules 2 and 3.
  - Then: one request dispatcher per session, EasyList and EasyPrivacy on by default, a switch per site, private windows included, cosmetic filtering, and lists bundled at build time and refreshed from the lists' own hosts.
  - **Built 2026-10-24** after S11 ([docs/decisions/S11-ad-blocking.md](docs/decisions/S11-ad-blocking.md); ARCHITECTURE.md §9). Both ways block the same requests; in chords the lists are `declarativeNetRequest` rules, which Chromium matches in its own code (in the browser process, with no JavaScript), so extensions like uBO Lite keep working. Private windows go through the dispatcher to Ghostery's engine in a worker, which also hides ad slots on every page. Settings → Privacy has the switch and the sites it's off for; a page's right-click menu turns it off for its site, with Undo. Not yet: element hiding that needs a script in the page, and stand-in files for `$redirect` filters.
- **P1 Import** from Chrome, Edge, Brave, Firefox and Safari: bookmarks, history, and open tabs where the files can be read. First run and Settings map each bookmark folder to a chord. No passwords or cookies: Chrome locks them to Chrome on Windows, and they're your password manager's job. Safari needs Full Disk Access, and Chord says so. Still no Arc import.
  - **Built 2026-10-24** (ARCHITECTURE.md §9, DESIGN.md §8.7): first run's *Bring your bookmarks?* step and Settings → Import. Each top-level folder becomes a new chord or a pinned folder in one you have; the bookmarks bar's links can be Favorites (up to 24); Firefox's open tabs land in a chord's Today; history goes in with its visits, so frecency ranks it. Counts before, progress during, Undo after, history included. Read in a utility process from copies of each browser's files, which are never changed; a test imports 3,000 bookmarks and 6,000 pages.
  - Not yet: Chrome, Edge and Brave's open tabs (their session files are an undocumented binary format that changes between versions) and Safari's; another Flatpak's browser data, which Chord's Flatpak can't see. After an import of tens of thousands of bookmarks every store change is slower than a frame, because the store copies its whole node map on each change (ARCHITECTURE.md §9, known limit). Measured 2026-10-24: copying a 30,000-key map costs 12.8 ms by itself, so the fix is structural (P3: nodes per chord, or very big imports kept out of the sidebar).
- **P2 Link routes by path**, such as `github.com/acme/*` → Work. **Built 2026-10-24** (ARCHITECTURE.md §9).
- **P2 Media controls** in the sidebar (the audible and muted states in DESIGN.md §7, plus play and pause). **Built 2026-10-24** (ARCHITECTURE.md §9, DESIGN.md §7.2 and §7.10): a speaker on the row of a tab making sound (on its Favorites tile too, and in the minimal bar for the tab on screen) mutes and unmutes it, kept through sleep and restarts; *Mute tab* in its menu and the command bar, and Ctrl+M (⌃M on macOS). A Now playing card at the bottom of the sidebar shows media playing in any of the window's chords out of sight, with the track from the page's Media Session, Play and Pause, Mute, picture-in-picture and Go to tab, read from an isolated world. The OS's own media controls already work through Chromium (checked on Linux). Not yet: pausing a player in an embedded frame (the card can mute it), and a by-hand check of Windows' media flyout and macOS's Now Playing.
- **P2 Reader mode.** **Built 2026-10-24** (ARCHITECTURE.md §9, DESIGN.md §7.11): a book beside the address on pages that read as articles (Mozilla's Readability, asked in Chord's isolated world), the tab's menu, the command bar, and F9 (⌘⌥R on macOS). The article shows in a view of Chord's own in place of the page, which comes back as it was; it's cleaned to an allow-list in a worker before any renderer sees it, runs none of the page's script, loads its images through the tab's own session, and its links go where the tab's would. Text size, font (Onest or the computer's serif), line width and colors (the chord's, Light, Dark, Sepia) are remembered. Not yet: reading aloud, and reader view for Peek's and mini windows' pages.
- **P2 Sharing** (planned 2026-10-24; about a week, one agent, after media controls since both touch the sidebar):
  - **Share a single tab.** Chord's picker lists Chord's tabs beside screens and windows; Electron 45 shares a tab's frame (`setDisplayMediaRequestHandler` with a `WebFrameMain`) and its sound on every OS, where system sound is Windows-only. Only that page goes out: no sidebar, desktop, notifications or other apps. On macOS 15+, where the system's picker is used today, Chord's picker comes first (this tab, or another), with the system's for screens and windows one click away.
  - **Presenting mode.** While anything is shared (a window or screen most of all; a shared tab already leaves Chord's own layers out), Chord hides what it knows is private: history, archive and Duet suggestions in the command bar (actions and typed addresses still work), hover previews, websites' notifications and Chord's own toasts. Optionally the sidebar collapses. It starts by itself when a page in Chord shares, and has a switch and a shortcut for when another app (Zoom, Teams) shares Chord's window, which Chord can't detect.
  - **What's shared, shown:** a tinted edge on the shared tab's frame (or the window's), beside the sidebar's existing Stop. Swapping the shared tab mid-call is a stretch: the page may have to ask again.
  - *Requirements found reviewing the multi-process model (2026-10-24):*
    - A shared tab never sleeps or goes to the archive, and while it isn't on screen it stays attached to its window off-screen (as the frame snapshot parks pages), with background throttling off: a detached view has no compositor and its stream would freeze.
    - Its sound: `enableLocalEcho: true`, or you stop hearing the tab you're sharing.
    - A private window's tabs are offered only to a page in that window; moving the shared tab across sign-ins makes a new page and ends the share, which the UI says.
    - The picker lists screens and windows by name first and fills in thumbnails after: `desktopCapturer` pictures every window, which can take seconds on a busy Windows desktop.
    - Presenting mode lives in main's state and reaches the views in the usual patches, with no channel of its own. Main enforces it where the data comes from: history search answers nothing and no preview cards are sent, so a keystroke in the frame before a view hears of it can't show a suggestion. Websites' notifications can only be stopped by refusing their permission check while presenting, so pages see "denied" for that while.
  - *Not doing:* automatic blurring of secrets (unreliable, and a miss is worse than none), silencing the OS's notifications (no public API on macOS, nothing usable on Windows), a presenter mirror, resolution or encoding controls (the calling app owns those), and cursor or markup overlays (they'd have to be injected into the shared page; maybe after Effects).
  - **Built 2026-10-24** (ARCHITECTURE.md §9, *Screen sharing* and *Presenting mode*; DESIGN.md §7.13). Chord's picker lists its tabs first (a private window's only to that window's pages), then screens and windows by name, pictured a moment later. A tab goes out with its sound, still heard here; while shared it never sleeps or archives, isn't throttled, and stays attached to its window out of sight. On macOS 15+ and Wayland, *Screen or window…* opens the system's picker from Chord's (on macOS with the same stand-in source Electron uses for its own `useSystemPicker`). Presenting mode starts with a share and ends with the last, or with ⌘⇧P / Ctrl+Shift+P and the command bar; a card in the sidebar (a chip in the minimal bar) says so and turns it off; main refuses history, archive and Duet suggestions, preview cards, websites' notifications and Chord's toasts while it's on; Settings → General can collapse the sidebar too. A shared tab's frame, and a window a page shares, get a tinted edge, and the shared tab's row has its own Stop. Moving a shared tab to other sign-ins ends the share, with a toast. E2E tests share a tab and check its picture, sound, local echo, painting off screen, no sleep, presenting mode, the shortcut, private windows and the move (`sharing.spec.ts`, on every OS).
  - *Not yet:* swapping the shared tab mid-call; a window edge when the system's picker chose (Chord can't know what it chose); by hand, the hand-over to macOS's picker (CI's macOS can't drive it) and to the portal on a real Wayland desktop, and a tab shared to a call on Windows and macOS.

### 0.3 · Effects · next (moved up 2026-10-25)
The maintainer moved Effects and Your data up, right after the P0 performance plan and ahead of everything else planned (2026-10-25). Effects is built beside the performance work, by an agent in its own worktree.

- **P1 Effects**, in place of Boosts (D13): per-site styles with a Dry/Wet switch that removes them at once.
  - By hand: your own CSS, hiding an element, a few presets.
  - *Ask Duet*: your Claude Code or Codex app writes a patch from a stripped outline of the page; same reading rules as Duet.
  - Every patch is parsed and stripped of anything that fetches before it's applied, and re-applied on each navigation.
  - **Built 2026-10-25** (ARCHITECTURE.md §9, DESIGN.md §7.15). The page's right-click menu, the command bar, the View or ⋯ menu and a button beside the address (while a site has Effects) open the Effects card in the popover, over the page, which shows each change as you make it: Dry · Wet, three presets (*Reading width*, *Dark*, *No sticky bars*), *Hide an element…* (the screenshot picker, clicking to hide), your CSS, Ask Duet, and Undo for what's removed. ⌘⇧E / Ctrl+Shift+E makes the site dry or wet; Settings → Effects lists the sites, and has Dry/Wet for every site. Kept by host (`www.` folded) in chord-data (migration 13), shared by every chord; a private window keeps its changes in memory. Each site's stylesheet is checked in a worker by a sanitizer built on the CSS Syntax spec's own parser, which writes out only known rules and functions and leaves out anything that fetches, then inserted once per navigation, as a stylesheet only. Ask Duet sends your words and, through one read-only tool, an outline of the page (never form values), and deletes the provider's copy after. Tests: `effects.spec.ts` (the whole journey, and what applying costs on a heavy page) and the sanitizer's table of hostile stylesheets.
  - *Not yet:* moving a Duet patch into your CSS to edit it; one set of Effects for a site and all its subdomains; a back/forward cache will need the stylesheet put back on a restored page.

- **P1 Duet fills forms** (D16, decided 2026-10-24): "fill only, you submit". Only when you ask, on the tab on screen; a review card of each field's value, then Chord fills them, with Undo; never submits, never passwords, cards, one-time codes or hidden fields. After Effects, sharing its safety review of writing into pages.

### 0.4 · Your data · right after Effects (moved up 2026-10-25)
- **P1 Export everything:** chords, tabs, folders, Favorites, themes, settings, routes, Effects, history and Duet chats, in the format sync uses.
- **P1 Sync** through a folder you already sync, end-to-end encrypted with your passphrase (D14). Setup only in its first version: no history, no open tabs. One log per device, merged on every device.

### Electron 46 · January 5, 2027
- **P0** The first major upgrade, on the 72-hour clock, whatever else is under way.

### Later (P3)
- **Updates on the fly** (asked 2026-10-24), in three layers, safest first. Every layer is signed with the update key, pinned to the contract of the main process that runs it, and rolls back to the last good version on failure. Main never runs code it downloaded.
  1. **Data without a release:** a signed pack of site rules, fetched like the ad lists and applied at once. It holds media-sites.ts's buttons, the DRM services, and selector fixes. When Twitch changes its markup, a fix doesn't wait for a release.
  2. **The UI without a restart:** the `chord://` pages (shell, command bar, popover, Settings, reader) as one signed bundle, versioned to main's IPC contract. A new bundle is swapped in by reloading those views, as after a crash. State lives in main, so nothing is lost.
  3. **Engine and main:** Chromium and Node can't be swapped while running, so these still need a restart, made nearly invisible. The update downloads in the background and Chord restarts at a quiet moment: nothing playing, sharing or typed but unsent. Tabs come back with their history, scroll and form fields (0.1.x's crash resilience did this groundwork), and Chord says what changed afterwards.
- **Translation.** Needs its own decision: an on-device engine, or Google's, which Google-free mode rules out.
- **Search the text of pages you've read**, kept on your computer.
- **Counts on tabs** (asked 2026-10-25). **Built 2026-10-25** (ARCHITECTURE.md §9, DESIGN.md §7.2): the Badging API's count on the tab, its tile, a closed folder and the chord switcher, the total on Chord's icon; a site's hidden from the tab's menu. A service worker's count shows on its site's tabs too (built 2026-10-25). Next: a hand check of the Dock and taskbar.
- **Duet makes images** (asked 2026-10-25). **Built 2026-10-25** with Codex's own image tool (ARCHITECTURE.md §11.5); Claude can't make images and offers Codex. A real image needs a hand check on the maintainer's plan.
- **Duet tidying your tabs.** It conflicts with D8 ("Duet reads, it doesn't rearrange"), so it waits for you to ask again.

## Not planned (decided 2026-10-22, updated 2026-10-24)

- **Arc import.**
- **A built-in password store** (D12): no `.kdbx` reader and no keychain store. KeePassXC-Browser covers `.kdbx` files.
- **Duet developer mode, your own API keys, local models.** Duet stays a chat that can read the browser; Effects use the same apps.
- **Connect an agent** (the Chord MCP server for your own Claude Code or Codex) is parked, not deleted. It goes beyond chat, and can come back if you want it.
- *Moved to After 0.1 on 2026-10-24:* built-in ad blocking (D5 reversed) and importing from other browsers.

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
| Connect an agent: MCP helper, chrome-devtools-mcp tool names, badge and Stop | Parked |
| Link routes, remembered chord per site | Done (2026-10-23, with the mini window) |
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
