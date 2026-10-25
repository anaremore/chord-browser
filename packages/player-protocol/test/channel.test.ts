import { createHmac } from 'node:crypto';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, LAUNCH_ENV, listen, newAddress, newSecret, parseLaunch, playerEnv, readLaunch, type Hello, type Peer } from '../src/channel.ts';
import { parseArtwork, parseLink, parseMedia, parseTheme, parseUrl } from '../src/messages.ts';

const HELLO: Hello = { protocol: 1, app: '0.1.0', ecs: '44.9.3+wvcus', pid: 1 };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function host(secret: string, versions: readonly [number, number] = [1, 1]) {
  const address = newAddress();
  const peers: { peer: Peer; hello: Hello }[] = [];
  const refused: Hello[] = [];
  const server = await listen(address, secret, versions, (peer, hello) => peers.push({ peer, hello }), (hello) => refused.push(hello));
  cleanups.push(() => {
    server.close();
    address.cleanup();
  });
  return { address, peers, refused, server };
}

/** A raw client that says whatever a test wants, to see what the host does with it. */
function raw(path: string): Promise<{ socket: net.Socket; lines: Record<string, unknown>[]; closed: Promise<void> }> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
      }
    });
    socket.on('error', () => {});
    const closed = new Promise<void>((done) => socket.on('close', () => done()));
    socket.on('connect', () => resolve({ socket, lines, closed }));
  });
}

