/**
 * Proxies (ARCHITECTURE.md §9): what a typed proxy may be, the config
 * session.setProxy takes, which session gets which proxy, and how the model
 * keeps a chord's own proxy to a chord with its own sign-ins.
 */
import { describe, expect, it } from 'vitest';
import {
  apply,
  bypassRule,
  cleanProxy,
  describeLoadError,
  emptyState,
  IDLE_LIVE,
  proxyBypassProblem,
  proxyConfig,
  proxyFor,
  proxyHost,
  proxyHostProblem,
  proxyLabel,
  proxyPac,
  proxyPacProblem,
  proxyPort,
  proxyPortProblem,
  restoreState,
  splitBypass,
  splitProxyAddress,
  type Chord,
  type Command,
  type Context,
  type ProxySettings,
  type State,
} from '../src';

const server = (host: string, port: number, scheme: 'http' | 'https' | 'socks5' = 'http', bypass: string[] = []) => ({ scheme, host, port, bypass });
const A: ProxySettings = { mode: 'server', server: server('10.0.0.2', 3128), pac: null };
const B: ProxySettings = { mode: 'server', server: server('proxy.example', 1080, 'socks5'), pac: null };

describe('a typed proxy', () => {
  it.each([
    ['proxy.example', 'proxy.example'],
    ['  Proxy.Example  ', 'proxy.example'],
    ['localhost', 'localhost'],
    ['10.0.0.2', '10.0.0.2'],
    ['::1', '[::1]'],
    ['[2001:db8::1]', '[2001:db8::1]'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['corp_proxy.internal', 'corp_proxy.internal'],
    // Not a host: Chromium would read these as something else, or can't.
    ['', null],
    ['proxy.example:8080', null],
    ['http://proxy.example', null],
    ['me:secret@proxy.example', null],
    ['proxy example', null],
    ['proxy.example/path', null],
    ['10.1', null],
    ['010.0.0.1', null],
    ['256.0.0.1', null],
    ['-proxy.example', null],
    ['[::1', null],
  ])('host %j → %j', (typed, host) => {
    expect(proxyHost(typed)).toBe(host);
  });

  it.each([
    ['8080', 8080],
    [' 1 ', 1],
    ['65535', 65535],
    [1080, 1080],
    ['0', null],
    ['65536', null],
    ['80a', null],
    ['', null],
    ['-1', null],
    ['8080.5', null],
  ] as const)('port %j → %j', (typed, port) => {
    expect(proxyPort(typed)).toBe(port);
  });

  it.each([
    ['<local>', '<local>'],
    ['<-loopback>', '<-loopback>'],
    ['*.Example.com', '*.example.com'],
    ['.example.com', '.example.com'],
    ['intranet', 'intranet'],
    ['*', '*'],
    ['https://x.*.y.com:99', 'https://x.*.y.com:99'],
    ['10.0.0.0/8', '10.0.0.0/8'],
    ['192.168.1.1/32', '192.168.1.1/32'],
    ['fd00::/8', 'fd00::/8'],
    ['[fd00::]/8', 'fd00::/8'],
    ['[::1]', '[::1]'],
    ['[::1]:8080', '[::1]:8080'],
    ['example.com:443', 'example.com:443'],
    ['10.0.0.0/33', null],
    ['example.com:99999', null],
    ['exa mple.com', null],
    ['example.com/path', null],
    ['::1', null],
    ['...', null],
  ])('address that skips the proxy %j → %j', (typed, rule) => {
    expect(bypassRule(typed)).toBe(rule);
  });

  it('splits the addresses as Chromium does: commas, semicolons, spaces; repeats once', () => {
    expect(splitBypass(' localhost, *.intranet.example;10.0.0.0/8\n<local>  localhost ')).toEqual(['localhost', '*.intranet.example', '10.0.0.0/8', '<local>']);
    expect(splitBypass('')).toEqual([]);
  });

  it.each([
    ['http://wpad.example/proxy.pac', 'http://wpad.example/proxy.pac'],
    ['https://wpad.example/proxy.pac', 'https://wpad.example/proxy.pac'],
    ['file:///etc/proxy.pac', 'file:///etc/proxy.pac'],
    ['data:application/x-ns-proxy-autoconfig,function FindProxyForURL(){return "DIRECT"}', 'data:application/x-ns-proxy-autoconfig,function FindProxyForURL(){return "DIRECT"}'],
    ['wpad.example/proxy.pac', null],
    ['ftp://wpad.example/proxy.pac', null],
    ['javascript:alert(1)', null],
    ['http://', null],
    ['', null],
  ])('configuration file %j → %j', (typed, pac) => {
    expect(proxyPac(typed)).toBe(pac);
  });

  it.each([
    ['socks5://10.0.0.2:1080', { scheme: 'socks5', host: '10.0.0.2', port: 1080 }],
    ['socks5h://proxy.example:1080/', { scheme: 'socks5', host: 'proxy.example', port: 1080 }],
    ['socks://proxy.example', { scheme: 'socks5', host: 'proxy.example' }],
    ['http://Proxy.Example:3128', { scheme: 'http', host: 'proxy.example', port: 3128 }],
    ['https://proxy.example', { scheme: 'https', host: 'proxy.example' }],
    ['proxy.example:3128', { host: 'proxy.example', port: 3128 }],
    ['[::1]:1080', { host: '[::1]', port: 1080 }],
    ['10.0.0.2', { host: '10.0.0.2' }],
    ['me:secret@proxy.example:3128', null],
    ['socks4://proxy.example:1080', null],
    ['proxy.example:99999', null],
  ])('a whole address pasted, %j, goes to its fields', (typed, fields) => {
    expect(splitProxyAddress(typed)).toEqual(fields);
  });

  it('says what is wrong in Chord’s words, and nothing when it can be used', () => {
    const problems = {
      host: ['', 'socks4://proxy.example', 'http://proxy.example', 'me@proxy.example', 'proxy.example:8080', 'proxy example', 'proxy.example'].map(proxyHostProblem),
      port: ['', '0', '70000', '3128'].map(proxyPortProblem),
      bypass: ['', 'localhost, *.intranet', 'localhost, example.com/path'].map(proxyBypassProblem),
      pac: ['', 'wpad.example/x.pac', 'http://wpad.example/x.pac'].map(proxyPacProblem),
    };
    expect(problems.host.map((p) => p?.split(/[.:]/)[0] ?? null)).toEqual([
      'Enter the proxy’s address',
      'Chord connects to SOCKS proxies with SOCKS5, so the proxy looks up the sites’ names',
      'Just the address, without http',
      'Just the address',
      'Put the port in the box beside it',
      'That isn’t an address Chord can use',
      null,
    ]);
    expect(problems.port).toEqual(['Enter the port.', 'A port is a whole number from 1 to 65535.', 'A port is a whole number from 1 to 65535.', null]);
    expect(problems.bypass).toEqual([null, null, 'Chord can’t read “example.com/path”. Use names like *.example.com, addresses like 10.0.0.0/8, or <local>.']);
    expect(problems.pac).toEqual(['Enter the file’s address.', 'Enter the file’s full address, starting with http://, https:// or file://.', null]);
    expect(proxyBypassProblem(Array.from({ length: 101 }, (_, i) => `h${i}.example`).join(','))).toBe('At most 100 addresses.');
  });
});

describe('what session.setProxy takes', () => {
  it.each<[string, ProxySettings, ReturnType<typeof proxyConfig>]>([
    ['the system’s (Electron’s default)', { mode: 'system', server: null, pac: null }, { mode: 'system' }],
    ['none, a server kept for later', { mode: 'none', server: server('10.0.0.2', 3128), pac: null }, { mode: 'direct' }],
    ['an HTTP proxy', A, { mode: 'fixed_servers', proxyRules: 'http://10.0.0.2:3128', proxyBypassRules: '' }],
    ['an HTTPS proxy', { mode: 'server', server: server('proxy.example', 443, 'https'), pac: null }, { mode: 'fixed_servers', proxyRules: 'https://proxy.example:443', proxyBypassRules: '' }],
    [
      'SOCKS5 (names looked up at the proxy) with addresses that skip it',
      { mode: 'server', server: server('[::1]', 1080, 'socks5', ['<local>', '*.intranet.example']), pac: null },
      { mode: 'fixed_servers', proxyRules: 'socks5://[::1]:1080', proxyBypassRules: '<local>,*.intranet.example' },
    ],
    ['a configuration file', { mode: 'pac', server: null, pac: 'http://wpad.example/proxy.pac' }, { mode: 'pac_script', pacScript: 'http://wpad.example/proxy.pac' }],
  ])('%s', (_name, proxy, config) => {
    expect(proxyConfig(proxy)).toEqual(config);
  });

  it.each<[ProxySettings, string]>([
    [{ mode: 'system', server: null, pac: null }, 'The system’s proxy'],
    [{ mode: 'none', server: null, pac: null }, 'No proxy'],
    [A, 'HTTP proxy at 10.0.0.2:3128'],
    [B, 'SOCKS5 proxy at proxy.example:1080'],
    [{ mode: 'pac', server: null, pac: 'https://wpad.example/proxy.pac' }, 'Automatic configuration from wpad.example'],
    [{ mode: 'pac', server: null, pac: 'file:///etc/proxy.pac' }, 'Automatic configuration from a file on this computer'],
  ])('reads %j as %j', (proxy, label) => {
    expect(proxyLabel(proxy)).toBe(label);
  });
});

describe('cleanProxy', () => {
  it.each<[string, unknown, ProxySettings | null]>([
    ['the default', { mode: 'system', server: null, pac: null }, { mode: 'system', server: null, pac: null }],
    ['a server, its host and rules as Chromium reads them', { mode: 'server', server: { scheme: 'socks5', host: 'Proxy.Example', port: 1080, bypass: ['*.A.example', 'bad rule', 'localhost', 'localhost'] }, pac: null }, { mode: 'server', server: server('proxy.example', 1080, 'socks5', ['*.a.example', 'localhost']), pac: null }],
    ['no proxy, keeping an unreadable server out', { mode: 'none', server: { scheme: 'http', host: 'x y', port: 1 }, pac: 'http://wpad.example/p.pac' }, { mode: 'none', server: null, pac: 'http://wpad.example/p.pac' }],
    ['a server mode without its server', { mode: 'server', server: null, pac: null }, null],
    ['a file mode without its file', { mode: 'pac', server: null, pac: 'wpad.example' }, null],
    ['SOCKS4, never offered', { mode: 'server', server: { scheme: 'socks4', host: 'p.example', port: 1080, bypass: [] }, pac: null }, null],
    ['an unknown mode', { mode: 'auto_detect', server: null, pac: null }, null],
    ['nothing', null, null],
  ])('%s', (_name, value, clean) => {
    expect(cleanProxy(value)).toEqual(clean);
  });
});

/** Settings' proxy for every chord, and chords: Personal and Work share sign-ins, Lab and Quiet keep their own, Lab with B. */
function stateWith(all: ProxySettings): State {
  const state = emptyState();
  state.settings.proxy = all;
  const chord = (id: string, profileId: string, proxy?: ProxySettings): Chord => ({
    id,
    profileId,
    name: id,
    icon: '✦',
    theme: { stops: [{ l: 0.7, c: 0.1, h: 200 }], grain: 0.2, appearance: 'auto' },
    rank: id,
    createdAt: 0,
    ...(proxy ? { proxy } : {}),
  });
  state.chords = {
    personal: chord('personal', 'default'),
    work: chord('work', 'default'),
    lab: chord('lab', 'p-lab', B),
    quiet: chord('quiet', 'p-quiet'),
  };
  return state;
}

describe('which session gets which proxy', () => {
  const state = stateWith(A);
  it.each<[string, string | null, ProxySettings]>([
    ['shared sign-ins: the proxy for every chord', 'default', A],
    ['a chord with its own sign-ins and proxy: its own', 'p-lab', B],
    ['a chord with its own sign-ins and no proxy of its own: the proxy for every chord', 'p-quiet', A],
    ['a private window: the proxy for every chord', 'private-w9', A],
    ['Chord’s own requests (updates, lists, suggestions): the proxy for every chord', null, A],
    ['sign-ins no chord uses any more: the proxy for every chord', 'p-gone', A],
  ])('%s', (_name, profileId, proxy) => {
    expect(proxyFor(state, profileId)).toEqual(proxy);
  });
});

describe('the model', () => {
  let n = 0;
  const ctx: Context = { now: 1000, newId: () => `id-${++n}` };
  const run = (state: State, ...commands: Command[]) => commands.reduce((s, c) => apply(s, c, ctx).state, state);

  it('takes a proxy for every chord only whole and usable', () => {
    const state = stateWith({ mode: 'system', server: null, pac: null });
    expect(run(state, { t: 'settings.set', settings: { proxy: A } }).settings.proxy).toEqual(A);
    // Unusable: nothing changes.
    const broken = { mode: 'server', server: { scheme: 'http', host: 'x y', port: 1, bypass: [] }, pac: null } as ProxySettings;
    expect(apply(run(state, { t: 'settings.set', settings: { proxy: A } }), { t: 'settings.set', settings: { proxy: broken } }, ctx).patches).toEqual([]);
  });

  it.each<[string, Command[], Partial<Record<'profileId' | 'reloads', unknown>> & { proxy: ProxySettings | undefined }]>([
    ['a chord with its own sign-ins gets a proxy of its own, nothing reloads', [{ t: 'chord.proxy', chordId: 'quiet', proxy: B }], { profileId: 'p-quiet', proxy: B, reloads: false }],
    ['a chord sharing sign-ins gets one only with sign-ins of its own', [{ t: 'chord.proxy', chordId: 'work', proxy: B }], { profileId: 'default', proxy: undefined }],
    ['…which come with it', [{ t: 'chord.proxy', chordId: 'work', proxy: B, profileId: 'p-new' }], { profileId: 'p-new', proxy: B, reloads: true }],
    ['back to the proxy for every chord keeps its own sign-ins', [{ t: 'chord.proxy', chordId: 'lab', proxy: null }], { profileId: 'p-lab', proxy: undefined, reloads: false }],
    ['sharing sign-ins again shares the proxy for every chord too', [{ t: 'chord.profile', chordId: 'lab', profileId: 'default' }], { profileId: 'default', proxy: undefined, reloads: true }],
    ['Undo of that puts both back', [{ t: 'chord.profile', chordId: 'lab', profileId: 'default' }, { t: 'chord.proxy', chordId: 'lab', proxy: B, profileId: 'p-lab' }], { profileId: 'p-lab', proxy: B }],
    ['Undo of a proxy that came with sign-ins puts the shared ones back', [{ t: 'chord.proxy', chordId: 'work', proxy: B, profileId: 'p-new' }, { t: 'chord.proxy', chordId: 'work', proxy: null, profileId: 'default' }], { profileId: 'default', proxy: undefined }],
    ['an unusable proxy changes nothing', [{ t: 'chord.proxy', chordId: 'quiet', proxy: { mode: 'pac', server: null, pac: 'nope' } }], { profileId: 'p-quiet', proxy: undefined, reloads: false }],
  ])('%s', (_name, commands, expected) => {
    // Work's tab is open on screen, so a change of sign-ins shows as its page closing and coming back.
    const before = stateWith(A);
    before.windows['w1'] = { id: 'w1', activeChordId: 'work', activeTab: { work: 'tab-w', lab: 'tab-l', quiet: 'tab-q' }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
    for (const [id, chordId] of [['tab-w', 'work'], ['tab-l', 'lab'], ['tab-q', 'quiet']] as const) {
      before.nodes[id] = { kind: 'tab', id, chordId, section: 'today', parentId: null, rank: 'a0', url: 'https://a.test/', title: '', pinnedUrl: null, customTitle: null, favicon: null, lastActiveAt: 0, createdAt: 0 };
      before.live[id] = { ...IDLE_LIVE };
    }
    let state = before;
    const effects = [];
    for (const command of commands) {
      const result = apply(state, command, ctx);
      state = result.state;
      effects.push(...result.effects);
    }
    const chordId = commands[0]!.t === 'chord.proxy' || commands[0]!.t === 'chord.profile' ? commands[0]!.chordId : '';
    expect(state.chords[chordId]!.proxy).toEqual(expected.proxy);
    if (expected.profileId) expect(state.chords[chordId]!.profileId).toBe(expected.profileId);
    if (expected.reloads !== undefined) expect(effects.some((e) => e.e === 'view.destroy')).toBe(expected.reloads);
  });

  it('never gives a private window’s chord a proxy of its own', () => {
    const state = stateWith(A);
    state.chords['private'] = { ...state.chords['quiet']!, id: 'private', profileId: 'private-w2', private: true };
    expect(apply(state, { t: 'chord.proxy', chordId: 'private', proxy: B }, ctx).patches).toEqual([]);
  });

  it('restores a saved proxy for every chord, and a chord’s own only with its own sign-ins', () => {
    const saved = stateWith(A);
    const chords = Object.values(saved.chords).map((c) => (c.id === 'work' ? { ...c, proxy: B } : c));
    const restored = restoreState(
      { chords, nodes: [], windows: [], settings: { proxy: { ...A, server: { ...A.server!, host: '10.0.0.2' } } } },
      { now: 0, newId: () => 'x', theme: chords[0]!.theme, homeUrl: 'https://home.test/' },
    );
    expect(restored.settings.proxy).toEqual(A);
    expect(restored.chords['lab']!.proxy).toEqual(B);
    // Work shares sign-ins: its saved proxy can't apply, so it's dropped.
    expect(restored.chords['work']!.proxy).toBeUndefined();
    // Something unreadable saved: the system's, as Electron does by default.
    const odd = restoreState({ chords, nodes: [], windows: [], settings: { proxy: { mode: 'server' } } }, { now: 0, newId: () => 'x', theme: chords[0]!.theme, homeUrl: 'https://home.test/' });
    expect(odd.settings.proxy.mode).toBe('system');
  });
});

describe('a proxy that fails, in the frame', () => {
  it.each([
    [-130, 'ERR_PROXY_CONNECTION_FAILED', 'Can’t reach the proxy.', 'retry'],
    [-111, 'ERR_TUNNEL_CONNECTION_FAILED', 'The proxy couldn’t reach a.test.', 'retry'],
    [-120, 'ERR_SOCKS_CONNECTION_FAILED', 'The proxy couldn’t reach a.test.', 'retry'],
    [-336, 'ERR_NO_SUPPORTED_PROXIES', 'Chord can’t use this proxy.', 'retry'],
    [-131, 'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED', 'Can’t load the proxy’s configuration file.', 'retry'],
    [-136, 'ERR_PROXY_CERTIFICATE_INVALID', 'The proxy’s certificate isn’t valid.', 'back'],
    [-127, 'ERR_PROXY_AUTH_REQUESTED', 'The proxy needs you to sign in.', 'retry'],
  ] as const)('%i reads as %s', (code, name, title, action) => {
    expect(describeLoadError(code, 'a.test')).toMatchObject({ kind: 'proxy', name, title, action });
  });
});
