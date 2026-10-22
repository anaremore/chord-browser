import { describe, expect, it } from 'vitest';
import { SHORTCUTS, findShortcut, formatKeys, keysFor, type KeyInput, type Platform } from '../src';

const platforms: Platform[] = ['darwin', 'win32', 'linux'];

const key = (k: string, mods: Partial<KeyInput> = {}, code = ''): KeyInput => ({
  type: 'keyDown',
  key: k,
  code,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...mods,
});

describe('shortcut registry', () => {
  it.each(platforms)('has no duplicate keys on %s', (platform) => {
    const seen = new Map<string, string>();
    for (const shortcut of SHORTCUTS) {
      for (const keys of keysFor(shortcut, platform)) {
        const normalized = keys.replace(/^Mod\+/, platform === 'darwin' ? 'Meta+' : 'Ctrl+').replace('+Mod+', platform === 'darwin' ? '+Meta+' : '+Ctrl+');
        expect(seen.get(normalized), `${keys} is bound to both ${seen.get(normalized)} and ${shortcut.id}`).toBeUndefined();
        seen.set(normalized, shortcut.id);
      }
    }
  });

  it('has unique ids', () => {
    expect(new Set(SHORTCUTS.map((x) => x.id)).size).toBe(SHORTCUTS.length);
  });

  it('never reserves keys web apps depend on (DESIGN.md §14.1 rule 3)', () => {
    const appKeys = ['Mod+K', 'Mod+E', 'Mod+B', 'Mod+I', 'Mod+U', 'Mod+Enter', 'Mod+/'];
    for (const platform of platforms) {
      for (const shortcut of SHORTCUTS.filter((x) => x.kind === 'reserved')) {
        for (const keys of keysFor(shortcut, platform)) expect(appKeys).not.toContain(keys);
      }
    }
  });
});

describe('findShortcut', () => {
  it('maps ⌘L on macOS and Ctrl+L / Alt+D elsewhere', () => {
    expect(findShortcut(key('l', { meta: true }, 'KeyL'), 'darwin')?.id).toBe('address.edit');
    expect(findShortcut(key('l', { control: true }, 'KeyL'), 'win32')?.id).toBe('address.edit');
    expect(findShortcut(key('d', { alt: true }, 'KeyD'), 'linux')?.id).toBe('address.edit');
    expect(findShortcut(key('l', { control: true }, 'KeyL'), 'darwin')).toBeUndefined();
  });

  it('matches shifted letters and physical digits', () => {
    expect(findShortcut(key('T', { meta: true, shift: true }, 'KeyT'), 'darwin')?.id).toBe('tab.reopen');
    // AZERTY: Ctrl+1 reports key "&" but code "Digit1"
    expect(findShortcut(key('&', { control: true }, 'Digit1'), 'win32')?.id).toBe('chord.goto1');
  });

  it('distinguishes Ctrl+Tab from ⌘Tab on macOS', () => {
    expect(findShortcut(key('Tab', { control: true }, 'Tab'), 'darwin')?.id).toBe('tab.recentNext');
    expect(findShortcut(key('Tab', { meta: true }, 'Tab'), 'darwin')).toBeUndefined();
  });

  it('ignores key-up events and filters by kind', () => {
    expect(findShortcut({ ...key('t', { control: true }, 'KeyT'), type: 'keyUp' }, 'win32')).toBeUndefined();
    expect(findShortcut(key('s', { control: true }, 'KeyS'), 'win32', 'reserved')).toBeUndefined();
    expect(findShortcut(key('s', { control: true }, 'KeyS'), 'win32', 'page-first')?.id).toBe('view.toggleSidebar');
  });
});

describe('formatKeys', () => {
  it('uses symbols in Apple order on macOS and words elsewhere', () => {
    expect(formatKeys('Mod+Shift+T', 'darwin')).toBe('⇧⌘T');
    expect(formatKeys('Mod+Alt+ArrowDown', 'darwin')).toBe('⌥⌘↓');
    expect(formatKeys('Mod+Shift+T', 'win32')).toBe('Ctrl+Shift+T');
    expect(formatKeys('Ctrl+Mod+F', 'linux')).toBe('Ctrl+F');
  });
});
