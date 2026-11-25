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
 * - **Generating (S17 §6, phase 2).** A new password's field (a sign-up form's, a change form's new one) takes
 *   focus → *Use a strong password*, made in main (`generator.ts`, `crypto.randomInt`) to the field's rules and the
 *   site's. Choosing it saves it at once (`presave`: no username yet, *Not confirmed*; the unlock card first when
 *   locked, the save card's passphrase step when there's no vault yet), then fills it into the new password's field
 *   and the confirmation's. The tab keeps that presave for the site for a while (`PRESAVE_MS`): a second step's
 *   confirmation, or the page reloaded, is offered the same password rather than a new one. Its submit gives the entry
 *   its username (`submitted`), and a sign-in that worked confirms it, and says so (the `saved` card: **Done**,
 *   *Delete it*). The row comes first, built like an account's (the owner's design 3A, 2026-11-17), the accounts and
 *   *Other passwords…* after it; ↻ by click, or by `PASSWORD_REGENERATE_KEYS` while the menu is open.
 * - **Sign-up and change forms.** A sign-up that worked with a password you typed gets the save card, with a sign-up's
 *   title. A change form's account is the saved one whose password equals its current field (by its username first,
 *   where it has one): one → the update card (a generated one's too, applied only on **Update**); none or several →
 *   the card asks which with the sign-in box's chooser (`change`), or *Save as new* (the owner's design 5A).
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
import { trimAppendedCode, type WindowId } from '@chord/core';
import { PASSWORDS_FILL, type PasswordMenu, type PasswordSaveCard, type PasswordsFill } from '@chord/ipc';
import { durations, easing } from '@chord/tokens';
import type { Input, WebContents, WebFrameMain } from 'electron';
import type { PasswordDetectorEvents, PasswordsFocusEvent } from './detector';
import { keyIdOf, routeMenuKey, routeTakenKey, TAKEN_KEY_PATIENCE } from './menu-keys';
import { isAgentInput } from '../control/input';
import { onUserLease, userTabCatching } from '../control/user-watch';
import { generatePasswordFor, type Generated } from './generator';
import { HOLD_MS, type CandidateValues } from './saving';
import type { PasswordService } from './service';

/** How long the save card stays unused (S17 §9: a minute ⚠). It doesn't go while you're in it. */
export const SAVE_CARD_MS = 60_000;
/** After a press on the menu, how long the field's blur (the popover took focus) doesn't close it (M0 §3). */
export const CLICK_GRACE_MS = 1000;

/** The forms the menu fills an account into: sign-in forms and their first steps, and a change form's current password. */
const MENU_KINDS = new Set(['sign-in', 'username-only', 'unknown', 'change']);
const MENU_ROLES = new Set(['username', 'current-password']);
/** The fields the generator's row is offered on (S17 §6): a new password's and its confirmation's, in any form but a first step. */
const NEW_ROLES = new Set(['new-password', 'confirmation-password']);
/** The forms a new account's save is offered for: a sign-in, and a sign-up (S17 §6, phase 2). */
const SAVE_KINDS = new Set(['sign-in', 'unknown', 'sign-up']);
/** The forms whose account is found by their current password (S17 §6): a change form, and a reset form (no current one). */
const CHANGE_KINDS = new Set(['change', 'reset']);
/**
 * How long a tab keeps a generated password it saved for a site, to offer it again (a confirmation on a second step,
 * the page reloaded) and to give it the username its submit had. The entry itself stays in the vault, *Not
 * confirmed*, whatever happens to this.
 */
const PRESAVE_MS = 10 * 60_000;
/**
 * How long a tab keeps the username a first step was submitted with (S17 §4, phase 3: Chromium's `possible_usernames_`),
 * for the password step after it: as long as a typed sign-in is held.
 */
const FIRST_STEP_MS = HOLD_MS;

export interface AssistTab {
  readonly nodeId: string;
  readonly windowId: WindowId;
  /** The tab's chord; a private window's is fill only (the vault knows it by this id). */
  readonly chordId: string | null;
  readonly private: boolean;
}

interface PasswordAssistHost {
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

export type AssistVault = Pick<
  PasswordService,
  'accountsFor' | 'passwordFor' | 'candidateFor' | 'saveCandidate' | 'neverFor' | 'askUnlock' | 'generatorFor' | 'presave' | 'presaved' | 'changeAccounts' | 'changePassword' | 'deleteSaved'
>;

export interface PasswordAssistOptions {
  readonly vault: AssistVault;
  /** Its events, and whether a page's navigation during a late window is still being judged (S17 §6, phase 3A-2). */
  /** `judging`: required, so an assist without it can't save a sign-in nobody judged (review round 3 of #62). */
  readonly detector: { readonly events: EventEmitter<PasswordDetectorEvents>; judging(contents: WebContents): boolean };
  readonly host: PasswordAssistHost;
  readonly now?: () => number;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  /** The site of an origin (its registrable domain), for the card that goes when you leave it. */
  readonly siteOf?: (origin: string) => Promise<string | null>;
  /** A strong password for a field on a page of an origin, with its rules in words, or null when they can't be met (`generator.ts`). */
  readonly generate?: (origin: string, rules: GeneratorRules) => Promise<Generated | null>;
}

/** What a new password's field says of the passwords it takes (`passwords:focus`'s `rules`). */
export type GeneratorRules = NonNullable<PasswordsFocusEvent['rules']>;
const NO_RULES: GeneratorRules = { passwordrules: '', minLength: -1, maxLength: -1 };

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
  /**
   * The form's kind, as the agent last said (a `focus` or `forms` for this form): a first step (`username-only`) has
   * no password field, so no password is sent to it. Read when you pick, not when the menu opened: a page that shows
   * its password field once the email has focus is a sign-in by then.
   */
  kind: string;
  rect: MenuAnchor['rect'];
  zoom: number;
  readonly host: string;
  readonly locked: boolean;
  readonly insecure: boolean;
  readonly accounts: readonly { id: string; username: string; host: string | null; madeAt?: number }[];
  index: number;
  /** When it opened (Enter waits `durations.promptInputDelay` on the generator's row). */
  readonly openedAt: number;
  /**
   * On a new password's field: the generator's row, first, its password and its rules in words, the field's rules
   * (for ↻), and whether it's the tab's presave offered again (`again`). `vault`: what choosing it asks first.
   */
  generate?: { password: string; rule: string | null; strong: boolean; again: boolean; vault: 'open' | 'locked' | 'none'; readonly rules: GeneratorRules };
}

/**
 * A generated password the tab saved for a site (S17 §6): its entry in the vault, the form it was filled into, and,
 * in memory until `PRESAVE_MS` after, its password, to offer it again and to tell its submit.
 */
interface Presave {
  readonly id: string;
  readonly origin: string;
  readonly site: string | null;
  readonly doc: number;
  readonly formId: string;
  /** The form's kind when it was filled: another document's form takes this entry only if it's of the same kind. */
  readonly kind: string;
  password: string;
  /** Its rules in words, and whether it's strong, for the row that offers it again. */
  readonly rule: string | null;
  readonly strong: boolean;
  /** A submit signal came since it was filled: the site may have it now, so ↻ makes another entry rather than changing this one. */
  submitted: boolean;
  timer: unknown;
}

/**
 * A first step's username, for the tab and site (its registrable domain, as saving reads it): in memory only, never from
 * a private window. Used at most once: the next sign-in on its site, worked or failed, card or not, takes it away
 * (review of 3A-1: a second account's password step mustn't get the first one's). Gone too at `FIRST_STEP_MS`, when
 * passwords are turned off there, or the tab closes; a newer first step on the same site replaces it.
 */
