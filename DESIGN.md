# Chord — Design

Status: **draft for review** · Last updated 2026-10-22 · Companion: [ARCHITECTURE.md](ARCHITECTURE.md)

This document is the bar every UI change is reviewed against. Values here become code in `packages/tokens`. Components never hardcode a color, size, radius, duration, or spring. If something you need isn't here, add a token, don't hardcode it.

---

## Contents

1. [Principles](#1-principles)
2. [Identity and voice](#2-identity-and-voice)
3. [Layout anatomy](#3-layout-anatomy)
4. [Tokens](#4-tokens)
5. [Chord themes](#5-chord-themes)
6. [Motion](#6-motion)
7. [Components](#7-components)
8. [Key flows](#8-key-flows)
9. [Empty states and copy](#9-empty-states-and-copy)
10. [Accessibility](#10-accessibility)
11. [Platform adaptations](#11-platform-adaptations)
12. [Design QA](#12-design-qa)
13. [Open design questions](#13-open-design-questions)
14. [Keyboard shortcuts](#14-keyboard-shortcuts)

---

## 1. Principles

Each principle has a test, so reviews can say "this fails principle 3" instead of "this feels off".

| # | Principle | In practice | Test |
|---|---|---|---|
| 1 | **Content first** | Chrome recedes. Web pages get the most space; the sidebar is the only persistent chrome, and it can hide. | At the default window size the page gets ≥ 80% of the window width. No chrome element animates while you're reading. |
| 2 | **Every interaction has a response** | Nothing snaps, pops, or jumps. Hover, press, drag, open, close, and arrive each get feedback within one frame and motion that explains what happened. | Record the interaction at 120 fps: no frame where an element teleports. |
| 3 | **Personality without noise** | Color, texture, and playfulness live in the sidebar, the chord themes, and transitions. Never in the page, never in your way. | Remove the moment of delight: does the task get slower? Then it was in the way. |
| 4 | **Fast is a feature** | Motion is for continuity, never for waiting. Typing never animates results. | Any animation that delays the user's next possible action is a bug. |
| 5 | **Native where it counts** | Window controls, menus, shortcuts, scrolling, and text rendering follow the platform. Chord's own personality lives in the space between. | A Windows user never hunts for the close button; a Mac user never sees Ctrl. |
| 6 | **Forgiving** | Every destructive action can be undone from a toast, and recovered later from the archive or Recently deleted. | No confirm dialogs for anything undoable. |
| 7 | **Keyboard is first-class** | Everything you can click, you can do from the keyboard and find in the command bar. | Complete every flow in §8 without a pointer. |

---

## 2. Identity and voice

**Name.** A *chord* is several notes played together. Inside Chord, each set of tabs is itself a chord: the tabs are the notes, and they play together with their own color. The identity stays musical but quiet. No music-note clip art.

**Mark.** Three rounded notes of different lengths, stacked and stepped like a chord on a staff and like tabs in a sidebar. Each note is one *Dusk* hue (Lilac, Rose, Coral), and each overlaps the one above through a cutout in the body's color. They sit on a pale body that runs from lilac-white to peach, so the colors carry the icon at any size. The sources are SVGs in `apps/desktop/build/` (ARCHITECTURE.md §15.1). The welcome card (§8.1) draws the same notes from the same numbers (`Onboarding.tsx`, `Mark`): the icon's geometry, gradients and shadows, with the cutouts in the card's color. It must not resemble Arc's arch, and it uses no Arc color pairings. Still to do: a monochrome version for menus and tray, and an Icon Composer `.icon` with layered glass for macOS 26 (electron-builder supports this).

**Signature motion.** On first launch the three bars land one after another (60 ms stagger, `bouncy` spring), like a chord being struck. That is the only place the logo animates.

**Voice.**
- Friendly, plain, brief. Sentence case everywhere. Verbs on buttons ("Make it the default", not "OK").
- Talk about outcomes, not mechanisms. Say "Keep sign-ins separate", not "isolated session partition". Say "Today", not "unpinned tabs". Say "Archive", not "history of closed tabs".
- Never blame. Say "That page couldn't load", not "You entered an invalid URL".
- A wink is welcome in empty states and onboarding. Everywhere else, be clear.

**Words we use:** chord (a set of tabs with its own color; lowercase in running text, so the app stays "Chord") · Pinned · Today · Folder · Archive · Split · Peek · Duet · Mini window.
**Words we avoid:** space and workspace (we say *chord*), session, profile (except in Settings → Advanced), tab group, incognito (we say *private window*), AI (we say *Duet*).

---

## 3. Layout anatomy

### 3.1 Window

```
macOS                                            Windows / Linux
┌──────────────┬──────────────────────────────┐  ┌──────────────┬──────────────────────────────┐
│ ● ● ●   ‹ › ⟳│                              │  │ ≡   ‹ › ⟳    │ 🔒 example.com · Title  ─ ▢ ✕│ ← 40 px strip (WCO)
│ ┌──────────┐ │ ╭──────────────────────────╮ │  │ ┌──────────┐ │ ╭──────────────────────────╮ │
│ │example.com│ │ │                          │ │  │ │example.com│ │ │                          │ │
│ └──────────┘ │ │                          │ │  │ └──────────┘ │ │                          │ │
│ ✦ Personal   │ │        web page          │ │  │ ✦ Personal   │ │        web page          │ │
│ ▸ Reading    │ │   (rounded, inset 4 px,  │ │  │ ▸ Reading    │ │                          │ │
│ ◉ Mail       │ │    soft shadow)          │ │  │ ◉ Mail       │ │                          │ │
│ ── Clear ──  │ │                          │ │  │ ── Clear ──  │ │                          │ │
│ + New tab    │ │                          │ │  │ + New tab    │ │                          │ │
│ ◉ Docs       │ │                          │ │  │ ◉ Docs       │ │                          │ │
│              │ │                          │ │  │              │ │                          │ │
│ ▣ ⤓   • ● • +│ ╰──────────────────────────╯ │  │ ▣ ⤓   • ● • +│ ╰──────────────────────────╯ │
└──────────────┴──────────────────────────────┘  └──────────────┴──────────────────────────────┘
  sidebar 248      frame inset: 4 top/right/bottom   frame top = strip bottom; inset 4 right/bottom
```

- **Sidebar:** default 248 px, resizable 200–400. It snaps to 248 with a gentle detent when you drag within 8 px of it. It sits directly on the window material (vibrancy, Mica, or solid) with the chord tint over it.
- **Content frame:** a 4 px bezel (`frame-inset`) from the window edges, as thin as it can be while the rounded corners still read. Its radius is the platform `radius-frame` token, with `shadow-frame` and a 1 px hairline. The shell draws the shadow and hairline; the web view sits inside.
- **Top strip (Windows and Linux only):** 40 px, needed for native caption buttons via Window Controls Overlay (and Snap Layouts on Windows 11). It is not wasted space: it shows site identity and page actions, and it's the window drag region. On Linux the caption buttons can be on the left; the layout reads `env(titlebar-area-x/width)` and the sidebar header makes room.
- **Duet panel (when open):** a second frame to the right of the content frame. Default 380 px, range 320–560, separated by an 8 px gap. It is a calm neutral surface, not tinted: chat is for reading.

### 3.2 Sidebar, top to bottom

| Row | Height | Contents |
|---|---|---|
| Header | 40 | macOS: traffic lights (≈ 68 px reserved, `trafficLightPosition` centered in the row) then back/forward/reload. Windows/Linux: app menu ≡ (native menu) then back/forward/reload. |
| URL pill | 36 | Site-info icon + registrable domain (full URL on hover). Click or ⌘L edits the address **in place**: the pill becomes a text field with the URL selected, and results drop down beneath it (§7.3). Hover reveals copy link · page actions. *(2026-10-24:)* On macOS with the sidebar docked, reader view's button (§7.11) sits just right of the pill while the page reads as an article; with a top strip (Windows, Linux) or the minimal bar, it's there instead. *(2026-10-25:)* Effects' button (§7.15) sits after it while the site has Effects. |
| Chord header | 28 | Chord icon (16) + name (`text-label`). Hover shows the ⋯ menu (Edit theme, Rename, Keep sign-ins separate, Delete). |
| Pinned | 32 / row | Pinned tabs and folders, nestable; indent 12 px per level, visually capped at 4 levels. |
| Favorites | 40 + 8 | *(As built, M1.2.)* Tiles every chord shares, in a wrapping grid, each a site's icon on an `item-hover` square (`radius-md`). The one for the tab you're on is raised. A tile switches to this chord's tab on that site, or opens it in Today. Drag a tab onto the row to add it; right-click to remove. *(2026-10-24:)* A tile whose tab makes sound wears a small speaker on its corner (`volume-x` while muted); its row mutes it. |
| Today divider | 24 | Hairline + "Clear" (`text-micro`), which appears on hover or focus and archives all Today tabs. |
| New tab | 32 | "+ New tab", muted. Same as ⌘T. |
| Today | 32 / row | New tabs arrive at the top. |
| (flex) | — | Toasts stack here, above the footer. |
| Presenting | 44 | *(Built 2026-10-24, §7.13.)* Only while presenting mode is on, with Turn off. |
| Now playing | 36 or 84, + 28 a row | *(Built 2026-10-24, §7.10.)* Only for media you left playing (or played from the card) in a tab the window isn't showing, or paused there in the last minute. More than one: a row each for up to two more. |
| Extensions shelf | 32 | Only when the chord's profile has extensions: pinned extensions' buttons (16 px icons in 28 px hit areas, with badges and tooltips), then the puzzle piece, which lists every extension with a pin toggle. A popup opens beside its button. Hidden when Settings puts extension buttons in the title bar. Right-click a button: the extension's items, Options, Unpin, Remove (with Undo), Manage in Settings. |
| Footer | 44 | Archive · Downloads on the left; chord switcher in the center (icons 20 px; active one in a pill; scrolls with fade edges past ~6); + New chord on the right. |

### 3.3 Sidebar collapsed: minimal mode

Every sidebar feature folds away. What remains is one 40 px bar with the basics, like Dia, so the browser all but disappears.

```
macOS
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  ◧  ‹ › ⟳   youtube.com / I Can't Believe What I Saw in Paris…    ◫ Duet │ ← 40 px bar, chord-tinted
│ ╭──────────────────────────────────────────────────────────────────────────╮ │
│ │                                web page                                  │ │
Windows / Linux
│ ◧  ‹ › ⟳   youtube.com / I Can't Believe What I Saw in Paris…   ◫ Duet   ─ ▢ ✕ │
│ ╭──────────────────────────────────────────────────────────────────────────╮ │
```

| Element (left → right) | Behavior |
|---|---|
| Sidebar toggle ◧ | Click or the toggle shortcut (§13) docks the sidebar again. Hovering the toggle for 300 ms, or pointing at the left window edge, *peeks* the sidebar over the page without docking it. *(Built 2026-10-25:)* Settings → Appearance → *Show the sidebar when you point at the window's edge* turns both on. It's off by default (the maintainer's call, 2026-10-25): then only a click or the shortcut brings the sidebar back. |
| Back · Forward · Reload | As in the sidebar header. Unavailable buttons sit at 40% opacity rather than disappearing, so nothing shifts. |
| Address field | `domain / title`: domain in `fg`, the slash and title in `fg-muted`, one line, truncated at the end. Click or ⌘L and the field *grows into* the command bar in place (shared-element morph), with the URL selected. Hover shows the site-info icon. |
| Speaker | *(Built 2026-10-24.)* Only while the tab on screen makes sound: the row's speaker (§7.2), which the hidden sidebar can't show. Click mutes or unmutes the tab. |
| Presenting | *(Built 2026-10-24.)* Only while presenting mode is on: a chip that turns it off (§7.13), standing in for the sidebar's card. |
| Reader view | *(Built 2026-10-24.)* Only while the page reads as an article, or shows in reader view: a book, pressed while it's open (§7.11). It sits right after the address, before the speaker; the Windows and Linux top strip has it there too with the sidebar docked. |
| Effects | *(Built 2026-10-25.)* Only while the site has Effects: their button (§7.15), raised while they're wet. It sits after reader view's book. |
| Drag region | Everything not interactive drags the window. Double-click follows the platform (maximize on Windows/Linux; the macOS title-bar preference). |
| Downloads | Present only while a download is active or just finished. |
| Extension actions | Only the puzzle piece, which lists every extension, so popups stay one click away while the header stays clean. With Settings → Extensions → "Show extension buttons: In the title bar", the pinned buttons sit here too: before ⋯ on Windows/Linux, and in the sidebar's header row on macOS (its title bar) while the sidebar is docked. |
| Duet | Duet's icon (two speech bubbles, `◫` in the diagrams) and the word *Duet*, when Duet is enabled; absent otherwise. The same icon marks Duet everywhere: Settings, the command bar, and tabs Duet read. ✦ stays Chord's own mark and the first chord's icon. |
| Window controls | Windows/Linux caption buttons (WCO). On macOS the traffic lights sit at the far left instead. |

- **The peek is the sidebar itself.** *(Built 2026-10-25, reworked the same day.)* It slides in over the page exactly where it sits when docked, full height, with its header row (toggle, back, forward, reload) and URL pill. Those land exactly over the bar's own, which sit where the sidebar header had them, so nothing shows twice. It wears the window's tint (sized to the window, so it runs on into the bar) and grain on a solid surface, since over the page nothing shows through it, with `shadow-popover` along its edge. It never docks on hover, which would resize the page whenever the pointer brushed the edge; clicking its ◧ docks it. *(Before the rework it floated on a card below the bar, without the header and the URL pill; the maintainer preferred the real sidebar.)*
- **The bar carries the chord's tint and grain** (same generator), so you always know which chord you're in without one extra element.
- Horizontal swipes on the bar switch chords exactly as on the sidebar: the tint crossfades and the address field updates.
- **Nothing becomes unreachable when collapsed:**
  - Tabs, pinned tabs, chords, the archive, and actions are all in the command bar (⌘T).
  - Chords also respond to ⌘1–9 and to swiping the bar.
  - Ctrl+Tab cycles recently used tabs.
  - Undo toasts appear at the frame's bottom-left.
- **The content frame keeps its 4 px bezel and rounded corners.** It's the one piece of identity that never folds away.
- In OS fullscreen the bar slides away too and returns when you point at the top edge.
- Collapsed or docked is remembered per window.

### 3.4 More windows, and private windows

- **⌘N** opens a window on the chord you're in, cascaded from the one you were in, with the command bar open. Every window lists the chord's tabs, and each shows its own. A tab shows in one window at a time: clicking one that another window is showing brings it to you, and that window goes back to the tab it used before.
- **⌘⇧N** opens a private window. It has a single chord of its own, named "Private" and marked with an eye-off glyph where the chord's icon goes. Its colors are quiet graphite, always dark, whatever the color scheme.
  - Its switcher shows only that chord. There's no New chord, no Archive button, no Pinned section, and no extensions shelf.
  - Its empty state says: "This window is private. Chord won't remember the sites you visit in this window. Files you download are kept."
  - Closing it forgets everything at once, with no confirmation.

---

## 4. Tokens

### 4.1 Architecture and enforcement

```
packages/tokens/src/
  primitives.ts    raw scales (spacing, radii, neutral ramp, type sizes, springs)
  semantic.ts      roles: color.sidebar.fg, radius.row, motion.overlay, …
  platform.ts      per-OS overrides (radius.frame, size.strip, font smoothing)
  theme.ts         createChordTheme(): user input → semantic color roles (§5)
build → tokens.css  :root, [data-platform], [data-appearance] custom properties
       tokens.ts    typed exports for JS-driven motion and canvas drawing
       docs/tokens.md  generated reference table
```

- **Three tiers.** *Primitives* are never used in components. *Semantic* roles are what components use. *Component* tokens exist only when a component genuinely needs its own knob.
- **Styling** is CSS Modules plus custom properties. No runtime CSS-in-JS on hot paths.
- **Lint.** stylelint 17 built-ins, with `overrides` exempting `packages/tokens`:
  - `color-no-hex`
  - `color-named: never`
  - `function-disallowed-list` (rgb, hsl, oklch)
  - `unit-disallowed-list: ["px", "ms", "s"]`
  - `declaration-property-value-allowed-list` for shadows and z-index
- A custom ESLint rule `chord/no-raw-motion` rejects numeric literals in Motion `transition` props; they must come from `motion.*` tokens.
- Debug builds have a **4 px grid overlay** toggle (⌘⌥G).

### 4.2 Typography

**Typeface: Onest** (SIL OFL, variable weight 100–900, has tabular figures).

Why Onest:
- It's warm and slightly playful without being childish, and its large x-height (0.527 em) reads well at the 12–13 px sizes the sidebar lives at.
- It's actively maintained and covers Latin and Cyrillic.
- It doesn't carry another product's identity the way Inter or Geist now do.
- Runner-up: Geist (x-height 0.530).

Bundling: one variable `woff2`, preloaded. `font-display: block` is safe because the font is local, so there's no flash. Page titles in other scripts fall back to the system UI font automatically.

| Token | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|
| `text-micro` | 11 / 16 | 500 | +0.01 em | keycaps, badges, the divider's "Clear", footer labels |
| `text-small` | 12 / 16 | 450 | 0 | secondary lines, toasts, URLs in results |
| `text-body` | 13 / 20 | 450 | 0 | sidebar rows, menus, settings, Duet messages |
| `text-label` | 13 / 20 | 600 | 0 | Chord name, buttons, active row |
| `text-title` | 15 / 20 | 600 | −0.005 em | dialog and card titles, preview titles |
| `text-input` | 18 / 24 | 450 | −0.01 em | command bar input |
| `text-heading` | 24 / 32 | 600 | −0.015 em | onboarding steps, empty-state titles |
| `text-display` | 36 / 44 | 650 | −0.02 em | first-run welcome only |

- Numbers that change (counts, times, download progress) use `font-variant-numeric: tabular-nums`.
- Weights 450 and 650 rely on the variable axis; they render crisper than 400 and 700 on Windows' grayscale antialiasing.

**Reading scale** (reader view, §7.11; `packages/tokens/src/reader.ts`): six body sizes, 15, 17, 19, 21, 24 and 28 px (19 to start, between Safari's and Firefox's). Each has its title (1.75×, 650), h2 (1.35×, 650), h3 (1.15×, 600), h4 (600), body (450), captions (0.85×) and code (0.9×), every line height on the 4 px grid (about 1.6× for body text), and a paragraph gap of about one em. Line widths, in ems of the body: narrow 30, medium 36, wide 44 (about 60, 70 and 85 characters). Fonts: Onest, or the computer's reading serif (Charter on macOS, Sitka on Windows, the desktop's serif on Linux), so no second typeface ships; code in the computer's monospace.

### 4.3 Spacing and sizing (4 px grid)

| Spacing | `space-1` | `space-2` | `space-3` | `space-4` | `space-5` | `space-6` | `space-8` | `space-10` | `space-12` | `space-16` |
|---|---|---|---|---|---|---|---|---|---|---|
| px | 4 | 8 | 12 | 16 | 20 | 24 | 32 | 40 | 48 | 64 |

| Size token | Value | Size token | Value |
|---|---|---|---|
| `size-row` | 32 | `size-icon-sm` / `size-icon` / `size-icon-lg` | 12 / 16 / 20 |
| `size-header` | 40 | `size-favicon` | 16 |
| `size-hit-min` | 24 (WCAG 2.2 AA target size) | `size-chord-icon` | 20 |
| `sidebar-width` | 248 (200–400) | `duet-width` | 380 (320–560) |
| `frame-inset` | 4 | `strip-height` (Win/Linux) | 40 |
| `command-bar-width` | clamp(480, 56% of frame, 680) | `preview-width` | 280 |

Only borders and focus rings may be off-grid (1 px and 2 px). Text is vertically centered in rows by layout, never by off-grid padding.

### 4.4 Radius, elevation, layers

**Radius:** `radius-xs` 4 · `radius-sm` 8 · `radius-md` 12 · `radius-lg` 16 · `radius-full`.
- **Concentric rule:** an inner radius equals the outer radius minus the padding, with a minimum of 4. Example: command bar 16 with 8 padding gives rows of 8.
- **`radius-frame` per platform:** macOS 12 (pairs with macOS 26's larger window corners) · Windows 8 (matches Windows 11 window corners) · Linux 12. To be tuned from screenshots.

| Elevation | Light | Dark | Used by |
|---|---|---|---|
| `shadow-raised` | `0 1px 2px oklch(0 0 0 / .08), 0 0 0 1px oklch(0 0 0 / .04)` | `0 1px 2px oklch(0 0 0 / .4), inset 0 0 0 1px oklch(1 0 0 / .06)` | active tab pill, keycaps |
| `shadow-frame` | `0 0 0 1px oklch(0 0 0 / .06), 0 2px 6px oklch(0 0 0 / .06), 0 12px 32px -12px oklch(0 0 0 / .16)` | `0 0 0 1px oklch(1 0 0 / .07), 0 12px 32px -12px oklch(0 0 0 / .6)` | content frame, Duet panel, split panes |
| `shadow-lift` | `0 8px 20px -6px oklch(0 0 0 / .22)` | `0 8px 20px -6px oklch(0 0 0 / .6)` | a row being dragged |
| `shadow-popover` | `0 12px 32px -8px oklch(0 0 0 / .22), 0 0 0 1px oklch(0 0 0 / .06)` | `… / .6`, hairline `oklch(1 0 0 / .08)` | hover previews, toasts |
| `shadow-card` | `0 4px 10px -3px oklch(0 0 0 / .24), 0 0 0 1px oklch(0 0 0 / .06)` | `… / .6`, hairline `oklch(1 0 0 / .08)` | the popover's cards (find, permissions, sign-in, screen sharing): their view is sized to them with `space-3` around, which the shadow stays inside, since a bigger view would take the page's clicks |
| `shadow-modal` | `0 24px 64px -16px oklch(0 0 0 / .32), 0 0 0 1px oklch(0 0 0 / .06)` | `… / .7` | command bar, Peek |

**Layers (inside one view):** `z-base` 0 · `z-raised` 1 · `z-sticky` 10 · `z-drag` 20 · `z-popover` 30 · `z-toast` 40 · `z-modal` 50. Stacking *across* views (shell, tabs, popover, overlay) is set in ARCHITECTURE.md §5, not by z-index.

### 4.5 Neutrals and roles

The neutral ramp is OKLCH with a whisper of the chord hue (chroma 0.006), so grays harmonize with each theme. Lightness steps:

| step | 0 | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 850 | 900 | 950 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L | .995 | .975 | .955 | .92 | .86 | .74 | .62 | .52 | .42 | .32 | .27 | .22 | .17 |

**Semantic color roles** (every one is generated per chord, §5):
- `fg`, `fg-muted`, `fg-subtle`
- `item-hover`, `item-active-bg`, `item-active-fg`
- `divider`
- `accent`, `accent-fg`
- `focus-ring` (the OS accent)
- `surface` (frames, Duet), `surface-raised` (command bar, toasts, previews), `scrim`
- `danger`, `warning`, `success` (used sparingly: download failed, permission blocked, update ready)

### 4.6 Icons and favicons

- **Icons:** Lucide (ISC). 16 px at stroke 1.75 in rows, 20 px at stroke 1.5 in the footer. Active state = `fg` color plus filled variants where Lucide provides them; never color alone. Icon-only buttons always carry `aria-label` and a tooltip after 600 ms.
- **Chord icons** are user content: emoji (platform emoji font), a curated set of 48 Lucide symbols, or a single letter.
- **Favicons** are first-class. Exact fallback rules are in §7.4.

---

## 5. Chord themes

### 5.1 What the user picks

```ts
type ChordTheme = {
  stops: Oklch[];           // 1–3 colors chosen on the wheel or from swatches
  grain: number;            // 0–1, default 0.2
  appearance: 'light' | 'dark' | 'auto';   // auto follows the OS
};
```

**Curated swatches**, each defined at display lightness L 0.72:

| Coral | Tangerine | Honey | Moss | Mint | Lagoon | Sky | Periwinkle | Lilac | Orchid | Rose | Graphite |
|---|---|---|---|---|---|---|---|---|---|---|---|
| H 30 · C .14 | 55 · .15 | 85 · .13 | 130 · .11 | 165 · .10 | 200 · .10 | 235 · .11 | 270 · .12 | 300 · .12 | 330 · .13 | 5 · .13 | 260 · .015 |

**Gradient presets:** *Dusk* (Lilac → Coral; Chord's signature) · *Sea Glass* (Mint → Sky) · *Citrus* (Honey → Tangerine) · *Aurora* (Mint → Periwinkle → Orchid) · *Ember* (Rose → Tangerine) · *Fog* (Graphite → Periwinkle).

**First chord default:** the OS accent color's hue, available on all three platforms. Chord ships the *Dusk* preset as a fallback if the accent can't be read.

**New chords** take the first gradient preset and icon that no other chord uses yet. The icons are ✦ ♪ ♫ ♩ ♬ ◆ ● ▲ ★, a nod to the name. The new chord opens empty, with its name selected so typing renames it. In the switcher, each chord's icon wears that chord's own accent, so the footer previews every chord's color.

**Custom icons:** click the icon in the chord header (or right-click a chord → *Change icon…*). The picker drops down inside the sidebar with:

- a field for any emoji or letter (the OS emoji panel works there: Win + . or ⌃⌘Space)
- 24 symbols
- 24 emoji

Only the first character counts (an emoji with its modifiers is one), and letters are capitalized.

### 5.2 `createChordTheme()` — a pure, tested function

1. **Resolve the appearance.** `auto` follows `nativeTheme`.
2. **Map stops into the appearance's band** so any pick looks calm:
   - Light: `L = 0.94 − 0.5·C`, `C = 0.7·min(C, 0.16)` (0.8 looked loud in the token preview)
   - Dark: `L = 0.26 + 0.4·C`, `C = 0.7·min(C, 0.16)`
3. **Geometry:**
   - 1 stop: a flat tint.
   - 2 stops: linear 160°.
   - 3 stops: a linear 160° base (stop 1 → stop 3) plus a soft radial of stop 2 at (30%, 60%), 70% size.
4. **Material composition.** The tint group sits over the OS material at alpha 0.72 (light) or 0.80 (dark). With no material (Linux, Windows 10, *Reduce transparency*), it composites over neutral 50 (light) or 900 (dark) and becomes opaque.
5. **Text colors:**
   - `fg` = L 0.24 / C 0.02 at the mean hue (light), or L 0.96 / C 0.01 (dark).
   - `fg-muted` = L 0.42 (light) or L 0.78 (dark).
6. **Contrast guard.**
   - Sample the composited gradient at 9 points, assuming worst-case material (light material as L 0.90, dark as L 0.28).
   - `fg` and `fg-muted` must each reach **≥ 4.5:1** at every sample.
   - If not, nudge the tint lightness away from the text by 0.01 per step (max 15 steps), then reduce chroma.
   - *As built (M1.6):* `fg-muted` and `fg-subtle` are text too (descriptions, keycaps, hints). Each moves away from its grounds until it reaches ≥ 4.5:1 on all of them: the tint's samples, `surface`, `surface-raised`, and each of those under an `item-hover` fill.
   - Unit tests run this over 10,000 random inputs.
7. **Accent.** The most chromatic stop at L 0.58 (light) or 0.76 (dark), `C = min(0.16, 1.2·C)`. It must reach ≥ 3:1 against `surface` (non-text contrast). Used for the selected command bar row, loading progress, Duet's send button, and split focus rings.
   - *As built (M1.6):* the accent is also text (Undo in a toast, links), so it reaches ≥ 4.5:1 on both surfaces, with and without a hover fill, and ≥ 3:1 over every sample of the tint.
   - **Focus ring:** the OS accent (or the chord's accent when the OS has none), with its lightness moved until it reaches ≥ 3:1 against the tint, both surfaces, hover fills and the active row's pill. It's the theme's `--color-focus-ring`.
   - **Fallback favicons** (§7.4): when neither white nor ink reaches 4.5:1 on a site's square, the square moves away from the letter until it does.
8. **Interaction roles:**
   - `item-hover` = `fg` at 6% (light) / 7% (dark).
   - `item-active-bg` = white at 78% plus `shadow-raised` (light), or white at 10% plus an inset hairline (dark).
   - `divider` = `fg` at 10%.
9. **Grain.** A pre-rendered 256 px tile of soft fractal value-noise at low contrast (deterministic, from `scripts/generate-grain.mjs`; no runtime `feTurbulence`), applied with `soft-light` *inside* the isolated tint group so it never blends with the desktop. Per-pixel static reads as dirt, not paper. Opacity = `grain × 0.20` (light) or `grain × 0.28` (dark).

### 5.3 Theme crossfade

- Each chord's sidebar content carries its own theme variables.
- The fixed chrome (header, URL pill, footer) gets `fg` interpolated in OKLCH each frame: one style write.
- The tint itself is **two stacked tint groups** whose opacities crossfade. Compositor-only; no gradient repaint per frame.

---

## 6. Motion

### 6.1 Rules

1. **Springs for anything spatial** (position, size, scale). Short fades only for opacity and color. Never linear, never bare `ease`.
2. **Interruptible always.** A new input retargets the running spring from its current position *and velocity*.
3. **Only transform and opacity** animate in the shell UI. No animated `width`/`height`/`top`; layout changes use FLIP (Motion `layout`). `filter` and `backdrop-filter` never animate.
4. **Web content never animates per frame.** Frame size changes use the snapshot technique (ARCHITECTURE.md §5).
5. **Typing never animates.** Command bar results swap instantly.
6. **Exits are quicker than entrances**: about 0.75× the entrance duration, or `fade-fast`.
7. **Stagger** is at most 12 ms per item, for at most 6 items; beyond that everything moves together.
8. **Under 400 ms.** No functional animation takes longer to *visually arrive* (t90). Decorative onboarding moments are the only exception.

### 6.2 Springs

Values are for Motion's `{type: 'spring', stiffness, damping, mass}`, mass 1. The t90, settle, and overshoot columns were **simulated numerically** (dt 0.5 ms, unit step), not estimated.

| Token | Stiffness | Damping | ζ | Overshoot | t90 | Settles (±0.5%) | Used for |
|---|---|---|---|---|---|---|---|
| `press` | 1500 | 74 | 0.96 | 0% | 95 ms | 172 ms | press-down scale (0.97), toggles, checkbox ticks |
| `snappy` | 700 | 50 | 0.94 | 0% | 137 ms | 243 ms | active-tab pill glide, folder chevron, hover-card reposition, sidebar slide-in (hidden mode) |
| `overlay` | 600 | 42 | 0.86 | 0.5% | 132 ms | 196 ms | command bar, Peek, toasts, Duet panel enter |
| `smooth` | 450 | 38 | 0.90 | 0.2% | 160 ms | 256 ms | list reflow, reorder make-room, folder expand/collapse, split resize settle |
| `bouncy` | 500 | 30 | 0.67 | 5.7% | 114 ms | 305 ms | **arrivals**: a drop settling, pin landing, new chord icon, archive "gulp" |
| `release` | 360 | 34 | 0.90 | 0.2% | 179 ms | 287 ms | gesture release (chord swipe, sidebar resize); seeded with gesture velocity |
| `gentle` | 260 | 31 | 0.96 | 0% | 230 ms | 417 ms | theme crossfade, scrims, empty-state illustrations |
| `playful` | 220 | 14 | 0.47 | 18.5% | 140 ms | 769 ms | **decorative only**: logo strike, onboarding flourishes, "Surprise me" dice. Never on functional UI. |

The tokens package also emits each spring as a CSS `linear()` easing plus duration. Simple hover and press transitions get spring feel with zero JavaScript.

### 6.3 Fades and timing

| Token | Value | Use |
|---|---|---|
| `fade-fast` | 90 ms, `cubic-bezier(.2,0,0,1)` | hover backgrounds, close-button reveal, exits |
| `fade-base` | 140 ms | tooltips, scrim in, crossfades |
| `fade-slow` | 220 ms | empty-state copy, onboarding text |
| `delay-hover-intent` | 500 ms | hover previews |
| `delay-tooltip` | 600 ms (0 ms while another tooltip is open: "warm" mode) | tooltips |
| `delay-spring-load` | 600 ms | a folder opens while you drag over it |
| `toast-duration` | 6 s, paused on hover or focus | undo toasts |

The command bar scrim is `oklch(0 0 0 / .18)` light and `oklch(0 0 0 / .36)` dark. Electron views can't blur another view's pixels by default. If spike S4 shows `View.setBackgroundBlur` works over a tab view, the command bar surface becomes 85% opaque with a 24 px blur. Otherwise it stays opaque. No fake blur.

### 6.4 Chord swipe (follows the trackpad 1:1)

| Phase | Behavior |
|---|---|
| **Engage** | Two-finger horizontal scroll over the sidebar once `|dx| > 8 px` and `|dx| > 1.5·|dy|` (axis lock). Vertical list scrolling is unaffected. |
| **Track** | The chord's content panel (header, pinned, Today) moves exactly with the fingers, following the OS natural-scroll direction. The neighbor chord slides in beside it. Tint crossfade progress `p = |offset| / sidebarWidth`. The footer's switcher pill travels proportionally. |
| **Edges** | Rubber band at the first and last chord: `shown = (1 − 1/(x·0.55/d + 1))·d`, with `d` = sidebar width. |
| **Release** | On `gestureScrollEnd` or `gestureFlingStart` from the shell view's `input-event` stream (fallback: 80 ms without wheel events). Commit if `p > 0.5` or velocity > 0.5 px/ms toward the neighbor; otherwise spring back. Uses the `release` spring seeded with the gesture's velocity. |
| **Content** | The page swaps to the target chord's active tab **at the moment of commit**, in one frame. Pages never slide; they are too heavy to move per frame (§6.1 rule 4). |
| **Interrupt** | A new swipe during the settle catches the panel where it is. Velocity carries over, so it never jumps back to zero. |
| **Keyboard / click** | ⌘1–9 or a switcher click plays the same transition with the `release` spring from rest. Jumping more than one chord does not slide past the in-between ones: it crossfades with a 24 px drift. |

*As built* (`shell/swipe.ts`, `shell/useChordSwipe.ts`):
- **Interrupt:** a swipe that starts during a spring-back catches the pane where it is, with its velocity. During a commit's settle (about 300 ms), new input waits.
- **Momentum:** what arrives after a release is ignored until it pauses for 120 ms, or the OS reports a new gesture.
- **Flick back:** a release past half the width that is flicked back faster than 0.5 px/ms springs back instead of committing.
- **Mouse tilt wheel or Shift+wheel:** line-based deltas, or a first step of 50 px or more, switch one chord per notch with the usual slide. Repeats while held are ignored.
- **Switcher pill:** it moves at the commit, not proportionally while tracking.

### 6.5 Choreography of the key moments

| Moment | Motion (distinct for each, so close ≠ archive ≠ pin) |
|---|---|
| **Hover a row** | Background fades in (`fade-fast`); the close × fades in at the right. |
| **Activate a tab** | The active pill *glides* from the old row to the new one (shared `layoutId`, `snappy`). If the rows are more than 400 px apart, or in different sections, it crossfades instead. |
| **Close** | Row content drifts 8 px left and fades (`fade-fast`); the row's height collapses (`smooth`); rows below close the gap. |
| **Archive** (auto or Clear) | The row shrinks to 0.92 and fades. A favicon ghost arcs toward the footer's Archive button (`bouncy`, 280 ms), and the Archive button does a small gulp (scale 1 → 1.12 → 1, `bouncy`). For more than one tab, ghosts stagger 12 ms each, up to 6. |
| **Pin** | The row lifts (`shadow-lift`), travels into its pinned slot, and lands with `bouncy` (~6% overshoot). The pinned section blooms with a brief accent tint (`fade-slow`). |
| **Drag pick-up** | Scale 1.03 plus `shadow-lift` (`snappy`). Other rows make room live (`smooth`). Hovering a closed folder for 600 ms opens it (chevron rotates, `snappy`). |
| **Drop** | The row settles into its slot with `bouncy`, and the shadow fades. Cancel (Esc) flies it home with `smooth`. |
| **Folder open/close** | Chevron rotates 90° (`snappy`). Children reveal via height (`smooth`) with a 12 ms stagger fade. The folder glyph crossfades between closed and open. |
| **Toast** | Enters by sliding up 12 px and fading in (`overlay`); leaves with `fade-fast` and a 6 px drop. Up to 3 stack like a deck (older ones scale to 0.96, offset −6 px). |
| **Command bar** | Scrim fades in (`fade-base`). The panel goes from scale 0.97, y −8 to rest, opacity 0 → 1 (`overlay`). On Enter it fades out in `fade-fast` *while* navigation starts. |
| **New chord** | The switcher icon pops from 0.6 → 1 (`bouncy`), the sidebar slides to the new chord, and the empty-state art blooms in (`gentle`). |
| **Collapse sidebar** | The sidebar slides out to the left (`snappy`). Back/forward/reload and the URL pill glide up into the bar (shared layout), and the pill morphs into the address field. The page frame widens using the snapshot technique (`smooth`). Docking reverses every piece.<br>*As built:* the page's picture glides on `smooth` (ARCHITECTURE.md §5, *The frame snapshot*) while the sidebar slides 24 px left and fades, on `smooth` rather than `snappy`; docking reverses it. On Windows and Linux the bar's back/forward/reload sit exactly where the sidebar header had them, so they stay put: the header's slide away with the sidebar while the bar's fade in. ⚠ *Not yet:* on macOS they don't glide from the header's right end into the bar (they fade in there), and the URL pill doesn't morph into the bar's address field. |
| **Sidebar peek** (collapsed) | The sidebar slides in *over* the page with `shadow-popover` (`snappy`) and slides away 300 ms after the pointer leaves. The page doesn't move. |
| **Edit the address (⌘L)** | The URL pill (or, in minimal mode, the bar's address field) becomes the input where it sits: its text and position stay put while the results panel grows down beneath it (`overlay`). With *Animate into the command bar* off (§6.8), it appears instantly. |
| **Duet panel** | The panel slides in from the right with `overlay`. The page's frame narrows through the snapshot technique: the bitmap scales over one `smooth` spring, then the real view is placed once. *As built:* closing slides it out in `fade-base` (exits are quicker) while the frame widens the same way, and the keyboard leaves the panel as it starts to go. A panel already open when the window opens is just there. |

*As built* (`shell/ArchiveArc.tsx`, `shell/today-motion.ts`):
- **Archive:** only rows that were on screen animate. A flight is a copy of the row's own icon, flown by the compositor; at most 6, 12 ms apart. Main says which tabs it's archiving just before the patch that removes them (`sidebar:archived`), so an archived row never leaves like a closed one. With reduced motion, rows go at once and the Archive button's highlight fades over 90 ms.
- **Close** drifts 8 px left and fades (`fade-fast`); **pin** lifts 8 px toward Pinned and fades, and the row lands in Pinned with `bouncy`. Rows arriving together start 12 ms apart, up to 6.

### 6.6 Reduced motion

`MotionConfig reducedMotion="user"` is set at the root. Motion's default is `"never"`, so this has to be explicit. When the OS asks for reduced motion, Motion disables transform and layout animations and keeps opacity and color. On top of that:

| Normally | With reduced motion |
|---|---|
| Spatial springs (pill glide, reorder, pin flight, archive arc) | Instant position change plus a 90 ms highlight fade on the destination |
| Chord swipe | Still tracks the fingers 1:1 (direct manipulation is fine). On release it crossfades over 120 ms instead of springing. Keyboard switches crossfade. |
| Command bar, Peek, toasts | Opacity only, `fade-base` |
| Theme crossfade | 120 ms opacity |
| `playful` and `bouncy` flourishes | Off |
| Loading spinner | A static loading dot that pulses opacity slowly (no rotation) |

### 6.7 Performance rules

- Keep under 50 nodes animating at once. Layout animations are skipped for rows outside the viewport.
- The Today list virtualizes beyond 150 rows; reorder animations apply only to mounted rows.
- `will-change: transform` is set only during an animation, never at rest.
- Every interaction in §6.5 has a scripted trace test. Long Animation Frames over 8 ms (120 Hz) or 16 ms (60 Hz) fail locally on reference hardware.
- Input never waits for motion: a field is focused and typeable on the first frame of its entrance animation.
- **One render a frame.** Updates from main (state patches, Duet's, the extension bar's) render the shell once a frame however many arrive in it, and a key or click first renders whatever is waiting (ARCHITECTURE.md §6.2).
- **Web content moves at most twice per frame-size change** (out of sight at its new size, then into place), never per frame; the perf spec counts it.

*As built* (`shell/virtual.ts`, `shell/today-motion.ts`, `shell/Tabs.tsx`):
- **The window.** Above 150 rows, Today mounts the rows in view and 3 more past each edge; spacers stand in for the rest, so the scrollbar is true. The rows past the edges come a frame after the list mounts (a chord switch), since they don't show.
- **Always mounted,** wherever they are: the tab on screen (its pill glides from there, and it's the trees' Tab stop), a row being dragged, a row picked up with Space, and the row with the keyboard (or about to get it).
- **Rows aren't Motion components,** in Pinned or Today: mounting one costs about as much as the rest of the row. The lists animate their rows with the Web Animations API, from their indices (every row is 32 px), so nothing is measured. Only rows near the viewport animate. A second move before the first settles adds onto it, so the row carries on from where it is. The active pill is still a Motion `layoutId`.
- **Drag and drop** (dnd-kit) is set up only for rows on screen, a frame after they mount: a drag starting measures every one. While a row is dragged, dnd-kit moves the rows. Drags keep global indices, scroll at the list's edges, and land among rows that weren't mounted when they began.
- **Leaving.** A row that leaves its list animates out in its own element, put back where it was; rows that scroll out of the window just go.
- **The keyboard** walks the trees in state order, not the DOM's, and scrolls a row into view (mounting it) before focusing it.

### 6.8 Motion settings

Speed beats animation. Settings → Motion lets people switch off each larger animation. Switched off means **instant** (no animation is created at all), not shortened.

| Setting | Default | Covers |
|---|---|---|
| Follow system motion settings | On | Everything in §6.6 |
| Animate into the command bar | On | The ⌘L address morph and the ⌘T panel entrance |
| Slide between chords | On | The chord switch. A trackpad swipe still follows your fingers; release just snaps. |
| Animate tab moves | On | Pin flight, archive arc, reorder make-room, drop settle, close collapse |
| Animate the sidebar | On | Collapse and dock, peek slide-in, folder open and close, Duet's panel opening and closing, and the Now playing card coming and going. Off, docking, collapsing and Duet take no frame snapshot at all. |
| Blend chord colors | On | The theme crossfade when switching chords |

- **Every setting in Chord, not only motion,** shows a ↺ button beside its label when it differs from the default; clicking it restores the default.
- **Implementation:** one `motion(name)` helper resolves the OS preference, the user's switch and the spring token to either a spring or *instant*. Components never read settings themselves. Switches take effect immediately, with no restart.
- **Rule:** a new animation ships with its switch, or belongs to one above.

---

## 7. Components

### 7.1 Inventory

| Area | Components |
|---|---|
| Window | `WindowShell`, `TrafficLightInset` (macOS), `TopStrip` (Win/Linux, WCO-aware), `MinimalBar` (`SidebarToggle`, `AddressField`; §3.3), `ReaderButton` (§7.11), `EffectsButton` (§7.15), `ContentFrame` (placeholder + shadow + loading bar), `DevtoolsFrame` (header, edge; §7.16), `DuetFrame` |
| Sidebar | `SidebarHeader`, `NavButtons`, `UrlPill`, `ChordHeader`, `SortableTree` (wraps @dnd-kit/react), `TabRow`, `FolderRow`, `SplitRow`, `TodayDivider`, `NewTabRow`, `ExtensionsShelf` (`ExtensionButton` with badge, `PuzzleButton`, "Add to Chord" on Web Store pages), `PresentingCard` (§7.13), `NowPlayingCard` (§7.10), `SidebarFooter`, `ChordSwitcher`, `SidebarResizeHandle` |
| Overlays | `CommandBar` (`CommandInput`, `ResultSection`, `ResultRow`, `HintBar`), `PeekCard`, `SplitDropZones`, `FindBar`, `CaptureLayer` (§7.12) |
| Popovers | `HoverPreview` (tab and folder variants), `PermissionPrompt`, `ShareCard` (the share picker: a tab, a window or a screen, §7.13), `EffectsCard` (a site's Effects, §7.15), `DownloadsPopover`, `ExtensionsList` (the puzzle piece's list), `ExtensionPopup` (an extension's own page, sized to it) |
| Feedback | `Toast` + `ToastStack`, `Tooltip`, `LoadingBar`, `Spinner`, `EmptyState`, `SafeBrowsingWarning` (§9), and in the popover the one-time `SafeBrowsingOffer`, the `PasskeyCard` (when a security key holds several passkeys for a site: a fingerprint glyph, *Sign in to [site] with a passkey*, a button per account with the site's display name over its account name, the first one focused, and Cancel; Escape declines), the `DrmNotice` (on a service that needs Widevine: a screen-and-play glyph, *[Service] won’t play in Chord yet*, why in a line, Chord Player first when it's offered (§7.14: its own full-width row, primary), then *Open in [browser]* for up to two other browsers on the computer, the likeliest primary when Chord Player isn't offered; × is Not now, until Chord quits) and the `AuthCard` sign-in box (a site or proxy asking for a username and password: a key, *Sign in to* the origin, the site's realm as a quote, *That username and password didn't work* in `danger` after a failed try, a warning on plain HTTP, two fields, *Cancel* · **Sign in**; Escape cancels) |
| Settings and help | `SettingRow` (label, control, and a ↺ reset button shown only when the value differs from its default), `ShortcutSheet` (the cheat sheet, generated from the shortcut registry) |
| Theme | `ThemePicker` (`ColorWheel`, `SwatchRow`, `PresetRow`, `GrainSlider`, `AppearanceSegmented`, `SurpriseButton`), `ChordIconPicker` |
| Duet | `DuetPanel`, `ThreadHeader` (title, provider/model chip, thread menu), `MessageList`, `AssistantMessage` (with `CitationPill`), `ToolActivityRow`, `ApprovalCard`, `Composer` (`ContextChips`, input, send), `DuetSetup` |
| Pages | `SettingsPage`, `ArchivePage`, `RecentlyDeleted`, `ReaderView` (`ReaderBar`, `TextControls`, `ArticleContent`; §7.11) |
| Primitives (`packages/ui`) | `Button` (primary, secondary, ghost, danger), `IconButton`, `Keycap`, `Toggle`, `Segmented`, `Slider`, `TextField`, `Favicon`, `ChordIcon`, `Menu` (wraps native menus) |

### 7.2 `TabRow`

**Anatomy:** `[favicon 16] [title, one line, ellipsis] [count?] [audio 16?] [close × or ↩ on hover]`. Height 32, padding 0 `space-2`, radius `radius-sm`, gap `space-2`.

| State | Treatment |
|---|---|
| Default | `fg`; title `text-body` |
| Hover | `item-hover` background; close × visible |
| Active | `item-active-bg` + `shadow-raised`; title `text-label` |
| Focus-visible | 2 px `focus-ring`, inset 2 px |
| Loading | Favicon replaced by a 16 px spinner ring (accent, 1.5 px stroke) |
| Audible / muted | Speaker icon; click toggles mute |
| Popped out (PiP) | PiP glyph (`picture-in-picture`, *Back to the tab*) in place of the speaker; click brings the tab on screen and the video home |
| Unloaded (pinned, not opened yet) | Normal favicon; title `fg-muted` |
| Navigated away (pinned) | Shows the current page's title. Hover shows ↩ *Back to pinned page* in place of ×; ⌘-click on ↩ opens the current page as a Today tab. |
| Sleeping | Favicon at 70% opacity |
| Count (*built 2026-10-25*) | The number the page gives itself (unread messages, the web's app badge), after the title: a 16 px `accent` pill, `text-glyph` in `accent-fg`, "99+" past 99; a 8 px `accent` dot when it gives no number. Screen readers hear it as the row's description ("3 unread"). |
| Crashed | Favicon replaced by `circle-alert` in `warning` |
| Sharing | *(2026-10-24)* Stop sharing (`screen-share` in `danger`) in the slot before ×; click ends the share |
| Being shared | *(2026-10-24)* Stop sharing this tab, the same button, which ends the shares of it; on screen, its frame's edge is tinted (§7.13) |
| Dragging | Scale 1.03, `shadow-lift`, cursor `grabbing` |

**Close on a pinned tab** unloads it; it stays pinned. Tooltip: "Close (stays pinned)".

*As built (2026-10-25), counts:* a page that counts something for you (Telegram, WhatsApp, Slack: the number an installed web app puts on its icon) shows it on its row. A closed folder or split shows its tabs' counts added up, a Favorites tile shows its tab's on its top corner, and the chord switcher puts a dot in a chord's own color on any other chord with one. Chord's own icon (Dock, taskbar, launcher) shows them all added up. A tab showing a count doesn't sleep or go to the archive, so it stays current. Its right-click menu's *Show count on tab* hides a site's (an inbox's unread mail), listed in Settings → General → *Show counts on tabs*, which turns them all off. In Windows High Contrast the pill and dots are in `Highlight`.

*As built (2026-10-24), audible and muted:* the speaker (Lucide `volume-2`, `volume-x` while muted, 14 px in a 24 px hit area) sits in the slot just before × in `fg-muted`, and shows whenever the tab makes sound, muted or not: Chromium goes on reporting a muted tab's sound, so a muted tab that plays shows the crossed-out speaker, and one that stops loses it. Click mutes or unmutes the tab; the keyboard has the row's menu (*Mute tab* / *Unmute tab*), the command bar's actions and Ctrl+M (⌃M on macOS, where ⌘M minimizes; Firefox and Edge use these keys). The row's description says *Playing sound* or *Muted*. Muting is kept with the tab, through sleep and restarts, until you unmute it; in a private window it works and is never saved. A split's tabs, listed under its row, show it too. A popped-out video's PiP glyph, and Stop sharing, take the slot first.

### 7.3 `CommandBar`

- **Size and placement:** width `command-bar-width`; top at 18% of the frame height (min 64 px); radius `radius-lg`; padding `space-2`; `surface-raised` with `shadow-modal`.
- **Two placements:**
  - **Centered** (⌘T, new tab): the size and position above.
  - **Anchored** (⌘L, edit this tab's address): the input sits exactly over the URL pill, or over the minimal bar's address field, showing the full URL selected. The results panel drops beneath it, at least 480 px wide, extending over the page. Esc restores the address.
- **Input row:** 56 px (centered) or the pill's own height (anchored), `text-input`. Placeholder: "Search or enter address".
- **Results:** rows of 40 px with `radius-sm`.
  - Row anatomy: `[icon or favicon 16] [title] [— domain, fg-muted, text-small] … [chord chip if another chord] [hint]`.
  - The hint shows on the selected row only, e.g. "Switch to tab ↵".
  - Up to 8 visible, then the list scrolls.
- **Sections** (`text-micro` headers, 24 px) appear only when two or more kinds are present. Order: Top hit · Tabs · Pinned · History · Archive · Actions · "Search for …".
- **Selection** is the accent at 14% alpha (light) or 22% (dark). The highlight glides between rows (`snappy`) for arrow keys and jumps instantly while typing.
- **Inline autocomplete:** the completed suffix is selected in the input; Tab accepts it.
- **Where a result opens** is chosen by the Enter key: ↵ here · ⌘↵ new background tab · ⇧↵ new window · ⌥↵ split (Phase 2).
- **Search by image** (*built 2026-10-25*): paste an image (a copied screenshot, an image file) or drop one on the field. It shows as a thumbnail chip before the text, with ✕ (Backspace on the empty field also takes it out), the placeholder becomes *Press Enter to search by this image*, and the rows become the image's:
  - **Search [engine] for this image** (`scan-search` icon): your engine's own image search, Google Lens or Bing. An engine that has none (DuckDuckGo, Brave, Kagi, Ecosia) gets Google Lens, named on the row so sending the image there is a choice; Google-free mode gets Bing. ↵ opens it in a new tab (here, when editing an address), ⌘↵ behind.
  - **Ask Duet about this image** (Duet's icon), when Duet is set up and on in this chord: the panel opens and the message goes, the image with the words you typed as the question (or *What is in this image?*). With no words typed it's the second row; with words it's the first, as *Ask Duet: [your words]*.
  Nothing leaves Chord before a row is chosen.
- **Narrowing:** `@tabs`, `@pinned`, `@history`, `@archive`, `@chords`, `@actions` filter the results. A site keyword such as `yt` or `gh` followed by Tab switches to searching that site.
- **Ranking** follows Crest's tested scoring (MPL-2.0; ported in M1.4): match position, recency, frecency, open/pinned bonuses, top-hit rules, and learning which result you pick for the same text.
- **`HintBar`:** "↵ Open · ⌘↵ New tab · Tab Complete · Esc Close". It fades out for good after the user has used each hint 3 times, so beginners get guidance and experts get quiet.

### 7.4 `Favicon`

- The real icon renders at 16 px from `chord-favicon://`.
- **Fallback monogram** (no icon, or the fetch failed): a 16 px square, `radius-xs`.
  - Background: `oklch(.70 .11 H)` light, `oklch(.55 .10 H)` dark, where `H = hash(registrable domain) mod 360`, so it's stable per site.
  - Content: the first letter of the registrable domain label, Onest 650 at 10 px, in white or near-black, whichever passes 4.5:1.
- **Internal pages** use Chord glyphs (gear for settings, box for archive).
- Fallbacks never flash: if a real icon loads later, it crossfades in with `fade-fast`.

### 7.5 `Toast`

- Lives in the sidebar above the footer, full sidebar width minus 16 px. In hidden-chrome mode it moves to the frame's bottom-left.
- 40 px tall, `radius-md`, `surface-raised`, `shadow-popover`.
- Anatomy: `[icon] [message text-small] … [Undo — text-label, accent] [⌘Z keycap when the shell has focus]`.
- Announced through a polite live region.
- A click on the toast itself, not one of its buttons, dismisses it, as a notification's does.
- A toast can have a second button, before its main one: a screenshot's **Ask Duet**, before **Save**.
- *As built (M1.6):* the stack is the one live region (each toast is announced once, as it arrives), and each Undo is described by its toast's message. ⌘Z / Ctrl+Z, while the shell has focus and no text field does, presses the newest toast's Undo. Up to three stack as the deck in §6.5: older ones tuck behind the newest, each 6 px higher and 4% smaller, with only their top edge showing. Hovering the stack, or moving focus into it, fans them out upward over the tabs (the sidebar doesn't jump), so every toast's buttons can be reached; every clock pauses while the deck is open. `test/e2e/toasts.spec.ts`.

### 7.6 `HoverPreview`

- 280 px card next to the sidebar, aligned to the hovered row and clamped to the window.
- **Pinned tab:** a 280×175 thumbnail (last capture, JPEG), title (`text-label`), domain (`text-small`, muted), and "Opened 2 h ago" (`text-micro`). A tab never captured shows its favicon on its tint.
- **Folder:** the folder title, then up to 6 rows (favicon and title), then "and 4 more".
- **Timing:** appears after `delay-hover-intent`. While one is visible, moving to another row swaps instantly: content crossfades, position glides (`snappy`). Hidden while dragging, resizing or peeking, and on a click, scroll or key.
- **Off switch:** Settings → Privacy → Show page previews (on by default). Off deletes the pictures.

### 7.7 `ThemePicker`

Opened from chord ⋯ → *Edit theme*, and inline in onboarding.

- **ColorWheel (240 px canvas).**
  - Hue runs around the ring; chroma runs outward from the gray center. It's drawn at the swatches' display lightness in both appearances. In the dark band it was too muddy to pick from. The orbs and the live sidebar show how each appearance draws the tint.
  - Up to 3 handles: 24 px circles with a 2 px white ring and `shadow-raised`.
  - Click an empty spot to move the nearest handle.
  - **+** adds a handle at +40° (analogous).
  - Dragging a handle off the wheel removes it: it shrinks to 0 with `bouncy`.
- **Below the wheel:** the 12 swatches (with names in tooltips), the 6 presets, a **Grain** slider whose track previews the texture, **Light · Dark · Auto**, and **Surprise me** (a dice icon that spins with `playful`).
- **Live:** the real sidebar re-themes on every pointer move. The generator runs in well under 1 ms.
- **Accessible:**
  - Each handle is a focusable 2D control. Arrow keys change hue; Shift+arrows change chroma.
  - `aria-valuetext` names the nearest swatch, e.g. "Close to Coral, vivid".

*As built* (Settings → Appearance's theme editor, `settings/ColorWheel.tsx`, `settings/wheel.ts`):
- **Drawing:** the wheel is drawn with the generator's own band mapping (`mapToBand`), so dark mode's wheel is as deep as dark tints are.
- **Handles:** hue is 0° at the top, growing clockwise. Picked colors are stored at the swatches' display lightness.
- **Removing a color:** let go of a handle 1.25 radii out. Delete or Backspace on a focused handle removes it too.
- **Replaced:** the wheel replaces the hue and vividness sliders. Swatches and grain stay beside it.
- **Surprise me:**
  - It's in the editor and on the themes header.
  - It picks neighbors on the wheel, or now and then a split complement.
  - On the header it re-colors the chord directly, leaving a "Current colors" card to save.
- **Edit colors…:** the chord menu's item opens the editor on the chord's colors, or on its own theme.

**Settings → Appearance** is the theme library. It has three parts:

- **Color scheme:** System, Light or Dark.
  - Each choice is a miniature Chord window drawn by the real generator.
  - System is split on the diagonal.
  - This sets the app's appearance, and web pages' `prefers-color-scheme` follows it. A chord can still keep itself light or dark.
- **Themes:** the presets, then your own, as cards.
  - Each card shows two orbs, the theme as light and as dark mode draw it.
  - Clicking a card applies it to the current chord, and the chord remembers which theme it came from. Editing a theme updates every chord that uses it. Deleting a theme leaves those chords' colors as they are.
  - If a chord's colors match no theme, a **Current colors** card leads, with *Save as a theme*.
  - Hover actions: copy the theme code (portable JSON), and Duplicate (presets) or Edit (your own).
  - *Create theme* and *Import* (paste a code) open an inline panel, never a dialog.
  - Delete lives in the editor and asks a second time in place.
- **Interface:** two sliders, both defaulting to 50%. Neither can push text below 4.5:1.
  - **Contrast:** how strongly dividers, hovers and secondary text stand out.
  - **Window tint:** how much color covers the OS material.

### 7.8 `DuetPanel`

As built in Phase 2. Duet chats and reads; it never changes your tabs (ARCHITECTURE.md §11). It fills a form only when you ask, after you check its values (D16, `FillCard` below).

- **Frame:** a `surface` frame (`radius-frame`, `shadow-frame`), 380 px, right of the page with an 8 px gap. The page's frame narrows to make room.
- **Header (40 px):** the chat's title (click *Rename* to edit it in place), the context meter, a *provider · model* chip ("Claude Code · Default") that opens the model menu, the **Chats** menu (New chat, Rename, Export as Markdown, Delete this chat, recent chats, Turn off in this chord), and close.
- **`ContextMeter`:** a 16 px pie in a 24 px hit area, `fg-subtle` (the `accent` from 80%), filling clockwise from the top as the chat uses the model's context. A pie, not a ring: a partly drawn ring reads as a spinner. Its tooltip and accessible value say "62% of context used. When it fills up, Claude Code compacts the conversation automatically and carries on." ("Under 1%" while some is used but it rounds to 0, as with a 1,000,000-token window.) It's a focusable `meter`. It appears after the first answer, and only when the CLI reports its context window (ARCHITECTURE.md §11.2); it's never estimated.
- **Reading line:** "Duet can read:" with *What you attach (asks for more)* · *Tabs in this chord* · *All my tabs*, for this chat (the default is set in Settings → Duet).
- **Messages:** `text-body`, max width 64ch.
  - User messages sit in a soft accent-tinted bubble, with the attached tabs' titles under it; hovering shows **Copy** and, on the last one, **Edit and send again**.
  - Assistant messages are unbubbled for calm reading: a small, safe Markdown subset with no images from the web. A link shows its full address and opens only when clicked.
  - **Images Codex made** (*built 2026-10-25*) show whole at the reply's width, `radius-sm`, with **Copy** and **Save** (to Downloads) over the top corner on hover or focus. While one is being made, a square placeholder says *Making an image…*. Its alt text is what Codex made it from. Settings → Duet → *Codex can make images* (on) turns this off.
  - **Claude can't make images.** Asked for one, it says so in a sentence and the reply ends with **Make it with Codex** (a `secondary` button) when Codex is set up and allowed: the chat goes on with Codex (*Switched to Codex*) and the message is asked again. Only on the latest reply.
  - **Citations** are small numbered pills inside the sentence they support. Clicking one switches to the source tab and finds the quote; if the tab is gone, it opens the page scrolled to the quote. A PDF's pill names its page, "1 · p. 3" (its accessible name, "Source 1, page 3: “…”"), and opens the PDF there. A citation that stands in for words of its sentence (after a comma, a colon, or a verb a quote follows: "Gruber called it [1] rather than…") shows its quote in place, “in quotation marks”, then its pill, so the sentence still reads; the prompt also asks Duet to write quoted words itself.
  - **Tabs by name:** Duet names a tab by its title or site. If it writes the tab's handle anyway ("tab t1"), the panel shows the tab's title there instead, in a soft pill (one line, at most 24 characters before …) that switches to the tab, or opens its page if it's closed.
  - An interrupted reply says *Interrupted* with **Retry**; an error gives the plain cause and the fix.
  - Dividers mark *Continued with a summary* and *Switched to Codex*.
- **`ToolActivityRow`:** a single quiet line ("Read “Article”", "Read 3 tabs · 1 more", "Searched history for 'flights'") that expands to show details.
- **`ApprovalCard`** ("Duet is asking"): what Duet wants to read, in plain words ("Read “Pricing”", "See the list of your tabs"), with the target listed.
  - Buttons: **Allow once** (⌘↵ / Ctrl+↵) · **Allow for this chat** · **No** (Esc).
  - *As built (M1.6):* those keys work from the message field too, while a card waits; the question is announced to screen readers.
  - The card never auto-accepts. Once answered it shrinks to a muted line (*Allowed*, *Not allowed*).
- **`FillCard`** (*built 2026-10-25*; D16, ARCHITECTURE.md §11.6): Duet's values for a form you asked it to fill, in the timeline where it proposed them, on the approval card's surface with its accent ring while it waits. Nothing goes into the page until you press Fill.
  - **Head:** *Fill this form on example.com*, then in `fg-muted`: *Nothing goes into the page until you press Fill, and you send the form yourself.*
  - **One row per field:** a checkbox to keep it (named *Fill “Email”*, on to start), the page's label, and *Required* in `text-micro`, `fg-subtle`, at the row's end. Under it the value, editable, on `item-hover` (`radius-sm`, `text-small`): a text field (a date, time, number, email, phone or address field for those types, never taking more than the page's field does), a text area, a select of the field's choices (a radio group's too), or *Checked · Not checked* for a checkbox. A field left out dims to half.
  - **What Chord left out,** in `fg-muted`: *Left out: Password, Card number and Verification code. Chord never fills passwords, payment details and one-time codes, so fill those yourself.* A page with more fields than Duet reads at once: *This page has more fields than Duet reads at once: these are the first.*
  - **Fill 5 fields** (the accent pill; its count follows what you keep, and it's off at none; ⌘↵ / Ctrl+↵ inside the card) · **Not now** (quiet, Esc). They stay at the timeline's bottom edge while a long card scrolls under them.
  - **Before Fill can work,** a line in `danger`: *Go back to “Sign up” to fill it.* (another tab is in front; the card waits), or a value the field won't take (*Name is longer than the field takes (20 characters).*).
  - **In the page:** each field outlined in the chord's accent for a moment, the first scrolled into view (at once with reduced motion), and the toast *Filled 5 fields on example.com* · **Undo**.
  - **Ended,** it shrinks to its head and a line in `fg-muted`: *Filled 5 fields.* (and, for a field the others changed as they went in, *Region changed as the other fields went in, so Chord left it alone. Ask Duet again for it.*) · *Filled 5 fields, then undone.* (and *1 field you changed since stayed as you left it.*) · *Not filled.* · or why nothing went in: *The form changed since Duet read it, so nothing was filled. Ask Duet again.* · *The page moved on since Duet read the form, so nothing was filled. Ask Duet again.* · *The form isn’t on the page any more, so nothing was filled.* · *The tab is closed, so nothing was filled.* · *Duet can’t read this site any more, so nothing was filled.* · *Duet is set to read nothing now, so nothing was filled.* · *Duet suggested other values below.* · *The page didn’t answer in time, so Chord can’t say what went in. Check the form.*
  - **Undo after the page moved on:** the toast *Couldn’t undo: the page has moved on*.
  - **Accessibility:** a group named by its head, described by its first line; screen readers hear *Duet suggests values for 5 fields on example.com. Check them, then Fill or Not now.* Only the card's own keys fill: the message field's ⌘↵ never writes into a page.
  - After a relaunch it's an activity line (*Filled 5 fields in “Sign up”*): Chord never keeps the values.
- **Working:** a dot and *Working… 12s* while a reply streams; text renders as it arrives, with no typing animation.
- **Follow:** the list follows new text until you scroll up more than 40 px; then a **Jump to latest** pill appears.
- **Composer:**
  - `ContextChips` above the input. The current tab is attached by default as a removable chip (*Reading example.com*; "This tab · example.com" before 2026-10-25), except under *Ask every time*; sites Duet can never read are never offered. The chip's tooltip says what's sent where, and that removing it makes Duet ask first.
  - **What Duet can read** (*built 2026-10-25*), above the messages: *Reads* and a radio group, **Ask · This tab · This chord · All tabs** (each option's tooltip says what it allows). It's the chat's own scope (ARCHITECTURE.md §11.3). With Settings → Duet → *Nothing*, the group gives way to *Reads* **Nothing** and **Change in Settings**, which opens Settings → Duet. No chat can loosen it. There's no chip, no **@**, and no image chips, and the empty chat suggests things that need no page (*Explain this simply*, *Help me write a reply*).
  - **Images** (*built 2026-10-25*): one asked about from the command bar, or a screenshot's **Ask Duet**, is a thumbnail chip with ✕ before the tab chips. Up to four; a fifth replaces the oldest. They go with the next message, which may be images alone. The model gets the picture itself: the command bar's at most 1,000 px a side, a screenshot's at most 1,568 (what Claude reads best). A user message shows its images as thumbnails above its words; Edit and send again brings them back with the words.
  - `@` opens a picker of this chord's tabs.
  - Enter sends; Shift+Enter adds a line; ↑ in an empty composer recalls your last message; Esc stops a reply.
  - Messages sent while Duet is answering are **queued** as chips (removable) and go in order.
  - Send turns into **Stop** while a reply streams. Each chat keeps its own draft.
- **States:** *Off* (not shown at all) · *Off in this chord* (a note and **Turn on in this chord**) · *Intro* · *Setup* · *Ready, empty* (three suggestion chips, and *Continue “title”* after 12 hours idle) · *Streaming* · *Needs approval* · *Provider error* (plain cause plus fix, e.g. "Claude Code isn't signed in. Run `claude auth login` in a terminal, then try again.").
- **In the sidebar:** Duet's icon, small, on tabs Duet read while the chat is open (*Duet read this tab*).

### 7.9 Split view, Peek, mini window, hidden chrome

| Component | Spec |
|---|---|
| **Split view** | 2–4 panes, each its own rounded frame, separated by 8 px gaps. The focused pane gets a 2 px accent ring in the gap (at full strength: the accent's 3:1 over the tint is what makes it visible; it was 50% before the M1.6 accessibility pass). Dividers are invisible until hovered, then show a 4×32 px pill (`fg` at 30%); the cursor shows the resize direction. Minimum pane width 320 px; double-click a divider to equalize. **In the sidebar** a split is one row: up to 4 favicons in a line plus a joined title ("Docs + Figma"), expandable to show its members. |
| **Peek** | Scrim plus a card up to 88% of the frame (max 1200×900), `radius-lg`, `shadow-modal`, with a 40 px header (domain · *Open in Today* ⌘↵ · *Close* Esc). It enters from scale 0.92 at the click point (`overlay`). Promoting it grows the card into the frame (`smooth`) and the page becomes a Today tab. |
| **Mini window** | A small window (remembers its size; default 900×640) with a 36 px bar showing the domain, **Open in ▾ [chord]**, and close. Neutral tint. Promoting it fades the window out, and the tab lands in the chosen chord's Today with the pin bloom. On Wayland the compositor places the window.<br>**As built:** each link gets its own mini window, cascaded from the middle of the screen. The bar shows a lock or globe with the domain, *Copy link*, and a split button: **Open in [icon] [chord]** moves the page (⌘↵ / Ctrl+Enter), and ▾ picks another chord from a menu, which moves it there at once. Close is the window's own caption control (traffic lights on macOS, the caption buttons on Windows and Linux), as for Chord's other windows. A thin line along the bar's bottom shows loading. Chord launched just to open a link shows only the mini window. ⚠ Not yet: the pin bloom on arrival (the tab just appears at the top of Today), and the fade on Linux (it closes at once). |
| **Auto picture-in-picture** | Leave a tab while its video plays and the video pops out into a floating window over everything, including other apps. Come back and it slides home inline.<br>**The window is Chromium's native PiP window**, the same one Chrome and Dia use. Its controls appear on hover: ↖ *back to tab* (top-left), the site's origin (top-center), ✕ (top-right), play/pause with the site's skip buttons (e.g. −10 / +30), and a progress bar. Chord doesn't restyle or animate this window; the OS and Chromium own it.<br>**In the sidebar** the tab's speaker icon becomes a PiP glyph (Lucide `picture-in-picture-2`). Clicking the glyph brings the video home.<br>**Settings:** *Pop out playing videos when you switch away*, **off by default** since 2026-10-25: a video leaving by itself was jarring, and Now playing in the sidebar pops one out on request. A per-site "Don't pop out" in the site menu is planned.<br>Details and limits: ARCHITECTURE.md §9. |
| **Minimal mode** (sidebar collapsed; the brief's "hidden chrome") | Specified in §3.3. Toggled by the bar's ◧ button, the sidebar's collapse button, the command bar ("Hide sidebar"), or the toggle shortcut. Peek reveal, when Settings → Appearance turns it on (off by default): pointing within 6 px of the left edge for 120 ms, or hovering ◧ for 300 ms. In OS fullscreen the bar itself auto-hides. |

### 7.10 `NowPlayingCard`

*Built 2026-10-24.* Media playing in a tab you aren't looking at, at the bottom of the sidebar, as Arc has it.

- **When:** media you left playing: it was playing when another tab, chord or window took its tab's place (a split's panes on screen count as shown), or you played or paused it from the card. A background tab that starts playing on its own (an autoplaying video in a tab you opened behind) gets the speaker on its row, not the card; media you paused before leaving doesn't come back as a card. Media in another chord shows too, so music started in Work keeps its controls when you switch to Personal. A normal window never shows a private window's media, and a private window shows only its own. The card stays a minute after the media pauses, so it can be played again from there; closing the tab or leaving the page ends it at once, though a tab you left playing that plays again on its next page comes back.
- **Several at once:** the one that started most recently in full; under a hairline (`divider`), up to two more as one-line rows, newest first: favicon and title (the track's when the page says, else the tab's) as a button to the tab, then picture-in-picture for a video, Mute and Play / Pause as icon buttons. Which video is out is yours to choose: Chromium has one picture-in-picture window, so popping out another swaps them, and the one that comes back plays on in its tab. With auto picture-in-picture on, the first video you leave pops out on its own and the next ones stay in, until you choose. More than that: *and 2 more* (`text-micro`, `fg-muted`), which shows the rest.
- **Where:** under the toasts, above the extensions shelf and the footer; the sidebar's width less 16 px. In minimal mode it's there while the sidebar peeks.
- **Anatomy:** 36 px tall when the page says nothing about what it plays, 84 when it does.
  - What plays, from the page's Media Session: the artwork at 40 px (`radius-xs`, concentric with the card), the track in `text-label` and *artist · album* in `text-small`, `fg-muted`, each on one line with an ellipsis. Without artwork, the text alone.
  - The tab: its favicon and title (`text-small`, `fg-muted`), a button that goes to the tab. Then **picture-in-picture** (`picture-in-picture-2`) for a playing video; once it's out, by Chord or by the site's own button, *Back to the tab* (`picture-in-picture`, pressed), which brings the tab on screen with the video back in it, as the PiP window's own button does; **Mute / Unmute** (`volume-2` / `volume-x`); and **Play / Pause**: a 28 px `accent` circle with a filled glyph in `accent-fg`, the card's one accent.
  - Play and Pause show only for a player in the page itself. One in an embedded frame (a video in an article) can be muted from the card, but not paused (ARCHITECTURE.md §9). On sites whose player keeps its own state or plays from outside the page (Twitch, SoundCloud, Bandcamp), they read and press the site's own button, so the site's player agrees (`main/media-sites.ts`; docs/testing/media-sites.md lists the hand checks).
- **Surface:** `item-hover` on the chord's tint, `radius-md`, padding `space-1`: a soft square like a favorite's, in the chord's own colors, light and dark. The buttons are the sidebar's icon buttons. Windows High Contrast adds a `CanvasText` edge.
- **Motion:** it rises 8 px and fades in on `overlay`, and leaves with `fade-fast` and a 4 px drop; with reduced motion, opacity only. It belongs to *Animate the sidebar* (§6.8): off, it just appears. When what it shows changes, it changes in place.
- **Accessibility:** a group named *Now playing*, outside the sidebar's trees, so its buttons are ordinary Tab stops, named for what they do: *Go to tab: [title]*, *Pop out the video*, *Mute tab*, *Pause*; a row's name the title it plays: *Go to tab: [title]*, *Pop out the video: [title]* (or *Back to the tab: [title]*, pressed), *Mute: [title]*, *Pause: [title]*. Going to the tab, or the card leaving with the keyboard in it, hands the keyboard to the sidebar's tab. A new track isn't announced.
- **The OS's own controls** (Windows' media flyout, macOS's Now Playing, Linux's MPRIS) come from Chromium, not this card: ARCHITECTURE.md §9.
- **Chord Player** (§7.14) is on the card as the tab it plays for would be, once something has played in it, until it closes.
  - Its line reads *[tab's title] · Chord Player*.
  - Instead of *Go to tab*, the button is ***Back to the player*** (it brings the player forward; named *Back to the player: [title]*).
  - Mute is the player's own (*Mute Chord Player* / *Unmute Chord Player*), not the tab's.
  - Play and Pause work as for a tab; there's no picture-in-picture button (the player's page has its own).

### 7.11 `ReaderView`

*Built 2026-10-24.* A page's article on its own, in Chord's typography and the chord's colors, without the site's layout, ads or scripts, as Firefox's and Safari's reader views show it. How it works, and why nothing in it can run: ARCHITECTURE.md §9.

- **When it's offered:** while the page on screen reads as an article (Chord asks once it has loaded, and again a few seconds later), a book (`book-open-text`, 16 px) shows beside the address: in the top strip on Windows and Linux and in the minimal bar, or right of the URL pill on macOS with the sidebar docked. It's an icon button named *Reader view*, pressed while reader view shows (`aria-pressed`, the active row's raised surface), with the keys in its tooltip. Also: the tab's menu (*Show in reader view* or *Leave reader view*, bringing the tab to the front), the command bar (*Show reader view*, *Leave reader view*), the View menu, and **F9** (⌘⌥R on macOS), page-first. Asked on a page with no article, a toast says *Chord couldn’t find an article on this page.*
- **Where:** in the frame, in place of the page, with the frame's radius and shadow; each pane of a split can show its own. The page waits behind as it was: Esc, ✕, the button or the keys bring it back, scrolled where you left it. Following a link from it in the tab leaves reader view, as the page goes.
- **Anatomy:**
  - **Bar**, 40 px, staying on top as the article scrolls: the book and the site's name (`text-small`, `fg-muted`) on the chord's tint over `surface`, a hairline under it; on the right *Text and colors* (`a-large-small`) and *Close reader view* (✕; its tooltip names Esc and the keys).
  - **The article**, one column at the line width you chose, centered, `space-10` above and `space-16` below: the title (reading `title`, lines balanced), a line under it with the byline and *8 min read* (`small`, `fg-muted`), then the text in reading `body`, selectable.
  - Headings start at h2 under the title and never skip a level. Links are `accent`, underlined, thicker on hover; they go where the tab's would (Peek from a pinned tab to another site, §8.5; ⌘/Ctrl-click or the middle button, a tab behind). Images fill the column at most (`radius-sm`), captions in `small`, `fg-muted`. Quotes get a 2 px `divider` rule and `fg-muted` text; code is in the computer's monospace on `item-hover`, wrapping; tables are `small` with hairline rows, and a wide one scrolls sideways in a region of its own.
- **Text and colors:** a card under its button (`surface-raised`, `shadow-popover`, `radius-md`, 320 px, `space-3` padding) with four segmented choices on `item-hover`, the chosen one raised: *Text size* (smaller · the size in px · larger, over the six sizes of §4.2), *Font* (Sans: Onest; Serif: the computer's), *Line width* (Narrow, Medium, Wide), and *Colors*, each with a swatch of its page and ink: **Chord** (the chord's own theme, light or dark as the chord is; the default), **Light** and **Dark** (neutral, Graphite), **Sepia** (warm paper and brown ink). A change applies at once, to every reader view, and is remembered (Settings keeps it, from a private window too: it says nothing about what you read). The zoom keys and Ctrl + wheel change the text size as well, as in Safari. Esc or a click elsewhere puts the card away.
- **Contrast:** every theme keeps text, secondary text and links at 4.5:1 or more on its page and focus rings at 3:1 (`createReaderTheme`, tested as the chord themes are).
- **Motion:** none of its own. Reader view comes in once its article is laid out, so no blank frame shows, and goes at once; only its buttons' hover fades remain, which reduced motion removes.
- **Accessibility:** the bar is the page's banner and the article its main landmark, with one h1, the title. Space, Page Down and the arrows scroll it as it opens (it takes the keyboard); F6 counts it as the page. The card's choices are radio groups (one Tab stop each, arrows choose); Esc closes the card, then reader view. An image without a description is decoration (empty `alt`), and a link with nothing to name it isn't one. Printing prints the article alone. Windows High Contrast: the card gets a `CanvasText` edge, a chosen option `Highlight`.
- **Private windows:** the same, in the window's graphite colors with the Chord theme; images come through the window's own sign-ins, and nothing of the article is kept.

### 7.12 `CaptureLayer`: screenshots

*Built 2026-10-24.* The maintainer's Screenboard extension, built in: an element, an area, what's on screen or the whole page, straight to the clipboard.

- **Starting:** ⌘⇧2 / Ctrl+Shift+2 (reserved; Arc's key, clear of macOS's own ⌘⇧3/4/5), *Take a screenshot* in the ⋯ menu, the page's right-click menu and the command bar (and File on macOS). It takes the page in front: the focused pane of a split, Peek's page while it's open, the whole window in fullscreen. With no page there (an error or crash page, a new tab), a toast says so.
- **One mode.** The overlay covers the window; the page stays clear and the rest dims (`scrim`). The pointer over the page is a crosshair.
  - **Hover** outlines the element under it (`focus-ring` width, `accent`, a 12% `accent` fill) with a label above: what it is and its size, "div#box · 200 × 120". **Click** takes the whole element, even where it runs past the screen.
  - **Drag** draws an area (a dashed hairline, 8% fill) with its size; let go to take it. A drag under 4 px is a click.
  - **The bar**, a pill centered at the page's top (`surface-raised`, `shadow-popover`): *Click an element or drag an area* in `fg-muted`, **Visible** (V), **Full page** (F), and ✕ (Esc).
  - **Keys:** ↑ and ↓ step to the element's parent or child, Enter takes it, V and F as above, Esc cancels. The wheel still scrolls the page. A click outside the page cancels.
- **After:** it's on the clipboard at once, as a PNG, and a toast says *Screenshot copied* with **Save**, which puts it in Downloads as "Screenshot 2026-10-24 at 18.32.10.png" and lists it there. ⌘Z never presses Save. Where Duet may see that page (set up, on in this chord, not a Never site), the toast also has **Ask Duet**, which puts it in Duet's composer and opens the panel.
- **Recent screenshots:** the downloads panel lists them under its downloads, newest first: a thumbnail, the page's title, when and how big, then Ask Duet (where Duet may see that page; the panel steps aside for Duet's), Copy, Save and Delete, and Clear for all. Up to 50, within 256 MB. Settings → Privacy → *Keep recent screenshots* (on) turns this off, deleting them. A private window's are in memory only, listed only in that window, and gone with it.
- **What can't be pictured:** video under DRM comes out black, as in every browser.
- **Accessibility:** a dialog named *Take a screenshot*, described by its hint, with the keyboard in it; the bar's buttons are ordinary Tab stops; the element under the pointer is announced politely ("div#box, 200 by 120"). Forced colors draw the outline and label in `Highlight`.

### 7.13 Sharing: the picker, presenting mode, and what's shared

*Built 2026-10-24* (ARCHITECTURE.md §9, *Screen sharing* and *Presenting mode*).

- **The picker (`ShareCard`).** A card in the popover at the frame's top-right, like a permission prompt, a little wider (`size-popover-card` plus `space-16`), with `shadow-card`. "Choose what to share with **meet.google.com**", and ✕ (or Esc) to refuse.
  - **A tab · A window · Entire screen**, a segmented row, A tab first and chosen to start with. Tabs are 32 px rows: the site's icon, the title, and the site in `text-small` and `fg-muted`. The asking tab leads, with *This tab* in `text-micro` and `accent` where its site would be. A picked row gets `item-active-bg` and a 2 px `accent` ring inside it. Nothing is picked to start with, so Share is never one click from a page sharing itself; going to screens picks the only screen there is.
  - **Screens and windows** are thumbnails two to a row, named at once; their pictures fill in when they arrive, and "Finding screens…" stands in until the list does.
  - **Sound:** *Share the tab's sound too*, ticked to start with; *Share your computer's sound too* (Windows only), not.
  - **macOS 15 and later, and Wayland:** no segmented row. The tabs, and *Screen or window…* (`monitor-up`, a secondary pill at the start of the buttons), which opens the system's own picker; its tooltip says whose ("Opens macOS's own picker").
  - Cancel · **Share**, the accent pill, once something's picked. Double-clicking a row shares it at once.
- **Presenting mode's indicator (`PresentingCard`).** While the mode is on, a card in the sidebar under the toasts, above Now playing: `presentation` in `danger` (the color that says "live", as Stop sharing's does), *Presenting* in `text-label`, "History, previews and notifications are hidden" in `text-small` and `fg-muted` on one line, and **Turn off**, a quiet text button. The same soft square as Now playing (`item-hover`, `radius-md`, padding `space-1`). It rises 8 px and fades in on `overlay`, and leaves with `fade-fast`; it belongs to *Animate the sidebar* (§6.8), and with reduced motion only fades. It's a group named *Presenting mode*. In the minimal bar, where the card is folded away, a chip stands in: the icon, *Presenting* and ✕ on an `item-hover` pill, named *Turn off presenting mode*. Turned off while a page still shares, it stays off until a share starts again. Windows High Contrast gives both a `CanvasText` edge.
- **The switch,** for when another app (Zoom, Teams) shares Chord's window: the command bar's *Start presenting* / *Stop presenting*, View → *Presenting Mode* on macOS and *Presenting mode* in the ⋯ menu (checked while it's on), and ⌘⇧P / Ctrl+Shift+P (page-first, §14). Settings → General → Sharing → *Hide the sidebar while presenting* (off by default) collapses every docked sidebar while it's on, the usual way, and docks them again after.
- **What's shared, shown.** A shared tab on screen has a 2 px edge in `danger` just outside its frame (or its split pane, inside the focused pane's ring), in the bezel the page's view doesn't reach. A window a page is sharing, as a window or on a shared screen, has a 2 px edge in `danger` all the way round inside it. Beside them, in the sidebar, the sharing tab's row has Stop sharing and the shared tab's has *Stop sharing this tab*. With forced colors the edges are lines in `Highlight`.

### 7.14 Chord Player

*Built 2026-10-25* (ARCHITECTURE.md §9, D4). The streaming services that need Widevine play in Chord Player, a companion app with a window of its own (S14's approach (a) on every OS). It should read as part of Chord: the chord's colors, Chord's type, and always a way back.

**The DRM notice's states** (the popover card above; `PlayerAction`). Chord Player is offered first, in a full-width row of its own between the notice's line and the other browsers, which drop to secondary buttons.
- **Install:** **Install Chord Player (about 125 MB)**, the download's size in decimal megabytes; **Update Chord Player (about … MB)** when the installed one is too old for this Chord.
- **Installing:** a 4 px progress bar (`accent` on `item-hover`, `radius-full`) under a line in `text-small`, `fg-muted`, tabular figures: *Downloading Chord Player · 42%*, *Checking the download*, *Unpacking Chord Player · 80%*. A `progressbar` named *Installing Chord Player*, its value text the same line.
- **Ready:** **Open in Chord Player**. Installing ends here too: the page then opens in the player.
- **Opening:** the same button, disabled: *Opening in Chord Player…*.
- **Failed:** why, in `danger`, `text-small` (an `alert`), then **Try again**:
  - *Chord Player didn't download. Check your connection and try again.*
  - *The download didn't match its signature, so Chord didn't install it.*
  - *Chord Player couldn't be unpacked. Check there's room on the disk and try again.*
  - *Chord Player didn't start.*
  - *Chord Player couldn't get Widevine from Google. Check your connection and try again.*
- **The line:** with Chord Player offered, *It needs Widevine, the copy protection streaming services use. Chord Player, a companion app with Widevine, plays it in a window of its own.* On Linux it adds *On Linux, some services play only in lower quality, or not at all.*
- **Never** in Google-free mode or a private window: there the card is as before, with other browsers only.

**The player's window.** Frameless, with a 40 px bar (`size-player-bar`) above the service's page. The bar wears the chord the service came from: its base and tint (as a solid window draws them, light or dark as the chord is), in Chord's type.
- **Left to right:** a 16 px rounded square in `accent` (`radius-xs`), the service's name in `text-label`, then, while Widevine installs on first use, *Getting Widevine ready…* in `text-small`, `fg-muted`.
- **On the right:** **Back to Chord** (an arrow-left and the words; a 28 px pill in `item-hover`, `item-active-bg` on hover, `focus-ring` outline), then the window's controls.
- **Window controls** are the OS's own:
  - macOS: the traffic lights, centered in the bar, 76 px kept for them on the left;
  - Windows and Linux: the caption buttons through the title bar overlay, on a transparent ground so the tint runs under them, with 138 px (Windows) or 120 px (Linux) kept on the right.
  - The bar is the window's drag region; the button isn't.
- **Before Chord sends the chord's colors:** Chord's default theme in the system's appearance. When the chord's colors or the appearance change, the bar follows.
- **Fullscreen** (a video's) covers the bar; leaving brings it back. Picture-in-picture is Chromium's window, as in Chord.
- **Sign-in popups** a service opens are small windows of the player's own (520 × 700), without the bar.
- **On Windows** the window joins Chord's taskbar button. On macOS it's an app of its own in the Dock and Cmd+Tab, named *Chord Player*.
- *Icon:* Chord's, for now; one of its own is a follow-up.

**The tab that stays** (`PlayerState`, in the frame where the page was). *Playing in Chord Player* (`text-heading`), *[host] plays in Chord Player, in a window of its own. This tab stays here.* (`fg-muted`), then **Show the page here** (secondary pill) and **Back to the player** (the `accent` pill), side by side. A `status`, so it's announced once.
- The page waits behind it, hidden; the DRM notice doesn't show over it.
- *Show the page here* shows the page again (to manage the account, say); the notice then offers *Open in Chord Player* again.
- Closing the player, or the tab leaving its service, does the same.
- Only one tab at a time: opening another service's page in the player moves it there.

**Settings → General → Chord Player** (after Spelling):
- **Installed:** *Chord Player 0.1.0*, *Plays Netflix, Spotify and the other services that need Widevine, in a window of its own, on castLabs ECS 44.9.3.* An update waiting adds *Version 0.1.1 starts the next time it opens.*
- **Remove** is a link button that asks once more inline: *Remove it and its sign-ins?* (for 5 seconds), then *Removing…*.
- **Not installed:** *It installs from the notice on their pages.*
- **Google-free mode:** *Off in Google-free mode, because Widevine, which it plays with, comes from Google.*
- **Where it can't run** (a Flatpak, Linux arm64), nothing shows.
- Settings → Privacy → Google-free mode lists it under *Also changed*.

### 7.15 Effects

*Built 2026-10-25* (ARCHITECTURE.md §9, D13). Your own styles for a site, in place of Arc's Boosts: your CSS, elements you hid, a few presets, and patches Duet writes when you ask. Each one can be switched off and kept, and a hidden element or a patch from Duet can be edited. The **Dry/Wet** switch, named for the mix knob on an effects pedal, takes them all off at once (dry) and puts them back (wet), on one site or on every site, over whatever each one's switch says. They stay on this computer.

- **Where they are:**
  - **Beside the address**, while the site in front has Effects: a button with Lucide's `blend` glyph (16 px, `iconButton`), right after reader view's book (§3.2, §3.3). Wet, it has the active row's raised surface (`item-active-bg`, `shadow-raised`); dry, it's plain, its glyph in `fg-subtle`. Its name says which, *Effects: wet* or *Effects: dry*, with the keys in its tooltip. A click opens the card. A site without Effects shows nothing: the page keeps the room.
  - The page's right-click menu (*Effects for this site…*, *Hide an element…*), View on macOS and the ⋯ menu's *Effects* on Windows and Linux, the command bar (*Effects for this site*, *Make this site dry* or *wet*, *Make every site dry* or *wet*, *Hide an element on this page*), and Settings → Effects.
  - **⌘⇧E / Ctrl+Shift+E** (page-first) makes the site in front dry or wet, with a toast that says which: *Dry: example.com shows as it comes*, *Wet: example.com shows your Effects*. On a site without Effects it opens the card.
- **The card (`EffectsCard`)** sits in the popover at the frame's top-right, as the find bar does, so the page stays clickable and every change shows on it as you make it. `size-popover-card` plus `space-10`, `surface-raised`, `shadow-card`, `radius-md`; at most `size-popover-max` (520 px) tall, its head staying put while the rest scrolls inside.
  - **Head:** the glyph in `accent`, *Effects on* **example.com**, then **Dry · Wet**, a segmented pair (the site's own switch, Wet first chosen), and ✕ (Esc).
  - **Every site dry:** a line under the head, *Every site is dry.* in `fg-muted`, and **Make every site wet**, a quiet text button.
  - **A private window:** *Changes here last until this window closes.* in `fg-muted`.
  - **Presets:** three chips that turn on and off (`aria-pressed`; an on chip has the raised surface and a check): *Reading width*, *Dark*, *No sticky bars*. Each one's description is its tooltip: *Keeps lines of text to a comfortable length.*, *Dark colors, for a site that has none.*, *Headers scroll away, and cookie banners stay hidden.*
  - **Each one's switch** *(2026-10-25)*: your CSS, each hidden element and each patch from Duet has one, as Settings' (`size-switch-*`, `accent` when on). Off keeps it in the card, its name in `fg-muted`, and applies nothing of it; the page follows at once. A switch is its own undo, as a preset's chip is: no toast. Dry · Wet stays over them all.
  - **A row** (a hidden element, a patch from Duet), on `item-hover`, `radius-sm`: its switch, its name cut short with an ellipsis (all of it in the tooltip), **Edit** (`pencil`, an icon button) and **Remove** (✕), with Undo. Edit opens the row's editor under it, and its first field takes the keyboard; only one is open at a time. Its fields are `text-small` on `surface-raised`, each with a `fg-muted` label above, and apply after a 300 ms pause, as your CSS does. **Done**, a small secondary pill at its end, or Esc closes it, and the keyboard goes back to Edit; Esc closes the card only after.
  - **Hidden:** **Hide an element…** (`mouse-pointer-click`), a secondary pill. The card steps aside for the picker (below) and comes back when it's done. Under it, each element you hid, one row each: its switch (*Hide div#sidebar*), its name in the computer's monospace (*div#sidebar*; the tooltip adds its selector when you renamed it). Remove shows it again for good: *Showing div#sidebar again* · **Undo**. Its editor: **Selector** (monospace), so a selector that matched too much can be narrowed, and **Name**. Under them, in `fg-muted`: *Another hidden element has this selector.* (and it isn't used), *Chord can’t use this selector, so it hides nothing.*, *It’s off, so it hides nothing.*
  - **Your CSS:** its switch (*Use your CSS*) before the label once there's CSS, or while it's off; off, the text in `fg-muted`. A text field in the computer's monospace, `text-small`, six lines tall and growing to fourteen, on `item-hover`, placeholder *body { font-size: 18px }*. What you type applies after a 300 ms pause. When Chord left something out it says so under the field in `fg-muted`, `text-small`: *Left out url() on line 3. Effects never load files.* (or, for what Chord doesn't know, *Left out foo() on line 2, which Chord doesn't know.*).
  - **Ask Duet**, only where Duet may read the page (set up, on in this chord, not a Never site, not a private window): a one-line field with Duet's icon, *Ask Duet to restyle this site*, Enter sends. While it writes, the field gives way to *Claude Code is writing… 8s* and **Stop**. Each patch Duet wrote is a row: its switch (*Use “Green headline”*), Duet's icon in `fg-muted`, its summary (your words when it gave none; the tooltip adds *You asked: …*), Edit and Remove (*Removed “Green headline”* · **Undo**). Its editor: **Name** (its summary; emptied, the row shows your words) and **CSS**, your CSS's field on `surface-raised`, holding the patch as Duet wrote it, without the `!important` Chord adds. What you type goes through the same checks as your CSS, and what Chord left out shows under the field as it does there; *It’s off, so the page doesn’t show it.* while it's off. When a request gives nothing, why, in one sentence in `danger`, `text-small`; what Chord left out of a new patch, in `fg-muted`.
  - **Foot:** *Remove all Effects on this site*, a quiet text button, with Undo.
- **Hiding an element** uses the screenshot picker's layer (§7.12) in its second mode: the page clear, the rest dimmed, the element under the pointer outlined with its name and size. A click hides it at once, and you can go on clicking. ↑ and ↓ step to the parent or child, Enter hides the outlined one, the wheel scrolls. The bar: *Click what to hide on example.com*, then *2 hidden* once there are any, and **Done** (Esc). Done shows one toast, *Hid 2 elements on example.com* · **Undo**. The element is found again on the site's other pages by a selector Chord makes from it (its id when that's unique, else a short chain of tags and classes).
- **What's kept, and where:** by site (the host, without `www.`), shared by every chord. A private window uses what you saved; what you change there lasts until it closes. Ask Duet isn't offered there.
- **Accessibility:** a dialog named *Effects on example.com*, which takes the keyboard when it opens; Esc closes it and the keyboard goes back to the page. Dry · Wet is a radio group, the presets toggle buttons, each item's switch a switch named for what it does on (*Use your CSS*, *Hide div#sidebar*, *Use “Green headline”*). The hidden elements and Duet's patches are lists; each row's Edit (*Edit div#sidebar*, expanded or not) and Remove (*Remove “Green headline”*) say whose they are, so a name cut short is whole for a screen reader. An open editor is a group (*Editing div#sidebar*) with labelled fields. The picker announces each element it hides, politely. With forced colors the card gets a `CanvasText` edge, the chosen chip and Dry · Wet `Highlight`, the item switches an edge and `Highlight` when on, the text fields a `CanvasText` edge.
- **Motion:** the card rises in like the other popover cards (`overlay`); nothing else of it moves but the switches' knobs, as Settings' do (`snappy`).

**Settings → Effects** (after Privacy):
- **Every site:** *Wet · Dry*, a segmented choice, with *Dry shows every site as it comes, and keeps your Effects.*
- **Sites**, newest change first: the site, what it has (*Your CSS · 2 hidden · Dark · 1 from Duet*, then *· 1 off* when some are switched off), a switch named *Wet* for its own Dry/Wet, and **Remove**, which asks once more in place for 5 seconds (*Remove?* **Remove** · Cancel). It lists sites, not their items: each item's switch and editor are in the site's card.
- **No sites yet:** *Sites you restyle show up here. Open a site's Effects from the page's right-click menu or the command bar.*

### 7.16 Developer tools

*Built 2026-10-25* (ARCHITECTURE.md §9). F12 or Ctrl+Shift+I (⌘⌥I on macOS) opens a tab's DevTools beside its page, as Chrome docks them, and closes them again.

```
╭────────────────────────╮ ╭──────────────────────────╮
│                        │ │ ⌨ Developer tools  ⬓ ⧉ ✕ │ ← Chord's 32 px header
│        web page        ┆ ├──────────────────────────┤
│                        ┆ │ Elements  Console  …     │ ← DevTools' own toolbar
│                        │ │                          │
╰────────────────────────╯ ╰──────────────────────────╯
                          ↑ the edge: drag to resize
```

- **Docked:** on the right of the page (to start with) or at the bottom, inside the page's frame, or its split pane. The page and DevTools are frames of their own (`radius-frame`, `shadow-frame`), 8 px apart. DevTools start 440 px wide on the right or 320 px tall at the bottom, and get no narrower than 280 px or shorter than 160 px; the page keeps at least 200 px. A pane too small for both shares what it has in that proportion.
- **The edge** between them is split view's divider: invisible until hovered, then the 4 × 32 px pill, with a resize cursor. Drag it and the page and DevTools follow live; the arrow keys move it 16 px (64 with Shift); double-click puts the size back to the default. It's a separator named *Resize developer tools*.
- **The header**, 32 px (`size-row`) on `surface`, with a hairline under it: `square-terminal` and *Developer tools* in `text-small`, `fg-muted`, then three 24 px icon buttons: **Dock to the bottom** (`panel-bottom`) or **Dock to the right** (`panel-right`), **Pop out into a window** (`app-window`), and **Close developer tools** (✕, with F12 in its tooltip). DevTools' own toolbar is under it; Chord can't add buttons to that, so its own dock-side menu isn't shown.
- **One setting**, as in Chrome: the side, the width on the right and the height at the bottom apply to every tab's DevTools, and are kept across launches. Whether they're open is each tab's own: switching tabs shows that tab's DevTools, or none.
- **In a window of their own:** *Pop out* moves them, as they are (nothing reloads), into a window with the mini window's 36 px bar: `square-terminal`, *Developer tools* and the site in `fg-muted`, then **Dock in the window** (the side's icon, on an `item-hover` pill), which puts them back beside the page and brings the tab forward. The OS's caption controls close the window, and the DevTools with it. New DevTools open the way you last chose: docked, or in a window. Inside DevTools, ⌘⇧D / Ctrl+Shift+D pops them out and docks them, as in Chrome.
- **Also:** the command bar has *Developer tools* or *Close developer tools*, *Dock developer tools at the bottom* or *on the right*, and *Pop out developer tools* or *Dock developer tools in the window*, for the tab on screen. The page's right-click **Inspect** opens them where they were and picks the element.
- **Split view:** each pane's tab can have its DevTools docked inside its own pane. The focused pane's ring goes round the page's frame.
- **Peek and mini windows:** their page's DevTools open popped out, in a plain window, as before. **Inspect Chord UI** (development builds) stays popped out too.
- **Reader view:** DevTools are the page's (behind the article), as reload and back are; docked, they sit beside the reader view.
- **Fullscreen:** a page in fullscreen covers them, and they're back when it leaves. Chord's own full screen (F11) keeps them docked.
- **Keys and focus:** opening them puts the keyboard in them. F6 counts docked DevTools as a region of their own, after the page. In DevTools, F12 closes them, reload keys reload their page, and Chord's other reserved keys work as from the page beside them; in their own window, ⌘W closes them.
- **Lifetime:** closing the tab closes its DevTools, and so does its page going (a pinned tab unloaded, a move to other sign-ins). A tab with DevTools open doesn't fall asleep, as in Chrome.
- **Motion:** when the frame changes size (the sidebar, Duet), docked DevTools glide as a picture beside the page's, their header included (ARCHITECTURE.md §5).
- **Accessibility:** DevTools' frame is a region named *Developer tools*, and its buttons are ordinary Tab stops in the shell. Windows High Contrast gives the frame a `CanvasText` edge.

---

## 8. Key flows

### 8.1 First run: your first chord in under 60 seconds

The window opens at 1200×800, centered, with the real sidebar on the left showing a placeholder chord in the OS accent hue. Onboarding cards render in the content frame. **Every choice you make shows up in the real sidebar as you make it.** That *is* the tour.

| # | Screen | Target time | Content | Exit |
|---|---|---|---|---|
| 1 | Welcome | 5 s | The mark strikes in (§2). "Hi, I'm Chord." / "A calm, colorful home for everything you do on the web." | **Make your first chord** (↵) |
| 2 | Name it | 10 s | "What's this chord for?" Text field (placeholder *Personal*) plus chips: Personal · Work · School · Side project · Home. Picking a chip fills the name and suggests an icon. The sidebar header types along. | ↵ |
| 3 | Make it yours | 15 s | The inline `ThemePicker`. Swatches first, wheel one click away. The sidebar re-themes live; *Surprise me* is right there. | **Looks good** (↵) → **Chord created** (≈ 30 s in) |
| 4 | Pin favorites *(optional)* | 15 s | "What do you open every day?" A URL field with offline autocomplete from a small built-in list of popular domains (no network). Each one lands in the sidebar with the pin animation. | **Next** · *Skip for now* (Esc) |
| 5 | Open links in Chord? *(optional)* | 5 s | "Links from Mail, Slack, and other apps will open here." Platform-specific outcome copy: on macOS the system asks to confirm; on Windows, "Windows will open Settings — pick Chord under Web browser"; on Linux it's set directly (Flatpak shows instructions). | **Make Chord my default** · *Not now* |
| 6 | Three things to know | 10 s | Three cards with live keycaps: **⌘T** Search or open anything · **⌘1–9** Jump between chords (or swipe the sidebar) · **Drag a tab up** to pin it for good | **Start browsing** → command bar opens: "Where to?" |

*As built (2026-10-24), between 3 and 4:* **Bring your bookmarks?** (optional), when another browser is on the computer: the import card from §8.7, with *Chord created* above its title, *Skip for now* (Esc) and **Import** (↵). It reads the first browser it found as the step comes up. Once the import starts, **Next** (↵) moves on while history keeps coming in, and the toast with Undo arrives in the sidebar when it's done. Whether the step is there is settled before the colors step ends, so the dots never shift under you.

*As built, between 5 and 6:* **Warn you before risky sites?** (Safe Browsing, ARCHITECTURE.md §14.5). An eyebrow with a shield, the title, and Safe Browsing's notice in full: "Chord checks the addresses you visit against Google's lists on this computer. Only when one matches does it send Google a short partial fingerprint of the address, never the address itself. Google sees your IP address when Chord fetches the lists or asks about a match. Protection isn't perfect: a dangerous site can be missed, and a safe one can be flagged by mistake." **Turn on warnings** (↵) · *Not now*. It's a choice, so Esc doesn't skip it. Builds without Google's API key leave the step out.

- *As built:* a brand-new profile starts here. Chrome's `--no-first-run` skips it, and development builds can force it with `CHORD_FIRST_RUN=1` (Playwright adds `--no-first-run` to every Electron app it drives). The page waits hidden behind the cards. Step 5 is left out when Chord is already the default, and in development builds, which can't be.
- Progress shows as a dot per step (6 to 8): filled for required steps, hollow for optional.
- Every optional step can be skipped with Esc.
- Duet is **not** part of onboarding; it sets itself up the first time you open it (§8.6).

### 8.2 Chord switching

Triggers: two-finger swipe on the sidebar (§6.4) · ⌘/Ctrl+1–9 · clicking the switcher · the command bar ("Go to Work").

1. The sidebar content slides (or follows the fingers), the tint crossfades, and the switcher pill travels.
2. At commit, the page frame shows the target chord's last-active tab, restored or lazily loaded. If that chord has no open tab, an empty state appears with the command bar hint.
3. A screen reader hears: "Work chord, 3 pinned, 7 today."
4. If the target chord uses a different profile, nothing extra happens visually. Sign-ins are simply different, by design.

### 8.3 Command bar

1. ⌘T opens it centered for a new tab; ⌘L opens it anchored on the address, to edit or search in place. Either way it's typeable in under 50 ms.
2. Results paint on the same frame as each keystroke; history and archive join within 16 ms without moving rows above them.
3. ↑/↓ move the selection; Tab completes a URL; ↵ opens (switching to an existing tab if one matches); ⌘↵ forces a new tab; Esc or a click outside closes it.
4. Actions are first-class rows: "New chord", "Pin this tab", "Copy URL", "Clear Today", "Split with…", "Edit theme", "Toggle sidebar", "Ask Duet…" (if enabled).

### 8.4 Split view

1. **Create:**
   - Drag a sidebar row onto the page. Drop zones appear over the frame (left/right halves, top/bottom, or quadrants when 3–4 panes), filled with the accent at 12% and ringed with a 2 px accent at 50%.
   - Or use the command bar: "Split with…" and pick a tab.
2. **On drop:** the frame divides with the snapshot technique (`smooth`). The sidebar row morphs into a `SplitRow`.
3. **Resize** by dragging the gaps. The focused pane follows the cursor or click; ⌘⌥[ / ⌘⌥] (Ctrl+Alt+[ / ]) moves focus. (⌘⌥←/→ is taken by chord switching.)
4. **Close a pane:** the others expand (`smooth`). A split of one dissolves back into a normal tab. Each step can be undone from a toast.
5. Splits are saved as a unit in Pinned or Today (and in folders) and come back exactly as they were. A private window can split too; like everything else there, it's never saved.
6. A split is something you set up on purpose: auto-archive skips its tabs (off screen they can still sleep, like any tab), and Clear leaves it in Today. Pinning or unpinning one of its tabs moves the whole split. To let its tabs go, close them or *Separate tabs* (Undo in a toast).

### 8.5 Peek (from pinned tabs)

A link clicked inside a pinned tab opens in Peek instead of replacing the pinned page. ↵ keeps it (*Open in Today*); Esc dismisses it. Peek's back stack is its own.

**As built:**
- Only links to another site open Peek (`docs.google.com` → `mail.google.com` stays in place). A link you follow, by click or Enter, counts; a page redirecting itself doesn't. ⌘/Ctrl-click still opens a background tab.
- Any tab can open a link in Peek from its right-click menu (*Open link in Peek*). That's how a private window peeks: it has no pinned tabs. Nothing from a private window's Peek is kept.
- Keeping it is ⌘↵ / Ctrl+Enter (plain ↵ belongs to the page). Esc, a click outside the card, or ⌘W closes it; so does switching tabs or chords.
- While Peek is open, find (⌘F), zoom, reload, back, print and copy link act on Peek's page.

**Links from other apps and link routes** (from Crest). A link another app hands Chord opens in a mini window (§7.9), or as a new tab if you choose that in Settings → General. A site can have a **link route** to a chord: its links from other apps go straight there as tabs, and so do addresses you type in the command bar, even from another chord. Chord never makes a route on its own. The second time in a session you move a site's page to the same chord, Chord asks. Moving a tab, the question is a second line on its toast: *Moved to Work* · Undo, then *Always open linear.app here?* · Always. From a mini window it's a toast of its own: *Always open linear.app in Work?* Settings → General → Link routes lists them, and you can change, add or remove one there. A route can be for part of a site, such as `github.com/acme`: those pages go to its chord, and the rest of the site follows its own route, if any.

### 8.6 Duet: first use

1. The user clicks **Duet** in the top bar or presses ⌘E / Ctrl+E. The panel opens with **Intro**:
   > **Meet Duet.** Chat about this page and your tabs, using your own Claude Code or Codex app. Chord never sees your sign-in, and nothing is sent until you press Send.
2. **Setup** (under the intro) lists what's on this computer:
   - Claude Code: *Installed 2.1.309 · Signed in* with **Use this**, or **Sign in** (opens a terminal running `claude auth login`). *Using your API key* shows when that's what pays.
   - Codex: *Not installed* · **How to install**.
   - On Windows, one installed only inside WSL is named for it: **Claude Code in WSL (Ubuntu)**, with the same line and buttons. While Chord looks there, the line says *Looking in WSL…*. With no WSL, nothing about it shows.
   - A version too old to say whether it's signed in: *Installed 1.0.34 · Needs an update* · **How to update**.
   - **Check again** re-detects. The user picks one and is done; it can be changed any time from the model chip or Settings.
3. **First-use note**, once: "What you attach goes to Claude Code through your own account. Duet reads only what's attached to your message, unless you let it see more. It never sees what you type into forms." **Got it**.
4. **Ready, empty:** "Ask about this page, your tabs, or anything you're working on." Chips: *Summarize this page* · *What should I know before I decide?* · *Compare with my other tabs*.
5. **First answer:** citations link back into the page; tool activity is visible; reading beyond what's attached asks first (by default).
6. **Turning it off:** Settings → Duet → *Show Duet* removes the panel, the button and the shortcut. *Turn off in this chord* (Chats menu) does it for one chord.

### 8.7 Import from another browser

*Built 2026-10-24* (ARCHITECTURE.md §9). Two places, one panel (`shared/ImportPanel.tsx`): first run's **Bring your bookmarks?** step (§8.1) and **Settings → Import**, between Extensions and Duet. Each wraps it in its own title and buttons.

1. **Pick a browser.** A radio group, *Import from*, one row per profile: *Chrome*, or *Chrome · Work* when a browser has several profiles, *Firefox (Flatpak)* for a sandboxed copy. Safari without Full Disk Access is listed with *Needs Full Disk Access* beside it. First run starts on the first browser Chord can read; Settings waits for a pick. While Chord reads: *Reading Chrome…*.
2. **See what it holds,** before anything is imported: one line in `text-label`, *1,204 bookmarks in 18 folders · 34,551 pages of history · 6 open tabs*. For Chrome, Edge and Brave a quieter line under it: *Open tabs stay in Chrome: Chord can't read them reliably.*
3. **Say where it goes.** A card, *Where they go*, one row per group, each with a native select (`radius-sm`, `item-hover`) named *Where Recipes goes*:
   - **The bar's own links** (*12 links of its own*): **Favorites** (to start with), a new chord, a chord you have, or *Don't import*. Favorites takes up to 24; the rest stay together in a folder named after the bar.
   - **Each top-level folder** (*42 bookmarks*): **New chord "Recipes"**, a chord you have, or *Don't import*. A new chord is named after the folder, gets the folder's first letter as its icon and the next preset's colors, and the folder's contents become its Pinned. In a chord you have, the folder lands as one pinned folder at the end of Pinned. Imported folders start closed. The first six folders start as new chords; the rest, the chord you're in.
   - **Other roots' own links** (Other bookmarks, the Bookmarks Menu): a folder in the chord you're in, to start with.
   - **Open tabs** (*6 tabs, into Today*), where the browser's files can be read: a chord's Today, at the top, unloaded until you open them, or *Don't import*.
   - **History** (*34,551 pages, for search in every chord*): a switch, on to start with. It isn't tied to a chord, like the rest of Chord's history.
   The card holds five rows and scrolls past that, so the buttons stay in view. A private window's chord is never offered.
4. **Import.** First run's **Import** is the accent pill (↵); Settings' is a quiet pill. Bookmarks and tabs land in the sidebar in a moment, then history comes in under a 4 px accent bar that fills as it goes: *Adding history: 12,500 of 34,551 pages*. Then *Imported 6 tabs, 1,204 bookmarks and 34,551 pages of history.*, and the window's toast says the same, *from Chrome*, with **Undo**. Settings has **Undo** and **Import more** beside the line too, since it may be covering that window. Undo takes back everything the import added, history included, even while it's still running: *Import undone.*
5. **Always under the panel**, in `text-small`: *Chord never copies passwords, cookies or extensions. Your password manager can bring passwords across, or use the browser's own export.*

When a browser can't be read, the panel says why in plain words, in a soft card with one button:

| Problem | Copy | Button |
|---|---|---|
| Safari without Full Disk Access | Chord needs Full Disk Access to read Safari. In System Settings, open Privacy & Security, then Full Disk Access, turn on Chord, and quit and reopen Chord. | Open System Settings |
| The browser holds its files (Windows) | Chrome is holding its files. Quit Chrome, then try again. | Try again |
| A damaged or unknown file | Chord couldn't read Chrome's files. | Try again |
| Another import still running | Another import is still running. Try again when it's done. | Try again |
| The profile has gone since Chord looked | That browser profile isn't there any more. | — |

With no other browser on the computer, first run leaves the step out, and Settings says *No other browsers found. Chord looks for Chrome, Edge, Brave and Firefox* (*…, Firefox and Safari* on a Mac).

---

## 9. Empty states and copy

| Where | Title | Body | Action |
|---|---|---|---|
| New chord, nothing yet | Fresh chord, fresh start. | Pin the sites you live in. Everything else lands in Today and tidies itself away after 12 hours. | New tab ⌘T |
| Pinned section empty | — | Drag a tab here to keep it. (shown inline in `text-small`, muted) | — |
| Archive empty | Nothing archived yet. | Tabs you haven't used in a while get tucked in here, so you can always find them again. | — |
| No search results | No matches for "…" | — | Search the web for "…" ↵ · Open "…" as an address |
| Duet, no threads | Ask about this page, your tabs, or anything you're working on. | — | three contextual chips |
| Page crashed | This page stopped working. | It's not you. Reloading usually fixes it. | Reload |
| Offline | You're offline. | Pages you have open will keep working; new ones will load when you're back. | Try again |

**Safe Browsing** (ARCHITECTURE.md §14.5). Google's terms shape the words: a warning never says a site *is* unsafe, only that it *may* be, and that it's on Google's list of *suspected* ones; it links to Google's page about the threat, and credits Google.

| Where | Title | Body | Action |
|---|---|---|---|
| A page on the phishing list | This site may be trying to trick you. | example.com is on Google's list of suspected phishing sites. Sites like this pretend to be someone you trust to get your passwords, card numbers or other details. | **Back to safety** |
| On the malware list | This site may harm your computer. | …on Google's list of sites suspected of spreading malware: software that can steal your information or damage your files. | **Back to safety** |
| On the unwanted-software list | This site may try to install unwanted software. | …on Google's list of sites suspected of offering programs that change your browser or computer without asking. | **Back to safety** |
| A frame on a list | (the title for its list) | "Part of this page comes from ads.example, which is on Google's list of…" | **Back to safety** |
| A held download (downloads panel) | the file's name | This file may be malware. Chord paused it. | **Delete** · *Keep anyway* |

- **The warning page** sits in the content frame where the page would be, like a load error (§7.1 `SafeBrowsingWarning`), on the frame's `surface`, centered, at most 480 px wide. Top to bottom:
  - A 48 px `danger` disc at 14% under a 24 px `shield-alert` in `danger`: the one place the danger color is this large. Status is never color alone: the title says it.
  - The title in `text-heading`, the body in `fg-muted`.
  - *Learn more about phishing* (or malware, or unwanted software): a link to Google's page, in `accent`, opening as a tab beside this one.
  - **Back to safety**: the accent pill, the only filled button. It shows the page you were on before, or closes the tab when there's none.
  - *Details* (a disclosure, closed): "If you trust this site, you can visit it anyway. Chord won't warn you about example.com again until you quit." and a quiet *Visit anyway* pill. Never one click from the main button.
  - *Advisory provided by Google*, in `text-micro`, `fg-subtle`, linked to Google's advisory. Always shown.
- **The held download** in the downloads panel: the row's file icon becomes `shield-alert` in `danger`; the line under the name says what's suspected; **Delete** is the accent pill and *Keep anyway* a text button; *Learn more…* and *Advisory provided by Google* sit under them in `text-micro`. The panel opens on it by itself, in the window the download came from.
- **Settings → Privacy → Safe Browsing:** one row, *Warn before suspected phishing and malware*, with the notice as its description (so it's read beside the switch, before it's on), and under it, once on, how Google's lists are doing ("999,877 entries on this computer, updated 3 minutes ago."). In Google-free mode the row says it's off and why; in a build without the key, that it isn't in this build. A note under the group: "Safe Browsing by Google." No ↺: a new profile turns it on in first run, so there's no single default to go back to.
- **The one-time offer**, for profiles from before Safe Browsing: a card in the popover at the frame's top-right, like a permission prompt, with a shield, *Warn you before risky sites?*, the notice, and *Not now* · **Turn on**. Either answer is final; Settings can change it.

**Ad and tracker blocking** (ARCHITECTURE.md §9). On by default, so it asks nothing first; it says what the lists' host sees where you'd look for it, beside the switch.
- **Settings → Privacy → Ads and trackers** (as built 2026-10-24), after Google-free mode: *Block ads and trackers*, with the notice as its description ("Chord checks what pages load against EasyList and EasyPrivacy, two public lists it keeps on this computer…") and ↺ once it's off. Under it, while on: *The lists* ("EasyList from Oct 24, 2026 and EasyPrivacy from Oct 24, 2026, checked for updates 3 hours ago."), then *Don't block on*, a field taking a site's name or any address on it, and the sites it's off for, one row each with an ✕ that blocks there again. A note under the group credits the EasyList authors and says private windows are filtered too.
- **A page's right-click menu**, at the end of its page section: *Block ads on this site*, a checkmark item, checked while blocking applies there. Unchecking it reloads the site's pages on screen once the change is in, with ads, and a toast offers Undo. Left out when blocking is off or the page isn't a web page. In a private window, turning a site off lasts as long as the window.
- **A site** is its registrable domain, subdomains included: turning it off on `cooking.nytimes.com` turns it off on `nytimes.com`.

**Toast copy:**
- "Tab closed · Undo"
- "Archived 4 tabs · Undo"
- "Deleted folder 'Reading' · Undo"
- "Deleted 'Work' chord · Undo"
- "Moved to Personal (sign-ins differ, so it reloaded) · Undo"
- "Not blocking ads on nytimes.com · Undo" · "Blocking ads on nytimes.com again · Undo"
- "Moved to Work (sign-ins differ, so it reloaded and is no longer shared) · Undo" · "Stopped sharing “Slides”: it moved to other sign-ins, so it loaded again" (these two show in presenting mode too, §7.13)
- "Filled 5 fields on example.com · Undo" (Duet's fill card, §7.8)

Empty states get a small abstract illustration in the chord's own colors (three soft shapes echoing the mark), animated once with `gentle`. They never look like stock art.

---

## 10. Accessibility

- **Keyboard:**
  - F6 cycles regions: sidebar → page → Duet → top strip.
  - The sidebar is an ARIA `tree`: arrows move, → / ← expand and collapse, ↵ activates, ⌘⌫ closes.
  - The Space key picks up a row for keyboard drag-and-drop; arrows move it, Space drops it, Esc cancels.
  - The command bar is a `combobox` controlling a `listbox`.
- **Focus:** always visible on keyboard focus. The ring is 2 px in the OS accent with a 2 px offset (inset inside rows so it isn't clipped).
- **Contrast:**
  - Guaranteed by the theme generator (§5.2): ≥ 4.5:1 for all text, ≥ 3:1 for UI glyphs and focus.
  - Status is never shown by color alone (icon or text too).
- **Screen readers:**
  - Live region announcements for toasts, chord switches, and Duet completions ("Duet finished answering").
  - Every icon button is labeled.
- **System settings respected:**
  - Reduce motion (§6.6).
  - Reduce transparency: solid sidebar.
  - Windows High Contrast / `forced-colors`: tints off, system colors on.
  - Text scaling via Chord's zoom setting (shell UI 90–150%).
- **Targets:** at least 24×24 px (WCAG 2.2 AA); sidebar rows are 32 px tall.

*As built (M1.6, the accessibility pass):*

- **F6 / ⇧F6** go sidebar → page → (its docked developer tools, §7.16) → (find bar or permission prompt) → Duet → top strip. Main knows which view has the keyboard; the shell picks the next region it shows and asks main to focus the page, the popover or itself (`focus:region`, `focus:move`). Coming back to a region lands where you left it; the first time, on the tab on screen, Duet's message field, or the address. The command bar and Peek are modal: F6 stays out.
- **The sidebar** is two ARIA trees, Pinned and Today. Each row is a `treeitem` named by its title, with level, position and size (rows are drawn flat, indented by depth). Each tree is one Tab stop: the row last focused, else the tab on screen. Arrows, Home and End move; → / ← open, enter and close folders and splits; ↵ opens; Space picks a row up; Delete or ⌘⌫ closes. Picking up, moving and dropping are announced. A row's own buttons (×, ↩, Stop sharing, the speaker, a split's chevron) are for the pointer; the keyboard has Delete and the row's menu (Shift+F10 or the menu key), which now also offers Stop sharing (*Stop sharing this tab* on a shared tab's row), Back to pinned page and Mute tab. A row's description says when its tab is playing sound or muted.
- **Now playing** (§7.10) is a group outside the trees, with ordinary buttons: one Tab stop each, named for what they do. So is presenting mode's card (§7.13), *Presenting mode*, with Turn off.
- **Composite widgets share one pattern** (`shared/a11y.ts`): radio groups, the chord switcher (tabs: ← → switch chords) and Duet's scope are one Tab stop, and arrow keys move and choose. Menus (Duet's model and Chats menus, Attach a tab) open on their first item, take ↑ ↓ Home End, and close on Esc or Tab with the keyboard back on their button. Popovers, pickers and in-place editors give the keyboard back to where it came from when they close.
- **The command bar** is a modal dialog: a `combobox` (expanded while it has results) owning the `listbox` "Results", with the active option followed by `aria-activedescendant`. Esc gives the keyboard back where it came from (the sidebar row, or the page). Split with…, Separate split tabs and the pane moves are among its actions. The downloads and extensions panels take the keyboard when they open.
- **Settings:** every row's description is read with its control; every ↺ is named for its setting ("Reset Search suggestions to default") and, once used, hands the keyboard to the setting it reset.
- **Duet** says "Duet finished answering." once a reply is done, rather than reading it as it streams: the conversation is a `log` with `aria-live="off"` and `aria-busy` while it streams. Opening the panel (⌘E too) puts the keyboard on its first step; closing it gives it back.
- **Announcements** go through one polite live region in the shell: chord switches ("Work chord, 3 pinned, 7 today"), Duet, onboarding steps and keyboard moves in the sidebar.
- **Windows High Contrast** (`forced-colors: active`): tints and grain are off; what's chosen (the tab on screen, the current chord, a checked option, a switch that's on, the selected command bar result) is `Highlight` with `HighlightText`; focus is a ring in `CanvasText` just outside the control; the focused split pane is ringed in `Highlight`; floating surfaces get a `CanvasText` edge. Color swatches, orbs and the wheel's handles keep their colors, since colors are what they show.
- **Interface size** (Settings → Appearance → Interface: 90, 100, 110, 125 or 150%) zooms every view of Chord's own UI: the sidebar and bars, the command bar, Peek's card, Duet, Settings, and the mini window's bar. Pages keep their own zoom (⌘= / ⌘−), and extension popups keep their size, opening from their button wherever it now is. Main works in the shell's CSS pixels and converts to window pixels only where it places a native view (`toWindowRect`), so each page sits exactly on the frame the shell draws, at every size. The caption buttons keep their native size, in a strip as tall as Chord's at that size; on macOS the traffic lights stay centered in the header. Every open window follows a change at once, and the size is kept across restarts. `test/e2e/interface-size.spec.ts`; captures at 100, 125 and 150% from `scripts/dev/qa-ui-scale.mjs`.
- **Reduce transparency** is read from `nativeTheme.prefersReducedTransparency`, at launch and whenever it changes: the window drops Mica or vibrancy for a solid background, and the theme composites over a solid base (§5.2 step 4).
- **Tests:** `test/e2e/a11y.spec.ts` runs axe on every surface in light and dark across the capture matrix's themes, and computes contrast from the theme tokens where axe can't see through the tint; it also checks the screen-reader structure (aria snapshots), forced colors (with captures), reduced motion both ways and reduced transparency. `test/e2e/keyboard.spec.ts` walks every key flow in §8 with real focus.

---

## 11. Platform adaptations

| | macOS | Windows | Linux |
|---|---|---|---|
| Window controls | Traffic lights in the sidebar header | Native caption buttons (WCO) in a 40 px strip, with Snap Layouts | WCO in a 40 px strip; button side and icons follow the desktop's settings |
| Material | Vibrancy (`sidebar`) under the tint | Mica on Windows 11 22H2+; solid on 10 or if Mica misbehaves | Solid tint + grain |
| Modifier and keycaps | ⌘ ⌥ ⇧ ⌃ glyphs | Ctrl+Shift+T text | Ctrl+Shift+T text |
| Minimal bar (§3.3) | Traffic lights · ◧ · nav · address · Duet | ◧ · nav · address · Duet · caption buttons | Same as Windows; if the desktop puts caption buttons on the left, they lead the bar |
| App menu | Native menu bar | ≡ button opening a native menu | ≡ button opening a native menu |
| Context menus | Native | Native | Native |
| `radius-frame` | 12 | 8 | 12 |
| Accent | OS accent → focus ring and the first chord | same | same (Electron 39+) |
| Scrollbars | Overlay | Thin, auto-hiding in the sidebar; native in pages | Thin, auto-hiding in the sidebar; native in pages |
| Swipe between chords | Trackpad, phases from Chromium | Precision touchpad (end-on-idle fallback) | libinput (end-on-idle fallback) |

---

## 12. Design QA

Every UI change gets the following before it reaches you:

1. **Capture matrix (CI artifacts).** {macOS, Windows, Linux X11, Linux Wayland} × {light, dark} × {Graphite, Coral, Aurora} for every touched surface. It also covers onboarding steps, empty states, the command bar open, and a toast.
2. **Self-review against this doc.** I check each capture for:
   - Tokens only (lint-enforced).
   - The 4 px grid (overlay on).
   - The type scale.
   - Contrast (generator plus spot-check).
   - Focus visibility.
   - Platform conventions (§11).
   - Principle tests (§1).

   Issues get fixed before you see anything.
3. **Motion check.**
   - New or changed interactions get a trace test: no Long Animation Frames over budget.
   - A screen recording, checked frame by frame on the Windows 144 Hz display.
   - macOS feel (vibrancy, trackpad, ProMotion) goes on your by-hand checklist, because there's no local Mac.
4. **Per-platform by-hand checklist** in each update to you, listing only what differs by OS.

---

## 13. Open design questions

1. ~~**Duet shortcut**~~ **Decided in Phase 2:** ⌘E / Ctrl+E, **page-first**. Google Docs and other editors that use it keep it; everywhere else it toggles Duet. It can be changed in Settings → Keyboard shortcuts.
2. **Sidebar toggle shortcut.** Proposed in §14: ⌘S / Ctrl+S, page-first (Google Docs and other editors keep their own ⌘S), with Save page on ⌘⇧S. Also: *peek on hover* in minimal mode, with a switch (off by default since 2026-10-25).
3. **Favorites row.** Arc's favicon grid sits above the chord and is shared across chords. It isn't in the brief. Add it as a later-phase item, or leave it out?
4. **Top strip on Windows/Linux.** Show the page title next to the domain, or only the domain (calmer)? I lean domain only, with the title on hover.
5. **Default grain.** Decided 2026-10-22: 0.2, with a soft fractal tile (the first per-pixel tile read as static).
6. **Density.** Ship a *Compact* option (28 px rows) in v1, or later?
7. **Sounds.** None by default. Agreed?

---

## 14. Keyboard shortcuts

Hotkeys are a first-class feature. Every action in Chord is reachable from the keyboard, and the common ones work without thinking.

### 14.1 Rules

1. **Chrome muscle memory first.** If Chrome has a shortcut for something Chord does, Chord uses the same keys.
2. **Two kinds of shortcut:**
   - **Reserved (R):** Chord always gets the key, even while a page has focus. These are the keys Chrome also refuses to give pages (new and close tab or window, tab switching), plus Chord's core keys (⌘L, ⌘1–9).
   - **Page-first (P):** the page sees the key first. If it uses it (Google Docs' ⌘S, a web editor's ⌘D), Chord stays out of the way. If not, Chord acts.
3. **Hands off keys web apps depend on.** Chord never *reserves* ⌘K, ⌘E, ⌘B, ⌘I, ⌘U, ⌘↵ or ⌘/. A page-first binding is allowed only where Chrome already has one, like Ctrl+U for view source on Windows/Linux, and the page still wins.
4. **Discoverable.** Every action is in the command bar with its keycaps shown. The full cheat sheet is one shortcut away.
5. **One registry.** `packages/core/src/shortcuts.ts` defines each shortcut once: id, macOS keys, Windows/Linux keys, kind, action. It generates the macOS menu bar, the reserved-key interceptor, keycaps, the cheat sheet, and the tables below. A test fails on any duplicate per platform.
6. **Every key is yours to change** (Settings → Keyboard shortcuts):
   - **Editing:** click a keycap to record a new one ("Press keys…"), or **+** to add another (up to four per action). Esc cancels, and Delete removes that key. ↺ puts one action back, and **Reset all** asks a second time in place.
   - **Conflicts are settled in the row.** "⌘K is used by *Search tabs*" offers **Use it here**, which moves the key, or Cancel. Never a dialog.
   - **Refused, with the reason in one plain sentence:**
     - a key with no ⌘/⌃/⌥ (Ctrl/Alt elsewhere), unless it's F1–F24;
     - what the OS keeps for itself: Spotlight's ⌘Space, ⌘Tab, Force Quit, Alt+Tab, Ctrl+Alt+Delete, Windows and Super key combinations, and the rest in `bindings.ts`;
     - text editing's ⌘C/V/X/A/Z (and Ctrl+Y off macOS).
   - **What changing keeps:** the action's kind (reserved or page-first) and its place in menus. Only the keys change, and they apply at once everywhere: the router, the menus, every keycap and tooltip, the command bar and onboarding.

### 14.2 The map (Phase 1 unless marked)

**Address and search**

| Action | macOS | Windows & Linux | Kind |
|---|---|---|---|
| Edit the address or search, in place | ⌘L | Ctrl+L · Alt+D | R |
| New tab (centered command bar) | ⌘T | Ctrl+T | R |
| Copy page address | ⌘⇧C | Ctrl+Shift+C | P |
| Copy as Markdown link | ⌘⌥⇧C | Ctrl+Alt+Shift+C | P |

**Navigate**

| Action | macOS | Windows & Linux | Kind |
|---|---|---|---|
| Back | ⌘[ · ⌘← | Alt+← | P |
| Forward | ⌘] · ⌘→ | Alt+→ | P |
| Reload | ⌘R | Ctrl+R · F5 | R |
| Reload, skipping the cache | ⌘⇧R | Ctrl+Shift+R · Ctrl+F5 | R |
| Stop loading | Esc | Esc | P |

**Tabs**

| Action | macOS | Windows & Linux | Kind |
|---|---|---|---|
| Close tab (a pinned tab unloads and stays pinned) | ⌘W | Ctrl+W · Ctrl+F4 | R |
| Reopen closed tab | ⌘⇧T | Ctrl+Shift+T | R |
| Recent tabs: hold ⌃ / Ctrl, press Tab to cycle | ⌃Tab · ⌃⇧Tab | Ctrl+Tab · Ctrl+Shift+Tab | R |
| Next / previous tab in the sidebar | ⌘⌥↓ · ⌘⌥↑ | Ctrl+PageDown · Ctrl+PageUp | R |
| Move tab down / up in the sidebar | ⌘⌥⇧↓ · ⌘⌥⇧↑ | Ctrl+Shift+PageDown · Ctrl+Shift+PageUp | R |
| Pin / unpin tab | ⌘D | Ctrl+D | P |
| Mute / unmute tab | ⌃M | Ctrl+M | P |

**Chords**

| Action | macOS | Windows & Linux | Kind |
|---|---|---|---|
| Go to chord 1–9 | ⌘1 … ⌘9 | Ctrl+1 … Ctrl+9 | R |
| Next / previous chord | ⌘⌥→ · ⌘⌥← | Ctrl+Alt+→ · Ctrl+Alt+← | R |

**Window and view**

| Action | macOS | Windows & Linux | Kind |
|---|---|---|---|
| New window | ⌘N | Ctrl+N | R |
| New private window | ⌘⇧N | Ctrl+Shift+N | R |
| Close window | ⌘⇧W | Ctrl+Shift+W | R |
| Show / hide the sidebar (minimal mode) | ⌘S | Ctrl+S | P |
| Presenting mode, on or off (§7.13; 2026-10-24) | ⌘⇧P | Ctrl+Shift+P | P |
| Find in page | ⌘F | Ctrl+F | P |
| Show / hide reader view (§7.11) | ⌘⌥R | F9 | P |
| Effects on this site: dry or wet (§7.15; 2026-10-25) | ⌘⇧E | Ctrl+Shift+E | P |
| Find next / previous | ⌘G · ⌘⇧G | F3 · Shift+F3 | P |
| Zoom in / out / actual size | ⌘= · ⌘− · ⌘0 | Ctrl+= · Ctrl+− · Ctrl+0 | P |
| Full screen | ⌃⌘F | F11 | R |
| Move focus: sidebar → page → address (→ Duet) | F6 · ⇧F6 | F6 · Shift+F6 | R |
| Print | ⌘P | Ctrl+P | P |
| Take a screenshot (§7.12) | ⌘⇧2 | Ctrl+Shift+2 | R |
| Save page as | ⌘⇧S | Ctrl+Shift+S | P |

**Chord's own pages and tools**

| Action | macOS | Windows & Linux | Kind |
|---|---|---|---|
| Settings | ⌘, | Ctrl+, | P |
| History and archive | ⌘Y | Ctrl+H | P |
| Downloads | ⌘⇧J | Ctrl+J | P |
| Keyboard shortcuts | ⌘⌥/ | Ctrl+Alt+/ | P |
| Developer tools | ⌘⌥I | F12 · Ctrl+Shift+I | R |
| View page source | ⌘⌥U | Ctrl+U | P |
| Quit | ⌘Q | Ctrl+Shift+Q (Linux); Alt+F4 closes the window (Windows) | R |

**Later phases**

| Action | macOS | Windows & Linux | Phase |
|---|---|---|---|
| Show / hide Duet (page-first) | ⌘E | Ctrl+E | 2 |
| Focus the pane left / right in a split | ⌘⌥[ · ⌘⌥] | Ctrl+Alt+[ · Ctrl+Alt+] | 2 |
| Split with… (the command bar picks what opens beside the current tab) | ⇧⌘\ | Ctrl+Shift+\ | 2 |
| Separate split tabs | (menus and the command bar) | (menus and the command bar) | 2 |
| Peek: keep as a tab · close | ⌘↵ · Esc | Ctrl+↵ · Esc | 3 |
| Mini window: move into a chord | ⌘↵ | Ctrl+↵ | 3 |

### 14.3 Inside surfaces

- **Command bar:**
  - ↑ ↓ move; ↵ opens (switching to the tab if it's already open).
  - ⌘↵ opens in a new background tab, ⇧↵ in a new window, ⌥↵ in a split (Phase 2).
  - Tab accepts the inline completion, or after a site keyword (`yt`, `gh`, …) switches to searching that site.
  - `@tabs`, `@pinned`, `@history`, `@archive`, `@chords` and `@actions` narrow results.
  - ⇧⌫ / Shift+Delete removes the selected history suggestion (Chrome's key).
  - ⌘C / Ctrl+C with no text selected copies the selected result's address.
  - Esc closes; in ⌘L mode it also restores the address.
- **Developer tools** (§7.16): ⌘⇧D / Ctrl+Shift+D pops them out or docks them; F12 (⌘⌥I) closes them; ⌘R / Ctrl+R reloads their page.
- **Sidebar** (focused via F6 or a click):
  - ↑ ↓ move; ← → fold and unfold folders.
  - ↵ opens; F2 renames; ⌘⌫ / Delete closes.
  - The Space key picks up a row, arrows move it, Space drops it, Esc cancels.
- **Mouse:**
  - Middle-click a tab row to close it; a pinned tab unloads.
  - ⌘-click / Ctrl+click or middle-click a link to open it in Today in the background; add ⇧ to switch to it.
  - ⇧-click a link to open it in a new window.
  - Mouse back and forward buttons navigate.

### 14.4 Known trade-offs

- **⌘1–9 switches chords**, as the brief asks, so Chrome's "go to tab N" isn't available.
- **Ctrl+Tab cycles recent tabs** (Arc's behavior) rather than Chrome's next-in-order. Next-in-order is on Ctrl+PageDown, and a setting can swap them.
- **Copy page address takes Ctrl+Shift+C**, which Chrome uses to inspect elements on Windows and Linux. In Chord, open DevTools (F12) first; its element picker answers to Ctrl+Shift+C there.
- **On GNOME, Ctrl+Alt+←/→ switches workspaces** before Chord sees it. Use Ctrl+1–9, the trackpad swipe, or give Next/Previous chord other keys in Settings → Keyboard shortcuts.
- **Page-first keys depend on the page.** In Google Docs, ⌘S does Docs' thing, not the sidebar. That is deliberate: web apps keep working, and the command bar and View menu always reach the same action.
