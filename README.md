# Chord

A calm, colorful, open-source browser for people leaving Arc. Chord keeps the sidebar-first workflow: pinned tabs, Today tabs, Spaces with their own colors, a command bar for everything. It has no account, no telemetry, and no lock-in.

Windows, macOS, and Linux (X11 and Wayland) are all first-class.

> **Status: early development.** Nothing to install yet. The first preview (0.1) is planned for mid-December 2026, ahead of Arc's shutdown on December 22. See the [roadmap](ROADMAP.md).

## What's planned

- **Vertical sidebar:** pinned tabs that remember their home page, Today tabs that tidy themselves into an archive, nestable folders, and drag-and-drop everywhere.
- **Spaces:** separate sets of tabs, each with its own color theme and, optionally, separate sign-ins. Switch with ⌘/Ctrl+1–9 or a swipe.
- **Command bar** (⌘/Ctrl+T): one place to search open tabs, pinned tabs, history, the archive, and actions.
- **Minimal mode:** collapse the sidebar and Chord shrinks to one slim bar.
- **Chrome extensions**, including password managers.
- **Pop-out video:** a playing video floats into picture-in-picture when you switch tabs.
- **Later:** split view, Peek, a mini window for links from other apps, and **Duet**, an opt-in panel for chatting about your tabs with your own Claude Code or Codex app.

## Documents

- [ARCHITECTURE.md](ARCHITECTURE.md): how Chord is built, and why.
- [DESIGN.md](DESIGN.md): principles, design tokens, motion, components, and key flows.
- [ROADMAP.md](ROADMAP.md): phases and milestones.

## Building from source

Requires Node.js 24 and pnpm 10.

```sh
pnpm install
pnpm dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

[Mozilla Public License 2.0](LICENSE).
