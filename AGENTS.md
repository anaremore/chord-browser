# AGENTS.md

What an agent (or a new contributor) needs before touching Chord: the commands, the rules that are never broken,
and where to read more. Keep it under 200 lines (`scripts/test/agents-md.test.ts` holds the cap, and checks that
every path named here exists). The long docs are references: read the section the table below points to, not the
whole file.

## You own this codebase

Chord's code, tests, docs and CI are yours to keep healthy: no one else will fix what you leave behind.
- **Finish what you start.** Carry a change through tests, review findings and CI until it merges. Never stop
  half-done waiting for a go-ahead on an engineering call.
- **Fix what you find.** When you notice a bug, a flake or a stale doc on the way, fix it, or file an issue with the
  cause and a reproduction.
- **Don't repeat work.** Read what's already decided (the decision records, this file) before re-deriving it, and
  don't re-litigate settled choices.
- **Know whose decision it is.** Engineering calls are yours. The owner decides product direction, how things
  look, anything that costs money, and what ships in a release. For those, stop and say exactly what's needed.

## Commands

From the repo root (Node 24, pnpm 10):

```sh
pnpm install --frozen-lockfile
pnpm typecheck                 # tsc -b in every package
pnpm lint                      # Oxlint, then Stylelint on every CSS file
pnpm test                      # unit tests (Vitest), no *.perf.test.ts
pnpm test:perf                 # timed unit tests, one file at a time
pnpm build                     # the desktop app, into apps/desktop/out
pnpm test:e2e:linux            # all E2E in a Linux container on X11, no windows on your desktop
pnpm test:e2e:linux --wayland agents.spec.ts -g "Stop" --repeat-each 5
pnpm deadcode                  # Knip, on demand only
```

- **Read the exit code**, every time. Never pipe typecheck, lint or tests through `head`, `tail` or `grep` before
  deciding they passed: the pipe's status is the last command's, not the test run's.
- **E2E runs in the container** (`scripts/e2e-linux/run.mjs`, CONTRIBUTING.md *Running E2E without windows*). On
  Windows, never run `pnpm --filter @chord/desktop test:e2e` while the owner works: it opens dozens of windows that
  take focus. What only Windows can show goes to CI's Windows jobs.
- **Arguments after `pnpm test:e2e:linux`** go to Playwright; it tests your working tree as it is, uncommitted
  changes included.

## Environment gotchas

- **`ELECTRON_RUN_AS_NODE`.** Electron-based hosts (editors, agent shells) set it, and then Electron starts as plain
  Node. `apps/desktop/scripts/electron-vite.mjs` removes it for `dev` and `build`; a script or test that spawns
  Electron must delete it from the child's env too, as the E2E specs do.
- **`CHORD_TEST_TEMP`.** Tests make throwaway profiles in the system temp folder (`vitest.setup.ts`,
  `apps/desktop/test/run-temp.ts`). On the owner's machine, set it to a folder on Z: so C: doesn't fill.
- **Build on Z:.** The repo, its worktrees, `node_modules` and builds live on Z:. C: is small, and tests once
  filled it.
- **Worktrees** go under `Z:\Projects\chord-browser-wt\<name>`, made with `git worktree add` from the main checkout.
  Remove one only after its PR shows MERGED.
- **Docker for the container runner** is Docker Engine in WSL 2. Don't `wsl --shutdown` casually: other threads'
  containers run there.
- **Never `--no-verify`, never `gh pr merge --admin`.** The planner merges, through main's merge queue:
  `gh pr merge <n> --merge --auto` queues a pull request whose `E2E` passed, and it merges once its merge group
  passes. A plain `gh pr merge <n> --merge` is refused while the queue is on.

## Invariants (never broken; reviewers check every one)

