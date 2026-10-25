/**
 * Screenshots (DESIGN.md §7.12, ARCHITECTURE.md §9). ⌘⇧2 opens the overlay's
 * capture mode over the page; it asks here what's under the pointer and what
 * to take. Every kind is taken by Chromium through the DevTools protocol
 * (`Page.captureScreenshot`), which pictures only the page's own surface (so
 * the overlay's highlight is never in it), clips in the page's CSS pixels
 * (page zoom included), reaches past the screen for a tall element or the
 * whole page, and hands back a PNG made outside main. The clipboard takes the
 * PNG as it is (Electron's `clipboard.write`), so main never decodes it.
 *
 * A capture is on the clipboard at once (Screenboard's rule), with a toast
 * whose Save puts it in Downloads. The recent ones are kept for the downloads
 * panel: on disk for a normal window, in memory for a private one, and not
 * at all with "Keep recent screenshots" off.
 */
import { captureScale, effectsHost, intersectRect, MIN_AREA, pageToUi, screenshotFilename, uiToPage, type ScreenshotEntry, type ScreenshotKind, type ShotRect } from '@chord/core';
import type { CaptureHit, ScreenshotChoice, ScreenshotItem } from '@chord/ipc';
import { clipboard, ClipboardItem, type WebContents } from 'electron';
import { pageCall } from '../page-call';
import type { AppWindow } from '../window';
import { FORGET_SCRIPT, hitScript, PICKED_SCRIPT, SHOT_WORLD, stepScript } from './scripts';
import { MemoryShots, newShotId, type ShotStore } from './store';

/** The thumbnail's width in the downloads panel's list, in image pixels. */
const THUMB_WIDTH = 240;
/** The longest side of the picture Duet is sent: what Claude reads best (larger is scaled down anyway). */
const ASK_SIDE = 1568;
/** How long a hover's answer may take: a hung page just shows no highlight. */
const HIT_MS = 500;
/** How long a capture may take before it's given up on (a whole long page takes a moment). */
const CAPTURE_MS = 15_000;

/** What the page's isolated world says about the picked element (scripts.ts). */
interface Picked {
  rect: ShotRect;
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
  label: string;
}

/** On the clipboard as a PNG, as the page's own pictures are copied. */
const copyPng = (png: Buffer): Promise<boolean> =>
  clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]).then(
    () => true,
    () => false,
  );

const isPicked = (value: unknown): value is Picked => {
  const p = value as Picked | null;
  return typeof p === 'object' && p !== null && typeof p.label === 'string' && [p.rect?.x, p.rect?.y, p.rect?.width, p.rect?.height, p.scroll?.x, p.scroll?.y].every((n) => typeof n === 'number' && Number.isFinite(n));
};

interface Capturing {
  contents: WebContents;
  /** Where the page is, in UI units. */
  pane: ShotRect;
  /** Picking elements to hide for Effects (main/effects) instead: nothing is taken. */
  hide: boolean;
}

interface Metrics {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssContentSize: { width: number; height: number };
}

export interface ScreenshotDeps {
  /** The interface size (UI units to the views' pixels). */
  uiScale(): number;
  /** "Keep recent screenshots". */
  keep(): boolean;
  /** Normal windows' recent screenshots, on disk. */
  disk: ShotStore;
  /** Into Downloads, listed as a finished download (a private window's only there). */
  saveFile(filename: string, bytes: Uint8Array, url: string, privateWindow: string | null): Promise<void>;
  /** Whether Duet may be asked about a screenshot of this page in this window (set up, may read the page). */
  duetReady(w: AppWindow, url: string): boolean;
  /** Put the picture in the window's Duet composer, and open the panel. */
  askDuet(windowId: string, image: { mime: 'image/jpeg'; width: number; height: number; bytes: Uint8Array; thumb: Uint8Array }): void;
}

export class Screenshots {
  private readonly capturing = new Map<string, Capturing>();
  /** Private windows' recent screenshots, gone with the window. */
  private readonly memory = new Map<string, MemoryShots>();
  /** Each window's last screenshot, so its toast's Save works even when none are kept. */
  private readonly last = new Map<string, { entry: ScreenshotEntry; png: Buffer; thumb: Buffer; ask: Buffer | null }>();
  /** A screenshot still being written, per window: the recent list waits for it, so the one just taken is in it. */
  private readonly saving = new Map<string, Promise<void>>();

