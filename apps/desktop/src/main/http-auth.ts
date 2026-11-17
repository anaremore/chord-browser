/**
 * Sites and proxies that ask for a username and password in the browser's
 * own box: HTTP Basic, Digest or NTLM, a 401 or a 407 (ARCHITECTURE.md §9,
 * decision D12). Chord asks in the window's popover, over the tab (or Peek)
 * that asked, and only while you're looking at it. Chromium keeps a sign-in
 * that worked for the rest of the session. Requests from anything else
 * (Chord's own pages, extensions, the assistant, mini windows) and a page's
 * requests to other sites for images or scripts are cancelled, as Chrome
 * does, and the site shows its own "unauthorized" page.
 *
 * With Chord's passwords on for the tab's chord (S17 §10, *HTTP sign-in*):
 *
 * - **Fill.** The box asks the vault for sign-ins saved from this box for the
 *   request's own origin (scheme, host and port, as main sees the request,
 *   never what a page says) and realm. Their usernames go to the popover, the
 *   passwords never: the box is filled with the first (a chooser picks
 *   another), its password masked, and Sign in sends `{ account, username }`,
 *   which main checks against the box's list as it is now and answers from
 *   the vault straight into Chromium's callback. Nothing is sent before you
 *   press Sign in. A locked vault shows *Unlock passwords*.
 * - **A frame of another site's page** (router.test inside evil.example):
 *   the box says so, and isn't filled: the saved usernames are a chooser, so
 *   signing in takes a click on one, never just Enter.
 * - **Remember.** A sign-in typed with *Remember* ticked is held here (never
 *   logged, never sent anywhere) until the server answers **the request that
 *   was answered**: the frame that was navigating to it (tracked from its
 *   `did-start-navigation`, through its redirects) commits that address with
 *   anything but a 401, and it's saved. Any other frame's commit says nothing.
 *   Chromium's retry (the same box again), a 401, Cancel, the frame going
 *   elsewhere, a navigation of the tab, the tab closing, or HOLD_MS drop it.
 *   A box for a page's own script request (not a navigation) has no commit to
 *   read, so it offers no *Remember*. Once accepted, the save goes on through
 *   a navigation (the server took it), but not through the tab closing.
 *   The first save ever chooses the passphrase in the form save card's step
 *   (`firstSave`); an update into an open vault says so, with Undo (`updated`).
 * - **Never** for a proxy (decision 11, DESIGN.md §9): no fill, no *Remember*.
 *   A private window fills and never saves (*Remember* hidden there).
 */
import type { NodeId, WindowId } from '@chord/core';
import type { AuthPrompt } from '@chord/ipc';
import type { AuthInfo, AuthenticationResponseDetails, WebContents } from 'electron';
import { HOLD_MS } from './passwords/saving';
import type { HttpAccountsAnswer, SaveAnswer } from './passwords/service';

/** The vault, as the box uses it (`PasswordService`'s `http…` methods and `askUnlock`). */
export interface AuthVault {
  accounts(origin: string, realm: string, chordId: string | null): Promise<HttpAccountsAnswer>;
  password(id: string, origin: string, realm: string, chordId: string | null): Promise<string | null>;
  remember(signIn: { origin: string; realm: string; username: string; password: string; chordId: string | null }): Promise<SaveAnswer>;
  askUnlock(windowId: WindowId): Promise<boolean>;
}

/** The tab (or Peek) a box is over, as the vault needs it. */
export interface AuthTab {
  chordId: string | null;
  private: boolean;
}

/** A sign-in typed with *Remember* ticked, for the first save's card, which chooses the passphrase. */
export interface FirstHttpSave {
  origin: string;
  realm: string;
  username: string;
  password: string;
  /** What was typed goes then, card or not. */
  until: number;
}