interface FirstStep {
  readonly site: string;
  username: string;
  timer: unknown;
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
  /** From the browser's own sign-in box (S17 §10): its realm. */
  readonly realm?: string;
  readonly site: string | null;
  readonly host: string;
  /** `refused`: a generated password's saved card, after a late error took the sign-in back (the owner's design 3A). */
  kind: 'new' | 'update' | 'change' | 'saved' | 'refused';
  /** A sign-up's save card: its own title. */
  signUp?: boolean;
  /** `change`: the accounts it asks between (the site's, or those with the form's current password); `update`: the one matched. */
  accounts?: readonly { id: string; username: string }[];
  /** A generated password saved for this form (S17 §6): Save confirms or applies it, rather than saving another. */
  presaved?: string;
  /** A generated password with no vault yet: Save chooses the passphrase, saves it, then fills it as the menu would have. */
  generated?: { readonly menu: Menu };
  /**
   * A change's card made while locked: the form's current password, to find the account once unlocked, and the
   * username the form showed. Held only as long as the card (`dropCard` clears it), as what was typed is.
   */
  change?: { current: string | null; readonly shown: string };
  /** The vault was locked when it was offered: Save asks to unlock first, and the vault decides new or update then. */
  locked: boolean;
  setup: boolean;
  /** What was typed, until the card goes. */
  values: CandidateValues | null;
  /**
   * A new sign-in on a site that takes a code after the password (S17 §6 phase 3D, the owner's design 1A): the
   * password as typed and the one without the code, and which `values` holds (what Save saves and the eye shows).
   * Held only as long as the card, as `values` is.
   */
  code?: { typed: string; trimmed: string; kept: boolean } | null;
  /**
   * A sign-in read from its form going (no navigation): until when a late request error can still take it back (the
   * tracker's `lateUntil`). Save, Update and *Save as new* pressed before then wait (S17 §6, phase 3A-2).
   */
  lateUntil?: number | null;
  /** What was pressed while the late window was open, and its timer: run when the window closes, unless a late error comes. */
  waiting?: { readonly action: 'save' | 'new'; readonly details: { username?: string; passphrase?: string; account?: number }; timer: unknown } | null;

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

/**
 * Which card a change gets (S17 §6, the owner's decision): the account is the saved one whose password is the form's
 * current one; the form's username only picks among several. One → update; none or several → the chooser, among
 * those that matched or, when none did, the site's; none saved at all → a new one. The change's own presave is
 * never among them.
 */
export function changeCard(
  found: { matches: readonly { id: string; username: string }[]; accounts: readonly { id: string; username: string }[] },
  values: { username: string; password: string },
  presaved?: string,
): { kind: 'update' | 'change' | 'new'; values: CandidateValues; accounts?: { id: string; username: string }[] } {
  const own = (a: { id: string }) => a.id !== presaved;
  const matched = found.matches.filter(own);
  const byName = values.username && matched.length > 1 ? matched.filter((a) => a.username === values.username) : [];
  const matches = byName.length === 1 ? byName : matched;
  if (matches.length === 1) return { kind: 'update', values: { username: matches[0]!.username, password: values.password }, accounts: [matches[0]!] };
  const among = matches.length > 1 ? matches : found.accounts.filter(own);
  if (!among.length) return { kind: 'new', values: { username: values.username, password: values.password } };
  return { kind: 'change', values: { username: among[0]!.username, password: values.password }, accounts: [...among] };
}

/** The menu's accounts with the one a first step was submitted with first (by username, ignoring case), else as they were. */
function firstStepFirst<T extends { readonly username: string }>(accounts: readonly T[], username: string): T[] {
  const wanted = username.trim().toLowerCase();
  const i = accounts.findIndex((a) => a.username.trim().toLowerCase() === wanted);
  return i <= 0 ? [...accounts] : [accounts[i]!, ...accounts.slice(0, i), ...accounts.slice(i + 1)];
}

export class PasswordAssist {
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly siteOf: (origin: string) => Promise<string | null>;
  private nextId = 1;
  private seq = 0;
  private readonly menus = new Map<WindowId, Menu>();
  private readonly pending = new Map<WebContents, Pending>();
  /**
   * A form whose menu was answered (a choice, Escape), with the field's role and the form's kind then: no menu again in
   * it until a real blur. Lifted only when both change: a first step that turned into its password step in place (no
   * blur, the page moved focus to the password). The same field, its form changing kind as you type, stays quiet, and
   * so does the other field of a one-step form.
   */
  private readonly quiet = new Map<WebContents, { formId: string; role: string; kind: string; generate: boolean }>();
  /** Each tab page's generated password, saved for a site (S17 §6). */
  private readonly presaves = new Map<WebContents, Presave>();
  /** Each tab page's `failed` events, counted: a sign-in being offered checks it after each wait (review round 4 of #59). */
  private readonly failures = new WeakMap<WebContents, number>();
  /**
   * A generated password's confirmation, waiting for the late window to close (S17 §6, phase 3A-2): its entry, what it
   * takes, and the card that says it's saved. A late error leaves the entry *Not confirmed* and turns the card.
   */
  private readonly confirms = new Map<
    WebContents,
    { readonly id: string; readonly origin: string; readonly chordId: string | null; values: { username?: string; password: string } | null; card: Card | null; timer: unknown }
  >();
  /** Each tab page's last first step's username, by site (S17 §4, phase 3). */
  private readonly firstSteps = new Map<WebContents, Map<string, FirstStep>>();
  /** Rules each page asked for that can't be met (`makeFor`). */
  private readonly unmet = new WeakMap<WebContents, Set<string>>();
  private readonly generate: (origin: string, rules: GeneratorRules) => Promise<Generated | null>;
  /** A press on a window's menu: the blur it causes doesn't close it, until then. */
  private readonly grace = new Map<WindowId, { until: number; contents: WebContents }>();
  private readonly docs = new WeakMap<WebContents, number>();
  /** Each page's forms' kinds, from the agent's last `forms` (until its next document). */
  private readonly kinds = new WeakMap<WebContents, ReadonlyMap<string, string>>();
  private readonly cards = new Map<string, Card>();
  private readonly guards = new Map<WebContents, KeyGuard>();

  /** Stops hearing the assistant's leases (dispose). */
  private readonly offLease: () => void;

  constructor(private readonly options: PasswordAssistOptions) {
    // The assistant beginning to act in a tab of yours (S18 M2e-2a): a menu open there closes (Neon's B7 on #147).
    this.offLease = onUserLease((contents) => {
      for (const menu of [...this.menus.values()]) if (menu.contents === contents) this.close(menu);
    });
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.siteOf = options.siteOf ?? (async (origin) => (await import('@chord/core/password-sites')).loginSite(origin));
    this.generate = options.generate ?? generatePasswordFor;
    const { events } = options.detector;
    events.on('submitted', (e) => void this.submitted(e));
    events.on('firstStep', (e) => void this.firstStep(e));
    events.on('focus', (e) => void this.focused(e));
    events.on('blur', (e) => this.blurred(e.contents));
    events.on('signedIn', (e) => void this.signedIn(e));
    // A sign-in there that failed: what an earlier one left to save is no longer what you use.
    events.on('failed', (e) => {
      // You submitted again while a late window's navigation was judged: what was held for that sign-in goes quietly
      // (no toast claims a refusal), before the new submit's `submitted` (review round 3 of #62).
      if (e.why === 'superseded') return this.dropLate(e.contents, null);
      // Counted, so a sign-in being offered while this came is dropped after its next wait (review round 4 of #59).
      this.failures.set(e.contents, (this.failures.get(e.contents) ?? 0) + 1);
      // A save or update pressed while the late window was open: cancelled, and the window's toast says why.
      this.cancelWaiting(e.contents);
      // A generated password whose confirmation was waiting on the window: never confirmed; its card says so.
      this.refuseConfirm(e.contents);
      // Every other card of the tab goes; the refused one is what tells.
      for (const card of [...this.cards.values()]) if (card.contents === e.contents && card.kind !== 'refused') this.dropCard(card);
      // The first step's username was for this sign-in; a retry, or another account, doesn't get it.
      void this.takeFirstStep(e.contents, e.origin);
      // The site didn't take it: the tab's presave there is as if never submitted, so ↻ changes it rather than making
      // another (review round 1 of #53).
      const kept = this.presaveFor(e.contents, e.origin);
      // Only the form it was filled into (review round 2 of #53): a sign-in that failed elsewhere on the site says
      // nothing about it.
      if (kept && e.formId === kept.formId) kept.submitted = false;
    });
    // That navigation reached its cap unjudged: a pressed save is cancelled with the toast, an unpressed card and a held
    // confirmation go. A miss is a missing offer, never a save nobody judged (review round 3 of #62).
    events.on('lateUnjudged', (e) => this.dropLate(e.contents, 'unjudged'));
    events.on('forms', (e) => {
      const kinds = new Map(e.forms.map((f) => [f.formId, f.kind] as const));
      this.kinds.set(e.contents, kinds);
      const menu = this.menuOf(e.contents);
      const kind = menu && kinds.get(menu.formId);
      if (!menu || !kind || kind === menu.kind) return;
      // Now a form the menu isn't for (a sign-up's, for accounts; a first step, for the generator): it goes.
      if (menu.generate ? kind === 'username-only' : !MENU_KINDS.has(kind)) this.close(menu);
      else menu.kind = kind;
    });
    events.on('filled', (e) => {
      if (e.ok) return;
      // Said without a value: a generated password saved but not filled stays in the vault, Not confirmed, and in Settings.
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
      // A navigation of your own (the address bar, a bookmark, Back), not the page's: the candidate ends, and a generated
      // password's confirmation waiting on the late window with it.
      if (!details.initiator) {
        this.dropCardsOf(contents);
        this.dropConfirm(contents);
      }
      // The page's own, during a late window: the tracker judges what it leads to (`judging`), and a held save or confirm
      // that comes due before then doesn't go ahead. Read when it comes due, so a card made after the navigation began
      // is covered too (review round 2 of #62).
    });
    contents.on('did-navigate', (_event, url) => {
      this.docs.set(contents, (this.docs.get(contents) ?? 0) + 1);
      this.kinds.delete(contents);
      this.closeMenuOf(contents);
      // A new document numbers its forms from f1 again: "not again in this form" was the last page's.
      this.quiet.delete(contents);
      void this.leftSite(contents, url);
      void this.leftPresaveSite(contents, url);
    });
    contents.once('destroyed', () => {
      this.closeMenuOf(contents);
      this.guards.delete(contents);
      this.pending.delete(contents);
      this.quiet.delete(contents);
      this.dropCardsOf(contents);
      this.dropPresave(contents);
      this.dropFirstSteps(contents);
      this.dropConfirm(contents);
    });
  }

