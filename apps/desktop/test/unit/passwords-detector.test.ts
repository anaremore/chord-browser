import { EventEmitter } from 'node:events';
import type { Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { checkMessage, createPasswordDetector, MESSAGE_RATE, pageOrigin, SENTINEL_ID, tokenBucket } from '../../src/main/passwords/detector';
import { SETTLE_MS } from '../../src/main/passwords/saving';

interface Frame {
  origin: string;
  parent: Frame | null;
  processId: number;
  routingId: number;
}
const frame = (origin: string, routingId = 1, parent: Frame | null = null): Frame => ({ origin, parent, processId: 7, routingId });

function fakeSession() {
  const scripts = new Map<string, unknown>();
  let n = 0;
  return {
    scripts,
    registerPreloadScript: vi.fn((script: { id: string }) => {
      const id = `${script.id}#${++n}`;
      scripts.set(id, script);
      return id;
    }),
    unregisterPreloadScript: vi.fn((id: string) => void scripts.delete(id)),
  };
}

/** A tab's webContents: its own ipc, its main frame, its session. */
function fakeContents(session: ReturnType<typeof fakeSession>, origin = 'https://example.com') {
  const contents = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const ipc = new EventEmitter() as EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>; handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void };
  ipc.handlers = new Map();
  ipc.handle = (channel, fn) => {
    if (ipc.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    ipc.handlers.set(channel, fn);
  };
  (ipc as unknown as { removeHandler(channel: string): void }).removeHandler = (channel) => void ipc.handlers.delete(channel);
  Object.assign(contents, { id: 1, ipc, session, mainFrame: frame(origin), isDestroyed: () => false, getZoomFactor: () => 1.25 });
  /** A message from a frame (the main frame unless given), as Electron delivers it. */
  const send = (channel: string, payload: unknown, from: Frame = contents['mainFrame'] as Frame) => ipc.emit(channel, { senderFrame: from }, payload);
  const invoke = (channel: string, from: Frame = contents['mainFrame'] as Frame) => ipc.handlers.get(channel)!({ senderFrame: from });
  return { contents: contents as unknown as WebContents, emitter: contents, send, invoke };
}

const FOCUS = { formId: 'f1', kind: 'sign-in', role: 'username', rect: { x: 10, y: 20, width: 200, height: 30 } };
const CANDIDATE = { formId: 'f1', kind: 'sign-in', signal: 'submit', username: { type: 'email', id: 'u', name: 'email' }, password: { type: 'password', id: 'p', name: 'password' }, newPassword: null, hasUsername: true, hasPassword: true };

function setup({ isPrivate = false, on = true, clock = { t: 0 } } = {}) {
  const session = fakeSession();
  const detector = createPasswordDetector({ preloadPath: '/out/preload/passwords.cjs', agentPath: '/out/main/passwords/agent.js', readAgent: async () => 'agent source', now: () => clock.t });
  detector.attachSession('p1', session as unknown as Session, isPrivate);
  if (on) detector.setEnabled(true);
  const page = fakeContents(session);
  detector.attachPage(page.contents);
  const seen: [string, Record<string, unknown>][] = [];
  for (const type of ['focus', 'blur', 'submitted', 'signedIn', 'failed'] as const) detector.events.on(type, (e: unknown) => seen.push([type, e as Record<string, unknown>]));
  return { detector, session, page, seen };
}

describe('the sentinel on and off', () => {
  it('is registered only while on, on each chord named or every one, and on sessions made later', () => {
    const detector = createPasswordDetector({ preloadPath: '/p.cjs', agentPath: '/a.js' });
    const a = fakeSession();
    const b = fakeSession();
    detector.attachSession('a', a as unknown as Session, false);
    expect(a.scripts.size).toBe(0);
    detector.setEnabled(true);
    expect([...a.scripts.values()]).toEqual([{ type: 'frame', id: SENTINEL_ID, filePath: '/p.cjs' }]);
    detector.attachSession('b', b as unknown as Session, false);
    expect(b.scripts.size).toBe(1);
    // Off in one chord (its password manager's extension, say): only that one's goes.
    detector.setEnabled(false, ['b']);
    expect([a.scripts.size, b.scripts.size]).toEqual([1, 0]);
    expect(detector.isEnabled('b')).toBe(false);
    // Turning it on again doesn't register twice.
    detector.setEnabled(true, ['a']);
    expect(a.registerPreloadScript).toHaveBeenCalledTimes(1);
    detector.setEnabled(false);
    expect([a.scripts.size, b.scripts.size]).toEqual([0, 0]);
  });
});

describe('who may talk to the detector', () => {
  it.each([
    ['the main frame of an https page', frame('https://a.example'), 'https://a.example'],
    ['an http page (a router)', frame('http://192.168.1.1'), 'http://192.168.1.1'],
    ['a frame inside the page', frame('https://a.example', 2, frame('https://a.example')), null],
    ['a frame with the main frame\'s origin but another routing id', frame('https://a.example', 9), null],
    ['an opaque origin (a sandboxed document)', frame('null'), null],
    ['a file page', frame('file://'), null],
    ['no frame (it went)', null, null],
  ])('%s', (_name, from, expected) => {
    expect(pageOrigin(from as Parameters<typeof pageOrigin>[0], frame('https://a.example'))).toBe(expected);
  });

  it('answers the agent\'s script only to a tab where it\'s on, from its main frame', async () => {
    const { page } = setup();
    expect(await page.invoke('passwords:agent')).toBe('agent source');
    expect(await page.invoke('passwords:agent', frame('https://example.com', 2, frame('https://example.com')))).toBeNull();
    const off = setup({ on: false });
    expect(await off.page.invoke('passwords:agent')).toBeNull();
  });

  it('takes the origin from the sender frame, and drops a subframe\'s message', () => {
    const { page, seen } = setup();
    page.send('passwords:focus', FOCUS);
    page.send('passwords:focus', FOCUS, frame('https://ads.example', 3, frame('https://example.com')));
    expect(seen.map(([t]) => t)).toEqual(['focus']);
    expect(seen[0]![1]).toMatchObject({ ...FOCUS, origin: 'https://example.com', zoomFactor: 1.25 });
  });

  it('drops messages from a chord turned off, without a restart', () => {
    const { detector, page, seen } = setup();
    detector.setEnabled(false);
    page.send('passwords:focus', FOCUS);
    expect(seen).toEqual([]);
  });
});

describe('payloads', () => {
  it.each<[string, string, unknown]>([
    ['an origin of the page\'s choosing', 'focus', { ...FOCUS, origin: 'https://bank.example' }],
    ['a value beside a field', 'candidate', { ...CANDIDATE, value: 'hunter2' }],
    ['a password in a field signature', 'candidate', { ...CANDIDATE, password: { ...CANDIDATE.password, value: 'hunter2' } }],
    ['a form id that isn\'t the agent\'s', 'blur', { formId: '<img src=x>' }],
    ['a role there isn\'t', 'focus', { ...FOCUS, role: 'credit-card' }],
    ['a rectangle out of any page', 'focus', { ...FOCUS, rect: { ...FOCUS.rect, x: Number.POSITIVE_INFINITY } }],
    ['a signature too long', 'candidate', { ...CANDIDATE, username: { type: 'email', id: 'x'.repeat(81), name: '' } }],
    ['too many forms', 'forms', { forms: Array.from({ length: 51 }, (_, i) => ({ formId: `f${i}`, kind: 'sign-in', username: null, password: null, newPassword: null })) }],
    ['a status that isn\'t HTTP\'s', 'hint', { formId: 'f1', status: 42 }],
    ['not an object', 'gone', 'f1'],
  ])('refuses %s', (_name, channel, payload) => {
    expect(checkMessage(channel as 'focus', payload)).toBeNull();
  });

  it('takes a well-formed one', () => {
    expect(checkMessage('candidate', CANDIDATE)).toEqual(CANDIDATE);
    expect(checkMessage('focus', FOCUS)).toEqual(FOCUS);
  });

  it('refuses one over the size limit', () => {
    expect(checkMessage('blur', { formId: 'f1', pad: 'x'.repeat(20_000) })).toBeNull();
  });
});

describe('events', () => {
  it('a submit, a navigation and a page without the form: submitted, then signed in', () => {
    vi.useFakeTimers();
    try {
      const { page, seen } = setup();
      page.send('passwords:candidate', CANDIDATE);
      page.emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator: page.contents.mainFrame });
      page.emitter.emit('did-navigate', {}, 'https://example.com/home', 200);
      page.emitter.emit('did-stop-loading');
      vi.advanceTimersByTime(SETTLE_MS);
      expect(seen.map(([t]) => t)).toEqual(['submitted', 'signedIn']);
      expect(seen[1]![1]).toMatchObject({ formId: 'f1', how: 'navigation', origin: 'https://example.com', contents: page.contents });
    } finally {
      vi.useRealTimers();
    }
  });

  it('in a private window: submitted, but never signed in or failed (fill only, S17 §7)', () => {
    const { page, seen } = setup({ isPrivate: true });
    page.send('passwords:candidate', CANDIDATE);
    page.send('passwords:gone', { formId: 'f1' });
    page.send('passwords:candidate', CANDIDATE);
    page.send('passwords:still', { formId: 'f1' });
    expect(seen.map(([t]) => t)).toEqual(['submitted', 'submitted']);
  });

  it('a navigation you started yourself forgets the form', () => {
    vi.useFakeTimers();
    try {
      const { page, seen } = setup();
      page.send('passwords:candidate', { ...CANDIDATE, signal: 'blur' });
      page.emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator: null });
      page.emitter.emit('did-navigate', {}, 'https://other.example/', 200);
      page.emitter.emit('did-stop-loading');
      vi.advanceTimersByTime(SETTLE_MS);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a page that floods main', () => {
  it('1,000 messages at once: only the burst gets through, and the rest are dropped without parsing', () => {
    const clock = { t: 0 };
    const { page, seen } = setup({ clock });
    for (let i = 0; i < 1000; i++) page.send('passwords:focus', FOCUS);
    expect(seen.length).toBe(MESSAGE_RATE.burst);
  });

  it('then the rate a second, whatever comes', () => {
    const clock = { t: 0 };
    const { page, seen } = setup({ clock });
    for (let ms = 0; ms < 5000; ms += 1) {
      clock.t = ms;
      page.send('passwords:blur', { formId: 'f1' });
    }
    // The burst, then about 20 a second for 5 s.
    expect(seen.length).toBeLessThanOrEqual(MESSAGE_RATE.burst + 5 * MESSAGE_RATE.perSecond);
    expect(seen.length).toBeGreaterThanOrEqual(5 * MESSAGE_RATE.perSecond);
  });

  it('a page that sends a little is never held back', () => {
    let t = 0;
    const bucket = tokenBucket(() => t);
    const passed = Array.from({ length: 50 }, () => ((t += 250), bucket.take())).filter(Boolean).length;
    expect(passed).toBe(50);
  });

  it('each page has its own bucket', () => {
    const one = setup();
    for (let i = 0; i < 100; i++) one.page.send('passwords:focus', FOCUS);
    const two = setup();
    two.page.send('passwords:focus', FOCUS);
    expect(two.seen.length).toBe(1);
  });
});

