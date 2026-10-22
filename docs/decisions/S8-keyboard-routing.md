# S8: Keyboard routing

**Result: pass on Windows and Linux X11 (CI, x64 and arm64). macOS and Wayland are checked by hand.**

**Decision:** reserved keys go through `before-input-event`; page-first keys are app-menu accelerators (DESIGN.md §14).

## Evidence (2026-10-22, Windows 11, Electron 45.0.0)

Setup: WebContentsView tabs inside a BaseWindow with `titleBarStyle: 'hidden'`. The application menu is set with `Menu.setApplicationMenu` and never shown as a bar. Keys were injected into the page with `webContents.sendInputEvent`, which takes the same route as real keys: the browser's pre-handler, then the renderer, then the window's accelerators for keys the page left alone.

| Case | Expected | Seen |
|---|---|---|
| Page ignores Ctrl+S (page-first: toggle sidebar) | Chord's menu accelerator fires | Sidebar collapsed |
| Page calls `preventDefault()` on Ctrl+S | Page keeps it; Chord does nothing | Page handled it, sidebar unchanged |
| Ctrl+T (reserved), page focused | Chord gets it before the page | Command bar opened |
| Ctrl+W (reserved, also a menu accelerator) | Fires once, not twice | Exactly one tab closed |

- The menu bar never appears. Accelerators still work on Windows with the hidden title bar.
- The E2E test `page-first keys reach Chord only when the page passes; reserved keys fire once` repeats these checks on every CI platform except macOS.
- Secondary page-first keys are hidden menu items that carry the extra accelerators. Today only macOS has any: ⌘← and ⌘→ for Back and Forward. Electron's `acceleratorWorksWhenHidden` defaults to true there. Secondary keys on Windows and Linux are all reserved (F5, Alt+D, Ctrl+F4), so `before-input-event` handles them.

## Why macOS is checked by hand

On macOS, keys a page leaves alone go back to the menu as the original `NSEvent`. Injected keys have no `NSEvent`, so the menu never sees them, and a CI test would fail even though real keys work.

## Still to check (by hand)

- **macOS:**
  - ⌘S with a page focused toggles the sidebar.
  - In a page that saves on ⌘S (Google Docs, for example), the page wins.
  - ⌘W closes exactly one tab.
- **Linux, Wayland:** the same three checks with Ctrl, on real keys. In CI under headless Weston, the page-first check fails: Ctrl+S never reaches the menu, while reserved keys work. The likely cause is that headless Weston never activates the window, and accelerators only fire for an active one, but that's unverified. The test is skipped on Wayland until a real session confirms it.