  /* ---------- the menu ---------- */

  private async focused(e: PasswordsFocusEvent): Promise<void> {
    const { host, vault } = this.options;
    const tab = host.tabOf(e.contents);
    if (!tab) return;
    const open = this.menuOf(e.contents);
    // The assistant acting in this tab (S18 M2e-2a, A4; Neon's B2): its click or focus never opens your passwords, and
    // a menu open as it starts closes.
    // The assistant's whole lease, its after-window too (Neon's S2 on #150): its click's effects may still be landing.
    if (userTabCatching(e.contents)) {
      this.pending.delete(e.contents);
      if (open) this.close(open);
      return;
    }
    // A new password's field: the generator's row (never in a private window, which never saves). Otherwise an account's.
    const generating = NEW_ROLES.has(e.role) && e.kind !== 'username-only' && !tab.private;
    if (!generating && (!MENU_KINDS.has(e.kind) || !MENU_ROLES.has(e.role))) {
      // A code's field, a sign-up's username: no menu.
      this.pending.delete(e.contents);
      if (open) this.close(open);
      return;
    }
    // A focus is newer than any `forms` before it: its kind is the form's now.
    this.kinds.set(e.contents, new Map(this.kinds.get(e.contents)).set(e.formId, e.kind));
    // The menu's field moved (a scroll, a zoom), or its form's kind changed: the menu follows it. Not from an account's
    // field to a new password's (a change form's), or back: that's the other menu.
    if (open && open.formId === e.formId && !!open.generate === generating) {
      open.kind = e.kind;
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
    const quiet = this.quiet.get(e.contents);
    if ((quiet?.formId === e.formId && quiet.generate === generating && (quiet.role === e.role || quiet.kind === e.kind)) || !host.shown(e.contents)) return;
    host.prepareMenu(tab.windowId);
    const seq = ++this.seq;
    const pending: Pending = { seq, formId: e.formId, role: e.role, rect: e.rect, zoom: e.zoomFactor };
    this.pending.set(e.contents, pending);
    const doc = this.docs.get(e.contents) ?? 0;
    if (generating) return this.focusedNew(e, tab, pending, doc);
    const [answer, stepped] = await Promise.all([
      vault.accountsFor(e.origin, tab.chordId).catch(() => ({ state: 'off' as const })),
      e.role === 'current-password' ? this.firstStepFor(e.contents, e.origin) : Promise.resolve(null),
    ]);
    // A blur, another field, or another page since: this answer is for nothing on screen.
    if (this.pending.get(e.contents) !== pending) return;
    this.pending.delete(e.contents);
    if (e.contents.isDestroyed() || (this.docs.get(e.contents) ?? 0) !== doc || !host.shown(e.contents)) return;
    if (answer.state !== 'open' && answer.state !== 'locked') return;
    const offered = answer.state === 'open' ? answer.offers.map((o) => ({ id: o.id, username: o.username, host: o.host !== hostOf(e.origin) ? o.host : null })) : [];
    if (answer.state === 'open' && offered.length === 0) return;
    // A password step after a first step on the site: the account it was submitted with comes first (S17 §4).
    const accounts = stepped ? firstStepFirst(offered, stepped) : offered;
    const menu: Omit<Menu, 'openedAt'> = {
      id: this.nextId++,
      tab,
      contents: e.contents,
      frame: e.frame,
      origin: e.origin,
      doc,
      formId: e.formId,
      role: e.role,
      // A `forms` that came while the vault answered is newer than the focus.
      kind: this.kinds.get(e.contents)?.get(e.formId) ?? e.kind,
      rect: pending.rect,
      zoom: pending.zoom,
      host: hostOf(e.origin),
      locked: answer.state === 'locked',
      insecure: answer.state === 'open' && answer.insecure,
      accounts,
      index: 0,
    };
    this.openMenu(menu);
  }

  private openMenu(made: Omit<Menu, 'openedAt'>): void {
    // Asked again right here, after the vault's answer: the assistant may have begun acting in the tab meanwhile
    // (Neon's B7 on #147). Its focus never opens your passwords.
    if (userTabCatching(made.contents)) return;
    const menu: Menu = { ...made, openedAt: this.now() };
    // One menu a window: another pane's, still open, closes first (its keys with it).
    const replaced = this.menus.get(menu.tab.windowId);
    if (replaced) this.close(replaced);
    this.menus.set(menu.tab.windowId, menu);
    this.guardKeys(menu.contents);
    this.options.host.changed(menu.tab.windowId);
  }

  /**
   * A new password's field took focus (S17 §6): the generator's row, with the tab's presave for the site offered again
   * if there is one, else a new password to the field's rules and the site's. None when passwords are off here, or
   * the rules can't be met.
   */
  private async focusedNew(e: PasswordsFocusEvent, tab: AssistTab, pending: Pending, doc: number): Promise<void> {
    const { host, vault } = this.options;
    const rules = e.rules ?? NO_RULES;
    const vaultState = await vault.generatorFor(e.origin, tab.chordId).catch(() => 'off' as const);
    // The tab's presave is offered again only while the vault is open (security review): locked, or started over, it's
    // forgotten here (the entry stays in the vault), and a new password is made.
    if (vaultState !== 'open') this.dropPresave(e.contents);
    const kept = this.presaveFor(e.contents, e.origin);
    const made = vaultState === 'off' ? null : kept ? { password: kept.password, rule: kept.rule, strong: kept.strong } : await this.makeFor(e.contents, e.origin, rules);
    // The saved accounts follow it (the owner's design 3A): a sign-in read as a sign-up, a change form's.
    const answer = vaultState === 'open' ? await vault.accountsFor(e.origin, tab.chordId).catch(() => ({ state: 'off' as const })) : null;
    if (this.pending.get(e.contents) !== pending) return;
    this.pending.delete(e.contents);
    if (vaultState === 'off' || e.contents.isDestroyed() || (this.docs.get(e.contents) ?? 0) !== doc || !host.shown(e.contents)) return;
    const accounts =
      answer?.state === 'open'
        ? answer.offers
            // The tab's presave, offered again as the generator's row, isn't listed twice.
            .filter((o) => o.id !== kept?.id)
            .map((o) => ({ id: o.id, username: o.username, host: o.host !== hostOf(e.origin) ? o.host : null, ...(o.madeAt !== undefined ? { madeAt: o.madeAt } : {}) }))
        : [];
    // Rules that can't be met: the accounts alone, if there are any.
    if (!made && !accounts.length) return;
    this.openMenu({
      id: this.nextId++,
      tab,
      contents: e.contents,
      frame: e.frame,
      origin: e.origin,
      doc,
      formId: e.formId,
      role: e.role,
      kind: this.kinds.get(e.contents)?.get(e.formId) ?? e.kind,
      rect: pending.rect,
      zoom: pending.zoom,
      host: hostOf(e.origin),
      locked: false,
      insecure: answer?.state === 'open' && answer.insecure,
      accounts,
      // A form that reads as a sign-in, its password field carrying `autocomplete=new-password` (sites do): the first
      // account is highlighted, the generator's row still first (review round 1 of #53).
      index: made && accounts.length && e.kind === 'sign-in' ? 1 : 0,
      ...(made ? { generate: { password: made.password, rule: made.rule, strong: made.strong, again: kept !== null, vault: vaultState, rules } } : {}),
    });
  }

  /**
   * A password to a field's rules, or null; rules that can't be met are remembered for the document, so a page that
   * moves focus between such fields in a loop costs main one generation each, not one a focus (security review).
   */
  private async makeFor(contents: WebContents, origin: string, rules: GeneratorRules): Promise<Generated | null> {
    const key = `${this.docs.get(contents) ?? 0}\0${origin}\0${rules.passwordrules}\0${rules.minLength}\0${rules.maxLength}`;
    const unmet = this.unmet.get(contents);
    if (unmet?.has(key)) return null;
    const made = await this.generate(origin, rules).catch(() => null);
    if (made === null) {
      const set = unmet ?? new Set<string>();
      // A page making new rules in a loop: the set is cut back rather than grown without end.
      if (set.size >= 64) set.clear();
      set.add(key);
      this.unmet.set(contents, set);
    }
    return made;
  }

  /** The menu's ↻: another password, to the same rules (from its window's popover, checked by the caller). */
  async regenerate(windowId: WindowId, id: number): Promise<void> {
    const menu = this.menus.get(windowId);
    if (!menu?.generate || menu.id !== id) return;
    const made = await this.makeFor(menu.contents, menu.origin, menu.generate.rules);
    if (made === null || this.menus.get(windowId) !== menu || !menu.generate) return;
    menu.generate = { ...menu.generate, password: made.password, rule: made.rule, strong: made.strong, again: false };
    this.options.host.changed(windowId);
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
    // Keys Chord sends for the assistant or an agent (control/input.ts) are the page's, never the menu's: Enter there
    // never fills a saved password (Neon's B2 on the M2e plan).
    if (isAgentInput(contents)) return;
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
    const routed = routeMenuKey({ index: menu.index, rows: this.rowsOf(menu), regenerate: !!menu.generate }, input);
    if (routed.take) {
      event.preventDefault();
      guard.taken = new Set([...guard.taken, keyIdOf(input)]);
      guard.patience = TAKEN_KEY_PATIENCE;
    }
    if (routed.regenerate) return void this.regenerate(menu.tab.windowId, menu.id);
    // A page can focus a new password's field by script just as you press Enter elsewhere: the generator's row, which
    // saves and fills, doesn't take an Enter in its first moments (as the sign-in box's buttons don't; security review).
    if (routed.choose !== undefined && menu.generate && this.now() - menu.openedAt < durations.promptInputDelay) return;
    if (routed.choose !== undefined) return void this.choose(menu, routed.choose);
    if (!routed.menu) {
      // Escape: not again in this form until you leave it. Tab: the page moves on, and the next field may get its own.
      if (input.key === 'Escape') this.quiet.set(menu.contents, { formId: menu.formId, role: menu.role, kind: menu.kind, generate: !!menu.generate });
      this.close(menu);
      return;
    }
    if (routed.menu.index !== menu.index) {
      menu.index = routed.menu.index;
      this.options.host.changed(menu.tab.windowId);
    }
  }

  /** *Use a strong password* where there's one, the accounts, then *Other passwords…*; or the one *Unlock passwords* row. */
  private rowsOf(menu: Menu): number {
    return menu.locked ? 1 : (menu.generate ? 1 : 0) + menu.accounts.length + 1;
  }

  /** A row clicked in the window's popover (the sender, checked by the caller). */
  chooseRow(windowId: WindowId, id: number, index: number): void {
    const menu = this.menus.get(windowId);
    if (!menu || menu.id !== id || index >= this.rowsOf(menu)) return;
    // The generator's row takes no click in its first moments either, as it takes no Enter (security review).
    if (menu.generate && index === 0 && this.now() - menu.openedAt < durations.promptInputDelay) return;
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
    this.quiet.set(menu.contents, { formId: menu.formId, role: menu.role, kind: menu.kind, generate: !!menu.generate });
    if (menu.generate) {
      if (index === 0) return this.chooseGenerated(menu, menu.generate.password);
      // The rows after it are the accounts', one lower.
      index--;
    }
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
    // The kind as it is now (the menu closed when you picked; a `forms` since still counts).
    const kind = this.kinds.get(contents)?.get(menu.formId) ?? menu.kind;
    const fill: PasswordsFill = {
      formId: menu.formId,
      username: account.username,
      // A first step has no password field: the password stays in main.
      ...(kind === 'username-only' ? {} : { password }),
      // Picked on a new password's field: where the form has no current one, that field takes it.
      ...(NEW_ROLES.has(menu.role) && kind !== 'username-only' ? { intoNew: true as const } : {}),
      highlight: { color: host.accent(menu.tab.nodeId) ?? 'Highlight', ms: durations.fillHighlight, stagger: durations.stagger, easing: easing.standard },
    };
    frame.send(PASSWORDS_FILL, fill);
  }

  /** Whether the menu's page is still the frame, origin and document it was shown for (S17 §5): nothing is sent otherwise. */
  private frameFor(menu: Menu): (FrameRef & { send: WebFrameMain['send'] }) | null {
    const contents = menu.contents;
    if (contents.isDestroyed() || (this.docs.get(contents) ?? 0) !== menu.doc) return null;
    const frame = contents.mainFrame as FrameRef | null;
    if (!sameFrame(frame, menu.frame) || frame?.origin !== menu.origin || typeof frame.send !== 'function') return null;
    return frame as FrameRef & { send: WebFrameMain['send'] };
  }

  private highlight(menu: Menu): PasswordsFill['highlight'] {
    return { color: this.options.host.accent(menu.tab.nodeId) ?? 'Highlight', ms: durations.fillHighlight, stagger: durations.stagger, easing: easing.standard };
  }

  /**
   * *Use a strong password* (S17 §6): saved first, so it's never only in the page (asking to unlock, or for the first
   * passphrase, as needed), then filled into the form the menu was shown for, if that's still there. The tab's presave
   * offered again is only filled. A new one in the same form, before any submit, changes that entry rather than
   * making another.
   */
  private async chooseGenerated(menu: Menu, password: string, passphrase?: string): Promise<void> {
    const { host, vault } = this.options;
    const contents = menu.contents;
    // A page that went (another document, another frame) gets nothing, and leaves no presave behind (review round 1).
    if (!this.frameFor(menu)) return;
    let kept = this.presaveFor(contents, menu.origin);
    // Offered again, it's filled only from an open vault: locked since, it asks first (security review).
    if (kept && kept.password === password && (await vault.generatorFor(menu.origin, menu.tab.chordId).catch(() => 'off' as const)) !== 'open') {
      if (!(await vault.askUnlock(menu.tab.windowId))) return;
      kept = this.presaveFor(contents, menu.origin);
    }
    if (!(kept && kept.password === password)) {
      // The same form, or the site's page loaded again, and no submit since: that entry takes the new one (the one
      // before is kept as `previous`), rather than another being made (review round 1 of #53). Another form on the
      // same page is another entry.
      // Across documents, only a form of the same kind: a change form's never takes a sign-up's entry, nor the other
      // way round (review round 2 of #53).
      const sameForm = kept && !kept.submitted && (kept.doc !== menu.doc ? kept.kind === menu.kind : kept.formId === menu.formId);
      let id: string;
      let setup = false;
      if (kept && sameForm && (await vault.presaved('pending', kept.id, menu.origin, menu.tab.chordId, { password }).catch(() => false))) id = kept.id;
      else {
        const request = { origin: menu.origin, password, chordId: menu.tab.chordId, ...(passphrase !== undefined ? { passphrase } : {}) };
        const send = () => vault.presave(request).catch(() => ({ ok: false as const, problem: 'io' as const }));
        let saved = await send();
        if (!saved.ok && saved.problem === 'locked' && (await vault.askUnlock(menu.tab.windowId))) saved = await send();
        if (!saved.ok && saved.problem === 'none' && passphrase === undefined) {
          // No vault yet: the save card chooses the first passphrase, then saves and fills this.
          if (!contents.isDestroyed()) this.showCard({ tab: menu.tab, contents, origin: menu.origin, site: await this.siteOf(menu.origin).catch(() => null), kind: 'new', locked: false, setup: true, values: { username: '', password }, until: this.now() + HOLD_MS, generated: { menu } });
          return;
        }
        if (!saved.ok) {
          // Cancelled, or it couldn't be saved: nothing is filled, so nothing is lost.
          if (saved.problem !== 'locked' && saved.problem !== 'off') host.toast(menu.tab.windowId, 'passwords:fill', 'Chord couldn’t save the password, so it didn’t fill it.');
          return;
        }
        id = saved.id;
        setup = saved.setup;
      }
      if (contents.isDestroyed()) return;
      const site = await this.siteOf(menu.origin).catch(() => null);
      this.keepPresave(contents, { id, origin: menu.origin, site, doc: menu.doc, formId: menu.formId, kind: menu.kind, password, rule: menu.generate?.rule ?? null, strong: menu.generate?.strong ?? true, submitted: false });
      if (setup) host.toast(menu.tab.windowId, 'passwords:saved', 'Saved. It’s in Settings → Passwords.');
    }
    const frame = this.frameFor(menu);
    if (!frame) return;
    const fill: PasswordsFill = { formId: menu.formId, generated: password, highlight: this.highlight(menu) };
    frame.send(PASSWORDS_FILL, fill);
  }

  /* ---------- the tab's presave ---------- */

  private presaveFor(contents: WebContents, origin: string): Presave | null {
    const kept = this.presaves.get(contents);
    return kept && kept.origin === origin ? kept : null;
  }

  private keepPresave(contents: WebContents, made: Omit<Presave, 'timer'>): void {
    this.dropPresave(contents);
    const presave: Presave = { ...made, timer: null };
    presave.timer = this.setTimer(() => {
      if (this.presaves.get(contents) === presave) this.dropPresave(contents);
    }, PRESAVE_MS);
    this.presaves.set(contents, presave);
  }

  /** The tab forgets it (the entry stays in the vault, Not confirmed until a sign-in confirms it). */
  private dropPresave(contents: WebContents): void {
    const kept = this.presaves.get(contents);
    if (!kept) return;
    if (kept.timer !== null) this.clearTimer(kept.timer);
    kept.password = '';
    this.presaves.delete(contents);
  }

  /**
   * A submit signal of the form the tab's presave was filled into (S17 §6): the entry takes the username submitted,
   * where the form has one (a change form's is the account's, found when it works). The password isn't told here: a
   * sign-in that worked with another one gets the save card. Never in a private window (no values come from one).
   */
  private async submitted(e: PasswordDetectorEvents['submitted'][0]): Promise<void> {
    const kept = this.presaveFor(e.contents, e.origin);
    const tab = this.options.host.tabOf(e.contents);
    if (!kept || !tab || tab.private) return;
    if (kept.doc !== (this.docs.get(e.contents) ?? 0) || kept.formId !== e.formId) return;
    kept.submitted = true;
    if (CHANGE_KINDS.has(e.kind)) return;
    // A password step with no username of its own takes the first step's (S17 §4, phase 3).
    const doc = this.docs.get(e.contents) ?? 0;
    const username = e.values?.username || (e.values ? await this.firstStepFor(e.contents, e.origin) : null);
    // The presave may have gone while that was looked up (dropped, replaced, another document; review round 1 of #59).
    if (!username || this.presaves.get(e.contents) !== kept || (this.docs.get(e.contents) ?? 0) !== doc) return;
    await this.options.vault.presaved('pending', kept.id, e.origin, tab.chordId, { username }).catch(() => false);
  }

  /* ---------- a first step's username (S17 §4, phase 3) ---------- */

  /** A first step was submitted: its username is kept for the tab and site, for the password step after it. */
  private async firstStep(e: PasswordDetectorEvents['firstStep'][0]): Promise<void> {
    const { host } = this.options;
    const tab = host.tabOf(e.contents);
    if (!tab || tab.private || !host.passwordsOn(tab.chordId)) return;
    const site = await this.siteOf(e.origin).catch(() => null);
    // Again after the wait: the tab closed, or passwords turned off there, since (review round 1 of #59).
    const now = e.contents.isDestroyed() ? null : host.tabOf(e.contents);
    if (!site || !now || now.private || !host.passwordsOn(now.chordId)) return;
    // A newer first step replaces the one for its own site only (review of 3A-1).
    this.dropFirstStep(e.contents, site);
    const kept: FirstStep = { site, username: e.username, timer: null };
    kept.timer = this.setTimer(() => {
      if (this.firstSteps.get(e.contents)?.get(site) === kept) this.dropFirstStep(e.contents, site);
    }, FIRST_STEP_MS);
    let bySite = this.firstSteps.get(e.contents);
    if (!bySite) this.firstSteps.set(e.contents, (bySite = new Map()));
    bySite.set(site, kept);
  }

  /** The tab's first step's username for the site of `origin`, or null: to look at (the menu, a presave), not to use up. */
  private async firstStepFor(contents: WebContents, origin: string): Promise<string | null> {
    if (!this.firstSteps.get(contents)?.size) return null;
    const site = await this.siteOf(origin).catch(() => null);
    return (site && this.firstSteps.get(contents)?.get(site)?.username) || null;
  }

  /** A sign-in on the site of `origin` ended, worked or failed: its first step's username, which goes with it (used once). */
  private async takeFirstStep(contents: WebContents, origin: string): Promise<string | null> {
    if (!this.firstSteps.get(contents)?.size) return null;
    const site = await this.siteOf(origin).catch(() => null);
    const username = (site && this.firstSteps.get(contents)?.get(site)?.username) || null;
    if (site) this.dropFirstStep(contents, site);
    return username;
  }

  private dropFirstStep(contents: WebContents, site: string): void {
    const bySite = this.firstSteps.get(contents);
    const kept = bySite?.get(site);
    if (!bySite || !kept) return;
    if (kept.timer !== null) this.clearTimer(kept.timer);
    kept.username = '';
    bySite.delete(site);
    if (!bySite.size) this.firstSteps.delete(contents);
  }

  /** Every site's, for the tab (it closed, or passwords were turned off there). */
  private dropFirstSteps(contents: WebContents): void {
    for (const site of [...(this.firstSteps.get(contents)?.keys() ?? [])]) this.dropFirstStep(contents, site);
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
    for (const contents of [...this.presaves.keys()]) {
      const tab = contents.isDestroyed() ? null : this.options.host.tabOf(contents);
      if (!tab || !this.options.host.passwordsOn(tab.chordId)) this.dropPresave(contents);
    }
    for (const contents of [...this.firstSteps.keys()]) {
      const tab = contents.isDestroyed() ? null : this.options.host.tabOf(contents);
      if (!tab || !this.options.host.passwordsOn(tab.chordId)) this.dropFirstSteps(contents);
    }
    // A generated password's confirmation waiting on the late window, where passwords are off now: it never comes.
    for (const contents of [...this.confirms.keys()]) {
      const tab = contents.isDestroyed() ? null : this.options.host.tabOf(contents);
      if (!tab || !this.options.host.passwordsOn(tab.chordId)) this.dropConfirm(contents);
    }
  }

  /** The window's menu as its popover shows it. */
  menuFor(windowId: WindowId): PasswordMenu | null {
    const menu = this.menus.get(windowId);
    if (!menu) return null;
    return {
      id: menu.id,
      host: menu.host,
      state: menu.generate ? 'generate' : menu.locked ? 'locked' : 'accounts',
      accounts: menu.accounts.map(({ username, host, madeAt }) => ({ username, host, ...(madeAt !== undefined ? { madeAt } : {}) })),
      index: menu.index,
      insecure: menu.insecure,
      ...(menu.generate ? { generated: { password: menu.generate.password, again: menu.generate.again, vault: menu.generate.vault, rule: menu.generate.rule, strong: menu.generate.strong } } : {}),
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
    // Never in a private window (the detector and the vault refuse too), and only with what was typed.
    if (!tab || tab.private || !e.values) return;
    // The document the sign-in ended on, read before any wait: if the tab commits another meanwhile, the card would be
    // for a page you've left (and `leftSite`, which runs at that commit, found no card to drop yet).
    const doc = this.docs.get(e.contents) ?? 0;
    // And no `failed` on the tab since (a late error that took this sign-in back while Chord waited; review round 4 of #59).
    const failures = this.failures.get(e.contents) ?? 0;
    const here = () => !e.contents.isDestroyed() && (this.docs.get(e.contents) ?? 0) === doc && (this.failures.get(e.contents) ?? 0) === failures;
    const values = { ...e.values };
    // The first step's username goes with this sign-in, card or not, so the next account's password step can't get it.
    // A password step with no username of its own (a two-step sign-in's second page) takes it (S17 §4).
    const stepped = await this.takeFirstStep(e.contents, e.origin);
    if (!here()) return;
    if (!values.username && !CHANGE_KINDS.has(e.kind) && stepped) values.username = stepped;
    const kept = this.presaveFor(e.contents, e.origin);
    const generated = kept && kept.password === values.password ? kept : null;
    if (CHANGE_KINDS.has(e.kind)) return this.changed(e, tab, values, generated);
    // A generated password that worked (a sign-up, often read as `unknown`): its entry is confirmed, with its username,
    // and the saved card says so (the owner's design 5A), with *Delete it*.
    if (generated) {
      this.dropPresave(e.contents);
      const confirmWith = { ...(values.username ? { username: values.username } : {}), password: values.password };
      // No navigation: confirmed only once the late window has closed, with no error (S17 §6, phase 3A-2).
      // A navigation the page made during an earlier window, still judged, holds it too (review round 3 of #62).
      if ((e.lateUntil && e.lateUntil > this.now()) || this.judging(e.contents)) {
        this.holdConfirm(e.contents, { id: generated.id, origin: e.origin, chordId: tab.chordId, values: confirmWith }, e.lateUntil ?? this.now());
      } else {
        const done = await this.options.vault.presaved('confirm', generated.id, e.origin, tab.chordId, confirmWith).catch(() => false);
        if (!done) return;
      }
      // A late error, or the page gone, while the vault answered: nothing to confirm or show (review round 1 of #62).
      if (!here()) return this.dropConfirm(e.contents);
      const site = await this.siteOf(e.origin).catch(() => null);
      if (!here()) return this.dropConfirm(e.contents);
      this.showCard({ tab, contents: e.contents, origin: e.origin, site, kind: 'saved', locked: false, setup: false, values: { username: values.username, password: '' }, presaved: generated.id, until: this.now() + HOLD_MS });
      const pending = this.confirms.get(e.contents);
      if (pending && pending.id === generated.id) pending.card = this.cards.get(tab.nodeId) ?? null;
      return;
    }
    if (!SAVE_KINDS.has(e.kind)) return;
    // The candidate's own deadline: the card keeps what was typed no longer than the tracker would have.
    const until = e.valuesUntil ?? this.now() + HOLD_MS;
    const answer = await vault.candidateFor({ origin: e.origin, username: values.username, password: values.password, chordId: tab.chordId });
    if (!here()) return;
    if (answer.kind !== 'new' && answer.kind !== 'update' && answer.kind !== 'locked') return;
    const site = await this.siteOf(e.origin).catch(() => null);
    if (!here() || until <= this.now()) return;
    const code = answer.kind !== 'update' && e.kind !== 'sign-up' ? await this.codeOf(e.origin, values.password) : null;
    if (!here() || until <= this.now()) return;
    this.showCard({
      tab,
      contents: e.contents,
      origin: e.origin,
      site,
      kind: answer.kind === 'update' ? 'update' : 'new',
      locked: answer.kind === 'locked',
      setup: answer.kind === 'new' && answer.setup,
      values: code ? { ...values, password: code.trimmed } : values,
      ...(code ? { code } : {}),
      until,
      lateUntil: e.lateUntil,
      ...(e.kind === 'sign-up' ? { signUp: true } : {}),
    });
  }

  /**
   * A new sign-in's code typed after its password (S17 §6 phase 3D, the owner's design 1A): on a site of Apple's list,
   * a password ending in 6 to 8 digits is saved without the last 6 unless you say *Keep them*. Apple's list is loaded
   * only for a password that ends so.
   */
  private async codeOf(origin: string, password: string): Promise<{ typed: string; trimmed: string; kept: boolean } | null> {
    const trimmed = trimAppendedCode(password);
    if (trimmed === password) return null;
    const { appendsCodeToPassword } = await import('@chord/core/password-quirks');
    return appendsCodeToPassword(origin) ? { typed: password, trimmed, kept: false } : null;
  }

  /**
   * A change or reset form's submit worked (S17 §6, the owner's decision): the account is the saved one on the site
   * whose password is its current field; the form's username only chooses among several. One → the update card (a
   * generated password's too, applied on **Update**); none or several → the card asks which; none saved for the site
   * at all → the save card. Locked: the update card, which unlocks on **Update** and then finds the account.
   */
  private async changed(e: PasswordDetectorEvents['signedIn'][0], tab: AssistTab, values: CandidateValues, generated: Presave | null): Promise<void> {
    const { vault } = this.options;
    const until = e.valuesUntil ?? this.now() + HOLD_MS;
    const doc = this.docs.get(e.contents) ?? 0;
    const failures = this.failures.get(e.contents) ?? 0;
    const here = () => !e.contents.isDestroyed() && (this.docs.get(e.contents) ?? 0) === doc && (this.failures.get(e.contents) ?? 0) === failures && until > this.now();
    const found = await vault.changeAccounts(e.origin, tab.chordId, values.current ?? null).catch(() => ({ state: 'off' as const }));
    if (!here()) return;
    if (found.state === 'none' && !generated) return this.offerCard(e, tab, { username: values.username, password: values.password }, until, doc);
    // No vault (started over since the presave), or passwords off: nothing to update.
    if (found.state !== 'open' && found.state !== 'locked') return;
    const site = await this.siteOf(e.origin).catch(() => null);
    if (!here()) return;
    // A generated one is the tab's no longer: the card (or Settings, Not confirmed) has it now.
    if (generated) this.dropPresave(e.contents);
    const base = { tab, contents: e.contents, origin: e.origin, site, setup: false, until, lateUntil: e.lateUntil, ...(generated ? { presaved: generated.id } : {}) };
    if (found.state === 'locked') {
      // The update card, whose **Update** unlocks first and then finds the account (as phase 1's locked save does).
      // Titled by the site, not the form's username: which account it is waits for the unlock (review round 2 of #53).
      return this.showCard({ ...base, kind: 'update', locked: true, values: { username: values.username, password: values.password }, change: { current: values.current ?? null, shown: values.username } });
    }
    if (found.state === 'open') this.showCard({ ...base, locked: false, ...changeCard(found, values, generated?.id) });
  }

  /** The save or update card, as the vault decides it (S17 §6 step 5). */
  private async offerCard(e: PasswordDetectorEvents['signedIn'][0], tab: AssistTab, values: { username: string; password: string }, until: number, doc: number): Promise<void> {
    const failures = this.failures.get(e.contents) ?? 0;
    const here = () => !e.contents.isDestroyed() && (this.docs.get(e.contents) ?? 0) === doc && (this.failures.get(e.contents) ?? 0) === failures;
    const answer = await this.options.vault.candidateFor({ origin: e.origin, username: values.username, password: values.password, chordId: tab.chordId });
    if (!here()) return;
    if (answer.kind !== 'new' && answer.kind !== 'update' && answer.kind !== 'locked') return;
    const site = await this.siteOf(e.origin).catch(() => null);
    if (!here() || until <= this.now()) return;
    this.showCard({ tab, contents: e.contents, origin: e.origin, site, kind: answer.kind === 'update' ? 'update' : 'new', locked: answer.kind === 'locked', setup: answer.kind === 'new' && answer.setup, values, until, lateUntil: e.lateUntil });
  }

  private showCard(
    made: Pick<Card, 'tab' | 'contents' | 'origin' | 'realm' | 'site' | 'kind' | 'locked' | 'setup' | 'values'> &
      Partial<Pick<Card, 'accounts' | 'presaved' | 'generated' | 'signUp' | 'change' | 'lateUntil' | 'code'>> & { until: number },
  ): void {
    const { until, ...rest } = made;
    const before = this.cards.get(made.tab.nodeId);
    if (before) this.dropCard(before, false);
    const card: Card = { id: this.nextId++, ...rest, host: hostOf(made.origin), busy: false, problem: null, held: false, shown: true, idle: null, expiry: null };
    card.expiry = this.setTimer(() => this.dropCard(card), until - this.now());
    this.cards.set(made.tab.nodeId, card);
    this.startTimer(card);
    this.options.host.changed(made.tab.windowId);
  }

  /**
   * A sign-in typed in the browser's own box with *Remember* ticked worked, and there's no vault yet (S17 §10): the
   * save card, whose first save chooses the passphrase, saves it with its realm. Never in a private window.
   */
  async offerFirstSave(contents: WebContents, signIn: { origin: string; realm: string; username: string; password: string; until: number }): Promise<void> {
    const tab = this.options.host.tabOf(contents);
    if (!tab || tab.private || signIn.until <= this.now()) return;
    const values = { username: signIn.username, password: signIn.password } as CandidateValues;
    const site = await this.siteOf(signIn.origin).catch(() => null);
    if (contents.isDestroyed() || signIn.until <= this.now()) return;
    this.showCard({ tab, contents, origin: signIn.origin, realm: signIn.realm, site, kind: 'new', locked: false, setup: true, values, until: signIn.until });
  }

  /** A minute unused, while it's shown and you're not in it: it hides (the key brings it back). */
  private startTimer(card: Card): void {
    if (card.idle !== null) this.clearTimer(card.idle);
    card.idle = card.held || !card.shown ? null : this.setTimer(() => this.hideCard(card), SAVE_CARD_MS);
  }

  /** × or a minute unused: off screen, still there for the key in the address until the candidate ends. */
  private hideCard(card: Card): void {
    if (this.cards.get(card.tab.nodeId) !== card || !card.shown) return;
    // The saved card only tells: closed, it's done, with nothing for the key in the address to bring back. The refused
    // one too (review round 1 of #62).
    if (card.kind === 'saved' || card.kind === 'refused') return this.dropCard(card);
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
    this.unwait(card);
    card.idle = card.expiry = null;
    card.values = null;
    card.code = null;
    // A locked change's current password goes with it (review round 2 of #53).
    if (card.change) card.change.current = null;
    delete card.change;
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
    const pending = this.confirms.get(contents);
    if (!card && !pending) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = 'null';
    }
    const site = origin === 'null' ? null : await this.siteOf(origin).catch(() => null);
    // A generated password's confirmation waiting on the late window: the site was left, so it never comes (review round 1
    // of #62). It stays Not confirmed.
    if (pending && this.confirms.get(contents) === pending) {
      const its = await this.siteOf(pending.origin).catch(() => null);
      if (this.confirms.get(contents) === pending && (site === null || its === null ? origin !== pending.origin : site !== its)) this.dropConfirm(contents);
    }
    if (!card || this.cards.get(card.tab.nodeId) !== card) return;
    if (site === null || card.site === null ? origin !== card.origin : site !== card.site) this.dropCard(card);
  }

  /** A page of the tab committed: its presave is forgotten once you've left the site it was saved for (the entry stays). */
  private async leftPresaveSite(contents: WebContents, url: string): Promise<void> {
    const kept = this.presaves.get(contents);
    if (!kept) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = 'null';
    }
    const site = origin === 'null' ? null : await this.siteOf(origin).catch(() => null);
    if (this.presaves.get(contents) !== kept) return;
    if (site === null || kept.site === null ? origin !== kept.origin : site !== kept.site) this.dropPresave(contents);
  }