const until = async (test: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('the control channel', () => {
  it('opens when both ends hold the secret, and carries requests, answers and messages', async () => {
    const secret = newSecret();
    const h = await host(secret);
    const player = await connect(h.address, secret, HELLO);
    cleanups.push(() => player.destroy());
    await until(() => h.peers.length === 1);
    const chord = h.peers[0]!;
    expect(chord.hello).toMatchObject({ protocol: 1, app: '0.1.0', ecs: '44.9.3+wvcus' });
    expect(player.protocol).toBe(1);

    player.handle('play', () => ({ ok: true }));
    await expect(chord.peer.request('play')).resolves.toEqual({ ok: true });
    // A request nobody handles comes back as unknown, which is how a newer Chord tells an older player.
    await expect(chord.peer.request('newer-feature')).rejects.toThrow(/unknown/);
    player.handle('fails', () => {
      throw new Error('no video');
    });
    await expect(chord.peer.request('fails')).rejects.toThrow('no video');

    const heard: unknown[] = [];
    chord.peer.handle('media', (m) => heard.push(m['title']));
    player.send('media', { title: 'Angel One' });
    await until(() => heard.length === 1);
    expect(heard).toEqual(['Angel One']);
  });

  it('drops a player with the wrong secret, and the player can tell', async () => {
    const h = await host(newSecret());
    await expect(connect(h.address, newSecret(), HELLO)).rejects.toThrow();
    expect(h.peers).toHaveLength(0);
  });

  it('drops a client that never says anything within 3 s', async () => {
    const h = await host(newSecret());
    const client = await raw(h.address.path);
    const started = Date.now();
    await client.closed;
    expect(Date.now() - started).toBeGreaterThan(2500);
    expect(client.lines[0]).toMatchObject({ t: 'challenge', v: [1, 1] });
  }, 6000);

  it('drops malformed lines, a line over the cap, and messages before the handshake', async () => {
    const h = await host(newSecret());
    for (const bad of ['not json\n', '[1,2]\n', '{"t":"media","title":"x"}\n', `{"t":"${'x'.repeat(600_000)}`]) {
      const client = await raw(h.address.path);
      client.socket.write(bad);
      await client.closed;
    }
    expect(h.peers).toHaveLength(0);
  });

  it('takes one player at a time', async () => {
    const secret = newSecret();
    const h = await host(secret);
    const first = await connect(h.address, secret, HELLO);
    cleanups.push(() => first.destroy());
    await expect(connect(h.address, secret, HELLO)).rejects.toThrow();
    first.destroy();
    await until(() => !first.open);
    await new Promise((r) => setTimeout(r, 50));
    const second = await connect(h.address, secret, HELLO);
    cleanups.push(() => second.destroy());
    await until(() => h.peers.length === 2);
  });

  it('a request in the same chunk as the welcome waits for the handlers the player installs once connected', async () => {
    const secret = newSecret();
    const address = newAddress();
    const answers: Record<string, unknown>[] = [];
    const server = net.createServer((socket) => {
      const n = 'b'.repeat(32);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const m = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          if (m.t === 'hello') {
            const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(['host', m.n, n, '1'].join('\0')).digest('hex');
            // The welcome and a request in one write, as a busy player may read them.
            socket.write(`${JSON.stringify({ t: 'welcome', v: 1, mac })}\n${JSON.stringify({ t: 'ping', id: 1 })}\n`);
          } else answers.push(m);
        }
      });
      socket.write(`${JSON.stringify({ t: 'challenge', n, v: [1, 1] })}\n`);
    });
    await new Promise<void>((done) => server.listen(address.path, done));
    cleanups.push(() => {
      server.close();
      address.cleanup();
    });
    const player = await connect(address, secret, HELLO);
    cleanups.push(() => player.destroy());
    player.handle('ping', () => 'pong');
    await until(() => answers.length === 1);
    expect(answers[0]).toEqual({ re: 1, ok: true, value: 'pong' });
  });

  it('a newer Chord takes an older player, and both know which version they speak', async () => {
    const secret = newSecret();
    const h = await host(secret, [1, 2]);
    const player = await connect(h.address, secret, HELLO);
    cleanups.push(() => player.destroy());
    await until(() => h.peers.length === 1);
    expect(h.peers[0]!.peer.protocol).toBe(1);
    expect(h.peers[0]!.hello.protocol).toBe(1);
    expect(player.protocol).toBe(1);
  });

  it('refuses a player speaking a protocol Chord doesn’t, after it proved the secret', async () => {
    const secret = newSecret();
    const h = await host(secret, [2, 3]);
    await expect(connect(h.address, secret, HELLO)).rejects.toThrow(/protocol/);
    await until(() => h.refused.length === 1);
    expect(h.refused[0]).toMatchObject({ protocol: 1, app: '0.1.0' });
    expect(h.peers).toHaveLength(0);
  });

  it('binds the version to the HMAC, so it can’t be changed on the way', async () => {
    const secret = newSecret();
    const h = await host(secret, [1, 2]);
    const client = await raw(h.address.path);
    await until(() => client.lines.length === 1);
    const n = client.lines[0]!['n'] as string;
    const mine = 'a'.repeat(32);
    // MAC computed for protocol 1, but the message claims 2.
    const mac = createHmac('sha256', Buffer.from(secret, 'hex')).update(['player', n, mine, '1', '0.1.0'].join('\0')).digest('hex');
    client.socket.write(`${JSON.stringify({ t: 'hello', n: mine, protocol: 2, app: '0.1.0', mac })}\n`);
    await client.closed;
    expect(h.peers).toHaveLength(0);
  });
});

