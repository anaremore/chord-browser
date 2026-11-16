/**
 * Chord's passwords where you use them (S17 §5, §6, §9): the detector's events joined to the
 * vault. Three things, all in main:
 *
 * - **The menu under the field.** A sign-in field takes focus (`focus`) → `accountsFor` the
 *   frame's origin and the tab's chord → the menu, placed under the field (the window's popover,
 *   anchored to the field's box and the page's zoom), within a frame of the vault's answer. Its
 *   rows are usernames and hosts; *Unlock passwords* when the vault is locked; nothing when
 *   there's nothing saved, or passwords are off there. It opens at most once per focus: after
 *   a choice or Escape, not again until the field loses focus for real. It closes on blur, a
 *   navigation, the tab leaving the screen, the page going.
 * - **Keys and clicks.** While it's open, main sees the page's keys first (`before-input-event`,
 *   listened to only then) and `menu-keys.ts` routes them: ↓ ↑ Enter Escape are the menu's and
 *   never reach the page; the rest go on. A click on a row moves focus to the popover for a
 *   moment (M0 §3): main hears the press first (`popoverMouse`), lets the blur that follows go
 *   by without closing the menu, and gives the page its focus back once the press is over.
 * - **Fill.** Your choice → `passwordFor` (the vault matches the sign-in to the origin the
 *   menu was shown for) → only if the tab's main frame is still that frame, with that origin,
 *   on that document, the values go to it alone (`passwords:fill`), and the agent checks the
 *   form again before writing. Main keeps no copy.
 * - **The save and update cards.** A sign-in that worked (`signedIn`, with what was typed) →
 *   `candidateFor` → the card for that tab, or none (the same password, a *Never* site,
 *   passwords off) → Save → `saveCandidate` (the first one with the passphrase its card
 *   chose), or *Never for this site* → `neverFor`. × (or a minute unused, not while you're in
 *   it) only hides the card: the key in the address brings it back (S17 §9, the owner's answer
 *   of 2026-11-16) while the candidate lasts. What was typed stays here, in memory, only that
 *   long: until the candidate's own deadline (`HOLD_MS` after it was typed, handed over by the
 *   tracker, not a fresh 5 minutes), *Save* or *Never*, passwords turned off for the chord, the
 *   tab leaving the site, a navigation of your own, a sign-in there that failed, or the tab
 *   closing. The popover gets the username; the password only when you press the card's eye,
 *   and only that card's popover.
 *
 * The vault keeps its own gates (the switch, the extension rule, an address that can be saved,
 * private windows never saving, proxies never), and the detector its own (Chord's pages, the
 * main frame only, private windows never signed in): this adds the tab's, and drops anything
 * from a page that isn't a tab's. Nothing here logs a value.
 */
import type { EventEmitter } from 'node:events';
import type { WindowId } from '@chord/core';
import { PASSWORDS_FILL, type PasswordMenu, type PasswordSaveCard, type PasswordsFill } from '@chord/ipc';
import { durations, easing } from '@chord/tokens';
import type { Input, WebContents, WebFrameMain } from 'electron';
import type { PasswordDetectorEvents, PasswordsFocusEvent } from './detector';
import { keyIdOf, routeMenuKey, routeTakenKey, TAKEN_KEY_PATIENCE } from './menu-keys';
import { HOLD_MS, type CandidateValues } from './saving';
import type { PasswordService } from './service';

/** How long the save card stays unused (S17 §9: a minute ⚠). It doesn't go while you're in it. */
export const SAVE_CARD_MS = 60_000;
/** After a press on the menu, how long the field's blur (the popover took focus) doesn't close it (M0 §3). */
export const CLICK_GRACE_MS = 1000;

/** The forms the menu fills in phase 1: sign-in forms and their first steps. Sign-up and change forms come with the generator (phase 2). */
const MENU_KINDS = new Set(['sign-in', 'username-only', 'unknown']);
const MENU_ROLES = new Set(['username', 'current-password']);
/** The forms a save is offered for: a sign-in. A sign-up's new account, and a changed password, are phase 2's. */
const SAVE_KINDS = new Set(['sign-in', 'unknown']);

