import { emptyState, type Command, type State } from '@chord/core';
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { SiteZoom, zoomHost } from '../../src/main/site-zoom';

/** Just enough of a page for SiteZoom: an address, a zoom factor, and its events. */
function fakePage(url: string) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let factor = 1;
  const page = {
    url,
    isDestroyed: () => false,
    getURL: () => page.url,
    getZoomFactor: () => factor,
    setZoomFactor: (f: number) => {
      factor = f;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.({}, ...args),
  };
  return page;
}

function setUp(isPrivate = false) {
  const box: { state: State; sent: Command[] } = { state: emptyState(), sent: [] };
  const zoom = new SiteZoom({
    state: () => box.state,
    dispatch: (command) => {
      box.sent.push(command);
      if (command.t === 'zoom.set') box.state = { ...box.state, siteZoom: { ...box.state.siteZoom, [command.host]: command.factor } };
    },
    isPrivate: () => isPrivate,
  });
  return { box, zoom };
}

describe('zoomHost', () => {
  it('is the host (with its port) of web pages only', () => {
    expect(zoomHost('https://a.test/x?y')).toBe('a.test');
    expect(zoomHost('http://127.0.0.1:8080/')).toBe('127.0.0.1:8080');
    expect(zoomHost('chord://archive')).toBeNull();
    expect(zoomHost('file:///C:/a.html')).toBeNull();
  });
});

describe('SiteZoom', () => {
  it('remembers a step for the site, and ⌘0 sets it back', () => {
    const { box, zoom } = setUp();
    const page = fakePage('https://a.test/');
    zoom.step(page as unknown as WebContents, 1);
    expect(page.getZoomFactor()).toBeCloseTo(1.1);
    expect(box.sent).toEqual([{ t: 'zoom.set', host: 'a.test', factor: page.getZoomFactor() }]);
    zoom.reset(page as unknown as WebContents);
    expect(box.sent.at(-1)).toEqual({ t: 'zoom.set', host: 'a.test', factor: 1 });
  });

  it('applies the saved zoom when a page arrives at the site, and zooms on the wheel', () => {
    const { box, zoom } = setUp();
    box.state = { ...box.state, siteZoom: { 'a.test': 1.5 } };
    const page = fakePage('https://a.test/');
    zoom.attach(page as unknown as WebContents);
    page.emit('did-navigate', 'https://a.test/');
    expect(page.getZoomFactor()).toBe(1.5);
    // Another site without a saved zoom is at 100%.
    page.url = 'https://b.test/';
    page.emit('did-navigate', 'https://b.test/');
    expect(page.getZoomFactor()).toBe(1);
    page.emit('zoom-changed', 'in');
    expect(page.getZoomFactor()).toBeCloseTo(1.1);
  });

  it('in a private window: uses what you saved, but saves nothing', () => {
    const { box, zoom } = setUp(true);
    box.state = { ...box.state, siteZoom: { 'a.test': 1.25 } };
    const page = fakePage('https://a.test/');
    zoom.attach(page as unknown as WebContents);
    page.emit('did-navigate', 'https://a.test/');
    expect(page.getZoomFactor()).toBe(1.25);
    zoom.step(page as unknown as WebContents, 1);
    expect(box.sent).toEqual([]);
    // Its own zoom on a site you never zoomed stays as it chose.
    page.url = 'https://b.test/';
    page.setZoomFactor(1.5);
    page.emit('did-navigate', 'https://b.test/');
    expect(page.getZoomFactor()).toBe(1.5);
  });
});