1. **Agent input is not yours.** Chord sends an agent's clicks and keys through `sendInputEvent`, so Chord's own
   `before-input-event`, `before-mouse-event` and `input-event` listeners see them too. A listener that acts on
   *your* hands (pausing an agent, shortcuts, DevTools keys, focusing a pane, the passwords menu's keys) asks
   `isAgentInput(contents)` first (`apps/desktop/src/main/control/input.ts`).
2. **What an agent's tab sends goes through the Fetch hold.** Every request the page makes passes Chromium's `Fetch`
   domain on the tab's debugger (`apps/desktop/src/main/control/sends.ts`). A `session.fetch` from main does not:
   it carries the session's cookies outside the hold and skips `isNeverReadable`. Don't add one for an agent's tab
   without saying how it's held or why it's safe (issue #115 is the favicon case).
3. **IPC is declared once, with caller roles.** Every channel is in `packages/ipc/src/index.ts`, with a zod schema
   and the renderer roles allowed to call it; main checks the caller's registered role and origin
   (`apps/desktop/src/main/ipc.ts`). Web content is never registered and gets no IPC.
4. **The sandbox stays on.** `app.enableSandbox()` in main, `sandbox: true` and `contextIsolation: true` on every
   view, and every Playwright `electron.launch` passes `chromiumSandbox: true`
   (`apps/desktop/test/unit/chromium-sandbox.test.ts`). The container runner keeps it on too.
5. **Design tokens only.** Colors, lengths and durations come from `packages/tokens`; Stylelint refuses hex colors,
   color functions, `px`, `ms` and `s` anywhere else (`stylelint.config.js`, DESIGN.md §4.1).
6. **DESIGN.md's voice, in US English.** Friendly, plain, brief; sentence case; verbs on buttons; outcomes, not
   mechanisms; never blame (DESIGN.md §2). The same voice in docs, PRs and commit messages.
7. **No native modal dialogs.** Destructive actions are undone from a toast (DESIGN.md §1, principle 6); messages are
   Chord's own UI. The system's file pickers are the only native dialogs. Windows beeps at a message box.
8. **No real sites in the repo.** No site names, addresses or markup from real sites (nor from the owner's
   accounts) in code, fixtures, tests, docs, PRs or issues. A finding from a real page becomes a fixture in Chord's
   own markup (`scripts/dev/signin-sweep/README.md`).
9. **Performance is measured before and after.** A change on a hot path comes with numbers from both sides, and a
   budget that holds the result: E2E in `apps/desktop/test/e2e/perf.spec.ts`, unit budgets in `*.perf.test.ts`
   (`docs/testing/performance.md`). Wall-clock assertions never go in ordinary unit tests: they flake under load.
10. **Mock before UI.** New UI starts as a static HTML mock the owner picks from, with multiple-choice questions.
    No UI code before the mock is approved.
11. **The renderer is a web page.** Nothing in `apps/desktop/src/renderer` imports `electron`, `node:*`, or main's
    or preload's code; it talks to main through `packages/ipc` only.
12. **Tests come with the change.** Logic gets unit tests (tables where there are many cases), user flows get E2E
    tests. Every feature works on Windows, macOS and Linux (X11 and Wayland).

## Where to read (a section, not the file)

ARCHITECTURE.md is about 420 KB and DESIGN.md about 190 KB; the S15, S17 and S18 records are 150–190 KB each.
Find the heading with `grep -n "^## " <file>` and read that section.

| Working on | Read |
| --- | --- |
| Processes, views, window composition | ARCHITECTURE.md §4, §5 |
| The store, reducer, undo | ARCHITECTURE.md §6; `packages/core/src/reducer.ts` |
| Database schema, migrations | ARCHITECTURE.md §7; `docs/data-format.md` |
| IPC channels and roles | ARCHITECTURE.md §8; `packages/ipc/src/index.ts` |
| Downloads, permissions, media, import, export, sync | ARCHITECTURE.md §9 (its subsection) |
| Command bar and search | ARCHITECTURE.md §10; DESIGN.md §7.3, §8.3 |
| The assistant (panel, tools, forms) | ARCHITECTURE.md §11; DESIGN.md §7.8; S10 records |
| Outside agents (MCP, acting, the Fetch hold) | `docs/decisions/S18-agent-mcp.md`: *M2: plan*, the latest *as built*, *M2e: threat checklist*; DESIGN.md §7.17 |
| Passwords | `docs/decisions/S17-passwords.md` §4–§8, §12, §13 and the *as built* sections; DESIGN.md §8.9 |
| Your data (export, import, sync) | `docs/decisions/S15-your-data.md` §1–§7; DESIGN.md §8.8; `docs/testing/sync.md` |
| Extensions | ARCHITECTURE.md §12; `docs/decisions/S9-extensions.md` |
| Ad blocking, Safe Browsing | `docs/decisions/S11-ad-blocking.md`; ARCHITECTURE.md §14.5 |
| Keyboard shortcuts and routing | DESIGN.md §14; `docs/decisions/S8-keyboard-routing.md` |
| Chord Player, Widevine | ARCHITECTURE.md §9 *Chord Player*; `docs/decisions/S14-widevine-player.md` |
| Tokens, themes, motion | DESIGN.md §4, §5, §6 |
| A component's look | DESIGN.md §7 (its subsection) |
| Copy and empty states | DESIGN.md §2, §9 |
| Accessibility | DESIGN.md §10 |
| Security hardening, updates | ARCHITECTURE.md §14 |
| Packaging, signing, CI, testing | ARCHITECTURE.md §15; `docs/releasing/`; `.github/workflows/ci.yml` |
| Performance budgets | `docs/testing/performance.md` |
| Releasing | `docs/releasing/patch-runbook.md` |
| What's next | ROADMAP.md |

New decision records (S20 and on) are a small folder each, not one growing file: `docs/decisions/README.md`.

**Procedures** are the repo's skills, in `.claude/skills/`: `chord-preview` (a Windows test installer from any ref),
`chord-e2e-linux` (E2E in the container) and `chord-release` (a patch or minor, tag to site links).

## The review contract

- **Reviews start when a push lands,** not when CI is green. Every PR with product code gets two independent
  reviews (Claude and Gemini Neon).
- **A finding is reproduced before it's fixed:** a failing test first (unit, or E2E in the container), then the fix
  that turns it green. A finding that can't be reproduced is said so, not fixed blind.
- **The stop rule.** A finding that needs an exotic API, a crash, or a hostile build to show becomes a stated limit
  in the decision record or an issue, not another review round.
- **Threat checklist first.** A slice that touches agents, passwords, IPC, sessions or anything web content can
  reach starts with a threat checklist and a design review, before code (S18's *M2e: threat checklist* is the
  model).
- **CI is tiered.** Every push gets the fast tier (Linux X11). The merge queue adds Windows x64 and macOS arm64
  for platform-sensitive code, every platform for an Electron change; the rest run nightly. Adding the `ready`
  label runs every platform now, once. The merge gate is the `E2E`
  commit status, on pull requests and merge groups (`.github/workflows/ci.yml`).
- **PR descriptions** say what changed, what was measured, which invariants it touches and how each is tested.
  Commits use Conventional Commits prefixes.
