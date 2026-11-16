/**
 * Chord's own passwords, the pure parts (docs/decisions/S17-passwords.md §5,
 * §7, §11): the lock's clock, when Show and Copy ask again, the extension
 * rule, the settings' restore and patches, and which saved sign-ins a page is
 * offered, in what order.
 */
import { describe, expect, it } from 'vitest';
import { insecureOrigin, loginOrigin, loginSite, matchLogin, offersFor } from '../src/password-sites';
import {
  applyPasswordPatch,
  DEFAULT_PASSWORD_SETTINGS,
  lockAfterText,
  lockDue,
  loginProblem,
  passphraseDue,
  passwordManagerIn,
  passwordProfiles,
  passwordsOffBecause,
  passwordsOffText,
  passwordsOnIn,
  restorePasswordSettings,
  type LoginSummary,
  type PasswordSettings,
} from '../src/passwords';
import type { InstalledExtension } from '../src/model';
import { apply, DEFAULT_SETTINGS, emptyState, restoreSettings } from '../src';

const MIN = 60_000;

describe('the lock’s clock', () => {
  it.each([
    [30, 0, 29 * MIN, false],
    [30, 0, 30 * MIN, true],
    [5, 10 * MIN, 14 * MIN, false],
    [5, 10 * MIN, 15 * MIN, true],
    [240, 0, 239 * MIN, false],
    ['never', 0, 1000 * 60 * MIN, false],
  ] as const)('lock after %s, last used at %d, now %d: due %s', (lockAfter, lastUsed, now, due) => {
    expect(lockDue(now, lastUsed, lockAfter)).toBe(due);
  });

  it.each([
    [null, 0, true],
    [0, 4 * MIN + 59_999, false],
    [0, 5 * MIN, true],
    [1000, 1000, false],
  ] as const)('passphrase typed at %s, now %d: Show and Copy ask again %s', (typedAt, now, due) => {
    expect(passphraseDue(now, typedAt)).toBe(due);
  });

  it.each([
    [5, '5 minutes unused'],
    [30, '30 minutes unused'],
    [60, '1 hour unused'],
    [240, '4 hours unused'],
    ['never', 'Never'],
  ] as const)('words %s as “%s”', (lockAfter, text) => {
    expect(lockAfterText(lockAfter)).toBe(text);
  });
});

const ext = (id: string, profileId: string, name: string): Pick<InstalledExtension, 'id' | 'profileId' | 'name'> => ({ id, profileId, name });
const ONE_PASSWORD = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
const BITWARDEN = 'nngceckbapebfimnlniiiahkandclblb';
const UBLOCK = 'cjpalhdlnbpafiamejdnhcphjbkeiagm';

describe('a password manager’s extension turns Chord’s off in its chord', () => {
  const extensions = [ext(ONE_PASSWORD, 'personal', '1Password'), ext(UBLOCK, 'default', 'uBlock Origin'), ext(BITWARDEN, 'shared', 'Bitwarden')];
  const settings = (patch: Partial<PasswordSettings> = {}): PasswordSettings => ({ ...DEFAULT_PASSWORD_SETTINGS, ...patch });
  const chords = [
    { id: 'c-work', name: 'Work', profileId: 'default' },
    { id: 'c-personal', name: 'Personal', profileId: 'personal' },
    { id: 'c-a', name: 'Side', profileId: 'shared' },
    { id: 'c-b', name: 'Music', profileId: 'shared' },
  ];

  it.each([
    ['a chord with no manager', settings(), chords[0]!, true],
    ['a chord with 1Password', settings(), chords[1]!, false],
    ['the same, turned on there too', settings({ onChords: ['c-personal'] }), chords[1]!, true],
    ['the switch off', settings({ enabled: false }), chords[0]!, false],
    ['the switch off, even turned on there', settings({ enabled: false, onChords: ['c-personal'] }), chords[1]!, false],
    ['a private window', settings(), null, true],
  ] as const)('%s: on %s', (_what, s, chord, on) => {
    expect(passwordsOnIn(s, chord, extensions)).toBe(on);
  });

  it('finds the manager by its store id, never by name', () => {
    expect(passwordManagerIn('default', extensions)).toBeNull();
    expect(passwordManagerIn('personal', extensions)?.name).toBe('1Password');
    expect(passwordManagerIn('personal', [ext(UBLOCK, 'personal', '1Password')])).toBeNull();
  });

  it.each([
    ['on: every chord’s sign-ins but those with a manager only, and private windows’', settings(), ['default', 'private-w1']],
    ['turned on there too: that chord’s sign-ins as well', settings({ onChords: ['c-a'] }), ['default', 'private-w1', 'shared']],
    ['the switch off: none, private windows’ neither', settings({ enabled: false }), []],
  ] as const)('the detector watches %s', (_what, s, profiles) => {
    const all = [...chords, { id: 'c-private', name: 'Private', profileId: 'private-w1', private: true }];
    expect(passwordProfiles(s, all, extensions)).toEqual(profiles);
  });

  it('says where it’s off, and why', () => {
    const off = passwordsOffBecause(settings(), chords, extensions);
    expect(off.map((o) => o.chordId)).toEqual(['c-personal', 'c-a', 'c-b']);
    expect(passwordsOffText(off.slice(0, 1))).toBe('Off in Personal, where 1Password is installed.');
    expect(passwordsOffText(off.slice(1))).toBe('Off in Side and Music, where Bitwarden is installed.');
    expect(passwordsOffText(off)).toBe('Off in Personal, Side and Music, where 1Password and Bitwarden are installed.');
    expect(passwordsOffText(passwordsOffBecause(settings({ onChords: ['c-personal', 'c-a', 'c-b'] }), chords, extensions))).toBeNull();
  });
});

