/**
 * Effects in main (ARCHITECTURE.md §9, decision D13; DESIGN.md §7.15).
 *
 * - **Where they live.** By site (`effectsHost`: the host, `www.` folded, a
 *   port kept), in chord-data's `effect` table (migration 13), shared by every
 *   chord. Main holds each site's stylesheet as the sanitizer made it, so a
 *   navigation costs a map lookup and one `insertCSS`. A private window's
 *   changes are kept in memory for that window only, over the saved ones,
 *   and go with it.
 * - **Applying.** On each of a page's new documents (`did-navigate`), the
 *   site's one stylesheet goes in with `insertCSS`, every declaration
 *   `!important`: no script ever goes into a page. A change swaps it on the
 *   site's open pages: the new one in, then the old one out, so nothing
 *   flashes. It's an author-origin sheet: Electron's `removeInsertedCSS` takes
 *   only those out (it passes no origin to Blink, which assumes the author's),
 *   and a user-origin sheet would stay until its document went (seen in
 *   effects.spec.ts: Dry left the page styled).
 * - **Dry/Wet.** Each site has its own switch; Settings' switch makes every
 *   site dry at once. Dry keeps everything and applies nothing. A tab's
 *   `live.effects` says which, for the button beside the address.
 * - **Sanitizing.** Every change goes through the sanitizer in Effects' worker
 *   (compiler.ts) before anything of it is used; nothing is applied from a
 *   stylesheet an older sanitizer made until the new one has made it again.
 * - **Ask Duet.** Your Claude Code or Codex app writes a patch from the page's
 *   outline (scripts.ts), under Duet's reading rules: never a private window, a
 *   chord where Duet is off, a Never site, or a form field's value.
 */
import {
  cleanOutline,
  EFFECTS_LIMITS,
  EFFECTS_OUTLINE_TOOL,
  effectPreset,
  effectsHost,
  effectsInstructions,
  effectsSummary,
  effectsTurn,
  emptyEffects,
  hasEffects,
  outlineResult,
  parseEffectsAnswer,
  uuidv7,
  type DuetToolSpec,
  type EffectPresetId,
  type LiveTab,
  type NodeId,
  type SavedEffects,
  type SiteEffects,
  type WindowId,
} from '@chord/core';
import type { EffectsAction, EffectsSite, EffectsSiteChange, EffectsView, Toast } from '@chord/ipc';
import { randomBytes } from 'node:crypto';
import type { WebContents } from 'electron';
import { pageCall } from '../page-call';
import { SHOT_WORLD } from '../screenshots/scripts';
import { EffectsCompiler } from './compiler';
import type { Removal } from './sanitize';
import { SANITIZER_VERSION } from './sanitize';
import { EFFECTS_WORLD, OUTLINE_MS, OUTLINE_SCRIPT, SELECTOR_SCRIPT, type PageOutline, type PickedElement } from './scripts';

/** How long Duet may take to write a patch. */
const ASK_MS = 180_000;
/** Undo tokens kept for toasts. */
const MAX_UNDO = 30;

/** What Effects need of a window: who it is, its popover, its toasts. */
export interface EffectsWindow {
  readonly id: WindowId;
  readonly isPrivate: boolean;
  focusPopover(): void;
  focusRegion(to: 'page' | 'popover' | 'shell'): void;
  toast(toast: Toast): void;
}

export interface EffectsDeps {
  workerPath: string;
  /** Every saved site, as chord-data had them at launch. */
  saved: readonly SavedEffects[];
  /** Save a site, or (null) forget it. Never a private window's. */
  persist(host: string, site: SavedEffects | null): void;
  /** Settings' switch for every site. */
  everywhere(): boolean;
  setEverywhere(wet: boolean): void;
  /** The private window a page's session belongs to; null for a chord's. */
  privateWindowOf(contents: WebContents): WindowId | null;
  /** The tab a page belongs to, for its live state. */
  nodeFor(contents: WebContents): NodeId | undefined;
  /** A tab's `live.effects` (dispatched only when it differs). */
  setLive(nodeId: NodeId, effects: LiveTab['effects']): void;
  windows(): Iterable<EffectsWindow>;
  /** The tab in front in a window (the focused pane) and its page: what the card and the picker act on. Never Peek's page. */
  front(windowId: WindowId): { nodeId: NodeId; contents: WebContents; url: string } | null;
  /** The window's popover should show (or stop showing) the card. */
  popoverChanged(windowId: WindowId): void;
  /** Push the card's view to the window's popover. */
  sendView(windowId: WindowId, view: EffectsView | null): void;
  /** Start the picker over the window's page for this site; false when there's no page there. */
  startPicker(windowId: WindowId, host: string): boolean;
  /** The page the picker is over, while it picks for Effects. */
  pickerPage(windowId: WindowId): WebContents | null;
  /** Settings' list of sites changed. */
  settingsChanged(): void;
}

