/**
 * What an agent's tab sends (S18 M2d; the owner's default, 2026-11-23: "ask when it sends data", and #112 review 2:
 * all the time, not only while an action runs). The words, forms and addresses classify a step before it's sent
 * (core's control-risk.ts); this is the layer under them, by what the page does: every request an agent's tab makes,
 * in any frame or worker (dedicated, shared, service), its own process or another's, passes through Chromium's `Fetch`
 * domain on the tab's debugger (attached for the tab's life by agents/pickers.ts, which turns it on in each frame and
 * worker before it runs, and counts the tab's hold as on only once it's on in the page). A worker's requests are its
 * page's (a dedicated or shared worker has no Fetch domain of its own; a service worker's own are held in its target).
 * A redirect is paused at its response (documents, XHR and fetch only: a read's image or script never is): a 307 or
 * 308, which sends the body on, is held again for its new site (Neon's review 2 of #112), and one that takes a page to
 * an address that deletes or signs out asks as that step.
 *
 * - A request that only reads (GET, HEAD, a CORS preflight's OPTIONS) goes on, except a document (a page or a frame
 *   going somewhere) whose address deletes or signs out (core's addressWhy, as `navigate`'s): held, and asked about
 *   as that step (Neon's review 2 of #112: `location = '/account/delete'` from a click handler). A script's image or
 *   fetch GET to such an address isn't checked (a stated limit).
 * - A report (a beacon, an `<a ping>`: `resourceType` Ping; a CSP violation report) is dropped, answered with nothing,
 *   and never asked about (the owner's option A). The rare page that saves data by beacon loses it in an agent's tab.
 * - Anything else that sends data (a form posted, a fetch or XHR with another method) is held and asked about:
 *   - **During an action**, the action's card asks (tools.ts, through `watchSends`), naming the sites; Allow lets go
 *     what goes to those sites, and what's sent to them from then on in that action; anything to another site waits
 *     for a card of its own. A step the user already allowed (a classified risky one) lets go only what its card named
 *     (its page's site, its form's target site, its link's address), never everything.
 *   - **Between actions**, a card asks *Codex's tab wants to send data to its site* (`SendHoldDeps.ask`, the agent's
 *     own gate); what's sent to the same sites while it's up joins it, anything else waits for the next.
 *   Allow lets it go; Don't or no answer fails it, and the agent hears so with its next result. *Allow until done*
 *   (the owner, 2026-11-23) lets go what this tab sends to those sites from then on too, without a card, until the
 *   agent is done with it: its connection ends, it's stopped, the tab closes, or you take the tab over. Never
 *   remembered past that; a new site still asks, and so does a step that deletes or signs out.
 * - **Yours**: while you have the tab (a key or click of yours paused the agent there), what it sends is yours and
 *   goes. Your taking it over, and Stop, fail what was held for the agent and take its card down (`failHeld`).
 *
 * A request dropped is answered: a document with an empty 204 (the page stays where it was), anything else failed
 * (the page's script sees an error, as for a blocked request).
 *
 * Not held (a stated limit, the owner's, 2026-11-23): live connections, WebSocket, WebRTC and WebTransport. They don't
 * pass through Fetch; a page that sends over one sends unasked.
 */
import { addressWhy, type RiskWhy } from '@chord/core';
import type { WebContents } from 'electron';

/** Each command's limit (those whose answer is waited on). */
const COMMAND_MS = 3000;
/** Reports: dropped, never asked. */
const REPORTS = new Set(['Ping', 'CSPViolationReport']);
/** Methods that send nothing of the page's (a preflight's OPTIONS asks whether the real request may go: that one's held). */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Paused = { requestId: string; sessionId: string | undefined; url: string; type: string; why: RiskWhy | null };

