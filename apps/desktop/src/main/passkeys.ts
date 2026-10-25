/**
 * Choosing a passkey (ARCHITECTURE.md §9, Passkeys). When an authenticator
 * holds more than one passkey for a site (a security key, say), Electron asks
 * the app which to use (`select-webauthn-account`), and with no one listening
 * it cancels the sign-in, even with a single passkey. Chord answers: one
 * passkey signs in as it is (you already chose a passkey and touched the
 * key), several are offered in the window's popover over the tab that asked,
 * as the sign-in box is, and Cancel or the tab going away declines. On Windows
 * the system's own dialog chooses, and this isn't asked.
 */
import type { NodeId } from '@chord/core';
import type { PasskeyPrompt } from '@chord/ipc';
import { webContents, type Session, type WebContents } from 'electron';

export interface PasskeyDeps {
  /** The tab (or Peek) a page belongs to; mini windows and Chord's own UI have none, and can't be asked. */
  nodeFor(contents: WebContents): NodeId | undefined;
  /** The prompts changed: refresh every window's popover. */
  onChange(): void;
}

type Answer = (credentialId?: string | null) => void;

interface Pending extends PasskeyPrompt {
  nodeId: NodeId;
  answer: Answer;
}

/** A site's own words about an account: kept short and on one line. */
const clip = (text: string | undefined, max = 120) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export class PasskeyBroker {
  private deps: PasskeyDeps | null = null;
  private readonly pending: Pending[] = [];
  private nextId = 1;

  /** Called once Browser exists; a choice asked before that is declined. */
  connect(deps: PasskeyDeps): void {
    this.deps = deps;
  }

  /** Every web session: chords' and private windows'. */
  attach(session: Session): void {
    session.on('select-webauthn-account', (_event, details, callback) => this.select(details, callback));
  }

  private select(details: Electron.SelectWebauthnAccountDetails, answer: Answer): void {
    const accounts = details.accounts.slice(0, 50).map((a) => ({ credentialId: a.credentialId, name: clip(a.name), displayName: clip(a.displayName) }));
    if (accounts.length === 0) return answer();
    if (accounts.length === 1) return answer(accounts[0]!.credentialId);
    const contents = details.frame ? webContents.fromFrame(details.frame) : undefined;
    const nodeId = contents && !contents.isDestroyed() ? this.deps?.nodeFor(contents) : undefined;
    if (!nodeId || !this.deps) return answer();
    this.pending.push({ id: this.nextId++, nodeId, site: clip(details.relyingPartyId, 253), accounts, answer });
    this.deps.onChange();
  }

  /** The choice to show for a tab, oldest first. */
  promptFor(nodeId: NodeId | null): PasskeyPrompt | null {
    const next = nodeId ? this.pending.find((p) => p.nodeId === nodeId) : undefined;
    return next ? { id: next.id, site: next.site, accounts: next.accounts } : null;
  }

  /** Sign in with one of the offered passkeys, or decline (null, or one that wasn't offered). */
  respond(id: number, credentialId: string | null): void {
    const index = this.pending.findIndex((p) => p.id === id);
    if (index < 0) return;
    const [prompt] = this.pending.splice(index, 1);
    const offered = prompt!.accounts.some((a) => a.credentialId === credentialId);
    prompt!.answer(offered ? credentialId : null);
    this.deps?.onChange();
  }

  /** A tab navigated away or closed: what it was asking is declined. */
  forgetTab(nodeId: NodeId): void {
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.nodeId !== nodeId) continue;
      this.pending.splice(i, 1)[0]!.answer(null);
      changed = true;
    }
    if (changed) this.deps?.onChange();
  }
}