  /** The tab's card as its window's popover shows it: the username, never the password. */
  cardFor(nodeId: string | null): PasswordSaveCard | null {
    const card = nodeId ? this.cards.get(nodeId) : undefined;
    if (!card?.values || !card.shown) return null;
    return {
      id: card.id,
      kind: card.kind,
      host: card.host,
      username: card.values.username,
      setup: card.setup,
      busy: card.busy,
      problem: card.problem,
      ...(card.waiting ? { waiting: true } : {}),
      ...(card.kind === 'change' && card.accounts ? { accounts: card.accounts.map((a) => a.username) } : {}),
      // A locked change's card names no account yet: its title is the site's.
      ...(card.change && card.locked ? { username: '' } : {}),
      ...(card.generated ? { generated: true } : {}),
      ...(card.signUp ? { signUp: true } : {}),
      ...(card.code && card.kind === 'new' ? { code: card.code.kept ? ('kept' as const) : ('trimmed' as const) } : {}),
    };
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
    return card?.values && card.kind !== 'saved' ? { password: card.values.password } : null;
  }

  /** The card's buttons, from its window's popover (the sender, checked by the caller). */
  async answer(
    windowId: WindowId,
    id: number,
    action: 'save' | 'never' | 'close' | 'hold' | 'release' | 'new' | 'delete' | 'code',
    details: { username?: string; passphrase?: string; account?: number } = {},
  ): Promise<void> {
    const card = this.cardById(windowId, id);
    if (!card || ((card.busy || card.waiting) && action !== 'hold' && action !== 'release' && action !== 'close')) return;
    // The saved card: **Done** (Save) and × close it; *Delete it* deletes what was saved. Nothing else is its. The
    // refused card (a generated password a late error took back) is answered the same way.
    if (card.kind === 'saved' || card.kind === 'refused') {
      if (action === 'save' || action === 'close') return this.dropCard(card);
      if (action === 'delete') return this.deleteSaved(card);
      if (action !== 'hold' && action !== 'release') return;
    } else if (action === 'delete' || (action === 'new' && card.kind !== 'change') || (action === 'code' && !(card.code && card.kind === 'new'))) return;
    switch (action) {
      case 'new':
        if (this.wait(card, 'new', details)) return;
        return this.saveChange(card, details, true);
      case 'close':
        // × while it waits cancels the save (the owner's design 1A).
        this.unwait(card);
        // Hidden, not gone: the key in the address brings it back while the candidate lasts.
        return this.hideCard(card);
      case 'hold':
      case 'release':
        card.held = action === 'hold';
        return this.startTimer(card);
      case 'never':
        return this.never(card);
      case 'code':
        // *Keep them* and *Leave off the code*: which password Save saves, and the eye shows. Nothing is saved here.
        // Never while a Save waits on the late window or runs: what it saves was settled when it was pressed.
        if (!card.values || !card.code || card.waiting || card.busy) return;
        card.code.kept = !card.code.kept;
        card.values = { ...card.values, password: card.code.kept ? card.code.typed : card.code.trimmed };
        return this.options.host.changed(this.windowOf(card));
      case 'save':
        if (this.wait(card, 'save', details)) return;
        return this.save(card, details);
    }
  }

