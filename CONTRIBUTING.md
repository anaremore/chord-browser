# Contributing to Chord

Thanks for helping. Chord is early, so expect things to move quickly.

## Before you start

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [DESIGN.md](DESIGN.md). Every UI change is reviewed against DESIGN.md, and every library or API choice against ARCHITECTURE.md.

## Setup

Requires Node.js 24 and pnpm 10.

```sh
pnpm install
pnpm dev          # run Chord with hot reload
pnpm test         # unit tests
pnpm typecheck
pnpm lint
```

## Ground rules

- **Every feature works on Windows, macOS, and Linux (X11 and Wayland).** CI runs on all of them.
- **No hardcoded design values.** Colors, spacing, radii, type, shadows, and motion come from `packages/tokens`. Lint enforces this.
- **Undo, not confirmation dialogs**, for anything destructive.
- **Web content never gets Node or IPC access.** New IPC channels are declared in `packages/ipc` with a schema and an allowed caller role.
- **Tests come with the change.** Logic gets unit tests; user flows get E2E tests.
- **Commits** use [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`, `chore:`, …).

## Screenshots

The README's screenshots come from `scripts/dev/readme-shots.mjs`, on Windows. From `apps/desktop`, run `pnpm build`, then `node ../../scripts/dev/readme-shots.mjs`. It uses a throwaway profile and public pages, captures only the Chord window it launched (never the screen), and writes `docs/images/`. Retake them when the UI they show changes.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE). Changes to `packages/core/src/rank.ts`, which is adapted from Crest, stay under the [Mozilla Public License 2.0](LICENSES/MPL-2.0.txt), as its header says.
