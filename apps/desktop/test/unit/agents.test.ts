/**
 * Outside agents' transport (S18 M1b), every path of M0's self-test as units, on
 * every CI OS: the bridge (`chord mcp`'s relay, in-process on streams) against a
 * real endpoint and AgentService, with the development hook for the connection
 * card. Plus Claude Code's and Codex's recorded `initialize`, the token, zero cost
 * with Agents off, the Windows DACL (window-owner.exe's restrict-pipe) and, on
 * Linux, another user refused.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AGENT_ENDPOINT_FILE,
  CONTROL_REFUSALS,
  DEFAULT_SETTINGS,
  agentToolList,
  agentToolsVersion,
  agentsAvailable,
  agentsServe,
  isMcpArgv,
  type Grant,
  type State,
} from '@chord/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runBridge } from '../../src/main/agents/bridge';
import { connectEndpoint, endpointPath, lines, readEndpoint } from '../../src/main/agents/endpoint';
import { AgentService, devApproval, devPresenter } from '../../src/main/agents/service';
import { watchAgents } from '../../src/main/agents/switch';
import type { CardPresenter } from '../../src/main/control/gate';
import type { ControlBrowser } from '../../src/main/control/tools';
import type { Change } from '../../src/main/store';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const profile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chord-agents-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const browser: ControlBrowser = { store: { state: { nodes: {} } as unknown as State }, tabs: { get: () => undefined, ensure: () => undefined }, readers: { viewFor: () => undefined } };

/** A held card the test answers itself, counting how many cards were shown. */
function heldCards() {
  const answers: ((g: Grant) => void)[] = [];
  const present: CardPresenter = (_card, signal) =>
    new Promise<Grant>((resolve) => {
      answers.push(resolve);
      signal.addEventListener('abort', () => resolve('deny'), { once: true });
    });
  return { answers, present };
}

async function chord(userData: string, present: CardPresenter = devPresenter('once'), waitMs = 2000, helper: string | null = null) {
  const service = new AgentService({ userData, browser, present, helper, waitMs });
  await service.start();
  cleanup.push(() => service.stop());
  return service;
}

