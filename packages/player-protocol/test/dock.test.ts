import { describe, expect, it } from 'vitest';
import { MAX_STILL_CHARS, mayBeShortcut, parseBounds, parseDock, parseHandle, parseKey, parseStill, roundedShape, type KeyReport } from '../src/messages.ts';

describe('docking messages (Chord Player in the tab)', () => {
  it('takes only sane on-screen rectangles', () => {
    expect(parseBounds({ x: -1920, y: 0, width: 1280, height: 720 })).toEqual({ x: -1920, y: 0, width: 1280, height: 720 });
    for (const bad of [null, 'x', { x: 0, y: 0, width: 0, height: 10 }, { x: 0.5, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 200_000 }, { x: 0, y: 0, width: '10', height: 10 }]) {
      expect(parseBounds(bad)).toBeNull();
    }
  });

  it('reads a dock: bounds or hidden, a still first, and the corners', () => {
    expect(parseDock({ bounds: { x: 10, y: 20, width: 300, height: 200 }, still: false, radius: 8 })).toEqual({ bounds: { x: 10, y: 20, width: 300, height: 200 }, still: false, radius: 8 });
    expect(parseDock({ bounds: null, still: true })).toEqual({ bounds: null, still: true, radius: 0 });
    // A malformed rectangle isn't "hidden": the message is refused.
    expect(parseDock({ bounds: { x: 0 }, still: false })).toBeNull();
    expect(parseDock({ bounds: null, radius: 900 })?.radius).toBe(0);
  });

  it('takes window handles as decimal strings only', () => {
    expect(parseHandle('132456')).toBe('132456');
    expect(parseHandle('18446744073709551615')).toBe('18446744073709551615');
    for (const bad of ['0', '-5', '12a', '', 12, '123456789012345678901']) expect(parseHandle(bad)).toBeNull();
  });

  it('takes still pictures as JPEG data URLs within the limit', () => {
    expect(parseStill('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
    expect(parseStill('data:image/png;base64,AAAA')).toBeNull();
    expect(parseStill('data:image/jpeg;base64,AA"><script>')).toBeNull();
    expect(parseStill(`data:image/jpeg;base64,${'A'.repeat(MAX_STILL_CHARS)}`)).toBeNull();
  });

  it('forwards keys that may be shortcuts, and Ctrl’s release', () => {
    const key = (k: Partial<KeyReport>): KeyReport => ({ type: 'keyDown', key: 'a', code: 'KeyA', control: false, shift: false, alt: false, meta: false, ...k });
    expect(mayBeShortcut(key({ key: 't', control: true }))).toBe(true);
    expect(mayBeShortcut(key({ key: 'ArrowLeft', alt: true }))).toBe(true);
    expect(mayBeShortcut(key({ key: 'F11' }))).toBe(true);
    expect(mayBeShortcut(key({ key: 'Control', type: 'keyUp' }))).toBe(true);
    // Typing, and space or arrows for the video, stay the page's alone.
    expect(mayBeShortcut(key({ key: 'a' }))).toBe(false);
    expect(mayBeShortcut(key({ key: ' ', code: 'Space' }))).toBe(false);
    expect(mayBeShortcut(key({ key: 'A', shift: true }))).toBe(false);
    expect(mayBeShortcut(key({ key: 't', type: 'keyUp' }))).toBe(false);
    expect(parseKey({ type: 'keyDown', key: 't', code: 'KeyT', control: true, extra: 1 })).toEqual(key({ key: 't', code: 'KeyT', control: true }));
    expect(parseKey({ type: 'char', key: 't', code: 'KeyT' })).toBeNull();
    expect(parseKey({ type: 'keyDown', key: '', code: '' })).toBeNull();
  });

  it('rounds a window’s corners with rectangles that cover it exactly once', () => {
    const [w, h, r] = [40, 30, 8];
    const shape = roundedShape(w, h, r);
    const covered = new Map<string, number>();
    for (const rect of shape) for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) covered.set(`${x},${y}`, (covered.get(`${x},${y}`) ?? 0) + 1);
    expect([...covered.values()].every((n) => n === 1)).toBe(true);
    // The middle is whole, the corners are cut, symmetrically.
    expect(covered.has(`${w / 2},${h / 2}`)).toBe(true);
    for (const corner of ['0,0', `${w - 1},0`, `0,${h - 1}`, `${w - 1},${h - 1}`]) expect(covered.has(corner)).toBe(false);
    expect(covered.has(`${r},0`)).toBe(true);
    expect(covered.has(`0,${r}`)).toBe(true);
    // Rows of the same width are merged: a few rectangles, not one per row.
    expect(shape.length).toBeLessThan(2 * r + 1);
  });

  it('leaves a plain rectangle without a radius', () => {
    expect(roundedShape(100, 50, 0)).toEqual([{ x: 0, y: 0, width: 100, height: 50 }]);
    // Never more than half the window.
    expect(roundedShape(6, 6, 20).every((rect) => rect.width > 0 && rect.height > 0)).toBe(true);
  });
});