describe('the settings', () => {
  it('start on, locking after 30 minutes', () => {
    expect(DEFAULT_SETTINGS.passwords).toEqual({ enabled: true, lockAfter: 30, onChords: [] });
  });

  it.each([
    ['nothing saved', undefined, DEFAULT_PASSWORD_SETTINGS],
    ['every part', { enabled: false, lockAfter: 'never', onChords: ['a', 'b'] }, { enabled: false, lockAfter: 'never', onChords: ['a', 'b'] }],
    ['a lock time Chord doesn’t offer', { lockAfter: 7 }, DEFAULT_PASSWORD_SETTINGS],
    ['junk in the chord list', { onChords: ['a', 3, '', 'a', 'x'.repeat(101)] }, { ...DEFAULT_PASSWORD_SETTINGS, onChords: ['a'] }],
  ])('restore %s', (_what, saved, expected) => {
    expect(restorePasswordSettings(saved)).toEqual(expected);
    expect(restoreSettings({ passwords: saved }).passwords).toEqual(expected);
  });

  it('a settings change sets each part it names, and nothing else', () => {
    const current = { ...DEFAULT_PASSWORD_SETTINGS, onChords: [] };
    applyPasswordPatch(current, { lockAfter: 5 });
    expect(current).toEqual({ enabled: true, lockAfter: 5, onChords: [] });
    applyPasswordPatch(current, { lockAfter: 'soon' as never, onChords: ['c1', 'c1'] });
    expect(current).toEqual({ enabled: true, lockAfter: 5, onChords: ['c1'] });
  });

  it('goes through the reducer', () => {
    const state = apply(emptyState(), { t: 'settings.set', settings: { passwords: { enabled: false, lockAfter: 'never' } } }, { now: 0, newId: () => 'id' }).state;
    expect(state.settings.passwords).toEqual({ enabled: false, lockAfter: 'never', onChords: [] });
  });
});

describe('a sign-in’s limits', () => {
  it.each([
    [{ origin: 'https://a.example', username: 'ada', password: 'p' }, null],
    [{ origin: 'https://a.example', username: '', password: 'p' }, null],
    [{ origin: 'https://a.example', username: 'ada', password: '' }, 'empty'],
    [{ origin: 'https://a.example', username: 'u'.repeat(501), password: 'p' }, 'username'],
    [{ origin: 'https://a.example', username: 'u', password: 'p'.repeat(1001) }, 'password'],
    [{ origin: 'https://a.example', username: 'u', password: 'p', note: 'n'.repeat(4001) }, 'note'],
  ] as const)('%j: %s', (login, problem) => {
    expect(loginProblem(login)).toBe(problem);
  });
});

