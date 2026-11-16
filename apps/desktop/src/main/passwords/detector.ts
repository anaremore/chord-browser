/**
 * The password detector's main side (S17 §4–§8): the sentinel preload registered on chords'
 * sessions while passwords are on, the agent's script served to it, and the agent's messages
 * checked and turned into events for the vault and the menu.
 *
 * - **On and off** without a restart: `setEnabled` registers or unregisters the sentinel
 *   (`registerPreloadScript`, M0 §1); a page takes the change at its next navigation, and
 *   messages from an agent left in a page of a chord turned off are dropped. The vault side
 *   owns the setting and the extension rule (S17 §11) and calls `setEnabled`; this reads no
 *   settings.
 * - **Who's asking:** only a tab's page (`attachPage`), only its main frame (phase 1), only an
 *   `http:` or `https:` origin, and that origin is the sender frame's as Chromium reports it
 *   (`event.senderFrame.origin`), never a word from the payload. Every payload is checked
 *   against @chord/ipc's strict schemas and a size limit.
 * - **Values:** only a candidate sent at a submit signal carries what was typed (the username
 *   and the password to save). The tracker holds them with the form, and they leave only on
 *   `signedIn`, for the save card. Nothing here logs, echoes or stores them.
 * - **Private windows** fill and never save (S17 §7): `signedIn` and `failed` never fire there,
 *   and a candidate's values are dropped as it arrives.
 * - **A page can't flood main:** each page's messages pass a token bucket (`MESSAGE_RATE`) before
 *   anything is parsed; the excess is dropped without a word. Focus and blur have one bucket and
 *   the rest (`candidate`, `forms`, `gone`, `still`, `hint`) another, so a page busy with focus
 *   can't crowd out a sign-in's messages; both start afresh with each new document. The agent
 *   sends far fewer: focus, blur and forms at most once a frame, one candidate per submit.
 *
 * Events (`events`): `focus`, `blur`, `submitted`, `signedIn`, `failed`, and `filled` (the
 * agent's answer to a fill the menu sent). Nothing here logs a
 * payload: a refused message is dropped without a word.
 */
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  PASSWORDS_AGENT_SOURCE,
  PASSWORDS_MESSAGE_MAX,
  passwordsAgentSchemas,
  type PasswordsAgentChannel,
  type PasswordsAgentMessage,
  type PasswordsFocus,
} from '@chord/ipc';
import type { IpcMainEvent, IpcMainInvokeEvent, Session, WebContents, WebFrameMain } from 'electron';
import { SETTLE_MS, SubmissionTracker, type SavingOutcome } from './saving';

/** The sentinel's registration id on each session. */
export const SENTINEL_ID = 'chord-passwords';

/** Chromium's net error for a navigation that was cancelled or replaced. */
const ERR_ABORTED = -3;

/**
 * Each page's messages to the detector: `burst` at once, then `perSecond`. A person focusing fields
 * and signing in sends a few a second; a page moving focus in a loop is held to this.
 */
export const MESSAGE_RATE = { perSecond: 20, burst: 10 } as const;

