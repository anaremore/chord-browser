# Performance

Chord's performance budgets ([ARCHITECTURE.md §1](../../ARCHITECTURE.md#1-scope)) are acceptance criteria for 0.1. `apps/desktop/test/e2e/perf.spec.ts` measures them on every E2E run. CI only reports, because its runners are noisy. The reference PC (Windows 11, Ryzen 9 5900X, 144 Hz display) enforces them.

## Run it

```sh
pnpm --filter @chord/desktop build
pnpm --filter @chord/desktop test:perf                       # report only
CHORD_PERF_ENFORCE=1 pnpm --filter @chord/desktop test:perf  # any miss fails
```

In PowerShell, set `$env:CHORD_PERF_ENFORCE = '1'` first. A run takes about four minutes: six launches, then four sessions (20 and 200 Today tabs, each with motion on and off). Each session opens and types in the command bar, switches tabs, pins, folds a folder, drags to reorder, switches chords, and runs Clear Today and its Undo. The spec turns motion on and off itself, whatever the OS setting.

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

Frame work comes from a Chromium trace (`test/e2e/frames.ts`). The Long Animation Frames API only reports frames over 50 ms, so it can't hold a 16 ms budget. Chromium also marks every frame in the trace. A frame's work is the main-thread task time inside it. A frame spans every task since the previous one, so on a slower display more work lands in each frame. The longest single task doesn't depend on the display, so it's held even on a locked screen.

## Read the report

At the end, the run prints one line per measure. Each check reads `label value/budget status`, where status is `ok`, `MISS`, `unlocked run`, `120 Hz display` (needs a faster display), or `no data` (nothing was measured; an enforced run counts it as a miss).

The full report is `apps/desktop/test-results/perf.json`. CI uploads it as the `perf-<os>` artifact of each E2E job. Besides the checks, each measure has:

- `environment`: the CPU, and the display's refresh rate and its idle frame interval.
- `locked` and `cpuBusy`: the screen state and the machine's load when it was measured.
- Launch `detail.sinceMainEntry`: when each stage was reached, run by run (`ready`, `restored`, `windowCreated`, `shellLoaded`, `windowShown`, `shellReady`, `shellPainted`).
- Command bar `detail`: per opening, when the overlay `received` the request and `committed` it; per keystroke, when the history search was `sent` and its `roundTrip` through chord-data.
- Frames `detail`: the worst frame split into script, style and layout, and paint, with its longest JS calls, and the longest task with its calls. These point at what to profile.

## Instrumentation in the app

These cost a clock read or a frame callback, so they're always on.

- **Main:** `src/main/perf.ts` stamps launch milestones from main's first line. Tests read them through `chordTestHooks.launch()` (`CHORD_E2E_HOOKS=1`). The shell reports `ready` and `painted` over the `perf:shell` IPC.
- **Renderers:** User Timing entries show up in DevTools' Performance panel: `chord:shell-ready` and `chord:shell-painted` marks; `chord:command-bar-open`, `chord:keystroke` and `chord:keystroke-history` measures.
- **Development builds:** `CHORD_PERF_TABS=200` and `CHORD_PERF_VISITS=2000` give a brand-new profile sleeping Today tabs and history to measure against. Pages are `/perf/1` and up on `CHORD_HOME_URL`'s site.

To profile a miss with readable names, build without minifying (`CHORD_NO_MINIFY=1 pnpm --filter @chord/desktop build`). Then record with DevTools' Performance panel, or attach a CDP session and use `Profiler.start`.
