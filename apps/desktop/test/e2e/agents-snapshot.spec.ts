/** Outside agents' snapshot (S18 M2b), end to end: the outline of a tab, its refs, and its budgets. Split from agents.spec.ts (#213). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnMainErrors } from './main-errors';
import { isShell, pageWhere } from './a11y-kit';
import { CODEX, TIMES_HELD, agents, answer, launch, relay, startAgentSite, within } from './agents-shared';

failOnMainErrors();

let site: Awaited<ReturnType<typeof startAgentSite>>;
test.beforeAll(async () => {
  site = await startAgentSite();
});
test.afterAll(() => site.server.close());

test('snapshot: the outline of a tab an agent opened, its refs, and its budgets (M2b)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    expect(((await mcp.request('tools/list', {})).result['tools'] as { name: string }[]).map((t) => t.name)).toContain('snapshot');
    const opening = mcp.call('open_tab', { url: `${site.origin}/snap` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const result = await mcp.call('snapshot', { tab_id: 'a1' });
    expect(result.isError).toBe(false);
    const snap = JSON.parse(result.text) as { source: string; trust: string; refs: number; page_id: string; content: string };
    expect(snap).toMatchObject({ source: 'web_snapshot', trust: 'untrusted' });
    const lines = snap.content.split('\n').map((l) => l.trim());
    const has = (pattern: RegExp) => expect(lines.some((l) => pattern.test(l)), `${pattern} in\n${snap.content}`).toBe(true);
    // An outside agent gets a container its c ref (#207): read-only, read_tab reads it.
    has(/^- navigation "Site" \[ref=c\d+\]$/);
    has(/^- link "Home" \[ref=e\d+\]$/);
    has(/^- heading "Your orders" \[ref=e\d+\]|^- heading "Your orders" \[level=1\]$/);
    has(/^- text: "Returns are free within 30 days\."$/);
    has(/^- searchbox "Search orders" \[ref=e\d+\] \[filled\]$/);
    has(/^- checkbox "Gift receipt" \[ref=e\d+\] \[checked\] \[required\]$/);
    has(/^- combobox "Shipping" \[ref=e\d+\] \[choice="Express"\]$/);
    has(/^- textbox "Note" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Password" \[password: the user signs in\]$/);
    has(/^- textbox "Code" \[one-time code: the user types it\]$/);
    has(/^- button "Start a return" \[ref=e\d+\]$/);
    has(/^- button "Cancel order" \[ref=e\d+\] \[disabled\]$/);
    has(/^- generic "Track package" \[ref=e\d+\]$/);
    has(/^- button "More" \[ref=e\d+\] \[collapsed\]$/);
    has(/^- button "In the shadow" \[ref=e\d+\]$/);
    // A same-origin frame (a srcdoc): read, its button under it with a ref, in an agent's own tab (#210).
    has(/^- iframe "Chat"$/);
    has(/^- button "Inside" \[ref=e\d+\]$/);
    has(/^- textbox "Message" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Card number" \[payment detail: the user fills it\]$/);
    has(/^- textbox \[ref=e\d+\] \[filled\]$/);
    has(/^- combobox "Expires" \[payment detail: the user fills it\]$/);
    has(/^- textbox "Cell" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Item" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Title" \[ref=e\d+\] \[filled\]$/);
    // A button labelled by an editor, a text area or a select isn't named by what's in it: by its own words instead.
    has(/^- button "Send" \[ref=e\d+\]$/);
    has(/^- button "Keep" \[ref=e\d+\]$/);
    has(/^- button "Pick" \[ref=e\d+\]$/);
    expect(lines.filter((l) => /^- textbox "Card number" \[payment detail: the user fills it\]$/.test(l))).toHaveLength(2);
    // What's hidden, what's in a frame, and what's in a field never show.
    for (const never of ['Invisible', 'wool scarf', 'secret-note-value', 'hunter2-secret', 'Hidden until opened', '123-45-6789', '4242', 'typed-into-a-role-textbox', 'Hidden from assistive tech', '07', '5555', 'typed-in-a-cell', 'typed-in-a-list-item', 'typed-in-a-heading', 'typed-label-source', 'Hidden, any case', 'initial-textarea-content', 'option-label-x']) expect(snap.content).not.toContain(never);

    // A page that's all editor: one typed field, never walked (review 3 of #104).
    for (const [i, path] of ['/edit-body', '/edit-html', '/design-mode'].entries()) {
      await mcp.call('open_tab', { url: `${site.origin}${path}` });
      const whole = JSON.parse((await mcp.call('snapshot', { tab_id: `a${i + 2}` })).text) as { content: string };
      expect(whole.content, path).toMatch(/^- textbox \[ref=e\d+\] \[filled\]$/);
      expect(whole.content, path).not.toContain('typed-');
    }
    expect(snap.refs).toBe((snap.content.match(/\[ref=e\d+\]/g) ?? []).length);
    // A second snapshot: new refs, counted on.
    const again = JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string };
    const firstMax = Math.max(...[...snap.content.matchAll(/ref=e(\d+)/g)].map((m) => Number(m[1])));
    // The same elements keep their refs from one snapshot to the next (M2g-1: the page's own ids).
    expect(Math.max(...[...again.content.matchAll(/ref=e(\d+)/g)].map((m) => Number(m[1])))).toBe(firstMax);

    // Budgets (docs/decisions/S18-agent-mcp.md, "M2: plan"): a typical page (about 1,500 elements) and a 20,000-element one.
    type Times = { times: number[]; after: number[]; walk: number[]; nodes: number; keys: number; cut: Record<string, boolean> | null } | null;
    const timesOf = (url: string, runs: number) => app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentSnapshotTimes(u: string, r: number): Promise<Times> } }).chordTestHooks.agentSnapshotTimes(u, r), [url, runs] as const);
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
    // (/article50: fifty named sections, each a part whose ref the snapshot decides by its ancestors: #207.)
    for (const [path, rows, runs] of [['/rows-300', 300, 20], ['/noisy', 300, 20], ['/article50', 50, 20], ['/rows-4000', 4000, 5], ['/texts', 0, 5]] as const) {
      await mcp.call('open_tab', { url: `${site.origin}${path}` });
      const measured = (await timesOf(`${site.origin}${path}`, runs))!;
      const ms = sorted(measured.times);
      const median = ms[Math.floor(ms.length / 2)]!;
      const worst = ms[ms.length - 1]!;
      // The slow end, without its single slowest run: one pause on a shared runner (a collection, the scheduler) can take
      // one run far past it (#154's macOS x64 run: medians 25 ms, one run 213 ms), as the huge pages' median allows for.
      const p90 = ms[Math.floor(ms.length * 0.9)]!;
      const seen = `${path}: ${rows * 5} elements, ${measured.nodes} nodes, ${measured.keys} keys, cut ${JSON.stringify(measured.cut)}; median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, worst ${worst.toFixed(1)} ms (${ms.map((t) => t.toFixed(0)).join(' ')})`;
      test.info().annotations.push({ type: 'snapshot timing', description: seen });
      console.log(`[snapshot timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${seen}`);
      // /article50 (#207): fifty named sections, each a part whose ref the snapshot decides by its ancestors. Its ratio is
      // logged, never held: a page of 152 nodes, where the snapshot's fixed cost per call outweighs a plain walk (2.3x
      // with no parts at all; its parts add about 0.5 ms).
      if (path === '/article50') {
        const walk = sorted(measured.walk);
        const walkMedian = walk[Math.floor(walk.length / 2)]!;
        console.log(`[snapshot ratio] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${path}: the snapshot ${(median / walkMedian).toFixed(2)}x a plain walk of the page (snapshot median ${median.toFixed(1)} ms, walk median ${walkMedian.toFixed(1)} ms; logged, not held)`);
      }
      if (path === '/rows-300' && TIMES_HELD) {
        // #166: what each part of the walk costs here, each left out in turn with the full snapshot (logged, never held).
        // Where times are held (off CI, or CHORD_PERF_ENFORCE=1): 200 more snapshots would cost CI's run 15-20 s (#270).
        type Parts = Record<string, number[]> | null;
        const parts = (await app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentSnapshotParts(u: string, r: number): Promise<Parts> } }).chordTestHooks.agentSnapshotParts(u, r), [`${site.origin}${path}`, 40] as const))!;
        const med = (xs: number[]) => sorted(xs)[Math.floor(xs.length / 2)]!;
        const full = med(parts['full']!);
        const saved = Object.entries(parts)
          .filter(([name]) => name !== 'full')
          .map(([name, xs]) => `${name === 'eagerPart' ? 'with the part built per element (main)' : `without ${name}`} ${med(xs).toFixed(1)} ms (${(med(xs) - full).toFixed(1)} against full)`)
          .join('; ');
        console.log(`[snapshot parts] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${path}: full ${full.toFixed(1)} ms; ${saved}`);
      }
      if (rows === 300) {
        // #166: the snapshot against a plain walk of the same page, timed in turn with it from main. A slow runner slows
        // both, so their ratio holds where milliseconds don't: held on every runner, CI's too (SNAPSHOT_RATIO_MAX; the
        // milliseconds below are held off CI only). Reported before anything is judged, so a slow run still says it; a
        // snapshot cut for time did less work, which the line shows (cut), and isn't held to the ratio.
        const walk = sorted(measured.walk);
        const walkMedian = walk[Math.floor(walk.length / 2)]!;
        const ratio = median / walkMedian;
        const ratioSeen = `${path}: the snapshot ${ratio.toFixed(2)}x a plain walk of the page${measured.cut?.['time'] ? ' (cut for time)' : ''} (snapshot median ${median.toFixed(1)} ms, walk median ${walkMedian.toFixed(1)} ms: ${walk.map((t) => t.toFixed(1)).join(' ')})`;
        test.info().annotations.push({ type: 'snapshot ratio', description: ratioSeen });
        console.log(`[snapshot ratio] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${ratioSeen}`);
        expect(walk.every((t) => t > 0), ratioSeen).toBe(true);
        if (!measured.cut?.['time']) expect(ratio, ratioSeen).toBeLessThanOrEqual(SNAPSHOT_RATIO_MAX);
        // Every key, unless a shared runner was slow enough for the scan's own time bound (SNAPSHOT_SCAN_MS) to cut it:
        // that's the bound working, and reported like the times.
        if (TIMES_HELD || !measured.cut?.['time']) expect(measured.keys, seen).toBe(600);
        const typical = SNAPSHOT_TYPICAL_MS;
        within(median, typical.median, seen);
        within(p90, typical.worst, seen);
        // The refs' items, place and shape, taken in the task right after the snapshot answers (the review of #117).
        const after = sorted(measured.after);
        const afterMedian = after[Math.floor(after.length / 2)]!;
        const afterSeen = `${path}: the refs' re-find data after the snapshot, median ${afterMedian.toFixed(1)} ms (${after.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[snapshot timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${afterSeen}`);
        expect(after.every((t) => t > 0), afterSeen).toBe(true);
        within(afterMedian, typical.median, afterSeen);
        // M2c: an action's own work before its input goes (the element checked, scrolled to, hit-tested), on this page.
        type ActTimes = { times: number[]; deep: number[]; refind: number[]; refound: number; failed?: string } | null;
        const act = (await app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentActTimes(u: string, r: number): Promise<ActTimes> } }).chordTestHooks.agentActTimes(u, r), [`${site.origin}${path}`, 30] as const))!;
        expect(act.failed).toBeUndefined();
        const at = sorted(act.times);
        const actMedian = at[Math.floor(at.length / 2)]!;
        const actP95 = at[Math.floor(at.length * 0.95)]!;
        const actSeen = `${path}: an action's point step, median ${actMedian.toFixed(1)} ms, p95 ${actP95.toFixed(1)} ms (${at.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${actSeen}`);
        within(actMedian, ACT_POINT_MS.median, actSeen);
        within(actP95, ACT_POINT_MS.p95, actSeen);
        // The owner's bug #2: the same step on the element after the page replaced it with a copy (found again, or not:
        // a page of rows named alike is two matches). A report; its cap is act.ts' REFIND_MS.
        const rf = sorted(act.refind);
        const refindSeen = `${path}: the point step on a replaced element, found again ${act.refound}/${rf.length}, median ${rf[Math.floor(rf.length / 2)]!.toFixed(1)} ms, p95 ${rf[Math.floor(rf.length * 0.95)]!.toFixed(1)} ms`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${refindSeen}`);
        // Each row's button is unique there, so each is found again; well within act.ts' REFIND_MS (50 ms).
        expect(act.refound, refindSeen).toBe(rf.length);
        within(rf[Math.floor(rf.length / 2)]!, 25, refindSeen);
        // Neon's review of #110: the debugger's session a press or typing opens, on this page. The document's first
        // finds Chord's world (Runtime enabled once: the page's stored console replayed, ~1,000 entries at most on
        // /noisy); the rest don't.
        const [first, ...later] = act.deep;
        const dt = sorted(later);
        const deepMedian = dt[Math.floor(dt.length / 2)]!;
        const deepP95 = dt[Math.floor(dt.length * 0.95)]!;
        const deepSeen = `${path}: the debugger's session, first ${first!.toFixed(1)} ms, then median ${deepMedian.toFixed(1)} ms, p95 ${deepP95.toFixed(1)} ms (${dt.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${deepSeen}`);
        within(first!, ACT_DEEP_MS.first, deepSeen);
        within(deepMedian, ACT_DEEP_MS.median, deepSeen);
        within(deepP95, ACT_DEEP_MS.p95, deepSeen);
        if (path === '/rows-300') {
          // M2d: the send watch (sends.ts), every request of a 60-image page through it, against without it.
          await mcp.call('open_tab', { url: `${site.origin}/heavy` });
          type WatchTimes = { off: number[]; on: number[]; failed?: string } | null;
          const watched = (await app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentWatchTimes(u: string, r: number): Promise<WatchTimes> } }).chordTestHooks.agentWatchTimes(u, r), [`${site.origin}/heavy`, 10] as const))!;
          expect(watched.failed).toBeUndefined();
          const mid = (xs: number[]) => sorted(xs)[Math.floor(xs.length / 2)]!;
          const extra = mid(watched.on) - mid(watched.off);
          const watchSeen = `/heavy: the send watch, loaded with it median ${mid(watched.on).toFixed(1)} ms, without ${mid(watched.off).toFixed(1)} ms, extra ${extra.toFixed(1)} ms (on ${watched.on.map((t) => t.toFixed(0)).join(' ')}; off ${watched.off.map((t) => t.toFixed(0)).join(' ')})`;
          console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${watchSeen}`);
          within(extra, SEND_WATCH_EXTRA_MS, watchSeen);
        }
      } else {
        // The median of five: one pause in five (a garbage collection on a page of 2,000,000 text nodes) took 777 ms once
        // on main itself, its other runs 35 to 43 ms. The worst is in the message.
        within(median, SNAPSHOT_HUGE_MS, seen);
        // A page of 2,000,000 text nodes is cut at the scan's bound like any other (review 1 of #104).
        expect(measured.nodes, seen).toBeLessThanOrEqual(20_000);
      }
    }
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * The snapshot's budgets, round trip from main (the renderer's work and the answer's way back), in the Linux container
 * and on CI's runners: a typical page (1,500 elements: 300 rows of a link, a note and a button) and a 20,000-element
 * one, which the script stops looking at after SNAPSHOT_SCAN_MS (150 ms). Measured (2026-11-22, the Linux container,
 * three runs each on X11 and Wayland): the typical page's median 12.8 to 15.9 ms, its worst 21 to 28 ms; the huge page
 * 127 to 166 ms median, 194 ms at worst; once text nodes counted toward the scan (review 1 of #104), 75 to 91 ms median
 * and 138 ms at worst, and a page of 2,000,000 text nodes 31 to 34 ms median, 49 ms at worst. The budgets are the plan's,
 * at least 1.5 times the worst seen.
 *
 * CI's runners only report these milliseconds (#163): a shared runner's speed decides them, 9.7 to 48.9 ms for the same
 * page (#166). What CI holds is SNAPSHOT_RATIO_MAX. So the per-platform budgets CI's runners once had are gone (#213):
 * one budget, held off CI and with CHORD_PERF_ENFORCE=1 (`within`). The 20,000-element and text-flood pages were 156 ms
 * at worst on any runner.
 */
