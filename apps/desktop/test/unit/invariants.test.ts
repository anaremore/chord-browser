/**
 * Checks for what reviews kept missing (Neon's factory audit, 2026-11-24), in the style of chromium-sandbox.test.ts:
 * a scan of the source and explicit registries, each entry with its reason. A new call site fails here until it's
 * classified, so the question is asked when the code is written, not in review round three.
 *
 * - **Agent input** (S18, control/input.ts): Chord sends an agent's clicks and keys through `sendInputEvent`, so every
 *   `before-input-event`, `before-mouse-event` and `input-event` listener in main sees them too. Each either asks
 *   `isAgentInput` or says here why it needn't.
 * - **Requests and windows from main** (S18 M2d, control/sends.ts): a `fetch` through a session, a window-open handler
 *   or a debugger attached from main, outside an agent tab's Fetch hold. Each is listed with what it does for an
 *   agent's tab.
 * - **Wall-clock budgets** (issue #85): never in the parallel unit suite, only in `*.perf.test.ts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const MAIN = join(repo, 'apps/desktop/src/main');

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(path, test);
    return test(entry.name) ? [path] : [];
  });
}

const rel = (file: string, from = MAIN) => relative(from, file).replaceAll('\\', '/');
const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

/** The text with comments blanked out (lengths and lines kept), and strings left as they are. */
function code(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (; j < text.length && text[j] !== ch; j++) if (text[j] === '\\') j++;
      out += text.slice(i, j + 1);
      i = j;
    } else out += ch;
  }
  return out;
}

