/**
 * Outside agents' transport (S18 M1b), every path of M0's self-test as units, on
 * every CI OS: the bridge (`chord mcp`'s relay, in-process on streams) against a
 * real endpoint and AgentService, with the connect card answered by the test. Plus Claude Code's and Codex's recorded `initialize`, the token, zero cost
 * with Agents off, the Windows DACL (window-owner.exe's restrict-pipe) and, on
 * Linux, another user refused.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  agentsServe,
  isMcpArgv,
  type Grant,
  type State,
} from '@chord/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runBridge } from '../../src/main/agents/bridge';
import { connectEndpoint, endpointPath, LIVE_MAX, lines, readEndpoint, startEndpoint, UNAUTHENTICATED_MAX } from '../../src/main/agents/endpoint';
import { privateFolder, relayFolder, relayUserData, userCache } from '../../src/main/agents/relay-folder';
import type { ConnectAnswer, ConnectingAgent } from '../../src/main/agents/connect';
import { AgentService, QUEUED_MAX } from '../../src/main/agents/service';
import { watchAgents } from '../../src/main/agents/switch';
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

type Ask = (who: ConnectingAgent, signal: AbortSignal) => Promise<ConnectAnswer>;

/** The connect card, answered as told (after `delayMs`), or no when it's taken down. */
function answering(grant: Grant, delayMs = 0): Ask {
  return (_who, signal) =>
    new Promise<ConnectAnswer>((resolve) => {
      signal.addEventListener('abort', () => resolve({ grant: 'deny', profileId: null }), { once: true });
      if (delayMs) setTimeout(() => resolve({ grant, profileId: null }), delayMs).unref?.();
      else resolve({ grant, profileId: null });
    });
}

/** A held card the test answers itself, counting how many cards were shown. */
function heldCards() {
  const answers: ((g: Grant) => void)[] = [];
  const present: Ask = (_who, signal) =>
    new Promise<ConnectAnswer>((resolve) => {
      answers.push((grant) => resolve({ grant, profileId: null }));
      signal.addEventListener('abort', () => resolve({ grant: 'deny', profileId: null }), { once: true });
    });
  return { answers, present };
}

