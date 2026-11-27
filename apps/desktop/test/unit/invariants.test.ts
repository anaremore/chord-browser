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
 * - **Page loads around the session gate** (#326): a load or history move on a page outside tabs.ts, each listed with why
 *   it may (inside the gate, Chord's own views, or no site).
 * - **Wall-clock budgets** (issue #85): never in the parallel unit suite, only in `*.perf.test.ts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { code } from './source-code';

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
    ['fetch', 'contents.session', "a tab's favicon: an agent's page (latched) only its own origin's or data:, no credentials, no redirect, never on a Never site (favicon-pick.ts, #115); yours: another site's without cookies, its own site's with them but no redirect (#324)"],
    ['fetch', 'contents.session', "a tab of yours' own-site favicon that redirected or failed, fetched again without cookies (#324); never an agent's (#115)"],
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

/* ---------- Page loads around the session gate ---------- */

/** A load or history move on a page: the call, and what it's called on (whitespace, `!` and `?` left out). */
type Move = { method: string; receiver: string; line: number };

const MOVE_NAMES = 'loadURL|loadFile|reload|reloadIgnoringCache|goBack|goForward|goToIndex|goToOffset|restore';
/**
 * Each place a page is loaded or moved in its history: `.loadURL(`, `?.loadURL(`, `!.loadURL(`, across lines, called as
 * `?.(` or `!(`, through `.call` / `.apply` / `.bind` (`?.call` too), or `['loadURL']` / `?.['loadURL']` (Opus's SF5,
 * round 1 of #333; Neon's NSF3, round 2).
 */
const MOVE = new RegExp(
  `(?:[?!]?\\.\\s*(${MOVE_NAMES})\\b|(?:\\?\\.)?\\[\\s*(['"\`])(${MOVE_NAMES})\\2\\s*\\])(?=\\s*(?:(?:!|\\?\\.)?\\s*\\(|[?!]?\\.\\s*(?:call|apply|bind)\\b))`,
  'g',
);
/** The tab manager's own (tabs.reload, tabs.go…): the gate itself, by these names only (Opus's N2). */
const THE_GATE = new Set(['this.tabs', 'this.deps.tabs', 'this.deps.tabMoves']);

/** What's called, read back from `end` (where its `.` or `[` is): a chain of names, calls and indexes. */
function receiverBefore(text: string, end: number): string {
  let i = end - 1;
  const skip = () => {
    while (i >= 0 && /[\s!?]/.test(text[i]!)) i--;
  };
  const back = (open: string, close: string) => {
    let depth = 0;
    for (; i >= 0; i--) {
      if (text[i] === close) depth++;
      else if (text[i] === open && --depth === 0) {
        i--;
        return;
      }
    }
  };
  skip();
  const stop = i + 1;
  for (;;) {
    if (text[i] === ')') back('(', ')');
    else if (text[i] === ']') back('[', ']');
    while (i >= 0 && /[\w$]/.test(text[i]!)) i--;
    const at = i;
    skip();
    if (text[i] === '.') {
      i--;
      skip();
      continue;
    }
    i = at;
    break;
  }
  return text.slice(i + 1, stop).replace(/[\s!?]/g, '');
}

function moves(source: string): Move[] {
  const text = code(source);
  // Names a file gives a page's history (`const history = contents.navigationHistory`, the repo's own idiom): a restore
  // through one is a page's too (Neon's NSF3).
  const histories = new Set([...text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*[\w$.!?()]*navigationHistory\b/g)].map((m) => m[1]!));
  return [...text.matchAll(MOVE)]
    .map((m) => ({ method: (m[1] ?? m[3])!, receiver: receiverBefore(text, m.index), line: lineOf(text, m.index) }))
    .filter((m) => !THE_GATE.has(m.receiver) && (m.method !== 'restore' || /(?:^|\.)navigationHistory$/.test(m.receiver) || histories.has(m.receiver)));
}

/**
 * Every load and history move on a page (tabs.ts' too), by file, method and receiver, with why it may (#326; round 1 of
 * #333). A new one fails until it's listed here: a page's load goes through the gate (tabs.ts' whenProxied, and
 * queueLoad, load, reload, go, navigate, reopenAt over it), so it never starts before the session's proxy is set or its
 * rules are on, and a load already waiting is dropped for it.
 */
const LOADS: Record<string, [string, string, string][]> = {
  'main/browser.ts': [['loadURL', 'contents', "an image search's upload into a tab: started by the gate (tabs.queueLoad, the `upload` it's given)"]],
  'main/context-menu.ts': [['reload', 'deps', "a page's menu's Reload: `deps.reload`, which a page's menu must have (WebMenuDeps): tabs.reload"]],
  'main/index.ts': [
    ['reload', 'browser.tabs', "the page's Reload key: tabs.reload, the gate (Browser's own tab manager, by another name here)"],
    ['loadURL', 'contents', "the E2E perf hook's timed reloads of a page already loaded (CHORD_E2E only)"],
  ],
  'main/window.ts': [
    ['reload', 'contents', "Chord's own UI view after its renderer crashed: Chord's session, no proxy or rules to wait for"],
    ['loadURL', 'view.webContents', "Chord's own UI view: Chord's session"],
    ['loadURL', 'pageOf(view)', "Chord's own UI views, again after a theme or language change: Chord's session"],
  ],
  'main/ad-blocking/extension.ts': [['loadURL', 'contents', "the blocker extension's own control page, in its own view: no site"]],
  'main/control/page.ts': [
    ['loadURL', 'contents', "the agent's navigate: started by the gate (gatedLoad, the tab manager's queueLoad)"],
    ['goToIndex', 'contents.navigationHistory', "the agent's back: started by the gate, and only if the entry is still the one just before"],
  ],
  'main/extensions/index.ts': [['loadURL', 'win', "an extension's own window (chrome.windows.create): after its session's wait (proxyReady), as a tab's first load"]],
  'main/extensions/popup.ts': [['loadURL', 'contents', "an extension's popup: after its session's wait (proxyReady), as a tab's first load"]],
  'main/safe-browsing/guard.ts': [
    ['goBack', 'contents.navigationHistory', 'Back to safety: leaves a flagged page at once, a load waiting dropped first (guard.ts says why it doesn’t wait, #323)'],
    ['loadURL', 'contents', 'Back to safety with nothing to go back to: about:blank, no request'],
  ],
  'main/tabs.ts': [
    ['loadURL', 'contents', 'load: started by the gate (queueLoad)'],
    ['reloadIgnoringCache', 'contents', 'reload (Hard Reload): started by the gate (queueLoad)'],
    ['reload', 'contents', 'reload: started by the gate (queueLoad)'],
    ['loadURL', 'contents', 'reopenAt: started by the gate (queueLoad)'],
    ['reload', 'contents', 'reopenAt’s reload: after a load that went, in the same turn, through the gate again'],
    ['goBack', 'contents.navigationHistory', 'go: started by the gate (queueLoad), if there’s still somewhere to go'],
    ['goForward', 'contents.navigationHistory', 'go: started by the gate (queueLoad), if there’s still somewhere to go'],
    ['loadURL', 'contents', 'a tab’s first load: started by the gate (whenProxied in ensure)'],
    ['loadURL', 'contents', 'an agent tab’s blank page (about:blank, no request), primed inside the gate’s turn'],
    ['restore', 'contents.navigationHistory', 'restoreInto: a tab’s view made again (sleep, a restart, held for its proxy), its first load; or Reload of one whose restore was dropped (#331). Started by the gate (whenProxied)'],
    ['loadURL', 'contents', 'a restored history that failed: its address, through the gate, in the same turn only'],
    ['loadURL', 'contents', 'a Peek’s or a mini window’s first load: started by the gate (whenProxied in createFloating)'],
    ['reload', 'this', 'a crashed page’s reload: this.reload, the gate, and not over a load you asked for that’s waiting'],
  ],
  'chrome-extensions/browser/popup.ts': [['loadURL', 'win.webContents', "upstream's own popup window: Chord shows popups itself (openActionPopup), so it never opens"]],
  'chrome-extensions/browser/api/tabs.ts': [
    ['reload', 'this', "the API's own handlers (this.reload.bind(this)) as it registers them: no page"],
    ['goForward', 'this', "the API's own handlers (this.goForward.bind(this)) as it registers them: no page"],
    ['goBack', 'this', "the API's own handlers (this.goBack.bind(this)) as it registers them: no page"],
    ['reloadIgnoringCache', 'tab', 'upstream, for an app without reloadTab: Chord has it'],
    ['reload', 'tab', 'upstream, for an app without reloadTab: Chord has it'],
    ['loadURL', 'tab', 'upstream, for an app without navigateTab: Chord has it'],
    ['goForward', 'tab.navigationHistory', 'upstream, for an app without goTab: Chord has it'],
    ['goBack', 'tab.navigationHistory', 'upstream, for an app without goTab: Chord has it'],
  ],
};

describe('page loads around the session gate (#326): every one is audited', () => {
  it('reads each way of writing one, and leaves comments, look-alikes and the tab manager’s own alone (Opus’s SF5, N2)', () => {
    const src = [
      'void contents.loadURL(url); // page.reload()',
      'contents.navigationHistory.goToIndex(2);',
      'pageOf(view)?.loadURL(x);',
      'views[0]!.reload();',
      'contents',
      '  .navigationHistory',
      '  .goBack();',
      "page['loadURL'](url);",
      'page.loadURL.call(page, url);',
      'contents.navigationHistory.restore({ entries, index });',
      'this.tabs.reload(contents);',
      'this.deps.tabMoves.go(contents, "back");',
      'tabs.reload(contents);',
      'win.restore();',
      'const reload = () => 1;',
      'page.reload?.();',
      'page.goBack!();',
      'page.loadURL?.call(page, url);',
      "contents.navigationHistory?.['restore'](state);",
      'const history = contents.navigationHistory;',
      'history.restore({ entries, index });',
    ].join('\n');
    expect(moves(src).map((m) => `${m.method} ${m.receiver}`)).toEqual([
      'loadURL contents',
      'goToIndex contents.navigationHistory',
      'loadURL pageOf(view)',
      'reload views[0]',
      'goBack contents.navigationHistory',
      'loadURL page',
      'loadURL page',
      'restore contents.navigationHistory',
      'reload tabs',
      'reload page',
      'goBack page',
      'loadURL page',
      'restore contents.navigationHistory',
      'restore history',
    ]);
  });

  it('each load or history move is listed, with its reason', () => {
    const roots: [string, string][] = [
      ['main', MAIN],
      ['chrome-extensions/browser', join(repo, 'packages/chrome-extensions/src/browser')],
    ];
    const found: Record<string, [string, string][]> = {};
    for (const [prefix, root] of roots) {
      for (const file of files(root, (name) => name.endsWith('.ts'))) {
        const seen = moves(readFileSync(file, 'utf8')).map((m): [string, string] => [m.method, m.receiver]);
        if (seen.length) found[`${prefix}/${rel(file, root)}`] = seen;
      }
    }
    const listed = Object.fromEntries(Object.entries(LOADS).map(([file, entries]) => [file, entries.map(([method, receiver]): [string, string] => [method, receiver])]));
    expect(found, 'a load or history move outside the gate: go through tabs (queueLoad, load, reload, go, navigate), or list it here with why').toEqual(listed);
    for (const entries of Object.values(LOADS)) for (const [, , why] of entries) expect(why.length).toBeGreaterThan(20);
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

/**
 * #322 (Opus's S1): Chromium resumes the requests paused for a client when it detaches, so a send held for an agent
 * would go. So the debugger is never detached while something is held: every detach is of Chord's own attachment
 * (behind `mine`), and the lease's `turnOff`, which detaches it, runs only after what's held failed (`failHeld`, or
 * `unholdSends`, which fails it first).
 */
describe('a debugger detach never lets a held send go', () => {
  const sites = files(MAIN, (n) => n.endsWith('.ts')).flatMap((f) => {
    const text = code(readFileSync(f, 'utf8'));
    const lines = text.split('\n');
    return [...text.matchAll(/\b(?:debug|debugger)\.detach\(\)/g)].map((m) => {
      const line = lineOf(text, m.index);
      return { file: rel(f), line, before: lines.slice(Math.max(0, line - 3), line).join('\n') };
    });
  });

  it('finds them', () => expect(sites.length, 'the scan found no detach at all: has main moved?').toBeGreaterThanOrEqual(4));

  it('every detach is of Chord’s own attachment (behind `mine`)', () => {
    expect(sites.filter((s) => !/\bmine\b/.test(s.before)).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it('the lease’s turnOff (it detaches) runs only after what’s held failed', () => {
    const text = code(readFileSync(join(MAIN, 'control/user-watch.ts'), 'utf8'));
    const lines = text.split('\n');
    const calls = [...text.matchAll(/await turnOff\(/g)].map((m) => lineOf(text, m.index));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const late = calls.filter((line) => !/\b(?:failHeld|unholdSends)\(contents\)/.test(lines.slice(Math.max(0, line - 16), line - 1).join('\n')));
    expect(late.map((line) => `control/user-watch.ts:${line}`)).toEqual([]);
  });
});

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