export interface AuthDeps {
  /** The tab (or Peek) a page belongs to; popups, mini windows and Chord's own UI have none. */
  nodeFor(contents: WebContents): NodeId | undefined;
  /** The prompts changed: refresh every window's popover. */
  onChange(): void;
  /** The node's chord and whether it's a private window's; without it (or `vault`), the box neither fills nor remembers. */
  tabOf?(nodeId: NodeId): AuthTab | null;
  /** The window a node is shown in: the unlock card's, and the only popover whose answers count. */
  windowOf?(nodeId: NodeId): WindowId | undefined;
  /** A committed frame's tree node id (`webFrameMain.fromId(…).frameTreeNodeId`), stable across its navigations. */
  frameOf?(processId: number, routingId: number): number | undefined;
  vault?: AuthVault;
  /** No vault yet: the form save card, with its passphrase step, saves this one. */
  firstSave?(contents: WebContents, signIn: FirstHttpSave): void;
  /** *Remember* changed a saved password: the window says so, with Undo. */
  updated?(windowId: WindowId, update: { id: string; host: string }): void;
  now?: () => number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

type Answer = (username?: string, password?: string) => void;

/**
 * Sign in with what was typed, with a saved sign-in (its place in the box's list and the username shown there, which
 * must still be what's there), or cancel (null).
 */
export type AuthAnswer = { username: string; password: string } | { account: number; username: string } | null;

interface Pending {
  id: number;
  nodeId: NodeId;
  contents: WebContents;
  origin: string;
  realm: string;
  proxy: boolean;
  insecure: boolean;
  retry: boolean;
  /** Every request waiting on this box: a page often asks several times at once. */
  answers: Answer[];
  /** The frames whose navigation this box answers, by tree node id, and the address each asked for. */
  frames: Map<number, string>;
  /** A frame of another site's page asked: its top page's host. */
  embeddedIn: string | null;
  /** Filled at once; false for a frame of another site's page, or one main couldn't place. */
  fill: boolean;
  /** The vault's part: null when it has none here (a proxy, passwords off, no tab). */
  tab: AuthTab | null;
  /** Saved sign-ins for this origin and realm: ids stay here, usernames go to the popover. */
  accounts: { id: string; username: string }[];
  locked: boolean;
  /** *Remember*: null hidden; else ticked to begin with. */
  remember: boolean | null;
  /** The box again after a sign-in typed with *Remember* didn't work: it stays ticked. */
  rememberAgain: boolean;
  /** Shown: the vault answered, or kept the box waiting long enough. */
  ready: boolean;
  /** A saved sign-in's password is being fetched. */
  busy: boolean;
}

interface Held {
  nodeId: NodeId;
  contents: WebContents;
  origin: string;
  realm: string;
  chordId: string | null;
  /** The frames whose request was answered, and the address each should commit (followed through redirects). */
  frames: Map<number, string>;
  /** What was typed: null once it's dropped. */
  values: { username: string; password: string } | null;
  until: number;
  timer: unknown;
  /** Listening for the answered request's redirect and commit; null once accepted (or dropped). */
  listeners: { redirect: (details: { url: string; frame?: { frameTreeNodeId: number } | null }) => void; commit: (...args: unknown[]) => void } | null;
}

/** Realms are the site's own words: kept short and on one line. */
const REALM_MAX = 120;
/** How long a box waits for the vault before it shows unfilled (it fills when the answer comes, if you haven't typed). */
export const AUTH_FILL_WAIT_MS = 400;
/** Frames navigating at once that a page's record keeps: more is a page making frames for sport. */
const FRAMES_MAX = 64;

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Plain HTTP off this computer: what's typed can be read on the way. */
function isInsecure(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return true;
  }
}

type NavigationDetails = { url: string; isSameDocument?: boolean; frame?: { frameTreeNodeId: number } | null };

export class AuthBroker {
  private deps: AuthDeps | null = null;
  private readonly pending: Pending[] = [];
  /** Sign-ins typed with *Remember*, by tab, until the server answers. */
  private readonly held = new Map<NodeId, Held>();
  /** Each page's frames that are navigating: tree node id → the address it's asking for now. */
  private readonly navigating = new WeakMap<WebContents, Map<number, string>>();
  private nextId = 1;

  /** Called once Browser exists; a request before that is cancelled. */
  connect(deps: AuthDeps): void {
    this.deps = deps;
  }

  /**
   * Every page, as it's made: which of its frames is navigating to which address, so a box's request is tied to
   * its frame (a request's details don't name one). Kept until the frame commits.
   */
  attachPage(contents: WebContents): void {
    const frames = new Map<number, string>();
    this.navigating.set(contents, frames);
    const track = (details: NavigationDetails) => {
      const id = details.frame?.frameTreeNodeId;
      if (id === undefined || details.isSameDocument) return;
      frames.delete(id);
      frames.set(id, details.url);
      if (frames.size > FRAMES_MAX) frames.delete(frames.keys().next().value!);
    };
    contents.on('did-start-navigation', track as never);
    contents.on('did-redirect-navigation', track as never);
    contents.on('did-frame-navigate', ((_event: unknown, _url: string, _code: number, _status: string, _main: boolean, processId: number, routingId: number) => {
      const id = this.deps?.frameOf?.(processId, routingId);
      if (id !== undefined) frames.delete(id);
    }) as never);
  }

