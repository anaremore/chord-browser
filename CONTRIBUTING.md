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

## Running E2E without windows

`pnpm --filter @chord/desktop test:e2e` opens dozens of real Chord windows, which take focus while they work. To run the suite out of sight, run it in a Linux container on a virtual display, the way CI's Linux jobs do:

```sh
pnpm test:e2e:linux                          # the whole suite on X11: Xvfb with openbox
pnpm test:e2e:linux --wayland                # on Wayland: headless Weston
pnpm test:e2e:linux launch.spec.ts -g "Peek" --repeat-each 5
```

It needs Docker. On Windows that's Docker Engine in a WSL 2 distro, with your user in its `docker` group; nothing else goes in WSL, as Node, pnpm and the display servers are in the image. Set `CHORD_E2E_WSL_DISTRO` if Docker isn't in your default distro. On Linux and macOS it uses the `docker` on your PATH. `pnpm --filter @chord/desktop test:e2e:linux` works too.

- **What it tests:** your working tree as it is, from whichever worktree you run it in, uncommitted changes included: tracked files, and untracked ones that aren't ignored. They're copied into a fresh container, which installs and builds there. Your own `node_modules` and `out` are never used.
- **Arguments** go to Playwright (spec files, `-g`, `--repeat-each`, `--workers`, `--reporter`, …), apart from `--wayland`/`--x11` and `--rebuild`, which rebuilds the image with fresh Ubuntu packages. Every app in a run shares one display, as on CI, so keep `--workers` at 1 for anything about focus.
- **Results** land where a local run leaves them: `apps/desktop/test-results` (failure details, `captures/`, `perf.json`), and `apps/desktop/playwright-report` if you asked for the html reporter.
- **Several runs at once** are fine. Each one gets its own container (`chord-e2e-run-<worktree>-<random>`), and they share the caches.
- **Cost:** the first run builds the image (`chord-e2e-runner:<hash>`, 1.4 GB, about 2 minutes) and fills the pnpm store and Electron download caches (the volumes `chord-e2e-pnpm-store` and `chord-e2e-electron-cache`, 440 MB, from 10 seconds to a couple of minutes, depending on the registry): about 11 minutes in all for the whole suite. After that, installing and building take about 20 seconds, and the whole suite about 9 minutes (CI's Linux jobs take about 10). The image is rebuilt only when `scripts/e2e-linux/Dockerfile` changes.
- **Where things go:** on Docker's own disk (on Windows, WSL's), never in Windows' temp folder. The copy of your tree, its `node_modules`, the build, and the test profiles in the run's temp folder (`test/run-temp.ts`) all live in the run's container. The caches are Docker volumes. Only the results come back to your tree.
- **Cleaning up:** a run removes its own container, even when stopped with Ctrl+C, and removes any container a killed run left behind that has been stopped for 10 minutes. To free the space: `docker volume rm chord-e2e-pnpm-store chord-e2e-electron-cache`, and `docker image rm` the tags `docker image ls chord-e2e-runner` lists.
- **The sandbox stays on.** Chromium's sandbox needs unprivileged user namespaces, so the container runs as an ordinary user with no capabilities, with Docker's seccomp profile (which blocks namespaces) turned off. `scripts/e2e-linux/run.mjs` says why that's the choice.
- **No core dumps.** WSL 2 copies every Linux crash dump, a container's included, to `%TEMP%\wsl-crashes` on Windows, and a renderer's can be gigabytes, so the container turns them off.

What the container can't tell you is how Chord behaves on Windows or macOS. It runs what CI's Linux jobs run and skips what they skip:

| Spec | X11 | Wayland | Why |
| --- | --- | --- | --- |
| `updates.spec.ts`, both tests | skipped | skipped | Windows only: the dev build downloads through the installer path |
| `duet.spec.ts` › Claude Code inside WSL is offered in Setup | skipped | skipped | Windows only, and only with `CHORD_E2E_WSL=1` (it needs WSL with Node in the default distro) |
| `launch.spec.ts` › a page that keeps crashing stops after two reloads | skipped | skipped | Forced renderer crashes hang on Linux. The crash page in `a11y.spec.ts`'s browser-window audit is left out on Linux for the same reason |
| `launch.spec.ts` › page-first keys reach Chord only when the page passes; a changed page-first shortcut reaches Chord through the rebuilt menu | runs | skipped | Menu accelerators need an active window, and headless Weston has none (also skipped on macOS) |
| `web.spec.ts` › screen sharing goes through Chord's picker | runs | skipped | Headless Weston has no screen to capture (also skipped on macOS) |
| `keyboard.spec.ts` | runs | partly | Which view has OS focus isn't checked: Weston never activates a window |

Checks inside tests that only run on Windows: downloads carry the mark of the web (`Zone.Identifier`, in `launch.spec.ts`), and `perf.spec.ts` notes whether the session is locked. Anything about Windows itself (window materials and chrome, focus and activation, keys the OS delivers, updates, the installer) still needs a Windows run: locally, where it opens windows, or CI's Windows jobs on a branch, with `git push origin HEAD:<branch>` and then `gh workflow run ci.yml --ref <branch>`. Only the maintainer, or agents allowed to push, do that.

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
