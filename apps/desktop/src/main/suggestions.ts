/**
 * Search suggestions while typing (ROADMAP Q4, DESIGN.md §7.3). Main asks the
 * engine, never the page: through an in-memory session that sends and keeps
 * no cookies, so what comes back isn't tied to anyone's accounts. Typed
 * addresses never go out (core's suggestUrl). A newer question from the same
 * command bar cancels the one before it, and failures just mean no
 * suggestions. They go through the proxy for every chord, or, typed in a
 * chord with a proxy of its own, through that one (a session each).
 */
import { parseSuggestions, suggestUrl, type SearchEngineId } from '@chord/core';
import { app, session, type Session } from 'electron';
import { proxies } from './proxy';

const TIMEOUT_MS = 2000;

export interface SuggestionsOptions {
  enabled(): boolean;
  engine(): SearchEngineId;
}

export class Suggestions {
  private readonly inFlight = new Map<number, AbortController>();
  /** By the sign-ins whose own proxy they go through; null for the proxy for every chord. */
  private readonly sessions = new Map<string | null, Session>();
  /** Development and E2E only: one local endpoint for every engine, so tests need no network. */
  private readonly override = app.isPackaged ? undefined : process.env['CHORD_SUGGEST_URL'];

  constructor(private readonly options: SuggestionsOptions) {}

  /**
   * `askerId` identifies the command bar asking, so its newer question replaces its older one. `ownProxy`:
   * the sign-ins of the asking window's chord, when it has a proxy of its own.
   */
  async suggest(askerId: number, query: string, engine?: SearchEngineId, ownProxy: string | null = null): Promise<string[]> {
    this.inFlight.get(askerId)?.abort();
    this.inFlight.delete(askerId);
    if (!this.options.enabled()) return [];
    const url = this.endpoint(query, engine ?? this.options.engine());
    if (!url) return [];

    const controller = new AbortController();
    this.inFlight.set(askerId, controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const ses = this.session(ownProxy);
      await proxies.ready(ses);
      const response = await ses.fetch(url, {
        credentials: 'omit',
        signal: controller.signal,
        headers: { accept: 'application/x-suggestions+json, application/json' },
      });
      if (!response.ok) return [];
      return parseSuggestions(JSON.parse(await response.text()), query);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      if (this.inFlight.get(askerId) === controller) this.inFlight.delete(askerId);
    }
  }

  private endpoint(query: string, engine: SearchEngineId): string | null {
    const url = suggestUrl(query, engine);
    if (!url || !this.override) return url;
    return `${this.override}${encodeURIComponent(query.trim())}`;
  }

  /** Not `persist:`: nothing it receives outlives the run, and no page ever uses it. */
  private session(ownProxy: string | null): Session {
    let ses = this.sessions.get(ownProxy);
    if (!ses) {
      ses = proxies.make(ownProxy, () => session.fromPartition(ownProxy ? `chord-suggest-${ownProxy}` : 'chord-suggest', { cache: false }));
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.sessions.set(ownProxy, ses);
    }
    return ses;
  }
}
