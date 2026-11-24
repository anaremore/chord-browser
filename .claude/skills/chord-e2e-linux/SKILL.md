---
name: chord-e2e-linux
description: Run Chord's (anaremore/chord-browser) Playwright E2E in the Linux container, on X11 or Wayland, without opening a window on the owner's desktop; with the WSL Docker credential workaround and how to read the result.
---
# Chord E2E in the Linux container

**When:** any E2E run on the owner's Windows machine. `pnpm --filter @chord/desktop test:e2e` opens dozens of windows that take focus, so it's never run there while the owner works. What only Windows or macOS can show goes to CI (`gh workflow run ci.yml --ref <branch>`).

**Reference:** CONTRIBUTING.md, *Running E2E without windows* (what it copies, what it skips per display, results, cost, cleanup); `scripts/e2e-linux/run.mjs`'s header (the options).

## Run it

From the worktree whose code you want tested (uncommitted changes included), in Git Bash:

```sh
pnpm test:e2e:linux > "$TEMP/e2e.log" 2>&1; echo "EXIT=$?"                     # everything, X11 (about 9 min)
pnpm test:e2e:linux --wayland agents.spec.ts > "$TEMP/e2e.log" 2>&1; echo "EXIT=$?"
pnpm test:e2e:linux proxies.spec.ts -g "SOCKS5" --repeat-each 5 > "$TEMP/e2e.log" 2>&1; echo "EXIT=$?"
```

- **Arguments** go to Playwright (spec files, `-g`, `--repeat-each`, `--workers`, `--reporter`), apart from `--x11` / `--wayland`, `--rebuild` (a fresh image) and `--cpus 4` (as CI's runners; perf baselines are taken so: `docs/testing/performance.md`).
- **A flake hunt:** `--repeat-each 5` to `20` on the one test (`-g`), and both displays when it touches focus or windows.
- **Long runs** go in the background; wait for them to finish instead of polling.
- **Read the exit code, then the log:** `tail -30 "$TEMP/e2e.log"` after the run. Never pipe the run itself through `head`, `tail` or `grep`: the pipe's status hides a failure. The last lines say `[e2e-linux] Passed` or what failed; details are in apps/desktop/test-results (Playwright's output, copied back).

## When the image won't build (WSL Docker credentials)

Rebuilding the runner image (first run, a changed `scripts/e2e-linux/Dockerfile`, or `--rebuild`) can fail with `docker-credential-desktop.exe: exec format error`: WSL's Docker config names Docker Desktop's credential helper, and WSL interop is broken. Run it with an empty Docker config instead:

```sh
MSYS_NO_PATHCONV=1 DOCKER_CONFIG=/home/human/.docker-nocreds WSLENV=DOCKER_CONFIG \
  pnpm test:e2e:linux > "$TEMP/e2e.log" 2>&1; echo "EXIT=$?"
```

- `/home/human/.docker-nocreds/config.json` holds `{}`. Don't edit the owner's own Docker config.
- `MSYS_NO_PATHCONV=1` is needed: without it Git Bash rewrites the path to `C:/Program Files/Git/…`, and WSL makes a stray folder named `C` (its colon a private-use character) in the working directory. Remove that one by its exact name, never with a `C*` glob.
- Never `wsl --shutdown`: other threads' containers run there.

## Clean up

Each run removes its own container. To free disk: CONTRIBUTING.md's *Cleaning up* (the `chord-e2e-*` volumes and `chord-e2e-runner` images).
