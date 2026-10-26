/**
 * Every session gets the proxy it should before its first request
 * (main/proxy.ts): as it's made, and again after a change, with old
 * connections closed first; nothing at all while no proxy is set; and WebRTC
 * kept to the proxy in pages behind one.
 */
import { DEFAULT_SETTINGS, type ProxySettings } from '@chord/core';
import type { Session, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { Proxies, type ProxyOwner } from '../../src/main/proxy';

const SYSTEM = DEFAULT_SETTINGS.proxy;
const A: ProxySettings = { mode: 'server', server: { scheme: 'http', host: '10.0.0.2', port: 3128, bypass: [] }, pac: null };
const B: ProxySettings = { mode: 'server', server: { scheme: 'socks5', host: '10.0.0.3', port: 1080, bypass: [] }, pac: null };
const NONE: ProxySettings = { mode: 'none', server: null, pac: null };

/** A session that records what it's told, answering setProxy and closeAllConnections a tick later, as Electron does. */
function fakeSession(name: string) {
  const calls: string[] = [];
  const session = {
    name,
    setProxy: (config: { mode: string; proxyRules?: string }) => {
      calls.push(`setProxy ${config.mode}${config.proxyRules ? ` ${config.proxyRules}` : ''}`);
      return new Promise<void>((resolve) => setTimeout(resolve, 1));
    },
    closeAllConnections: () => {
      calls.push('closeAllConnections');
      return new Promise<void>((resolve) => setTimeout(resolve, 1));
    },
  } as unknown as Session;
  return { session, calls };
}

function fakeContents(session: Session) {
  const policies: string[] = [];
  const contents = { session, isDestroyed: () => false, setWebRTCIPHandlingPolicy: (policy: string) => policies.push(policy) } as unknown as WebContents;
  return { contents, policies };
}

/** Proxies with the proxy for every chord, and chords' own by their sign-ins, changeable. */
function setup(all: ProxySettings, own: Record<string, ProxySettings> = {}) {
  const settings = { all, own };
  const contents: WebContents[] = [];
  const proxies = new Proxies();
  const start = () => proxies.start({ proxyFor: (owner: ProxyOwner) => (owner && settings.own[owner]) || settings.all, contents: () => contents });
  return { proxies, settings, contents, start };
}

describe('Proxies', () => {
  it('with the system’s proxy (Electron’s own), never touches a session: nothing set, nothing to wait for', async () => {
    const { proxies, start } = setup(SYSTEM);
    const early = fakeSession('default');
    proxies.created(early.session);
    start();
    const later = fakeSession('chord-updates');
    proxies.created(later.session);
    const profile = fakeSession('persist:default');
    proxies.make('default', () => (proxies.created(profile.session), profile.session));
    expect([early.calls, later.calls, profile.calls]).toEqual([[], [], []]);
    expect(proxies.ready(later.session)).toBeNull();
    expect(proxies.settled()).toBeNull();
  });

  it('sets the proxy for every chord on each session as it’s made, and its first request waits until that’s done', async () => {
    const { proxies, start } = setup(A);
    start();
    const made = fakeSession('chord-updates');
    // session-created fires inside fromPartition: setProxy is called before the session is handed back.
    proxies.created(made.session);
    expect(made.calls).toEqual(['setProxy fixed_servers http://10.0.0.2:3128']);
    const ready = proxies.ready(made.session);
    expect(ready).not.toBeNull();
    await ready;
    expect(proxies.ready(made.session)).toBeNull();
    // Made just now, it had no connections to close.
    expect(made.calls).toEqual(['setProxy fixed_servers http://10.0.0.2:3128']);
  });

  it('gives sessions made before the settings were read (Chord’s UI, Electron’s default) theirs once they are', async () => {
    const { proxies, start } = setup(A);
    const ui = fakeSession('chord-ui');
    proxies.created(ui.session);
    expect(ui.calls).toEqual([]);
    start();
    await proxies.settled();
    expect(ui.calls).toEqual(['setProxy fixed_servers http://10.0.0.2:3128', 'closeAllConnections']);
  });

  it.each<[string, ProxyOwner, Record<string, ProxySettings>, string[]]>([
    ['a chord with its own proxy: its own', 'p-lab', { 'p-lab': B }, ['setProxy fixed_servers socks5://10.0.0.3:1080']],
    ['a chord with its own sign-ins but no proxy of its own: the one for every chord', 'p-quiet', { 'p-lab': B }, ['setProxy fixed_servers http://10.0.0.2:3128']],
    ['shared sign-ins: the one for every chord', 'default', { 'p-lab': B }, ['setProxy fixed_servers http://10.0.0.2:3128']],
    ['a private window: the one for every chord', 'private-w2', { 'p-lab': B }, ['setProxy fixed_servers http://10.0.0.2:3128']],
  ])('makes a profile’s session with its proxy, once: %s', (_name, owner, own, calls) => {
    const { proxies, start } = setup(A, own);
    start();
    const made = fakeSession(String(owner));
    // As session.fromPartition does: session-created fires while it's made.
    proxies.make(owner, () => {
      proxies.created(made.session);
      return made.session;
    });
    expect(made.calls).toEqual(calls);
  });

  it('after a change, sets each session that should change, closes its connections, and only then lets requests go', async () => {
    const { proxies, settings, start } = setup(A, { 'p-lab': B });
    start();
    const shared = fakeSession('persist:default');
    const lab = fakeSession('persist:p-lab');
    proxies.make('default', () => (proxies.created(shared.session), shared.session));
    proxies.make('p-lab', () => (proxies.created(lab.session), lab.session));
    await proxies.settled();
    shared.calls.length = 0;
    lab.calls.length = 0;

    settings.all = NONE;
    proxies.sync();
    // Lab keeps its own proxy: untouched.
    expect(lab.calls).toEqual([]);
    expect(proxies.ready(lab.session)).toBeNull();
    const ready = proxies.ready(shared.session)!;
    expect(ready).not.toBeNull();
    let letGo = false;
    void ready.then(() => (letGo = true));
    await new Promise((r) => setTimeout(r, 1));
    expect(shared.calls).toEqual(['setProxy direct', 'closeAllConnections']);
    expect(letGo).toBe(false);
    await ready;
    expect(letGo).toBe(true);

    // The same again changes nothing.
    proxies.sync();
    expect(shared.calls).toHaveLength(2);
  });

  it('runs a change made during another after it, so the older one’s closing never cuts the newer one’s requests', async () => {
    const { proxies, settings, start } = setup(A);
    start();
    const made = fakeSession('persist:default');
    proxies.created(made.session);
    await proxies.settled();
    made.calls.length = 0;
    settings.all = B;
    proxies.sync();
    settings.all = NONE;
    proxies.sync();
    await proxies.settled();
    expect(made.calls).toEqual(['setProxy fixed_servers socks5://10.0.0.3:1080', 'closeAllConnections', 'setProxy direct', 'closeAllConnections']);
  });

  it('keeps WebRTC to the proxy in pages behind one, and lets it be again without', async () => {
    const { proxies, settings, contents, start } = setup(SYSTEM);
    start();
    const made = fakeSession('persist:default');
    proxies.created(made.session);
    const before = fakeContents(made.session);
    proxies.contentsCreated(before.contents);
    contents.push(before.contents);
    expect(before.policies).toEqual([]);

    settings.all = A;
    proxies.sync();
    expect(before.policies).toEqual(['disable_non_proxied_udp']);
    const page = fakeContents(made.session);
    proxies.contentsCreated(page.contents);
    expect(page.policies).toEqual(['disable_non_proxied_udp']);
    contents.push(page.contents);

    // A configuration file is a proxy too; no proxy, or the system's, isn't.
    settings.all = { mode: 'pac', server: null, pac: 'http://wpad.example/proxy.pac' };
    proxies.sync();
    expect(page.policies).toEqual(['disable_non_proxied_udp']);
    settings.all = NONE;
    proxies.sync();
    expect(page.policies).toEqual(['disable_non_proxied_udp', 'default']);
    await proxies.settled();
  });

  it('forgets a private window’s session with it', async () => {
    const { proxies, settings, start } = setup(A);
    start();
    const made = fakeSession('chord-private-w2');
    proxies.make('private-w2', () => (proxies.created(made.session), made.session));
    await proxies.settled();
    proxies.forget(made.session);
    settings.all = B;
    proxies.sync();
    expect(made.calls).toEqual(['setProxy fixed_servers http://10.0.0.2:3128']);
  });
});
