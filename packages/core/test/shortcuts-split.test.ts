import { describe, expect, it } from 'vitest';
import { findShortcut, keycapFor, type KeyInput } from '../src';

const press = (input: Partial<KeyInput>): KeyInput => ({ type: 'keyDown', key: '', code: '', control: false, shift: false, alt: false, meta: false, ...input }) as KeyInput;

describe('split view keys', () => {
  it('Split with… is Mod+Shift+\\, by the key’s position', () => {
    expect(keycapFor('split.with', 'win32', {})).toBe('Ctrl+Shift+\\');
    expect(keycapFor('split.with', 'darwin', {})).toBe('⇧⌘\\');
    expect(findShortcut(press({ key: '|', code: 'Backslash', control: true, shift: true }), 'win32', 'reserved')?.id).toBe('split.with');
    expect(findShortcut(press({ key: '|', code: 'Backslash', meta: true, shift: true }), 'darwin', 'reserved')?.id).toBe('split.with');
  });

  it('AltGr letters stay typeable (no Ctrl+Alt+letter for split view)', () => {
    expect(findShortcut(press({ key: 'ś', code: 'KeyS', control: true, alt: true }), 'win32', 'reserved')).toBeUndefined();
  });

  it('⌘⌥[ / ⌘⌥] (Ctrl+Alt+[ / ]) move focus between panes', () => {
    expect(findShortcut(press({ key: '[', code: 'BracketLeft', control: true, alt: true }), 'win32', 'reserved')?.id).toBe('split.focusPrevious');
    expect(findShortcut(press({ key: '‘', code: 'BracketRight', meta: true, alt: true }), 'darwin', 'reserved')?.id).toBe('split.focusNext');
  });
});