/** An MCP client on a bridge in this process: as an agent would talk to `chord mcp`. */
function client(userData: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  const notifications: string[] = [];
  let ended = false;
  lines(output, (line) => {
    const m = JSON.parse(line) as { id?: number; method?: string };
    if (m.method) notifications.push(m.method);
    if (typeof m.id === 'number') waiting.get(m.id)?.(m);
  });
  runBridge({ userData, input, output, version: '0.0.0-test', onEnd: () => (ended = true), parentPid: process.pid, cwd: userData });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<{ result: Record<string, unknown> }>((done) => {
      const n = ++id;
      waiting.set(n, done as never);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const c = {
    request,
    notifications,
    initialize: (params: Record<string, unknown> = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', title: 'Fake agent', version: '1' } }) => request('initialize', params),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await request('tools/call', { name, arguments: args });
      const content = r.result['content'] as { text?: string }[];
      return { error: r.result['isError'] === true, text: content[0]?.text ?? '' };
    },
    close: () => input.end(),
    get ended() {
      return ended;
    },
  };
  cleanup.push(() => c.close());
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('chord mcp and the endpoint: M0’s paths', () => {
  it('with Chord not running, initialize and tools/list still work and calls say so; once Chord opens, the next call reaches it', async () => {
    const ud = profile();
    const c = client(ud);
    expect((await c.initialize()).result).toMatchObject({ serverInfo: { name: 'chord' }, capabilities: { tools: { listChanged: true } } });
    expect(((await c.request('tools/list')).result['tools'] as { name: string }[]).map((t) => t.name)).toEqual(['list_tabs', 'open_tab', 'read_tab', 'tab_screenshot', 'read_form', 'page_diagnostics', 'close_tab']);
    expect(await c.call('list_tabs')).toEqual({ error: true, text: CONTROL_REFUSALS.notOpen });
    await chord(ud);
    const listed = await c.call('list_tabs');
    expect(listed.error).toBe(false);
    expect(JSON.parse(listed.text)).toEqual({ trust: 'untrusted', data: { tabs: [] } });
  });

  it('allowed: tools run through the shared layer against the stub scope, refusing in one sentence', async () => {
    const ud = profile();
    const service = await chord(ud);
    const c = client(ud);
    await c.initialize();
    // [tool, arguments, what it says]
    const table: [string, Record<string, unknown>, string][] = [
      ['read_tab', { tab_id: 'a1' }, 'No such tab. Use list_tabs or an attached tab id.'],
      ['read_form', { tab_id: 'a1' }, 'No such tab. Use the tab id from "Attached:".'],
      ['open_tab', { url: 'https://example.com/' }, 'This build of Chord has no Agent chord yet, so it can’t open or close tabs.'],
      ['search_history', { query: 'x' }, 'There’s no tool called search_history. Call tools/list.'],
    ];
    for (const [tool, args, said] of table) expect(await c.call(tool, args), tool).toEqual({ error: true, text: said });
    expect(service.connections.size).toBe(1);
  });

  it('denied: every call says so, and the card shows once', async () => {
    const ud = profile();
    const { answers, present } = heldCards();
    await chord(ud, present);
    const c = client(ud);
    await c.initialize();
    const first = c.call('list_tabs');
    await sleep(50);
    answers[0]!('deny');
    expect(await first).toEqual({ error: true, text: CONTROL_REFUSALS.denied });
    expect(await c.call('list_tabs')).toEqual({ error: true, text: CONTROL_REFUSALS.denied });
    expect(answers).toHaveLength(1);
  });

  it('waiting: a call held past the wait answers waiting; the retry waits on the same card; after the yes, calls work', async () => {
    const ud = profile();
    const { answers, present } = heldCards();
    await chord(ud, present, 150);
    const c = client(ud);
    await c.initialize();
    expect(await c.call('list_tabs')).toEqual({ error: true, text: CONTROL_REFUSALS.waiting });
    const retry = c.call('list_tabs');
    await sleep(50);
    expect(answers).toHaveLength(1);
    answers[0]!('once');
    expect((await retry).error).toBe(false);
    expect((await c.call('list_tabs')).error).toBe(false);
  });

  it('a slow card inside the wait: the call just waits', async () => {
    const ud = profile();
    await chord(ud, devPresenter(devApproval('delay:300')), 2000);
    const c = client(ud);
    await c.initialize();
    expect((await c.call('list_tabs')).error).toBe(false);
  });

  it('stopped: Stop answers a call waiting on its card at once, and refuses every later call', async () => {
    const ud = profile();
    const { present } = heldCards();
    const service = await chord(ud, present, 10_000);
    const c = client(ud);
    await c.initialize();
    const waiting = c.call('list_tabs');
    await sleep(100);
    const started = performance.now();
    service.stopAll();
    expect(await waiting).toEqual({ error: true, text: CONTROL_REFUSALS.stopped });
    expect(performance.now() - started).toBeLessThan(500);
    expect(await c.call('list_tabs')).toEqual({ error: true, text: CONTROL_REFUSALS.stopped });
  });

  it('Chord quits mid-call: the call in flight and the next one say Chord isn’t open', async () => {
    const ud = profile();
    const { present } = heldCards();
    const service = await chord(ud, present, 10_000);
    const c = client(ud);
    await c.initialize();
    const inFlight = c.call('list_tabs');
    await sleep(100);
    await service.stop();
    expect(await inFlight).toEqual({ error: true, text: CONTROL_REFUSALS.notOpen });
    expect(await c.call('list_tabs')).toEqual({ error: true, text: CONTROL_REFUSALS.notOpen });
    expect(existsSync(join(ud, AGENT_ENDPOINT_FILE))).toBe(false);
  });

  it('no token, or a wrong one: the endpoint sends nothing and hangs up', async () => {
    const ud = profile();
    const service = await chord(ud);
    for (const hello of [null, { type: 'hello', token: '00' }, { type: 'hello', token: 'f'.repeat(64) }]) {
      const got = await new Promise<string>((done) => {
        let bytes = '';
        const s = connect(service.serving!.path);
        s.on('connect', () => hello && s.write(`${JSON.stringify(hello)}\n`));
        s.on('data', (d) => (bytes += d));
        s.on('close', () => done(bytes));
        s.on('error', () => done(bytes));
      });
      expect(got).toBe('');
    }
    expect(service.connections.size).toBe(0);
  }, 10_000);

  it('the client going ends the bridge', async () => {
    const ud = profile();
    const c = client(ud);
    await c.initialize();
    c.close();
    await sleep(20);
    expect(c.ended).toBe(true);
  });
});

describe('Real clients’ initialize, replayed (S18 §3)', () => {
  // As Claude Code 2.1.328 and Codex 0.160.1 sent them in M0.
  const clients: [string, Record<string, unknown>][] = [
    [
      'Claude Code',
      {
        protocolVersion: '2025-11-25',
        capabilities: { roots: {}, elicitation: { form: {}, url: {} } },
        clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.328', description: 'Anthropic’s agentic coding tool', websiteUrl: 'https://claude.com/claude-code' },
      },
    ],
    ['Codex', { protocolVersion: '2025-06-18', capabilities: { elicitation: {}, experimental: { 'codex/auth-change': {} } }, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' } }],
  ];
  it.each(clients)('%s: answered in its own protocol version, with the tools and listChanged; its name reaches the card', async (name, params) => {
    const ud = profile();
    const shown: string[] = [];
    await chord(ud, (card) => (shown.push(card.description), Promise.resolve('once')));
    const c = client(ud);
    const init = (await c.initialize(params)).result;
    expect(init).toMatchObject({ protocolVersion: params['protocolVersion'], capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'chord', title: 'Chord' } });
    expect(String(init['instructions'])).toContain('untrusted');
    expect((await c.request('tools/list')).result['tools']).toEqual(agentToolList());
    expect((await c.call('list_tabs')).error).toBe(false);
    expect(shown).toEqual([`“${name}” wants to use Chord`]);
    // Connected, tools/list is Chord's own.
    expect((await c.request('tools/list')).result['tools']).toEqual(agentToolList());
  });

  it('Chord says list_changed when the bridge gave another build’s list', async () => {
    const ud = profile();
    await chord(ud);
    const socket = await connectEndpoint(ud, { initialize: null, bridgePid: 1, parentPid: 1, cwd: ud, toolsVersion: 'other' });
    cleanup.push(() => socket?.destroy());
    const got: string[] = [];
    lines(socket!, (l) => got.push(l));
    await sleep(100);
    expect(got.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([{ type: 'welcome' }, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
    expect(agentToolsVersion()).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('Zero cost, and off in packaged builds', () => {
  it('packaged builds never serve, whatever the setting or CHORD_AGENTS says', () => {
    // [packaged, setting, CHORD_AGENTS, serves]
    const table: [boolean, boolean, string | undefined, boolean][] = [
      [true, true, '1', false],
      [true, false, undefined, false],
      [false, false, undefined, false],
      [false, true, undefined, true],
      [false, false, '1', true],
      [false, false, '0', false],
    ];
    for (const [packaged, setting, dev, serves] of table) expect(agentsServe({ packaged }, setting, dev), JSON.stringify([packaged, setting, dev])).toBe(serves);
    expect(agentsAvailable({ packaged: true })).toBe(false);
  });

  function store(on: boolean) {
    let state = { settings: { ...DEFAULT_SETTINGS, agentsEnabled: on } } as unknown as State;
    const listeners = new Set<(c: Change) => void>();
    return {
      get state() {
        return state;
      },
      subscribe(l: (c: Change) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      set(agentsEnabled: boolean) {
        const before = state;
        state = { settings: { ...state.settings, agentsEnabled } } as unknown as State;
        for (const l of listeners) l({ state, before, patches: [{ op: 'replace', path: ['settings', 'agentsEnabled'], value: agentsEnabled }], effects: [] });
      },
    };
  }

  it('packaged: nothing is even watched; off: nothing is made or written until the setting turns on, and off again removes it', async () => {
    const ud = profile();
    let made = 0;
    const make = async () => {
      made++;
      return new AgentService({ userData: ud, browser, present: devPresenter('once'), helper: null });
    };
    expect(watchAgents({ packaged: true, store: store(true), devSwitch: '1', make })).toBeNull();
    const s = store(false);
    const agents = watchAgents({ packaged: false, store: s, devSwitch: undefined, make })!;
    cleanup.push(() => agents.quit());
    await agents.settled();
    expect(made).toBe(0);
    expect(existsSync(join(ud, AGENT_ENDPOINT_FILE))).toBe(false);
    s.set(true);
    await agents.settled();
    expect(made).toBe(1);
    expect(readEndpoint(ud)?.token).toMatch(/^[0-9a-f]{64}$/);
    // Nothing more until an agent connects: no connection, no parent lookup, no DACL helper.
    expect(agents.service!.connections.size).toBe(0);
    expect(agents.service!.restricted).toBeNull();
    s.set(false);
    await agents.settled();
    expect(existsSync(join(ud, AGENT_ENDPOINT_FILE))).toBe(false);
  });

  it('looks up who started the bridge only once a card shows', async () => {
    const ud = profile();
    const service = await chord(ud);
    const c = client(ud);
    await c.initialize();
    expect((await c.call('list_tabs')).error).toBe(false);
    const [held] = [...service.connections];
    expect(held!.parent).not.toBeNull();
    expect(held!.hello).toMatchObject({ bridgePid: process.pid, parentPid: process.pid, cwd: ud, toolsVersion: agentToolsVersion() });
  });

  // [argv after the executable (and, in development, the app's folder), is it chord mcp?]
  const argv: [string[], boolean][] = [
    [['mcp'], true],
    [['--user-data-dir=/x', 'mcp'], true],
    [['--ozone-platform=headless', 'mcp', '--verbose'], true],
    [[], false],
    [['--no-first-run'], false],
    [['https://example.com/', 'mcp'], false],
    [['--single-argument', 'mcp'], false],
    [['mcp.html'], false],
  ];
  it.each(argv)('%j is chord mcp: %s', (args, mcp) => expect(isMcpArgv(args)).toBe(mcp));
});

describe('Who can reach the endpoint', () => {
  it.skipIf(process.platform === 'win32')('the socket is in a 0700 folder, and the token file is 0600', async () => {
    const ud = profile();
    const service = await chord(ud);
    expect(statSync(dirname(service.serving!.path)).mode & 0o777).toBe(0o700);
    expect(statSync(join(ud, AGENT_ENDPOINT_FILE)).mode & 0o777).toBe(0o600);
    expect(endpointPath('linux', { XDG_RUNTIME_DIR: '/run/user/1000', FLATPAK_ID: 'io.github.anaremore.chord-browser' }, 'ab')).toBe('/run/user/1000/app/io.github.anaremore.chord-browser/chord-agent-ab/s');
  });

  // Linux CI runners have password-less sudo: another user (nobody) can't connect to the socket.
  const sudo = process.platform === 'linux' && spawnSync('sudo', ['-n', 'true']).status === 0;
  it.skipIf(!sudo)('another user (nobody) is refused', async () => {
    const ud = profile();
    const service = await chord(ud);
    const script = `require('net').connect(${JSON.stringify(service.serving!.path)}).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (e) => { console.log(e.code); process.exit(0); })`;
    const out = execFileSync('sudo', ['-n', '-u', 'nobody', process.execPath, '-e', script], { encoding: 'utf8' }).trim();
    expect(out).toBe('EACCES');
  });

  // Windows: window-owner.exe tightens the pipe's DACL on the first connection (built here, as a build does).
  const helper = resolve(import.meta.dirname, '../../out/window-owner/window-owner.exe');
  it.skipIf(process.platform !== 'win32')('the pipe ends up open to SYSTEM and the user only, never the network', async () => {
    spawnSync(process.execPath, [resolve(import.meta.dirname, '../../scripts/build-window-owner.mjs')], { stdio: 'inherit' });
    expect(existsSync(helper)).toBe(true);
    const ud = profile();
    const service = await chord(ud, devPresenter('once'), 2000, helper);
    const dacl = () => execFileSync(helper, ['pipe-dacl', service.serving!.path], { encoding: 'utf8' }).trim();
    expect(dacl()).toMatch(/\(A;;FR;;;WD\)/);
    // Any connection, even one that never says hello, starts it.
    const s = connect(service.serving!.path);
    s.on('error', () => undefined);
    cleanup.push(() => s.destroy());
    await expect.poll(() => service.restricted, { timeout: 5000 }).not.toBeNull();
    expect(await service.restricted).toBe(0);
    const after = dacl();
    // The user by SID, or by its SDDL alias where it has one (CI runs as the built-in Administrator: LA).
    expect(after).toMatch(/^D:P\(D;;FA;;;NU\)\(A;;FA;;;SY\)\(A;;FA;;;(S-1-5-[-\d]+|[A-Z]{2})\)$/);
    expect(after).not.toMatch(/;(WD|AN|BA|BU|AU)\)/);
    // A client of the user's own still gets through.
    const c = client(ud);
    await c.initialize();
    expect((await c.call('list_tabs')).error).toBe(false);
  }, 30_000);
});
