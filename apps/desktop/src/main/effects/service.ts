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
 * - **Each one's switch.** Your CSS, each hidden element and each of Duet's
 *   patches can be switched off and kept (a preset that's off isn't kept).
 *   The site's stylesheet is made from what's on (`effectsParts`), so
 *   switching one is a change like any other: one stylesheet made again and
 *   swapped on the site's pages.
 * - **Dry/Wet.** Each site has its own switch; Settings' switch makes every
 *   site dry at once. Dry keeps everything and applies nothing, over whatever
 *   each item's switch says. A tab's `live.effects` says which, for the button
 *   beside the address.
 * - **Sanitizing.** Every change goes through the sanitizer in Effects' worker
 *   (compiler.ts) before anything of it is used, an edited Duet patch as much
 *   as your CSS; nothing is applied from a stylesheet an older sanitizer made
 *   until the new one has made it again.
 * - **Ask Duet.** Your Claude Code or Codex app writes a patch from the page's
 *   outline (scripts.ts), under Duet's reading rules: never a private window, a
 *   chord where Duet is off, a Never site, or a form field's value.
 */
import {
  cleanOutline,
  cleanSiteEffects,
  EFFECTS_LIMITS,
  EFFECTS_OUTLINE_TOOL,
  effectsHost,
  effectsInstructions,
  effectsParts,
  effectsSummary,
  effectsTurn,
  effectsWet,
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
import type { Compiled, Removal } from './sanitize';
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
  persist(host: string, site: SavedEffects | null, fromSync?: boolean): void;
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
  /** What it said about the stylesheet, for the card; null until it's been made this launch. */
  notes: Notes | null;
}

/** What the sanitizer said about what's switched on: what it left out of your CSS and of each of Duet's patches (by id), and the hidden elements' selectors it can't use. */
interface Notes {
  css: Removal[];
  duet: Map<string, Removal[]>;
  unusable: Set<string>;
}

const noNotes = (): Notes => ({ css: [], duet: new Map(), unusable: new Set() });