/** Ask Duet, as main's Duet offers it to Effects (duet/service.ts): set once Duet exists. */
export interface EffectsDuet {
  /** Whether Duet may read this page from this window, and the provider's name; null if not. */
  available(windowId: WindowId, url: string): { provider: string } | null;
  /** One request, no chat: its instructions, the user's turn, and the one tool. Resolves with the reply's text. */
  ask(request: { instructions: string; text: string; tool: DuetToolSpec; onTool(): Promise<string>; signal: AbortSignal; timeoutMs: number }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

interface Stored {
  site: SiteEffects;
  /** The stylesheet the sanitizer made, and which version of it. */
  compiled: string;
  sanitizer: number;
  /** What it left out of your CSS; null until it's been made this launch. */
  removed: Removal[] | null;
}

interface Page {
  contents: WebContents;
  url: string | null;
  host: string | null;
  /** The private window it's in, or null. */
  scope: WindowId | null;
  /** What's inserted in its document now, and the key to take it out. */
  css: string | null;
  key: string | null;
  seq: number;
}

interface Card {
  nodeId: NodeId;
  host: string;
  scope: WindowId | null;
  opened: number;
}

interface Ask {
  host: string;
  scope: WindowId | null;
  busy: boolean;
  startedAt: number | null;
  error: string | null;
  note: string | null;
  controller: AbortController | null;
}

interface Pick {
  host: string;
  scope: WindowId | null;
  hidden: number;
  before: SiteEffects | null;
  fromCard: boolean;
}

const scopeKey = (scope: WindowId | null, host: string) => `${scope ?? ''}|${host}`;
const clone = (site: SiteEffects): SiteEffects => structuredClone(site);

/** "url() on line 3, @import on line 1": what the card says Chord left out. */
export const removedText = (removed: readonly { what: string; line: number }[]): string => removed.map((r) => `${r.what} on line ${r.line}`).join(', ');

export class Effects {
  private readonly saved = new Map<string, Stored>();
  private readonly privates = new Map<WindowId, Map<string, Stored>>();
  private readonly pages = new Map<number, Page>();
  private readonly cards = new Map<WindowId, Card>();
  private readonly asks = new Map<WindowId, Ask>();
  private readonly picks = new Map<WindowId, Pick>();
  private readonly undos = new Map<string, { scope: WindowId | null; host: string; before: SiteEffects | null }>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly compiler: EffectsCompiler;
  private opened = 0;
  /** Set once Duet exists (index.ts). */
  duet: EffectsDuet | null = null;
  /** Main's part of applying a site's stylesheet to a page, in ms: finding it, and `insertCSS` answering (tests and the docs read it). */
  readonly timings: { lookup: number; insert: number; bytes: number }[] = [];

  constructor(private readonly deps: EffectsDeps) {
    this.compiler = new EffectsCompiler(deps.workerPath);
    const stale: string[] = [];
    for (const s of deps.saved) {
      const { compiled, sanitizer, ...site } = s;
      this.saved.set(site.host, { site, compiled, sanitizer, removed: null });
      if (sanitizer !== SANITIZER_VERSION) stale.push(site.host);
    }
    // Made by an older sanitizer: made again before any of it is used.
    for (const host of stale) void this.change(null, host, (site) => site);
  }

  /* ---------- Sites ---------- */

  private stored(scope: WindowId | null, host: string): Stored | undefined {
    return (scope ? this.privates.get(scope)?.get(host) : undefined) ?? this.saved.get(host);
  }

  /** The stylesheet a page should have now: none while dry, or until the current sanitizer made it. */
  private cssFor(page: Page): string | null {
    const st = page.host ? this.stored(page.scope, page.host) : undefined;
    if (!st || !st.compiled || st.sanitizer !== SANITIZER_VERSION || !st.site.wet || !this.deps.everywhere()) return null;
    return st.compiled;
  }

  private liveFor(scope: WindowId | null, host: string | null): LiveTab['effects'] {
    const st = host ? this.stored(scope, host) : undefined;
    if (!st || !hasEffects(st.site)) return null;
    return st.site.wet && this.deps.everywhere() ? 'wet' : 'dry';
  }

  /**
   * Change one site's Effects, one change at a time per site: `edit` gets a
   * copy of what's there now (or an empty site) and returns the new one, or
   * null to remove it. The result is sanitized before anything of it is used.
   * `undo` puts a toast in that window to take the change back.
   */
  private change(scope: WindowId | null, host: string, edit: (site: SiteEffects) => SiteEffects | null, undo?: { w: EffectsWindow; message: string }): Promise<void> {
    const key = scopeKey(scope, host);
    const run = async () => {
      const before = this.stored(scope, host);
      const next = edit(before ? clone(before.site) : emptyEffects(host, Date.now()));
      let stored: Stored | null = null;
      if (next && (hasEffects(next) || scope)) {
        let compiled = '';
        let removed: Removal[] = [];
        let sanitizer = SANITIZER_VERSION;
        if (hasEffects(next)) {
          try {
            const result = await this.compiler.compile({
              presets: next.presets.map((id) => effectPreset(id)?.css ?? ''),
              hidden: next.hidden.map((h) => h.selector),
              css: next.css,
              duet: next.duet.map((d) => d.css),
            });
            compiled = result.css;
            removed = result.removed;
          } catch (error) {
            // Nothing is applied that the sanitizer didn't make: the site waits for the next change, or the next launch.
            console.error('[chord] Effects couldn’t check a stylesheet:', error instanceof Error ? error.message : error);
            sanitizer = 0;
          }
        }
        stored = { site: next, compiled, sanitizer, removed };
      }
      if (scope) {
        // A private window keeps its own copy, an empty one too: what was saved doesn't show through it.
        let own = this.privates.get(scope);
        if (!own) this.privates.set(scope, (own = new Map()));
        own.set(host, stored ?? { site: emptyEffects(host, Date.now()), compiled: '', sanitizer: SANITIZER_VERSION, removed: [] });
      } else if (stored) {
        this.saved.set(host, stored);
        this.deps.persist(host, { ...stored.site, compiled: stored.compiled, sanitizer: stored.sanitizer });
      } else if (this.saved.delete(host)) {
        this.deps.persist(host, null);
      }
      if (undo) this.offerUndo(undo.w, scope, host, before?.site ?? null, undo.message);
      this.siteChanged(scope, host);
      if (!scope) this.deps.settingsChanged();
    };
    const chain = (this.chains.get(key) ?? Promise.resolve()).then(run, run);
    this.chains.set(key, chain);
    return chain;
  }

  private offerUndo(w: EffectsWindow, scope: WindowId | null, host: string, before: SiteEffects | null, message: string): void {
    const token = randomBytes(12).toString('hex');
    this.undos.set(token, { scope, host, before });
    while (this.undos.size > MAX_UNDO) this.undos.delete(this.undos.keys().next().value!);
    w.toast({ id: `effects:${host}`, message, action: { label: 'Undo', command: { t: 'effects.undo', token } } });
  }

  /** A toast's Undo: the site as it was before. */
  undo(token: string): Promise<void> {
    const u = this.undos.get(token);
    if (!u) return Promise.resolve();
    this.undos.delete(token);
    return this.change(u.scope, u.host, () => (u.before ? clone(u.before) : null));
  }

  /** A site changed: its open pages, tabs' buttons and cards follow. */
  private siteChanged(scope: WindowId | null, host: string): void {
    for (const page of this.pages.values()) {
      if (page.host !== host) continue;
      // A change to the saved site reaches private windows that have no copy of their own.
      if (scope ? page.scope !== scope : page.scope && this.privates.get(page.scope)?.has(host)) continue;
      void this.sync(page);
      this.reportLive(page);
    }
    for (const [windowId, card] of this.cards) if (card.host === host && (card.scope === scope || (!scope && !this.privates.get(card.scope ?? '')?.has(host)))) this.push(windowId);
  }

  /** Settings' switch for every site changed: every page follows. */
  everywhereChanged(): void {
    for (const page of this.pages.values()) {
      void this.sync(page);
      this.reportLive(page);
    }
    for (const windowId of this.cards.keys()) this.push(windowId);
  }

  /* ---------- Pages ---------- */

  /** Wire a page (a tab, Peek, a mini window, a popup): its site's stylesheet on each new document. */
  attachPage(contents: WebContents): void {
    const page: Page = { contents, url: null, host: null, scope: this.deps.privateWindowOf(contents), css: null, key: null, seq: 0 };
    this.pages.set(contents.id, page);
    contents.on('did-navigate', (_event, url) => {
      // A new document: whatever was inserted went with the old one.
      page.url = url;
      page.host = effectsHost(url);
      page.css = null;
      page.key = null;
      page.seq++;
      void this.sync(page);
      this.reportLive(page);
    });
    contents.once('destroyed', () => this.pages.delete(contents.id));
  }

  private reportLive(page: Page): void {
    const nodeId = this.deps.nodeFor(page.contents);
    if (nodeId) this.deps.setLive(nodeId, this.liveFor(page.scope, page.host));
  }

  /** Bring a page's document in line: the new stylesheet in, then the old one out. */
  private async sync(page: Page): Promise<void> {
    const { contents } = page;
    if (contents.isDestroyed()) return;
    const started = performance.now();
    const want = this.cssFor(page);
    if (want === page.css) return;
    const seq = ++page.seq;
    const url = page.url;
    const old = page.key;
    page.css = want;
    page.key = null;
    let key: string | null = null;
    const lookup = performance.now() - started;
    if (want) {
      // A hung renderer never answers: past pageCall's limit the page counts as without it (the next change tries again),
      // and a stylesheet that lands late after all is taken out again.
      const inserting = contents.insertCSS(want, { cssOrigin: 'author' });
      key = await pageCall(inserting, null);
      if (key === null) {
        if (page.seq === seq) page.css = null;
        void inserting
          .then(async (late) => {
            if (!contents.isDestroyed()) await contents.removeInsertedCSS(late);
          })
          .catch(() => undefined);
      }
      this.timings.push({ lookup, insert: performance.now() - started - lookup, bytes: want.length });
      if (this.timings.length > 50) this.timings.shift();
    }
    if (old && !contents.isDestroyed()) void contents.removeInsertedCSS(old).catch(() => {});
    if (page.seq !== seq || page.url !== url) {
      // Something newer happened meanwhile (another change, a navigation): this one goes, wherever it landed.
      if (key && !contents.isDestroyed()) void contents.removeInsertedCSS(key).catch(() => {});
      return;
    }
    page.key = key;
  }

  /** A private window closed: what it changed goes with it. */
  forgetWindow(windowId: WindowId): void {
    this.privates.delete(windowId);
    this.cards.delete(windowId);
    this.asks.get(windowId)?.controller?.abort();
    this.asks.delete(windowId);
    this.picks.delete(windowId);
  }

  /* ---------- The card (DESIGN.md §7.15) ---------- */

  private windowOf(windowId: WindowId): EffectsWindow | undefined {
    for (const w of this.deps.windows()) if (w.id === windowId) return w;
    return undefined;
  }

  /** The site in front in a window, if it's a website. */
  private frontSite(windowId: WindowId): { nodeId: NodeId; contents: WebContents; url: string; host: string } | null {
    const front = this.deps.front(windowId);
    const host = front ? effectsHost(front.url) : null;
    return front && host ? { ...front, host } : null;
  }

  /** Open the card for the site in front (the button, the menus, the command bar). */
  open(w: EffectsWindow): void {
    const front = this.frontSite(w.id);
    if (!front) {
      w.toast({ id: 'effects', message: 'Effects work on websites. There’s none on screen here.' });
      return;
    }
    const scope = w.isPrivate ? w.id : null;
    this.cards.set(w.id, { nodeId: front.nodeId, host: front.host, scope, opened: ++this.opened });
    this.deps.popoverChanged(w.id);
    w.focusPopover();
    // What was left out of your CSS is known once it's been made this launch.
    const st = this.stored(scope, front.host);
    if (st && st.removed === null && hasEffects(st.site)) void this.notes(st, w.id);
    else this.push(w.id);
  }

  /** What the sanitizer leaves out of a site's CSS, found again without changing anything. */
  private async notes(st: Stored, windowId: WindowId): Promise<void> {
    const result = await this.compiler.patch(st.site.css).catch(() => null);
    st.removed = result?.removed ?? [];
    this.push(windowId);
  }

  /** What the window's popover shows of the card: only while the tab it was opened for is in front, on that site. */
  cardFor(windowId: WindowId): { host: string; opened: number } | null {
    const card = this.cards.get(windowId);
    if (!card) return null;
    const front = this.frontSite(windowId);
    if (!front || front.nodeId !== card.nodeId || front.host !== card.host) {
      this.cards.delete(windowId);
      return null;
    }
    return { host: card.host, opened: card.opened };
  }

  view(windowId: WindowId): EffectsView | null {
    const card = this.cards.get(windowId);
    if (!card || !this.cardFor(windowId)) return null;
    const st = this.stored(card.scope, card.host);
    const site = st?.site ?? emptyEffects(card.host, 0);
    const front = this.frontSite(windowId);
    const available = front ? (this.duet?.available(windowId, front.url) ?? null) : null;
    const ask = this.asks.get(windowId);
    const mine = ask && ask.host === card.host && ask.scope === card.scope ? ask : null;
    return {
      host: card.host,
      wet: site.wet,
      everywhere: this.deps.everywhere(),
      css: site.css,
      removed: (st?.removed ?? []).map(({ what, line, kind }) => ({ what, line, kind })),
      hidden: site.hidden.map(({ selector, label }) => ({ selector, label })),
      presets: [...site.presets],
      duet: site.duet.map(({ id, ask, summary }) => ({ id, ask, summary })),
      ask: { available: available !== null, provider: available?.provider ?? null, busy: Boolean(mine?.busy), startedAt: mine?.startedAt ?? null, error: mine?.error ?? null, note: mine?.note ?? null },
      private: card.scope !== null,
    };
  }

  private push(windowId: WindowId): void {
    this.deps.sendView(windowId, this.view(windowId));
  }

  /** The card's changes, for its own site. */
  async act(w: EffectsWindow, action: EffectsAction): Promise<void> {
    const card = this.cards.get(w.id);
    if (!card || !this.cardFor(w.id)) return;
    const { scope, host } = card;
    const now = Date.now();
    switch (action.do) {
      case 'css':
        // The field has its own undo; a toast for each pause in typing would only be noise.
        return this.change(scope, host, (site) => ({ ...site, css: action.css, updatedAt: now }));
      case 'wet':
        return this.change(scope, host, (site) => ({ ...site, wet: action.wet, updatedAt: now }));
      case 'everywhere':
        this.deps.setEverywhere(action.wet);
        return;
      case 'preset':
        return this.change(scope, host, (site) => ({ ...site, presets: togglePreset(site.presets, action.id, action.on), updatedAt: now }));
      case 'unhide': {
        const label = this.stored(scope, host)?.site.hidden.find((h) => h.selector === action.selector)?.label ?? 'it';
        return this.change(scope, host, (site) => ({ ...site, hidden: site.hidden.filter((h) => h.selector !== action.selector), updatedAt: now }), { w, message: `Showing ${label} again` });
      }
      case 'removeDuet': {
        const patch = this.stored(scope, host)?.site.duet.find((d) => d.id === action.id);
        if (!patch) return;
        return this.change(scope, host, (site) => ({ ...site, duet: site.duet.filter((d) => d.id !== action.id), updatedAt: now }), { w, message: `Removed “${patch.summary || patch.ask}”` });
      }
      case 'clear':
        return this.change(scope, host, () => null, { w, message: `Removed the Effects on ${host}` });
      case 'pick':
        this.cards.delete(w.id);
        this.deps.popoverChanged(w.id);
        this.startPick(w, true);
        return;
      case 'ask':
        return this.ask(w, card, action.text);
      case 'stop':
        this.asks.get(w.id)?.controller?.abort();
        return;
      case 'close':
        this.cards.delete(w.id);
        this.deps.popoverChanged(w.id);
        w.focusRegion('page');
        return;
    }
  }

  /* ---------- Keys, menus and the command bar ---------- */

  /** ⌘⇧E: the site in front dry or wet. A site without Effects opens the card instead. */
  toggleSite(w: EffectsWindow): void {
    const front = this.frontSite(w.id);
    const scope = w.isPrivate ? w.id : null;
    const st = front ? this.stored(scope, front.host) : undefined;
    if (!front || !st || !hasEffects(st.site)) return this.open(w);
    const wet = !st.site.wet;
    void this.change(scope, front.host, (site) => ({ ...site, wet, updatedAt: Date.now() })).then(() => {
      const everywhere = this.deps.everywhere();
      w.toast({ id: `effects:${front.host}`, message: wet ? (everywhere ? `Wet: ${front.host} shows your Effects` : `${front.host} is wet, but every site is dry`) : `Dry: ${front.host} shows as it comes` });
    });
  }

  /** Dry or wet everywhere. */
  toggleEverywhere(w: EffectsWindow): void {
    const wet = !this.deps.everywhere();
    this.deps.setEverywhere(wet);
    w.toast({ id: 'effects', message: wet ? 'Wet everywhere: sites show your Effects' : 'Dry everywhere: every site shows as it comes' });
  }

  /* ---------- Hiding an element ---------- */

  /** Pick elements to hide on the page in front (the card's Hide an element…, the menus, the command bar). */
  startPick(w: EffectsWindow, fromCard = false): void {
    const front = this.frontSite(w.id);
    if (!front) {
      w.toast({ id: 'effects', message: 'Effects work on websites. There’s none on screen here.' });
      return;
    }
    const scope = w.isPrivate ? w.id : null;
    this.picks.set(w.id, { host: front.host, scope, hidden: 0, before: this.stored(scope, front.host)?.site ?? null, fromCard });
    if (!this.deps.startPicker(w.id, front.host)) this.picks.delete(w.id);
  }

  /** The picker's click: the element under the pointer is hidden on the site. Answers how the list names it. */
  async hidePicked(windowId: WindowId): Promise<{ label: string } | null> {
    const pick = this.picks.get(windowId);
    const contents = this.deps.pickerPage(windowId);
    if (!pick || !contents || contents.isDestroyed() || effectsHost(contents.getURL()) !== pick.host) return null;
    const found = (await pageCall(contents.executeJavaScriptInIsolatedWorld(SHOT_WORLD, [{ code: SELECTOR_SCRIPT }]), null, 1000)) as PickedElement | null;
    if (!found || typeof found.selector !== 'string' || typeof found.label !== 'string' || !found.selector || found.selector.length > EFFECTS_LIMITS.selector) return null;
    const label = found.label.slice(0, EFFECTS_LIMITS.label);
    const selector = found.selector.trim();
    await this.change(pick.scope, pick.host, (site) =>
      site.hidden.some((h) => h.selector === selector) ? site : { ...site, hidden: [...site.hidden, { selector, label, at: Date.now() }].slice(-EFFECTS_LIMITS.hidden), updatedAt: Date.now() },
    );
    pick.hidden++;
    return { label };
  }

  /** The picker closed: one toast for what it hid, with Undo, and the card again if it came from there. */
  pickDone(windowId: WindowId): void {
    const pick = this.picks.get(windowId);
    if (!pick) return;
    this.picks.delete(windowId);
    const w = this.windowOf(windowId);
    if (!w) return;
    if (pick.hidden > 0) this.offerUndo(w, pick.scope, pick.host, pick.before, `Hid ${pick.hidden === 1 ? 'an element' : `${pick.hidden} elements`} on ${pick.host}`);
    if (pick.fromCard) this.open(w);
  }

  /* ---------- Ask Duet ---------- */

  private async ask(w: EffectsWindow, card: Card, text: string): Promise<void> {
    const front = this.frontSite(w.id);
    const duet = this.duet;
    if (this.asks.get(w.id)?.busy || !front || front.host !== card.host) return;
    // Duet's own rules, checked again here: set up, on in this chord, not a Never site, not a private window.
    const available = duet && !w.isPrivate ? duet.available(w.id, front.url) : null;
    const state: Ask = { host: card.host, scope: card.scope, busy: true, startedAt: Date.now(), error: null, note: null, controller: new AbortController() };
    this.asks.set(w.id, state);
    if (!duet || !available) {
      Object.assign(state, { busy: false, startedAt: null, error: 'Duet can’t read this page, so it can’t restyle it.' });
      return this.push(w.id);
    }
    this.push(w.id);
    const { contents } = front;
    const current = this.stored(card.scope, card.host)?.compiled ?? '';
    const result = await duet.ask({
      instructions: effectsInstructions(),
      text: effectsTurn(card.host, text),
      tool: EFFECTS_OUTLINE_TOOL,
      signal: state.controller!.signal,
      timeoutMs: ASK_MS,
      onTool: async () => {
        const page = contents.isDestroyed() ? null : ((await pageCall(contents.executeJavaScriptInIsolatedWorld(EFFECTS_WORLD, [{ code: OUTLINE_SCRIPT }]), null, OUTLINE_MS)) as PageOutline | null);
        // The page may have moved on to another site meanwhile: it's this site's outline or none.
        if (!page || typeof page.outline !== 'string' || effectsHost(String(page.url)) !== card.host) return JSON.stringify({ error: 'The page could not be read.' });
        return outlineResult({ url: String(page.url), title: String(page.title ?? ''), outline: cleanOutline(page.outline), current, retrievedAt: Date.now() });
      },
    });
    state.busy = false;
    state.controller = null;
    if (this.asks.get(w.id) !== state) return;
    if (!result.ok) {
      state.error = result.error;
      return this.push(w.id);
    }
    const answer = parseEffectsAnswer(result.text);
    if (!answer) state.error = 'Duet’s answer wasn’t a stylesheet Chord could use. Try asking another way.';
    else if (!answer.css.trim()) state.error = answer.summary || 'Duet couldn’t do that with CSS.';
    else {
      const clean = await this.compiler.patch(answer.css).catch(() => null);
      if (!clean?.css) state.error = 'Nothing in Duet’s answer was safe to use.';
      else {
        if (clean.removed.length) state.note = `Chord left out ${removedText(clean.removed)} from Duet’s patch.`;
        const at = Date.now();
        await this.change(card.scope, card.host, (site) => ({
          ...site,
          duet: [...site.duet, { id: uuidv7(at), ask: text.trim().slice(0, EFFECTS_LIMITS.ask), summary: answer.summary || text.trim().slice(0, EFFECTS_LIMITS.summary), css: clean.css, at }].slice(-EFFECTS_LIMITS.duet),
          updatedAt: at,
        }));
      }
    }
    this.push(w.id);
  }

  /* ---------- Settings → Effects ---------- */

  /** Every saved site with Effects, newest change first. */
  sites(): EffectsSite[] {
    return [...this.saved.values()]
      .filter((st) => hasEffects(st.site))
      .map((st) => ({ host: st.site.host, wet: st.site.wet, summary: effectsSummary(st.site), updatedAt: st.site.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  settingsChange(change: EffectsSiteChange): Promise<void> {
    if (!this.saved.has(change.host)) return Promise.resolve();
    if (change.do === 'remove') return this.change(null, change.host, () => null);
    return this.change(null, change.host, (site) => ({ ...site, wet: change.wet, updatedAt: Date.now() }));
  }

  /** Development and tests: what's saved, what each page has, and main's timings. */
  inspect(): { sites: string[]; pages: { url: string | null; applied: boolean }[]; timings: Effects['timings']; compile: number[] } {
    return {
      sites: [...this.saved.keys()],
      pages: [...this.pages.values()].map((p) => ({ url: p.url, applied: p.key !== null })),
      timings: [...this.timings],
      compile: [...this.compiler.timings],
    };
  }

  /** Quitting: the worker goes; requests to Duet stop. */
  stop(): void {
    for (const ask of this.asks.values()) ask.controller?.abort();
    this.compiler.stop();
  }
}

/** A preset on or off, keeping the order they were turned on in. */
function togglePreset(presets: readonly EffectPresetId[], id: EffectPresetId, on: boolean): EffectPresetId[] {
  const rest = presets.filter((p) => p !== id);
  return on ? [...rest, id] : rest;
}
