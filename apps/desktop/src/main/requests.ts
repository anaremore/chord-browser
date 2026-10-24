/**
 * One `onBeforeRequest` listener per session, shared (ARCHITECTURE.md §1 rule
 * 2, §9). Electron keeps a single listener per event per session, so a
 * feature that needs to hold or cancel requests registers a handler here
 * rather than setting its own and silently replacing another's.
 *
 * Only for sessions where nothing else can do the job. A session with any
 * webRequest listener sends every request through Electron's own proxy on
 * main's thread, and extensions' webRequest listeners and declarativeNetRequest
 * rules stop applying to it (electron_browser_client.cc,
 * WillCreateURLLoaderFactory). So chords' sessions, where extensions run,
 * never get one; private windows' in-memory sessions, where extensions can't
 * load, do while ad blocking is on.
 *
 * Handlers answer synchronously or with a promise; the first to cancel wins.
 * Each must take microseconds: every request of every page in the session
 * waits on main's thread for them.
 */
import type { OnBeforeRequestListenerDetails, Session } from 'electron';

export type RequestVerdict = 'cancel' | undefined;

export interface RequestHandler {
  /** Electron URL patterns (`*://*\/*`); a request matching none never reaches JavaScript. */
  urls: string[];
  handle(details: OnBeforeRequestListenerDetails): RequestVerdict | Promise<RequestVerdict>;
}

export class RequestDispatcher {
  private readonly handlers = new Set<RequestHandler>();

  constructor(private readonly session: Session) {}

  get size(): number {
    return this.handlers.size;
  }

  /** Add a handler; the returned function removes it. */
  add(handler: RequestHandler): () => void {
    this.handlers.add(handler);
    this.listen();
    return () => {
      this.handlers.delete(handler);
      this.listen();
    };
  }

  /** The one listener, filtered to every handler's patterns, or none at all once no handler is left. */
  private listen(): void {
    if (this.handlers.size === 0) {
      this.session.webRequest.onBeforeRequest(null);
      return;
    }
    const urls = [...new Set([...this.handlers].flatMap((h) => h.urls))];
    const handlers = [...this.handlers];
    this.session.webRequest.onBeforeRequest({ urls }, (details, callback) => {
      let pending: Promise<RequestVerdict>[] | null = null;
      for (const handler of handlers) {
        let verdict: RequestVerdict | Promise<RequestVerdict>;
        try {
          verdict = handler.handle(details);
        } catch {
          continue;
        }
        if (verdict === 'cancel') return callback({ cancel: true });
        if (verdict) (pending ??= []).push(verdict.catch(() => undefined));
      }
      if (!pending) return callback({});
      void Promise.all(pending).then((verdicts) => callback(verdicts.includes('cancel') ? { cancel: true } : {}));
    });
  }
}

const dispatchers = new WeakMap<Session, RequestDispatcher>();

/** The session's dispatcher (made on first use). */
export function requestDispatcher(session: Session): RequestDispatcher {
  let dispatcher = dispatchers.get(session);
  if (!dispatcher) {
    dispatcher = new RequestDispatcher(session);
    dispatchers.set(session, dispatcher);
  }
  return dispatcher;
}
