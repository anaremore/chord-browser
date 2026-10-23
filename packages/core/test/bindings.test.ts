import { describe, expect, it } from 'vitest';
import {
  apply,
  checkCombo,
  cleanOverrides,
  comboFromInput,
  emptyState,
  findShortcut,
  formatKeys,
  keycapFor,
  keysFor,
  overrideFor,
  restoreState,
  shortcutById,
  shortcutUsing,
  type KeyInput,
  type Shortcut,
} from '../src';

const key = (k: Partial<KeyInput> & { key: string; code: string }): KeyInput => ({
  type: 'keyDown',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...k,
});
const sc = (id: Parameters<typeof shortcutById>[0]) => shortcutById(id) as Shortcut;

describe('recording a key press', () => {
  it('names ⌘ as Mod on macOS and Ctrl as Mod elsewhere', () => {
    expect(comboFromInput(key({ key: 'k', code: 'KeyK', meta: true }), 'darwin')).toBe('Mod+K');
    expect(comboFromInput(key({ key: 'k', code: 'KeyK', control: true }), 'darwin')).toBe('Ctrl+K');
    expect(comboFromInput(key({ key: 'k', code: 'KeyK', control: true }), 'win32')).toBe('Mod+K');
    expect(comboFromInput(key({ key: 'k', code: 'KeyK', meta: true }), 'linux')).toBe('Meta+K');
  });

  it('goes by position for letters, digits and punctuation, as the router matches', () => {
    // ⌥K types ˚ on a US Mac; Shift+1 types !; AZERTY's digit row needs Shift for digits.
    expect(comboFromInput(key({ key: '˚', code: 'KeyK', meta: true, alt: true }), 'darwin')).toBe('Mod+Alt+K');
    expect(comboFromInput(key({ key: '!', code: 'Digit1', control: true, shift: true }), 'win32')).toBe('Mod+Shift+1');
    expect(comboFromInput(key({ key: '?', code: 'Slash', control: true, shift: true }), 'linux')).toBe('Mod+Shift+/');
    expect(comboFromInput(key({ key: ' ', code: 'Space', alt: true }), 'win32')).toBe('Alt+Space');
  });

  it('waits while only modifiers are down', () => {
    expect(comboFromInput(key({ key: 'Meta', code: 'MetaLeft', meta: true }), 'darwin')).toBeNull();
    expect(comboFromInput(key({ key: 'Shift', code: 'ShiftLeft', shift: true, control: true }), 'win32')).toBeNull();
    expect(comboFromInput(key({ key: 'Dead', code: 'Quote', alt: true }), 'darwin')).toBeNull();
  });

  it('round-trips: a recorded combination matches the key press that made it', () => {
    const press = key({ key: 'j', code: 'KeyJ', control: true, alt: true });
    const combo = comboFromInput(press, 'win32')!;
    expect(findShortcut(press, 'win32', undefined, { 'tab.new': [combo] })?.id).toBe('tab.new');
    expect(formatKeys(combo, 'win32')).toBe('Ctrl+Alt+J');
    expect(formatKeys('Mod+Alt+J', 'darwin')).toBe('⌥⌘J');
  });
});

describe('what can be a shortcut', () => {
  it('needs ⌘, ⌃ or ⌥ (or Ctrl/Alt), unless it is a function key', () => {
    expect(checkCombo('Mod+K', 'darwin')).toBeNull();
    expect(checkCombo('F7', 'win32')).toBeNull();
    expect(checkCombo('Shift+F7', 'linux')).toBeNull();
    expect(checkCombo('K', 'darwin')).toBe('Add ⌘, ⌃ or ⌥, so typing never sets it off.');
    expect(checkCombo('Shift+K', 'win32')).toBe('Add Ctrl or Alt, so typing never sets it off.');
  });

  it('refuses what each OS keeps for itself', () => {
    expect(checkCombo('Mod+Space', 'darwin')).toBe('macOS uses ⌘Space for Spotlight.');
    expect(checkCombo('Mod+Tab', 'darwin')).toBe('macOS uses ⌘Tab to switch apps.');
    expect(checkCombo('Mod+Alt+Escape', 'darwin')).toBe('macOS uses ⌥⌘Esc for Force Quit.');
    expect(checkCombo('Alt+Tab', 'win32')).toBe('Windows uses Alt+Tab to switch windows.');
    expect(checkCombo('Mod+Alt+Delete', 'win32')).toBe('Windows keeps Ctrl+Alt+Delete for itself.');
    expect(checkCombo('Meta+E', 'win32')).toBe('Windows keeps Windows-key shortcuts for itself.');
    expect(checkCombo('Meta+A', 'linux')).toBe('Your desktop keeps Super-key shortcuts for itself.');
    expect(checkCombo('Alt+F2', 'linux')).toBe('Your desktop uses Alt+F2 to run commands.');
    // Ctrl+Space is only kept on macOS (input sources).
    expect(checkCombo('Ctrl+Space', 'darwin')).not.toBeNull();
    expect(checkCombo('Mod+Space', 'win32')).toBeNull();
  });

  it('keeps text editing keys for text editing', () => {
    expect(checkCombo('Mod+C', 'darwin')).toBe('Chord keeps ⌘C for copying.');
    expect(checkCombo('Mod+V', 'win32')).toBe('Chord keeps Ctrl+V for pasting.');
    expect(checkCombo('Mod+Y', 'win32')).toBe('Chord keeps Ctrl+Y for redo.');
    // ⌘Y isn't redo on macOS (it's History there).
    expect(checkCombo('Mod+Y', 'darwin')).toBeNull();
  });

  it('refuses things that aren’t combinations at all', () => {
    expect(checkCombo('', 'darwin')).not.toBeNull();
    expect(checkCombo('Mod+Hyper+K', 'darwin')).not.toBeNull();
    expect(checkCombo('Mod+Mod+K', 'darwin')).not.toBeNull();
    expect(checkCombo('Mod+Control', 'darwin')).not.toBeNull();
  });
});