  /* ---------- the late window (S17 §6, phase 3A-2) ---------- */

  /**
   * Save, Update or *Save as new* pressed while a late error could still take the sign-in back: the card says
   * *Saving…* (or *Updating…*) and the save runs when the window closes. Whether it waits.
   */
  private wait(card: Card, action: 'save' | 'new', details: { username?: string; passphrase?: string; account?: number }): boolean {
    // A card with no late window of its own (a navigation's sign-in, the browser box's first save) isn't the judged
    // sign-in's: it never waits on the tab's judging (review round 3 of #62).
    if (card.lateUntil == null) return false;
    const left = card.lateUntil - this.now();
    // Past the window, but the page's navigation not judged yet: it waits too, and is cancelled when it comes due (now).
    if (left <= 0 && !this.judging(card.contents)) return false;
    // `change`'s **Update** with no account picked does nothing, now or later.
    if (action === 'save' && card.kind === 'change' && details.account === undefined) return true;
    const waiting = { action, details: { ...details }, timer: null as unknown };
    waiting.timer = this.setTimer(() => {
      if (card.waiting !== waiting || this.cards.get(card.tab.nodeId) !== card) return;
      // The page navigated and the new page isn't judged yet: no write (review rounds 1 and 2 of #62).
      if (this.judging(card.contents)) return this.cancelCard(card, true, 'unjudged');
      card.waiting = null;
      card.lateUntil = null;
      this.options.host.changed(this.windowOf(card));
      void (action === 'new' ? this.saveChange(card, waiting.details, true) : this.save(card, waiting.details));
    }, Math.max(0, left));
    card.waiting = waiting;
    this.options.host.changed(this.windowOf(card));
    return true;
  }