describe('origins and sites', () => {
  it.each([
    ['https://github.com/login?x=1', 'https://github.com'],
    ['http://10.0.0.1:8080/', 'http://10.0.0.1:8080'],
    ['HTTPS://GitHub.COM', 'https://github.com'],
    ['https://user:pass@github.com', null],
    ['chord://settings', null],
    ['file:///etc/passwd', null],
    ['about:blank', null],
    ['data:text/html,<form>', null],
    ['blob:https://github.com/1', null],
    ['not a url', null],
  ])('%s → %s', (url, origin) => {
    expect(loginOrigin(url)).toBe(origin);
  });

  it.each([
    ['https://login.github.com', 'github.com'],
    ['https://a.github.io', 'a.github.io'],
    ['https://www.bbc.co.uk', 'bbc.co.uk'],
    ['http://localhost:3000', 'localhost:3000'],
    ['http://localhost', 'localhost'],
    ['http://192.168.1.1', '192.168.1.1'],
    ['https://192.168.1.1:8443', '192.168.1.1:8443'],
    ['http://[::1]:8080', '[::1]:8080'],
    ['http://router', 'router'],
  ])('%s is the site %s', (origin, site) => {
    expect(loginSite(origin)).toBe(site);
  });

  it.each([
    ['https://github.com', 'https://github.com', 'origin'],
    ['https://app.x.com', 'https://login.x.com', 'site'],
    ['https://x.com', 'https://x.com:8443', 'site'],
    ['https://github.com', 'http://github.com', 'upgrade'],
    ['https://github.com:8443', 'http://github.com', null],
    ['https://app.x.com', 'http://login.x.com', null],
    ['http://github.com', 'https://github.com', null],
    ['http://router.local', 'http://router.local', 'origin'],
    ['http://app.x.com', 'http://login.x.com', null],
    ['https://a.github.io', 'https://b.github.io', null],
    ['https://paypa1.com', 'https://paypal.com', null],
    ['https://paypal.com.evil.example', 'https://paypal.com', null],
    ['https://10.0.0.1', 'https://10.0.0.2', null],
    ['https://10.0.0.1:8443', 'https://10.0.0.1:9443', null],
  ] as const)('the page %s, saved on %s: %s', (page, saved, match) => {
    expect(matchLogin(page, saved)).toBe(match);
  });

  it.each([
    ['https://github.com', false],
    ['http://github.com', true],
    ['http://localhost:3000', false],
    ['http://127.0.0.1', false],
    ['chord://settings', true],
  ])('%s is insecure: %s', (origin, insecure) => {
    expect(insecureOrigin(origin)).toBe(insecure);
  });
});

describe('what the menu under the field offers', () => {
  const login = (id: string, origin: string, username: string, lastUsed: number | null = null, chordUsed: number | null = null): LoginSummary => ({
    id,
    origin,
    username,
    note: '',
    createdAt: 0,
    updatedAt: 0,
    lastUsed,
    chordUsed,
  });

  it('the page’s own first, this chord’s recent first within each, the rest of the site below with its host', () => {
    const offers = offersFor('https://github.com', [
      login('gist', 'https://gist.github.com', 'ada.lovelace', 900, 900),
      login('personal', 'https://github.com', 'ada@home.dev', 800, null),
      login('work', 'https://github.com', 'ada@acme.dev', 100, 100),
      login('old-http', 'http://github.com', 'old', null, null),
      login('other', 'https://gitlab.com', 'nope', 1000, 1000),
    ]);
    expect(offers.map((o) => [o.id, o.host, o.match])).toEqual([
      ['work', '', 'origin'],
      ['personal', '', 'origin'],
      ['old-http', '', 'upgrade'],
      ['gist', 'gist.github.com', 'site'],
    ]);
    expect(Object.keys(offers[0]!).sort()).toEqual(['host', 'id', 'match', 'username']);
  });

  it('offers nothing to an http page from https, nor to a look-alike', () => {
    const saved = [login('a', 'https://paypal.com', 'ada')];
    expect(offersFor('http://paypal.com', saved)).toEqual([]);
    expect(offersFor('https://paypa1.com', saved)).toEqual([]);
    expect(offersFor('chord://settings', saved)).toEqual([]);
  });
});
