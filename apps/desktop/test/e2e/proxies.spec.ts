/**
 * Proxies end to end (ARCHITECTURE.md §9, *Proxies*; DESIGN.md §9), with no
 * network. Two local HTTP proxies answer absolute-URI requests the way a
 * forward proxy does, and record them; the "direct" server is what a page
 * reaches without one. Pages live at site.test, mapped to this machine
 * (--host-resolver-rules), because Chromium never sends loopback addresses
 * through a proxy. What each server saw is the proof of which way a request went.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';
import { lookedUpHosts } from './netlog';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

interface Recorder {
  server: Server;
  port: number;
  /** What reached it, as host + path (`site.test:1234/home`): a proxy's absolute URIs, the direct server's Host and path. */
  seen: string[];
  /** Connections open to it now: closing them is what a change of proxy does to pooled ones. */
  open(): number;
}

/** What every server answers: a page titled with who answered (`Via A /home`), an icon, suggestions, and the update feed. */
function respond(via: string, path: string, res: ServerResponse): void {
  if (path.startsWith('/suggest?q=')) {
    const q = decodeURIComponent(path.slice('/suggest?q='.length));
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify([q, [`${q} via ${via}`]]));
  }
  if (path === '/releases') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end('[]');
  }
  if (path === '/icon.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return void res.end(PNG);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><title>${via} ${path}</title><link rel="icon" href="/icon.png"><link rel="dns-prefetch" href="//prefetch.test"><p>${via}</p>`);
}

function listen(server: Server | ReturnType<typeof createTcpServer>, onSocket?: (socket: Socket) => void): Promise<{ port: number; open(): number }> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    onSocket?.(socket);
  });
  // Idle connections stay open until Chord closes them (Node would close them after 5 s itself).
  if ('keepAliveTimeout' in server) server.keepAliveTimeout = 0;
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ port: (server.address() as AddressInfo).port, open: () => sockets.size })));
}

/** The server a page reaches without a proxy. */
async function startDirect(): Promise<Recorder> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.headers.host}${req.url}`);
    respond('Direct', req.url ?? '/', res);
  });
  return { server, seen, ...(await listen(server)) };
}

/**
 * A forward proxy: requests come as absolute URIs (`GET http://site.test:1234/home`). With `auth`, it
 * answers 407 until it gets that Basic username and password, except for Chord's own suggestions
 * (Chord can't sign in for its own requests).
 */
async function startProxy(name: string, auth?: { user: string; password: string }): Promise<Recorder> {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const target = new URL(req.url ?? '');
    seen.push(`${target.host}${target.pathname}${target.search}`);
    const expected = auth && `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
    if (expected && req.headers['proxy-authorization'] !== expected && !target.pathname.startsWith('/suggest')) {
      res.writeHead(407, { 'proxy-authenticate': `Basic realm="Proxy ${name}"`, 'content-type': 'text/html' });
      return void res.end('<title>Proxy sign-in needed</title>');
    }
    respond(`Via ${name}`, `${target.pathname}${target.search}`, res);
  });
  return { server, seen, ...(await listen(server)) };
}

interface SocksRequest {
  version: 4 | 5;
  /** What the browser asked for: a name (SOCKS5 with a domain name) or an address it looked up itself. */
  host: string;
  port: number;
}

/** A SOCKS4 and SOCKS5 proxy (no sign-in), recording what each request named, and connecting it to the direct server. */
async function startSocks(directPort: number): Promise<{ server: ReturnType<typeof createTcpServer>; port: number; seen: SocksRequest[] }> {
  const seen: SocksRequest[] = [];
  const server = createTcpServer();
  const tunnel = (client: Socket, reply: Buffer) => {
    const upstream = connect(directPort, '127.0.0.1', () => {
      client.write(reply);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  };
  const port = (
    await listen(server, (client) => {
      client.once('data', (hello: Buffer) => {
        if (hello[0] === 4) {
          // VN CD DSTPORT DSTIP USERID NUL: an address, looked up by the browser.
          seen.push({ version: 4, host: [...hello.subarray(4, 8)].join('.'), port: hello.readUInt16BE(2) });
          return tunnel(client, Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
        }
        client.write(Buffer.from([5, 0]));
        client.once('data', (request: Buffer) => {
          const type = request[3];
          const length = type === 3 ? request[4]! : 0;
          const host = type === 3 ? request.subarray(5, 5 + length).toString() : type === 1 ? [...request.subarray(4, 8)].join('.') : 'ipv6';
          const at = type === 3 ? 5 + length : type === 1 ? 8 : 20;
          seen.push({ version: 5, host, port: request.readUInt16BE(at) });
          tunnel(client, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      });
    })
  ).port;
  return { server, port, seen };
}

let direct: Recorder;
let proxyA: Recorder;
let proxyB: Recorder;
test.beforeAll(async () => {
  direct = await startDirect();
  proxyA = await startProxy('A');
  proxyB = await startProxy('B', { user: 'me', password: 'secret' });
});
test.afterAll(() => {
  for (const r of [direct, proxyA, proxyB]) r.server.close();
});

const url = (path: string) => `http://site.test:${direct.port}${path}`;
const at = (path: string) => `site.test:${direct.port}${path}`;
/** Forget what the servers saw so far. */
const clearSeen = () => {
  for (const r of [direct, proxyA, proxyB]) r.seen.length = 0;
};

async function launch(profile: string, env: Record<string, string> = {}, args: string[] = []): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CHORD_USER_DATA: profile,
    CHORD_IMPORT_ROOT: join(profile, 'no-browsers'),
    // Chord's own requests, at the same site: the update check (a second after launch) and search suggestions.
    CHORD_UPDATE_FEED: url('/releases'),
    CHORD_SUGGEST_URL: url('/suggest?q='),
    ...env,
  };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(
    await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run', '--host-resolver-rules=MAP site.test 127.0.0.1, MAP socks4.test 127.0.0.1', ...args], env: childEnv, cwd: appDir }),
  );
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}
const isShell = (u: string) => u.startsWith('chord://shell') || u.includes('/shell/index.html');
const isOverlay = (u: string) => u.startsWith('chord://overlay') || u.includes('/overlay/index.html');
const isPopover = (u: string) => u.startsWith('chord://popover') || u.includes('/popover/index.html');
const isSettings = (u: string) => u.startsWith('chord://settings') || u.includes('/settings/index.html');
const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

