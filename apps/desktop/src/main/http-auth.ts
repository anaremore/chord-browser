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
 * - **A frame of another page** (router.test inside evil.example): the box
 *   says so, and isn't filled: the saved usernames are a chooser, so signing
 *   in takes a click on one, never just Enter.
 * - **Each navigation is followed** (`attachPage`, on every page): every
 *   frame's navigation gets a number at its `did-start-navigation`, keeps it
 *   through its redirects, and ends at its commit or its failure. A box for a
 *   frame's navigation is tied to that navigation, and closes once every
 *   navigation it answers is gone (the frame started another, or the request
 *   failed or was cancelled): a box never outlives its request. A frame
 *   that goes (a removed iframe) takes its navigations with it, found by
 *   what frames the page still has once main can't name the one that went;
 *   and a box for a navigation main couldn't place closes once nothing in
 *   its page is navigating any more.
 * - **Remember.** A sign-in typed with *Remember* ticked is held here (never
 *   logged, never sent anywhere) until the server answers **that
 *   navigation**: the same frame, the same navigation (its redirects
 *   followed, never another's), commits that address with a 2xx, and it's
 *   saved. Anything else drops it: a 401 or any other status, another
 *   navigation starting in the frame, the request failing, Chromium's retry
 *   (the same box again), Cancel, a navigation of the tab, the tab closing,
 *   or HOLD_MS. Any other frame's commit says nothing. A box for a page's own
 *   script request (not a navigation) has nothing to follow, so it offers no
 *   *Remember*; nor does one that more than one frame's navigation waits on
 *   (the `login` event doesn't say which frame asked, so a commit couldn't
 *   say whose answer it is). Once accepted, the save goes on through a
 *   navigation (the server took it), but not through the tab closing. The first save ever
 *   chooses the passphrase in the form save card's step (`firstSave`); an
 *   update says so, with Undo (`updated`).
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
  /** A frame's tree node id (`webFrameMain.fromId(…).frameTreeNodeId`), stable across its navigations. */
  frameOf?(processId: number, routingId: number): number | undefined;
  /** The tree node ids of a page's frames now (`mainFrame.framesInSubtree`): a frame missing from it has gone. */
  framesOf?(contents: WebContents): Iterable<number>;
  vault?: AuthVault;
  /** No vault yet: the form save card, with its passphrase step, saves this one. */
  firstSave?(contents: WebContents, signIn: FirstHttpSave): void;
  /** *Remember* changed a saved password: the window says so, with Undo while it's still what Remember wrote. */
  updated?(windowId: WindowId, update: { id: string; host: string; changedAt: number }): void;
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

/** One frame's navigation: its number (from its start) and the address it's asking for now (after its redirects). */
interface Navigation {
  nav: number;
  url: string;
}

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
  /** The frames' navigations this box answers, by tree node id. */
  frames: Map<number, Navigation>;
  /** It answers frames' navigations: it closes when the last of them is gone. */
  followed: boolean;
  /** A navigation main couldn't place: it closes once nothing in its page is navigating. */
  unplaced: boolean;
  /** More than one frame's navigation waited on it at some point: no *Remember*, as whose answer a commit is can't be told. */
  shared: boolean;
  /** A frame of another page asked (its host, or null for a page with no origin of its own, `file:` and the like). */
  embedded: { host: string | null } | null;
  /** Filled at once; false for a frame of another page, or one main couldn't place. */
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
  /** The navigations that were answered, by frame: only these, committing their address with a 2xx, are the server taking it. */
  frames: Map<number, Navigation>;
  /** Waiting for that commit; false once accepted (being saved). */
  waiting: boolean;
  /** What was typed: null once it's dropped. */
  values: { username: string; password: string } | null;
  until: number;
  timer: unknown;
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

function withoutFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

const sameNavigations = (a: Map<number, Navigation>, b: Map<number, Navigation> | undefined) =>
  !!b && [...a].every(([id, n]) => b.get(id)?.nav === n.nav);

type NavigationDetails = { url: string; isSameDocument?: boolean; frame?: { frameTreeNodeId: number } | null };

export class AuthBroker {
  private deps: AuthDeps | null = null;
  private readonly pending: Pending[] = [];
  /** Sign-ins typed with *Remember*, by tab, until the server answers. */
  private readonly held = new Map<NodeId, Held>();
  /** Each page's frames that are navigating: tree node id → that navigation. */
  private readonly navigating = new WeakMap<WebContents, Map<number, Navigation>>();
  private nextId = 1;
  private nextNav = 1;

  /** Called once Browser exists; a request before that is cancelled. */
  connect(deps: AuthDeps): void {
    this.deps = deps;
  }

  /**
   * Every page, as it's made: each frame's navigation, from its start through its redirects to its commit or
   * failure, so a box's request is tied to its frame's navigation (a request's details don't name one).
   */
  attachPage(contents: WebContents): void {
    const frames = new Map<number, Navigation>();
    /**
     * By frame: navigations a newer one replaced before they ended. Each still ends with a failure (Chromium
     * cancels it), which can come after the newer one's start, for the same address: that one is passed over.
     */
    const superseded = new Map<number, number>();
    this.navigating.set(contents, frames);
    const frameOf = (processId: number, routingId: number) => this.deps?.frameOf?.(processId, routingId);
    const end = (id: number) => {
      frames.delete(id);
      superseded.delete(id);
    };
    /** Main couldn't name the frame: if one has gone (a removed iframe), its navigations went with it. */
    const sweep = () => {
      const live = this.deps?.framesOf?.(contents);
      if (!live || contents.isDestroyed()) return;
      const present = new Set(live);
      for (const id of [...frames.keys()]) {
        if (present.has(id)) continue;
        end(id);
        this.navigationGone(contents, id, () => false);
      }
    };
    contents.on('did-start-navigation', ((details: NavigationDetails) => {
      const id = details.frame?.frameTreeNodeId;
      if (id === undefined || details.isSameDocument) return;
      const navigation = { nav: this.nextNav++, url: details.url };
      if (frames.has(id)) superseded.set(id, (superseded.get(id) ?? 0) + 1);
      frames.delete(id);
      frames.set(id, navigation);
      if (frames.size > FRAMES_MAX) {
        const oldest = frames.keys().next().value!;
        end(oldest);
      }
      // Whatever answered the frame's earlier navigation is gone.
      this.navigationGone(contents, id, (nav) => nav === navigation.nav);
    }) as never);
    contents.on('did-redirect-navigation', ((details: NavigationDetails) => {
      const id = details.frame?.frameTreeNodeId;
      const navigation = id === undefined ? undefined : frames.get(id);
      if (!navigation || details.isSameDocument) return;
      navigation.url = details.url;
      this.redirected(contents, id!, navigation);
    }) as never);
    contents.on('did-frame-navigate', ((_event: unknown, url: string, code: number, _status: string, _main: boolean, processId: number, routingId: number) => {
      const id = frameOf(processId, routingId);
      if (id === undefined) {
        sweep();
        return this.settled(contents);
      }
      const navigation = frames.get(id);
      end(id);
      this.committed(contents, id, navigation, url, code);
      this.settled(contents);
    }) as never);
    // A navigation that fails or is cancelled (before it commits): whatever answers it is gone too. Only the one it
    // names: a cancelled navigation's failure can come after the next one's start, which goes on.
    contents.on('did-fail-provisional-load', ((_event: unknown, _code: number, _description: string, url: string, _main: boolean, processId: number, routingId: number) => {
      const id = frameOf(processId, routingId);
      if (id === undefined) {
        sweep();
        return this.settled(contents);
      }
      const navigation = frames.get(id);
      const replaced = superseded.get(id) ?? 0;
      // A replaced navigation's failure, whichever address it had: the frame's own navigation goes on. Two to the
      // same address can't be told apart, but either order ends the right one: the second failure to come does.
      if (replaced > 0) {
        if (replaced === 1) superseded.delete(id);
        else superseded.set(id, replaced - 1);
        return;
      }
      if (!navigation || withoutFragment(navigation.url) !== withoutFragment(url)) return;
      end(id);
      this.navigationGone(contents, id, (nav) => nav !== navigation.nav);
      this.settled(contents);
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

  /** The frames' navigations asking for exactly this address in the page now (usually one). A request never has the fragment. */
  private navigationsAsking(contents: WebContents, url: string): [number, Navigation][] {
    const frames = this.navigating.get(contents);
    return frames ? [...frames].filter(([, n]) => withoutFragment(n.url) === url).map(([id, n]) => [id, { ...n }]) : [];
  }

  /* ---------- following each navigation ---------- */

  /** A frame's navigations ended, all but those `keep` names: what answers them goes. */
  private navigationGone(contents: WebContents, frame: number, keep: (nav: number) => boolean): void {
    let changed = false;
    for (const prompt of [...this.pending]) {
      const navigation = prompt.contents === contents ? prompt.frames.get(frame) : undefined;
      if (!navigation || keep(navigation.nav)) continue;
      prompt.frames.delete(frame);
      // Every request this box answers is gone: it goes too, and an answer to it would reach nothing.
      if (prompt.frames.size === 0 && prompt.followed) {
        this.pending.splice(this.pending.indexOf(prompt), 1);
        for (const answer of prompt.answers) answer();
        changed = true;
      }
    }
    for (const held of [...this.held.values()]) {
      const navigation = held.contents === contents && held.waiting ? held.frames.get(frame) : undefined;
      if (!navigation || keep(navigation.nav)) continue;
      held.frames.delete(frame);
      if (held.frames.size === 0) this.drop(held);
    }
    if (changed) this.deps?.onChange();
  }

  /**
   * A navigation in the page ended. A box for a navigation main couldn't place answers one of those under way when
   * it asked: once none is, its own has ended too.
   */
  private settled(contents: WebContents): void {
    if ((this.navigating.get(contents)?.size ?? 0) > 0) return;
    let changed = false;
    for (const prompt of [...this.pending]) {
      if (prompt.contents !== contents || !prompt.unplaced) continue;
      this.pending.splice(this.pending.indexOf(prompt), 1);
      for (const answer of prompt.answers) answer();
      changed = true;
    }
    if (changed) this.deps?.onChange();
  }

  /** The answered navigation redirected: its frame should commit there now. Another navigation's redirect never counts. */
  private redirected(contents: WebContents, frame: number, navigation: Navigation): void {
    for (const prompt of this.pending) {
      const answered = prompt.contents === contents ? prompt.frames.get(frame) : undefined;
      if (answered?.nav === navigation.nav) answered.url = navigation.url;
    }
    for (const held of this.held.values()) {
      const answered = held.contents === contents ? held.frames.get(frame) : undefined;
      if (answered?.nav === navigation.nav) answered.url = navigation.url;
    }
  }

  /**
   * A frame committed. For a held sign-in, that's the server's answer only if it's the answered navigation (by
   * its number) committing its address: then a 2xx saves it, anything else drops it. Any other frame says nothing.
   */
  private committed(contents: WebContents, frame: number, navigation: Navigation | undefined, url: string, code: number): void {
    for (const held of [...this.held.values()]) {
      const answered = held.contents === contents && held.waiting ? held.frames.get(frame) : undefined;
      if (!answered) continue;
      if (navigation?.nav === answered.nav && url === answered.url && code >= 200 && code < 300) void this.save(held);
      else this.drop(held);
    }
    // A box whose navigation committed without it is answered by nothing now.
    this.navigationGone(contents, frame, () => false);
  }

  /* ---------- the box ---------- */

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
    const asking = !info.isProxy && details.isRequestForNavigation ? this.navigationsAsking(contents!, details.url) : [];
    // Asked again for what was just answered: it didn't work, so nothing typed with *Remember* is saved.
    const held = this.held.get(nodeId);
    const failed = retry && !!held && !info.isProxy && held.origin === origin && held.realm === realm;
    if (failed) this.drop(held!);
    const same = this.pending.find((p) => p.nodeId === nodeId && p.origin === origin && p.realm === realm && p.proxy === info.isProxy);
    if (same) {
      same.answers.push(answer);
      for (const [id, navigation] of asking) same.frames.set(id, navigation);
      // Another frame's navigation waits on it too: a commit can't say whose answer it is, so no *Remember*.
      if (same.frames.size > 1 && !same.shared) {
        same.shared = true;
        if (same.remember !== null) {
          same.remember = null;
          if (same.ready) this.deps.onChange();
        }
      }
      if (retry && !same.retry) {
        same.retry = true;
        if (same.ready) this.deps.onChange();
      }
      return true;
    }
    const mainFrame = contents!.mainFrame?.frameTreeNodeId;
    // A subframe navigating to another origin than its page's: not filled, and it says whose page it's in.
    const embedded = asking.some(([id]) => id !== mainFrame) && origin !== top;
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
      frames: new Map(asking),
      followed: asking.length > 0,
      unplaced: !info.isProxy && details.isRequestForNavigation && asking.length === 0,
      shared: asking.length > 1,
      embedded: embedded ? { host: top ? hostOf(top) : null } : null,
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
    // request that isn't a frame's navigation has no answer main can follow: nothing to remember.
    if (answer.state === 'off' || tab.private || !prompt.followed || prompt.shared) prompt.remember = null;
    else prompt.remember = (prompt.fill && prompt.accounts.length > 0) || prompt.rememberAgain;
    if (answer.state === 'off') prompt.tab = null;
    prompt.ready = true;
    this.deps?.onChange();
  }

  /** The box to show for a tab, oldest first. */
  promptFor(nodeId: NodeId | null): AuthPrompt | null {
    const next = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    if (!next?.ready) return null;
    const { id, origin, realm, proxy, insecure, retry, locked, remember, fill, embedded } = next;
    return { id, origin, realm, proxy, insecure, retry, accounts: next.accounts.map((a) => a.username), locked, remember, fill, embedded };
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
    if (answer && remember && prompt.remember !== null && prompt.tab && !prompt.tab.private && !prompt.proxy && prompt.followed && !prompt.shared) this.hold(prompt, answer);
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
    // Only navigations still under way, as they were when the box asked: another started meanwhile answers nothing.
    const frames = new Map([...prompt.frames].filter(([id, n]) => sameNavigations(new Map([[id, n]]), this.navigating.get(prompt.contents))));
    if (prompt.contents.isDestroyed() || frames.size === 0) return;
    const held: Held = {
      nodeId: prompt.nodeId,
      contents: prompt.contents,
      origin: prompt.origin,
      realm: prompt.realm,
      chordId: prompt.tab!.chordId,
      frames,
      waiting: true,
      values: { username: values.username, password: values.password },
      until: this.now() + HOLD_MS,
      timer: null,
    };
    held.timer = this.setTimer(() => this.drop(held), HOLD_MS);
    this.held.set(prompt.nodeId, held);
  }

  /** What was typed goes. */
  private drop(held: Held): void {
    held.waiting = false;
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
    held.waiting = false;
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
    if (saved.ok && saved.kind === 'update' && saved.changedAt !== undefined && shownIn) updated?.(shownIn, { id: saved.id, host: hostOf(held.origin), changedAt: saved.changedAt });
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
    if (held && (held.waiting || closed)) this.drop(held);
    if (changed) this.deps?.onChange();
  }
}

/** Timers, as a test drives them. */
export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };

/**
 * *Password updated*'s Undo (`AuthDeps.updated`): by password id, for the window whose toast offered it, taken once,
 * and only for `ms` (Browser makes that as long as its toast could last). Offered again, the newer one counts.
 */
export class UpdateUndos<W = WindowId> {
  private readonly offers = new Map<string, { windowId: W; changedAt: number; timer: unknown }>();

  constructor(
    private readonly ms: number,
    private readonly timers: Timers = realTimers,
  ) {}

  offer(id: string, windowId: W, changedAt: number): void {
    const before = this.offers.get(id);
    if (before) this.timers.clear(before.timer);
    const offer = { windowId, changedAt, timer: null as unknown };
    offer.timer = this.timers.set(() => {
      if (this.offers.get(id) === offer) this.offers.delete(id);
    }, this.ms);
    this.offers.set(id, offer);
  }

  /** What the update wrote, for that window's Undo; null from another window, once taken, or once it's expired. */
  take(id: string, windowId: W): { changedAt: number } | null {
    const offer = this.offers.get(id);
    if (!offer || offer.windowId !== windowId) return null;
    this.timers.clear(offer.timer);
    this.offers.delete(id);
    return { changedAt: offer.changedAt };
  }
}
