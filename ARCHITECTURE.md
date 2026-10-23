# Chord — Architecture

Status: **draft for review** · Last updated 2026-10-22 · Companion docs: [DESIGN.md](DESIGN.md), ROADMAP.md (next step)

Chord is an open-source (MIT) desktop browser for people leaving Arc. It keeps the sidebar-first workflow and the delight, with no Chord account, no telemetry, no cloud, and no lock-in. Windows, macOS, and Linux (X11 and Wayland) are equal targets.

Every library, API, and version below was checked on 2026-10-22. Anything not confirmed from a primary source is marked **⚠ unverified** and has a spike or test that settles it. [§16](#16-decisions-needed-from-you) lists the decisions that need your call.

---

## Contents

1. [Scope](#1-scope)
2. [Stack](#2-stack)
3. [Repository layout](#3-repository-layout)
4. [Process model](#4-process-model)
5. [Window composition](#5-window-composition)
6. [State model and data flow](#6-state-model-and-data-flow)
7. [Data schema](#7-data-schema)
8. [IPC contract](#8-ipc-contract)
9. [Browser engine services](#9-browser-engine-services)
10. [Command bar and search](#10-command-bar-and-search)
11. [Duet — the assistant panel](#11-duet--the-assistant-panel)
12. [Extensions](#12-extensions)
13. [Cross-platform abstractions](#13-cross-platform-abstractions)
14. [Security, updates, and the 72-hour patch process](#14-security-updates-and-the-72-hour-patch-process)
15. [Packaging, distribution, CI, testing](#15-packaging-distribution-ci-testing)
16. [Decisions needed from you](#16-decisions-needed-from-you)
17. [Risks](#17-risks)

---

## 1. Scope

**In scope**, in the priority order from the brief: vertical sidebar (pinned and Today tabs), chords with optional per-chord profiles, nestable folders, auto-archive, command bar, split view, mini window plus default-browser registration, Peek, and hidden-chrome mode. Hidden-chrome is now a **fully collapsible sidebar**: every sidebar feature folds away, leaving one Dia-style bar with basic controls and a combined `domain / title` field (DESIGN.md §3.3). Two additions:

- **Duet**, an opt-in right-side assistant panel. It uses your own Claude Code or Codex install ([§11](#11-duet--the-assistant-panel)).
- **Extensions**, needed for password managers ([§12](#12-extensions)).

**Not in v1:** browser-data import (Arc or otherwise; the schema doesn't preclude it later), sync, Boosts, Easels, mobile, background AI of any kind, and a Chord account or server.

**Performance budgets.** These are acceptance criteria, measured as described in [§15.5](#155-testing):

| Budget | Target | How it's measured |
|---|---|---|
| Cold launch to usable window | < 1.5 s on a mid-range machine | `process.hrtime` at main entry → first shell paint with interactive sidebar (`performance.mark` + IPC timestamp) |
| Command bar open | < 50 ms keydown → first painted frame | `before-input-event` timestamp → overlay `requestAnimationFrame` after `open` |
| Command bar keystroke | Results paint in the same frame as the keystroke for in-memory sources; ≤ 16 ms for history and archive | `input` event → next rAF; data-process query time logged |
| New tab ready to type | 0 extra frames: ⌘T opens the command bar, which is always mounted | same as command bar |
| Shell UI frame rate | 120 fps where the display supports it, never < 60 fps | Long Animation Frames API + Chromium trace during scripted interactions |

---

## 2. Stack

| Concern | Choice | Version today | Status / notes |
|---|---|---|---|
| Runtime | **Electron 45** (Chromium 156, Node 24.22, V8 15.6) | 45.0.0, released 2026-10-20 | ✅ Supported lines: 45, 44, 43. Electron 46 stable is expected 2027-01-05. Chrome moved to 2-week releases, so each Electron major now jumps 4 Chromium milestones. |
| Language | TypeScript, strict | **6.0.x** | ✅ TypeScript 7.0.2 (the Go-native compiler) is out, but typescript-eslint 8.72 supports only TS `<6.1`, and TS 7's JS API is still `unstable/*`. We revisit once typescript-eslint supports 7. |
| UI | React 19 + React Compiler 1.0 | Compiler 1.0 stable since 2025-10-07 | ✅ Wired through plugin-react 6's documented `reactCompilerPreset` + `@rolldown/plugin-babel`. Its other route, `compiler: true` on `oxc-transform-react`, is marked experimental in the plugin README, so we don't use it. |
| Build | Vite 8 via **electron-vite 6.0** | 6.0.0, 2026-10-14 | ✅ Works with Electron 45, verified in M1.0, with two adjustments. First, Electron 45 downloads its binary lazily and has no install script, but electron-vite looks for the `path.txt` that download writes; so `apps/desktop` runs `install-electron` on postinstall. Second, a wrapper script clears `ELECTRON_RUN_AS_NODE`, which some Electron-based hosts leak and which makes Electron start as plain Node. Sandboxed preloads are built as one self-contained CJS file each (`isolatedEntries`, no externalized deps). electron-vite has one maintainer; fallback is plain Vite configs. Forge 8's Vite plugin brings Forge's packager, which we don't want. |
| Packaging | **electron-builder 26.18.0** (pinned) | 26.18.0 is on the `v26` dist-tag | ✅ npm's `latest` tag still points at 26.15.3, so pin exact versions. v27 is in alpha. Config: `apps/desktop/electron-builder.config.ts` ([§15](#15-packaging-distribution-ci-testing)). |
| Updates | **electron-updater 6.8.11** + Chord's Ed25519 manifest check | 6.8.11 (`v26` tag) | ✅ Signed manifests are built into v27 alpha only. Until then we verify through a custom provider ([§14.4](#144-auto-updates)). |
| Database | **`node:sqlite`** in a utility process, with FTS5 | Node 24 marks it "Release candidate" (1.2) | ✅ Works in Electron main without flags since 35. FTS5 is compiled in. ⚠ **utilityProcess use is inferred, not documented**; spike S1 settles it. Fallback: better-sqlite3 v13 (N-API, prebuilds bundled). A thin `Db` interface keeps the swap cheap. |
| Motion | **motion** (motion.dev, MIT) | 14.6.0 | ✅ Majors ship fast (13.0 on 2026-08-05, 14.0 on 2026-10-02), so pin. Only the MIT core is used; no Motion+ components. |
| Drag and drop | **@dnd-kit/react** | 0.5.1 (pre-1.0) | ✅ The only option with live "make room" shifting for nested trees. The legacy `@dnd-kit/core` is frozen. Pinned and wrapped behind our `SortableTree` so churn stays contained. |
| Validation | zod | 4.6.7 | ✅ |
| Ordering | fractional-indexing (CC0) | 4.0.0 (ESM-only) | ✅ |
| Fuzzy match | @leeoniya/ufuzzy (MIT) | 1.0.19 | ✅ About 0.15 ms per search over 5k items (extrapolated from the author's benchmark; we'll measure). |
| Icons | lucide-react (ISC) | 1.61.0 | ✅ Phosphor was considered and rejected: no release in 17 months. |
| UI typeface | **Onest** (SIL OFL), variable 100–900, `tnum` | — | ✅ See DESIGN.md §4.2. |
| Extensions | electron-chrome-extensions, the iamEvanYT fork, **vendored** as `packages/chrome-extensions` | 4.9.5 (fork commit `25cf4d7`) | ✅ Used under GPL-3.0 (decision D1); Chord's changes are listed in its CHORD-CHANGES.md. See [§12](#12-extensions). |
| Tests | Vitest 5, Playwright `_electron` 1.64 | — | Playwright's Electron support is still experimental. See [§15.5](#155-testing). |
| Lint | ESLint 10 + typescript-eslint 8.72, stylelint 17 | — | — |
| Package manager | pnpm 10 | 10.33 locally | Electron packaging needs the hoisted layout (`nodeLinker: hoisted` in `pnpm-workspace.yaml`). Electron 45 no longer has an install script (verified in its package.json), so pnpm 10's build-script allow-list doesn't apply to it. |

---

## 3. Repository layout

The monorepo exists to enforce boundaries: `@chord/core` cannot import Electron, and renderers cannot import main.

```
chord-browser/
├─ apps/desktop/
│  ├─ src/main/                 Electron main process
│  │  ├─ app/                   lifecycle, single-instance, open-url / second-instance
│  │  ├─ windows/               WindowManager, view composition, materials
│  │  ├─ tabs/                  TabManager: WebContentsView lifecycle, navigation, sleeping
│  │  ├─ sessions/              profiles→partitions, permissions, downloads, certificates
│  │  ├─ store/                 authoritative Store (wraps @chord/core)
│  │  ├─ ipc/                   router + sender validation (one role per preload)
│  │  ├─ shortcuts/             single registry → app menu (macOS) + before-input-event
│  │  ├─ platform/              darwin.ts · win32.ts · linux.ts (see §13)
│  │  ├─ updates/               electron-updater + Ed25519 manifest verification
│  │  └─ duet/                  supervisor for the agent utility process
│  ├─ src/preload/              shell.ts · overlay.ts · popover.ts · internal.ts
│  ├─ src/renderer/
│  │  ├─ shell/                 sidebar, content frame chrome, Duet panel, onboarding
│  │  ├─ overlay/               command bar, Peek chrome, split drop zones
│  │  ├─ popover/               hover previews, permission prompts
│  │  └─ pages/                 chord://settings, chord://archive
│  ├─ src/data/                 "chord-data" utility process: SQLite, search, favicons
│  ├─ src/agent/                "chord-agent" utility process: Duet providers + MCP server
│  ├─ test/                     unit · e2e (dev build) · packaged (smoke test of a packaged build)
│  ├─ build/                    packaging resources: app icon; later NSIS include, entitlements
│  └─ electron-builder.config.ts
├─ packages/
│  ├─ core/                     pure domain model: entities, commands, reducer, policies
│  ├─ ipc/                      channel contract, zod schemas, typed client/server helpers
│  ├─ db/                       schema, migrations, prepared queries
│  ├─ tokens/                   design tokens → CSS vars + TS; chord theme generator
│  └─ ui/                       shared React primitives (Button, Keycap, Favicon, Toast…)
├─ flatpak/                     Flathub manifest (built from source)
├─ scripts/                     asset generators (grain, icon); later release, manifest signing, Electron release watcher
├─ docs/                        SECURITY-PATCHING.md, decision records, design QA captures
└─ .github/workflows/           ci.yml · release.yml · electron-watch.yml
```

---

## 4. Process model

```mermaid
flowchart LR
  subgraph Main["Main process (Node, privileged)"]
    Store[(Store<br/>@chord/core)]
    WM[WindowManager]
    TM[TabManager]
    SM[Sessions / Permissions / Downloads]
    SR[ShortcutRouter]
    UP[Updater]
  end
  subgraph Data["chord-data utilityProcess"]
    DB[(SQLite + FTS5)]
  end
  subgraph Agent["chord-agent utilityProcess (only if Duet enabled)"]
    MCP[Chord MCP server<br/>127.0.0.1, token]
    PA[Provider adapters]
  end
  PA -- stdio --> CC[[user's own `claude` CLI]]
  PA -- stdio JSON-RPC --> CX[[user's own `codex app-server`]]
  CC -- HTTP --> MCP
  CX -- HTTP --> MCP
  Shell[Shell renderer<br/>sidebar · Duet panel] <-- invoke + patches --> Main
  Overlay[Overlay renderer<br/>command bar · Peek chrome] <-- invoke --> Main
  Overlay <-- MessagePort --> Data
  Shell <-- MessagePort --> Agent
  Main <-- MessagePort --> Data
  Main <-- MessagePort --> Agent
  Web[Web content renderers<br/>sandboxed, no preload] -. CDP/events only .- TM
```

| Process | Responsibilities | Why it's separate |
|---|---|---|
| **Main** | Lifecycle, windows, WebContentsView creation and placement, sessions and profiles, navigation policy, permissions, downloads, shortcuts, menus, default browser, updates. Holds the **authoritative in-memory Store**. | Owns every native object. It is never allowed to block: no SQLite, no search, no LLM I/O. |
| **chord-data** (utilityProcess) | SQLite connection (WAL), migrations, write-behind persistence, history, archive, FTS5 search, favicon cache, backups. | Synchronous SQLite stays off main. A crash here doesn't take down windows: main buffers writes and respawns it. |
| **chord-agent** (utilityProcess, lazy) | Duet: spawns the user's provider CLIs, hosts the Chord MCP server, streams turns. | Isolates third-party CLIs and network I/O. It is **never spawned** unless Duet is enabled, and is killed after 10 minutes idle. |
| **Shell renderer** (1 per window) | React UI: sidebar, content-frame shadows and placeholders, Win/Linux top strip, Duet panel, toasts, onboarding. | Our trusted UI, still sandboxed. |
| **Overlay renderer** (1 per window, pre-warmed) | Command bar, Peek frame chrome, split-view drop zones. | Must paint above web content ([§5](#5-window-composition)). Kept mounted and hidden so it opens in < 50 ms. |
| **Popover renderer** (1 per window, pre-warmed) | Hover previews, permission prompts. Its bounds are sized to the card. | Electron views can't pass clicks through (see [§5](#5-window-composition)), so popovers must not cover the sidebar. |
| **Web content** | One WebContentsView per live tab; Chromium site isolation decides the processes. | `sandbox`, `contextIsolation`, no `nodeIntegration`, **no preload**, no `webviewTag`. |
| **Internal pages** (`chord://settings`, `chord://archive`) | Settings is its own window (⌘, / Ctrl+,), one at a time: the preferences convention on every OS, and it keeps a privileged page out of browsing tabs entirely. The archive renders as a normal tab. | Separate in-memory `chord-ui` session; each page has its own narrow preload and IPC role. Settings (`internal.ts`, role `internal`) sees settings and one chord's theme, never tabs or history. The archive page (`archive.ts`, role `archive`) lists, restores and removes archived tabs, and sees its chord's colors. A tab showing it is made by TabManager on the UI session; navigating it to a web address (or a web tab to it) replaces the view. |

All Chord UI views use one in-memory session, `chord-ui`. The `chord://` and `chord-favicon://` protocols are registered **only on that session**, so web pages can't reach them (this also prevents history-sniffing through favicons).

---

## 5. Window composition

Each window is a `BaseWindow` whose `contentView` holds views in this z-order, bottom to top:

```
┌─ BaseWindow (material: vibrancy / Mica / solid) ───────────────────────────┐
│ 1. shellView      full window, transparent bg: sidebar, frame shadow,      │
│                   top strip (Win/Linux), Duet panel, toasts                │
│ 2. tabViews       active tab (or 2–4 split panes) at the content-frame     │
│                   rect, setBorderRadius(frame radius); background tabs     │
│                   are removed from the tree but stay alive                 │
│ 3. popoverView    hidden; when shown, bounds = card rect only              │
│ 4. overlayView    hidden; when shown, full window (command bar is modal)   │
│ 5. peekView       Peek's page, placed above the overlay's scrim + chrome   │
└────────────────────────────────────────────────────────────────────────────┘
```

Verified constraints and how they shape this:

- **No per-view mouse pass-through.** A transparent region of a view still swallows clicks. Electron #23863 is open; PR #53841 `View.setInteractive(false)` is open. So the overlay view covers the window only for modal moments: the command bar and Peek, where clicking outside closes them. Hover previews live in a separate popover view sized to the card so the sidebar keeps receiving hover events. If #53841 lands, the two collapse into one view.
- `View.setBorderRadius` (Electron 33+) takes one radius for all corners, and the cut-out corners still capture clicks. That's acceptable: the shell draws the frame's hairline and shadow beneath it. Per-corner radii are PR #51472, still open.
- `WebContentsView` starts with a **white** background. Chord views call `setBackgroundColor('#00000000')`. Each tab view starts with the page's last-known background color to avoid white flashes in dark mode.
- `View.setBackgroundBlur` (43+) blurs what is behind a view inside the window. ⚠ Whether it blurs a tab view under the overlay view convincingly is **unverified**; spike S4. Without it the command bar uses a dim scrim and no blur (DESIGN.md §6.3).
- **Layout sync.** The shell renderer owns layout. It measures the content-frame placeholder with a `ResizeObserver` and posts rects over a dedicated `MessagePort`, coalesced to one per animation frame. Main calls `setBounds`. Expect about one frame of lag during sidebar-resize drags; the placeholder is painted in the page's background color to hide it.
- **Animating the frame size** (Duet panel open/close, sidebar dock/undock) never calls `setBounds` per frame, because each call relayouts the page. Instead we capture the page with `capturePage()` (cached when the tab was last shown), animate the bitmap in the shell, then set the final bounds once and swap. Split-view divider drags do resize live, as Chrome does.
- **Minimal mode (sidebar collapsed)** needs no extra view.
  - The 40 px bar is part of the shell view and lies above the frame rect, so no tab view ever covers it.
  - Collapsing changes the frame rect; the change is animated with the snapshot technique below.
- **Sidebar peek in minimal mode** reorders views rather than adding one.
  - The shell view moves *above* the tab views, with its bounds shrunk to a 6 px hot strip at the left edge (plus the bar).
  - On hover-intent its bounds grow to the sidebar rect, and CSS slides the sidebar in over the page.
  - When the peek ends, the bounds shrink back.
  - The cost is that the page's leftmost 6 px don't receive clicks while peek-on-hover is enabled.
  - The peek setting can be turned off.
  - *As built (M1.2), simpler and with no cost to the page:*
    - The hot strip is the 4 px bezel left of the frame, which is already the shell's. Hovering the bar's toggle for 300 ms also peeks.
    - Peeking lifts the shell above the page (`AppWindow.setPeek`) at full size. While it's lifted the shell paints nothing over the page: the backdrop is clipped to the bar, and the frame placeholder is hidden.
    - The pointer resting over the page, a click there, or Esc puts it away. The shell goes back under the page once the slide-out finishes.
    - There's no setting to turn it off yet.
- **Closing a tab really releases it.** `removeChildView` alone does not free the renderer; `webContents.close()` does. The `WebContentsView.destroy()` request (#42884) was closed without explanation on 2026-09-25.

---

## 6. State model and data flow

### 6.1 One reducer, used on both sides

`@chord/core` is pure TypeScript (no Electron, no DOM). It defines:

- **Entities:** `Profile`, `Chord`, `Node` (folder | tab | split), `WindowState`, `ArchiveItem`, `Settings`.
- **Commands:** a discriminated union describing user intent.
- **`apply(state, command, ctx) → { state, patches, inverse, effects }`**, built on Immer's `produceWithPatches`.
- **Policies:** auto-archive eligibility, ordering (fractional ranks), the profile-boundary rule for moving tabs across chords, and frecency.

```ts
type Command =
  | { t: 'tab.open'; chordId: ChordId; url: string; at?: Position; activate?: boolean }
  | { t: 'tab.activate'; nodeId: NodeId }
  | { t: 'tab.close'; nodeId: NodeId }          // pinned → unload; today → archive('closed')
  | { t: 'tab.pin'; nodeId: NodeId; at: Position }
  | { t: 'tab.unpin'; nodeId: NodeId; at?: Position }
  | { t: 'tab.resetToPinned'; nodeId: NodeId }
  | { t: 'node.move'; nodeId: NodeId; to: Position }   // Position = {chordId, section, parentId, rank}
  | { t: 'folder.create' | 'folder.rename' | 'folder.toggle' | 'folder.delete'; /* … */ }
  | { t: 'chord.create' | 'chord.update' | 'chord.delete' | 'chord.reorder'; /* … */ }
  | { t: 'chord.activate'; windowId: WindowId; chordId: ChordId }
  | { t: 'today.clear'; chordId: ChordId }
  | { t: 'archive.restore'; archiveId: ArchiveId }
  | { t: 'split.create' | 'split.resize' | 'split.dissolve'; /* … */ }
  | { t: 'undo'; token: UndoToken };

type Effect =
  | { e: 'view.create' | 'view.destroy' | 'view.attach' | 'view.detach'; nodeId: NodeId }
  | { e: 'navigate'; nodeId: NodeId; url: string }
  | { e: 'persist'; ops: PersistOp[] }
  | { e: 'toast'; undo: UndoToken; copy: ToastCopy };
```

### 6.2 Flow

1. The renderer dispatches a `Command`. For drag-and-drop and other latency-sensitive actions, it **applies the same reducer locally first** (optimistic). Because the reducer is shared and deterministic, the optimistic state equals the authoritative one, so nothing flickers.
2. Main validates the command (zod plus semantic checks), applies it, runs the effects (view lifecycle, navigation), bumps `version`, and broadcasts `{version, patches}` to every Chord renderer.
3. Renderers apply the patches. On a version gap they request a fresh snapshot.
4. `persist` effects go to chord-data. Writes are coalesced and committed every 250 ms or when idle, flushed on quit (2-second cap), and written in WAL mode. Worst case on a hard crash is about 250 ms of sidebar edits lost. Navigation state is persisted on each committed navigation, coalesced per tab.

Live-only fields are never persisted: loading, audible, crashed, the attached-view handle, the capture cache.

### 6.3 Undo

Every destructive command returns inverse patches plus an `UndoToken`. A toast holds the token for 6 s (paused while hovered); undo replays the inverse. Behind the toast, data is also soft-retained:

- Closed Today tabs go to the archive (`reason='closed'`) with their navigation history, which `webContents.navigationHistory.restore()` brings back ✅.
- Deleted folders and chords are soft-deleted (`deleted_at`) and kept 30 days. They can be restored from Settings → Recently deleted.
- Reopen-closed-tab (⌘⇧T) walks the same archive: this session's closed (and cleared) tabs first, back in their exact place, then what the archive remembers you closed or cleared, newest first, across restarts. Tabs tidied away automatically aren't reopened by ⌘⇧T; they're in the archive page and the command bar.

---

## 7. Data schema

**Files:** `<userData>/chord.db` plus `-wal`/`-shm`. Thumbnails for hover previews are files under `<userData>/Captures/` (WebP), not blobs. Chromium's own data (cookies, cache) lives under `<userData>/Partitions/<profile>`.

| OS | `userData` |
|---|---|
| macOS | `~/Library/Application Support/Chord` (Electron default) |
| Windows | `%LOCALAPPDATA%\Chord\User Data`, set via `app.setPath` before ready. Browsers don't roam multi-GB profiles, which is why Electron's `%APPDATA%` default is wrong here. Chrome uses the same location. |
| Linux | `$XDG_CONFIG_HOME/Chord` (default `~/.config/Chord`) |

**Throwaway profiles.** A Chrome-style `--user-data-dir=<path>` replaces `userData` in every build, so packaged builds can be smoke-tested without touching a real profile. Chromium parses it: only the `=` form counts, an empty value is ignored, and a relative path resolves against the working directory ✅. Development builds also read `CHORD_USER_DATA`. The single-instance lock follows `userData`, so such a run doesn't hand off to a running Chord (✅ two packaged instances with different profiles ran side by side on Windows).

**Conventions:**
- IDs are UUIDv7 `TEXT`.
- Times are `INTEGER` Unix ms, UTC.
- Order is a fractional-index `TEXT rank`, so a drag-and-drop move is one row update.
- All tables are `STRICT`.
- JSON columns are validated by zod at the boundary.
- Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`.

```sql
CREATE TABLE profile (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  partition TEXT NOT NULL UNIQUE,              -- 'persist:default' | 'persist:p-<id>'
  is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chord (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profile(id),
  name TEXT NOT NULL,
  icon TEXT NOT NULL,                          -- {kind:'emoji'|'symbol'|'letter', value}
  theme TEXT NOT NULL,                         -- ChordTheme {stops[1..3], grain, appearance}
  rank TEXT NOT NULL,
  duet_enabled INTEGER NOT NULL DEFAULT 1,     -- per-chord opt-out (global switch in settings)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;

-- The sidebar tree. Folders only in 'pinned'; splits in either section; tabs anywhere.
CREATE TABLE node (
  id TEXT PRIMARY KEY, chord_id TEXT NOT NULL REFERENCES chord(id),
  parent_id TEXT REFERENCES node(id),          -- NULL = section root
  section TEXT NOT NULL CHECK (section IN ('pinned','today')),
  kind TEXT NOT NULL CHECK (kind IN ('folder','tab','split')),
  rank TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE INDEX node_children ON node(chord_id, section, parent_id, rank) WHERE deleted_at IS NULL;

CREATE TABLE folder (
  node_id TEXT PRIMARY KEY REFERENCES node(id),
  title TEXT NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE tab (
  node_id TEXT PRIMARY KEY REFERENCES node(id),
  pinned_url TEXT,                             -- the pinned "home" URL; NULL for Today tabs
  custom_title TEXT,
  url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  favicon_key TEXT,
  nav_state BLOB,                              -- navigationHistory entries + index (for restore)
  last_active_at INTEGER NOT NULL,             -- drives auto-archive
  muted INTEGER NOT NULL DEFAULT 0, zoom REAL
) STRICT;

CREATE TABLE split (
  node_id TEXT PRIMARY KEY REFERENCES node(id),
  layout TEXT NOT NULL                         -- {dir:'row'|'column', sizes:number[]}; children = tab nodes
) STRICT;

CREATE TABLE window_state (
  id TEXT PRIMARY KEY,
  bounds TEXT NOT NULL,                        -- {x,y,w,h,displayId,maximized,fullscreen}
  active_chord_id TEXT REFERENCES chord(id),
  sidebar_width INTEGER NOT NULL,
  sidebar_mode TEXT NOT NULL DEFAULT 'docked' CHECK (sidebar_mode IN ('docked','collapsed')),
  duet_width INTEGER,                          -- NULL = panel closed
  active_tab_by_chord TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE archive_item (
  id TEXT PRIMARY KEY, chord_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
  favicon_key TEXT, nav_state BLOB,
  reason TEXT NOT NULL CHECK (reason IN ('auto','closed','cleared','folder-deleted','chord-deleted')),
  archived_at INTEGER NOT NULL, restored_at INTEGER
) STRICT;
CREATE INDEX archive_recent ON archive_item(archived_at DESC);

CREATE TABLE history_url (
  id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profile(id),
  url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  visit_count INTEGER NOT NULL DEFAULT 0, typed_count INTEGER NOT NULL DEFAULT 0,
  last_visit_at INTEGER NOT NULL, frecency REAL NOT NULL DEFAULT 0,
  UNIQUE (profile_id, url)
) STRICT;
CREATE TABLE history_visit (
  id INTEGER PRIMARY KEY, url_id INTEGER NOT NULL REFERENCES history_url(id) ON DELETE CASCADE,
  visited_at INTEGER NOT NULL, transition TEXT NOT NULL
) STRICT;

-- One FTS index for history, archive, pinned tabs and Duet thread titles; triggers keep it in sync.
CREATE VIRTUAL TABLE search_fts USING fts5(
  title, url, kind UNINDEXED, ref UNINDEXED, profile_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3 4'
);

CREATE TABLE favicon (
  key TEXT PRIMARY KEY,                        -- sha256(icon URL)
  icon_url TEXT, data BLOB NOT NULL, mime TEXT NOT NULL,
  dominant_color TEXT, fetched_at INTEGER NOT NULL
) STRICT;

CREATE TABLE site_permission (
  profile_id TEXT NOT NULL, origin TEXT NOT NULL, permission TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny')), updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, origin, permission)
) STRICT;

CREATE TABLE download (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, url TEXT NOT NULL, path TEXT NOT NULL,
  state TEXT NOT NULL, received INTEGER, total INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER
) STRICT;

CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;   -- zod schema per key

-- Duet (§11)
CREATE TABLE duet_thread (
  id TEXT PRIMARY KEY, chord_id TEXT REFERENCES chord(id),
  provider TEXT NOT NULL,                      -- 'claude-code' | 'codex' | later: 'anthropic-api' | 'openai-api' | 'local'
  model TEXT, provider_session_id TEXT,        -- for resume
  mode TEXT NOT NULL DEFAULT 'browse' CHECK (mode IN ('browse','developer')),
  project_dir TEXT,                            -- developer mode only
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE TABLE duet_message (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES duet_thread(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','approval')),
  body TEXT NOT NULL,                          -- JSON blocks: text, citations, tool calls, context refs
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE duet_site_rule (
  origin TEXT PRIMARY KEY, rule TEXT NOT NULL CHECK (rule IN ('never','ask'))
) STRICT;
```

**As built (migration 1, `packages/data/src/migrations.ts`):** the profile, chord, node, folder, tab, window_state, favicon and setting tables. Three deliberate differences from the sketch above:

- `node.chord_id` is `DEFERRABLE INITIALLY DEFERRED`, because a batch writes whole entities in any order.
- `parent_id` and `active_chord_id` aren't foreign keys. `restoreState()` in `@chord/core` repairs dangling references on load (an orphaned tab moves to its section root; a missing active chord falls back to the first).
- `tab` and `folder` rows cascade from `node`.

Favicons are stored once per distinct icon, keyed by content hash, and unused ones (no tab or archived tab uses them) are dropped on open.

**The archive, as built (migration 5):** `archive_item` with an explicit integer `rid` (so its external-content FTS5 index, `archive_fts`, survives `VACUUM`), `reason` of `auto`, `closed` or `cleared`, and `nav_state` as JSON: the tab's `navigationHistory` entries (with Chromium's `pageState`, which holds the scroll position) and index, at most 50 entries around the current one, web pages only, and capped at 1 MB. An entry is deleted when its tab comes back. Entries older than 30 days go on open. Archive writes ride the history event stream (`HistoryEvent` `archive` / `unarchive`), in order and in the same transaction as the batch they arrive with.

**Favorites, as built (migration 6):** `favorite` (id, url, title, `favicon_key` into `favicon`, rank, created_at), shared by every chord and profile; the favicon clean-up keeps their icons. **Folders** use the `folder` table from migration 1, Pinned only (a tab moved into a folder is pinned there). **Sidebar width** uses `window_state.sidebar_width` from migration 1, 200–400 px.

**Migrations** are forward-only numbered SQL files, each run in a transaction. Before every migration, and as a daily rolling copy (keep 3), we take a backup with `VACUUM INTO`. A failed migration restores the backup and opens in a read-only "something went wrong" state rather than losing data.

**Profiles.** Chords share the default profile unless "Keep sign-ins separate" is on. That creates a profile with its own persistent partition: cookies, storage, cache, extensions. Moving a tab to a chord with a **different profile** recreates it in the target session and reloads it, because a WebContents can't change session. The UI says so before the drop completes.

*As built:*
- **Where to switch:** the chord's ⋯ menu, the command bar action, and Settings → General → Sign-ins. That Settings group also has a "New chords keep their own sign-ins" default.
- **What happens:** `chord.profile` sets the chord's profile. Its open pages close, the page on screen reloads in the new session, and the window offers Undo.
- **Cleanup:** a profile no chord uses is deleted at the next launch, both its `profile` row and its `Partitions/p-<id>` folder. That's when the sign-ins of a chord that was deleted or switched back to shared disappear.
- **Still shared across profiles, on purpose:** history, permission decisions and downloads. They're about sites and you, not accounts.

**Auto-archive.** A main-process timer runs every 5 minutes and on `powerMonitor` `resume`. It archives Today tabs whose `last_active_at` is older than the chord's threshold (12 h by default; 24 h, 7 d, 30 d, or never). It skips tabs that are audible, visible in any window, part of a split, or playing media. Archived items are kept 30 days by default.

As built (`core/idle.ts`, `main/idle.ts`):
- The threshold is one setting for now (Settings → General → "Archive Today tabs after"), not per chord.
- `last_active_at` is when you last *left* the tab (the reducer stamps the tab a window stops showing), so idle time runs from then, not from when you opened it.
- Busy tabs are skipped: audible; playing (`media-started-playing` until `media-paused`, so muted video counts); given the camera or microphone, until the page goes (Electron can't say when capture ends); and in picture-in-picture (asked in an isolated world just before acting).
- Candidates are checked again against fresh state right before acting, and the reducer never auto-archives a tab on screen.
- `CHORD_ARCHIVE_AFTER_MS`, `CHORD_SLEEP_AFTER_MS` and `CHORD_IDLE_CHECK_MS` shorten the times in development and tests (ignored when packaged).

---

## 8. IPC contract

**Principles:**

1. **One preload per trust role:** shell, overlay, popover, internal. Each exposes a frozen `window.chord` object through `contextBridge` with explicit methods. Raw `ipcRenderer` is never exposed.
2. **Every channel is declared once** in `@chord/ipc/contract.ts`: name, allowed roles, zod request and response schemas. Both sides import the same contract, so types and runtime validation can't drift.
3. **Main checks the sender on every message.** `event.sender.id` must be registered under an allowed role, `event.senderFrame` must be the main frame, and `senderFrame.url` must be the expected `chord://<surface>` origin. Unknown channels are dropped and logged; payloads over 256 KB are rejected. Large data (attachments, screenshots) moves by reference ID, never inline.
4. **Web content gets nothing:** no preload, no IPC. The exception is the extension library's preload: it runs in every page of a profile that has extensions, and does nothing outside extension pages and extensions' isolated worlds. Extension pages get only what it injects ([§12](#12-extensions)).
5. **Electron 45 constraint:** sandboxed preloads no longer have the `events`, `timers`, `url`, or `Buffer` modules, so preloads are written against browser APIs only.

**Transports:**

| Kind | Transport | Examples |
|---|---|---|
| Commands and queries | `ipcRenderer.invoke` → `ipcMain.handle` | `cmd.dispatch`, `settings.get` |
| State fan-out | `webContents.send('state.patch', {version, patches})` | sidebar updates |
| High-frequency streams | `MessagePort`. Main creates a `MessageChannelMain` and hands one end to a utility process and the other to the renderer's preload. Ports arrive in the isolated world and are wrapped there; they are not forwarded to the main world. | layout rects (shell→main), search (overlay↔data), Duet stream (agent↔shell) |

**Channels, by role:**

| Channel | shell | overlay | popover | internal | Notes |
|---|:-:|:-:|:-:|:-:|---|
| `state.snapshot` / `state.patch` | ✓ | ✓ | ✓ (subset) | — | |
| `cmd.dispatch(Command)` | ✓ | ✓ (open/activate/actions subset) | — | — | |
| `layout.port` | ✓ | — | — | — | frame rects, Duet width |
| `nav.back/forward/reload/stop` | ✓ | ✓ | — | — | |
| `search.port` | — | ✓ | — | — | direct to chord-data |
| `archive:list/restore/remove/snapshot` | — | restore only | — | — | the archive page's own role, `archive`; as built these are `invoke` channels through main, which flushes pending writes first |
| `system.info` | ✓ | ✓ | ✓ | ✓ | platform, accent, reduced motion and transparency, forced colors, window-controls geometry |
| `overlay.open/close` | ✓ | ✓ | — | — | |
| `permission.respond` | — | — | ✓ | — | |
| `settings.get/set` | read | read | — | ✓ | |
| `defaultBrowser.status/request` | ✓ (onboarding) | — | — | ✓ | |
| `updates.status/check/install` | — | — | — | ✓ | |
| `duet.port` / `duet.approve` / `duet.attach` | ✓ | — | — | — | absent if Duet is off |
| `duet.settings.*` | — | — | — | ✓ | |

Navigation guards: every Chord UI view rejects `will-navigate`, `will-frame-navigate`, and `setWindowOpenHandler` for anything other than its own `chord://` URL. Web content can never navigate to `chord://` or `chord-favicon://`, and isn't served them anyway (separate session, [§4](#4-process-model)).

---

## 9. Browser engine services

| Service | Approach |
|---|---|
| **Tabs** | TabManager owns `nodeId → WebContentsView`. Views are created lazily: on restart only the active tab of each window loads. Others load on activation (pinned tabs show their cached favicon and title until then). |
| **Sleeping tabs** | Electron has no Chromium tab discarding. Tabs hidden for more than 60 minutes (configurable) get their `nav_state` saved and `webContents.close()` called. Activation restores them with `navigationHistory.restore()` ✅. **Never slept or auto-archived** (rule borrowed from Crest): tabs that are playing media, in picture-in-picture, sharing the screen or camera, being used by an agent, or holding a pending `beforeunload`. **As built:** 60 minutes hidden, checked with auto-archive; on by default, with a switch in Settings → General. The history (with `pageState`, so the scroll position comes back) stays in memory until the tab is shown; a sleeping tab is one with no live entry, and its icon fades to 70 %. ⚠ Not yet: detecting a pending `beforeunload` (a page with unsaved form input can be slept; `pageState` usually brings the input back). |
| **Popups / OAuth** | `setWindowOpenHandler`: a plain `target=_blank` becomes a new Today tab (or Peek, for links from pinned tabs, later). `window.open` with features, as OAuth and payment popups use, gets a real child popup window so `window.opener` keeps working. |
| **Navigation events** | `did-navigate`, `page-title-updated`, `page-favicon-updated`, loading and audible changes are coalesced per tab (≤ 1 update per 50 ms) into store commands. History visits go to chord-data. |
| **Favicons** | Fetched through the tab's own session (`session.fetch`, so partition cookies apply), size-capped at 64 KB, sanitized (SVG rasterized to PNG in a sandboxed context), and stored by key. The shell loads them via `chord-favicon://<key>`. Fallback monograms are generated client-side (DESIGN.md §7.4). |
| **Permissions** | `setPermissionRequestHandler` and `setPermissionCheckHandler` on every profile session (`main/permissions.ts`). Camera, microphone, location, notifications and clipboard-read prompt in the popover, but only for the tab you're looking at. Allow and Block are remembered per origin (`site_permission`, migration 2); ✕ denies this time only. Pending requests are denied when their tab navigates away or closes. Fullscreen, pointer lock, sanitized clipboard writes, persistent storage and storage access are allowed. Everything else is denied. ⚠ Not yet: screen sharing (`display-capture` needs a picker via `setDisplayMediaRequestHandler`), MIDI, and a Settings page to review decisions. |
| **Downloads** | `will-download` saves straight to the Downloads folder (no dialog, as Chrome does by default), as `name (1).ext` rather than overwriting (`main/downloads.ts`). Progress reaches the store at most every 250 ms and is persisted (`download` table, migration 3). Downloads cut off by quitting come back as interrupted, with Retry. The sidebar footer's Downloads button fills a ring while files download and shows a dot for unseen finished ones. It opens the downloads panel in the overlay, anchored to the button. In minimal mode the button appears in the bar only while something is downloading or just finished. ✅ On Windows, downloaded files get the mark of the web (`Zone.Identifier`, `ZoneId=3`), so SmartScreen and Office's Protected View still apply; an E2E test checks it. ⚠ Not yet: dangerous-file warnings, and asking where to save. |
| **Certificates** | Electron refuses untrusted certificates by default, and the load fails with an `ERR_CERT_*` code. The frame then explains it with "Go back" (or "Close tab") and no way through. A bypass for non-HSTS hosts may come later. |
| **Load errors** | `did-fail-load` on the main frame (except `ERR_ABORTED`) records the error on the tab. The tab's view is hidden, and the frame shows plain-language copy from `describeLoadError()` in `@chord/core` with Try again, plus the `ERR_` name in small type. The next navigation clears it. |
| **Find in page** | `webContents.findInPage`, with a find bar in the **popover** view at the frame's top-right. The overlay would have blocked the page while it's open; the popover is sized to its cards, so the page stays scrollable and clickable. The bar follows its tab and closes when another tab is shown. |
| **Fullscreen** | `enter-html-full-screen` hides the shell chrome and gives the tab view the full window bounds. |
| **Crashes** | `render-process-gone` reloads the page automatically, at most twice per tab (Crest's rule). After that the frame shows a friendly "This page stopped" state with Reload. |
| **Auto picture-in-picture** | When you leave a tab whose video is playing (switch tab or chord), the video pops out into a floating player, like Dia. **As built (spike S7, docs/decisions/S7-auto-pip.md; `main/auto-pip.ts`):**<br>1. The switch happens first; nothing waits.<br>2. In the outgoing tab's isolated world, `executeJavaScriptInIsolatedWorld(…, userGesture = true)` calls `requestPictureInPicture()` on the largest playing video. Embedded frames are asked in their own main world. `userGesture` meets the user-activation rule, and it works on a tab that's already off screen ✅.<br>3. The video keeps playing and drawing in the PiP window after its view is detached ✅. The tab's `live.pip` is set, so it's never slept or archived.<br>4. Returning to the tab, or clicking the PiP glyph in its row, calls `document.exitPictureInPicture()`, so the video continues inline.<br>**Why Chord does it itself:** Chrome's auto-PiP lives in Chrome's browser layer, which Electron doesn't ship. The Media Session `enterpictureinpicture` action is never fired by Electron ✅.<br>**The floating window** is Chromium's own video PiP window, the same one Chrome and Dia show. ✅ Its hover controls in Electron 45: *Back to tab*, Close, Minimize, the origin, play/pause, ±10 s, previous/next track, a time scrubber, Mute, and the video-call buttons.<br>*Back to tab* sends Chord no event ✅. Chord recognizes it as PiP ending with the video still playing, when Chord didn't end it and no other video took the window, and brings the tab forward. ✕ ends PiP and Chromium pauses the video ✅, which Chord can't prevent; Chord leaves you where you are.<br>Chord can't restyle the window. Document Picture-in-Picture's `requestWindow()` resolves but shows no window (#39633) ✅.<br>**Skipped when:** the video is muted and the page hasn't made sound since it loaded; it's smaller than 200×112; it has `disablePictureInPicture`; something on the page is already in PiP; another tab's video is popped out; or *Pop out playing videos when you switch away* is off.<br>⚠ Not yet: the per-site "Don't pop out" list. On Wayland the compositor places the PiP window. |
| **Context menus** | Native `Menu.popup()` built from the `context-menu` params. This is platform-correct, accessible, and avoids overlay z-order problems. |
| **Internal pages** | `chord://settings` and `chord://archive` are served by `protocol.handle` from inside the asar, with CSP `default-src 'self'; img-src 'self' chord-favicon:; style-src 'self'; script-src 'self'`. React sets styles through the CSSOM, so no `'unsafe-inline'` is needed. |
| **Search engine** | **Google by default** (decided 2026-10-22); DuckDuckGo, Bing, Kagi, Ecosia and custom engines selectable in Settings and from the command bar. Search suggestions while typing send keystrokes to the engine; their default is open question Q2 in ROADMAP.md. |
| **User agent** | **Decided (S2):** the standard Chromium user agent, Electron's default minus the `Electron/…` and app-name tokens (`src/main/user-agent.ts`). Client-hint brands still say `Chromium`, so we don't claim to be Google Chrome. ✅ Google sign-in works by hand on Windows with this UA, and also with Electron's default. Automated (Playwright) sign-in is always blocked, because Google flags debugger-driven browsers. ⚠ Still to check by hand: Microsoft, Apple, GitHub, Cloudflare Turnstile, and Google on macOS/Linux. Electron sends no `Sec-CH-UA` on navigations (PR #53519). See docs/decisions/S2-google-signin.md. |
| **Several windows** | ⌘N opens a window on the chord you're in, with the command bar open (`window.create`; the overlay says `overlay:ready` before its first opening is sent). **A tab shows in one window at a time**, because a view has one parent. Activating a tab another window shows moves it: that window falls back to its most recent free tab, and its `view.show` runs first. Landing on a chord, or after a close or archive, never takes a tab from another window. Closing one of several windows forgets it (`window.close`). The last normal window, and every window open at quit, comes back next launch. Restore gives a tab shown twice to the first window only. |
| **Private windows** | ⌘⇧N. Each has one chord of its own (`private: true`, "Private", graphite and always dark, an eye-off glyph) on an in-memory partition, `chord-private-<windowId>`. Main empties it when the window closes. Nothing of it is ever saved: `opsFromPatches` and `opsForState` skip it, and restore drops it. Other windows, the command bar, Settings and the archive page never see its chord or tabs (`chordsFor`, `sortedChords`). Inside it, rules are enforced in the reducer: no pinning, no archive, and ⌘⇧T remembers its tabs only while it's open. History and command-bar picks aren't recorded, and searches return nothing from history or the archive. Permission prompts work, but the answers live in memory for the window's life and it never reads your saved ones. Downloads are saved to disk but listed only in that window (`Download.privateWindow`) and forgotten with it. No extensions: Electron refuses to load them into an in-memory session, and Chord refuses to install there. Links from other apps and Settings go to a normal window. Duet is unavailable. |
| **`session.webRequest`** | **Chord core does not use it.** Hooking it silently stops extensions' `chrome.webRequest` listeners from firing (electron-chrome-extensions README; also seen in Flow Browser #153). Header and policy needs go through other hooks. This constrains the built-in ad-blocker option in [§12](#12-extensions). |

---

## 10. Command bar and search

The command bar is the overlay renderer, **always mounted and hidden**:

1. ⌘T / Ctrl+T reaches main through `before-input-event` (from any focused view) or the app menu (macOS).
2. Main calls `overlayView.setVisible(true)`, focuses its webContents, and posts `open {mode, prefill}`. No React mount and no layout work happen at open time. Target: first frame under 16 ms, well inside the 50 ms budget.
3. ⌘L opens it pre-filled with the current URL, selected.

**Sources and latency per keystroke:**

| Source | Where it lives | Latency |
|---|---|---|
| Open tabs (all chords), pinned tabs, folders, chords | In-memory index in the overlay, updated from state patches | uFuzzy, about 0.15 ms per 5k items ⇒ painted the same frame |
| Actions ("New chord", "Pin this tab", "Copy URL", "Archive Today", "Split with…") | Static registry in the overlay | same frame |
| History, archive, Duet threads | chord-data FTS5 prefix query, `LIMIT 20`, ranked by `bm25 × frecency`, over the overlay's direct `MessagePort` | target ≤ 5 ms p95; merges in without reflowing rows above it |
| Inline URL autocompletion | Top host match from history (typed_count-weighted) | same frame |
| Web search row | Always last ("Search for “…”"); first if nothing else matches strongly | same frame |

Each query carries a sequence number; stale responses are dropped. The in-memory index is trimmed to what search needs (title, URL, chord, kind, favicon key).

**As built (M1.4 ranking, `core/rank.ts`, ported from Crest with attribution):**
- **Signals:**
  - **Text match:** start of the text 1000, start of a word 700, inside a word 300. A word found only in the address scores 150 less, and every typed word must match. Initials and letters in order count too ("tsv" finds Toggle Split View).
  - **Usage:** history earns `min(300, 60·log₂(1 + frecency))`.
  - **Recency:** an open tab earns up to 200 within the hour, fading over a day.
  - **Fixed points:** 150 for an open tab and 100 for a pinned one.
  - **Learned picks:** per chord, up to 1000 for an exact repeat.
- **Frecency** is stored as one number per page (`decay_day`, the day its score falls to 1). A visit adds 1, and a pick from the command bar adds another, so a typed visit counts twice. The score halves every 30 days.
- **One row per page:** an open tab beats its history entry, and the typed address is never repeated as history. A page is keyed by host without `www.`, port, path and query.
- **What leads (Return runs it):**
  - a pick made twice for exactly this text, or else
  - a pinned or recently used tab, or a well-used page (usage ≥ 120), that the text starts.

  Otherwise the address or search the text spells comes first. A typed address leads over pages unless habit says otherwise.
- **Transport:** history lives in chord-data (migration 4: `history_url`, `history_visit`, an external-content FTS5 index kept in sync by triggers, and `palette_choice`). The overlay asks through main (`history:search`), not yet over a direct MessagePort. The 50 best bm25 matches come back, and the overlay ranks them with everything else.
- **Inline autocomplete:** only the leading row completes, and only when it's a page whose address (its place key, or `www.` plus it) starts with the typed text. So the field never shows one place while Return opens another. The completed part stays selected: typing on replaces it, Tab accepts it. Deleting never brings it back until you type again. An address typed in full that is an open tab's leads with that tab ("Switch to tab"), so accepting a completion never opens a page twice.
- **Search suggestions** (Q4: on, with a switch in Settings → General):
  - Main asks the chosen engine's OpenSearch endpoint (`SEARCH_ENGINES[].suggest`). All six were checked with real requests through Chromium's network stack. Brave refuses curl but answers Chromium ✅.
  - The request goes through an in-memory `chord-suggest` session with `credentials: 'omit'`. A newer question from the same command bar aborts the older one; failures mean no suggestions.
  - Typed addresses and half-typed `@filters` never go out.
  - The overlay waits 120 ms after the last keystroke, drops stale replies, and appends suggestions below every local row, so nothing above them moves.
- **Scopes** (DESIGN.md §7.3):
  - **Site keywords** (`core/keywords.ts`): YouTube `yt`, GitHub `gh`, Wikipedia `wiki`, Google Maps `maps` and Reddit `reddit`, plus one per engine (`google`, `ddg`, `bing`, `brave`, `kagi`, `ecosia`).
    - Tab switches to the keyword. Space switches too, but only for abbreviations (`yt`, `gh`, `wiki`, `ddg`), so a search that starts with "maps" stays a search.
    - The keyword's search leads. Pages on that site follow, then the engine's suggestions when the keyword is an engine.
  - **Filters:** `@tabs`, `@pinned`, `@history` (recent pages before you type), `@archive` (the newest archived tabs before you type), `@chords` and `@actions`. Typing `@` lists them.
  - The keyword or filter shows as a chip; Backspace in the empty field removes it.
- **Where a result opens:** ↵ here, ⌘↵ / Ctrl+↵ in a new background tab, ⇧↵ in a new tab in front. ⇧↵ becomes "new window" once Chord has more than one window.
- **Archive (as built):** archived tabs come from chord-data with history, and replace the history row for the same page. They rank with that page's use (or recency of archiving) and picking one brings the tab back with its back/forward history.
- ⚠ **Not yet:** Crest's calculator, and the fading HintBar.

---

## 11. Duet — the assistant panel

Duet is an **opt-in** right-side panel for chatting about what's in the browser. It uses the user's **own** Claude Code or Codex installation and subscription. Chord runs no server, never sees credentials, and spawns nothing until Duet is turned on.

### 11.1 Provider policy constraints (verified 2026-10-22)

**Anthropic** ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)):
- Third-party developers may not offer Claude.ai login, route requests through Free, Pro or Max credentials on users' behalf, or "collect, store, or intermediate Claude.ai credentials or session tokens".
- Products using the Agent SDK should use API keys.
- The page does **not** prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- Running Claude Code in a product requires the Commercial Terms and that the binary be unmodified, with its authentication methods unrestricted.

**OpenAI:** `codex app-server` is the documented interface for rich clients (JSON-RPC 2.0, JSONL over stdio), and sign-in runs inside Codex. ⚠ **No published policy for third-party clients using ChatGPT subscriptions was found.**

**Design consequences:**

| Rule | How Chord complies |
|---|---|
| Use the user's unmodified binary | Chord **does not bundle** `claude` or `codex`. It detects them on `PATH` and the standard install locations and shows "Install Claude Code" / "Install Codex" links to the official instructions. |
| Sign-in completes through the provider's own flow | Chord has **no sign-in UI**. "Sign in" opens a terminal running `claude auth login` or `codex login`, or shows the command to run. Status comes from `claude auth status` (JSON; exit code 0 when logged in) and Codex's equivalent. |
| No credential handling | Chord never reads `~/.claude` or `~/.codex` credentials, never sets token environment variables in subscription mode, and never logs CLI auth output. |
| No Anthropic/OpenAI branding as our feature name | The feature is **Duet**. Copy says "works with your Claude Code or Codex app" in plain text, with no logos. |
| Avoid needing Electron as Node | We spawn the user's native `claude` binary directly, not the Agent SDK's bundled `cli.js` via `process.execPath`. The latter would require the `RunAsNode` fuse, which we disable ([§14.1](#141-hardening)). |
| Setup is the user's own step | Decided 2026-10-22: no provider agreement is sought. The user installs and signs in to their own CLI (`claude auth login` / `codex login`), the same model T3 Code uses: it drives `@anthropic-ai/claude-agent-sdk` and `codex app-server` (checked in its repo). Anthropic says it may enforce its terms "without prior notice", so R8 tracks policy changes, and the BYO-key and local-model backstops stay on the roadmap. |

A later phase adds **your own API key** (Anthropic or OpenAI APIs, stored with `safeStorage` async) and **local models** (any OpenAI-compatible local endpoint, such as Ollama or LM Studio). That keeps Duet working even if subscription access changes.

### 11.2 Runtime

```mermaid
sequenceDiagram
  participant U as Duet panel (shell)
  participant M as Main
  participant A as chord-agent
  participant C as claude (user's binary)
  participant T as Chord MCP (in chord-agent)
  U->>M: duet.send(threadId, text, contextRefs)
  M->>A: turn {thread, text, resolved context}
  A->>C: stream-json user message (stdin)
  C->>T: tools/call tab.read {tabId}
  T->>M: read tab (isolated-world extractor)
  M-->>T: markdown + provenance
  C->>T: approve {tool: folder.create}
  T->>U: approval card
  U-->>T: allow once
  C-->>A: stream-json deltas
  A-->>U: deltas over duet.port
```

**Claude Code adapter.** One long-lived `claude` process per active thread:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages
       --session-id <uuid> | --resume <provider_session_id>
       --model <alias>
       --strict-mcp-config --mcp-config <inline JSON: chord MCP at 127.0.0.1:<port>, bearer token>
       --permission-prompt-tool mcp__chord__approve
       --append-system-prompt-file <duet-browse.md>
       # browse mode only:
       --restricted --tools ""
```

All flags were verified against the CLI reference on 2026-10-22.
- `--tools ""` removes every built-in tool (Bash, file edits, WebFetch), so a browse thread can only call Chord's MCP tools.
- `--restricted` (CLI v2.1.248+) loads only managed settings and `--settings`, isolating browse threads from the user's coding hooks and plugins.
- Chord enforces a minimum CLI version and asks the user to run `claude update` if theirs is older.

**Codex adapter.** One `codex app-server` per agent process: JSON-RPC over stdio, `initialize` with `clientInfo.name = "chord"`, then threads and turns. Chord's tools are offered via the same localhost MCP server, configured through config overrides, or via `dynamicTools` on `thread/start` (marked experimental).
- ⚠ **Unverified:** how to remove Codex's shell tool for browse mode.
- Until spike S5 settles it, Codex browse threads run with a read-only `sandboxPolicy` and an approval policy that sends every command to Chord's approval UI.

**Chord MCP server:**
- Streamable HTTP bound to `127.0.0.1` on a random port.
- A per-process bearer token, checked for `Host`/`Origin` to block DNS rebinding.
- Lives only as long as chord-agent.

### 11.3 Tools, in permission tiers

| Tier | Tools | Approval |
|---|---|---|
| 0 · Context | `tabs.list` (current chord; other chords only if the user allows), `tab.read` (attached or user-allowed tabs; markdown or text; ranged), `tab.screenshot`, `history.search`, `archive.search`, `page.highlight(tabId, quote)` (scrolls to the quote and marks it) | None, but scoped to what the user attached or allowed |
| 1 · Organize | `tab.open` (Peek or Today), `folder.create`, `node.move`, `tab.archive`, `space.create` | Approval card per call; "Allow for this thread" available |
| 2 · Act on pages (later) | click, type, fill | Approval per action, always. Disabled on excluded sites. |
| Developer mode | `devtools.console`, `devtools.network` (CDP via `webContents.debugger`, only for tabs the user attaches), `tab.reload`; plus the provider's normal file and shell tools in the chosen project folder | Provider's own permission flow, routed to Chord's approval UI |

### 11.4 Content extraction and prompt-injection posture

Page content is **untrusted input** handed to an agent that may hold tools.

- **Extraction:**
  - Readability plus HTML→Markdown, run in an **isolated world** (`executeJavaScriptInIsolatedWorld`) so page scripts can't tamper with the extractor.
  - It reads rendered text only: never form-field values, never `input[type=password]`, and not hidden or `aria-hidden` subtrees.
  - Capped at 100k characters, with ranged reads.
- **Provenance and delimiting:** every chunk is wrapped with its source (tab, URL, retrieved time). The Duet system prompt states that page content is data, never instructions.
- **Capability containment:**
  - Browse threads have no shell, no files, no fetch.
  - Tier 1 and 2 tools need approval.
  - `tab.open` to a URL that did not come from the user's own context needs approval even when the thread allows "organize". This closes the exfiltrate-via-URL path.
- **Exclusions:**
  - Private windows and `duet_site_rule = 'never'` origins can never be read.
  - Pages with a focused password field are skipped.
  - Each chord has a Duet off switch.
  - The **global off** removes the panel, menus, and shortcut, and chord-agent is never spawned.
- **Visibility:**
  - Context chips show exactly what will be sent with each message.
  - Tool activity is shown inline.
  - A dot on the tab marks one that Duet is watching (console/network) in developer mode.
- **Nothing in the background.** Duet only acts on a user message.

**Connect an agent (from Crest, Phase 2+).** The Chord MCP server is also offered to agents the user runs themselves. Settings → Agents copies a `claude mcp add …` or `codex mcp add …` line that points at a small `chord-mcp` stdio helper:
- **Helper:** a Node single-executable build, or Go/Rust if size matters. It can't be Electron as Node, because the RunAsNode fuse is off.
- **Transport:** a named pipe on Windows and a 0600 Unix socket elsewhere.
- **Tool names** follow chrome-devtools-mcp, which agents already know, and carry read-only/destructive hints that map onto §11.3's tiers.
- **Visibility:** every tab an agent touches gets a badge, a colored outline and a **Stop** button.

Duet becomes one client of that same server. Unlike Crest, Duet keeps per-call approvals, because it reads pages that may carry prompt injection.

**Storage.** Chord keeps its own rendering transcript in `duet_message`. Providers also keep their own local transcripts (Claude under `~/.claude/projects`, Codex under `~/.codex/sessions`); that is disclosed in settings.

---

## 12. Extensions

Chrome extension support is a **Phase 1 requirement** (decided 2026-10-22), built in M1.5 on spike S9 ([docs/decisions/S9-extensions.md](docs/decisions/S9-extensions.md)). Verified state (Electron 45, Chromium 156):

- **Electron's built-in support** (`session.extensions`) loads unpacked MV3 extensions, runs their service workers and content scripts, and covers `scripting`, `webRequest`, partial `extension`/`management`/`runtime`/`tabs`, `storage.local`, and **`declarativeNetRequest`**, which is present and enforcing.
  - Gaps: no `action` popups, `contextMenus`, `windows`, `cookies` or `commands`; no Web Store installer.
  - Electron skips Chrome's install step, so `runtime.onInstalled` never fires and manifest-enabled rulesets aren't turned on. Chord does both itself (below).
  - Electron refuses to load extensions into in-memory sessions.
  - Alone, it runs only 2 of S9's 6 test extensions.
- **The library:** electron-chrome-extensions, the iamEvanYT fork (4.9.5), **vendored** as `packages/chrome-extensions`.
  - It fills the gaps, and mirrors its APIs onto the native `browser` namespace that Chromium 148+ also exposes.
  - It runs all 6 test extensions.
  - Its `checkLicense()` needs only a declared license string (`'GPL-3.0'`), not a key. Chord uses it under GPL-3.0 (decision D1).
  - Chord's changes are listed in its `CHORD-CHANGES.md`. One upstream bug fix: `queueAndSendEvent()` now waits for the *target* extension's listener.
- **Issues worth knowing:** #172 (MV3 workers broke in Electron 40), #184 (breakage in 42+), #185 (an extension iframe inside a page can't reach its worker), #177 (Proton Pass popup sizing, fixed by Chord's own popups).

**How Chord integrates it:**
- **`ExtensionHost`** (`main/extensions/host.ts`) is the seam: one per profile that has extensions, and the only code that touches the library. Another implementation (the Patron License, or our own) only replaces this file.
  - The library's frame preload runs in every page of a profile with extensions (§8 notes the exception).
- **Tabs and windows:** `chrome.tabs` maps onto TabManager's pages (tab ID = `webContents.id`); pinned and index come from the sidebar. `chrome.windows` maps onto Chord windows; `windows.create({type: 'popup'})` opens a small window on the profile. Unloaded tabs aren't visible to extensions.
- **Context menus:** extensions' items join the page's native menu, before Inspect.
- **Popups:** a view on the profile session inside the window, sized like Chrome's (25×25 to 800×600) beside its button. It closes on Esc, a click elsewhere in Chord, or a tab or layout change, and stays open when focus leaves Chord.
  - Electron 45's `enablePreferredSizeMode` doesn't survive the cross-process navigation into an extension's process. So a script in Chord's own isolated world reports the page's size instead (`main/extensions/sizer.ts`).
- **Toolbar:** pinned extensions' buttons sit in the sidebar's shelf, or in the title bar by choice (DESIGN.md §3). The puzzle piece lists them all.
- **Web Store installer** (`main/extensions/crx.ts`, `webstore.ts`) is Chord's own, because electron-chrome-web-store verifies no signatures.
  - It asks Google's update service, downloads over HTTPS, and checks the announced SHA-256.
  - It verifies CRX3 as Chromium's `crx_verifier.cc` does: every signature, the developer key against the ID, and the store's publisher key.
  - It unpacks with a traversal-safe, size-limited ZIP reader, and writes the developer key into the manifest so the store ID holds.
  - Updates are checked a minute after launch, then every 5 hours, and roll back if a new version won't load.
- **The install step:** on install or update, Chord sends `runtime.onInstalled` (once per version, remembered across crashes) and, on first install, enables the manifest's rulesets through the library's worker preload.
- **Saved state:** installs, versions and pins live in chord-data's `extension` table, per profile.

**Ad blocking.** uBO Lite's `declarativeNetRequest` blocking works (S9). Decision D5 can now consider it alongside the Ghostery engine.

**Electron #54685** (`session.fetch` breaking after extensions load) didn't reproduce on Windows with `persist:` partitions, which is Chord's favicon path. Recheck on macOS.

---

## 13. Cross-platform abstractions

All OS-specific code lives in `src/main/platform/{darwin,win32,linux}.ts` behind one interface. Renderers receive a `SystemInfo` snapshot and style themselves with `[data-platform]`, `[data-appearance]`, and design-token overrides. No `process.platform` checks in components.

```ts
interface PlatformServices {
  os: 'darwin' | 'win32' | 'linux';
  displayServer?: 'x11' | 'wayland';
  windowChrome(): { kind: 'traffic-lights'; inset: Rect } | { kind: 'wco'; height: number; side: 'left' | 'right' | 'both' };
  applyMaterial(win: BaseWindow, appearance: 'light' | 'dark'): 'vibrancy' | 'mica' | 'none';
  accentColor(): string | null;                 onAccentChange(cb: (hex: string) => void): void;
  prefersReducedMotion(): boolean;              prefersReducedTransparency(): boolean;
  forcedColors(): boolean;
  defaultBrowser: { status(): Promise<'yes' | 'no' | 'unknown'>; request(): Promise<'done' | 'opened-settings' | 'instructions'> };
  canPositionWindows: boolean;                  // false on Wayland
  modifier: 'Cmd' | 'Ctrl';
}
```

| Concern | macOS | Windows | Linux |
|---|---|---|---|
| Window controls | `titleBarStyle: 'hidden'`, traffic lights placed in the sidebar header via `trafficLightPosition` ✅ | `titleBarStyle: 'hidden'` + `titleBarOverlay` (Window Controls Overlay) in a 40 px top strip ✅. Snap Layouts per Microsoft for Electron 13+; ⚠ no WCO-specific confirmation, test on Win11. | WCO ✅. Button side follows the desktop's layout (43+), icons are themed from GTK/Breeze (44+), and Wayland client-side decorations work (41+). Layout reads `env(titlebar-area-*)`. |
| Material | `vibrancy: 'sidebar'` on BaseWindow ✅ | `backgroundMaterial: 'mica'` on Win11 22H2+ ✅. ⚠ Known bugs with frameless and maximize (#41824, #42393, #46753), so it's a runtime capability with a solid fallback. Win10 gets solid. | No OS material API ✅. Solid tint plus grain. |
| Accent color | `systemPreferences.getAccentColor()` ✅ | same, plus `accent-color-changed` ✅ | same (39+) ✅ |
| Reduce motion / transparency | `getAnimationSettings().prefersReducedMotion` + CSS `prefers-reduced-motion` (follows OS on all three ✅); `nativeTheme.prefersReducedTransparency` | same; `nativeTheme.inForcedColorsMode` for High Contrast | CSS follows `gtk-enable-animations` ✅ |
| Shortcuts | One registry (`packages/core/src/shortcuts.ts`, DESIGN.md §14) builds everything. **Reserved** keys are caught in `before-input-event` on every webContents, before the page sees them. **Page-first** keys are app-menu accelerators that fire only when the page didn't handle the key. Spike S8 passed on Windows; macOS is still to be confirmed by hand. | Same model; the menu is attached but never shown as a bar. Accelerators fire with `titleBarStyle: 'hidden'` (S8). | Same as Windows |
| Default browser | `Info.plist` URL schemes + `app.setAsDefaultProtocolClient`. ⚠ Electron calls the deprecated `LSSetDefaultHandlerForURLScheme`; whether the system "Keep Safari / Use Chord" prompt appears is unverified (spike S3). Fallback: a small native helper calling `NSWorkspace setDefaultApplicationAtURL`. | Installer writes `Capabilities` + `URLAssociations` + `RegisteredApplications` (HKCU) and calls `SHChangeNotify` (`build/installer.nsh`). Links launch `Chord.exe --single-argument %1`, as Chrome's do: Chromium hands everything after that switch over as one argument, so a crafted link can't add switches ✅ (tested). In-app "Make default" opens `ms-settings:defaultapps?registeredAppUser=Chord`. The status check reads `UserChoiceLatest\ProgId`, then `UserChoice` (newer Windows 11 builds keep the live choice in the former) ✅. Programmatic default is impossible (UCPD protects UserChoice) ✅. | `.desktop` declares `x-scheme-handler/http(s)` + `text/html`; Electron's API uses GIO (`g_app_info_set_as_default_for_type`) ✅. We also run `xdg-settings set default-web-browser` when available. Flatpak shows instructions (no portal found). |
| Links from other apps | `open-url` (registered before `ready`) ✅ | `second-instance`, reading `additionalData` rather than argv (argv can be reordered) ✅ | same as Windows |
| Window placement | free | free | **Wayland can't set positions or read the global cursor** ✅. The mini window uses compositor placement there, and Peek's origin comes from the last in-page mouse-down (`input-event`), which works everywhere. |
| Chord swipe phases | `webContents.on('input-event')` `gestureScrollBegin/Update/End` on the shell view gives real phases ✅ (the old `scroll-touch-*` events were removed in 23). ⚠ Phase quality on Windows precision touchpads and libinput is unverified; fallback is end-on-idle (DESIGN.md §6.4). | | |

---

## 14. Security, updates, and the 72-hour patch process

### 14.1 Hardening

| Control | Setting |
|---|---|
| Renderer sandbox | Default since Electron 20 ✅. `app.enableSandbox()` also called. It also removes a `--no-sandbox` switch from the command line (✅ `app.commandLine.hasSwitch('no-sandbox')` is false afterwards), so no launcher can turn the sandbox off. |
| Web content | `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`, `sandbox: true`, **no preload**. `will-attach-webview` denied globally. |
| Fuses | `RunAsNode` **off** · `EnableCookieEncryption` **on** · `EnableNodeOptionsEnvironmentVariable` **off** · `EnableNodeCliInspectArguments` **off** · `EnableEmbeddedAsarIntegrityValidation` **on** (macOS, Windows; compiled out on Linux, so a no-op there ✅) · `OnlyLoadAppFromAsar` **on** · `GrantFileProtocolExtraPrivileges` **off** · `LoadBrowserProcessSpecificV8Snapshot` off for now (revisit for startup) · `WasmTrapHandlers` on (default). Set by electron-builder's `electronFuses` right before signing. It bundles `@electron/fuses` 1.8.0, which doesn't know `WasmTrapHandlers`, so that one keeps Electron's default. ✅ Read back with `@electron/fuses` 2.1.3 from the Windows x64 and Linux x64 builds: exactly this list. electron-builder writes the asar integrity data (an `INTEGRITY` resource on Windows, `ElectronAsarIntegrity` in macOS's Info.plist). ✅ On Windows, a one-byte change inside `app.asar` stops the app with *ASAR Integrity Violation*. With `EnableNodeCliInspectArguments` off, Playwright's `_electron.launch` can't attach to a packaged build (it needs `--inspect`), so the packaged smoke test drives it over Chromium's remote-debugging port ([§15.5](#155-testing)). |
| IPC | §8 allowlist, sender validation, zod schemas |
| Internal protocols | `chord://` and `chord-favicon://` registered only on the `chord-ui` session, with CSP |
| Secrets | Only Duet BYO API keys (later). `safeStorage` **async** API, since the sync API is deprecated in 45 and removed in 46 ✅. |
| Permissions | Prompt or deny by default ([§9](#9-browser-engine-services)). `display-capture` goes through our picker. |
| Safe Browsing | ⚠ Electron has no Safe Browsing. Option: Google Safe Browsing v5 Local List mode. Its terms allow non-commercial use and require attribution and disclosure. Decision D7. |
| Duet | [§11.4](#114-content-extraction-and-prompt-injection-posture) |

### 14.2 Dependency automation (Renovate)

`renovate.json` passes `renovate-config-validator --strict` (Renovate 44.178.1) ✅. It runs on the Mend-hosted app: every 4 hours for active repos, and daily until the first Renovate PR is merged ✅.

- **`electron`** has no `minimumReleaseAge` and no PR rate limits (`prConcurrentLimit`/`prHourlyLimit: 0`), and it comes first (`prPriority`).
  - It's a group of its own, so a tooling update still in its 7-day wait can't hold it back.
- **Electron patch and minor updates automerge** once every CI check passes. Majors get a manual PR.
  - Renovate's own automerge treats any failed check as red, and no checks at all as pending ✅.
  - `platformAutomerge` is off. Without a ruleset that requires the CI checks, GitHub's native auto-merge could merge before tests finish ✅.
- **Everything else waits `minimumReleaseAge: 7 days`** (supply-chain buffer).
  - Vulnerability-alert PRs bypass the wait: the `vulnerabilityAlerts` default sets `minimumReleaseAge: null` ✅. They need Dependabot alerts turned on for the repo.
  - Renovate can't check release age for some update types (`pin`, `pinDigest`, `lockFileMaintenance`, …), so those are exempt. Otherwise they'd wait forever ✅.
- **Lock file maintenance** runs weekly (before 4 am Monday). A person reviews it, because it refreshes transitive versions with no age check ✅.
- **GitHub Actions** are pinned to commit SHAs (`helpers:pinGitHubActionDigests`, part of Renovate's `config:best-practices` ✅), and Renovate keeps the pins current.
- **Groups:**
  - `electron`, alone;
  - electron tooling (electron-vite, electron-builder, electron-updater, `@electron/*`);
  - build and lint tooling;
  - UI libraries.

  Renovate has no Electron preset, so we use `groupName` ✅.
- The Dependency Dashboard is on, and `:configMigration` opens a PR when Renovate renames an option.

### 14.3 The 72-hour Chromium security process

Electron security advisories **only cover Electron's own bugs**. Chromium fixes appear only in the release notes, so vulnerability alerts never fire for them ✅. Current notes say "Backported fixes from upstream ANGLE, Chromium, …" with no CVE ids, or just "Updated Chromium to …". Hence:

- **`electron-watch.yml`** runs hourly, at :17, because GitHub delays scheduled runs at the top of the hour ✅. The logic is in `scripts/ci/electron-watch.mjs`, with unit tests.
  1. It reads `releases.electronjs.org/releases.json`. That file lists versions but carries no notes ✅, so the notes for each newer release on our major come from the GitHub API.
  2. Security content means a CVE, a GHSA, a `Security:` line, a `Backported …` line, or `Updated Chromium to …`.
  3. On a hit, it opens **one P0 issue per version**. The issue is labeled `security` + `p0` and assigned to the `SECURITY_ONCALL` repo variable (default: the owner).
  4. It then ticks the Dependency Dashboard's "run again" checkbox, so Renovate runs now rather than within 4 hours. ⚠ Mend doesn't document that as an API.
  5. Separately, it opens an issue 30 days before our major's end-of-life, using `schedule.json`.
- **Runbook:** [docs/SECURITY-PATCHING.md](docs/SECURITY-PATCHING.md).

| T+ | Step | Today |
|---|---|---|
| 0 h | Electron publishes a patched release. Precedent: a V8 zero-day was fixed in Chrome on 2025-06-30 and in Electron 37.2.0 on 2025-07-02 ✅. Its notes said only "Updated Chromium to 138.0.7204.97" ✅. | |
| ≤ 1 h | Watcher opens an issue; Renovate PR is up | Automated. If the dashboard tick doesn't take, the PR comes within 4 h. |
| ≤ 8 h | CI green on the full matrix (unit, E2E on macOS, Windows, Linux X11, Linux Wayland, arm64 + x64); Renovate automerges | Automated |
| ≤ 12 h | Tag `vX.Y.Z` → release workflow builds, signs, notarizes, and signs manifests | Builds only; signing is deferred (§15.2) |
| ≤ 24 h | Publish at `stagingPercentage: 20`; Flathub PR opened; apt/rpm repos updated | Publish only; the rest arrives in Phase 3 |
| ≤ 48 h | Staged rollout → 100% after crash-free check (local crash logs only, since there is no telemetry; we watch issue reports) | Phase 3 |
| ≤ 72 h | All channels patched: GitHub/updater, Cloudsmith repos, Flathub merged | GitHub Release only |

To pull a bad release we ship a higher version (electron-updater has no rollback ✅).

**Bus factor:** at least two maintainers must hold release approval rights before 1.0 (risk R9).

### 14.4 Auto-updates

| Platform | Mechanism | Integrity |
|---|---|---|
| macOS | electron-updater (dmg plus **zip**, needed by Squirrel.Mac) | Squirrel.Mac checks the update against the running app's code-signing requirement ✅, plus sha512, **plus Chord's Ed25519 manifest signature** |
| Windows | electron-updater with NSIS, differential via blockmap | Authenticode signer must match `publisherName` ✅ (⚠ the check is skipped if PowerShell can't run, so the Ed25519 check is the backstop), plus sha512, plus Ed25519 |
| Linux AppImage | electron-updater, differential | sha512 only upstream ✅ → **Chord's Ed25519 check is required** |
| Linux deb/rpm | Signed apt/yum repos on **Cloudsmith** (OSS tier: 50 GB storage, 200 GB/month ✅). The in-app updater only notifies, because electron-updater's deb/rpm install uses `--allow-unauthenticated` / `--nogpgcheck` ✅. | GPG-signed repo metadata (`Signed-By`) |
| Flatpak | Flathub | Flathub's GPG-verified remotes ✅ |

**While builds are unsigned** (§15.2), the preview builds work like this:
- **Phase 1:** a notify-only update check on every platform (`src/main/updates.ts`, built).
  - **When:** installed builds only, with Settings → About → "Check for updates automatically" (on by default). It runs 30 s after launch, then daily.
  - **What it asks:** GitHub's `/releases` list, unauthenticated: 60 calls an hour per address ✅. It uses an in-memory session and never sends cookies.
  - **Which release counts:** the newest by SemVer precedence. Drafts never count. SemVer pre-releases count only for someone already running one; GitHub's own pre-release flag is ignored, so previews still announce each other. Only release-page links are trusted.
  - **What you see:** a toast "Chord 0.2.0 is out · What's new" (once per version per run) and the answer in About, with "Check now".
  - **Failures:** silent, with backoff of 1 h, 2 h, 4 h, then daily.
- **Phase 3:** in-app install on Windows and AppImage, still gated by the Ed25519 check.
- **macOS:** stays notify-and-download until it's signed.

**Ed25519 manifest signing:**
- The release workflow signs `latest*.yml` with a key held in a protected GitHub Environment.
- The public key is baked into the app.
- A custom electron-updater provider (`provider: 'custom'` ✅) wraps the GitHub provider and verifies the signature before any download.
- When electron-builder v27's built-in signed manifests go stable, we switch to them.

---

## 15. Packaging, distribution, CI, testing

### 15.0 App identity (hard to change later, so fixed now)

| Identifier | Value | Where it matters |
|---|---|---|
| Product name | Chord | window titles, menus, installer |
| App ID (reverse DNS of **chordbrowser.com**, which we control) | `com.chordbrowser.Chord` | macOS bundle ID, Windows AppUserModelID, Linux `.desktop` file name, Flatpak/Flathub app ID (Flathub verifies domain ownership), `userData` folder name |
| Executable | `chord` (Linux), `Chord.exe`, `Chord.app` | packaging, default-browser registration |
| Internal schemes | `chord://`, `chord-favicon://` | only on the `chord-ui` session (§4) |
| Future web uses of the domain | site, install guides, `security@` contact for SECURITY.md (Cloudflare Email Routing), optional `dl.` CNAME for package repos | no rush |

In the packages:
- **Linux:** the `.desktop` file is `com.chordbrowser.Chord.desktop` with `StartupWMClass=com.chordbrowser.Chord` ✅ (checked in the built `.deb` and AppImage). `desktopName` in `apps/desktop/package.json` sets it; Electron uses the same value as the Wayland `app_id` and X11 `WM_CLASS`, and electron-builder's `linux.syncDesktopName` names the file after it.
- **Windows:** the one-click per-user installer names its folder after the npm package name, so the packaged `package.json` is renamed `chord`: `%LOCALAPPDATA%\Programs\chord` (⚠ read from electron-builder's NSIS source; the release workflow logs where it installs). The installer is `Chord-<version>-win-<arch>-setup.exe`; its uninstall entry's GUID derives from the app ID.

### 15.1 Targets

| Platform | Artifact | Notes |
|---|---|---|
| macOS | Signed, notarized **universal** (arm64 + x64) `.dmg` + `.zip` | Developer ID; notarization via notarytool API key. electron-builder's docs say to base64 the key, but the code wants a **file path**: write the `.p8` to disk in CI ✅. Entitlements start with `allow-jit` only and are added only when a test fails ✅. Icon: Icon Composer `.icon` for macOS 26 Liquid Glass, supported since electron-builder PR #9279 ✅. |
| Windows | **NSIS**, per-user, one combined x64 + arm64 installer ✅ | Recommended over MSIX: it works with electron-updater, has no virtualized AppData surprises, and uses classic default-browser registration through a custom NSIS include (electron-builder writes none of those keys ✅). MSIX can declare a browser via `uap3:Protocol` ✅ but updates only through the Store or App Installer. A future Store channel would come from the same build. |
| Linux | **deb + rpm** (primary, Cloudsmith repos), **Flatpak** (Flathub, built from source with `org.electronjs.Electron2.BaseApp` + zypak ✅), **AppImage** | electron-builder's deb/rpm post-install adds an AppArmor `userns` profile or a setuid `chrome-sandbox` as needed ✅. **AppImage:** electron-builder's launcher silently adds `--no-sandbox` when user namespaces are blocked (Ubuntu 23.10+) ✅. `app.enableSandbox()` drops that switch ([§14.1](#141-hardening)), so Chord **never runs unsandboxed**. A dialog that explains this and points the user to the deb or Flatpak is still to do. |

**Preview builds today** (unsigned, [§15.2](#152-code-signing)) differ from the table above:
- **One artifact per OS and architecture**, each built on its own native runner so it can be smoke-tested there: `Chord-<version>-win-<arch>-setup.exe`, `Chord-<version>-mac-<arch>.dmg` and `.zip`, `Chord-<version>-linux-<arch>.AppImage` and `.deb` (Linux names x64 `x86_64` or `amd64`). A universal Mac app or a combined Windows installer would double every download. Revisit when signing arrives.
- **No rpm yet.** Flatpak and package repos stay in Phase 3.
- **AppImage uses electron-builder's static runtime** (`toolsets.appimage: '1.0.3'`, which electron-builder labels beta). The default runtime needs libfuse2, which Ubuntu 22.04 and later don't install. ✅ The static one ran Chord on Ubuntu 22.04 (WSL) without libfuse2, and is 8 MB smaller. Where user namespaces are blocked, the AppImage won't start (⚠ how it fails is unverified), and the README sends those users to the deb.
- **deb:** electron-builder's post-install installs an AppArmor `userns` profile ✅ (present in the built package). ⚠ That it lets the sandbox run on Ubuntu 24.04 is checked by the release workflow's install smoke test, which hasn't run yet.
- **Icon** (DESIGN.md §2): SVG masters in `apps/desktop/build/`. `icon.svg` is drawn on Apple's 1024 px grid; `icon-16.svg`, `icon-24.svg` and `icon-32.svg` redraw it on whole pixels for those sizes. `pnpm --filter @chord/desktop icons` (`scripts/build-icons.mjs`) draws them with Chromium in a hidden Electron page and writes the committed `icon.icns` (16–1024 px), `icon.ico` (16–256 px) and `icons/NxN.png` (Linux hicolor sizes, 16–512 px). Windows and Linux get the body cropped to fill the square, without the macOS shadow. electron-builder copies an `.ico` or `.icns` named in its config as is rather than converting it ✅ (its icon converter's source), so each size ships as drawn.
  - Development runs set the icon on the window (Windows, Linux) and in the Dock (macOS). Packaged Windows takes it from the `.exe`, and packaged Linux windows read the PNG inside `app.asar` ✅ (`nativeImage` reads from asar).
  - ⚠ macOS 26 shrinks app icons that don't fill its rounded square onto a gray plate. Reports say icons on Apple's grid, like ours, are left alone; unverified on a Mac. The lasting fix is an Icon Composer `.icon`, which electron-builder 26.18 compiles with Xcode's `actool` when `mac.icon` names one ✅ (its source).

### 15.2 Code signing

> **Deferred (decided 2026-10-22): focus on open source first.** Until signing is set up, builds ship unsigned. Consequences we design around:
>
> | Platform | Unsigned behavior | What Chord does |
> |---|---|---|
> | macOS | Gatekeeper blocks first launch. On macOS 15+ the user must allow it under System Settings → Privacy & Security → *Open Anyway*. **Squirrel.Mac can't auto-update unsigned apps.** Apple Silicon requires at least an ad-hoc signature to run at all. electron-builder 26.18 has no automatic ad-hoc fallback: without an identity it skips signing ✅ (its option docs and source). So Chord sets `mac.identity: '-'` (ad-hoc) and `hardenedRuntime: false`, because with an ad-hoc identity the hardened runtime's library validation rejects Electron's frameworks ✅ (electron-builder's docs and warning). Hardened runtime and `allow-jit` come back with Developer ID signing. ⚠ That the ad-hoc build launches on Apple Silicon is checked by the release workflow on `macos-26` (`codesign --verify`, then the smoke test), which hasn't run yet. ⚠ Cookie encryption keeps its key in the keychain, and keychain access is tied to the code signature. An ad-hoc signature changes with every build, so macOS may ask to allow *Chord Safe Storage* after an update. | Install steps in the README (*Try the preview*); screenshots to come. In-app update is notify-and-download only. |
> | Windows | SmartScreen shows "Windows protected your PC" → *More info* → *Run anyway*. | Install steps in the README; electron-updater still works (no `publisherName` pin), integrity comes from the Ed25519 manifest check. |
> | Linux | Unaffected: AppImage/deb/rpm don't use OS code signing; repos and Flathub use free GPG signing. | Normal. |
>
> Everything below is the plan for when signing is switched on (roadmap Phase 4). Each piece is additive, so nothing built now has to change.

| Platform | Plan |
|---|---|
| macOS | Apple Developer Program membership (decision D3). |
| Windows | **Azure Artifact Signing** (formerly Trusted Signing): $9.99/month, `win.azureSignOptions` ✅. Individuals are eligible **only in the US or Canada**; organizations in more countries. Validation takes 1–20 business days. Fallback: **SignPath Foundation** (free for OSS, but requires an existing release history, manual approval per release, and the cert subject reads "SignPath Foundation") ✅. EV certificates no longer give instant SmartScreen reputation ✅. We keep one signing identity forever, because `publisherName` pins it for updates. |
| Linux | GPG key for repos and for AppImage detached signatures; Ed25519 update key. |

### 15.3 Releases come only from CI

Tags `v*` trigger `release.yml`. It can also be run by hand, which builds and tests without releasing. Today, unsigned, it does this:
1. **Build the matrix:** each OS and architecture on its own native runner (§15.4). A tag must match the version in `apps/desktop/package.json`.
2. **Install or open each build as a user would, and smoke-test that copy** ([§15.5](#155-testing)):
   - Windows: the per-user NSIS install, run silently.
   - macOS: `codesign --verify` and `hdiutil verify`, then the app.
   - Linux: the installed `.deb`, with no sysctl change, so its AppArmor profile is what's tested. Then the AppImage.
   - The fuses are read back into the log.
3. **Upload a draft prerelease** with `SHA256SUMS.txt`. The only write permission is `contents: write`, on that job.
4. **A maintainer publishes.**

When signing arrives (Phase 4), these steps slot in after the build:
- Sign through a **protected GitHub Environment** (`release`). Signing secrets are available only to tag builds on `main`, with required reviewers.
- Notarize.
- Sign the manifests.

A laptop never holds signing keys.

### 15.4 CI matrix (GitHub-hosted, free for public repos ✅)

| Job | Runner |
|---|---|
| macOS arm64 build + tests | `macos-26` |
| macOS Intel smoke | `macos-15-intel` (the last Intel image; Intel runners end August 2027 ✅) |
| Windows x64 / arm64 | `windows-latest` / `windows-11-arm` |
| Linux x64 / arm64 | `ubuntu-24.04` / `ubuntu-24.04-arm` |
| Linux X11 E2E | `xvfb-run` ✅ |
| Linux Wayland E2E | headless Weston (`--backend=headless-backend.so`), copied from Electron's own `run-tests-wayland.sh` ✅. Wayland is the default since Electron 38 ✅. |

Every PR runs lint, typecheck, unit tests, E2E, and **visual captures** on all of the above.

### 15.5 Testing

| Layer | Tooling | Covers |
|---|---|---|
| Unit | Vitest | `@chord/core` reducer and policies (property tests for ordering and undo round-trips), `@chord/tokens` (contrast guarantees across random themes), `@chord/db` migrations and queries against real SQLite |
| Component | Vitest + Testing Library | sidebar tree keyboard navigation, command bar ranking |
| E2E | Playwright `_electron` 1.64 (experimental) | ✅ Verified in M1.0: `app.windows()` returns both the tab and the `chord://shell/` page inside `WebContentsView`s, and tests drive them directly. `browserWindow(page)` fails for `BaseWindow`, so we don't use it. Tests set `CHORD_HOME_URL` (dev builds only) so they never need the network. ⚠ Verified in M1.1: Playwright's synthetic key presses **never reach Electron's `before-input-event`**, so tests can't press reserved shortcuts. Real OS input does reach it. E2E tests open the command bar through the shell's API, and the shortcut router is covered by unit tests on the registry. A **test-only** IPC for querying state arrives with the Store in M1.1. |
| Packaged | Playwright over CDP (`test/packaged`, `pnpm --filter @chord/desktop test:packaged`) | Starts a packaged build (the platform's unpacked output, or the file in `CHORD_APP`) with a throwaway `--user-data-dir`, and on macOS with `--use-mock-keychain` so it never touches the tester's keychain: a build whose ad-hoc signature the keychain hasn't seen waits on a *Chord Safe Storage* prompt before loading any page. A macOS-only test runs a freshly re-signed copy to prove it doesn't ✅ (macOS 27, M3). Checks that the shell loads from `chord://shell/` inside the asar with its bundled font, a tab loads a local page, and Settings opens. Then it quits, relaunches, and checks that the tabs and a setting were restored, which proves the asar'd chord-data utility process and `node:sqlite` work. `_electron.launch` can't attach to a packaged build ([§14.1](#141-hardening)), so the test passes `--remote-debugging-port=0` and connects with `chromium.connectOverCDP`; it has no main-process access. ✅ Passed on Windows x64 (the unpacked build and the installer's payload) and on Linux x64 (the AppImage, in WSL). |
| Visual | Playwright screenshots of shell and overlay | Uploaded as CI artifacts per OS × light/dark × 3 chord themes. Reviewed against DESIGN.md before any UI change is shown to you. |
| Performance | Startup, command bar, and frame-time probes | Run in CI for trends. **Enforced** on reference hardware locally, since CI runners are noisy. |

**What gets verified where.** Windows is the primary platform, so features are built and checked there first.
- **Windows 11:** locally on your machine (144 Hz display, good for the 120 fps target).
- **Linux:**
  - WSL2/WSLg on this machine (Wayland, plus X11 through XWayland).
  - Your Linux VM.
  - CI on X11 and Weston.
- **macOS:**
  - CI captures.
  - Your Apple Silicon MacBook, for vibrancy, traffic-light placement, ProMotion 120 Hz (⚠ unverified in Electron) and trackpad gestures. I'll list exactly what to check after each change.

---

## 16. Decisions

| # | Decision | Status |
|---|---|---|
| **D1** | Extension library license | **Decided 2026-10-22: (a).** Chord's source is MIT. `core/rank.ts` stays MPL-2.0 because it comes from Crest. Release binaries that include the extensions library are a GPL-3 combined work: they ship the GPL-3 text and point to the source at the release tag. MIT is GPL-compatible, and so is MPL-2.0 (§3.3). The alternatives were (b) the Patron License, an ongoing sponsorship that keeps binaries non-GPL, and (c) our own `chrome.*` layer, months of work. The `ExtensionHost` seam keeps both open. Not legal advice. |
| **D2** | Duet provider access | **Decided:** no provider agreement. Users run `claude auth login` / `codex login` themselves, as with T3 Code (§11.1). |
| **D3** | Code signing | **Deferred:** open source first, unsigned builds, with the consequences handled in §15.2. Signing becomes roadmap Phase 4. |
| **D4** | DRM (Netflix, Spotify, Disney+) | **Open; needed by M1.6.** (a) Stock Electron: no Widevine, fastest security patches. (b) castLabs ECS: Widevine on macOS/Windows, none on Linux. Its latest stable is 44.5.1+wvcus (2026-10-03) while upstream 44 is at 44.9.3, so it trails on patches. **Recommendation: (a) for v1**, with honest copy. |
| **D5** | Ad blocking | Open; not needed until Phase 3. Built-in Ghostery engine (MPL-2.0, opt-in) vs none. uBO Lite needs `declarativeNetRequest`, which Electron lacks. |
| **D6** | Default search engine | **Decided:** Google; others selectable. |
| **D7** | Phishing and malware protection | Open; not needed until Phase 3. Safe Browsing v5 Local List (non-commercial terms, attribution) vs none. |
| **D8** | Duet timing | **Proposed in ROADMAP.md:** Phase 2, browse mode first; developer mode in Phase 4. |

## 17. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **Sign-in blocked or bot checks failing** (Microsoft, Apple, GitHub, Cloudflare; no client-hint headers on navigation) | Low for Google (passed S2 by hand on Windows) / severe if it hits | Manual checks in M1.1 once the address bar exists. Track Electron PR #53519. Never judge sign-in from automated runs. |
| R2 | **Password managers unreliable** through the extension layer | High / severe | Extension acceptance suite. Move extension support as early as the roadmap allows. Upstream fixes. Interim: desktop apps' system autofill. |
| R3 | **Time to Arc's shutdown (2026-12-22, 61 days)** | High / high | Phase 1 scoped to a usable browser on all three OSes; Duet and everything else after. ROADMAP will be explicit about what lands before Dec 22. |
| R4 | electron-vite or @dnd-kit/react churn (single maintainer / pre-1.0) | Medium / medium | Pin versions; wrap behind our own modules; eject paths documented. |
| R5 | Mica and frameless bugs on Windows | Medium / low | Runtime capability detection; solid fallback; visual tests on Win11. |
| R6 | Memory with many tabs (no Chromium discarding) | Medium / medium | Sleeping tabs (§9); lazy restore; auto-archive. |
| R7 | Linux sandbox breakage (AppArmor userns, AppImage) | Medium / high | deb/rpm/Flatpak primary; AppImage refuses to run unsandboxed. |
| R8 | Duet policy change by a provider | Medium / medium | BYO API key and local models; feature isolated in chord-agent. |
| R9 | 72-hour patch SLA depends on one person | High / high | A second maintainer with release rights before 1.0; automation does everything except the publish click. |
| R10 | Prompt injection through page content | High / high | Browse threads have no shell or files; approval tiers; URL-exfiltration rule; exclusions (§11.4). |
| R11 | `node:sqlite` is "release candidate" and untested in utilityProcess | Low / medium | Spike S1; `Db` interface; better-sqlite3 v13 fallback. |
| R12 | 120 Hz in Electron unverified on ProMotion | Low / medium | Measure on your Mac; Chromium flags if needed. |

**Spikes (first week of Phase 1, each about a day):**
- **S1** `node:sqlite` + FTS5 in utilityProcess on all OSes.
- **S2** Sign-in and bot-check matrix.
- **S3** macOS default-browser prompt.
- **S4** `setBackgroundBlur` over a tab view.
- **S5** Codex browse-mode tool restriction (in Duet's phase).
- **S6** Trackpad gesture phases per OS.
- **S8** Keyboard routing: reserved keys via `before-input-event` and page-first app-menu accelerators, with WebContentsView inside BaseWindow, on all three OSes (including hidden menus on Windows/Linux and whether macOS menu key equivalents preempt the page). **Pass on Windows** ([docs/decisions/S8-keyboard-routing.md](docs/decisions/S8-keyboard-routing.md)); Linux in CI; macOS by hand.
- **S7** Auto picture-in-picture: controls present in Electron 45's PiP window, *back to tab* routing, and video rendering after the source view is detached (see Electron PR #50264 on occluded video). ✅ **Resolved on Windows:** docs/decisions/S7-auto-pip.md.
- **S9** Chrome extensions on Electron 45: real Web Store extensions, popups, DNR, isolation, library and license. **Partial on Windows:** the iamEvanYT fork of electron-chrome-extensions runs all six test extensions, while Electron alone runs two. Recommends the vendored fork, Chord's own verified installer, and GPL-3 binaries (D1 a) ([docs/decisions/S9-extensions.md](docs/decisions/S9-extensions.md)).