async function newPage(app: ElectronApplication, match: (u: string) => boolean, known: readonly Page[]): Promise<Page> {
  const find = () => app.windows().find((p) => match(p.url()) && !known.includes(p));
  await expect.poll(() => Boolean(find()), { timeout: 20_000 }).toBe(true);
  return find()!;
}

/** Open the command bar (⌘T), unless it's open already (a new window opens with it). */
async function commandBar(shell: Page, overlay: Page): Promise<void> {
  if (!(await overlay.getByRole('dialog').isVisible())) {
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
  }
  await expect(overlay.getByRole('combobox')).toBeFocused();
}

/** Open an address from a window's command bar. */
async function visit(shell: Page, overlay: Page, address: string): Promise<void> {
  await commandBar(shell, overlay);
  await overlay.keyboard.type(address);
  await overlay.keyboard.press('Enter');
}

/** The title of the tab showing `path`, once it has one from a server. */
const titleOf = (app: ElectronApplication, path: string) => async () => {
  const page = app.windows().find((p) => p.url() === url(path));
  return page ? await page.title() : null;
};

/** ICE candidates a page gathers with no STUN or TURN server: its own addresses, over UDP, unless WebRTC is kept to the proxy. */
const udpCandidates = (page: Page) =>
  page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('probe');
    const found: string[] = [];
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) found.push(e.candidate.candidate);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 4000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          done();
        }
      };
    });
    pc.close();
    return found.filter((c) => / udp /i.test(c)).length;
  });

/**
 * With no proxy, a page does gather UDP candidates. Once in a while a CI runner gathers none within the
 * 4 s (issue #42, Linux x64 only, not a proxy's doing: it was before any was set), so gather again rather
 * than fail on the first try. A proxy's 0 is checked once, as it should be.
 */
const gathersUdp = (page: Page) => expect.poll(() => udpCandidates(page), { timeout: 20_000, intervals: [0], message: 'UDP candidates with no proxy' }).toBeGreaterThan(0);

/** Settings → Privacy, at the Proxy group. */
async function privacy(app: ElectronApplication, shell: Page): Promise<Page> {
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('button', { name: 'Privacy' }).click();
  return settings;
}

