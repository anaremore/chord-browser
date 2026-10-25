# Performance

Chord's performance budgets ([ARCHITECTURE.md §1](../../ARCHITECTURE.md#1-scope)) are acceptance criteria for 0.1. `apps/desktop/test/e2e/perf.spec.ts` measures them on every E2E run. The checks that count something (one shell render a frame, pages moved at most twice, no late results) don't depend on the machine, so they fail CI too. Times only report in CI, because its runners are noisy; the reference PC (Windows 11, Ryzen 9 5900X, 144 Hz display) enforces them. Memory at idle and warm launches are held to [baselines](#baselines) instead: what the same CI runner measured before, plus a margin.

## Run it

```sh
pnpm --filter @chord/desktop build
pnpm --filter @chord/desktop test:perf                       # report only
CHORD_PERF_ENFORCE=1 pnpm --filter @chord/desktop test:perf  # any miss fails
pnpm test:e2e:linux --cpus 4 perf.spec.ts -g "launch: |memory: "   # the baselines, as the container holds them
```

In PowerShell, set `$env:CHORD_PERF_ENFORCE = '1'` first. A run takes about five minutes: eleven launches of Chord and eight of bare Electron, three more launches to measure memory, then four sessions (20 and 200 Today tabs, each with motion on and off). Each session opens and types in the command bar, switches tabs, collapses and docks the sidebar, opens and closes Duet, pins, folds a folder, drags to reorder, switches chords, and runs Clear Today and its Undo, then Clear Today again scrolled to the end of the list (in a windowed list, rows that weren't mounted at the start). With motion on, each Clear also checks the archive arc (DESIGN.md §6.5): rows on screen leave, at most 6 favicons fly, and under 50 nodes animate at once; with motion off, nothing does. The spec turns motion on and off itself, whatever the OS setting.

`test/e2e/today.spec.ts` covers the windowed list itself (DESIGN.md §6.7): scrolling, an axe audit of the list scrolled to the middle, the keyboard to the end of 200 tabs, a drag past the list's edge, and the arc with motion on, reduced and off. It captures the arc mid-flight, light and dark, as `test-results/captures/archive-arc-*.png`.

Before an enforced run:

- **Unlock the screen and leave Chord's window alone.** A locked Windows session paints to a ~55 Hz virtual display (`WinDisc`), so checks that depend on the display aren't held: time to a painted frame, a frame's work, and gaps between frames. The report marks them `unlocked run` and the row `[locked]`.
- **Quiet the machine.** Other builds and test runs slow everything down. The report records how busy the CPUs were before each test (`cpuBusy`).

## What's held

| Budget | Measured | Held |
|---|---|---|
| Launch < 1.5 s | Main's first line to the sidebar's first commit with its handlers attached (`ready`), and to its first painted frame. Fresh profile and 200 restored tabs, three runs each; the worst run counts. | `ready` always; painted when unlocked |
| Command bar open < 50 ms | The request in main to the overlay's first frame (its `requestAnimationFrame`), and on to the paint. Ten openings, including the first since launch. | First frame always; paint when unlocked |
| Keystroke, open tabs and actions | Their rows are in the DOM before the keystroke's frame begins (`late` must be 0). | Always |
| Keystroke, history and archive ≤ 16 ms | Keystroke to the reply being committed, and to its paint. | Commit always; paint when unlocked |
| Shell frames | During each interaction: the longest main-thread task ≤ 16 ms; the worst frame's work ≤ 16 ms, or ≤ 8 ms on a 120 Hz+ display; the slowest gap between frames ≤ 20 ms (60 fps). | Task always; frames and gaps when unlocked; 8 ms on 120 Hz+ displays only |
| One shell render a frame | Switching tabs: the shell's App commits (each leaves a `chord:shell-render` mark) between one frame's start and the next. At most 1 (`renders`). | Always |
| Pages never move per frame | Collapsing and docking the sidebar, opening and closing Duet: how often the page's view is moved (`setBounds`, counted in main) in one change. At most 2 (`moves`): out of sight at its new size, then into place (ARCHITECTURE.md §5, *The frame snapshot*). With motion off it's 1. | Always |
| Memory at idle doesn't grow | Each of Chord's own processes with one window and one simple page: main, shell, command bar, popover, hover preview, the page, GPU, chord-data. Private memory, the median of three launches. | Against the runner's baseline: up to 15% or 5 MB more, whichever is more |
| Warm launches don't slow down | Process start to the sidebar ready, 200 tabs restored, seven launches, each just after a bare Electron launch: the median of Chord's over the median of Electron's (`×`). | Against the runner's baseline: up to 25% more |

Frame work comes from a Chromium trace (`test/e2e/frames.ts`). The Long Animation Frames API only reports frames over 50 ms, so it can't hold a 16 ms budget. Chromium also marks every frame in the trace. A frame's work is the main-thread task time inside it. A frame spans every task since the previous one, so on a slower display more work lands in each frame. The longest single task doesn't depend on the display, so it's held even on a locked screen.

## Read the report

At the end, the run prints one line per measure. Each check reads `label value/budget status`, where status is `ok`, `MISS`, `unlocked run`, `120 Hz display` (needs a faster display), `no data` (nothing was measured; an enforced run counts it as a miss), or `no baseline` (held to a baseline this runner doesn't have, so only reported). The first line names the baseline in use.

The full report is `apps/desktop/test-results/perf.json`. CI uploads it as the `perf-<os>` artifact of each E2E job. Besides the checks, each measure has:

- `environment`: the CPU, and the display's refresh rate and its idle frame interval.
- `locked` and `cpuBusy`: the screen state and the machine's load when it was measured.
- Switch tabs' renders `detail`: the renders per switch, and the most in one frame for each.
- Page view moves `detail`: the moves in each of the three changes, and how often the page laid itself out in each and for how long (`pageLayouts`, `pageLayoutMs`, from the trace of the page's renderer).
- Launch `detail.sinceMainEntry`: when each stage was reached, run by run (`ready`, `restored`, `windowCreated`, `shellLoaded`, `windowShown`, `shellReady`, `shellPainted`).
- Command bar `detail`: per opening, when the overlay `received` the request and `committed` it; per keystroke, when the history search was `sent` and its `roundTrip` through chord-data.
- Frames `detail`: the worst frame split into script, style and layout, and paint, with its longest JS calls, and the longest task with its calls. These point at what to profile.
- Memory `detail`: each process's memory launch by launch; the last memory row has Chromium's other processes.
- Warm launch `detail`: Chord's and bare Electron's launches, run by run.
- `measured`: this run's numbers as a baseline, with the runner they belong to (`null` where none can be held). `perf:baseline` takes them from here.

## Baselines

Memory and launch times depend on the machine, and CI's runners of one kind aren't one machine: over twelve CI runs on 2026-10-25, Linux X11's warm launches took 656 to 1015 ms (the median of each run's three), Windows x64's 563 to 939 ms, macOS arm64's 780 to 1748 ms. Within a run they agree far better. So these two are held to what the same runner measured before (`test/e2e/perf-baseline.json`), plus a margin, rather than to a budget. The logic is in `test/e2e/baselines.ts`.

**Where they're held.** Each CI runner has its own baseline, by OS, architecture and, on Linux, display server (`linux-x64-x11`, `win32-arm64`, …). The Linux container is a machine of its own, by how many CPUs it runs on (`linux-x64-x11, container, 4 CPUs`); its baselines are taken on 4 CPUs, as CI's runners have, so check against them with `--cpus 4` (warm launches came out at 4.0 times bare Electron's on 24 CPUs, 4.5 on 4). A runner without a baseline, any other machine, and macOS only report (`no baseline`). macOS because Electron gives its memory only as a resident set, shared pages and all, and because CI's macOS machines are too busy for steady launches: even judged against Electron's own start, their slowest run's warm launches took 1.2 to 1.6 times the fastest's.

**Memory** is each process's private memory the way Chromium counts its own footprint: on Linux, anonymous memory plus swap (`RssAnon` and `VmSwap` in `/proc/<pid>/status`); on Windows, private bytes (`app.getAppMetrics()`). Counting private pages from `/proc/<pid>/smaps_rollup` instead made main and the GPU process jump 10 to 16 MB from one launch to the next: a library's pages count as private only while no other process maps them, so it depended on what else was running. Before measuring, the spec waits 3 s after the page loads and collects garbage in main and every renderer, so what's measured is what's kept; it reads the GPU process before that, as attaching DevTools to collect garbage makes the views paint again (3.5 MB more). Each process's number is the median of three launches.

In the container on 4 CPUs, over ten launches, every renderer and chord-data stayed within 1 MB of its median, main within 4 MB, and the GPU process within 0.2 MB. Over ten runs of the test on X11 and ten on Wayland, the medians it holds moved by at most 0.9 MB for a renderer, 0.1 MB for chord-data, 3.7 MB for main, and not at all for the GPU process. The margin, 15% or 5 MB, whichever is more, is at least three times that. It catches 30 MB more in any process, and about 5 MB more in any renderer.

**Warm launches** are judged against bare Electron (`test/fixtures/bare-electron/main.mjs`: one window, one small page), launched just before each of Chord's seven so that both see the machine as it is at that moment. Not against how long Electron takes to reach main's first line, which every launch measures anyway: 40% of that is Chord's own (62 ms for bare Electron, 105 ms for Chord, as main's bundle loads first), so loading main faster would have read as launching slower. In the container on 4 CPUs, Chord takes about 4.4 times as long as bare Electron; single launches varied from 4.2 to 4.9 times. Over ten runs of the test, the median of seven ranged from 4.36 to 4.64 on X11 and from 3.95 to 4.45 on Wayland, at most 5.5% over the baseline. The margin is 25%. That leaves room for CI, whose runners vary more: judged against Electron's own start, the nearest measure CI has reported so far, warm launches over twelve runs varied by up to 4% either side on Linux X11, 6% on Wayland and Windows arm64, and 9% on Windows x64. It catches 200 to 300 ms more on a 700 ms launch: the container's warm launch went from 4.48 to 6.03 times bare Electron's with main blocked for 300 ms before the window opened.

**A failure** says what grew, from what to what, past which limit, and how to take a new baseline. With 30 MB kept alive in the shell: `Memory at idle: shell (one window, one page, linux-x64-x11, container, 4 CPUs) grew from 35.1 to 65.1 MB (+30 MB, +85%), past its limit of 40.4 MB. If that's intended, take a new baseline: pnpm --filter @chord/desktop perf:baseline (docs/testing/performance.md, "Baselines").`

**Take a new baseline** when a change means to grow a number, and commit `perf-baseline.json` with the change; its diff shows what moved and where it was measured:

```sh
pnpm --filter @chord/desktop perf:baseline               # the container: Linux x64, X11 then Wayland, on 4 CPUs
pnpm --filter @chord/desktop perf:baseline --run <id>    # CI's runners, from a CI run's perf-* artifacts (needs gh)
```

A run that failed because a number grew still counts. The container's numbers aren't CI's (the same code launches relatively slower on CI's runners, for one), so each CI runner's baseline comes from a CI run: start one on a branch with `gh workflow run ci.yml --ref <branch>`, then take its numbers with `--run`. `perf:baseline <perf.json or folder>…` takes reports you already have.

## Instrumentation in the app

These cost a clock read or a frame callback, so they're always on.

- **Main:** `src/main/perf.ts` stamps launch milestones from main's first line. Tests read them through `chordTestHooks.launch()` (`CHORD_E2E_HOOKS=1`). The shell reports `ready` and `painted` over the `perf:shell` IPC; at launch, `painted` is also when the window's command bar, popover and hover preview start loading (ARCHITECTURE.md §1, *Launch order*).
- **Renderers:** User Timing entries show up in DevTools' Performance panel: `chord:shell-ready`, `chord:shell-painted` and `chord:shell-render` (each shell commit; the oldest are dropped past 500) marks; `chord:command-bar-open`, `chord:keystroke` and `chord:keystroke-history` measures.
- **Development builds:** `CHORD_PERF_TABS=200` and `CHORD_PERF_VISITS=2000` give a brand-new profile sleeping Today tabs and history to measure against. Pages are `/perf/1` and up on `CHORD_HOME_URL`'s site.

To profile a miss with readable names, build without minifying (`CHORD_NO_MINIFY=1 pnpm --filter @chord/desktop build`). With `CHORD_PERF_PROFILE=1`, the spec also samples the shell's CPU during each interaction (V8's profiler, every 100 µs) and adds the 15 functions with the most self time to each frames measure (`detail.shellSelfTime`). Sampling slows the shell a little, so use it to find a cost, not to judge a budget. In the Linux container: `CHORD_NO_MINIFY=1 CHORD_PERF_PROFILE=1 pnpm test:e2e:linux perf.spec.ts -g "200 Today tabs, motion on"` (both variables are passed in).