export interface AssistTab {
  readonly nodeId: string;
  readonly windowId: WindowId;
  /** The tab's chord; a private window's is fill only (the vault knows it by this id). */
  readonly chordId: string | null;
  readonly private: boolean;
}

export interface PasswordAssistHost {
  /** The tab a page is, or null when it isn't a tab's page. */
  tabOf(contents: WebContents): AssistTab | null;
  /** Whether the page is on screen in its window now. */
  shown(contents: WebContents): boolean;
  /** A window's menu or save card changed: its popover again, and where it goes. */
  changed(windowId: WindowId): void;
  /** Keyboard focus back to the page (after a click on the menu). */
  focusPage(contents: WebContents): void;
  /** The tab's chord's accent, for the fill's outline. */
  accent(nodeId: string): string | null;
  toast(windowId: WindowId, id: string, message: string): void;
  /** A closed save card can be brought back: the key in the tab's address (`live.passwordOffer`). */
  offer(nodeId: string, on: boolean): void;
  /** A sign-in field took focus in this window: the menu's view is made now if it isn't yet, while the vault answers. */
  prepareMenu(windowId: WindowId): void;
  /** *Other passwords…*: Settings → Passwords. */
  openPasswords(windowId: WindowId): void;
  /** Whether Chord's passwords are on for a chord now: the switch and the extension rule. */
  passwordsOn(chordId: string | null): boolean;
}

export type AssistVault = Pick<PasswordService, 'accountsFor' | 'passwordFor' | 'candidateFor' | 'saveCandidate' | 'neverFor' | 'askUnlock'>;

export interface PasswordAssistOptions {
  readonly vault: AssistVault;
  readonly detector: { readonly events: EventEmitter<PasswordDetectorEvents> };
  readonly host: PasswordAssistHost;
  readonly now?: () => number;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  /** The site of an origin (its registrable domain), for the card that goes when you leave it. */
  readonly siteOf?: (origin: string) => Promise<string | null>;
}

/** Where the menu goes: the field's box in its page's CSS pixels, and the page's zoom. */
export interface MenuAnchor {
  readonly contents: WebContents;
  readonly rect: { x: number; y: number; width: number; height: number };
  readonly zoom: number;
}

type FrameRef = Pick<WebFrameMain, 'processId' | 'routingId' | 'origin'> & { send?: WebFrameMain['send'] };

interface Menu {
  readonly id: number;
  readonly tab: AssistTab;
  readonly contents: WebContents;
  readonly frame: FrameRef;
  readonly origin: string;
  /** The document it was shown for (counted per page at each commit). */
  readonly doc: number;
  readonly formId: string;
  readonly role: string;
  /** The form's kind: a first step (`username-only`) has no password field, so no password is sent to it. */
  readonly kind: string;
  rect: MenuAnchor['rect'];
  zoom: number;
  readonly host: string;
  readonly locked: boolean;
  readonly insecure: boolean;
  readonly accounts: readonly { id: string; username: string; host: string | null }[];
  index: number;
}

/** A page's keys while a menu is or was just open: one listener, and the keys whose keyDown the menu took. */
interface KeyGuard {
  taken: ReadonlySet<string>;
  /** Once the menu has closed: how many more events it waits through for a taken key's keyUp. */
  patience: number;
  readonly onKey: (event: { preventDefault(): void }, input: Input) => void;
}

interface Pending {
  readonly seq: number;
  readonly formId: string;
  readonly role: string;
  rect: MenuAnchor['rect'];
  zoom: number;
}

