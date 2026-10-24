/**
 * Sites and proxies that ask for a username and password in the browser's
 * own box: HTTP Basic, Digest or NTLM, a 401 or a 407 (ARCHITECTURE.md §9,
 * decision D12). Chord asks in the window's popover, over the tab (or Peek)
 * that asked, and only while you're looking at it. Nothing is saved: Chromium
 * keeps a sign-in that worked for the rest of the session, so it lasts until
 * you quit. Requests from anything else (Chord's own pages, extensions, Duet,
 * mini windows) and a page's requests to other sites for images or scripts
 * are cancelled, as Chrome does, and the site shows its own "unauthorized" page.
 */
import type { NodeId } from '@chord/core';
import type { AuthPrompt } from '@chord/ipc';
import type { AuthInfo, AuthenticationResponseDetails, WebContents } from 'electron';

export interface AuthDeps {
  /** The tab (or Peek) a page belongs to; popups, mini windows and Chord's own UI have none. */
  nodeFor(contents: WebContents): NodeId | undefined;
  /** The prompts changed: refresh every window's popover. */
  onChange(): void;
}

type Answer = (username?: string, password?: string) => void;

interface Pending extends AuthPrompt {
  nodeId: NodeId;
  /** Every request waiting on this box: a page often asks several times at once. */
  answers: Answer[];
}

/** Realms are the site's own words: kept short and on one line. */
const REALM_MAX = 120;

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
  private nextId = 1;

  /** Called once Browser exists; a request before that is cancelled. */
  connect(deps: AuthDeps): void {
    this.deps = deps;
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
    const same = this.pending.find((p) => p.nodeId === nodeId && p.origin === origin && p.realm === realm && p.proxy === info.isProxy);
    if (same) {
      same.answers.push(answer);
      if (retry && !same.retry) {
        same.retry = true;
        this.deps.onChange();
      }
      return true;
    }
    this.pending.push({
      id: this.nextId++,
      nodeId,
      origin,
      realm,
      proxy: info.isProxy,
      insecure: !info.isProxy && isInsecure(details.url),
      retry,
      answers: [answer],
    });
    this.deps.onChange();
    return true;
  }

  /** The box to show for a tab, oldest first. */
  promptFor(nodeId: NodeId | null): AuthPrompt | null {
    const next = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    if (!next) return null;
    const { id, origin, realm, proxy, insecure, retry } = next;
    return { id, origin, realm, proxy, insecure, retry };
  }

  /** Sign in with what was typed, or cancel (null). */
  respond(id: number, credentials: { username: string; password: string } | null): void {
    const index = this.pending.findIndex((p) => p.id === id);
    if (index < 0) return;
    const [prompt] = this.pending.splice(index, 1);
    for (const answer of prompt!.answers) {
      if (credentials) answer(credentials.username, credentials.password);
      else answer();
    }
    this.deps?.onChange();
  }

  /** A tab navigated away or closed: whatever it was asking is cancelled. */
  forgetTab(nodeId: NodeId): void {
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.nodeId !== nodeId) continue;
      for (const answer of this.pending.splice(i, 1)[0]!.answers) answer();
      changed = true;
    }
    if (changed) this.deps?.onChange();
  }
}
