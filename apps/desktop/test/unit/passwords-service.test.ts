/**
 * Main's side of Chord's own passwords (main/passwords/service.ts; S17 §5,
 * §7, §11), over a real chord-data vault on a temp chord.db: the lock's clock,
 * *Lock now*, the key kept with the OS, Show and Copy asking again, the
 * clipboard's minute, Delete's Undo, the unlock card, and the API the menu
 * under the field and the save cards will call.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PASSWORD_SETTINGS, type InstalledExtension, type PasswordSettings } from '@chord/core';
import { ChordDatabase } from '@chord/data/db';
import type { Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPasswordDetector } from '../../src/main/passwords/detector';
import { PasswordService, UNCONFIRMED_IN_MENU_MS, type PasswordKeys, type PasswordPage } from '../../src/main/passwords/service';

const KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSPHRASE = 'correct horse battery staple';
const MIN = 60_000;

/** A clock and timers the test moves by hand. */
class Clock {
  now = 1_000_000;
  private timers: { at: number; run: () => void; id: number }[] = [];
  private next = 1;
  setTimeout = (run: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ at: this.now + ms, run, id });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  /** Forward by `ms`, running what comes due, in order. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.run();
      await settle();
    }
    this.now = until;
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** The OS's key store, as on a computer with a keyring: its own wrapping, readable here only. */
class FakeKeys implements PasswordKeys {
  has = true;
  broken = false;
  private readonly kept = new Map<string, Uint8Array>();
  available = async () => this.has;
  wrap = async (key: Uint8Array) => {
    const blob = `wrapped-${this.kept.size}`;
    this.kept.set(blob, new Uint8Array(key));
    return Buffer.from(blob).toString('base64');
  };
  unwrap = async (blob: string) => {
    const key = this.kept.get(Buffer.from(blob, 'base64').toString());
    if (!key || this.broken) throw new Error('no');
    return new Uint8Array(key);
  };
}

let dir: string;
let db: ChordDatabase;
let clock: Clock;
let keys: FakeKeys;
let clipboard: { text: string; writeText(t: string): void; readText(): string };
let settings: PasswordSettings;
let changes: number;
let hides: number;
let service: PasswordService;
const extensions: Record<string, InstalledExtension> = {};

/** The chords main knows: Work (shared sign-ins), and a private window's. */
const CHORDS: Record<string, { id: string; profileId: string; private?: boolean }> = {
  work: { id: 'work', profileId: 'default' },
  priv: { id: 'priv', profileId: 'private-w1', private: true },
};