describe('launching', () => {
  it('reads the launch line from the environment, and removes it', async () => {
    const env: NodeJS.ProcessEnv = { [LAUNCH_ENV]: JSON.stringify({ path: '\\\\.\\pipe\\x', secret: 'ab'.repeat(32), profile: 'C:\\p', appUserModelId: 'com.chordbrowser.Chord' }) };
    const launch = await readLaunch(env, new PassThrough());
    expect(launch).toMatchObject({ path: '\\\\.\\pipe\\x', profile: 'C:\\p', appUserModelId: 'com.chordbrowser.Chord' });
    expect(env[LAUNCH_ENV]).toBeUndefined();
  });

  it('reads it from stdin otherwise, and gives up on nothing or garbage', async () => {
    const stdin = new PassThrough();
    const pending = readLaunch({}, stdin);
    stdin.write(`${JSON.stringify({ path: '/run/s', secret: 'cd'.repeat(32), profile: '/p' })}\n`);
    await expect(pending).resolves.toMatchObject({ path: '/run/s' });
    await expect(readLaunch({}, new PassThrough(), 50)).resolves.toBeNull();
    const junk = new PassThrough();
    const nothing = readLaunch({}, junk);
    junk.write('{"path": 1}\n');
    await expect(nothing).resolves.toBeNull();
  });

  it('checks every field, and keeps only test switches it understands', () => {
    expect(parseLaunch(JSON.stringify({ path: 'x', secret: 'short', profile: 'p' }))).toBeNull();
    expect(parseLaunch(JSON.stringify({ path: 'x', secret: 'ef'.repeat(32) }))).toBeNull();
    const launch = parseLaunch(JSON.stringify({ path: 'x', secret: 'ef'.repeat(32), profile: 'p', appUserModelId: 'bad id;', test: { hostResolverRules: 'MAP www.netflix.com 127.0.0.1', secureOrigins: ['http://www.netflix.com:4000', 'javascript:x'] } }));
    expect(launch?.appUserModelId).toBeUndefined();
    expect(launch?.test).toEqual({ hostResolverRules: 'MAP www.netflix.com 127.0.0.1', secureOrigins: ['http://www.netflix.com:4000'] });
  });

  it('starts the player without what Electron added to Chord’s own environment', () => {
    const env = playerEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', CHROME_DESKTOP: 'x', NODE_OPTIONS: '--inspect', CHORD_HOME_URL: 'x', DBUS_SESSION_BUS_ADDRESS: 'disabled:', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('message checks', () => {
  it('accepts only http(s) links', () => {
    expect(parseLink({ url: 'https://example.com/x', why: 'navigation' })).toEqual({ url: 'https://example.com/x', why: 'navigation' });
    expect(parseLink({ url: 'javascript:alert(1)', why: 'navigation' })).toBeNull();
    expect(parseLink({ url: 'file:///etc/passwd', why: 'popup' })).toBeNull();
    expect(parseLink({ url: 'https://example.com/', why: 'whatever' })).toBeNull();
    expect(parseUrl(`https://example.com/${'a'.repeat(9000)}`)).toBeNull();
  });

  it('trims what plays to sizes the card can show', () => {
    const media = parseMedia({ title: 'x'.repeat(1000), artist: 'A', playing: true, muted: false, pausable: true, extra: 1 });
    expect(media?.title).toHaveLength(300);
    expect(media).not.toHaveProperty('extra');
    expect(parseMedia({ title: 'x' })).toBeNull();
  });

  it('takes artwork only as a small raster data URL', () => {
    expect(parseArtwork('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(parseArtwork('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(parseArtwork('https://example.com/a.png')).toBeNull();
    expect(parseArtwork(`data:image/png;base64,${'A'.repeat(400_000)}`)).toBeNull();
  });

  it('keeps only theme values that can’t load anything', () => {
    const theme = parseTheme({
      appearance: 'dark',
      vars: {
        '--color-fg': 'oklch(0.95 0.01 280)',
        '--color-tint': 'linear-gradient(in oklab 160deg, oklch(0.4 0.1 280 / 0.6), oklch(0.3 0.1 200 / 0.6))',
        '--color-accent': 'url(https://evil.example/x)',
        '--color-base': 'red; background: url(x)',
        '--not-a-theme-var': 'red',
      },
    });
    expect(theme?.vars).toEqual({ '--color-fg': 'oklch(0.95 0.01 280)', '--color-tint': 'linear-gradient(in oklab 160deg, oklch(0.4 0.1 280 / 0.6), oklch(0.3 0.1 200 / 0.6))' });
    expect(parseTheme({ appearance: 'blue', vars: {} })).toBeNull();
  });
});