/** The text between the `(` at `open` and its matching `)`, past strings. */
function balanced(text: string, open: number, [o, c] = ['(', ')']): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${o} at offset ${open}`);
}

/* ---------- Agent input ---------- */

const INPUT_EVENTS = /'(before-input-event|before-mouse-event|input-event)'/g;

type Listener = { event: string; line: number; checks: boolean };

/**
 * Each place `text` subscribes to an input event: the event's name in code, unless it's taking a listener off. Whether
 * it asks `isAgentInput`: in the call's own arguments, or in the named handler it passes (its definition's body).
 */
function inputListeners(source: string): Listener[] {
  const text = code(source);
  return [...text.matchAll(INPUT_EVENTS)].flatMap((m): Listener[] => {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/\.(?:off|removeListener|removeAllListeners)\(\s*(?:[\w$]+\s+as\s+)?$/.test(before)) return [];
    const call = /\.(?:on|once|addListener|prependListener|prependOnceListener)\(\s*(?:[\w$]+\s+as\s+)?$/.exec(before);
    let args = '';
    if (call) {
      const open = m.index - before.length + call.index + call[0].indexOf('(');
      args = balanced(text, open);
    }
    let checks = /\bisAgentInput\(/.test(args);
    const handler = /,\s*([\w$.]+)\s*$/.exec(args)?.[1]?.split('.').at(-1);
    if (!checks && handler) {
      // Its definition: the nearest one before the listener (an arrow function given a name, or a method).
      const pattern = new RegExp(`\\b${handler}\\s*(?::[^=]+)?=\\s*(?:\\([^)]*\\)|[\\w$]+)\\s*(?::[^=]+)?=>\\s*\\{|\\b${handler}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`, 'g');
      const defs = [...text.matchAll(pattern)];
      const def = defs.filter((d) => d.index < m.index).at(-1) ?? defs[0];
      if (def) checks = /\bisAgentInput\(/.test(balanced(text, def.index + def[0].length - 1, ['{', '}']));
    }
    return [{ event: m[1]!, line: lineOf(text, m.index), checks }];
  });
}

/** Why a listener needn't ask: it's never on a page an agent acts in, or acting on an agent's input is right. */
type Exempt = string;
/** It asks `isAgentInput`. */
const CHECKS = 'checks';
/** A known gap, with where it's being fixed: fails once fixed, so the entry becomes `CHECKS`. */
type Gap = { gap: string };

/**
 * Every input listener in apps/desktop/src/main, file by file, in the order they appear. Agent input reaches only an
 * agent's tab today (control/page.ts; agent tabs are never pinned, open no popups and have no Peek or mini window);
 * M2e's assistant acts in your own tabs too, so entries that say "your tab" are rechecked then.
 */
const INPUT_LISTENERS: Record<string, (typeof CHECKS | Exempt | Gap)[]> = {
  'agents/chords.ts': [CHECKS, CHECKS],
  'browser.ts': [
    // Your key or click in a tab of yours, before its page sees it (S18 M2e-2a, F1): the assistant's own input isn't yours.
    CHECKS,
    CHECKS,
    CHECKS,
    'DevTools front end of a tab (wire): Chord never sends an agent input there',
    "the passwords menu's own view (Chord's UI): never an agent's page",
    "the shell (Chord's UI): the swipe's gesture phases only",
    "reader view (Chord's own page for a tab): never an agent's page",
  ],
  'devtools.ts': ["the DevTools window's bar (Chord's UI): never an agent's page", CHECKS],
  'extensions/popup.ts': ["an extension's popup: never an agent's page"],
  'frame-snapshot.ts': ["typing ends a chord switch's motion early: harmless for an agent's key, it only shows the page sooner"],
  'index.ts': [
    "the E2E hook's list of the three events (CHORD_E2E only), subscribed on the next line",
    "the E2E hook's list of the three events (CHORD_E2E only), subscribed on the next line",
    "the E2E hook's list of the three events (CHORD_E2E only), subscribed on the next line",
    CHECKS,
  ],
  'keyboard.ts': [CHECKS],
  'mini-window.ts': ["a mini window's page and bar: never an agent's (agent tabs open no windows: tabs.ts openFrom); recheck in M2e"],
  // S18 A4 (Neon's M2e blocker B2), closed in M2e-2a: the menu's key guard ignores the input Chord sends.
  'passwords/assist.ts': [CHECKS],
  'peek.ts': ["Peek's page: never an agent's (Peek opens from pinned tabs; agent tabs are never pinned); recheck in M2e"],
  // Peek's link gesture in a pinned tab: closed in M2e-2b, an assistant's click in your pinned tab never opens Peek.
  'tabs.ts': [CHECKS],
  'window.ts': ["the popover's card (Chord's UI): never an agent's page"],
};

describe('agent input: every input listener in main is classified', () => {
  it('reads a call across lines, a named handler, and skips taking one off', () => {
    const src = [
      "contents.on('before-input-event', (event, input) => {",
      '  if (isAgentInput(contents)) return;',
      '});',
      "contents.on('input-event', mine); // 'before-mouse-event'",
      "contents.off('input-event', mine);",
      'const mine = (event: Event, input: Input) => {',
      '  if (!isAgentInput(contents)) focus();',
      '};',
      "contents.prependListener('before-mouse-event', guard.onKey);",
      "for (const name of names) contents.on(name as 'input-event', count);",
    ].join('\n');
    expect(inputListeners(src)).toEqual([
      { event: 'before-input-event', line: 1, checks: true },
      { event: 'input-event', line: 4, checks: true },
      { event: 'before-mouse-event', line: 9, checks: false },
      { event: 'input-event', line: 10, checks: false },
    ]);
  });

  const found = new Map(files(MAIN, (n) => n.endsWith('.ts')).map((f) => [rel(f), inputListeners(readFileSync(f, 'utf8'))] as const).filter(([, l]) => l.length > 0));

  it('finds them', () => {
    expect([...found.values()].flat().length, 'the scan found no listeners at all: has main moved?').toBeGreaterThan(10);
  });

  it('lists every file that has one, and no file that has none', () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(INPUT_LISTENERS).sort());
  });

  it.each(Object.entries(INPUT_LISTENERS))('%s: each listener asks isAgentInput, or says why it needn’t', (file, entries) => {
    const listeners = found.get(file) ?? [];
    const where = listeners.map((l) => `${l.event} at line ${l.line}${l.checks ? ' (checks)' : ''}`).join(', ');
    expect(listeners.length, `${file} has ${listeners.length} input listeners (${where}): classify each in INPUT_LISTENERS`).toBe(entries.length);
    listeners.forEach((listener, i) => {
      const entry = entries[i]!;
      const at = `${file}:${listener.line} (${listener.event})`;
      if (entry === CHECKS) expect(listener.checks, `${at} is listed as asking isAgentInput, and doesn't`).toBe(true);
      else if (typeof entry === 'object') expect(listener.checks, `${at} asks isAgentInput now: the gap is closed, so mark it CHECKS`).toBe(false);
      else expect(listener.checks, `${at} asks isAgentInput now: mark it CHECKS`).toBe(false);
    });
  });
});

