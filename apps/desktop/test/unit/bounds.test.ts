import { describe, expect, it } from 'vitest';
import { placeOnDisplays } from '../../src/main/bounds';

const laptop = { x: 0, y: 0, width: 1440, height: 860 };
const monitor = { x: 1440, y: -200, width: 2560, height: 1400 };
const saved = { x: 2000, y: 100, width: 1200, height: 800, maximized: false };

describe('placeOnDisplays', () => {
  it('keeps a window that is still on a display', () => {
    expect(placeOnDisplays(saved, [laptop, monitor])).toEqual(saved);
  });

  it('keeps a window that hangs off an edge but can still be grabbed', () => {
    const partly = { ...saved, x: -900 };
    expect(placeOnDisplays(partly, [laptop])).toEqual(partly);
  });

  it('brings back a window whose monitor is gone, centered and shrunk to fit', () => {
    expect(placeOnDisplays({ ...saved, width: 1600, height: 1000 }, [laptop])).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 860,
      maximized: false,
    });
    expect(placeOnDisplays(saved, [laptop])).toEqual({ ...saved, x: 120, y: 30 });
  });

  it('rescues a window whose title bar is above the top of every display', () => {
    expect(placeOnDisplays({ ...saved, x: 100, y: -790 }, [laptop]).y).toBe(30);
  });
});
