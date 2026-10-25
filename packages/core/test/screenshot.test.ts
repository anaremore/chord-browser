import { describe, expect, it } from 'vitest';
import { captureScale, intersectRect, pageToUi, rectFromPoints, SCREENSHOT_LIMITS, screenshotFilename, screenshotsToForget, uiToPage } from '../src/screenshot';

describe('screenshot geometry', () => {
  it('a drag in any direction spans the same rectangle', () => {
    for (const [a, b] of [
      [{ x: 10, y: 20 }, { x: 110, y: 70 }],
      [{ x: 110, y: 70 }, { x: 10, y: 20 }],
      [{ x: 110, y: 20 }, { x: 10, y: 70 }],
      [{ x: 10, y: 70 }, { x: 110, y: 20 }],
    ] as const) {
      expect(rectFromPoints(a, b)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    }
  });

  it('keeps the part inside, or nothing', () => {
    expect(intersectRect({ x: -10, y: 5, width: 50, height: 50 }, { x: 0, y: 0, width: 30, height: 30 })).toEqual({ x: 0, y: 5, width: 30, height: 25 });
    expect(intersectRect({ x: 40, y: 40, width: 5, height: 5 }, { x: 0, y: 0, width: 30, height: 30 })).toMatchObject({ width: 0, height: 0 });
  });

  // Pane at (300, 40) in UI units; the page's CSS pixels depend on the interface size and the page's zoom.
  it.each([
    { uiScale: 1, zoom: 1, page: { x: 100, y: 50, width: 300, height: 200 } },
    { uiScale: 1, zoom: 1.5, page: { x: 100 / 1.5, y: 50 / 1.5, width: 200, height: 200 / 1.5 } },
    { uiScale: 1.25, zoom: 1, page: { x: 125, y: 62.5, width: 375, height: 250 } },
    { uiScale: 1.25, zoom: 2, page: { x: 62.5, y: 31.25, width: 187.5, height: 125 } },
  ])('UI to page and back (interface $uiScale, zoom $zoom)', ({ uiScale, zoom, page }) => {
    const pane = { x: 300, y: 40, width: 800, height: 600 };
    const ui = { x: 400, y: 90, width: 300, height: 200 };
    const p = uiToPage(ui, pane, uiScale, zoom);
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(p[key]).toBeCloseTo(page[key]);
    const back = pageToUi(p, pane, uiScale, zoom);
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(back[key]).toBeCloseTo(ui[key]);
  });
});

describe('captureScale', () => {
  it('captures at the screen’s own scale until a side or the pixel count would pass the limits', () => {
    expect(captureScale(1280, 800, 2)).toBe(2);
    // 1000 × 20,000 at 2x: 40,000 px tall, past the 16,384 side.
    expect(captureScale(1000, 20_000, 2)).toBeCloseTo(SCREENSHOT_LIMITS.side / 20_000);
    // 9000 × 9000 at 1x: within a side, past 64 Mi pixels.
    const s = captureScale(9000, 9000, 1);
    expect(9000 * s * 9000 * s).toBeLessThanOrEqual(SCREENSHOT_LIMITS.pixels + 1);
    expect(s).toBeLessThan(1);
    expect(captureScale(0, 100, 2)).toBe(2);
  });
});

describe('screenshotFilename', () => {
  it('is dated as macOS names them, without colons', () => {
    expect(screenshotFilename(new Date(2026, 9, 4, 8, 5, 9))).toBe('Screenshot 2026-10-04 at 08.05.09.png');
  });
});

describe('screenshotsToForget', () => {
  const entry = (id: string, createdAt: number, bytes: number) => ({ id, createdAt, bytes });
  it('lets the oldest go past the count, then past the room', () => {
    const entries = [entry('a', 1, 10), entry('b', 2, 10), entry('c', 3, 10), entry('d', 4, 10)];
    expect(screenshotsToForget(entries, { count: 3, bytes: 1000 })).toEqual(['a']);
    expect(screenshotsToForget(entries, { count: 10, bytes: 25 })).toEqual(['b', 'a']);
    // One too big for the room on its own goes, and smaller older ones may still fit.
    expect(screenshotsToForget([entry('big', 5, 100), ...entries], { count: 10, bytes: 50 })).toEqual(['big']);
  });
});