test('the proxy for every chord and a chord’s own, set in Settings: pages, private windows, Chord’s own requests, changes, and a relaunch', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch(profile, { CHORD_HOME_URL: url('/home') });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const popover = await pageWhere(app, isPopover);
    // No proxy set (the system's, which here is none): the page goes direct, and its connection stays pooled.
    await expect.poll(titleOf(app, '/home')).toBe('Direct /home');
    await expect.poll(() => direct.open()).toBeGreaterThan(0);
    const home = await pageWhere(app, (u) => u === url('/home'));
    await gathersUdp(home);

    // Settings → Privacy → Proxy: a proxy server for every chord, checked as it's typed.
    const settings = await privacy(app, shell);
    const forAll = settings.getByRole('radiogroup', { name: 'Proxy for every chord' });
    await forAll.getByRole('radio', { name: /^A proxy server/ }).click();
    const address = settings.getByLabel('Proxy for every chord: address', { exact: true });
    await address.fill('http://127.0.0.1');
    await expect(settings.getByRole('alert').filter({ hasText: 'Just the address, without http://' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Use this proxy' })).toBeDisabled();
    // A whole address typed in the box goes to the fields it belongs in.
    await address.fill(`127.0.0.1:${proxyA.port}`);
    await address.blur();
    await expect(address).toHaveValue('127.0.0.1');
    await expect(settings.getByLabel('Proxy for every chord: port', { exact: true })).toHaveValue(String(proxyA.port));
    await settings.getByRole('button', { name: 'Use this proxy' }).click();
    await expect(forAll.getByRole('radio', { name: /^A proxy server/ }).getByLabel('In use')).toBeVisible();

    // Connections opened direct are closed at once, and the next load goes through A.
    await expect.poll(() => direct.open()).toBe(0);
    clearSeen();
    await home.reload();
    await expect.poll(() => home.title()).toBe('Via A /home');
    expect(proxyA.seen).toContain(at('/home'));
    expect(direct.seen).toEqual([]);
    // WebRTC sends nothing past it: no UDP candidates with this computer's addresses.
    expect(await udpCandidates(home)).toBe(0);

    // Chord's own requests too: what's typed for suggestions goes through A.
    await commandBar(shell, overlay);
    await overlay.keyboard.type('chords');
    await expect(overlay.getByRole('option').filter({ hasText: 'chords via Via A' })).toBeVisible();
    await overlay.keyboard.press('Escape');
    expect(proxyA.seen).toContain(at('/suggest?q=chords'));

    // A private window uses the proxy for every chord.
    const privateBefore = app.windows();
    await runAction(shell, 'window.newPrivate');
    const privateShell = await newPage(app, isShell, privateBefore);
    const privateOverlay = await newPage(app, isOverlay, privateBefore);
    // A new window opens with the command bar, a moment after the window: opening it again meanwhile would empty what's typed.
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await visit(privateShell, privateOverlay, url('/private'));
    await expect.poll(titleOf(app, '/private')).toBe('Via A /private');
    expect(direct.seen).toEqual([]);
    await runAction(privateShell, 'window.close').catch(() => {});

    // A chord sharing sign-ins gets a proxy of its own only with its own sign-ins, and Settings says so first.
    await shell.getByRole('button', { name: 'New chord' }).click();
    await shell.getByRole('textbox', { name: 'Chord name' }).fill('Work');
    await shell.getByRole('textbox', { name: 'Chord name' }).press('Enter');
    await settings.getByRole('button', { name: /, proxy for Work$/ }).click();
    const forWork = settings.getByRole('radiogroup', { name: 'Proxy for Work' });
    await expect(forWork.getByRole('radio', { name: /^Same as all chords/ })).toHaveAttribute('aria-checked', 'true');
    await forWork.getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByLabel('Proxy for Work: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for Work: port', { exact: true }).fill('70000');
    await expect(settings.getByRole('alert').filter({ hasText: 'A port is a whole number from 1 to 65535.' })).toBeVisible();
    await settings.getByLabel('Proxy for Work: port', { exact: true }).fill(String(proxyB.port));
    await expect(settings.getByText('Work will be signed out of every site, and its tabs will reload.')).toBeVisible();
    await settings.getByRole('button', { name: 'Keep sign-ins separate and use this proxy' }).click();
    await expect(shell.getByRole('group').filter({ hasText: '“Work” keeps its own sign-ins and proxy now.' })).toBeVisible();
    await expect(shell.getByRole('img', { name: 'Uses its own proxy' })).toBeVisible();
    await expect(shell.getByRole('img', { name: 'Keeps its own sign-ins' })).toBeVisible();
    await expect(settings.getByText(`Its own: HTTP proxy at 127.0.0.1:${proxyB.port}`)).toBeVisible();

    // Work's pages go through B, which asks for a password: Chord's sign-in box, over the tab.
    await visit(shell, overlay, url('/work'));
    const box = popover.getByRole('alertdialog', { name: `The proxy 127.0.0.1:${proxyB.port} needs you to sign in` });
    await expect(box.locator('q')).toHaveText('Proxy B');
    await box.getByLabel('Username').fill('me');
    await box.getByLabel('Password').fill('secret');
    await box.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(titleOf(app, '/work')).toBe('Via B /work');
    await expect.poll(() => proxyB.seen).toContain(at('/icon.png'));
    expect(proxyA.seen).not.toContain(at('/work'));
    expect(direct.seen).toEqual([]);
    // What's typed in Work goes out through its own proxy too.
    await commandBar(shell, overlay);
    await overlay.keyboard.type('notes');
    await expect(overlay.getByRole('option').filter({ hasText: 'notes via Via B' })).toBeVisible();
    await overlay.keyboard.press('Escape');
    expect(proxyA.seen).not.toContain(at('/suggest?q=notes'));

    // No proxy for every chord: A's connections close, Personal goes direct, and Work keeps B (its connections too).
    await shell.getByRole('tablist', { name: 'Chords' }).getByRole('tab', { name: 'Personal' }).click();
    await forAll.getByRole('radio', { name: /^No proxy/ }).click();
    await settings.getByRole('button', { name: 'Connect directly' }).click();
    await expect.poll(() => proxyA.open()).toBe(0);
    expect(proxyB.open()).toBeGreaterThan(0);
    clearSeen();
    await home.reload();
    await expect.poll(() => home.title()).toBe('Direct /home');
    expect(proxyA.seen).toEqual([]);
    await gathersUdp(home);

    // A proxy server again: the one typed before is kept.
    await forAll.getByRole('radio', { name: /^A proxy server/ }).click();
    await expect(settings.getByLabel('Proxy for every chord: address', { exact: true })).toHaveValue('127.0.0.1');
    await settings.getByRole('button', { name: 'Use this proxy' }).click();
    await expect(forAll.getByRole('radio', { name: /^A proxy server/ }).getByLabel('In use')).toBeVisible();
  } finally {
    await app.close();
  }

  // Relaunched, everything is as it was, and nothing goes direct first: not the first page, nor the update check.
  clearSeen();
  app = await launch(profile);
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    await expect.poll(titleOf(app, '/home')).toBe('Via A /home');
    await expect.poll(() => proxyA.seen).toContain(at('/releases'));
    expect(direct.seen).toEqual([]);
    // Work's tab, when shown, asks B again: Chord kept no password.
    await shell.getByRole('tablist', { name: 'Chords' }).getByRole('tab', { name: 'Work' }).click();
    await expect(popover.getByRole('alertdialog', { name: `The proxy 127.0.0.1:${proxyB.port} needs you to sign in` })).toBeVisible();
    expect(proxyB.seen).toContain(at('/work'));
    expect([...proxyA.seen, ...direct.seen]).not.toContain(at('/work'));
  } finally {
    await app.close();
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

test('SOCKS5 sends sites’ names to the proxy, never to this computer’s DNS; SOCKS4, which Chord doesn’t offer, would look them up here', async () => {
  const socks = await startSocks(direct.port);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const log = join(profile, 'net.json');
  // socks.test isn't mapped to this machine: a lookup here would show in the net log (and fail).
  const page = (path: string) => `http://socks.test:${direct.port}${path}`;
  const app = await launch(profile, { CHORD_HOME_URL: 'about:blank' }, [`--log-net-log=${log}`]);
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const settings = await privacy(app, shell);
    const forAll = settings.getByRole('radiogroup', { name: 'Proxy for every chord' });
    await forAll.getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByRole('radiogroup', { name: 'Proxy for every chord: type' }).getByRole('radio', { name: 'SOCKS5' }).click();
    await expect(settings.getByText('The proxy looks up sites’ names too')).toBeVisible();
    await settings.getByLabel('Proxy for every chord: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for every chord: port', { exact: true }).fill(String(socks.port));
    await settings.getByRole('button', { name: 'Use this proxy' }).click();
    await expect(forAll.getByRole('radio', { name: /^A proxy server/ }).getByLabel('In use')).toBeVisible();

    await visit(shell, overlay, page('/socks'));
    await expect.poll(async () => (await app.windows().find((p) => p.url() === page('/socks'))?.title()) ?? null).toBe('Direct /socks');
    await expect.poll(() => socks.seen).toContainEqual({ version: 5, host: 'socks.test', port: direct.port });
    // The command bar's connection ahead of Enter goes through the proxy too, by name.
    await commandBar(shell, overlay);
    await overlay.keyboard.type(`http://preconnect.test:${direct.port}/`);
    await expect.poll(() => socks.seen.some((s) => s.host === 'preconnect.test')).toBe(true);
    await overlay.keyboard.press('Escape');

    // For comparison, SOCKS4 on a session of its own (Settings never offers it): the name is looked up here first,
    // and the proxy gets only the address (socks4.test is mapped to this machine). Chord gives every new session the
    // proxy for every chord as it's made (proxy.ts, SOCKS5 here), so the probe's fetch waits until the network service
    // answers with the probe's own proxy: on CI's slower runners it went out on another (issue #64, twice on Windows
    // arm64 and x64), with no SOCKS4 hello at the proxy.
    const probed = await app.evaluate(
      async ({ session }, { rules, address, want }) => {
        const probe = session.fromPartition('socks4-probe', { cache: false });
        await probe.setProxy({ proxyRules: rules });
        let proxy = await probe.resolveProxy(address);
        for (const until = Date.now() + 10_000; proxy !== want && Date.now() < until; ) {
          await new Promise((done) => setTimeout(done, 50));
          proxy = await probe.resolveProxy(address);
        }
        const body = await probe.fetch(address).then((r) => r.text());
        return { proxy, body };
      },
      { rules: `socks4://127.0.0.1:${socks.port}`, address: `http://socks4.test:${direct.port}/socks4`, want: `SOCKS 127.0.0.1:${socks.port}` },
    );
    const what = `the probe's proxy ${probed.proxy}, its answer ${JSON.stringify(probed.body)}, the proxy saw ${JSON.stringify(socks.seen)}`;
    expect(probed.proxy, what).toBe(`SOCKS 127.0.0.1:${socks.port}`);
    await expect.poll(() => socks.seen.filter((s) => s.version === 4), { message: what }).toEqual([{ version: 4, host: '127.0.0.1', port: direct.port }]);
  } finally {
    await app.close();
    socks.server.close();
  }
  // Neither the page nor the connection ahead of it asked this computer's DNS for its name.
  const asked = lookedUpHosts(log);
  expect(asked.has('socks.test')).toBe(false);
  expect(asked.has('preconnect.test')).toBe(false);
  // Known, and not Chord's to route (ARCHITECTURE.md §9, Proxies): Electron looks up a page's <link rel="dns-prefetch">
  // hints itself, even behind a proxy, where Chrome skips them. Noted on the run rather than checked: whether the hint
  // went out before Chord quit is timing, and this test is about what Chord does.
  test.info().annotations.push({ type: 'dns-prefetch', description: asked.has('prefetch.test') ? 'prefetch.test was looked up here' : 'prefetch.test was not looked up' });
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

test('a proxy that can’t be reached explains itself in the frame, with its settings a click away; the command bar opens a chord’s', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  // A port nothing listens on.
  const closed = createTcpServer();
  const { port } = await listen(closed);
  await new Promise<void>((done) => closed.close(() => done()));
  const app = await launch(profile, { CHORD_HOME_URL: url('/home') });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect.poll(titleOf(app, '/home')).toBe('Direct /home');
    const settings = await privacy(app, shell);
    await settings.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByLabel('Proxy for every chord: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for every chord: port', { exact: true }).fill(String(port));
    await settings.getByRole('button', { name: 'Use this proxy' }).click();

    clearSeen();
    await runAction(shell, 'nav.reload');
    const frame = shell.getByRole('alert').filter({ hasText: 'Can’t reach the proxy.' });
    await expect(frame).toBeVisible();
    await expect(frame).toContainText('ERR_PROXY_CONNECTION_FAILED');
    // It never fell back to loading the page without the proxy.
    expect(direct.seen).toEqual([]);
    await frame.getByRole('button', { name: 'Proxy settings' }).click();
    const again = settings;
    await expect(again.getByRole('radiogroup', { name: 'Proxy for Personal' })).toBeVisible();
    await expect(again.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ })).toHaveAttribute('aria-checked', 'true');

    // From the command bar: Proxy for this chord…
    await shell.getByRole('button', { name: 'New chord' }).click();
    await shell.getByRole('textbox', { name: 'Chord name' }).fill('Lab');
    await shell.getByRole('textbox', { name: 'Chord name' }).press('Enter');
    await commandBar(shell, overlay);
    await overlay.keyboard.type('proxy for this');
    await overlay.getByRole('option').filter({ hasText: 'Proxy for this chord…' }).click();
    await expect(again.getByRole('radiogroup', { name: 'Proxy for Lab' })).toBeVisible();
    await expect(again.getByRole('radiogroup', { name: 'Proxy for Lab' }).getByRole('radio', { name: /^Same as all chords/ })).toBeFocused();
  } finally {
    await app.close();
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

test('a proxy that can’t be set (#325): its pages wait, never direct; one toast, a row in Settings with Try again; then it takes', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_HOME_URL: url('/home') });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(titleOf(app, '/home')).toBe('Direct /home');
    await pageWhere(app, (u) => u === url('/home'));
    // Chromium refusing this proxy, as it refuses a config it can't use: setProxy rejects while the flag is up.
    await app.evaluate(({ session }, port) => {
      const proto = Object.getPrototypeOf(session.defaultSession) as { setProxy(config: { proxyRules?: string }): Promise<void> };
      const real = proto.setProxy;
      (globalThis as { refuseProxy?: boolean }).refuseProxy = true;
      proto.setProxy = function (this: unknown, config: { proxyRules?: string }) {
        if ((globalThis as { refuseProxy?: boolean }).refuseProxy && String(config?.proxyRules ?? '').includes(`:${port}`)) return Promise.reject(new Error('net::ERR_INVALID_ARGUMENT'));
        return real.call(this, config);
      };
    }, proxyA.port);
    const settings = await privacy(app, shell);
    await settings.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByLabel('Proxy for every chord: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for every chord: port', { exact: true }).fill(String(proxyA.port));
    await settings.getByRole('button', { name: 'Use this proxy' }).click();

    // Settings says so, under the proxy for every chord, with why and Try again.
    // The row (its words are also said once in the page's status region, for screen readers).
    const row = settings.locator('[data-tone="warning"]').getByText('Can’t use this proxy.');
    await expect(settings.getByRole('status').filter({ hasText: 'Can’t use this proxy.' })).toHaveCount(1);
    await expect(row).toBeVisible({ timeout: 10_000 });
    // One toast in the window, with Settings: checked first, as a toast goes by itself after a few seconds.
    const toast = shell.getByRole('region', { name: 'Notifications' }).getByRole('group').filter({ hasText: 'The proxy isn’t working. Pages are waiting.' });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Settings' })).toBeVisible();
    await shell.screenshot({ path: test.info().outputPath('proxy-failing-toast.png') });
    // Its Settings: the proxy for every chord's choice in use, focused (Carbon's SF2 on #331), wherever the focus was.
    await settings.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await toast.getByRole('button', { name: 'Settings' }).click();
    await expect(settings.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ })).toBeFocused();
    // In words for people (Carbon's SF5): an address Chromium won't take is one to check.
    await expect(settings.getByText('Pages wait until Chord can. Check the proxy’s address or its configuration file (ERR_INVALID_ARGUMENT).', { exact: true })).toBeVisible();
    // The chord's header says so too, quietly, while it lasts (the owner's yes on #331): its proxy icon, a button.
    await expect(shell.getByRole('button', { name: 'Personal’s proxy isn’t working, Proxy settings', exact: true })).toBeVisible();
    // A window opened while it fails gets its toast too (Carbon's SF3): a private one, whose pages it holds.
    await runAction(shell, 'window.newPrivate');
    await expect.poll(() => app.windows().filter((p) => isShell(p.url())).length).toBe(2);
    const privateShell = app.windows().find((p) => isShell(p.url()) && p !== shell)!;
    await expect(privateShell.getByRole('region', { name: 'Notifications' }).getByRole('group').filter({ hasText: 'The proxy isn’t working. Pages are waiting.' })).toBeVisible();
    await settings.screenshot({ path: test.info().outputPath('proxy-failing-light.png') });
    await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'dark'));
    await settings.waitForTimeout(400);
    await settings.screenshot({ path: test.info().outputPath('proxy-failing-dark.png') });
    await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'system'));


    // A load meanwhile waits: nothing reaches the site direct (or through the proxy).
    clearSeen();
    await runAction(shell, 'nav.reload');
    await shell.waitForTimeout(2500);
    expect(direct.seen, `direct: ${direct.seen.join(', ')}`).toEqual([]);
    expect(proxyA.seen).toEqual([]);
    // Held (#331): its page closed, its tab keeps its title; it loads through the proxy below.
    await expect(shell.getByRole('tree', { name: 'Unpinned tabs' })).toContainText('Direct /home');

    // Try again while it still can't (Carbon's B2): Trying…, then said again, as still failing.
    const again = settings.getByRole('button', { name: 'Try again, proxy for every chord', exact: true });
    await again.click();
    await expect(settings.locator('[data-proxy-said]')).toHaveText('Still can’t use this proxy.', { timeout: 10_000 });

    // Chromium takes it now; Try again from the keyboard: the row goes, and the page loads through the proxy. The focus
    // goes to the choice in use, never to the page (Carbon's B1); the status says it works again.
    await app.evaluate(() => void ((globalThis as { refuseProxy?: boolean }).refuseProxy = false));
    await again.focus();
    await settings.keyboard.press('Enter');
    await expect(row).toBeHidden({ timeout: 10_000 });
    await expect(settings.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ })).toBeFocused();
    await expect(settings.locator('[data-proxy-said]')).toHaveText('The proxy works again.');
    await expect(shell.getByRole('button', { name: /proxy isn’t working/ })).toHaveCount(0);
    // The held page loads now, through the proxy, and never went direct.
    await expect.poll(titleOf(app, '/home'), { timeout: 15_000 }).toBe('Via A /home');
    expect(proxyA.seen).toContain(at('/home'));
    expect(direct.seen).toEqual([]);
  } finally {
    await app.close();
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

test('a chord’s own proxy that can’t be set (Carbon’s round on #331): said at once, even with no tab of it open; its toast opens its proxy; Try again keeps the focus', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_HOME_URL: url('/home') });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(titleOf(app, '/home')).toBe('Direct /home');
    await app.evaluate(({ session }, port) => {
      const proto = Object.getPrototypeOf(session.defaultSession) as { setProxy(config: { proxyRules?: string }): Promise<void> };
      const real = proto.setProxy;
      (globalThis as { refuseProxy?: boolean }).refuseProxy = true;
      proto.setProxy = function (this: unknown, config: { proxyRules?: string }) {
        if ((globalThis as { refuseProxy?: boolean }).refuseProxy && String(config?.proxyRules ?? '').includes(`:${port}`)) return Promise.reject(new Error('net::ERR_FAILED'));
        return real.call(this, config);
      };
    }, proxyA.port);
    // A new chord, with no tab open: its sign-ins are the shared ones until it gets a proxy of its own.
    await shell.getByRole('button', { name: 'New chord' }).click();
    await shell.getByRole('textbox', { name: 'Chord name' }).fill('Lab');
    await shell.getByRole('textbox', { name: 'Chord name' }).press('Enter');
    const settings = await privacy(app, shell);
    await settings.getByRole('button', { name: 'Its own…, proxy for Lab' }).click();
    await settings.getByRole('radiogroup', { name: 'Proxy for Lab' }).getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByLabel('Proxy for Lab: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for Lab: port', { exact: true }).fill(String(proxyA.port));
    await settings.getByRole('button', { name: /^Keep sign-ins separate and use this proxy/ }).click();

    // Its session made at once, so its proxy is tried now: the row under it, never "In use" as if it worked (SF1).
    const row = settings.locator('[data-tone="warning"]').getByText('Can’t use Lab’s proxy.');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(settings.getByText('Its pages wait until Chord can, and Chord keeps trying (ERR_FAILED).', { exact: true })).toBeVisible();
    await expect(settings.locator('[data-proxy-said]')).toHaveText('Can’t use Lab’s proxy.');
    // Its toast, in the window showing Lab: Settings opens at Lab's proxy, its choice in use focused (SF2).
    const toast = shell.getByRole('region', { name: 'Notifications' }).getByRole('group').filter({ hasText: 'Lab’s proxy isn’t working. Its pages are waiting.' });
    await expect(toast).toBeVisible();
    await settings.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await toast.getByRole('button', { name: 'Settings' }).click();
    await expect(settings.getByRole('radiogroup', { name: 'Proxy for Lab' }).getByRole('radio', { name: /^A proxy server/ })).toBeFocused();
    await settings.screenshot({ path: test.info().outputPath('proxy-failing-chord.png') });

    // Lab's header: its proxy icon in warning, a button to its proxy (the owner's yes on #331), in light, dark and
    // forced colours.
    const sign = shell.getByRole('button', { name: 'Lab’s proxy isn’t working, Proxy settings', exact: true });
    await expect(sign).toBeVisible();
    const header = sign.locator('..');
    await header.screenshot({ path: test.info().outputPath('proxy-sign-light.png') });
    await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'dark'));
    await shell.waitForTimeout(400);
    await header.screenshot({ path: test.info().outputPath('proxy-sign-dark.png') });
    await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'system'));
    await shell.emulateMedia({ forcedColors: 'active' });
    await shell.waitForTimeout(200);
    await header.screenshot({ path: test.info().outputPath('proxy-sign-forced.png') });
    await shell.emulateMedia({ forcedColors: 'none' });
    // It opens Lab's proxy, as the toast does.
    await settings.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await sign.click();
    await expect(settings.getByRole('radiogroup', { name: 'Proxy for Lab' }).getByRole('radio', { name: /^A proxy server/ })).toBeFocused();

    // Chromium takes it now; Try again from the keyboard: the row goes, the focus to Lab's own button, never the page
    // (B1), and the status says Lab's proxy works again (B2).
    await app.evaluate(() => void ((globalThis as { refuseProxy?: boolean }).refuseProxy = false));
    await settings.getByRole('button', { name: 'Try again, proxy for Lab', exact: true }).focus();
    await settings.keyboard.press('Enter');
    await expect(row).toBeHidden({ timeout: 10_000 });
    await expect(settings.getByRole('button', { name: /^(Done|Change…), proxy for Lab$/ })).toBeFocused();
    await expect(settings.locator('[data-proxy-said]')).toHaveText('Lab’s proxy works again.');
    // Its header's icon is only the quiet one again.
    await expect(sign).toBeHidden();
    await expect(shell.getByRole('img', { name: 'Uses its own proxy' })).toBeVisible();
  } finally {
    await app.close();
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

test('a page open when its proxy fails (#331, the owner’s pick): held, its own fetches and navigation reach neither the site nor the proxy; back once it takes', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  // An extension in the session, as a chord's always has (Chord's ad blocking): with one, a page open before the
  // session's block sends around it (measured on #331), which is why the page is held.
  const app = await launch(profile, { CHORD_HOME_URL: url('/home'), CHORD_LOAD_EXTENSION: resolve(appDir, 'test/fixtures/extension') });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(titleOf(app, '/home')).toBe('Direct /home');
    const home = await pageWhere(app, (u) => u === url('/home'));
    await app.evaluate(({ session }, port) => {
      const proto = Object.getPrototypeOf(session.defaultSession) as { setProxy(config: { proxyRules?: string }): Promise<void> };
      const real = proto.setProxy;
      (globalThis as { refuseProxy?: boolean }).refuseProxy = true;
      proto.setProxy = function (this: unknown, config: { proxyRules?: string }) {
        if ((globalThis as { refuseProxy?: boolean }).refuseProxy && String(config?.proxyRules ?? '').includes(`:${port}`)) return Promise.reject(new Error('net::ERR_INVALID_ARGUMENT'));
        return real.call(this, config);
      };
    }, proxyA.port);
    const settings = await privacy(app, shell);
    await settings.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByLabel('Proxy for every chord: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for every chord: port', { exact: true }).fill(String(proxyA.port));
    await settings.getByRole('button', { name: 'Use this proxy' }).click();
    await expect(settings.locator('[data-tone="warning"]').getByText('Can’t use this proxy.')).toBeVisible({ timeout: 10_000 });

    // The page as it was open before the failure, if it still is: sending on its own, a fetch every 200 ms and a
    // navigation a second from now. Held, it isn't (its page was closed), so nothing can.
    clearSeen();
    await home
      .evaluate(() => {
        let n = 0;
        setInterval(() => void fetch(`/tick-${n++}`, { cache: 'no-store' }).catch(() => {}), 200);
        setTimeout(() => void (location.href = '/later'), 1000);
      })
      .catch(() => {});
    // Main's own requests in that session (a favicon's, a PDF's) are cut off too: session.fetch rejects (Opus's SF-B).
    const fetched = await app.evaluate(({ session }, u) => session.fromPartition('persist:default').fetch(u).then(() => 'reached', (e: Error) => `rejected: ${e.message}`), url('/main-fetch'));
    expect(fetched).toMatch(/^rejected/);
    // Nothing of the page's reaches the site or the proxy, not its fetches, not its navigation; its tab keeps its title.
    await shell.waitForTimeout(3000);
    const sent = [...direct.seen, ...proxyA.seen].filter((s) => /\/(tick-|later|main-fetch)/.test(s));
    expect(sent, `sent while held: ${sent.join(', ')}`).toEqual([]);
    await expect(shell.getByRole('tree', { name: 'Unpinned tabs' })).toContainText('Direct /home');

    // Chromium takes it now; Try again: the tab's page comes back, through the proxy, never direct.
    await app.evaluate(() => void ((globalThis as { refuseProxy?: boolean }).refuseProxy = false));
    clearSeen();
    await settings.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(titleOf(app, '/home'), { timeout: 15_000 }).toBe('Via A /home');
    expect(direct.seen.filter((s) => s.endsWith('/home'))).toEqual([]);
  } finally {
    await app.close();
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

test('an extension’s worker already running when its proxy fails (#331, Opus’s SF-A): it sends nothing from then, and a new one runs once the proxy takes', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  // An installed extension whose service worker fetches on a loop, as some do. Each start of it has its own boot id in
  // what it sends, and reading its storage on every tick keeps it alive (Opus's round 3: so a worker left running is
  // caught every time, not only when Chromium hasn't stopped it for being idle).
  const ext = join(profile, 'looper');
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Looper', version: '1.0', permissions: ['storage'], background: { service_worker: 'bg.js' }, host_permissions: ['http://site.test/*'] }));
  writeFileSync(
    join(ext, 'bg.js'),
    `const boot = Math.random().toString(36).slice(2, 10); let n = 0; setInterval(async () => { await chrome.storage.local.get('x'); fetch('${url('/sw-tick')}-' + boot + '-' + (n++)).catch(() => {}); }, 250);`,
  );
  const app = await launch(profile, { CHORD_HOME_URL: url('/home'), CHORD_LOAD_EXTENSION: ext });
  const ticksIn = (seen: string[]) => seen.filter((s) => s.includes('/sw-tick-'));
  const bootOf = (s: string) => /\/sw-tick-([a-z0-9]+)-/.exec(s)?.[1];
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(() => ticksIn(direct.seen).length, { timeout: 15_000 }).toBeGreaterThan(2);
    const before = new Set(ticksIn(direct.seen).map(bootOf));
    await app.evaluate(({ session }, port) => {
      const proto = Object.getPrototypeOf(session.defaultSession) as { setProxy(config: { proxyRules?: string }): Promise<void> };
      const real = proto.setProxy;
      (globalThis as { refuseProxy?: boolean }).refuseProxy = true;
      proto.setProxy = function (this: unknown, config: { proxyRules?: string }) {
        if ((globalThis as { refuseProxy?: boolean }).refuseProxy && String(config?.proxyRules ?? '').includes(`:${port}`)) return Promise.reject(new Error('net::ERR_INVALID_ARGUMENT'));
        return real.call(this, config);
      };
    }, proxyA.port);
    const settings = await privacy(app, shell);
    await settings.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByLabel('Proxy for every chord: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for every chord: port', { exact: true }).fill(String(proxyA.port));
    await settings.getByRole('button', { name: 'Use this proxy' }).click();
    await expect(settings.locator('[data-tone="warning"]').getByText('Can’t use this proxy.')).toBeVisible({ timeout: 10_000 });
    // From a moment after it failed, for 10 s (through retries): nothing of the worker's reaches the site or the proxy.
    await shell.waitForTimeout(1000);
    clearSeen();
    await shell.waitForTimeout(10_000);
    expect(ticksIn([...direct.seen, ...proxyA.seen])).toEqual([]);
    // It takes: a worker runs again through the proxy, and it's a new one (its extension was loaded again), never the old.
    await app.evaluate(() => void ((globalThis as { refuseProxy?: boolean }).refuseProxy = false));
    await settings.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => ticksIn(proxyA.seen).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const after = new Set(ticksIn(proxyA.seen).map(bootOf));
    for (const boot of after) expect(before.has(boot), `boot ${boot} ran before the failure too`).toBe(false);
    expect(ticksIn(direct.seen)).toEqual([]);
  } finally {
    await app.close();
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
});