  private now(): number {
    return (this.deps?.now ?? Date.now)();
  }

  private setTimer(run: () => void, ms: number): unknown {
    return (this.deps?.setTimeout ?? ((r, t) => setTimeout(r, t)))(run, ms);
  }

  private clearTimer(timer: unknown): void {
    (this.deps?.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(timer);
  }

  /** The frames navigating to exactly this address in the page (usually one). */
  private framesAsking(contents: WebContents, url: string): number[] {
    const frames = this.navigating.get(contents);
    return frames ? [...frames].filter(([, asked]) => asked === url).map(([id]) => id) : [];
  }

  /**
   * The app's `login` event. Returns whether Chord will answer (the caller
   * then prevents Electron's default, which cancels the request).
   */
  login(contents: WebContents | null, details: AuthenticationResponseDetails, info: AuthInfo, answer: Answer): boolean {
    const nodeId = contents && !contents.isDestroyed() ? this.deps?.nodeFor(contents) : undefined;
    if (!nodeId || !this.deps) return false;
    const origin = info.isProxy ? `${info.host}:${info.port}` : originOf(details.url);
    if (!origin) return false;
    const top = originOf(contents!.getURL());
    // A page's own images and scripts from another site don't get to ask.
    if (!info.isProxy && !details.isRequestForNavigation && origin !== top) return false;
    const realm = info.realm.replace(/\s+/g, ' ').trim().slice(0, REALM_MAX);
    const retry = !details.firstAuthAttempt;
    const asking = !info.isProxy && details.isRequestForNavigation ? this.framesAsking(contents!, details.url) : [];
    // Asked again for what was just answered: it didn't work, so nothing typed with *Remember* is saved.
    const held = this.held.get(nodeId);
    const failed = retry && !!held && !info.isProxy && held.origin === origin && held.realm === realm;
    if (failed) this.drop(held!);
    const same = this.pending.find((p) => p.nodeId === nodeId && p.origin === origin && p.realm === realm && p.proxy === info.isProxy);
    if (same) {
      same.answers.push(answer);
      for (const id of asking) same.frames.set(id, details.url);
      if (retry && !same.retry) {
        same.retry = true;
        if (same.ready) this.deps.onChange();
      }
      return true;
    }
    const mainFrame = contents!.mainFrame?.frameTreeNodeId;
    // A subframe navigating to another site than its page's: not filled, and it says whose page it's in.
    const embedded = asking.some((id) => id !== mainFrame) && origin !== top;
    // A navigation main couldn't place, to another site than the page's, gets the same care.
    const placed = asking.length > 0 || !details.isRequestForNavigation || origin === top;
    const tab = info.isProxy || !this.deps.vault ? null : (this.deps.tabOf?.(nodeId) ?? null);
    const prompt: Pending = {
      id: this.nextId++,
      nodeId,
      contents: contents!,
      origin,
      realm,
      proxy: info.isProxy,
      insecure: !info.isProxy && isInsecure(details.url),
      retry,
      answers: [answer],
      frames: new Map(asking.map((id) => [id, details.url])),
      embeddedIn: embedded && top ? hostOf(top) : null,
      fill: !embedded && placed,
      tab,
      accounts: [],
      locked: false,
      remember: null,
      rememberAgain: failed,
      ready: tab === null,
      busy: false,
    };
    this.pending.push(prompt);
    if (prompt.ready) {
      this.deps.onChange();
    } else {
      void this.lookUp(prompt);
      this.setTimer(() => this.show(prompt), AUTH_FILL_WAIT_MS);
    }
    return true;
  }

  private show(prompt: Pending): void {
    if (prompt.ready || !this.pending.includes(prompt)) return;
    prompt.ready = true;
    this.deps?.onChange();
  }

  /** The vault's sign-ins for the box's origin and realm, and whether it offers *Remember*. */
  private async lookUp(prompt: Pending): Promise<void> {
    const { vault } = this.deps ?? {};
    const tab = prompt.tab;
    if (!vault || !tab) return;
    const answer = await vault.accounts(prompt.origin, prompt.realm, tab.chordId).catch((): HttpAccountsAnswer => ({ state: 'off' }));
    if (!this.pending.includes(prompt)) return;
    prompt.accounts = answer.state === 'open' ? answer.accounts : [];
    prompt.locked = answer.state === 'locked';
    // Off for the chord: as before passwords, no *Remember* and no fill. A private window fills, never saves. A
    // request that isn't a frame's navigation has no answer main can read: nothing to remember.
    if (answer.state === 'off' || tab.private || prompt.frames.size === 0) prompt.remember = null;
    else prompt.remember = (prompt.fill && prompt.accounts.length > 0) || prompt.rememberAgain;
    if (answer.state === 'off') prompt.tab = null;
    prompt.ready = true;
    this.deps?.onChange();
  }

  /** The box to show for a tab, oldest first. */
  promptFor(nodeId: NodeId | null): AuthPrompt | null {
    const next = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    if (!next?.ready) return null;
    const { id, origin, realm, proxy, insecure, retry, locked, remember, fill, embeddedIn } = next;
    return { id, origin, realm, proxy, insecure, retry, accounts: next.accounts.map((a) => a.username), locked, remember, fill, embeddedIn };
  }

  /** Whether an answer for a box came from the popover of the window its tab is shown in. */
  private fromItsWindow(prompt: Pending, windowId: WindowId | undefined): boolean {
    return windowId === undefined || this.deps?.windowOf?.(prompt.nodeId) === windowId;
  }

  /**
   * Sign in with what was typed, or with a saved sign-in (`{ account, username }`:
   * its place in the box's list and the username shown there, refused unless
   * the list still says so; its password goes from the vault straight to
   * Chromium), or cancel (null). `remember`: hold what was typed until the
   * server answers, and save it then. `windowId`: the popover that answered,
   * which must be the one the box's tab is shown in.
   */
  async respond(id: number, answer: AuthAnswer, remember = false, windowId?: WindowId): Promise<void> {
    const prompt = this.pending.find((p) => p.id === id);
    if (!prompt || prompt.busy || !prompt.ready || !this.fromItsWindow(prompt, windowId)) return;
    if (answer && 'account' in answer) {
      const account = prompt.accounts[answer.account];
      const vault = this.deps?.vault;
      // The list changed since the popover drew it (locked, unlocked, deleted): it asks again rather than guess.
      if (!account || account.username !== answer.username || !vault || !prompt.tab) return;
      prompt.busy = true;
      const password = await vault.password(account.id, prompt.origin, prompt.realm, prompt.tab.chordId).catch(() => null);
      prompt.busy = false;
      if (!this.pending.includes(prompt)) return;
      // Locked (or deleted) meanwhile: the box asks the vault again, and stays.
      if (password === null) return void this.lookUp(prompt);
      return this.finish(prompt, { username: account.username, password });
    }
    this.finish(prompt, answer);
    if (answer && remember && prompt.remember !== null && prompt.tab && !prompt.tab.private && !prompt.proxy && prompt.frames.size > 0) this.hold(prompt, answer);
  }

  private finish(prompt: Pending, credentials: { username: string; password: string } | null): void {
    const index = this.pending.indexOf(prompt);
    if (index < 0) return;
    this.pending.splice(index, 1);
    for (const answer of prompt.answers) {
      if (credentials) answer(credentials.username, credentials.password);
      else answer();
    }
    // Cancelled: nothing typed before it is saved either.
    if (!credentials) {
      const held = this.held.get(prompt.nodeId);
      if (held && held.origin === prompt.origin && held.realm === prompt.realm) this.drop(held);
    }
    this.deps?.onChange();
  }

  /** *Unlock passwords* in the box: the unlock card, then the box fills. */
  async unlock(id: number, from?: WindowId): Promise<void> {
    const prompt = this.pending.find((p) => p.id === id);
    const windowId = prompt ? this.deps?.windowOf?.(prompt.nodeId) : undefined;
    if (!prompt?.locked || !windowId || !this.deps?.vault || !this.fromItsWindow(prompt, from)) return;
    if (await this.deps.vault.askUnlock(windowId)) await this.lookUp(prompt);
  }

  /* ---------- Remember ---------- */

  private hold(prompt: Pending, values: { username: string; password: string }): void {
    const before = this.held.get(prompt.nodeId);
    if (before) this.drop(before);
    if (prompt.contents.isDestroyed()) return;
    const held: Held = {
      nodeId: prompt.nodeId,
      contents: prompt.contents,
      origin: prompt.origin,
      realm: prompt.realm,
      chordId: prompt.tab!.chordId,
      frames: new Map(prompt.frames),
      values: { username: values.username, password: values.password },
      until: this.now() + HOLD_MS,
      timer: null,
      listeners: null,
    };
    held.timer = this.setTimer(() => this.drop(held), HOLD_MS);
    held.listeners = {
      // The answered request redirected: its frame should commit there now.
      redirect: (details) => {
        const id = details.frame?.frameTreeNodeId;
        if (id !== undefined && held.frames.has(id)) held.frames.set(id, details.url);
      },
      // The server's answer to the request that was answered: that frame committing that address. Any other frame's
      // commit (a sibling on the same site, say) says nothing about it.
      commit: (...args: unknown[]) => {
        const [, url, code, , , processId, routingId] = args as [unknown, string, number, string, boolean, number, number];
        const id = this.deps?.frameOf?.(processId, routingId);
        const expected = id === undefined ? undefined : held.frames.get(id);
        if (expected === undefined) return;
        if (url !== expected || code === 401) this.drop(held);
        else if (code > 0) void this.save(held);
      },
    };
    held.contents.on('did-redirect-navigation', held.listeners.redirect as never);
    held.contents.on('did-frame-navigate', held.listeners.commit as never);
    this.held.set(prompt.nodeId, held);
  }

  private unlisten(held: Held): void {
    if (held.listeners && !held.contents.isDestroyed()) {
      held.contents.off('did-redirect-navigation', held.listeners.redirect as never);
      held.contents.off('did-frame-navigate', held.listeners.commit as never);
    }
    held.listeners = null;
  }

  /** What was typed goes. */
  private drop(held: Held): void {
    this.unlisten(held);
    if (held.timer !== null) this.clearTimer(held.timer);
    held.timer = null;
    held.values = null;
    if (this.held.get(held.nodeId) === held) this.held.delete(held.nodeId);
  }

  /**
   * The server took it: saved (new, or a new password for that username), unlocking first if need be. From here a
   * navigation of the tab doesn't drop it (the sign-in worked), but the tab closing does, and so does the deadline.
   */
  private async save(held: Held): Promise<void> {
    this.unlisten(held);
    const { vault, windowOf, firstSave, updated } = this.deps ?? {};
    if (!vault) return this.drop(held);
    // Made each time it's sent, from what's held now: a deadline or the tab closing meanwhile leaves nothing to send.
    const request = () =>
      held.values && this.held.get(held.nodeId) === held && !held.contents.isDestroyed()
        ? { origin: held.origin, realm: held.realm, chordId: held.chordId, ...held.values }
        : null;
    const send = (r: NonNullable<ReturnType<typeof request>>) => vault.remember(r).catch((): SaveAnswer => ({ ok: false, problem: 'io' }));
    const first = request();
    if (!first) return;
    let saved = await send(first);
    const windowId = windowOf?.(held.nodeId);
    if (!saved.ok && saved.problem === 'locked' && windowId && (await vault.askUnlock(windowId))) {
      const again = request();
      if (again) saved = await send(again);
    }
    if (!saved.ok && saved.problem === 'none' && firstSave) {
      const last = request();
      if (last) firstSave(held.contents, { origin: last.origin, realm: last.realm, username: last.username, password: last.password, until: held.until });
    }
    // A new sign-in is saved quietly (you ticked Remember); a changed password says so, with Undo.
    const shownIn = windowOf?.(held.nodeId);
    if (saved.ok && saved.kind === 'update' && shownIn) updated?.(shownIn, { id: saved.id, host: hostOf(held.origin) });
    if (!saved.ok && saved.problem !== 'none' && saved.problem !== 'locked') console.warn('Passwords: a sign-in from the browser’s box wasn’t saved');
    this.drop(held);
  }

  /**
   * A tab navigated away (`closed` false) or closed: whatever it was asking is cancelled. What was typed with
   * *Remember* goes too, unless the server already took it and it's being saved (a navigation then is just you
   * going on); closing the tab drops it either way.
   */
  forgetTab(nodeId: NodeId, closed = false): void {
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.nodeId !== nodeId) continue;
      for (const answer of this.pending.splice(i, 1)[0]!.answers) answer();
      changed = true;
    }
    const held = this.held.get(nodeId);
    if (held && (held.listeners || closed)) this.drop(held);
    if (changed) this.deps?.onChange();
  }
}