describe('your changes', () => {
  it('replace an action’s keys; actions you didn’t touch keep the registry’s', () => {
    const overrides = { 'tab.new': ['Mod+Alt+N'], 'view.find': [] };
    expect(keysFor(sc('tab.new'), 'darwin', overrides)).toEqual(['Mod+Alt+N']);
    expect(keysFor(sc('view.find'), 'darwin', overrides)).toEqual([]);
    expect(keysFor(sc('tab.close'), 'win32', overrides)).toEqual(['Mod+W', 'Mod+F4']);
    expect(keycapFor('tab.new', 'win32', overrides)).toBe('Ctrl+Alt+N');
    expect(keycapFor('view.find', 'darwin', overrides)).toBe('');
  });

  it('decide which shortcut a key press runs, and the old key stops working', () => {
    const overrides = { 'tab.new': ['Mod+Alt+N'] };
    const old = key({ key: 't', code: 'KeyT', meta: true });
    const fresh = key({ key: 'n', code: 'KeyN', meta: true, alt: true });
    expect(findShortcut(old, 'darwin', 'reserved', overrides)).toBeUndefined();
    expect(findShortcut(fresh, 'darwin', 'reserved', overrides)?.id).toBe('tab.new');
    // The action keeps its routing class: tab.new stays reserved.
    expect(findShortcut(fresh, 'darwin', 'page-first', overrides)).toBeUndefined();
  });

  it('find the action already using a key, with your changes counted', () => {
    expect(shortcutUsing('Mod+T', 'darwin', {})?.id).toBe('tab.new');
    expect(shortcutUsing('Ctrl+T', 'win32', {})?.id).toBe('tab.new');
    expect(shortcutUsing('Mod+T', 'darwin', { 'tab.new': ['Mod+Alt+N'] })).toBeUndefined();
    expect(shortcutUsing('Mod+T', 'darwin', {}, 'tab.new')).toBeUndefined();
    expect(shortcutUsing('Mod+Alt+N', 'darwin', { 'tab.new': ['Mod+Alt+N'] }, 'view.find')?.id).toBe('tab.new');
  });

  it('go back to the registry (no override) when they match it again', () => {
    expect(overrideFor('tab.close', ['Mod+W', 'Mod+F4'], 'win32')).toBeNull();
    expect(overrideFor('tab.close', ['Mod+W'], 'win32')).toEqual(['Mod+W']);
    expect(overrideFor('tab.close', ['Mod+W'], 'darwin')).toBeNull();
  });
});

describe('saved changes', () => {
  it('are cleaned on restore: unknown actions and unusable keys go, defaults always stay', () => {
    const cleaned = cleanOverrides(
      {
        'tab.new': ['Mod+Alt+N', 'K', 'Mod+Alt+N', 'Mod+Space'],
        'nav.stop': ['Escape', 'Mod+.'],
        'no.such.action': ['Mod+J'],
        'view.find': 'Mod+F',
      },
      'darwin',
    );
    // K needs a modifier, the repeat goes, and ⌘Space is Spotlight's.
    expect(cleaned['tab.new']).toEqual(['Mod+Alt+N']);
    // Esc is Stop loading's own key, so it stays even though you couldn't record it.
    expect(cleaned['nav.stop']).toEqual(['Escape', 'Mod+.']);
    expect(Object.keys(cleaned)).toEqual(['tab.new', 'nav.stop']);
  });

  it('come back after a relaunch through restoreState', () => {
    const seed = { now: 1, newId: (() => { let n = 0; return () => `id-${++n}`; })(), theme: { stops: [{ l: 0.72, c: 0.1, h: 200 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'https://home.test/', platform: 'win32' as const };
    const state = restoreState({ chords: [], nodes: [], windows: [], settings: { shortcuts: { 'tab.new': ['Mod+Alt+N'], 'tab.close': ['Meta+W'] } } }, seed);
    expect(state.settings.shortcuts).toEqual({ 'tab.new': ['Mod+Alt+N'], 'tab.close': [] });
  });

  it('change through settings.set: a list replaces, null goes back to the registry', () => {
    const ctx = { now: 1, newId: () => 'x' };
    let state = apply(emptyState(), { t: 'settings.set', settings: { shortcuts: { 'tab.new': ['Mod+Alt+N', 'J'], 'view.find': [] } } }, ctx).state;
    // J alone can't be a shortcut, so it's dropped even if a renderer sent it.
    expect(state.settings.shortcuts).toEqual({ 'tab.new': ['Mod+Alt+N'], 'view.find': [] });
    state = apply(state, { t: 'settings.set', settings: { shortcuts: { 'tab.new': null } } }, ctx).state;
    expect(state.settings.shortcuts).toEqual({ 'view.find': [] });
  });
});