/** A token bucket: `take()` says whether one more message may pass now. */
export function tokenBucket(now: () => number, { perSecond, burst }: { perSecond: number; burst: number } = MESSAGE_RATE): { take(): boolean } {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export interface PasswordsFocusEvent extends PasswordsFocus {
  readonly contents: WebContents;
  readonly frame: WebFrameMain;
  /** The sender frame's origin, as Chromium reports it. */
  readonly origin: string;
  /** The page's zoom when the field took focus: the menu places the rect with it. */
  readonly zoomFactor: number;
}
export interface PasswordsBlurEvent {
  readonly contents: WebContents;
  readonly formId: string;
}
export interface PasswordsFilledEvent {
  readonly contents: WebContents;
  readonly formId: string;
  readonly ok: boolean;
}
type Outcome<T extends SavingOutcome['type']> = Omit<Extract<SavingOutcome, { type: T }>, 'type'> & { readonly contents: WebContents };

export interface PasswordDetectorEvents {
  focus: [PasswordsFocusEvent];
  blur: [PasswordsBlurEvent];
  submitted: [Outcome<'submitted'>];
  signedIn: [Outcome<'signedIn'>];
  failed: [Outcome<'failed'>];
  filled: [PasswordsFilledEvent];
}

export interface PasswordDetectorOptions {
  /** The built sentinel (out/preload/passwords.cjs). */
  readonly preloadPath: string;
  /** The built agent (out/main/passwords/agent.js). */
  readonly agentPath: string;
  /** For tests: how the agent's script is read, and a clock. */
  readonly readAgent?: (path: string) => Promise<string>;
  readonly now?: () => number;
}

export interface PasswordDetector {
  readonly events: EventEmitter<PasswordDetectorEvents>;
  /** A chord's session, as it's made. `isPrivate`: a private window's. */
  attachSession(profileId: string, session: Session, isPrivate: boolean): void;
  /** A tab's page, as its webContents is made: the only pages the agent's channels answer. */
  attachPage(contents: WebContents): void;
  /**
   * Any other webContents on a chord's session (Peek, a pop-up, an extension's page), as it's made: the
   * sentinel runs there too, and its ask for the agent gets nothing rather than "no handler". A tab's
   * page attached later replaces this.
   */
  attachOther(contents: WebContents): void;
  /** Turns detection on or off for these chords' profiles, or for every one (and every one made later) when none are named. */
  setEnabled(on: boolean, profileIds?: readonly string[]): void;
  /** Detection on in exactly these chords' profiles and off in every other one (and every one made later). */
  setProfiles(profileIds: readonly string[]): void;
  isEnabled(profileId: string): boolean;
}

interface SessionEntry {
  readonly profileId: string;
  readonly session: Session;
  readonly isPrivate: boolean;
  registration: string | null;
}

/** Where a message may come from: a web origin, in the page's main frame. */
type FrameIds = Pick<WebFrameMain, 'origin' | 'parent' | 'processId' | 'routingId'>;
export function pageOrigin(frame: FrameIds | null | undefined, mainFrame: Pick<WebFrameMain, 'processId' | 'routingId'> | null | undefined): string | null {
  if (!frame || !mainFrame || frame.parent || frame.processId !== mainFrame.processId || frame.routingId !== mainFrame.routingId) return null;
  const origin = frame.origin;
  return /^https?:\/\/[^/]+$/i.test(origin) ? origin : null;
}

/** A payload checked against its channel's schema and the size limit, or null. Never echoed, never logged. */
export function checkMessage<C extends PasswordsAgentChannel>(channel: C, raw: unknown): PasswordsAgentMessage<C> | null {
  let size: number;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    return null;
  }
  if (size > PASSWORDS_MESSAGE_MAX) return null;
  const parsed = passwordsAgentSchemas[channel].safeParse(raw);
  return parsed.success ? (parsed.data as PasswordsAgentMessage<C>) : null;
}

