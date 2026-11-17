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
 *   another), its password masked, and Sign in sends `{ account }`, which main
 *   answers from the vault straight into Chromium's callback. Nothing is sent
 *   before you press Sign in. A locked vault shows *Unlock passwords*.
 * - **Remember.** A sign-in typed with *Remember* ticked is held here (never
 *   logged, never sent anywhere) until the server's answer: saved when the
 *   page commits for that origin with anything but 401, dropped when the same
 *   box comes back (Chromium's retry: it didn't work), on a 401, on Cancel, a
 *   navigation, leaving the origin, the tab closing, or HOLD_MS after it was
 *   typed. The first save ever chooses the passphrase in the form save card's
 *   step (`firstSave`).
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
  /** The window a node is shown in, for the unlock card. */
  windowOf?(nodeId: NodeId): WindowId | undefined;
  vault?: AuthVault;
  /** No vault yet: the form save card, with its passphrase step, saves this one. */
  firstSave?(contents: WebContents, signIn: FirstHttpSave): void;
  now?: () => number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

type Answer = (username?: string, password?: string) => void;

/** Sign in with what was typed, with a saved sign-in (its place in the box's list), or cancel (null). */
export type AuthAnswer = { username: string; password: string } | { account: number } | null;

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
  /** What was typed: null once it's dropped. */
  values: { username: string; password: string } | null;
  until: number;
  timer: unknown;
  listener: ((event: unknown, url: string, code: number, status: string, isMainFrame: boolean) => void) | null;
}

/** Realms are the site's own words: kept short and on one line. */
const REALM_MAX = 120;
/** How long a box waits for the vault before it shows unfilled (it fills when the answer comes, if you haven't typed). */
export const AUTH_FILL_WAIT_MS = 400;

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
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

export class AuthBroker {
  private deps: AuthDeps | null = null;
  private readonly pending: Pending[] = [];
  /** Sign-ins typed with *Remember*, by tab, until the server answers. */
  private readonly held = new Map<NodeId, Held>();
  private nextId = 1;