describe('other pages on a chord\'s session', () => {
  it('a page that isn\'t a tab gets nothing for its ask, and a tab attached after takes over', async () => {
    const { detector, session } = setup();
    const other = fakeContents(session);
    detector.attachOther(other.contents);
    expect(await other.invoke('passwords:agent')).toBeNull();
    detector.attachPage(other.contents);
    expect(await other.invoke('passwords:agent')).toBe('agent source');
    // Attached twice over: no second handler error.
    expect(() => detector.attachOther(other.contents)).not.toThrow();
  });
});

describe('the forms message fits the channel', () => {
  it('the most forms, each with the longest signatures, stay under the size limit', async () => {
    const { PASSWORDS_MAX_FORMS } = await import('@chord/core');
    const { PASSWORDS_MESSAGE_MAX } = await import('@chord/ipc');
    const sig = { type: 't'.repeat(20), id: 'i'.repeat(80), name: 'n'.repeat(80) };
    const forms = { forms: Array.from({ length: PASSWORDS_MAX_FORMS }, (_, i) => ({ formId: `f${100000 + i}`, kind: 'username-only', username: sig, password: sig, newPassword: sig })) };
    expect(JSON.stringify(forms).length).toBeLessThan(PASSWORDS_MESSAGE_MAX);
    expect(checkMessage('forms', forms)).not.toBeNull();
  });
});