/** Responses paused: only where a redirect can carry data on, or take a page somewhere. */
const RESPONSES = ['Document', 'XHR', 'Fetch', 'Other'];
/** What every request's hold pauses: its start, and those responses. */
const PATTERNS = [{ requestStage: 'Request' }, ...RESPONSES.map((resourceType) => ({ resourceType, requestStage: 'Response' }))];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A send card's answer: Don't (or none), Allow, or *Allow until done* (those sites, this tab, until the agent's done). */
export type SendAnswer = 'deny' | 'once' | 'until';

/** What a tab's hold needs from its agent's chord (agents/chords.ts), once its page is wired. */
export interface SendHoldDeps {
  /** Whose the tab's sends are now: the agent's (held, asked), yours (they go), or no one's to ask (dropped). */
  whose(): 'agent' | 'user' | 'none';
  /** Between actions: the card, *Codex's tab wants to send data to …* (or the step an address is: `why`). */
  ask(sites: string[], why: RiskWhy | null, signal: AbortSignal): Promise<SendAnswer>;
  /** A request's site, as the card names it. */
  siteOf(url: string): string;
}

/** What one action sent, held, so far. */
export interface SendWatch {
  /** What's held now: each request's address and, for a document going somewhere risky, why. */
  held(): { url: string; why: RiskWhy | null }[];
  /** The sites of these addresses, as the hold tells them apart (what allow() compares): each once, in order. */
  sitesOf(urls: readonly string[]): string[];
  /** Resolves once something is held (at once if something is now), or the action is cancelled. */
  nextHeld(): Promise<'held'>;
  /** Cancelled: you took the tab over, or Stop (failHeld). The action's card comes down. */
  readonly cancelled: AbortSignal;
  /** Allow: what's held for these sites goes, and what's sent to them from now on in this action (`until`: and after it, until the agent's done). */
  allow(sites: ReadonlySet<string>, until?: boolean): void;
  /** Don't: all of it dropped, and anything sent from now on in this action. */
  deny(): void;
  /** The action's over: anything still held is asked about as the tab's (the card between actions). */
  end(): void;
}

/** What a step the user already allowed lets go (its card named it): sites data may go to, and addresses it may open. */
export interface Allowed {
  sites: ReadonlySet<string>;
  urls: ReadonlySet<string>;
}

interface Action {
  denied: boolean;
  /** Sites Allow named (or the allowed step's card): their requests go. */
  sites: Set<string>;
  /** Addresses the allowed step's card named (a link to a delete address): a document going there goes. */
  urls: Set<string>;
  held: Paused[];
  waiting: (() => void)[];
  cancel: AbortController;
}

interface Hold {
  contents: object;
  deps: SendHoldDeps | null;
  action: Action | null;
  /** Held between actions, not yet on a card. */
  idle: Paused[];
  /** The card up between actions: its sites, and what's held for them. */
  card: { sites: Set<string>; held: Paused[]; cancel: AbortController } | null;
  /** *Allow until done*: sites this tab's sends go to without a card, until the agent's done with it (failHeld, endUntil). */
  until: Set<string>;
  go(p: Paused): void;
  drop(p: Paused): void;
}

const holds = new WeakMap<object, Hold>();
/** What was dropped (Don't, no answer, Stop, your taking over), per tab, until the agent's next action there takes the count. */
const dropped = new WeakMap<object, number>();

/** What the tab sent that was dropped since the agent's last action there: taken (the count goes back to 0). */
export function takeDroppedAfter(contents: object): number {
  const n = dropped.get(contents) ?? 0;
  dropped.delete(contents);
  return n;
}

const countDropped = (contents: object, n: number) => {
  if (n > 0) dropped.set(contents, (dropped.get(contents) ?? 0) + n);
};

/** A site as the card names it: by the chord's deps, or the address's host. */
const siteBy = (hold: Hold, url: string) => hold.deps?.siteOf(url) ?? hostOf(url);

/**
 * Starts the tab's send hold (agents/pickers.ts, as it starts the tab's picker hold): every request it makes from now
 * on is answered here. Until `sendHoldDeps` gives it its chord, what it sends waits.
 */
export function holdSends(contents: WebContents): void {
  if (holds.has(contents) || contents.isDestroyed()) return;
  const debug = contents.debugger;
  /** An answer nothing waits on (most requests: every read): no timer of its own. */
  const answer = (method: string, params: object, sessionId?: string) => {
    if (contents.isDestroyed() || !debug.isAttached()) return;
    debug.sendCommand(method, params, sessionId).catch(() => undefined);
  };
  const hold: Hold = {
    contents,
    deps: null,
    action: null,
    idle: [],
    card: null,
    until: new Set(),
    go: (p) => answer('Fetch.continueRequest', { requestId: p.requestId }, p.sessionId),
    drop: (p) =>
      p.type === 'Document'
        ? answer('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: [] }, p.sessionId)
        : answer('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, p.sessionId),
  };
  holds.set(contents, hold);
  debug.on('message', (_event, method: string, params: unknown, sessionId?: string) => {
    if (method !== 'Fetch.requestPaused') return;
    const at = params as {
      requestId?: string;
      request?: { method?: string; url?: string };
      resourceType?: string;
      responseStatusCode?: number;
      responseHeaders?: { name: string; value: string }[];
    };
    if (!at.requestId) return;
    // The page's own target comes with an empty session id: answered without one (an empty one reaches no session).
    const type = String(at.resourceType ?? '');
    const how = String(at.request?.method ?? 'GET').toUpperCase();
    let url = String(at.request?.url ?? '');
    let read = READS.has(how);
    if (at.responseStatusCode !== undefined) {
      // A response: only a redirect matters, and only where it goes is asked about.
      const location = at.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
      const next = REDIRECTS.has(at.responseStatusCode) && location ? resolved(location, url) : '';
      if (!next) return hold.go({ requestId: at.requestId, sessionId: sessionId || undefined, url, type, why: null });
      // A 307 or 308 sends the same request on, its body too; any other redirect goes on as a read.
      if (!(at.responseStatusCode === 307 || at.responseStatusCode === 308)) read = true;
      url = next;
    }
    const p: Paused = { requestId: at.requestId, sessionId: sessionId || undefined, url, type, why: read && type === 'Document' ? addressWhy(url) : null };
    if (read && !p.why) return hold.go(p);
    // A report: dropped, never asked (the owner's option A).
    if (REPORTS.has(type)) return hold.drop(p);
    const whose = hold.deps?.whose() ?? 'agent';
    if (whose === 'user') return hold.go(p);
    // Allowed until done: data to those sites goes (a step an address is still asks).
    if (whose === 'agent' && !p.why && hold.until.has(siteBy(hold, url))) return hold.go(p);
    const action = hold.action;
    if (action) {
      if (action.denied) return hold.drop(p);
      if (p.why ? action.urls.has(url) : action.sites.has(siteBy(hold, url))) return hold.go(p);
      action.held.push(p);
      for (const wake of action.waiting.splice(0)) wake();
      return;
    }
    if (whose === 'none') {
      countDropped(contents, 1);
      return hold.drop(p);
    }
    heldBetween(hold, [p]);
  });
  // Gone with its page: nothing held outlives it (a closed tab's requests go with its renderer).
  contents.once('destroyed', () => {
    hold.card?.cancel.abort();
    hold.action?.cancel.abort();
    holds.delete(contents);
  });
}

/** The tab's chord, once its page is wired (agents/chords.ts): what was held meanwhile is asked about now. */
export function sendHoldDeps(contents: object, deps: SendHoldDeps): void {
  const hold = holds.get(contents);
  if (!hold) return;
  hold.deps = deps;
  askNext(hold);
}

/** Held between actions: on the card up if it names their site (and it's data, not a step), else for the next card. */
function heldBetween(hold: Hold, held: Paused[]): void {
  for (const p of held) {
    if (hold.card && !p.why && hold.card.sites.has(siteBy(hold, p.url))) hold.card.held.push(p);
    else hold.idle.push(p);
  }
  askNext(hold);
}

/** A card for what waits, if none is up: a step an address is gets its own; data, its sites. Only what it names goes. */
function askNext(hold: Hold): void {
  const deps = hold.deps;
  if (hold.card || !deps || hold.idle.length === 0) return;
  const step = hold.idle.find((p) => p.why);
  const batch = step ? hold.idle.splice(hold.idle.indexOf(step), 1) : hold.idle.splice(0, hold.idle.length);
  const sites = [...new Set(batch.map((p) => siteBy(hold, p.url)))];
  const card = { sites: new Set(step ? [] : sites), held: batch, cancel: new AbortController() };
  hold.card = card;
  void deps.ask(sites, step?.why ?? null, card.cancel.signal).then(
    (answer) => settleCard(hold, card, answer),
    () => settleCard(hold, card, 'deny'),
  );
}

function settleCard(hold: Hold, card: NonNullable<Hold['card']>, answer: SendAnswer): void {
  if (hold.card !== card) return;
  hold.card = null;
  const allow = answer !== 'deny';
  if (answer === 'until' && hold.deps?.whose() === 'agent') for (const site of card.sites) hold.until.add(site);
  // Still the agent's to send: you may have taken the tab meanwhile (then it was failed already: failHeld).
  const go = allow && hold.deps?.whose() === 'agent';
  for (const p of card.held) (go ? hold.go : hold.drop)(p);
  if (!go) countDropped(hold.contents, card.held.length);
  askNext(hold);
}

/**
 * What's held for the agent fails, and its cards come down (the one between actions, and the action's): you took the
 * tab over (a key, a click), or Stop. From then on, while the tab is yours, what it sends goes.
 */
export function failHeld(contents: object): void {
  const hold = holds.get(contents);
  if (!hold) return;
  // Allow until done ends too: you took the tab, or the agent was stopped.
  hold.until.clear();
  const failed = [...hold.idle.splice(0), ...(hold.card ? hold.card.held.splice(0) : []), ...(hold.action ? hold.action.held.splice(0) : [])];
  if (hold.card) {
    const card = hold.card;
    hold.card = null;
    card.cancel.abort();
  }
  if (hold.action) {
    hold.action.denied = true;
    hold.action.cancel.abort();
    for (const wake of hold.action.waiting.splice(0)) wake();
  }
  for (const p of failed) hold.drop(p);
  countDropped(contents, failed.length);
}

/**
 * Starts watching what `contents` sends for one action. `allowed`: what a step the user already allowed lets go (its
 * card named it); nothing for an action no card asked about. `siteOf`: a request's site, as the card names it. Null
 * if the tab has no send hold, or another action there still watches: nothing is sent then (tools.ts refuses).
 */
export function watchSends(contents: WebContents, allowed: Allowed | null): SendWatch | null {
  const hold = holds.get(contents);
  if (!hold || hold.action || contents.isDestroyed() || !contents.debugger.isAttached()) return null;
  const action: Action = { denied: false, sites: new Set(allowed?.sites ?? []), urls: new Set(allowed?.urls ?? []), held: [], waiting: [], cancel: new AbortController() };
  hold.action = action;
  return {
    held: () => action.held.map((p) => ({ url: p.url, why: p.why })),
    sitesOf: (urls) => [...new Set(urls.map((u) => siteBy(hold, u)))],
    nextHeld: () => (action.held.length || action.denied ? Promise.resolve('held' as const) : new Promise<'held'>((done) => action.waiting.push(() => done('held')))),
    cancelled: action.cancel.signal,
    allow: (sites, until) => {
      if (action.denied) return;
      for (const site of sites) action.sites.add(site);
      if (until) for (const site of sites) hold.until.add(site);
      const still: Paused[] = [];
      for (const p of action.held.splice(0)) {
        // A document going somewhere risky is allowed by its own address only (its card named that step).
        const named = p.why ? sites.has(siteBy(hold, p.url)) : action.sites.has(siteBy(hold, p.url));
        if (!named) {
          still.push(p);
          continue;
        }
        if (p.why) action.urls.add(p.url);
        hold.go(p);
      }
      action.held.push(...still);
    },
    deny: () => {
      action.denied = true;
      for (const p of action.held.splice(0)) hold.drop(p);
    },
    end: () => {
      if (hold.action !== action) return;
      hold.action = null;
      for (const wake of action.waiting.splice(0)) wake();
      const left = action.held.splice(0);
      if (left.length) heldBetween(hold, left);
    },
  };
}

/** The agent's done with the tab (its connection ended): *Allow until done* ends. */
export function endUntil(contents: object): void {
  holds.get(contents)?.until.clear();
}

/** Every request the tab makes paused at its start, in the page or a frame or worker (agents/pickers.ts, before it runs). */
export function sendsOn(contents: WebContents, sessionId?: string): Promise<boolean> {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return Promise.resolve(false);
  return Promise.race([
    contents.debugger.sendCommand('Fetch.enable', { patterns: PATTERNS }, sessionId).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((done) => setTimeout(() => done(false), COMMAND_MS).unref?.()),
  ]);
}

/** A redirect's address, against the request's; empty when it can't be read. */
function resolved(location: string, base: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    return '';
  }
}

/** An address's host, or empty. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