  /** A waiting save, cancelled: nothing is saved (× on the card, or the card going). */
  private unwait(card: Card): void {
    if (!card.waiting) return;
    if (card.waiting.timer !== null) this.clearTimer(card.waiting.timer);
    if (card.waiting.details.passphrase !== undefined) card.waiting.details.passphrase = '';
    card.waiting = null;
  }

  /** A late error on the tab: a save or update that waited on it is cancelled, and the toast says so (the owner's design 2A). */
  private cancelWaiting(contents: WebContents): void {
    for (const card of [...this.cards.values()]) if (card.contents === contents && card.waiting) this.cancelCard(card, false);
  }

  /**
   * A waiting save cancelled, with the toast; the card goes too unless the caller drops it itself. `refused`: the site
   * said no (the owner's wording, 2A). `unjudged`: the page navigated and its new page couldn't be judged in time, so
   * Chord can't claim a refusal (review round 2 of #62).
   */
  private cancelCard(card: Card, drop = true, why: 'refused' | 'unjudged' = 'refused'): void {
    if (!card.waiting) return;
    const updating = card.kind === 'update' || (card.kind === 'change' && card.waiting.action === 'save');
    this.unwait(card);
    const message =
      why === 'refused' ? `The site didn’t accept that password, so Chord didn’t ${updating ? 'update' : 'save'} it.` : `Chord couldn’t tell whether that worked, so it didn’t ${updating ? 'update' : 'save'}.`;
    this.options.host.toast(this.windowOf(card), 'passwords:refused', message);
    if (drop) this.dropCard(card);
  }

