/**
 * The site card (S18 M2c; mocks/agents-s18-m2.html §1): an outside agent's first action on a site asks you, where the
 * connect card does (the window you used last, in its popover, centered at the top, never taking the keyboard).
 * *Let Claude Code click and type on shop.example?*, what it wants to do first in Chord's words (never the agent's),
 * that it still asks before submitting, paying, sending or deleting, then Deny (or ×), *Allow for now*, and
 * *Always on this site* for an agent you always allow (kept with its allowance; one let in once has no lasting
 * identity to keep it with).
 *
 * Everything on it but its buttons is from the agent (its name) or the page (the element's name, already in Chord's
 * own words and cut): shown as plain text.
 */
import { randomBytes } from 'node:crypto';
import type { Grant, WindowId } from '@chord/core';
import type { AgentSiteCard, AgentStepCard } from '@chord/ipc';
import { plain } from './connect';

/** What a site card asks: who, where, what first, and whether *Always on this site* is offered. */
export interface SiteQuestion {
  name: string;
  site: string;
  /** The first action, in Chord's words (core's actPhrase): `click “Start a return”`. */
  action: string;
  always: boolean;
}

/** What a step card asks (S18 M2d): who, what will happen, what it's about to do, what goes with it. */
export interface StepQuestion {
  name: string;
  title: string;
  action: string;
  fields: string[];
  more: number;
  danger: boolean;
  shows?: string;
  typed?: string;
  sends?: { sites: string[]; other: boolean };
  idle?: boolean;
  untilDone?: boolean;
  going?: string;
  to?: string;
  /** Show me: the tab shown in that window, the element outlined; the card stays. */
  show(windowId: WindowId): void;
}

export interface SiteCardsDeps {
  /** The window used last (never a private one); null while there's none. */
  lastWindow(): WindowId | null;
  /** The cards changed: windows' popovers show them again. */
  changed(): void;
}

interface Waiting {
  card: AgentSiteCard | AgentStepCard;
  windowId: WindowId | null;
  answer(answer: 'deny' | 'once' | 'always', windowId: WindowId | null): void;
  show?(windowId: WindowId): void;
}

/** Cut to `max` characters, with an ellipsis. */
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class SiteCards {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly deps: SiteCardsDeps) {}

  /** Ask; a no when `signal` aborts (Stop, the agent going, the call's own end). */
  ask(question: SiteQuestion, signal: AbortSignal): Promise<Grant> {
    if (signal.aborted) return Promise.resolve('deny');
    return new Promise<Grant>((resolve) => {
      const id = randomBytes(8).toString('hex');
      const entry: Waiting = {
        card: { kind: 'site', id, name: plain(question.name).slice(0, 60), site: plain(question.site).slice(0, 253), action: plain(question.action).slice(0, 200), always: question.always },
        windowId: this.deps.lastWindow(),
        answer: (answer) => {
          if (!this.waiting.delete(id)) return;
          signal.removeEventListener('abort', onAbort);
          this.deps.changed();
          // Always on this site only where it was offered: otherwise it's Allow for now.
          resolve(answer === 'always' && !question.always ? 'once' : answer);
        },
      };
      const onAbort = () => entry.answer('deny', entry.windowId);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, entry);
      this.deps.changed();
    });
  }

  /**
   * Ask a risky step (S18 M2d), where the site card asks: Don't (or ×), Allow (once: never remembered), and Show me,
   * which leaves it up. A no when `signal` aborts.
   */
  askStep(question: StepQuestion, signal: AbortSignal): Promise<Grant> {
    if (signal.aborted) return Promise.resolve('deny');
    return new Promise<Grant>((resolve) => {
      const id = randomBytes(8).toString('hex');
      const entry: Waiting = {
        card: {
          kind: 'step',
          id,
          name: plain(question.name).slice(0, 60),
          title: plain(question.title).slice(0, 300),
          action: plain(question.action).slice(0, 200),
          fields: question.fields.map((f) => plain(f).slice(0, 60)).slice(0, 6),
          more: Math.max(0, Math.floor(question.more)),
          danger: question.danger,
          ...(question.shows ? { shows: plain(question.shows).slice(0, 60) } : {}),
          ...(question.typed !== undefined ? { typed: cut(plain(question.typed), 120) } : {}),
          ...(question.sends ? { sends: { sites: question.sends.sites.map((s) => plain(s).slice(0, 253)).slice(0, 8), other: question.sends.other } } : {}),
          ...(question.idle ? { idle: true } : {}),
          ...(question.untilDone ? { untilDone: true } : {}),
          ...(question.going ? { going: plain(question.going).slice(0, 200) } : {}),
          ...(question.to ? { to: plain(question.to).slice(0, 253) } : {}),
        },
        windowId: this.deps.lastWindow(),
        answer: (answer) => {
          if (!this.waiting.delete(id)) return;
          signal.removeEventListener('abort', onAbort);
          this.deps.changed();
          // A step's yes is for this once, whatever button said it; a send card's *Allow until done* is `always` (sends.ts).
          resolve(answer === 'deny' ? 'deny' : answer === 'always' && question.untilDone ? 'always' : 'once');
        },
        show: (windowId) => question.show(windowId),
      };
      const onAbort = () => entry.answer('deny', entry.windowId);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, entry);
      this.deps.changed();
    });
  }

  /** The card a window shows: the oldest waiting there. A card waiting for a window goes to this one if it's the one used last. */
  cardFor(windowId: WindowId): AgentSiteCard | AgentStepCard | null {
    for (const entry of this.waiting.values()) if (entry.windowId === windowId) return entry.card;
    if (this.deps.lastWindow() === windowId) {
      for (const entry of this.waiting.values()) {
        if (entry.windowId) continue;
        entry.windowId = windowId;
        return entry.card;
      }
    }
    return null;
  }

  /** Your answer, from the card in that window's popover (only that window's card). */
  answer(id: string, answer: 'deny' | 'once' | 'always' | 'show', windowId: WindowId): boolean {
    const entry = this.waiting.get(id);
    if (!entry || entry.windowId !== windowId) return false;
    // Show me: only a step card's, and it stays up.
    if (answer === 'show') {
      entry.show?.(windowId);
      return true;
    }
    entry.answer(answer, windowId);
    return true;
  }

  windowFocused(windowId: WindowId): void {
    let moved = false;
    for (const entry of this.waiting.values()) {
      if (entry.windowId) continue;
      entry.windowId = windowId;
      moved = true;
    }
    if (moved) this.deps.changed();
  }

  /** A window closed: its cards go to the window used last, or wait for a normal window (never a no on their own). */
  windowClosed(windowId: WindowId): void {
    const to = this.deps.lastWindow();
    for (const entry of this.waiting.values()) if (entry.windowId === windowId) entry.windowId = to && to !== windowId ? to : null;
    this.deps.changed();
  }
}