export function createPasswordDetector(options: PasswordDetectorOptions): PasswordDetector {
  const events = new EventEmitter<PasswordDetectorEvents>();
  const sessions = new Map<Session, SessionEntry>();
  const explicit = new Map<string, boolean>();
  let everyone = false;
  let agentSource: Promise<string | null> | null = null;
  const read = options.readAgent ?? ((path: string) => readFile(path, 'utf8'));
  const now = options.now ?? Date.now;

  const isEnabled = (profileId: string) => explicit.get(profileId) ?? everyone;
  const apply = (entry: SessionEntry) => {
    const on = isEnabled(entry.profileId);
    if (on && !entry.registration) entry.registration = entry.session.registerPreloadScript({ type: 'frame', id: SENTINEL_ID, filePath: options.preloadPath });
    else if (!on && entry.registration) {
      entry.session.unregisterPreloadScript(entry.registration);
      entry.registration = null;
    }
  };

  /** The agent's script, read once, the first time a page asks (never at launch). */
  const source = () => (agentSource ??= read(options.agentPath).catch(() => ((agentSource = null), null)));

  function attachPage(contents: WebContents): void {
    const entryOf = () => sessions.get(contents.session);
    /** The sender's origin when this page may talk to the detector now, else null. */
    const allowed = (event: IpcMainEvent | IpcMainInvokeEvent): string | null => {
      const entry = entryOf();
      if (!entry || !isEnabled(entry.profileId) || contents.isDestroyed()) return null;
      return pageOrigin(event.senderFrame, contents.mainFrame);
    };
    const tracker = new SubmissionTracker(now);
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const emit = (outcomes: SavingOutcome[]) => {
      const priv = entryOf()?.isPrivate ?? true;
      for (const o of outcomes) {
        const { type, ...rest } = o;
        if (type === 'submitted') events.emit('submitted', { ...(rest as Omit<Extract<SavingOutcome, { type: 'submitted' }>, 'type'>), contents });
        // Private windows never save (S17 §7): nothing is offered there.
        else if (priv) continue;
        else if (type === 'signedIn') events.emit('signedIn', { ...(rest as Omit<Extract<SavingOutcome, { type: 'signedIn' }>, 'type'>), contents });
        else events.emit('failed', { ...(rest as Omit<Extract<SavingOutcome, { type: 'failed' }>, 'type'>), contents });
      }
    };

    contents.ipc.removeHandler(PASSWORDS_AGENT_SOURCE);
    contents.ipc.handle(PASSWORDS_AGENT_SOURCE, async (event) => (allowed(event) ? await source() : null));
    // Two buckets for the page: focus and blur, and the sign-in's own messages. Checked after the sender, before a message is sized or parsed.
    let buckets = { focus: tokenBucket(now), lifecycle: tokenBucket(now) };
    /** Main told the vault a field has focus: the blur that ends it always passes, so what main believes stays true. */
    let focusShown = false;
    const on = <C extends PasswordsAgentChannel>(channel: C, handle: (message: PasswordsAgentMessage<C>, origin: string, event: IpcMainEvent) => void) => {
      contents.ipc.on(`passwords:${channel}`, (event, raw: unknown) => {
        const origin = allowed(event);
        if (!origin) return;
        const free = channel === 'blur' && focusShown;
        if (!free && !(channel === 'focus' || channel === 'blur' ? buckets.focus : buckets.lifecycle).take()) return;
        const message = checkMessage(channel, raw);
        if (message) handle(message, origin, event);
      });
    };
    on('focus', (m, origin, event) => {
      focusShown = true;
      events.emit('focus', { ...m, contents, frame: event.senderFrame!, origin, zoomFactor: contents.getZoomFactor() });
    });
    on('blur', (m) => {
      focusShown = false;
      events.emit('blur', { contents, formId: m.formId });
    });
    on('candidate', (m, origin) => {
      // A private window never saves: what was typed there isn't even held.
      if ((entryOf()?.isPrivate ?? true) && m.values) {
        const { values: _values, ...rest } = m;
        return emit(tracker.candidate(rest, origin));
      }
      emit(tracker.candidate(m, origin));
    });
    on('forms', (m) => emit(tracker.forms(m)));
    on('gone', (m) => emit(tracker.gone(m.formId)));
    on('still', (m) => emit(tracker.still(m.formId)));
    on('hint', (m) => tracker.hint(m.formId, m.status));
    on('filled', (m) => events.emit('filled', { contents, formId: m.formId, ok: m.ok }));

    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      // Started by the page (a form's post, a script's location change), not by you from Chord's address bar or Back.
      emit(tracker.navigationStarted(!!details.initiator));
    });
    contents.on('did-navigate', (_event, _url, code) => {
      // A new document: its agent starts with full buckets, and nothing of the last page has focus.
      buckets = { focus: tokenBucket(now), lifecycle: tokenBucket(now) };
      focusShown = false;
      emit(tracker.navigated(code));
    });
    // A navigation that failed without committing: back to waiting on the form. Not ERR_ABORTED (-3): an aborted
    // navigation's late failure can arrive after another has replaced it. One aborted with nothing after it ends
    // at did-stop-loading, below.
    const failed = (code: number, isMainFrame: boolean) => {
      if (isMainFrame && code !== ERR_ABORTED) emit(tracker.navigationFailed());
    };
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => failed(code, isMainFrame));
    contents.on('did-fail-provisional-load', (_event, code, _description, _url, isMainFrame) => failed(code, isMainFrame));
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) emit(tracker.navigatedInPage());
    });
    contents.on('did-stop-loading', () => {
      // Loading stopped with nothing committed (a 204, a download): the navigation decided nothing.
      if (tracker.navigating) return void emit(tracker.navigationFailed());
      if (!tracker.settling) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!contents.isDestroyed()) emit(tracker.settled());
      }, SETTLE_MS);
    });
    contents.once('destroyed', () => {
      if (settleTimer) clearTimeout(settleTimer);
      tracker.reset();
    });
  }

  return {
    events,
    attachSession(profileId, session, isPrivate) {
      if (sessions.has(session)) return;
      const entry: SessionEntry = { profileId, session, isPrivate, registration: null };
      sessions.set(session, entry);
      apply(entry);
    },
    attachPage,
    attachOther(contents) {
      try {
        contents.ipc.handle(PASSWORDS_AGENT_SOURCE, () => null);
      } catch {
        // A handler already: a tab's page.
      }
    },
    setEnabled(on, profileIds) {
      if (!profileIds) {
        everyone = on;
        explicit.clear();
      } else for (const id of profileIds) explicit.set(id, on);
      for (const entry of sessions.values()) apply(entry);
    },
    setProfiles(profileIds) {
      everyone = false;
      explicit.clear();
      for (const id of profileIds) explicit.set(id, true);
      for (const entry of sessions.values()) apply(entry);
    },
    isEnabled,
  };
}