  /** Called once Browser exists; a request before that is cancelled. */
  connect(deps: AuthDeps): void {
    this.deps = deps;
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

  /**
   * The app's `login` event. Returns whether Chord will answer (the caller
   * then prevents Electron's default, which cancels the request).
   */
  login(contents: WebContents | null, details: AuthenticationResponseDetails, info: AuthInfo, answer: Answer): boolean {
    const nodeId = contents && !contents.isDestroyed() ? this.deps?.nodeFor(contents) : undefined;
    if (!nodeId || !this.deps) return false;
    const origin = info.isProxy ? `${info.host}:${info.port}` : originOf(details.url);
    if (!origin) return false;
    // A page's own images and scripts from another site don't get to ask.
    if (!info.isProxy && !details.isRequestForNavigation && origin !== originOf(contents!.getURL())) return false;
    const realm = info.realm.replace(/\s+/g, ' ').trim().slice(0, REALM_MAX);
    const retry = !details.firstAuthAttempt;
    // Asked again for what was just answered: it didn't work, so nothing typed with *Remember* is saved.
    const held = this.held.get(nodeId);
    const failed = retry && !!held && !info.isProxy && held.origin === origin && held.realm === realm;
    if (failed) this.drop(held!);
    const same = this.pending.find((p) => p.nodeId === nodeId && p.origin === origin && p.realm === realm && p.proxy === info.isProxy);
    if (same) {
      same.answers.push(answer);
      if (retry && !same.retry) {
        same.retry = true;
        if (same.ready) this.deps.onChange();
      }
      return true;
    }
    // A proxy's box never touches the vault (decision 11).
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
    // Off for the chord: as before passwords, no *Remember* and no fill. A private window fills, never saves.
    prompt.remember = answer.state === 'off' || tab.private ? null : prompt.accounts.length > 0 || prompt.rememberAgain;
    if (answer.state === 'off') prompt.tab = null;
    prompt.ready = true;
    this.deps?.onChange();
  }

  /** The box to show for a tab, oldest first. */
  promptFor(nodeId: NodeId | null): AuthPrompt | null {
    const next = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    if (!next?.ready) return null;
    const { id, origin, realm, proxy, insecure, retry, locked, remember } = next;
    return { id, origin, realm, proxy, insecure, retry, accounts: next.accounts.map((a) => a.username), locked, remember };
  }

  /**
   * Sign in with what was typed, or with a saved sign-in (`{ account }`, its
   * place in the box's list: its password goes from the vault straight to
   * Chromium), or cancel (null). `remember`: hold what was typed until the
   * server answers, and save it then.
   */
  async respond(id: number, answer: AuthAnswer, remember = false): Promise<void> {
    const prompt = this.pending.find((p) => p.id === id);
    if (!prompt || prompt.busy || !prompt.ready) return;
    if (answer && 'account' in answer) {
      const account = prompt.accounts[answer.account];
      const vault = this.deps?.vault;
      if (!account || !vault || !prompt.tab) return;
      prompt.busy = true;
      const password = await vault.password(account.id, prompt.origin, prompt.realm, prompt.tab.chordId).catch(() => null);
      prompt.busy = false;
      if (!this.pending.includes(prompt)) return;
      // Locked (or deleted) meanwhile: the box asks the vault again, and stays.
      if (password === null) return void this.lookUp(prompt);
      return this.finish(prompt, { username: account.username, password });
    }
    this.finish(prompt, answer);
    if (answer && remember && prompt.remember !== null && prompt.tab && !prompt.tab.private && !prompt.proxy) this.hold(prompt, answer);
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
  async unlock(id: number): Promise<void> {
    const prompt = this.pending.find((p) => p.id === id);
    const windowId = prompt ? this.deps?.windowOf?.(prompt.nodeId) : undefined;
    if (!prompt?.locked || !windowId || !this.deps?.vault) return;
    if (await this.deps.vault.askUnlock(windowId)) await this.lookUp(prompt);
  }

  /* ---------- Remember ---------- */

  private hold(prompt: Pending, values: { username: string; password: string }): void {
    const before = this.held.get(prompt.nodeId);
    if (before) this.drop(before);
    const held: Held = {
      nodeId: prompt.nodeId,
      contents: prompt.contents,
      origin: prompt.origin,
      realm: prompt.realm,
      chordId: prompt.tab!.chordId,
      values: { username: values.username, password: values.password },
      until: this.now() + HOLD_MS,
      timer: null,
      listener: null,
    };
    held.timer = this.setTimer(() => this.drop(held), HOLD_MS);
    if (held.contents.isDestroyed()) return;
    // The server's answer: the page (or a frame of it) commits for that origin. Chromium's retry, a new box, comes to `login`.
    held.listener = (_event, url, code, _status, isMainFrame) => {
      if (originOf(url) === held.origin) {
        if (code === 401) this.drop(held);
        else if (code > 0) void this.save(held);
      } else if (isMainFrame) {
        this.drop(held);
      }
    };
    held.contents.on('did-frame-navigate', held.listener as never);
    this.held.set(prompt.nodeId, held);
  }

  private unlisten(held: Held): void {
    if (held.listener && !held.contents.isDestroyed()) held.contents.off('did-frame-navigate', held.listener as never);
    held.listener = null;
  }

  /** What was typed goes. */
  private drop(held: Held): void {
    this.unlisten(held);
    if (held.timer !== null) this.clearTimer(held.timer);
    held.timer = null;
    held.values = null;
    if (this.held.get(held.nodeId) === held) this.held.delete(held.nodeId);
  }

  /** The server took it: saved (new, or a new password for that username), unlocking first if need be. */
  private async save(held: Held): Promise<void> {
    this.unlisten(held);
    const { vault, windowOf, firstSave } = this.deps ?? {};
    if (!vault) return this.drop(held);
    // Made each time it's sent, from what's held now: a deadline or a navigation meanwhile leaves nothing to send.
    const request = () => (held.values && this.held.get(held.nodeId) === held ? { origin: held.origin, realm: held.realm, chordId: held.chordId, ...held.values } : null);
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
      if (last && !held.contents.isDestroyed()) firstSave(held.contents, { origin: last.origin, realm: last.realm, username: last.username, password: last.password, until: held.until });
    }
    if (!saved.ok && saved.problem !== 'none' && saved.problem !== 'locked') console.warn('Passwords: a sign-in from the browser’s box wasn’t saved');
    this.drop(held);
  }

  /** A tab navigated away or closed: whatever it was asking is cancelled, and anything typed with *Remember* goes. */
  forgetTab(nodeId: NodeId): void {
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.nodeId !== nodeId) continue;
      for (const answer of this.pending.splice(i, 1)[0]!.answers) answer();
      changed = true;
    }
    const held = this.held.get(nodeId);
    if (held && held.listener) this.drop(held);
    if (changed) this.deps?.onChange();
  }
}
