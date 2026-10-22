import { describe, expect, it } from 'vitest';
import { markdownLink, usableDataIcon, zoomStep } from '../src';

describe('zoomStep', () => {
  it('walks Chromium presets and stops at the ends', () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(zoomStep(5, 1)).toBe(5);
    expect(zoomStep(0.25, -1)).toBe(0.25);
  });

  it('snaps a factor between presets to the next one', () => {
    expect(zoomStep(1.2, 1)).toBe(1.25);
    expect(zoomStep(1.2, -1)).toBe(1.1);
  });
});

describe('markdownLink', () => {
  it('escapes brackets in the title and encodes parentheses in the URL', () => {
    expect(markdownLink('Chord [music]', 'https://en.wikipedia.org/wiki/Chord_(music)')).toBe(
      '[Chord \\[music\\]](https://en.wikipedia.org/wiki/Chord_%28music%29)',
    );
  });

  it('falls back to the URL when there is no title', () => {
    expect(markdownLink('  ', 'https://a.test/')).toBe('[https://a.test/](https://a.test/)');
  });
});

describe('usableDataIcon', () => {
  it('accepts small image data URLs', () => {
    expect(usableDataIcon('data:image/png;base64,iVBORw0KGgo=', 1024)).toBe(true);
    expect(usableDataIcon('data:image/svg+xml,%3Csvg%2F%3E', 1024)).toBe(true);
  });

  it('rejects "no icon" and non-image data URLs', () => {
    expect(usableDataIcon('data:,', 1024)).toBe(false);
    expect(usableDataIcon('data:image/png;base64,', 1024)).toBe(false);
    expect(usableDataIcon('data:text/html,<b>hi</b>', 1024)).toBe(false);
  });

  it('rejects icons over the size limit', () => {
    expect(usableDataIcon(`data:image/png;base64,${'A'.repeat(4000)}`, 1024)).toBe(false);
  });
});