interface Card {
  readonly id: number;
  readonly tab: AssistTab;
  readonly contents: WebContents;
  readonly origin: string;
  readonly site: string | null;
  readonly host: string;
  kind: 'new' | 'update';
  /** The vault was locked when it was offered: Save asks to unlock first, and the vault decides new or update then. */
  locked: boolean;
  setup: boolean;
  /** What was typed, until the card goes. */
  values: CandidateValues | null;
  busy: boolean;
  problem: 'io' | null;
  held: boolean;
  /** On screen; hidden by × or a minute unused, and brought back by the key in the address. */
  shown: boolean;
  /** The minute unused, while shown. */
  idle: unknown;
  /** The candidate's deadline: the card and what was typed go then, shown or not. */
  expiry: unknown;
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};
const sameFrame = (a: Pick<FrameRef, 'processId' | 'routingId'> | null | undefined, b: Pick<FrameRef, 'processId' | 'routingId'> | null | undefined) =>
  !!a && !!b && a.processId === b.processId && a.routingId === b.routingId;

export class PasswordAssist {
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly siteOf: (origin: string) => Promise<string | null>;
  private nextId = 1;
  private seq = 0;
  private readonly menus = new Map<WindowId, Menu>();
  private readonly pending = new Map<WebContents, Pending>();
  /** A form whose menu was answered (a choice, Escape): no menu again in it until a real blur. */
  private readonly quiet = new Map<WebContents, string>();
  /** A press on a window's menu: the blur it causes doesn't close it, until then. */
  private readonly grace = new Map<WindowId, { until: number; contents: WebContents }>();
  private readonly docs = new WeakMap<WebContents, number>();
  private readonly cards = new Map<string, Card>();
  private readonly guards = new Map<WebContents, KeyGuard>();

  constructor(private readonly options: PasswordAssistOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.siteOf = options.siteOf ?? (async (origin) => (await import('@chord/core/password-sites')).loginSite(origin));
    const { events } = options.detector;
    events.on('focus', (e) => void this.focused(e));
    events.on('blur', (e) => this.blurred(e.contents));
    events.on('signedIn', (e) => void this.signedIn(e));
    // A sign-in there that failed: what an earlier one left to save is no longer what you use.
    events.on('failed', (e) => this.dropCardsOf(e.contents));
    events.on('filled', (e) => {
      if (e.ok) return;
      // Half a fill, refused: the detector and the page disagree about the form. Said without a value, an origin or a field.
      if (e.reason === 'password') console.warn('Passwords: a fill had no password for a password field in its form, so nothing was filled');
      const tab = options.host.tabOf(e.contents);
      if (!tab) return;
      if (e.reason === 'password') options.host.toast(tab.windowId, 'passwords:fill', 'Chord couldn’t tell where the password goes in this form, so it didn’t fill it.');
      else options.host.toast(tab.windowId, 'passwords:fill', 'The form changed, so Chord didn’t fill it. Choose the account again.');
    });
  }