  /** Whether the tab's page navigated during a late window, and what it led to isn't judged yet (the tracker's). */
  private judging(contents: WebContents): boolean {
    return !contents.isDestroyed() && this.options.detector.judging(contents);
  }

  /**
   * A late window's sign-in ended with no judgment (`unjudged`: its cap; null: superseded by a new submit): its cards go,
   * a pressed one with the toast when `why` says one, and a generated password's held confirmation. Counted as a failure,
   * so an offer for it still being made is dropped. Cards with no late window of their own stay.
   */
  private dropLate(contents: WebContents, why: 'unjudged' | null): void {
    this.failures.set(contents, (this.failures.get(contents) ?? 0) + 1);
    for (const card of [...this.cards.values()]) {
      if (card.contents !== contents || card.lateUntil == null) continue;
      if (card.waiting && why) this.cancelCard(card, true, why);
      else this.dropCard(card);
    }
    this.dropConfirm(contents);
  }

  /** The vault locked: a generated password's confirmation waiting on the late window is dropped with its values. */
  locked(): void {
    for (const contents of [...this.confirms.keys()]) this.dropConfirm(contents);
  }

  /** A generated password's confirmation, held until the late window closes (S17 §6, phase 3A-2). */
  private holdConfirm(contents: WebContents, held: { id: string; origin: string; chordId: string | null; values: { username?: string; password: string } }, until: number): void {
    this.dropConfirm(contents);
    const pending = { ...held, values: held.values as { username?: string; password: string } | null, card: null as Card | null, timer: null as unknown };
    pending.timer = this.setTimer(() => {
      if (this.confirms.get(contents) !== pending) return;
      // The page's navigation not judged by now: never confirmed (it stays Not confirmed, in Settings).
      if (this.judging(contents)) return this.dropConfirm(contents);
      this.confirms.delete(contents);
      const values = pending.values;
      pending.values = null;
      pending.card = null;
      if (values) void this.options.vault.presaved('confirm', pending.id, pending.origin, pending.chordId, values).catch(() => false);
    }, Math.max(0, until - this.now()));
    this.confirms.set(contents, pending);
  }