  constructor(private readonly deps: ScreenshotDeps) {}

  /**
   * ⌘⇧2: capture mode over the page the window shows, or a word that there's
   * nothing to take. With `hide`, the same picker for Effects (DESIGN.md §7.15):
   * clicks hide elements on that site instead, so only a page on it will do.
   */
  start(w: AppWindow, hide?: { host: string }): boolean {
    const target = w.captureTarget();
    if (!target || (hide && effectsHost(target.contents.getURL()) !== hide.host)) {
      if (!hide) w.toast({ id: 'screenshot', whilePresenting: true, message: 'There’s no page here to take a screenshot of' });
      return false;
    }
    this.capturing.set(w.id, { contents: target.contents, pane: target.rect, hide: Boolean(hide) });
    w.openOverlay('capture', '', null, 'page', undefined, { pane: target.rect, ...(hide ? { hide } : {}) });
    return true;
  }

  /** The page the picker is over, while it picks elements to hide. */
  pickerPage(w: AppWindow): WebContents | null {
    const c = this.live(w);
    return c?.hide ? c.contents : null;
  }

  /** Capture mode closed without taking anything. */
  cancel(w: AppWindow): void {
    const c = this.capturing.get(w.id);
    this.capturing.delete(w.id);
    if (c && !c.contents.isDestroyed()) void pageCall(c.contents.executeJavaScriptInIsolatedWorld(SHOT_WORLD, [{ code: FORGET_SCRIPT }]), null);
  }

  /** The element under the pointer (UI units), or null over the page itself, outside it, or when the page doesn't answer in time. */
  async hover(w: AppWindow, x: number, y: number): Promise<CaptureHit | null> {
    const c = this.live(w);
    if (!c || x < c.pane.x || y < c.pane.y || x > c.pane.x + c.pane.width || y > c.pane.y + c.pane.height) return null;
    const at = uiToPage({ x, y, width: 0, height: 0 }, c.pane, this.deps.uiScale(), c.contents.getZoomFactor());
    return this.hit(c, await pageCall(c.contents.executeJavaScriptInIsolatedWorld(SHOT_WORLD, [{ code: hitScript(at.x, at.y) }]), null, HIT_MS));
  }

  /** ↑ and ↓: the picked element's parent or first child. */
  async step(w: AppWindow, to: 'parent' | 'child'): Promise<CaptureHit | null> {
    const c = this.live(w);
    if (!c) return null;
    return this.hit(c, await pageCall(c.contents.executeJavaScriptInIsolatedWorld(SHOT_WORLD, [{ code: stepScript(to) }]), null, HIT_MS));
  }

  /** The wheel, passed on to the page, so you can scroll to what you want while choosing. */
  scroll(w: AppWindow, x: number, y: number, deltaX: number, deltaY: number): void {
    const c = this.live(w);
    if (!c) return;
    const k = this.deps.uiScale();
    // Chromium's wheel deltas point the other way from the DOM's.
    c.contents.sendInputEvent({ type: 'mouseWheel', x: Math.round((x - c.pane.x) * k), y: Math.round((y - c.pane.y) * k), deltaX: -deltaX, deltaY: -deltaY, canScroll: true });
  }

  /** Take it: the overlay closes at once, the picture goes to the clipboard, and a toast offers Save. */
  async take(w: AppWindow, choice: ScreenshotChoice): Promise<void> {
    const c = this.live(w);
    // Picking for Effects takes nothing.
    if (c?.hide) return;
    this.capturing.delete(w.id);
    w.closeOverlay();
    if (!c) return;
    let shot: { png: Buffer; thumb: Buffer; ask: Buffer | null; width: number; height: number } | null = null;
    try {
      shot = await this.capture(c, choice);
    } catch (error) {
      console.warn('[chord] Screenshot failed:', error instanceof Error ? error.message : error);
    }
    void pageCall(c.contents.executeJavaScriptInIsolatedWorld(SHOT_WORLD, [{ code: FORGET_SCRIPT }]), null);
    if (!shot) {
      w.toast({ id: 'screenshot', whilePresenting: true, message: 'Couldn’t take the screenshot' });
      return;
    }
    const entry: ScreenshotEntry = {
      id: newShotId(),
      kind: choice.kind satisfies ScreenshotKind,
      createdAt: Date.now(),
      width: shot.width,
      height: shot.height,
      bytes: shot.png.byteLength + shot.thumb.byteLength + (shot.ask?.byteLength ?? 0),
      title: c.contents.getTitle().slice(0, 300),
      url: c.contents.getURL().slice(0, 2048),
    };
    const copied = await copyPng(shot.png);
    this.last.set(w.id, { entry, png: shot.png, thumb: shot.thumb, ask: shot.ask });
    if (this.deps.keep()) {
      const saving = this.store(w).add(entry, shot.png, shot.thumb, shot.ask ?? undefined);
      this.saving.set(w.id, saving);
      await saving.finally(() => this.saving.get(w.id) === saving && this.saving.delete(w.id));
    }
    // Saved either way: if the clipboard said no, Save is how to keep it.
    w.toast({
      id: 'screenshot',
      // It answers what you just did, and shows nothing private: presenting doesn't hide it.
      whilePresenting: true,
      message: copied ? 'Screenshot copied' : 'Screenshot taken, but couldn’t be copied',
      action: { label: 'Save', screenshot: { id: entry.id, do: 'save' } },
      ...(shot.ask && this.deps.duetReady(w, entry.url) ? { secondary: { label: 'Ask Duet', screenshot: { id: entry.id, do: 'duet' as const } } } : {}),
    });
  }