  /** A tab's page, as it's made: its documents counted, and what's shown for it closed when it goes. */
  attachPage(contents: WebContents): void {
    this.docs.set(contents, 0);
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.closeMenuOf(contents);
      // A navigation of your own (the address bar, a bookmark, Back), not the page's: the candidate ends.
      if (!details.initiator) this.dropCardsOf(contents);
    });
    contents.on('did-navigate', (_event, url) => {
      this.docs.set(contents, (this.docs.get(contents) ?? 0) + 1);
      this.closeMenuOf(contents);
      // A new document numbers its forms from f1 again: "not again in this form" was the last page's.
      this.quiet.delete(contents);
      void this.leftSite(contents, url);
    });
    contents.once('destroyed', () => {
      this.closeMenuOf(contents);
      this.guards.delete(contents);
      this.pending.delete(contents);
      this.quiet.delete(contents);
      this.dropCardsOf(contents);
    });
  }

  /* ---------- the menu ---------- */

  private async focused(e: PasswordsFocusEvent): Promise<void> {
    const { host, vault } = this.options;
    const tab = host.tabOf(e.contents);
    if (!tab) return;
    const open = this.menuOf(e.contents);
    if (!MENU_KINDS.has(e.kind) || !MENU_ROLES.has(e.role)) {
      // A sign-up's or a code's field took focus: no menu (the generator is phase 2's).
      this.pending.delete(e.contents);
      if (open) this.close(open);
      return;
    }
    // The menu's field moved (a scroll, a zoom): the menu follows it.
    if (open && open.formId === e.formId) {
      open.rect = e.rect;
      open.zoom = e.zoomFactor;
      host.changed(open.tab.windowId);
      return;
    }
    if (open) this.close(open);
    const waiting = this.pending.get(e.contents);
    if (waiting && waiting.formId === e.formId && waiting.role === e.role) {
      waiting.rect = e.rect;
      waiting.zoom = e.zoomFactor;
      return;
    }
    if (this.quiet.get(e.contents) === e.formId || !host.shown(e.contents)) return;
    host.prepareMenu(tab.windowId);
    const seq = ++this.seq;
    const pending: Pending = { seq, formId: e.formId, role: e.role, rect: e.rect, zoom: e.zoomFactor };
    this.pending.set(e.contents, pending);
    const doc = this.docs.get(e.contents) ?? 0;
    const answer = await vault.accountsFor(e.origin, tab.chordId).catch(() => ({ state: 'off' as const }));
    // A blur, another field, or another page since: this answer is for nothing on screen.
    if (this.pending.get(e.contents) !== pending) return;
    this.pending.delete(e.contents);
    if (e.contents.isDestroyed() || (this.docs.get(e.contents) ?? 0) !== doc || !host.shown(e.contents)) return;
    if (answer.state !== 'open' && answer.state !== 'locked') return;
    const accounts = answer.state === 'open' ? answer.offers.map((o) => ({ id: o.id, username: o.username, host: o.host !== hostOf(e.origin) ? o.host : null })) : [];
    if (answer.state === 'open' && accounts.length === 0) return;
    const menu: Menu = {
      id: this.nextId++,
      tab,
      contents: e.contents,
      frame: e.frame,
      origin: e.origin,
      doc,
      formId: e.formId,
      role: e.role,
      kind: e.kind,
      rect: pending.rect,
      zoom: pending.zoom,
      host: hostOf(e.origin),
      locked: answer.state === 'locked',
      insecure: answer.state === 'open' && answer.insecure,
      accounts,
      index: 0,
    };
    // One menu a window: another pane's, still open, closes first (its keys with it).
    const replaced = this.menus.get(tab.windowId);
    if (replaced) this.close(replaced);
    this.menus.set(tab.windowId, menu);
    this.guardKeys(e.contents);
    host.changed(tab.windowId);
  }

  private blurred(contents: WebContents): void {
    this.pending.delete(contents);
    const menu = this.menuOf(contents);
    const grace = menu ? this.grace.get(menu.tab.windowId) : undefined;
    // The popover took focus for a click on the menu: this blur isn't you leaving the field.
    if (menu && grace && grace.contents === contents && grace.until >= this.now()) return;
    this.quiet.delete(contents);
    if (menu) this.close(menu);
  }

  /**
   * The page's keys come here first only while a menu is open, and until the keys it took are over (their keyUp):
   * nothing runs per keystroke otherwise. Prepended, so before Chord's own shortcuts.
   */
  private guardKeys(contents: WebContents): void {
    if (this.guards.has(contents)) return;
    const guard: KeyGuard = { taken: new Set(), patience: TAKEN_KEY_PATIENCE, onKey: (event, input) => this.onKey(contents, guard, event, input) };
    this.guards.set(contents, guard);
    contents.prependListener('before-input-event', guard.onKey);
  }

  private onKey(contents: WebContents, guard: KeyGuard, event: { preventDefault(): void }, input: Input): void {
    const menu = this.menuOf(contents);
    if (menu && input.type === 'keyDown') return this.key(menu, guard, event, input);
    const routed = routeTakenKey(guard.taken, input);
    guard.taken = routed.taken;
    if (routed.take) event.preventDefault();
    if (menu) return;
    // Closed: the listener goes once the keys it took are over (another key pressed meanwhile is the page's, and
    // doesn't end the wait), or after a few events if a keyUp never comes.
    if (!routed.take) guard.patience--;
    if (guard.taken.size === 0 || guard.patience <= 0) this.unguardKeys(contents);
  }

  private unguardKeys(contents: WebContents): void {
    const guard = this.guards.get(contents);
    if (!guard) return;
    this.guards.delete(contents);
    if (!contents.isDestroyed()) contents.off('before-input-event', guard.onKey);
  }

  private key(menu: Menu, guard: KeyGuard, event: { preventDefault(): void }, input: Input): void {
    const routed = routeMenuKey({ index: menu.index, rows: this.rowsOf(menu) }, input);
    if (routed.take) {
      event.preventDefault();
      guard.taken = new Set([...guard.taken, keyIdOf(input)]);
      guard.patience = TAKEN_KEY_PATIENCE;
    }
    if (routed.choose !== undefined) return void this.choose(menu, routed.choose);
    if (!routed.menu) {
      // Escape: not again in this form until you leave it. Tab: the page moves on, and the next field may get its own.
      if (input.key === 'Escape') this.quiet.set(menu.contents, menu.formId);
      this.close(menu);
      return;
    }
    if (routed.menu.index !== menu.index) {
      menu.index = routed.menu.index;
      this.options.host.changed(menu.tab.windowId);
    }
  }

  /** Accounts, then *Other passwords…*; or the one *Unlock passwords* row. */
  private rowsOf(menu: Menu): number {
    return menu.locked ? 1 : menu.accounts.length + 1;
  }

  /** A row clicked in the window's popover (the sender, checked by the caller). */
  chooseRow(windowId: WindowId, id: number, index: number): void {
    const menu = this.menus.get(windowId);
    if (!menu || menu.id !== id || index >= this.rowsOf(menu)) return;
    void this.choose(menu, index);
  }

  /** The popover's mouse, before its page sees it: a press on the menu keeps the menu through the blur it causes. */
  popoverMouse(windowId: WindowId, type: string): void {
    const menu = this.menus.get(windowId);
    if (type === 'mouseDown' && menu) {
      this.grace.set(windowId, { until: this.now() + CLICK_GRACE_MS, contents: menu.contents });
    } else if (type === 'mouseUp') {
      const grace = this.grace.get(windowId);
      if (!grace) return;
      // Once the click has reached the row: the page's field has the keyboard again.
      this.setTimer(() => {
        if (!grace.contents.isDestroyed()) this.options.host.focusPage(grace.contents);
      }, 0);
      this.setTimer(() => {
        if (this.grace.get(windowId) === grace) this.grace.delete(windowId);
      }, CLICK_GRACE_MS);
    }
  }

  private async choose(menu: Menu, index: number): Promise<void> {
    const { host, vault } = this.options;
    this.close(menu);
    this.quiet.set(menu.contents, menu.formId);
    if (menu.locked) {
      // The unlock card takes the keyboard; once the vault is open, the field has it again and its menu lists the accounts.
      const open = await vault.askUnlock(menu.tab.windowId);
      if (open && !menu.contents.isDestroyed()) {
        this.quiet.delete(menu.contents);
        host.focusPage(menu.contents);
      }
      return;
    }
    const account = menu.accounts[index];
    if (!account) return host.openPasswords(menu.tab.windowId);
    const password = await vault.passwordFor(account.id, menu.origin, menu.tab.chordId);
    if (password === null) return;
    const contents = menu.contents;
    // The same frame, origin and document the menu was shown for, or nothing is sent (S17 §5).
    if (contents.isDestroyed() || (this.docs.get(contents) ?? 0) !== menu.doc) return;
    const frame = contents.mainFrame as FrameRef | null;
    if (!sameFrame(frame, menu.frame) || frame?.origin !== menu.origin || typeof frame.send !== 'function') return;
    const fill: PasswordsFill = {
      formId: menu.formId,
      username: account.username,
      // A first step has no password field: the password stays in main.
      ...(menu.kind === 'username-only' ? {} : { password }),
      highlight: { color: host.accent(menu.tab.nodeId) ?? 'Highlight', ms: durations.fillHighlight, stagger: durations.stagger, easing: easing.standard },
    };
    frame.send(PASSWORDS_FILL, fill);
  }

  private close(menu: Menu): void {
    if (this.menus.get(menu.tab.windowId) !== menu) return;
    this.menus.delete(menu.tab.windowId);
    // The keys it took keep the listener until their keyUp; with none, it goes now.
    if (this.guards.get(menu.contents)?.taken.size === 0 || menu.contents.isDestroyed()) this.unguardKeys(menu.contents);
    this.options.host.changed(menu.tab.windowId);
  }

  private menuOf(contents: WebContents): Menu | undefined {
    for (const menu of this.menus.values()) if (menu.contents === contents) return menu;
    return undefined;
  }

  private closeMenuOf(contents: WebContents): void {
    this.pending.delete(contents);
    const menu = this.menuOf(contents);
    if (menu) this.close(menu);
  }

  /** The switch or the extension rule changed: a card for a chord where passwords are off now goes, and what was typed with it. */
  switched(): void {
    for (const card of [...this.cards.values()]) if (!this.options.host.passwordsOn(card.tab.chordId)) this.dropCard(card);
  }

  /** The window's menu as its popover shows it. */
  menuFor(windowId: WindowId): PasswordMenu | null {
    const menu = this.menus.get(windowId);
    if (!menu) return null;
    return {
      id: menu.id,
      host: menu.host,
      state: menu.locked ? 'locked' : 'accounts',
      accounts: menu.accounts.map(({ username, host }) => ({ username, host })),
      index: menu.index,
      insecure: menu.insecure,
    };
  }

  /** Where the window's popover goes while its menu is open: under the field. */
  anchorFor(windowId: WindowId): MenuAnchor | null {
    const menu = this.menus.get(windowId);
    return menu ? { contents: menu.contents, rect: menu.rect, zoom: menu.zoom } : null;
  }

  /** The window's popover is synced: a menu whose page left the screen (another tab, another pane) closes. */
  check(windowId: WindowId): void {
    const menu = this.menus.get(windowId);
    // Gone, off screen, or moved to another window (its tab dragged out): the menu closes.
    if (menu && (menu.contents.isDestroyed() || !this.options.host.shown(menu.contents) || this.options.host.tabOf(menu.contents)?.windowId !== windowId)) this.close(menu);
  }

  /* ---------- the save and update cards ---------- */

  private async signedIn(e: PasswordDetectorEvents['signedIn'][0]): Promise<void> {
    const { host, vault } = this.options;
    const tab = host.tabOf(e.contents);
    // Never in a private window (the detector and the vault refuse too), only a sign-in, and only with what was typed.
    if (!tab || tab.private || !e.values || !SAVE_KINDS.has(e.kind)) return;
    const values = { ...e.values };
    // The candidate's own deadline: the card keeps what was typed no longer than the tracker would have.
    const until = e.valuesUntil ?? this.now() + HOLD_MS;
    // The document the sign-in ended on: if the tab commits another while the vault answers, the card would be for a
    // page you've left (and `leftSite`, which runs at that commit, found no card to drop yet).
    const doc = this.docs.get(e.contents) ?? 0;
    const here = () => !e.contents.isDestroyed() && (this.docs.get(e.contents) ?? 0) === doc;
    const answer = await vault.candidateFor({ origin: e.origin, username: values.username, password: values.password, chordId: tab.chordId });
    if (!here()) return;
    if (answer.kind !== 'new' && answer.kind !== 'update' && answer.kind !== 'locked') return;
    const site = await this.siteOf(e.origin).catch(() => null);
    if (!here() || until <= this.now()) return;
    const before = this.cards.get(tab.nodeId);
    if (before) this.dropCard(before, false);
    const card: Card = {
      id: this.nextId++,
      tab,
      contents: e.contents,
      origin: e.origin,
      site,
      host: hostOf(e.origin),
      kind: answer.kind === 'update' ? 'update' : 'new',
      locked: answer.kind === 'locked',
      setup: answer.kind === 'new' && answer.setup,
      values,
      busy: false,
      problem: null,
      held: false,
      shown: true,
      idle: null,
      expiry: null,
    };
    card.expiry = this.setTimer(() => this.dropCard(card), until - this.now());
    this.cards.set(tab.nodeId, card);
    this.startTimer(card);
    host.changed(tab.windowId);
  }

  /** A minute unused, while it's shown and you're not in it: it hides (the key brings it back). */
  private startTimer(card: Card): void {
    if (card.idle !== null) this.clearTimer(card.idle);
    card.idle = card.held || !card.shown ? null : this.setTimer(() => this.hideCard(card), SAVE_CARD_MS);
  }

  /** × or a minute unused: off screen, still there for the key in the address until the candidate ends. */
  private hideCard(card: Card): void {
    if (this.cards.get(card.tab.nodeId) !== card || !card.shown) return;
    card.shown = false;
    card.held = false;
    this.startTimer(card);
    this.options.host.offer(card.tab.nodeId, true);
    this.options.host.changed(this.windowOf(card));
  }

  /** The key in the address: the tab's card again, as it was. */
  reopen(windowId: WindowId, nodeId: string): void {
    const card = this.cards.get(nodeId);
    if (!card || card.shown || !card.values || this.windowOf(card) !== windowId) return;
    card.shown = true;
    this.startTimer(card);
    this.options.host.offer(nodeId, false);
    this.options.host.changed(windowId);
  }

  /** The card goes, and what was typed with it. */
  private dropCard(card: Card, notify = true): void {
    for (const timer of [card.idle, card.expiry]) if (timer !== null) this.clearTimer(timer);
    card.idle = card.expiry = null;
    card.values = null;
    if (this.cards.get(card.tab.nodeId) !== card) return;
    this.cards.delete(card.tab.nodeId);
    if (!card.shown) this.options.host.offer(card.tab.nodeId, false);
    if (notify) this.options.host.changed(this.windowOf(card));
  }

  private dropCardsOf(contents: WebContents): void {
    for (const card of [...this.cards.values()]) if (card.contents === contents) this.dropCard(card);
  }

  /** A page of the tab committed: the card goes once you've left the site it's for. */
  private async leftSite(contents: WebContents, url: string): Promise<void> {
    const card = [...this.cards.values()].find((c) => c.contents === contents);
    if (!card) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = 'null';
    }
    const site = origin === 'null' ? null : await this.siteOf(origin).catch(() => null);
    if (this.cards.get(card.tab.nodeId) !== card) return;
    if (site === null || card.site === null ? origin !== card.origin : site !== card.site) this.dropCard(card);
  }

  /** The tab's card as its window's popover shows it: the username, never the password. */
  cardFor(nodeId: string | null): PasswordSaveCard | null {
    const card = nodeId ? this.cards.get(nodeId) : undefined;
    if (!card?.values || !card.shown) return null;
    return { id: card.id, kind: card.kind, host: card.host, username: card.values.username, setup: card.setup, busy: card.busy, problem: card.problem };
  }

  /** The window the card's tab is in now (a tab can move to another window). */
  private windowOf(card: Card): WindowId {
    return (!card.contents.isDestroyed() && this.options.host.tabOf(card.contents)?.windowId) || card.tab.windowId;
  }

  private cardById(windowId: WindowId, id: number): Card | undefined {
    for (const card of this.cards.values()) if (card.id === id && card.values && card.shown && this.windowOf(card) === windowId) return card;
    return undefined;
  }

  /** The card's eye: its password, for its own window's popover only. */
  reveal(windowId: WindowId, id: number): { password: string } | null {
    const card = this.cardById(windowId, id);
    return card?.values ? { password: card.values.password } : null;
  }

  /** The card's buttons, from its window's popover (the sender, checked by the caller). */
  async answer(windowId: WindowId, id: number, action: 'save' | 'never' | 'close' | 'hold' | 'release', details: { username?: string; passphrase?: string } = {}): Promise<void> {
    const card = this.cardById(windowId, id);
    if (!card || (card.busy && action !== 'hold' && action !== 'release')) return;
    switch (action) {
      case 'close':
        // Hidden, not gone: the key in the address brings it back while the candidate lasts.
        return this.hideCard(card);
      case 'hold':
      case 'release':
        card.held = action === 'hold';
        return this.startTimer(card);
      case 'never':
        return this.never(card);
      case 'save':
        return this.save(card, details);
    }
  }

  private async never(card: Card): Promise<void> {
    const { vault } = this.options;
    card.busy = true;
    this.options.host.changed(this.windowOf(card));
    let done = await vault.neverFor(card.origin, card.tab.chordId);
    // Locked: the site list is in the vault, so it asks first.
    if (!done && (await vault.askUnlock(this.windowOf(card)))) done = await vault.neverFor(card.origin, card.tab.chordId);
    if (this.cards.get(card.tab.nodeId) !== card) return;
    card.busy = false;
    if (done) this.dropCard(card);
    else this.options.host.changed(this.windowOf(card));
  }

  private async save(card: Card, details: { username?: string; passphrase?: string }): Promise<void> {
    const { host, vault } = this.options;
    if (!card.values) return;
    if (card.setup && details.passphrase === undefined) return;
    card.busy = true;
    card.problem = null;
    host.changed(this.windowOf(card));
    /**
     * The request, made from what the card holds now, each time it's sent: nothing here keeps the password while the
     * unlock card waits, so a card that goes meanwhile (the candidate's deadline, the site left) leaves no copy behind.
     */
    const request = () => {
      const values = this.cards.get(card.tab.nodeId) === card ? card.values : null;
      if (!values) return null;
      // An update is for the username it was offered for; a new one takes the username as you left it.
      const username = card.kind === 'update' ? values.username : (details.username ?? values.username);
      return { origin: card.origin, username, password: values.password, chordId: card.tab.chordId, ...(card.setup && details.passphrase !== undefined ? { passphrase: details.passphrase } : {}) };
    };
    const send = (r: NonNullable<ReturnType<typeof request>>) => vault.saveCandidate(r).catch(() => ({ ok: false as const, problem: 'io' as const }));
    const setup = card.setup;
    const first = request();
    if (!first) return;
    let saved = await send(first);
    // Locked: unlock, then save again, unless the card went meanwhile (taking its values with it).
    if (!saved.ok && saved.problem === 'locked' && (await vault.askUnlock(this.windowOf(card)))) {
      const again = request();
      if (again) saved = await send(again);
    }
    if (this.cards.get(card.tab.nodeId) !== card) return;
    card.busy = false;
    if (saved.ok) {
      this.dropCard(card);
      // The first one: where it went.
      if (setup) host.toast(this.windowOf(card), 'passwords:saved', 'Saved. It’s in Settings → Passwords.');
      return;
    }
    switch (saved.problem) {
      case 'none':
        // The vault went (Start over) since the card came: this one sets the passphrase now.
        card.setup = true;
        break;
      case 'locked':
        // The unlock card was cancelled: the save card stays, to try again.
        break;
      case 'off':
      case 'never':
      case 'refused':
        return this.dropCard(card);
      default:
        card.problem = 'io';
    }
    host.changed(this.windowOf(card));
  }

  /** A window closed: its menu and its tabs' cards go. */
  windowClosed(windowId: WindowId): void {
    const menu = this.menus.get(windowId);
    if (menu) this.close(menu);
    this.grace.delete(windowId);
    for (const card of [...this.cards.values()]) if (this.windowOf(card) === windowId) this.dropCard(card, false);
  }
}