  private dropConfirm(contents: WebContents): void {
    const pending = this.confirms.get(contents);
    if (!pending) return;
    if (pending.timer !== null) this.clearTimer(pending.timer);
    pending.values = null;
    pending.card = null;
    this.confirms.delete(contents);
  }

  /**
   * A late error took the sign-in back: the generated password's entry stays *Not confirmed* (never lost), and its saved
   * card, if it's there, says the site didn't take it, with *Delete it* and **Done** (the owner's design 3A).
   */
  private refuseConfirm(contents: WebContents): void {
    const pending = this.confirms.get(contents);
    if (!pending) return;
    const card = pending.card;
    this.dropConfirm(contents);
    if (!card || this.cards.get(card.tab.nodeId) !== card) return;
    card.kind = 'refused';
    // Shown again if it was hidden: this is news.
    if (!card.shown) this.options.host.offer(card.tab.nodeId, false);
    card.shown = true;
    this.startTimer(card);
    this.options.host.changed(this.windowOf(card));
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

  private async save(card: Card, details: { username?: string; passphrase?: string; account?: number }): Promise<void> {
    const { host, vault } = this.options;
    if (!card.values) return;
    if (card.setup && details.passphrase === undefined) return;
    if (card.generated) return this.saveGenerated(card, card.generated.menu, details.passphrase!);
    if (card.change && card.locked) return this.saveLockedChange(card);
    // A change's cards (the chooser, or the update card for the account it found) update that account by its id.
    if (card.kind === 'change' || card.presaved || (card.kind === 'update' && card.accounts)) return this.saveChange(card, details, false);
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
      return {
        origin: card.origin,
        username,
        password: values.password,
        // Without the code: what was typed too, so the vault decides as it would have with the vault open (a password
        // saved as typed, or with a code after it, is the same; an update keeps what was typed; review round 1 of #70).
        ...(card.code && !card.code.kept ? { typed: card.code.typed } : {}),
        chordId: card.tab.chordId,
        ...(card.realm !== undefined ? { realm: card.realm } : {}),
        ...(card.setup && details.passphrase !== undefined ? { passphrase: details.passphrase } : {}),
      };
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

  /** The no-vault card for a generated password: the passphrase chosen, it's saved, and filled as the menu would have. */
  private async saveGenerated(card: Card, menu: Menu, passphrase: string): Promise<void> {
    const password = card.values?.password;
    if (!password) return;
    card.busy = true;
    this.options.host.changed(this.windowOf(card));
    this.dropCard(card);
    await this.chooseGenerated(menu, password, passphrase);
  }

  /**
   * A change card's Save (the account you chose), or a card for a generated password saved for the form: the
   * account's password replaced and the presave deleted, or the presave confirmed with the username you left.
   */
  private async saveChange(card: Card, details: { username?: string; account?: number }, asNew: boolean): Promise<void> {
    const { host, vault } = this.options;
    const values = card.values;
    if (!values) return;
    // `change`'s **Update** waits for a pick (the owner's design 5A): no account chosen, nothing saved.
    if (card.kind === 'change' && !asNew && details.account === undefined) return;
    const account = card.kind === 'new' || asNew ? undefined : card.accounts?.[card.kind === 'change' ? details.account! : 0];
    if (card.kind !== 'new' && !asNew && !account) return;
    card.busy = true;
    card.problem = null;
    host.changed(this.windowOf(card));
    let ok: boolean;
    if (account) {
      const saved = await vault
        .changePassword({ origin: card.origin, chordId: card.tab.chordId, account: account.id, password: values.password, ...(card.presaved ? { presaved: card.presaved } : {}) })
        .catch(() => ({ ok: false as const }));
      ok = saved.ok;
    } else if (card.presaved) {
      ok = await vault.presaved('confirm', card.presaved, card.origin, card.tab.chordId, { username: details.username ?? values.username, password: values.password }).catch(() => false);
    } else {
      // *Save as new*, with a password you typed: another sign-in for the site, as the save card would.
      const saved = await vault.saveCandidate({ origin: card.origin, username: values.username, password: values.password, chordId: card.tab.chordId }).catch(() => ({ ok: false as const }));
      ok = saved.ok;
    }
    if (this.cards.get(card.tab.nodeId) !== card) return;
    card.busy = false;
    if (ok) return this.dropCard(card);
    card.problem = 'io';
    host.changed(this.windowOf(card));
  }

  /**
   * A change's update card, offered while locked (titled by its site): **Update** unlocks, then the account is found
   * as for any change. It's updated at once only when that's the one account the form could have meant: the only match,
   * under the username the form showed, or the form showed none. Otherwise the card shows the account it found, or the
   * chooser, and waits for another **Update** (review round 2 of #53). What it needs is read from the card each time,
   * so a card that goes during the unlock leaves nothing behind.
   */
  private async saveLockedChange(card: Card): Promise<void> {
    const { host, vault } = this.options;
    card.busy = true;
    card.problem = null;
    host.changed(this.windowOf(card));
    const open = await vault.askUnlock(this.windowOf(card));
    const live = () => this.cards.get(card.tab.nodeId) === card && card.values && card.change;
    if (!live()) return;
    const found = open ? await vault.changeAccounts(card.origin, card.tab.chordId, card.change!.current).catch(() => ({ state: 'off' as const })) : null;
    if (!live()) return;
    card.busy = false;
    if (!found) return host.changed(this.windowOf(card));
    if (found.state !== 'open') {
      card.problem = 'io';
      return host.changed(this.windowOf(card));
    }
    const shown = card.change!.shown;
    const next = changeCard(found, card.values!, card.presaved);
    card.change!.current = null;
    delete card.change;
    Object.assign(card, { locked: false, kind: next.kind, values: next.values, accounts: next.accounts });
    if (next.kind === 'update' && (shown === '' || shown === next.values.username)) return this.saveChange(card, {}, false);
    host.changed(this.windowOf(card));
  }

  /** The saved card's *Delete it*: the sign-in its generated password was saved as goes (chord-data keeps Undo for the session). */
  private async deleteSaved(card: Card): Promise<void> {
    // A confirmation still waiting on the late window is for an entry being deleted: it never runs.
    if (this.confirms.get(card.contents)?.id === card.presaved) this.dropConfirm(card.contents);
    if (!card.presaved) return this.dropCard(card);
    card.busy = true;
    this.options.host.changed(this.windowOf(card));
    const done = await this.options.vault.deleteSaved(card.presaved, card.origin, card.tab.chordId).catch(() => false);
    if (this.cards.get(card.tab.nodeId) !== card) return;
    card.busy = false;
    if (done) return this.dropCard(card);
    card.problem = 'io';
    this.options.host.changed(this.windowOf(card));
  }

  /** A window closed: its menu and its tabs' cards go. */
  /** Done with it (a test's, or one made again): it stops hearing the assistant's leases. */
  dispose(): void {
    this.offLease();
  }

  windowClosed(windowId: WindowId): void {
    const menu = this.menus.get(windowId);
    if (menu) this.close(menu);
    this.grace.delete(windowId);
    for (const card of [...this.cards.values()]) if (this.windowOf(card) === windowId) this.dropCard(card, false);
  }
}