/**
 * The typical pages' snapshot against a plain walk of the same page (#166, #195): at most this many times as long, on
 * every runner. CI's first 77 runs since #186 (2026-11-25, every runner, both pages): 0.87-1.51, while the snapshot's
 * own median went 9.7-48.9 ms. 2 is 1.3 times the worst: a snapshot twice as costly per element as now fails, a slow
 * runner doesn't.
 */
const SNAPSHOT_RATIO_MAX = 2;

/** The typical page's snapshot budget: its median, and its slow end (p90 of 20 runs: never one pause). */
const SNAPSHOT_TYPICAL_MS = { median: 25, worst: 60 };

/** The huge pages' budget, on the median of five runs (a single pause can take one run far past it). */
const SNAPSHOT_HUGE_MS = 300;

/**
 * An action's own work in the page before its input goes (M2c: the element checked against its snapshot, scrolled to and
 * hit-tested), round trip from main, on the typical page: the plan's budget. Measured: the decision record's
 * "M2c: as built".
 */
const ACT_POINT_MS = { median: 15, p95: 40 };

/** The debugger's session for a press or typing (Neon's review of #110): a document's first, then the rest. */
const ACT_DEEP_MS = { first: 200, median: 25, p95: 60 };

/** The send watch's cost: a page of 60 requests loaded with it, against without it (median ms more). */
const SEND_WATCH_EXTRA_MS = 25;