async function chord(userData: string, ask: Ask = answering('once'), waitMs = 2000, helper: string | null = null) {
  const service = new AgentService({ userData, browser, ask, helper, waitMs });
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

  it('allowed: tools run through the shared layer on the agent’s own tabs (none yet), refusing in one sentence', async () => {
    const ud = profile();
    const service = await chord(ud);
    const c = client(ud);
    await c.initialize();
    // [tool, arguments, what it says]
    const table: [string, Record<string, unknown>, string][] = [
      ['read_tab', { tab_id: 'a1' }, 'No such tab. Use list_tabs or an attached tab id.'],
      ['read_form', { tab_id: 'a1' }, 'No such tab. Use the tab id from "Attached:".'],
      // This service has no chords (no browser to open tabs in): the E2E opens real ones.
      ['open_tab', { url: 'https://example.com/' }, 'This Chord can’t open tabs for agents.'],
      ['close_tab', { tab_id: 'a1' }, 'No such tab. Use list_tabs.'],
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
    // The card shows once the connection's code has loaded: under load that can take a while.
    await expect.poll(() => answers.length).toBe(1);
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
    await expect.poll(() => answers.length).toBe(1);
    answers[0]!('once');
    expect((await retry).error).toBe(false);
    expect((await c.call('list_tabs')).error).toBe(false);
  });

  it('a slow card inside the wait: the call just waits', async () => {
    const ud = profile();
    await chord(ud, answering('once', 300), 2000);
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

  it('a line too long hangs up: past 64 KB before the token', async () => {
    const ud = profile();
    const service = await chord(ud);
    const got = await new Promise<string>((done) => {
      let bytes = '';
      const s = connect(service.serving!.path);
      s.on('connect', () => s.write('x'.repeat(70 * 1024)));
      s.on('data', (d) => (bytes += d));
      s.on('close', () => done(bytes));
      s.on('error', () => done(bytes));
    });
    expect(got).toBe('');
    expect(service.connections.size).toBe(0);
  });

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
    await chord(ud, (who) => (shown.push(who.name), Promise.resolve({ grant: 'once', profileId: null })));
    const c = client(ud);
    const init = (await c.initialize(params)).result;
    expect(init).toMatchObject({ protocolVersion: params['protocolVersion'], capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'chord', title: 'Chord' } });
    expect(String(init['instructions'])).toContain('untrusted');
    expect((await c.request('tools/list')).result['tools']).toEqual(agentToolList());
    expect((await c.call('list_tabs')).error).toBe(false);
    expect(shown).toEqual([name]);
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
  it('the setting serves in every build; CHORD_AGENTS only in development ones', () => {
    // [packaged, setting, CHORD_AGENTS, serves]
    const table: [boolean, boolean, string | undefined, boolean][] = [
      [true, true, undefined, true],
      [true, false, '1', false],
      [true, false, undefined, false],
      [false, false, undefined, false],
      [false, true, undefined, true],
      [false, false, '1', true],
      [false, false, '0', false],
    ];
    for (const [packaged, setting, dev, serves] of table) expect(agentsServe({ packaged }, setting, dev), JSON.stringify([packaged, setting, dev])).toBe(serves);
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

  it('packaged: CHORD_AGENTS does nothing; off: nothing is made or written until the setting turns on, and off again removes it', async () => {
    const ud = profile();
    let made = 0;
    const make = async () => {
      made++;
      return new AgentService({ userData: ud, browser, ask: answering('once'), helper: null });
    };
    const packaged = watchAgents({ packaged: true, store: store(false), devSwitch: '1', make });
    cleanup.push(() => packaged.quit());
    await packaged.settled();
    expect(made).toBe(0);
    expect(existsSync(join(ud, AGENT_ENDPOINT_FILE))).toBe(false);
    const s = store(false);
    const agents = watchAgents({ packaged: false, store: s, devSwitch: undefined, make });
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
    // The token stays with the endpoint.
    expect(held!.hello).not.toHaveProperty('token');
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
  it.skipIf(process.platform === 'win32')('the socket is in a 0700 folder, and the token file is 0600, even over an old one that wasn’t', async () => {
    const ud = profile();
    writeFileSync(join(ud, AGENT_ENDPOINT_FILE), '{}', { mode: 0o644 });
    const service = await chord(ud);
    expect(readdirSync(ud)).toEqual([AGENT_ENDPOINT_FILE]);
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
    const service = await chord(ud, answering('once'), 2000, helper);
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

/** Windows' path separator, as join writes it there. */
const SEP = String.fromCharCode(92);

describe('chord mcp’s own folder (review 1 of #76)', () => {
  // [platform, env, cache, packaged, folder]
  const table: [NodeJS.Platform, NodeJS.ProcessEnv, string, boolean, string][] = [
    ['linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/u/.cache', true, '/run/user/1000/chord-mcp'],
    ['linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/u/.cache', false, '/run/user/1000/chord-dev-mcp'],
    ['linux', {}, '/home/u/.cache', true, '/home/u/.cache/Chord MCP'],
    ['darwin', { XDG_RUNTIME_DIR: '/x' }, '/Users/u/Library/Caches', true, '/Users/u/Library/Caches/Chord MCP'],
  ];
  it.each(table)('%s %j → %s', (platform, env, cache, packaged, folder) => expect(relayFolder(platform, env, cache, packaged).replaceAll(SEP, '/')).toBe(folder));

  it('the cache folder is the user’s own on each OS', () => {
    expect(userCache('linux', {}, '/home/u').replaceAll(SEP, '/')).toBe('/home/u/.cache');
    expect(userCache('linux', { XDG_CACHE_HOME: '/c' }, '/home/u')).toBe('/c');
    expect(userCache('darwin', {}, '/Users/u').replaceAll(SEP, '/')).toBe('/Users/u/Library/Caches');
    expect(userCache('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Local');
  });

  it('a folder of the user’s own is used, made 0700 on POSIX', () => {
    const folder = join(profile(), 'Chord MCP');
    expect(privateFolder(folder)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(relayUserData(folder).path).toBe(folder);
  });

  it.skipIf(process.platform === 'win32')('a link where the folder should be is refused, and the run gets a fresh private folder, removed after', () => {
    const base = profile();
    const target = join(base, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, join(base, 'Chord MCP'));
    expect(privateFolder(join(base, 'Chord MCP'))).toBe(false);
    const scratch = relayUserData(join(base, 'Chord MCP'));
    expect(scratch.path).not.toBe(join(base, 'Chord MCP'));
    expect(statSync(scratch.path).mode & 0o777).toBe(0o700);
    scratch.dispose();
    expect(existsSync(scratch.path)).toBe(false);
  });
});

describe('No work while no agent connects (S18 M1c)', () => {
  it('the agents’ chords, and their watch on the store, start with the first connection', async () => {
    const ud = profile();
    let subscribed = 0;
    const store = { state: { nodes: {}, chords: {}, windows: {}, live: {} } as unknown as State, dispatch: () => undefined, subscribe: () => (subscribed++, () => undefined) };
    const service = new AgentService({ userData: ud, browser, ask: answering('once'), helper: null, waitMs: 2000, chords: { store, page: () => undefined, lastWindow: () => null } });
    await service.start();
    cleanup.push(() => service.stop());
    expect(service.chords).toBeNull();
    expect(subscribed).toBe(0);
    const c = client(ud);
    await c.initialize();
    expect((await c.call('list_tabs')).error).toBe(false);
    expect(service.chords).not.toBeNull();
    expect(subscribed).toBe(1);
  });
});

/** A raw connection to the endpoint: what it was sent, and whether Chord hung up, once `settle` ms pass. */
function rawConnection(path: string, write: string | null, settle = 300) {
  const s = connect(path);
  s.on('error', () => undefined);
  cleanup.push(() => s.destroy());
  let bytes = '';
  let closed = false;
  s.on('connect', () => write !== null && s.write(write));
  s.on('data', (d) => (bytes += d));
  s.on('close', () => (closed = true));
  return { socket: s, settled: () => sleep(settle).then(() => ({ bytes, closed })) };
}

const helloLine = (token: string) => `${JSON.stringify({ type: 'hello', token, initialize: null, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion() })}\n`;

describe('The endpoint under load (security review)', () => {
  it('the first connection hands over the endpoint’s path, before startEndpoint returns (the Windows DACL never waits on it)', async () => {
    const ud = profile();
    const firsts: string[] = [];
    const endpoint = await startEndpoint({ userData: ud, onConnection: () => ({ message: () => undefined }), onFirstConnection: (path) => void firsts.push(path) });
    cleanup.push(() => endpoint.close());
    await rawConnection(endpoint.path, null, 50).settled();
    await rawConnection(endpoint.path, null, 50).settled();
    expect(firsts).toEqual([endpoint.path]);
  });

  // [connections that said hello, connections that haven't, whether one more is hung up on at once]
  const table: [number, number, boolean][] = [
    [0, UNAUTHENTICATED_MAX - 1, false],
    [0, UNAUTHENTICATED_MAX, true],
    [LIVE_MAX - UNAUTHENTICATED_MAX, UNAUTHENTICATED_MAX - 1, false],
    [LIVE_MAX - 1, 0, false],
    [LIVE_MAX, 0, true],
  ];
  it.each(table)('%i in and %i before their hello: the next is refused: %s', async (authenticated, unauthenticated, refused) => {
    const ud = profile();
    let connected = 0;
    const endpoint = await startEndpoint({ userData: ud, onConnection: () => (connected++, { message: () => undefined }) });
    cleanup.push(() => endpoint.close());
    const token = readEndpoint(ud)!.token;
    // One at a time: a burst would be before its hello all at once.
    for (let i = 0; i < authenticated; i++) {
      rawConnection(endpoint.path, helloLine(token));
      await expect.poll(() => connected, { timeout: 5000 }).toBe(i + 1);
    }
    const quiet = Array.from({ length: unauthenticated }, () => rawConnection(endpoint.path, null));
    await sleep(100);
    // The next one says hello at once.
    const next = await rawConnection(endpoint.path, helloLine(token)).settled();
    expect(next.closed).toBe(refused);
    expect(next.bytes).toBe(refused ? '' : `${JSON.stringify({ type: 'welcome' })}\n`);
    // Those already in stay.
    expect((await Promise.all(quiet.map((q) => q.settled()))).every((q) => !q.closed)).toBe(true);
  }, 15_000);

  // [messages sent with the hello, before the connection's code has loaded; whether Chord hangs up]
  const queued: [number, boolean][] = [
    [3, false],
    [QUEUED_MAX + 1, true],
  ];
  it.each(queued)('%i messages while the connection’s code loads: hung up: %s', async (count, hungUp) => {
    const ud = profile();
    await chord(ud);
    const token = readEndpoint(ud)!.token;
    const pings = Array.from({ length: count }, (_, i) => `${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'ping' })}\n`).join('');
    const got = await rawConnection(readEndpoint(ud)!.path, helloLine(token) + pings).settled();
    expect(got.closed).toBe(hungUp);
  });
});