/** The notes on a stylesheet made from a site's parts (`effectsParts`), whose patches were the ones that are on, in order. */
function notesOf(site: SiteEffects, compiled: Compiled): Notes {
  const on = site.duet.filter((d) => d.on);
  return { css: compiled.removed, duet: new Map(on.map((d, i) => [d.id, compiled.patches[i] ?? []])), unusable: new Set(compiled.unusable) };
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
  /** What each import from a Chord file changed, by site, as it was (null: it had none). */
  private readonly imported = new Map<string, { host: string; site: SiteEffects | null }[]>();
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
      this.saved.set(site.host, { site, compiled, sanitizer, notes: null });
      if (sanitizer !== SANITIZER_VERSION) stale.push(site.host);
    }
    // Made by an older sanitizer: made again before any of it is used.
    for (const host of stale) void this.change(null, host, (site) => site);
  }

  /* ---------- Sites ---------- */

  private stored(scope: WindowId | null, host: string): Stored | undefined {
    return (scope ? this.privates.get(scope)?.get(host) : undefined) ?? this.saved.get(host);
  }

  /** The stylesheet a page should have now: none while dry, with nothing on, or until the current sanitizer made it. */
  private cssFor(page: Page): string | null {
    const st = page.host ? this.stored(page.scope, page.host) : undefined;
    if (!st || !st.compiled || st.sanitizer !== SANITIZER_VERSION || !effectsWet(st.site, this.deps.everywhere())) return null;
    return st.compiled;
  }

  private liveFor(scope: WindowId | null, host: string | null): LiveTab['effects'] {
    const st = host ? this.stored(scope, host) : undefined;
    if (!st || !hasEffects(st.site)) return null;
    return effectsWet(st.site, this.deps.everywhere()) ? 'wet' : 'dry';
  }

  /**
   * Change one site's Effects, one change at a time per site: `edit` gets a
   * copy of what's there now (or an empty site) and returns the new one, or
   * null to remove it. The result is sanitized before anything of it is used.
   * `undo` puts a toast in that window to take the change back. `quiet`: Settings' list hears of it from the caller, once for many.
   * `fromSync`: another computer's change, saved without a stamp (it never goes back into this computer's log).
   */
  private change(scope: WindowId | null, host: string, edit: (site: SiteEffects) => SiteEffects | null, undo?: { w: EffectsWindow; message: string }, quiet = false, fromSync = false): Promise<void> {
    const key = scopeKey(scope, host);
    const run = async () => {
      const before = this.stored(scope, host);
      const next = edit(before ? clone(before.site) : emptyEffects(host, Date.now()));
      let stored: Stored | null = null;
      if (next && (hasEffects(next) || scope)) {
        let compiled = '';
        let notes = noNotes();
        let sanitizer = SANITIZER_VERSION;
        // Only what's on goes in; with everything off there's nothing to make.
        const parts = effectsParts(next);
        if (parts.presets.length > 0 || parts.hidden.length > 0 || parts.css.trim() || parts.duet.length > 0) {
          try {
            const result = await this.compiler.compile(parts);
            compiled = result.css;
            notes = notesOf(next, result);
          } catch (error) {
            // Nothing is applied that the sanitizer didn't make: the site waits for the next change, or the next launch.
            console.error('[chord] Effects couldn’t check a stylesheet:', error instanceof Error ? error.message : error);
            sanitizer = 0;
          }
        }
        stored = { site: next, compiled, sanitizer, notes };
      }
      if (scope) {
        // A private window keeps its own copy, an empty one too: what was saved doesn't show through it.
        let own = this.privates.get(scope);
        if (!own) this.privates.set(scope, (own = new Map()));
        own.set(host, stored ?? { site: emptyEffects(host, Date.now()), compiled: '', sanitizer: SANITIZER_VERSION, notes: noNotes() });
      } else if (stored) {
        this.saved.set(host, stored);
        this.deps.persist(host, { ...stored.site, compiled: stored.compiled, sanitizer: stored.sanitizer }, fromSync);
      } else if (this.saved.delete(host)) {
        this.deps.persist(host, null, fromSync);
      }
      if (undo) this.offerUndo(undo.w, scope, host, before?.site ?? null, undo.message);
      this.siteChanged(scope, host);
      if (!scope && !quiet) this.deps.settingsChanged();
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
      // Main doesn't wait past pageCall's limit. A page still busy loading (a heavy site just reloaded) can answer later:
      // what lands then stays if it's still what the page should have, and goes if something newer came meanwhile. One
      // that never lands leaves the page without it, and the next change tries again.
      const inserting = contents.insertCSS(want, { cssOrigin: 'author' });
      key = await pageCall(inserting, null);
      if (key === null) {
        void inserting.then(
          (late) => {
            if (contents.isDestroyed()) return;
            if (page.seq === seq && page.url === url && page.css === want) page.key = late;
            else void contents.removeInsertedCSS(late).catch(() => {});
          },
          () => {
            if (page.seq === seq) page.css = null;
          },
        );
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
    // What was left out of your CSS and Duet's patches is known once the stylesheet's been made this launch.
    const st = this.stored(scope, front.host);
    if (st && st.notes === null && hasEffects(st.site)) void this.notes(st, w.id);
    else this.push(w.id);
  }

  /** What the sanitizer leaves out of what's on, found again without changing anything. */
  private async notes(st: Stored, windowId: WindowId): Promise<void> {
    const result = await this.compiler.compile(effectsParts(st.site)).catch(() => null);
    st.notes = result ? notesOf(st.site, result) : noNotes();
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
    const notes = st?.notes;
    const removals = (removed: readonly Removal[] | undefined) => (removed ?? []).map(({ what, line, kind }) => ({ what, line, kind }));
    return {
      host: card.host,
      wet: site.wet,
      everywhere: this.deps.everywhere(),
      css: site.css,
      cssOn: site.cssOn,
      removed: removals(notes?.css),
      hidden: site.hidden.map(({ selector, label, on }) => ({ selector, label, on, usable: !notes?.unusable.has(selector) })),
      presets: [...site.presets],
      duet: site.duet.map(({ id, ask, summary, css, on }) => ({ id, ask, summary, css, on, removed: removals(notes?.duet.get(id)) })),
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
        // The field has its own undo; a toast for each pause in typing would only be noise. So with the editors below.
        return this.change(scope, host, (site) => ({ ...site, css: action.css, updatedAt: now }));
      case 'cssOn':
        // A switch is its own undo, as a preset's chip is.
        return this.change(scope, host, (site) => ({ ...site, cssOn: action.on, updatedAt: now }));
      case 'wet':
        return this.change(scope, host, (site) => ({ ...site, wet: action.wet, updatedAt: now }));
      case 'everywhere':
        this.deps.setEverywhere(action.wet);
        return;
      case 'preset':
        return this.change(scope, host, (site) => ({ ...site, presets: togglePreset(site.presets, action.id, action.on), updatedAt: now }));
      case 'hiddenOn':
        return this.change(scope, host, (site) => ({ ...site, hidden: site.hidden.map((h) => (h.selector === action.selector ? { ...h, on: action.on } : h)), updatedAt: now }));
      case 'editHidden': {
        const { selector, label } = action.next;
        return this.change(scope, host, (site) =>
          // Another element is hidden by that selector already: the card says so, and nothing changes.
          site.hidden.some((h) => h.selector === selector && h.selector !== action.selector)
            ? site
            : { ...site, hidden: site.hidden.map((h) => (h.selector === action.selector ? { ...h, selector, label: label.trim() } : h)), updatedAt: now },
        );
      }
      case 'duetOn':
        return this.change(scope, host, (site) => ({ ...site, duet: site.duet.map((d) => (d.id === action.id ? { ...d, on: action.on } : d)), updatedAt: now }));
      case 'editDuet':
        // Kept as written, like your CSS: the sanitizer makes the stylesheet from it, and the card says what it left out.
        return this.change(scope, host, (site) => ({
          ...site,
          duet: site.duet.map((d) => (d.id === action.id ? { ...d, summary: action.summary.replace(/\s+/g, ' ').trim(), css: action.css } : d)),
          updatedAt: now,
        }));
      case 'unhide': {
        // Its name, or its selector when you emptied the name.
        const hidden = this.stored(scope, host)?.site.hidden.find((h) => h.selector === action.selector);
        const label = hidden ? hidden.label || hidden.selector : 'it';
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
    // Picking one that's in the list but off turns it on again.
    await this.change(pick.scope, pick.host, (site) =>
      site.hidden.some((h) => h.selector === selector)
        ? { ...site, hidden: site.hidden.map((h) => (h.selector === selector ? { ...h, on: true } : h)), updatedAt: Date.now() }
        : { ...site, hidden: [...site.hidden, { selector, label, on: true, at: Date.now() }].slice(-EFFECTS_LIMITS.hidden), updatedAt: Date.now() },
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
          duet: [...site.duet, { id: uuidv7(at), ask: text.trim().slice(0, EFFECTS_LIMITS.ask), summary: answer.summary || text.trim().slice(0, EFFECTS_LIMITS.summary), css: clean.css, on: true, at }].slice(-EFFECTS_LIMITS.duet),
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

  /* ---------- Your data: an import from a Chord file (S15 §5) ---------- */

  /**
   * Sites' Effects from a Chord file, each merged with what's here already
   * (core's planMerge) and checked (`cleanSiteEffects`): each one goes through
   * `change`, so the sanitizer makes its stylesheet before any of it is used,
   * as for Effects you write. They apply on the site's next page. What each
   * site had is kept, for the import's Undo.
   */
  async importSites(importId: string, sites: readonly SiteEffects[]): Promise<void> {
    const before = this.imported.get(importId) ?? [];
    this.imported.set(importId, before);
    await Promise.all(
      sites.map((incoming) => {
        const site = cleanSiteEffects(incoming);
        if (!site || !hasEffects(site) || (!this.saved.has(site.host) && this.saved.size >= EFFECTS_LIMITS.sites)) return Promise.resolve();
        return this.change(
          null,
          site.host,
          (current) => {
            if (!before.some((b) => b.host === site.host)) before.push({ host: site.host, site: this.saved.has(site.host) ? clone(current) : null });
            return site;
          },
          undefined,
          true,
        );
      }),
    );
    // Settings' list of sites, once for the lot.
    this.deps.settingsChanged();
  }

  /** An import's Undo: each site it changed as it was, or without Effects again. */
  async undoImport(importId: string): Promise<void> {
    const before = this.imported.get(importId) ?? [];
    this.imported.delete(importId);
    await Promise.all(before.map((b) => this.change(null, b.host, () => (b.site ? clone(b.site) : null), undefined, true)));
    this.deps.settingsChanged();
  }

  /* ---------- Your data: sync (S15 §7) ---------- */

  /**
   * Sites' Effects another computer changed, already merged and checked
   * (core's planApply, `cleanSiteEffects`): each through `change`, so the
   * sanitizer makes its stylesheet before any of it is used, as for Effects
   * you write; and the sites whose Effects went there. No Undo: these are
   * changes you made elsewhere. Saved as sync's, so they never go back into
   * this computer's log.
   */
  async syncSites(sites: readonly SiteEffects[], gone: readonly string[]): Promise<void> {
    await Promise.all([
      ...sites.map((incoming) => {
        const site = cleanSiteEffects(incoming);
        if (!site || !hasEffects(site) || (!this.saved.has(site.host) && this.saved.size >= EFFECTS_LIMITS.sites)) return Promise.resolve();
        return this.change(null, site.host, () => site, undefined, true, true);
      }),
      ...gone.map((host) => (this.saved.has(host) ? this.change(null, host, () => null, undefined, true, true) : Promise.resolve())),
    ]);
    this.deps.settingsChanged();
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
