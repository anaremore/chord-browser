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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PasswordService, type PasswordKeys, type PasswordPage } from '../../src/main/passwords/service';

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
let service: PasswordService;
const extensions: Record<string, InstalledExtension> = {};

function make(): PasswordService {
  return new PasswordService({
    data: (op) => db.passwords.run(op, clock.now),
    settings: () => settings,
    keys,
    clipboard,
    changed: () => void changes++,
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
  settings = { ...DEFAULT_PASSWORD_SETTINGS, onChords: [] };
  changes = 0;
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
    expect((await service.accountsFor(github, extensions)).state).toBe('locked');
    await service.unlock(PASSPHRASE);
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

  it('refuses what can’t be saved', async () => {
    await service.setup(PASSPHRASE);
    expect(await service.add({ origin: 'chord://settings', username: 'a', password: 'b', note: '' })).toEqual({ ok: false, problem: 'invalid' });
    expect(await service.add({ origin: 'https://a.example', username: 'a', password: '', note: '' })).toEqual({ ok: false, problem: 'invalid' });
  });

  it('starts over: nothing left, and a new passphrase can be chosen', async () => {
    await oneLogin();
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

describe('the API for the menu under the field and the save cards', () => {
  const page = (patch: Partial<PasswordPage> = {}): PasswordPage => ({ ...github, ...patch });
  const ONE_PASSWORD: InstalledExtension = { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', profileId: 'default', name: '1Password', version: '8', source: 'store', path: '', notifiedVersion: null } as InstalledExtension;

  it('offers usernames only, the page’s own first', async () => {
    await oneLogin();
    await service.add({ origin: 'https://gist.github.com', username: 'ada.lovelace', password: 'pw2', note: '' });
    const answer = await service.accountsFor(page({ origin: 'https://github.com' }), extensions);
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
      expect(await service.accountsFor(at, extensions)).toEqual({ state: 'off' });
      expect(await service.passwordForFill(at, 'id', extensions)).toBeNull();
    } finally {
      delete extensions['x'];
    }
  });

  it('turned on there too, a chord with 1Password is offered them', async () => {
    await oneLogin();
    extensions['x'] = ONE_PASSWORD;
    settings.onChords = ['work'];
    try {
      expect((await service.accountsFor(page(), extensions)).state).toBe('open');
    } finally {
      delete extensions['x'];
    }
  });

  it('says locked, so the menu offers Unlock passwords', async () => {
    await oneLogin();
    await service.lock();
    expect(await service.accountsFor(page(), extensions)).toEqual({ state: 'locked' });
  });

  it('fills only the page it matches, and remembers which chord used it (not a private window)', async () => {
    const id = await oneLogin();
    expect(await service.passwordForFill(page({ origin: 'https://evil.example' }), id, extensions)).toBeNull();
    expect(await service.passwordForFill(page({ origin: 'http://github.com' }), id, extensions)).toBeNull();
    expect(await service.passwordForFill(page({ chord: null, private: true }), id, extensions)).toBe('hunter2');
    expect((await db.passwords.run({ op: 'list', chordId: 'work' })).logins![0]!.chordUsed).toBeNull();
    expect(await service.passwordForFill(page(), id, extensions)).toBe('hunter2');
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