  /** The window's recent screenshots, newest first, with thumbnails. */
  async list(w: AppWindow): Promise<ScreenshotItem[]> {
    if (!this.deps.keep()) return [];
    await this.saving.get(w.id)?.catch(() => undefined);
    const store = this.store(w);
    return Promise.all(
      (await store.list()).map(async (entry) => {
        const thumb = await store.thumb(entry.id);
        return { ...entry, thumb: thumb ? `data:image/jpeg;base64,${thumb.toString('base64')}` : null, duet: this.deps.duetReady(w, entry.url) };
      }),
    );
  }

  /** Copy, save or delete one: the window's own (a private window never reaches a normal one's, nor the other way). */
  async act(w: AppWindow, id: string, action: 'copy' | 'save' | 'delete' | 'duet'): Promise<void> {
    const store = this.store(w);
    if (action === 'delete') {
      await store.remove(id);
      return;
    }
    const last = this.last.get(w.id);
    const entry = last?.entry.id === id ? last.entry : (await store.list()).find((e) => e.id === id);
    const png = last?.entry.id === id ? last.png : await store.png(id);
    if (!entry || !png) return;
    if (action === 'duet') {
      const ask = last?.entry.id === id ? last.ask : await store.ask(id);
      const thumb = last?.entry.id === id ? last.thumb : await store.thumb(id);
      if (!ask || !thumb || !this.deps.duetReady(w, entry.url)) return;
      const k = Math.min(1, ASK_SIDE / Math.max(entry.width, entry.height));
      this.deps.askDuet(w.id, { mime: 'image/jpeg', width: Math.round(entry.width * k), height: Math.round(entry.height * k), bytes: ask, thumb });
      return;
    }
    if (action === 'copy') {
      w.toast({ id: 'screenshot', whilePresenting: true, message: (await copyPng(png)) ? 'Screenshot copied' : 'Couldn’t copy the screenshot' });
      return;
    }
    await this.deps.saveFile(screenshotFilename(new Date(entry.createdAt)), png, entry.url, w.isPrivate ? w.id : null);
    w.toast({ id: 'screenshot', whilePresenting: true, message: 'Screenshot saved to Downloads' });
  }

  async clear(w: AppWindow): Promise<void> {
    await this.store(w).clear();
  }

  /** "Keep recent screenshots" turned off: every kept one goes. */
  async forgetAll(): Promise<void> {
    await this.deps.disk.clear();
    for (const store of this.memory.values()) await store.clear();
  }

  /** A window closed: a private one's screenshots go with it. */
  windowClosed(windowId: string): void {
    this.capturing.delete(windowId);
    this.memory.delete(windowId);
    this.last.delete(windowId);
  }

  private store(w: AppWindow): ShotStore {
    if (!w.isPrivate) return this.deps.disk;
    let store = this.memory.get(w.id);
    if (!store) this.memory.set(w.id, (store = new MemoryShots()));
    return store;
  }

  private live(w: AppWindow): Capturing | null {
    const c = this.capturing.get(w.id);
    return c && !c.contents.isDestroyed() ? c : null;
  }