/* ---------- Requests and windows from main ---------- */

type Site = { kind: 'fetch' | 'window-open' | 'debugger'; receiver: string; line: number };

const SITES: [Site['kind'], RegExp][] = [
  // A fetch through anything: a session, net, an injected fetch (`this.deps.fetch`).
  ['fetch', /((?:\(await [\w$.]+\(\)\))|[\w$]+(?:\.[\w$]+)*)\.fetch\s*\(/g],
  ['window-open', /([\w$]+(?:\.[\w$]+)*)\.setWindowOpenHandler\s*\(/g],
  // A debugger's attach takes the protocol's version, or nothing.
  ['debugger', /([\w$]+(?:\.[\w$]+)*)\.attach\s*\(\s*(?:'\d|"\d|\))/g],
];

function callSites(source: string): Site[] {
  const text = code(source);
  return SITES.flatMap(([kind, pattern]) =>
    [...text.matchAll(pattern)]
      .filter((m) => kind !== 'debugger' || /(?:^|\.)(?:debug|debugger)$/.test(m[1]!) || /\(\s*['"]\d/.test(m[0]))
      .map((m) => ({ kind, receiver: m[1]!, line: lineOf(text, m.index) })),
  ).sort((a, b) => a.line - b.line);
}

/**
 * Every fetch, window-open handler and debugger attach in apps/desktop/src/main, by file, receiver and what it means
 * for an agent's tab (S18: its Fetch hold, `isNeverReadable`, and no windows of its own). A new one fails until it's
 * listed here, with its reason.
 */
const AUDITED: Record<string, [Site['kind'], string, string][]> = {
  'ad-blocking/service.ts': [['fetch', '(await this.session())', 'filter lists, through its own session, no credentials: no page of yours or an agent’s']],
  'agents/pickers.ts': [['debugger', 'debug', "an agent tab's debugger, attached for the tab's life: it's what arms the Fetch hold"]],
  'assistant/service.ts': [['fetch', 'net', 'a file you attached, read from disk (file: URL): no network']],
  'control/deep.ts': [['debugger', 'debug', "the assistant's deep read, through the tab's debugger queue (debugger-queue.ts); detached unless another client had it"]],
  'control/diagnostics.ts': [['debugger', 'debug', "page_diagnostics' read: Log and Runtime only, let go after the read"]],
  'control/user-watch.ts': [
    [
      'debugger',
      'debug',
      "the assistant's lease on a tab of yours (S18 M2e-2a): attached through the debugger queue right before its action, which arms the Fetch hold (sends.ts) before anything goes in; let go at the lease's end, detached unless another client had it",
    ],
  ],
  'control/pdf.ts': [['fetch', 'contents.session', "the PDF a tab shows, for a read tool: `readable` (isNeverReadable) is asked about the final address, after redirects"]],
  'devtools.ts': [['window-open', 'contents', 'DevTools: denied']],
  'extensions/index.ts': [['window-open', 'win.webContents', "an extension's own window: links become tabs of yours"]],
  'extensions/popup.ts': [['window-open', 'contents', "an extension's popup: links become tabs of yours"]],
  'extensions/webstore.ts': [
    ['fetch', 'this.options', "the Web Store's update check, with the injected fetch: no page's session"],
    ['fetch', 'this.options', "an extension's package download, with the injected fetch: no page's session"],
  ],
  'index.ts': [
    ['fetch', 'playerFetchSession', "Chord Player's updates: its own in-memory session, no cookies"],
    ['fetch', 'net', "the E2E hook's fetch (CHORD_E2E only)"],
  ],
  'media.ts': [
    [
      'fetch',
      'contents.session',
      "now-playing artwork through the tab's session. FINDING: runs for an agent's tab too (no agentTab check), with its cookies, outside the Fetch hold and isNeverReadable; the #115 class",
    ],
  ],
  'player/installer.ts': [
    ['fetch', 'this.deps', "Chord Player's release feed, through its own session (index.ts)"],
    ['fetch', 'this.deps', "a release file, through Chord Player's own session"],
    ['fetch', 'this.deps', "Chord Player's package, through its own session"],
  ],
  'protocol.ts': [['fetch', 'net', "Chord's own UI files from disk (file: URL)"]],
  'reader/service.ts': [
    ['window-open', 'contents', "reader view (Chord's own page): links open as tabs of yours"],
    ['fetch', 'reader.session', "reader view's images, which you opened; reader view isn't an agent's tool"],
  ],
  'safe-browsing/service.ts': [['fetch', '(await this.session())', "Safe Browsing's lookups, through its own session"]],
  'screenshots/service.ts': [['debugger', 'debug', 'your screenshot of a whole page, through the debugger queue; detached unless another client had it']],
  'security.ts': [['window-open', 'contents', "Chord's own UI views: denied"]],
  'suggestions.ts': [['fetch', 'ses', "the search engine's suggestions, through their own session, no credentials"]],
  'tabs.ts': [
    ['window-open', 'contents', "a tab's window.open: an agent's tab opens nothing (openFrom, agentPage)"],
    ['window-open', 'contents', 'a popup opened by a tab of yours (agent tabs open none)'],
    ['fetch', 'contents.session', "a tab's favicon. FINDING (issue #115): runs for an agent's tab too, with its cookies, outside the Fetch hold and isNeverReadable"],
  ],
  'updates.ts': [['fetch', '(await this.session())', "Chord's update feed, through its own session"]],
};

describe('requests and windows from main: every call site is audited', () => {
  it('reads each kind, and leaves comments and look-alikes alone', () => {
    const src = [
      'const r = await contents.session.fetch(url); // x.fetch(y)',
      'await (await this.session()).fetch(url);',
      'win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));',
      "if (!debug.isAttached()) debug.attach('1.3');",
      'this.media.attach(contents, nodeId);',
      'fetch(url: string): Promise<Response>;',
    ].join('\n');
    expect(callSites(src).map((s) => `${s.kind} ${s.receiver}`)).toEqual([
      'fetch contents.session',
      'fetch (await this.session())',
      'window-open win.webContents',
      'debugger debug',
    ]);
  });

  const found = new Map(files(MAIN, (n) => n.endsWith('.ts')).map((f) => [rel(f), callSites(readFileSync(f, 'utf8'))] as const).filter(([, s]) => s.length > 0));

  it('finds them', () => {
    expect([...found.values()].flat().length, 'the scan found none at all: has main moved?').toBeGreaterThan(20);
  });

  it('lists every file that has one, and no file that has none', () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(AUDITED).sort());
  });

  it.each(Object.entries(AUDITED))('%s: each call site is listed, with what it means for an agent’s tab', (file, entries) => {
    const sites = found.get(file) ?? [];
    const got = sites.map((s) => `${s.kind} ${s.receiver}`).sort();
    const listed = entries.map(([kind, receiver]) => `${kind} ${receiver}`).sort();
    const where = sites.map((s) => `${s.kind} ${s.receiver} at line ${s.line}`).join(', ');
    expect(got, `${file}: ${where}. Classify a new one in AUDITED, and take out one that's gone`).toEqual(listed);
  });
});

/* ---------- Wall-clock budgets ---------- */

/** The unit suite's files (vitest.config.ts's `include`), but for the perf suite's. */
function unitFiles(): string[] {
  const each = (top: string, ...sub: string[]) => readdirSync(join(repo, top), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(repo, top, d.name, ...sub));
  const dirs = [...each('packages', 'test'), ...each('apps', 'test', 'unit'), ...each('apps', 'test', 'web'), join(repo, 'scripts/test'), join(repo, 'site/test')];
  return dirs.filter((dir) => existsSync(dir)).flatMap((dir) => files(dir, (n) => n.endsWith('.test.ts') && !n.endsWith('.perf.test.ts')));
}

const CLOCK = /\b(?:performance|Date)\.now\(\)/;

/**
 * Each `expect(…)` held under a bound (`toBeLessThan`, `toBeLessThanOrEqual`) whose value is a time measured: a
 * clock's difference (`performance.now() - started`), or a name given one, directly or through another (`longest =
 * Math.max(longest, now - last)`, where `now` is a clock's reading).
 */
function wallClockBudgets(source: string): number[] {
  const text = code(source);
  const assigns = [...text.matchAll(/\b([\w$]+)\s*=(?!=)\s*([^;\n]+)/g)].map((m) => ({ name: m[1]!, value: m[2]! }));
  const clocks = new Set(assigns.filter((a) => new RegExp(`^${CLOCK.source}\\s*$`).test(a.value.trim())).map((a) => a.name));
  const clockExpr = () => `(?:${CLOCK.source}|\\b(?:${[...clocks].join('|') || '$^'})\\b)`;
  const isDifference = (value: string) => new RegExp(`${clockExpr()}\\s*-|-\\s*${clockExpr()}`).test(value);
  const elapsed = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of assigns) {
      if (elapsed.has(a.name)) continue;
      if (isDifference(a.value) || [...elapsed].some((e) => new RegExp(`\\b${e}\\b`).test(a.value))) {
        elapsed.add(a.name);
        grew = true;
      }
    }
  }
  return [...text.matchAll(/\bexpect\s*\(/g)].flatMap((m) => {
    const open = m.index + m[0].length - 1;
    const args = balanced(text, open);
    const after = text.slice(open + args.length + 2, open + args.length + 2 + 40);
    if (!/^\s*\.(?:not\.)?toBeLessThan(?:OrEqual)?\(/.test(after)) return [];
    const value = args.split(/,(?![^(]*\))/)[0]!;
    const timed = isDifference(value) || [...elapsed].some((e) => new RegExp(`^\\s*${e}\\s*$`).test(value));
    return timed ? [lineOf(text, m.index)] : [];
  });
}

describe('wall-clock budgets: only in *.perf.test.ts', () => {
  it('finds a stopwatch, and leaves a clock alone', () => {
    const src = [
      'const started = performance.now();',
      'expect(performance.now() - started).toBeLessThan(500);',
      'const ms = performance.now() - started;',
      'expect(ms, seen).toBeLessThan(150);',
      'let last = performance.now();',
      'const now = performance.now(); longest = Math.max(longest, now - last);',
      'expect(longest).toBeLessThanOrEqual(100);',
      'expect(outbox().at(-1)!.at![0]).toBeLessThanOrEqual(Date.now() + CLOCK_DRIFT_MS);',
      'const result = db.sync.merge(records, Date.now());',
      'expect(result.newest).toBeLessThanOrEqual(Date.now());',
      'expect(elements(big.content).length).toBeLessThan(60_000);',
    ].join('\n');
    expect(wallClockBudgets(src)).toEqual([2, 4, 7]);
  });

  it('none in the unit suite', () => {
    const self = resolve(import.meta.filename);
    const all = unitFiles().filter((f) => resolve(f) !== self);
    expect(all.length, 'the scan found no unit tests: has the layout moved?').toBeGreaterThan(50);
    const found = all.flatMap((file) => wallClockBudgets(readFileSync(file, 'utf8')).map((line) => `${rel(file, repo)}:${line}`));
    expect(found, 'a wall-clock budget flakes beside every other file (issue #85): move it to a *.perf.test.ts (pnpm test:perf)').toEqual([]);
  });
});
