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
  AGENTS_RELEASED,
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
import { choosePeer } from '../../src/main/agents/peer';
import type { ConnectAnswer, ConnectingAgent } from '../../src/main/agents/connect';
import { AgentService, QUEUED_MAX, RESTRICT_TIMED_OUT, restrictWithRetry } from '../../src/main/agents/service';
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
function client(userData: string, closed?: boolean, cwd = userData) {
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
  runBridge({ userData, input, output, version: '0.0.0-test', onEnd: () => (ended = true), parentPid: process.pid, cwd, closed });
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
    // A build with M2 (development, tests): M1's tools, then M2's (snapshot so far).
    expect(((await c.request('tools/list')).result['tools'] as { name: string }[]).map((t) => t.name)).toEqual(['list_tabs', 'open_tab', 'read_tab', 'tab_screenshot', 'read_form', 'page_diagnostics', 'read_selection', 'close_tab', 'snapshot', 'click', 'type', 'press_key', 'select_option', 'hover', 'navigate', 'back', 'wait_for']);
    expect(await c.call('list_tabs')).toEqual({ error: true, text: CONTROL_REFUSALS.notOpen });
    await chord(ud);
    const listed = await c.call('list_tabs');
    expect(listed.error).toBe(false);
    expect(JSON.parse(listed.text)).toEqual({ trust: 'untrusted', data: { tabs: [] } });
  });

  it('a build without Agents (packaged, before AGENTS_RELEASED): calls say Chord isn’t open even while one serves', async () => {
    const ud = profile();
    const service = await chord(ud);
    const c = client(ud, true);
    await c.initialize();
    expect(((await c.request('tools/list')).result['tools'] as unknown[]).length).toBe(17);
    expect(await c.call('list_tabs')).toEqual({ error: true, text: CONTROL_REFUSALS.notOpen });
    expect(service.connections.size).toBe(0);
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
      // M2d (the owner, 2026-11-23): an address that signs out or deletes asks first, even to open a tab (no card here: a no).
      ['open_tab', { url: 'https://example.com/account/logout' }, 'The user said no to this step. Don’t try it another way; ask the user what to do.'],
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

  it('the store hears how many agents are let in (the command bar offers sharing only then); a denied one doesn’t count', async () => {
    const ud = profile();
    const counts: number[] = [];
    const ask: Ask = async (who) => ({ grant: who.name === 'Codex' ? 'once' : 'deny', profileId: null });
    const service = new AgentService({ userData: ud, browser, ask, helper: null, waitMs: 2000, dispatch: (c) => void (c.t === 'agents.letIn' && counts.push(c.count)) });
    await service.start();
    cleanup.push(() => service.stop());
    const codex = client(ud);
    await codex.initialize({ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '1' } });
    expect((await codex.call('list_tabs')).error).toBe(false);
    expect(counts.at(-1)).toBe(1);
    const other = client(ud);
    await other.initialize();
    expect((await other.call('list_tabs')).error).toBe(true);
    expect(counts.at(-1)).toBe(1);
    expect(service.sharingWith().map((a) => a.name)).toEqual(['Codex']);
    // No store for tabs here: the menu offers nothing, and nothing is shared.
    expect(service.shareMenu('any-tab')).toBeNull();
    expect(service.sharing).toBe(false);
    codex.close();
    await expect.poll(() => counts.at(-1)).toBe(0);
  });

  it('nothing of a connection is handled until the pipe is restricted (the Windows DACL, which the first connection starts)', async () => {
    const ud = profile();
    const events: string[] = [];
    const restrict = (_path: string) =>
      new Promise<number>((done) =>
        setTimeout(() => {
          events.push('restricted');
          done(0);
        }, 300),
      );
    const ask: Ask = async () => (events.push('asked'), { grant: 'once', profileId: null });
    const service = new AgentService({ userData: ud, browser, ask, helper: null, waitMs: 2000, restrict });
    await service.start();
    cleanup.push(() => service.stop());
    const c = client(ud);
    await c.initialize();
    expect((await c.call('list_tabs')).error).toBe(false);
    expect(events).toEqual(['restricted', 'asked']);
    expect(await service.restricted).toBe(0);
  });

  it('restricting the pipe: a failure is logged with its reason and tried once more; the outcome is kept', async () => {
    // [what each try does, the outcome, how many warnings]
    const table: [string, (number | Error)[], number, number][] = [
      ['fine at once', [0], 0, 0],
      ['fails, then works', [5, 0], 0, 1],
      ['fails twice', [5, 7], 7, 2],
      ['doesn’t start, twice', [new Error('spawn window-owner.exe ENOENT'), new Error('spawn window-owner.exe ENOENT')], -1, 2],
      // A timeout already took 10 s: not tried again.
      ['times out', [RESTRICT_TIMED_OUT, 0], RESTRICT_TIMED_OUT, 1],
    ];
    for (const [what, tries, outcome, warnings] of table) {
      const logged: string[] = [];
      let n = 0;
      const restrict = async () => {
        const next = tries[n++]!;
        if (next instanceof Error) throw next;
        return next;
      };
      expect(await restrictWithRetry(restrict, 'pipe', (...a: unknown[]) => void logged.push(a.join(' '))), what).toBe(outcome);
      expect(logged, what).toHaveLength(warnings);
      if (what.startsWith('doesn’t start')) expect(logged[0]).toContain('ENOENT');
      if (what === 'fails twice') expect(logged[1]).toContain('the token still gates every connection');
      if (what === 'times out') expect(logged[0]).toMatch(/it timed out.*the token still gates every connection/);
      if (what === 'times out') expect(n).toBe(1);
    }
  });

  it('Remove in Settings hangs up on that agent, let in for good by that program, and leaves an Allow once one alone', async () => {
    const ud = profile();
    // Claude Code is always allowed, kept by its program; Codex was let in once.
    const ask: Ask = async (who) => (who.name === 'Claude Code' ? { grant: 'always', profileId: null, allowedParent: '/bin/claude' } : { grant: 'once', profileId: null });
    const service = await chord(ud, ask);
    const names = () => [...service.connections].map((h) => h.connection.name).sort();
    const claude = client(ud);
    await claude.initialize({ protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '1' } });
    expect((await claude.call('list_tabs')).error).toBe(false);
    const codex = client(ud);
    await codex.initialize({ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '1' } });
    expect((await codex.call('list_tabs')).error).toBe(false);
    expect(names()).toEqual(['Claude Code', 'Codex']);
    // Another program's allowance by the same name: nothing.
    service.disconnect('Claude Code', '/elsewhere/claude');
    service.disconnect('Codex', '/bin/claude');
    await sleep(50);
    expect(names()).toEqual(['Claude Code', 'Codex']);
    service.disconnect('Claude Code', '/bin/claude');
    await expect.poll(names).toEqual(['Codex']);
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
    expect((await c.request('tools/list')).result['tools']).toEqual(agentToolList(true));
    expect((await c.call('list_tabs')).error).toBe(false);
    expect(shown).toEqual([name]);
    // Connected, tools/list is Chord's own.
    expect((await c.request('tools/list')).result['tools']).toEqual(agentToolList(true));
  });

  it('progress reaches the client through the relay while the connection card waits (#143)', async () => {
    const ud = profile();
    const service = new AgentService({ userData: ud, browser, ask: answering('once', 1200), helper: null, waitMs: 2000, progressMs: 300 });
    await service.start();
    cleanup.push(() => service.stop());
    const c = client(ud);
    await c.initialize();
    const r = await c.request('tools/call', { name: 'list_tabs', arguments: {}, _meta: { progressToken: 'p1' } });
    expect(r.result['isError']).toBe(false);
    expect(c.notifications.filter((m) => m === 'notifications/progress').length).toBeGreaterThanOrEqual(2);
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
    expect(agentToolsVersion(agentToolList(true))).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('Zero cost, and off in packaged builds', () => {
  it('the setting serves in development builds, and in packaged ones once released; CHORD_AGENTS only in development ones', () => {
    // [packaged, setting, CHORD_AGENTS, AGENTS_RELEASED, serves]
    const table: [boolean, boolean, string | undefined, boolean, boolean][] = [
      // Packaged, before 0.14.0: never, whatever the setting or the switch.
      [true, true, undefined, false, false],
      [true, true, '1', false, false],
      [true, false, '1', false, false],
      [true, false, undefined, false, false],
      // Packaged, released.
      [true, true, undefined, true, true],
      [true, false, '1', true, false],
      [true, false, undefined, true, false],
      // Development: the same either way.
      ...[false, true].flatMap((released): [boolean, boolean, string | undefined, boolean, boolean][] => [
        [false, false, undefined, released, false],
        [false, true, undefined, released, true],
        [false, false, '1', released, true],
        [false, false, '0', released, false],
      ]),
    ];
    for (const [packaged, setting, dev, released, serves] of table) expect(agentsServe({ packaged }, setting, dev, released), JSON.stringify([packaged, setting, dev, released])).toBe(serves);
    // The default is this build's AGENTS_RELEASED.
    expect(agentsServe({ packaged: true }, true, undefined)).toBe(AGENTS_RELEASED);
    expect(agentsServe({ packaged: false }, true, undefined)).toBe(true);
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
    // Packaged with the setting saved on, or turned on: serves only once AGENTS_RELEASED (0.14.0).
    const savedOn = store(true);
    const packagedOn = watchAgents({ packaged: true, store: savedOn, devSwitch: undefined, make });
    cleanup.push(() => packagedOn.quit());
    await packagedOn.settled();
    if (!AGENTS_RELEASED) {
      savedOn.set(false);
      savedOn.set(true);
      await packagedOn.settled();
      expect(made).toBe(0);
      expect(existsSync(join(ud, AGENT_ENDPOINT_FILE))).toBe(false);
    } else {
      await packagedOn.quit();
      made = 0;
    }
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
    expect(held!.hello).toMatchObject({ bridgePid: process.pid, parentPid: process.pid, cwd: ud, toolsVersion: agentToolsVersion(agentToolList(true)) });
    // The token stays with the endpoint.
    expect(held!.hello).not.toHaveProperty('token');
  });

  // M2a: Started by comes from the process at the other end, as the OS says (peer.ts), never the hello's parentPid.
  // [the peer the OS gives, M2 in this build, whose chain the card gets: 'parent' (this process's parent: the peer is
  // Chord's own executable, the bridge), 'none', or 'hello' (M1's: from the hello's parentPid, this process)]
  const started: [string, number | null, boolean, 'parent' | 'none' | 'hello'][] = [
    ['the bridge, in Chord’s executable: who started it', process.pid, true, 'parent'],
    ['unknown: nobody, so no program and no Always allow', null, true, 'none'],
    ['a packaged build before M2: the hello’s word, as in M1', null, false, 'hello'],
  ];
  it.each(started)('who started it: %s', async (_name, peerPid, actions, want) => {
    const ud = profile();
    let asked: { claimed: number; endpoint: string } | null = null;
    const service = new AgentService({
      userData: ud,
      browser,
      ask: answering('once'),
      helper: null,
      waitMs: 2000,
      actions,
      peer: async (_socket, endpoint, claimed) => {
        asked = { claimed, endpoint };
        return { pid: peerPid };
      },
    });
    await service.start();
    cleanup.push(() => service.stop());
    const c = client(ud);
    await c.initialize();
    expect((await c.call('list_tabs')).error).toBe(false);
    const [held] = [...service.connections];
    const chain = await held!.parent!;
    if (want === 'none') expect(chain).toEqual([]);
    // Never the wrong process. Where the parent chain comes from the OS's own lookup (PowerShell's on Windows), CI's
    // Windows arm64 runner has had it come back empty (issue #107): nobody is a right answer there, a wrong one never.
    else if (chain.length > 0 || !(process.platform === 'win32' && process.arch === 'arm64')) expect(chain[0]?.pid).toBe(want === 'parent' ? process.ppid : process.pid);
    if (actions) expect(asked).toEqual({ claimed: process.pid, endpoint: service.serving!.path });
    else expect(asked).toBeNull();
    expect(held!.peerPid ?? null).toBe(actions ? peerPid : null);
  }, 20_000);

  it('who started it, from a chain the lookup gave (Windows’ helper): used as given, no second lookup', async () => {
    const ud = profile();
    const bridge = { pid: 123_456, name: 'chord.exe', path: process.execPath, cwd: null, ppid: 77 };
    const claude = { pid: 77, name: 'claude.exe', path: '/opt/claude/claude', cwd: null, ppid: 1 };
    const service = new AgentService({ userData: ud, browser, ask: answering('once'), helper: null, waitMs: 2000, actions: true, peer: async () => ({ pid: bridge.pid, chain: [bridge, claude] }) });
    await service.start();
    cleanup.push(() => service.stop());
    const c = client(ud);
    await c.initialize();
    expect((await c.call('list_tabs')).error).toBe(false);
    const [held] = [...service.connections];
    // The peer is Chord's own executable (the bridge): who started it is the next one.
    expect(await held!.parent!).toEqual([claude]);
  });

  // M2a, review 2 of #103: a bridge PID claimed by two live connections is contested. Neither gets it by claim, both
  // can't tell (no fallback), everyone else counts it taken; it clears as they close.
  it('a contested bridge PID: whoever claimed it first and second both can’t tell; it clears as they close', async () => {
    const ud = profile();
    // The pipe's clients as Windows' helper would list them: the real relay (this process) and the impostor.
    const IMPOSTOR = 999_999;
    const asked: { claimed: number; held: number[] }[] = [];
    let delay: Promise<void> | null = null;
    const service = new AgentService({
      userData: ud,
      browser,
      ask: answering('once'),
      helper: null,
      waitMs: 2000,
      actions: true,
      peer: async (_socket, _endpoint, claimed, held) => {
        asked.push({ claimed, held: [...held] });
        await delay;
        return { pid: choosePeer([process.pid, IMPOSTOR], claimed, held, true) };
      },
    });
    await service.start();
    cleanup.push(() => service.stop());
    const heldBy = (cwd: string) => [...service.connections].find((h) => h.hello.cwd === cwd)!;
    // X, with the token, hellos first as the relay this process is; then the relay's own hello (R) claims it too.
    const x = await connectEndpoint(ud, { initialize: null, bridgePid: process.pid, parentPid: 1, cwd: '/impostor', toolsVersion: agentToolsVersion(agentToolList(true)) });
    await expect.poll(() => service.connections.size).toBe(1);
    const r = client(ud);
    await r.initialize();
    expect((await r.call('list_tabs')).error).toBe(false);
    // X calls too: neither is looked up, and neither gets anyone.
    x!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } })}\n`);
    await expect.poll(() => heldBy('/impostor').parent).not.toBeNull();
    expect(await heldBy('/impostor').parent).toEqual([]);
    expect(await heldBy(ud).parent).toEqual([]);
    expect(heldBy('/impostor').peerPid).toBeNull();
    expect(heldBy(ud).peerPid).toBeNull();
    expect(asked).toEqual([]);
    // X goes: the contest clears, but a later claimant of the same PID contests it with R again.
    x!.destroy();
    await expect.poll(() => service.connections.size).toBe(1);
    const again = client(ud, false, '/again');
    await again.initialize();
    expect((await again.call('list_tabs')).error).toBe(false);
    expect(await heldBy('/again').parent).toEqual([]);
    expect(asked).toEqual([]);
    r.close();
    again.close();
    await expect.poll(() => service.connections.size).toBe(0);
    // Alone again, a claim holds: looked up with its claim, nothing taken.
    const alone = client(ud, false, '/alone');
    await alone.initialize();
    expect((await alone.call('list_tabs')).error).toBe(false);
    expect(asked).toEqual([{ claimed: process.pid, held: [] }]);
    expect(heldBy('/alone').peerPid).toBe(process.pid);
    alone.close();
    await expect.poll(() => service.connections.size).toBe(0);
    // Contested while it looked (another hello arrived meanwhile): what it found isn't used.
    let release!: () => void;
    delay = new Promise((done) => (release = done));
    const looking = client(ud, false, '/looking');
    await looking.initialize();
    const calling = looking.call('list_tabs');
    await expect.poll(() => asked.length).toBe(2);
    const late = await connectEndpoint(ud, { initialize: null, bridgePid: process.pid, parentPid: 1, cwd: '/late', toolsVersion: agentToolsVersion(agentToolList(true)) });
    await expect.poll(() => service.connections.size).toBe(2);
    release();
    expect((await calling).error).toBe(false);
    expect(await heldBy('/looking').parent).toEqual([]);
    expect(heldBy('/looking').peerPid).toBeNull();
    late!.destroy();
  }, 30_000);

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

const helloLine = (token: string) => `${JSON.stringify({ type: 'hello', token, initialize: null, bridgePid: 1, parentPid: 1, cwd: '/', toolsVersion: agentToolsVersion(agentToolList(true)) })}\n`;

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