  /** What the page said, where it shows on screen: cut to the pane, or null when none of it is in view. */
  private hit(c: Capturing, picked: unknown): CaptureHit | null {
    if (!isPicked(picked)) return null;
    const ui = pageToUi(picked.rect, c.pane, this.deps.uiScale(), c.contents.getZoomFactor());
    const shown = intersectRect(ui, c.pane);
    if (shown.width < 1 || shown.height < 1) return null;
    return { rect: shown, label: picked.label, width: Math.round(picked.rect.width), height: Math.round(picked.rect.height) };
  }

  /** The region to take, in the page's CSS pixels from the top of the document. */
  private async region(c: Capturing, choice: ScreenshotChoice, metrics: Metrics): Promise<ShotRect | null> {
    const view = metrics.cssVisualViewport;
    const onScreen = { x: 0, y: 0, width: view.clientWidth, height: view.clientHeight };
    const fromTop = (r: ShotRect): ShotRect => ({ x: r.x + view.pageX, y: r.y + view.pageY, width: r.width, height: r.height });
    switch (choice.kind) {
      case 'visible':
        return fromTop(onScreen);
      case 'page':
        return { x: 0, y: 0, width: Math.max(view.clientWidth, metrics.cssContentSize.width), height: Math.max(view.clientHeight, metrics.cssContentSize.height) };
      case 'area': {
        const r = intersectRect(uiToPage(choice.rect, c.pane, this.deps.uiScale(), c.contents.getZoomFactor()), onScreen);
        const minimum = MIN_AREA / 2;
        return r.width >= minimum && r.height >= minimum ? fromTop(r) : null;
      }
      case 'element': {
        const picked: unknown = await pageCall(c.contents.executeJavaScriptInIsolatedWorld(SHOT_WORLD, [{ code: PICKED_SCRIPT }]), null, HIT_MS);
        if (!isPicked(picked)) return null;
        // The whole element, past the screen if it goes on: from where it is in the document.
        const r = { x: picked.rect.x + picked.scroll.x, y: picked.rect.y + picked.scroll.y, width: picked.rect.width, height: picked.rect.height };
        return intersectRect(r, { x: 0, y: 0, width: Math.max(metrics.cssContentSize.width, view.clientWidth), height: Math.max(metrics.cssContentSize.height, view.clientHeight) });
      }
    }
  }

  private async capture(c: Capturing, choice: ScreenshotChoice): Promise<{ png: Buffer; thumb: Buffer; ask: Buffer | null; width: number; height: number } | null> {
    const debug = c.contents.debugger;
    const mine = !debug.isAttached();
    if (mine) debug.attach('1.3');
    try {
      const send = <T>(method: string, params?: object) => pageCall(debug.sendCommand(method, params) as Promise<T>, null, CAPTURE_MS);
      const metrics = await send<Metrics>('Page.getLayoutMetrics');
      if (!metrics) return null;
      const region = await this.region(c, choice, metrics);
      if (!region || region.width < 1 || region.height < 1) return null;
      // The protocol clips in the view's own pixels: the page's CSS pixels times its zoom. The page's
      // devicePixelRatio is the screen's scale times that zoom.
      const zoom = c.contents.getZoomFactor();
      const pageRatio = Number(await pageCall(c.contents.executeJavaScriptInIsolatedWorld(SHOT_WORLD, [{ code: 'devicePixelRatio' }]), zoom)) || zoom;
      const screen = pageRatio / zoom;
      const clip = { x: region.x * zoom, y: region.y * zoom, width: region.width * zoom, height: region.height * zoom };
      const scale = captureScale(clip.width, clip.height, screen) / screen;
      const shot = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale } });
      if (!shot?.data) return null;
      const png = Buffer.from(shot.data, 'base64');
      // The thumbnail: its top, at most 16:10, small and as a JPEG, made by Chromium too.
      const top = { ...clip, height: Math.min(clip.height, clip.width * 0.625) };
      const small = await send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: true, clip: { ...top, scale: Math.min(1, THUMB_WIDTH / (clip.width * screen)) } });
      // What Duet is sent, if you ask it: the whole picture, at most 1,568 px a side.
      const sized = await send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: true, clip: { ...clip, scale: Math.min(scale, ASK_SIDE / (Math.max(clip.width, clip.height) * screen)) } });
      return { png, thumb: Buffer.from(small?.data ?? '', 'base64'), ask: sized?.data ? Buffer.from(sized.data, 'base64') : null, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    } finally {
      if (mine && debug.isAttached()) debug.detach();
    }
  }
}