let locks = 0;
function make(): PasswordService {
  return new PasswordService({
    locked: () => void locks++,
    chord: (chordId) => CHORDS[chordId] ?? null,
    extensions: () => extensions,
    data: (op) => db.passwords.run(op, clock.now),
    settings: () => settings,
    keys,
    clipboard,
    changed: () => void changes++,
    hide: () => void hides++,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-passwords-main-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
  clock = new Clock();
  keys = new FakeKeys();
  clipboard = {
    text: '',
    writeText(t) {
      this.text = t;
    },
    readText() {
      return this.text;
    },
  };
  settings = { ...DEFAULT_PASSWORD_SETTINGS, onChords: [], offChords: [] };
  changes = 0;
  hides = 0;
  service = make();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const github: PasswordPage = { origin: 'https://github.com', chord: { id: 'work', profileId: 'default' }, private: false };

/** A vault with one sign-in, its passphrase typed `clock.now`. */
async function oneLogin(): Promise<string> {
  expect((await service.setup(PASSPHRASE)).ok).toBe(true);
  const added = await service.add({ origin: 'https://github.com', username: 'ada@acme.dev', password: 'hunter2', note: '' });
  if (!added.ok) throw new Error(added.problem);
  return added.view.logins[0]!.id;
}

describe('the lock', () => {
  it.each([
    [30, 29, 'open'],
    [30, 30, 'locked'],
    [5, 5, 'locked'],
    [240, 239, 'open'],
    ['never', 24 * 60, 'open'],
  ] as const)('lock after %s: %d minutes unused leaves it %s', async (lockAfter, minutes, state) => {
    settings.lockAfter = lockAfter;
    await oneLogin();
    await clock.advance(minutes * MIN);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe(state);
  });

  it('counts from the last use, and from a new Lock after once it changes', async () => {
    await oneLogin();
    await clock.advance(20 * MIN);
    await service.view();
    await clock.advance(20 * MIN);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('open');
    settings.lockAfter = 5;
    service.settingsChanged();
    await clock.advance(1);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('locked');
  });

  it('is locked after every launch, and Settings says so', async () => {
    await oneLogin();
    db.close();
    db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
    service = make();
    const view = await service.view();
    expect([view.state, view.count, view.logins]).toEqual(['locked', 1, []]);
    expect((await service.unlock('wrong passphrase!')).ok).toBe(false);
    expect((await service.unlock(PASSPHRASE)).ok).toBe(true);
  });
});

describe('Keep unlocked on this computer', () => {
  it('opens after a launch without asking, and Lock now still locks until the passphrase', async () => {
    const id = await oneLogin();
    expect((await service.keep(true)).ok).toBe(true);
    db.close();
    db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
    service = make();
    let view = await service.view();
    expect([view.state, view.kept, view.logins.map((l) => l.id)]).toEqual(['open', true, [id]]);
    // Idle: the key leaves memory, and comes back unasked.
    await clock.advance(31 * MIN);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('locked');
    expect((await service.view()).state).toBe('open');
    // Lock now: locked until you type it.
    view = await service.lock();
    expect(view.state).toBe('locked');
    expect((await service.accountsForPage(github, extensions)).state).toBe('locked');
    await service.unlock(PASSPHRASE);
    expect((await service.view()).state).toBe('open');
  });

  it('turning it on asks for the passphrase when it was typed more than 5 minutes ago', async () => {
    settings.lockAfter = 'never';
    await oneLogin();
    await clock.advance(5 * MIN);
    expect(await service.keep(true)).toEqual({ ok: false, problem: 'passphrase' });
    expect(await service.keep(true, 'not it at all')).toEqual({ ok: false, problem: 'wrong' });
    expect((await service.keep(true, PASSPHRASE)).ok).toBe(true);
  });

  it('opened unasked, the lock clock starts: a Never site’s candidate after an idle lock doesn’t leave it open', async () => {
    await oneLogin();
    await service.keep(true);
    await service.never({ origin: 'https://example.com', chord: { id: 'work', profileId: 'default' }, private: false });
    await clock.advance(31 * MIN);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('locked');
    expect(await service.candidateFor({ origin: 'https://example.com', username: 'a', password: 'b', chordId: 'work' })).toEqual({ kind: 'never' });
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('open');
    await clock.advance(30 * MIN);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('locked');
  });

  it('an idle lock hides a shown password in Settings, kept or not; Lock now too', async () => {
    await oneLogin();
    await service.keep(true);
    await clock.advance(30 * MIN);
    expect(hides).toBe(1);
    await service.lock();
    expect(hides).toBe(2);
  });

  it('Lock now during a passphrase change holds, with the key kept', async () => {
    await oneLogin();
    await service.keep(true);
    const changing = service.changePassphrase(PASSPHRASE, 'a brand new passphrase');
    await service.lock();
    expect((await changing).ok).toBe(true);
    expect((await service.view()).state).toBe('locked');
  });

  it('Lock now holds across a relaunch with the key kept', async () => {
    await oneLogin();
    await service.keep(true);
    await service.lock();
    db.close();
    db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
    service = make();
    expect((await service.view()).state).toBe('locked');
    expect((await service.unlock(PASSPHRASE)).ok).toBe(true);
    await db.passwords.run({ op: 'lock' });
    service = make();
    expect((await service.view()).state).toBe('open');
  });

  it('needs a keyring, and the vault open', async () => {
    await oneLogin();
    keys.has = false;
    expect(await service.keep(true)).toEqual({ ok: false, problem: 'keyring' });
    keys.has = true;
    await service.lock();
    expect(await service.keep(true)).toEqual({ ok: false, problem: 'locked' });
  });

  it('a kept key the OS can’t read leaves the vault locked, and the passphrase still opens it', async () => {
    await oneLogin();
    await service.keep(true);
    db.close();
    db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
    service = make();
    keys.broken = true;
    const errors: unknown[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      expect((await service.view()).state).toBe('locked');
    } finally {
      console.error = error;
    }
    expect(JSON.stringify(errors)).not.toMatch(/hunter2|wrapped/);
    expect((await service.unlock(PASSPHRASE)).ok).toBe(true);
  });

  it('turned off, a launch asks again', async () => {
    await oneLogin();
    await service.keep(true);
    expect((await service.keep(false)).ok).toBe(true);
    db.close();
    db = new ChordDatabase(join(dir, 'chord.db'), 'linux', KDF);
    service = make();
    expect((await service.view()).state).toBe('locked');
  });
});

describe('Show and Copy', () => {
  it.each([
    ['right after the passphrase', 0, undefined, { ok: true, password: 'hunter2' }],
    ['4 minutes later', 4 * MIN, undefined, { ok: true, password: 'hunter2' }],
    ['5 minutes later, without it', 5 * MIN, undefined, { ok: false, problem: 'passphrase' }],
    ['5 minutes later, with it', 5 * MIN, PASSPHRASE, { ok: true, password: 'hunter2' }],
    ['5 minutes later, with a wrong one', 5 * MIN, 'not the passphrase', { ok: false, problem: 'wrong' }],
  ] as const)('Show %s', async (_what, later, passphrase, answer) => {
    settings.lockAfter = 'never';
    const id = await oneLogin();
    await clock.advance(later);
    expect(await service.reveal(id, passphrase)).toEqual(answer);
  });

  it('asks before the first Show when the vault opened with the kept key', async () => {
    const id = await oneLogin();
    await service.keep(true);
    service = make();
    await db.passwords.run({ op: 'lock' });
    expect(await service.reveal(id)).toEqual({ ok: false, problem: 'passphrase' });
    expect(await service.reveal(id, PASSPHRASE)).toEqual({ ok: true, password: 'hunter2' });
  });

  it('Copy puts it on the clipboard, never in its answer, and takes it off after a minute', async () => {
    const id = await oneLogin();
    expect(await service.copy(id)).toEqual({ ok: true });
    expect(clipboard.text).toBe('hunter2');
    await clock.advance(59_000);
    expect(clipboard.text).toBe('hunter2');
    await clock.advance(1000);
    expect(clipboard.text).toBe('');
  });

  it('leaves the clipboard alone when something else was copied since', async () => {
    const id = await oneLogin();
    await service.copy(id);
    clipboard.text = 'a link I copied';
    await clock.advance(60_000);
    expect(clipboard.text).toBe('a link I copied');
  });

  it('clears it on quit too', async () => {
    const id = await oneLogin();
    await service.copy(id);
    await service.dispose();
    expect(clipboard.text).toBe('');
  });

  it('a locked vault shows nothing', async () => {
    const id = await oneLogin();
    await service.lock();
    expect(await service.reveal(id, PASSPHRASE)).toEqual({ ok: false, problem: 'locked' });
    expect(clipboard.text).toBe('');
  });
});

describe('Settings’ list', () => {
  it('deletes with Undo, named, for the session', async () => {
    const id = await oneLogin();
    const deleted = await service.remove(id);
    if (!deleted.ok) throw new Error(deleted.problem);
    expect(deleted.view.logins).toEqual([]);
    expect(deleted.view.deleted).toEqual([{ id, origin: 'https://github.com', username: 'ada@acme.dev' }]);
    const back = await service.undo(id);
    if (!back.ok) throw new Error(back.problem);
    expect([back.view.logins.map((l) => l.id), back.view.deleted]).toEqual([[id], []]);
  });

  it('never carries a password in its view', async () => {
    await oneLogin();
    expect(JSON.stringify(await service.view())).not.toContain('hunter2');
  });

  it('changing an address needs the passphrase typed in the last 5 minutes; the rest doesn’t', async () => {
    settings.lockAfter = 'never';
    const id = await oneLogin();
    await clock.advance(6 * MIN);
    expect(await service.edit(id, { origin: 'https://evil.example' })).toEqual({ ok: false, problem: 'passphrase' });
    expect((await service.edit(id, { note: 'work' })).ok).toBe(true);
    expect((await service.reveal(id, PASSPHRASE)).ok).toBe(true);
    expect((await service.edit(id, { origin: 'https://gitlab.com' })).ok).toBe(true);
  });

  it('Lock now during an unlock leaves it locked, and the card isn’t told it opened', async () => {
    await oneLogin();
    await service.keep(true);
    await service.lock();
    const unlocking = service.unlock(PASSPHRASE);
    await service.lock();
    expect((await unlocking).ok).toBe(false);
    // Lock now still holds: the kept key doesn't reopen it.
    expect((await service.view()).state).toBe('locked');
  });

  it('idle with the key kept: Settings isn’t told, so it doesn’t reopen the vault by asking', async () => {
    await oneLogin();
    await service.keep(true);
    changes = 0;
    await clock.advance(30 * MIN);
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('locked');
    expect(changes).toBe(0);
  });

  it('an address change asks inline, as Show does', async () => {
    settings.lockAfter = 'never';
    const id = await oneLogin();
    await clock.advance(6 * MIN);
    expect(await service.edit(id, { origin: 'https://gitlab.com' }, 'not it at all')).toEqual({ ok: false, problem: 'wrong' });
    expect((await service.edit(id, { origin: 'https://gitlab.com' }, PASSPHRASE)).ok).toBe(true);
  });

  it('shows no deletions while locked', async () => {
    const id = await oneLogin();
    await service.remove(id);
    expect((await service.view()).deleted).toHaveLength(1);
    await service.lock();
    expect((await service.view()).deleted).toEqual([]);
  });

  it('starts over only while locked', async () => {
    await oneLogin();
    expect((await service.startOver()).count).toBe(1);
    await service.lock();
    expect((await service.startOver()).count).toBe(0);
  });

  it('forgets its Undo when chord-data starts again', async () => {
    const id = await oneLogin();
    await service.remove(id);
    service.restarted();
    expect((await service.view()).deleted).toEqual([]);
  });

  it('refuses what can’t be saved', async () => {
    await service.setup(PASSPHRASE);
    expect(await service.add({ origin: 'chord://settings', username: 'a', password: 'b', note: '' })).toEqual({ ok: false, problem: 'invalid' });
    expect(await service.add({ origin: 'https://a.example', username: 'a', password: '', note: '' })).toEqual({ ok: false, problem: 'invalid' });
  });

  it('starts over: nothing left, and a new passphrase can be chosen', async () => {
    await oneLogin();
    await service.lock();
    expect(await service.startOver()).toMatchObject({ state: 'none', count: 0 });
    expect((await service.setup('another good passphrase')).ok).toBe(true);
  });
});

describe('the unlock card', () => {
  it('asks in a window, answers every caller once the vault opens, and goes', async () => {
    await oneLogin();
    await service.lock();
    const first = service.askUnlock('w1');
    const second = service.askUnlock('w1');
    await settle();
    const card = service.unlockPromptFor('w1')!;
    expect(card).toMatchObject({ keep: false, canKeep: true, problem: null, busy: false });
    await service.answerUnlock(card.id, 'not it at all', false);
    expect(service.unlockPromptFor('w1')!.problem).toBe('wrong');
    await service.answerUnlock(card.id, PASSPHRASE, true);
    expect([await first, await second]).toEqual([true, true]);
    expect(service.unlockPromptFor('w1')).toBeNull();
    // Keep unlocked was on: the key is kept with the OS now.
    expect((await service.view()).kept).toBe(true);
  });

  it('Cancel answers false; a closed window cancels its card', async () => {
    await oneLogin();
    await service.lock();
    const cancelled = service.askUnlock('w1');
    const closed = service.askUnlock('w2');
    await settle();
    await service.answerUnlock(service.unlockPromptFor('w1')!.id, null, false);
    service.windowClosed('w2');
    expect([await cancelled, await closed]).toEqual([false, false]);
  });

  it('isn’t needed when the vault is open, and can’t open one that doesn’t exist', async () => {
    expect(await service.askUnlock('w1')).toBe(false);
    await oneLogin();
    expect(await service.askUnlock('w1')).toBe(true);
    expect(service.unlockPromptFor('w1')).toBeNull();
  });
});

describe('the API agreed with the detector (origin from senderFrame, a chord id)', () => {
  it('accountsFor: usernames only, this chord’s recent first', async () => {
    const id = await oneLogin();
    expect(await service.accountsFor('https://github.com', 'work')).toEqual({ state: 'open', insecure: false, offers: [{ id, username: 'ada@acme.dev', host: '', match: 'origin' }] });
    expect(await service.accountsFor('https://evil.example', 'work')).toEqual({ state: 'open', insecure: false, offers: [] });
  });

  it('passwordFor: only for an origin the sign-in matches; a private window’s use isn’t remembered', async () => {
    const id = await oneLogin();
    expect(await service.passwordFor(id, 'https://github.com.evil.example', 'work')).toBeNull();
    expect(await service.passwordFor(id, 'https://github.com', 'priv')).toBe('hunter2');
    expect((await db.passwords.run({ op: 'list', chordId: 'work' })).logins![0]!.chordUsed).toBeNull();
    expect(await service.passwordFor(id, 'https://github.com', 'work')).toBe('hunter2');
    expect((await db.passwords.run({ op: 'list', chordId: 'work' })).logins![0]!.chordUsed).toBe(clock.now);
  });

  it('saveCandidate: the first sets the passphrase; then update, same; never in a private window, an unknown chord or for a proxy', async () => {
    const at = { origin: 'https://github.com', username: 'ada', password: 'one', chordId: 'work' };
    expect(await service.saveCandidate(at)).toEqual({ ok: false, problem: 'none' });
    for (const refused of [{ ...at, chordId: 'priv' }, { ...at, proxy: true }]) {
      expect(await service.saveCandidate({ ...refused, passphrase: PASSPHRASE })).toEqual({ ok: false, problem: 'refused' });
    }
    // A chord main doesn't know gets nothing at all.
    for (const unknown of [{ ...at, chordId: 'gone' }, { ...at, chordId: null }]) {
      expect(await service.saveCandidate({ ...unknown, passphrase: PASSPHRASE })).toEqual({ ok: false, problem: 'off' });
    }
    const first = await service.saveCandidate({ ...at, passphrase: PASSPHRASE });
    expect(first).toEqual({ ok: true, id: expect.any(String), kind: 'new' });
    const id = (first as { id: string }).id;
    expect(await service.saveCandidate({ ...at, password: 'two' })).toEqual({ ok: true, id, kind: 'update', changedAt: clock.now });
    expect(await service.passwordFor(id, 'https://github.com', 'work')).toBe('two');
    expect(await service.saveCandidate({ ...at, password: 'two' })).toEqual({ ok: true, id, kind: 'same' });
    expect(await service.candidateFor({ ...at, username: 'grace' })).toEqual({ kind: 'new', setup: false });
    await service.never({ origin: 'https://example.com', chord: { id: 'work', profileId: 'default' }, private: false });
    expect(await service.saveCandidate({ ...at, origin: 'https://example.com' })).toEqual({ ok: false, problem: 'never' });
  });

  it('neverFor: the save card’s Never, for the frame’s origin; never from a private window, an unknown chord, or while locked', async () => {
    await oneLogin();
    expect(await service.neverFor('https://example.com', 'priv')).toBe(false);
    expect(await service.neverFor('https://example.com', 'gone')).toBe(false);
    expect(await service.neverFor('https://example.com', 'work')).toBe(true);
    expect(await service.candidateFor({ origin: 'https://example.com', username: 'a', password: 'b', chordId: 'work' })).toEqual({ kind: 'never' });
    await service.lock();
    expect(await service.neverFor('https://other.example', 'work')).toBe(false);
  });

  it('a chord main doesn’t know gets nothing; a private window’s fills', async () => {
    const id = await oneLogin();
    expect(await service.accountsFor('https://github.com', 'gone')).toEqual({ state: 'off' });
    expect(await service.accountsFor('https://github.com', null)).toEqual({ state: 'off' });
    expect(await service.passwordFor(id, 'https://github.com', 'gone')).toBeNull();
    expect(await service.candidateFor({ origin: 'https://github.com', username: 'x', password: 'y', chordId: 'gone' })).toEqual({ kind: 'off' });
    expect((await service.accountsFor('https://github.com', 'priv')).state).toBe('open');
  });

  it('tells the detector which sign-ins to watch, only when that changes', () => {
    const calls: (readonly string[])[] = [];
    const ONE_PASSWORD = { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', profileId: 'default', name: '1Password' } as InstalledExtension;
    let state = { settings: { passwords: settings }, chords: CHORDS, extensions: {} as Record<string, InstalledExtension> };
    service.attachDetector({ setProfiles: (profiles) => void calls.push(profiles) }, state);
    expect(calls).toEqual([['default', 'private-w1']]);
    service.stateChanged(state);
    service.stateChanged({ ...state, chords: { ...CHORDS } });
    expect(calls).toHaveLength(1);
    state = { ...state, extensions: { x: ONE_PASSWORD } };
    service.stateChanged(state);
    expect(calls.at(-1)).toEqual(['private-w1']);
    state = { ...state, settings: { passwords: { ...settings, onChords: ['work'] } } };
    service.stateChanged(state);
    expect(calls.at(-1)).toEqual(['default', 'private-w1']);
    state = { ...state, settings: { passwords: { ...settings, enabled: false } } };
    service.stateChanged(state);
    expect(calls.at(-1)).toEqual([]);
  });

  it('turns the real detector off where it should be: the switch, a password manager’s extension', () => {
    const fake = () => {
      const scripts = new Set<string>();
      let n = 0;
      return {
        scripts,
        registerPreloadScript: vi.fn(() => {
          const id = `s${++n}`;
          scripts.add(id);
          return id;
        }),
        unregisterPreloadScript: vi.fn((id: string) => void scripts.delete(id)),
      };
    };
    const main = fake();
    const priv = fake();
    const detector = createPasswordDetector({ preloadPath: '/p.cjs', agentPath: '/a.js' });
    detector.attachSession('default', main as unknown as Session, false);
    detector.attachSession('private-w1', priv as unknown as Session, true);
    const ONE_PASSWORD = { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', profileId: 'default', name: '1Password' } as InstalledExtension;
    let state = { settings: { passwords: settings }, chords: CHORDS, extensions: {} as Record<string, InstalledExtension> };
    service.attachDetector(detector, state);
    expect([main.scripts.size, priv.scripts.size]).toEqual([1, 1]);
    // 1Password in the default profile: Chord's detector steps aside there (S17 §11).
    state = { ...state, extensions: { x: ONE_PASSWORD } };
    service.stateChanged(state);
    expect([main.scripts.size, priv.scripts.size]).toEqual([0, 1]);
    expect(detector.isEnabled('default')).toBe(false);
    state = { ...state, extensions: {} };
    service.stateChanged(state);
    expect([main.scripts.size, priv.scripts.size]).toEqual([1, 1]);
    // The chord's own switch off by hand (offChords): its sentinel goes at once, and comes back on again; a private window keeps its own.
    state = { ...state, settings: { passwords: { ...settings, offChords: ['work'] } } };
    service.stateChanged(state);
    expect([main.scripts.size, priv.scripts.size]).toEqual([0, 1]);
    state = { ...state, settings: { passwords: { ...settings, offChords: [] } } };
    service.stateChanged(state);
    expect([main.scripts.size, priv.scripts.size]).toEqual([1, 1]);
    // 1Password there, and the chord's switch turned on (onChords): watched despite it.
    state = { ...state, extensions: { x: ONE_PASSWORD }, settings: { passwords: { ...settings, onChords: ['work'] } } };
    service.stateChanged(state);
    expect([main.scripts.size, priv.scripts.size]).toEqual([1, 1]);
    state = { ...state, extensions: {} };
    // The switch off: off everywhere, and in profiles made later.
    state = { ...state, settings: { passwords: { ...settings, enabled: false } } };
    service.stateChanged(state);
    expect([main.scripts.size, priv.scripts.size]).toEqual([0, 0]);
    expect(detector.isEnabled('later')).toBe(false);
  });
});

describe('the API for the menu under the field and the save cards', () => {
  const page = (patch: Partial<PasswordPage> = {}): PasswordPage => ({ ...github, ...patch });
  const ONE_PASSWORD: InstalledExtension = { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', profileId: 'default', name: '1Password', version: '8', source: 'store', path: '', notifiedVersion: null } as InstalledExtension;

  it('offers usernames only, the page’s own first', async () => {
    await oneLogin();
    await service.add({ origin: 'https://gist.github.com', username: 'ada.lovelace', password: 'pw2', note: '' });
    const answer = await service.accountsForPage(page({ origin: 'https://github.com' }), extensions);
    expect(answer).toEqual({
      state: 'open',
      insecure: false,
      offers: [
        { id: expect.any(String), username: 'ada@acme.dev', host: '', match: 'origin' },
        { id: expect.any(String), username: 'ada.lovelace', host: 'gist.github.com', match: 'site' },
      ],
    });
    expect(JSON.stringify(answer)).not.toMatch(/hunter2|pw2/);
  });

  it.each([
    ['the switch off', () => (settings.enabled = false), page()],
    ['a chord with 1Password', () => (extensions['x'] = ONE_PASSWORD), page()],
    ['Chord’s own page', () => undefined, page({ origin: 'chord://settings' })],
  ])('offers nothing with %s', async (_what, arrange, at) => {
    await oneLogin();
    arrange();
    try {
      expect(await service.accountsForPage(at, extensions)).toEqual({ state: 'off' });
      expect(await service.passwordForPage(at, 'id', extensions)).toBeNull();
    } finally {
      delete extensions['x'];
    }
  });

  it('turned on there too, a chord with 1Password is offered them', async () => {
    await oneLogin();
    extensions['x'] = ONE_PASSWORD;
    settings.onChords = ['work'];
    try {
      expect((await service.accountsForPage(page(), extensions)).state).toBe('open');
    } finally {
      delete extensions['x'];
    }
  });

  it('a chord turned off by hand is offered nothing', async () => {
    await oneLogin();
    settings.offChords = ['work'];
    expect(await service.accountsForPage(page(), extensions)).toEqual({ state: 'off' });
    expect(await service.passwordForPage(page(), 'id', extensions)).toBeNull();
  });

  it('says locked, so the menu offers Unlock passwords', async () => {
    await oneLogin();
    await service.lock();
    expect(await service.accountsForPage(page(), extensions)).toEqual({ state: 'locked' });
  });

  it('fills only the page it matches, and remembers which chord used it (not a private window)', async () => {
    const id = await oneLogin();
    expect(await service.passwordForPage(page({ origin: 'https://evil.example' }), id, extensions)).toBeNull();
    expect(await service.passwordForPage(page({ origin: 'http://github.com' }), id, extensions)).toBeNull();
    expect(await service.passwordForPage(page({ chord: null, private: true }), id, extensions)).toBe('hunter2');
    expect((await db.passwords.run({ op: 'list', chordId: 'work' })).logins![0]!.chordUsed).toBeNull();
    expect(await service.passwordForPage(page(), id, extensions)).toBe('hunter2');
    expect((await db.passwords.run({ op: 'list', chordId: 'work' })).logins![0]!.chordUsed).toBe(clock.now);
  });

  it.each([
    ['a private window', { private: true, chord: null }, { kind: 'refused' }],
    ['a proxy', { proxy: true }, { kind: 'refused' }],
    ['a new username', { username: 'grace' }, { kind: 'new', setup: false }],
    ['a new password', { password: 'changed' }, { kind: 'update' }],
    ['what’s saved', {}, { kind: 'same' }],
  ] as const)('a sign-in that worked from %s: %j', async (_what, patch, kind) => {
    await oneLogin();
    const answer = await service.candidate({ ...page(), username: 'ada@acme.dev', password: 'hunter2', ...patch }, extensions);
    expect(answer).toMatchObject(kind);
  });

  it('the first save sets the passphrase; private windows and proxies never save', async () => {
    const at = { ...page(), username: 'ada', password: 'first-password' };
    expect(await service.candidate(at, extensions)).toEqual({ kind: 'new', setup: true });
    expect(await service.save(at, extensions)).toEqual({ ok: false, problem: 'none' });
    expect(await service.save({ ...at, private: true, passphrase: PASSPHRASE }, extensions)).toEqual({ ok: false, problem: 'refused' });
    expect(await service.save({ ...at, proxy: true, passphrase: PASSPHRASE }, extensions)).toEqual({ ok: false, problem: 'refused' });
    expect((await db.passwords.run({ op: 'status' })).status!.state).toBe('none');
    const saved = await service.save({ ...at, passphrase: PASSPHRASE }, extensions);
    expect(saved).toEqual({ ok: true, id: expect.any(String) });
    expect((await service.view()).logins.map((l) => l.username)).toEqual(['ada']);
    // The passphrase was typed just now: Show doesn't ask.
    expect(await service.reveal((saved as { id: string }).id)).toEqual({ ok: true, password: 'first-password' });
  });

  it('Never for this site: no card there again, and Settings lists it', async () => {
    await oneLogin();
    expect(await service.never(page({ origin: 'https://login.example.com' }))).toBe(true);
    expect(await service.candidate({ ...page({ origin: 'https://example.com' }), username: 'a', password: 'b' }, extensions)).toEqual({ kind: 'never' });
    expect(await service.save({ ...page({ origin: 'https://example.com' }), username: 'a', password: 'b' }, extensions)).toEqual({ ok: false, problem: 'refused' });
    expect((await service.view()).nevers).toEqual(['example.com']);
  });
});

describe('the browser’s own sign-in box (S17 §10)', () => {
  const ROUTER = 'http://router.test:8080';
  const signIn = { origin: ROUTER, realm: 'Router admin', username: 'ada@example.com', password: 'box-Sekrit', chordId: 'work' };

  it('the first Remember sets the passphrase; then saved, updated, the same; never in a private window, an unknown chord or a proxy', async () => {
    expect(await service.saveCandidate(signIn)).toEqual({ ok: false, problem: 'none' });
    expect(await service.saveCandidate({ ...signIn, chordId: 'priv', passphrase: PASSPHRASE })).toEqual({ ok: false, problem: 'refused' });
    expect(await service.saveCandidate({ ...signIn, proxy: true, passphrase: PASSPHRASE })).toEqual({ ok: false, problem: 'refused' });
    expect(await service.saveCandidate({ ...signIn, chordId: 'gone', passphrase: PASSPHRASE })).toEqual({ ok: false, problem: 'off' });
    const first = await service.saveCandidate({ ...signIn, passphrase: PASSPHRASE });
    expect(first).toMatchObject({ ok: true, kind: 'new' });
    const id = (first as { id: string }).id;
    expect(await service.saveCandidate({ ...signIn, password: 'two-Sekrit' })).toEqual({ ok: true, id, kind: 'update', changedAt: clock.now });
    expect(await service.saveCandidate({ ...signIn, password: 'two-Sekrit' })).toEqual({ ok: true, id, kind: 'same' });
    // Updated with the one before it kept, as a form's.
    expect(await service.httpPasswordFor(id, ROUTER, 'Router admin', 'work')).toBe('two-Sekrit');
    // A site you said Never for still remembers what you ticked Remember for: you asked.
    await service.never({ origin: ROUTER, chord: { id: 'work', profileId: 'default' }, private: false });
    expect(await service.saveCandidate({ ...signIn, username: 'grace@example.com' })).toMatchObject({ ok: true, kind: 'new' });
  });

  it('fills the box for its origin and realm only, with usernames in the answer; a private window fills, the box and a form stay apart', async () => {
    const saved = await service.saveCandidate({ ...signIn, passphrase: PASSPHRASE });
    const id = (saved as { id: string }).id;
    expect(await service.httpAccountsFor(ROUTER, 'Router admin', 'work')).toEqual({ state: 'open', accounts: [{ id, username: 'ada@example.com' }] });
    for (const [origin, realm] of [
      ['http://router.test:8081', 'Router admin'],
      ['https://router.test:8080', 'Router admin'],
      [ROUTER, 'Other'],
      [ROUTER, ''],
    ] as const) {
      expect(await service.httpAccountsFor(origin, realm, 'work')).toEqual({ state: 'open', accounts: [] });
      expect(await service.httpPasswordFor(id, origin, realm, 'work')).toBeNull();
    }
    expect((await service.httpAccountsFor(ROUTER, 'Router admin', 'priv')).state).toBe('open');
    expect(await service.httpPasswordFor(id, ROUTER, 'Router admin', 'priv')).toBe('box-Sekrit');
    // A form on that origin isn't offered it, nor filled from it.
    expect(await service.accountsFor(ROUTER, 'work')).toEqual({ state: 'open', insecure: true, offers: [] });
    expect(await service.passwordFor(id, ROUTER, 'work')).toBeNull();
  });

  it('main refuses a box’s sign-in on the form side itself, whatever chord-data answers', async () => {
    const boxLogin = { id: 'box', origin: ROUTER, username: 'ada@example.com', realm: 'Router admin', note: '', createdAt: 0, updatedAt: 0, lastUsed: null, chordUsed: null };
    // A chord-data that forgot to keep the two apart.
    const careless = new PasswordService({
      ...{ chord: (chordId: string) => CHORDS[chordId] ?? null, extensions: () => extensions, settings: () => settings, keys, clipboard, changed: () => undefined },
      data: async (op) => {
        if (op.op === 'status') return { status: { state: 'open', kept: false, count: 1 }, generation: 0, held: false };
        if (op.op === 'forSite') return { logins: [boxLogin], unreadable: 0 };
        if (op.op === 'fill') return { password: 'box-Sekrit', loginOrigin: ROUTER, loginRealm: 'Router admin' };
        return {};
      },
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    expect(await careless.accountsFor(ROUTER, 'work')).toEqual({ state: 'open', insecure: true, offers: [] });
    expect(await careless.passwordFor('box', ROUTER, 'work')).toBeNull();
    // And the box gets only its own realm's.
    expect(await careless.httpPasswordFor('box', ROUTER, 'Other', 'work')).toBeNull();
    expect(await careless.httpPasswordFor('box', ROUTER, 'Router admin', 'work')).toBe('box-Sekrit');
  });

  it('Undo of an update: the password before it back, only while it’s still what that update wrote; nothing when locked', async () => {
    const first = await service.saveCandidate({ ...signIn, passphrase: PASSPHRASE });
    const id = (first as { id: string }).id;
    expect(await service.revertUpdate(id, clock.now)).toBe(false);
    clock.now += 1000;
    const update = await service.saveCandidate({ ...signIn, password: 'two-Sekrit' });
    expect(update).toEqual({ ok: true, id, kind: 'update', changedAt: clock.now });
    const changedAt = (update as { changedAt: number }).changedAt;
    // Changed again since (in Settings, say): Undo of the earlier update would bring back the wrong one.
    clock.now += 1000;
    await service.edit(id, { password: 'three-Sekrit' });
    expect(await service.revertUpdate(id, changedAt)).toBe(false);
    expect(await service.httpPasswordFor(id, ROUTER, 'Router admin', 'work')).toBe('three-Sekrit');
    clock.now += 1000;
    const again = await service.saveCandidate({ ...signIn, password: 'four-Sekrit' });
    expect(await service.revertUpdate(id, (again as { changedAt: number }).changedAt)).toBe(true);
    expect(await service.httpPasswordFor(id, ROUTER, 'Router admin', 'work')).toBe('three-Sekrit');
    await service.lock();
    expect(await service.revertUpdate(id, clock.now)).toBe(false);
  });

  it('off where passwords are off, locked when locked, nothing for a chord main doesn’t know', async () => {
    const saved = await service.saveCandidate({ ...signIn, passphrase: PASSPHRASE });
    const id = (saved as { id: string }).id;
    expect(await service.httpAccountsFor(ROUTER, 'Router admin', 'gone')).toEqual({ state: 'off' });
    settings = { ...settings, offChords: ['work'] };
    expect(await service.httpAccountsFor(ROUTER, 'Router admin', 'work')).toEqual({ state: 'off' });
    expect(await service.httpPasswordFor(id, ROUTER, 'Router admin', 'work')).toBeNull();
    expect(await service.saveCandidate({ ...signIn, password: 'x' })).toEqual({ ok: false, problem: 'off' });
    settings = { ...settings, offChords: [], enabled: false };
    expect(await service.httpAccountsFor(ROUTER, 'Router admin', 'priv')).toEqual({ state: 'off' });
    settings = { ...settings, enabled: true };
    await service.lock();
    expect(await service.httpAccountsFor(ROUTER, 'Router admin', 'work')).toEqual({ state: 'locked' });
    expect(await service.httpPasswordFor(id, ROUTER, 'Router admin', 'work')).toBeNull();
  });
});

describe('generated passwords, sign-up and change forms (S17 §6, phase 2)', () => {
  const SITE = 'https://example.com';
  const listed = async () => (await db.passwords.run({ op: 'list', chordId: null })).logins!;

  it.each<[string, () => Promise<void>, string, 'open' | 'locked' | 'none' | 'off']>([
    ['no vault yet', async () => undefined, 'work', 'none'],
    ['open', async () => void (await service.setup(PASSPHRASE)), 'work', 'open'],
    ['locked', async () => void (await service.setup(PASSPHRASE), await service.lock()), 'work', 'locked'],
    ['a private window', async () => void (await service.setup(PASSPHRASE)), 'priv', 'off'],
    ['a chord main doesn’t know', async () => void (await service.setup(PASSPHRASE)), 'gone', 'off'],
    ['passwords off', async () => void (await service.setup(PASSPHRASE), (settings = { ...settings, enabled: false })), 'work', 'off'],
  ])('generatorFor, %s: %s', async (_name, before, chordId, state) => {
    await before();
    expect(await service.generatorFor(SITE, chordId)).toBe(state);
  });

  it('presave: the first sets the passphrase; saved Not confirmed with no username; never in a private window', async () => {
    expect(await service.presave({ origin: SITE, password: 'Gen-1', chordId: 'work' })).toEqual({ ok: false, problem: 'none' });
    expect(await service.presave({ origin: SITE, password: 'Gen-1', chordId: 'priv', passphrase: PASSPHRASE })).toEqual({ ok: false, problem: 'refused' });
    const first = await service.presave({ origin: SITE, password: 'Gen-1', chordId: 'work', passphrase: PASSPHRASE });
    expect(first).toEqual({ ok: true, id: expect.any(String), setup: true });
    expect(await listed()).toEqual([expect.objectContaining({ origin: SITE, username: '', unconfirmed: true })]);
    await service.lock();
    expect(await service.presave({ origin: SITE, password: 'Gen-2', chordId: 'work' })).toEqual({ ok: false, problem: 'locked' });
  });

  it('a Not confirmed one is in the menu for a day after it was made, after the confirmed ones, saying when; confirmed, it’s like any', async () => {
    await oneLogin();
    await db.passwords.run({ op: 'add', login: { origin: 'https://github.com', username: 'zed', password: 'z' }, chordId: null });
    const made = clock.now;
    const g = (await service.presave({ origin: 'https://github.com', password: 'Gen-1', chordId: 'work' })) as { id: string };
    const offers = async () => ((await service.accountsFor('https://github.com', 'work')) as { offers: { username: string; madeAt?: number }[] }).offers.map((o) => [o.username, o.madeAt]);
    expect(await offers()).toEqual([['ada@acme.dev', undefined], ['zed', undefined], ['', made]]);
    expect(await service.presaved('pending', g.id, 'https://github.com', 'work', { username: 'aaa-first-by-name' })).toBe(true);
    expect((await offers()).at(-1)).toEqual(['aaa-first-by-name', made]);
    // A day on, abandoned: in Settings only.
    clock.now += UNCONFIRMED_IN_MENU_MS + 1;
    expect(await offers()).toEqual([['ada@acme.dev', undefined], ['zed', undefined]]);
    expect(await service.presaved('confirm', g.id, 'https://github.com', 'work', { password: 'Gen-1' })).toBe(true);
    expect((await offers()).map(([u]) => u)).toContain('aaa-first-by-name');
  });

  it('presaved: for the frame’s origin only, never a private window’s, never once confirmed', async () => {
    const { id } = (await service.presave({ origin: SITE, password: 'Gen-1', chordId: 'work', passphrase: PASSPHRASE })) as { id: string };
    expect(await service.presaved('pending', id, 'https://example.org', 'work', { username: 'x' })).toBe(false);
    expect(await service.presaved('pending', id, SITE, 'priv', { username: 'x' })).toBe(false);
    expect(await service.presaved('pending', id, SITE, 'work', { username: 'u'.repeat(501) })).toBe(false);
    expect(await service.presaved('confirm', id, SITE, 'work', { username: 'ada' })).toBe(true);
    expect(await service.presaved('pending', id, SITE, 'work', { username: 'grace' })).toBe(false);
    expect((await listed())[0]).toMatchObject({ username: 'ada' });
    expect((await listed())[0]!.unconfirmed).toBeUndefined();
  });

  it('a sign-in that worked with exactly a Not confirmed password confirms it', async () => {
    const { id } = (await service.presave({ origin: SITE, password: 'Gen-1', chordId: 'work', passphrase: PASSPHRASE })) as { id: string };
    await service.presaved('pending', id, SITE, 'work', { username: 'ada' });
    expect(await service.candidateFor({ origin: SITE, username: 'ada', password: 'Gen-1', chordId: 'work' })).toEqual({ kind: 'same', id });
    expect((await listed())[0]!.unconfirmed).toBeUndefined();
  });

  it('changeAccounts: those with the current password, and the site’s to ask from; changePassword updates one and deletes the presave', async () => {
    await service.setup(PASSPHRASE);
    const add = async (username: string, password: string, origin = SITE) => (await db.passwords.run({ op: 'add', login: { origin, username, password }, chordId: null })).id!;
    const ada = await add('ada', 'old');
    const bob = await add('bob', 'old', 'https://login.example.com');
    const cy = await add('cy', 'other');
    await add('dee', 'old', 'https://example.org');
    const found = await service.changeAccounts(SITE, 'work', 'old');
    expect(found).toMatchObject({ state: 'open' });
    if (found.state !== 'open') return;
    expect(found.matches.map((m) => m.id).sort()).toEqual([ada, bob].sort());
    expect(found.accounts.map((a) => a.id).sort()).toEqual([ada, bob, cy].sort());
    expect(await service.changeAccounts(SITE, 'work', null)).toMatchObject({ matches: [] });
    expect(JSON.stringify(found)).not.toContain('old');

    const { id: presaved } = (await service.presave({ origin: SITE, password: 'Gen-1', chordId: 'work' })) as { id: string };
    expect(await service.changePassword({ origin: SITE, chordId: 'work', account: ada, password: 'Gen-1', presaved })).toMatchObject({ ok: true, id: ada, kind: 'update' });
    expect(await service.passwordFor(ada, SITE, 'work')).toBe('Gen-1');
    expect((await listed()).map((l) => l.id)).not.toContain(presaved);
    // Another site's account, a private window, or one that isn't there: refused.
    const org = (await listed()).find((l) => l.username === 'dee')!.id;
    expect(await service.changePassword({ origin: SITE, chordId: 'work', account: org, password: 'x' })).toEqual({ ok: false, problem: 'missing' });
    expect(await service.changePassword({ origin: SITE, chordId: 'priv', account: ada, password: 'x' })).toEqual({ ok: false, problem: 'off' });
    expect(await service.passwordFor(ada, SITE, 'work')).toBe('Gen-1');
  });

  it('changePasswordUrl: the site’s /.well-known/change-password, for a sign-in Settings was shown only', async () => {
    const id = await oneLogin();
    // A service whose Settings hasn't been shown the list (a relaunch): nothing.
    expect(await make().changePasswordUrl(id)).toBeNull();
    expect(await service.changePasswordUrl(id)).toMatch(/^https:\/\//);
    await service.add({ origin: SITE, username: 'ada', password: 'p', note: '' });
    const view = await service.view();
    const mine = view.logins.find((l) => l.origin === SITE)!;
    expect(await service.changePasswordUrl(mine.id)).toBe('https://example.com/.well-known/change-password');
    expect(await service.changePasswordUrl('not-an-id')).toBeNull();
  });
});

describe('the locks tell the assist (review round 3 of #62)', () => {
  it('idle lock and Lock now each call `locked`, so a held confirmation goes', async () => {
    await oneLogin();
    locks = 0;
    await clock.advance(31 * MIN);
    expect(locks).toBe(1);
    await service.unlock(PASSPHRASE);
    await service.lock();
    expect(locks).toBe(2);
  });
});
