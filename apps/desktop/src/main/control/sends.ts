/**
 * What an agent's tab sends (S18 M2d; the owner's default, 2026-11-23: "ask when it sends data", and #112 review 2:
 * all the time, not only while an action runs). The words, forms and addresses classify a step before it's sent
 * (core's control-risk.ts); this is the layer under them, by what the page does: every request an agent's tab makes,
 * in any frame or dedicated worker, its own process or another's, passes through Chromium's `Fetch` domain on the
 * tab's debugger (attached for the tab's life by agents/pickers.ts, which turns it on in each frame before it runs, and
 * counts the tab's hold as on only once it's on in the page). A dedicated worker reads and never sends (its requests
 * never pass through its page's Fetch: agents/agent-scripts.ts' lock). Service workers are bypassed in an agent's tab,
 * so its requests are its own, and a service worker is never held: it's the site's, and your own tabs there send
 * through it too (Claude's review 3 of #112). An agent's tab has no shared workers, deferred sends or service workers
 * at all (agent-scripts.ts' PAGE_LACKS, and AGENT_POLICY on every document it loads).
 * A redirect's next request is paused again at its start (Chromium does that; Claude's review 3 of #112 had the
 * response-stage pause dropped, checked end to end): a 307 or 308, which sends the body on, is held again for its
 * new origin (Neon's review 2), and one that takes a page to an address that deletes or signs out asks as that step.
 *
 * - A request that only reads (GET, HEAD, OPTIONS, with no body) goes on, except a document (a page or a frame going
 *   somewhere) whose address deletes or signs out (core's pageAddressWhy): held, and asked about as that step (Neon's
 *   review 2 of #112: `location = '/account/delete'` from a click handler). A script's image or fetch GET to such an
 *   address isn't checked, nor what a GET's address carries (stated limits).
 * - A report (a beacon, an `<a ping>`: `resourceType` Ping; a CSP violation report) the agent's page sends is dropped,
 *   answered with nothing, and never asked about (the owner's option A); while you have the tab, yours go. The rare
 *   page that saves data by beacon loses it in an agent's tab.
 * - Anything else that sends data (a form posted, a fetch or XHR with another method) is held and asked about:
 *   - **During an action**, the action's card asks (tools.ts, through `watchSends`), naming the origins (by host);
 *     Allow lets go what goes to those exact origins, and what's sent to them from then on in that action; anything to
 *     another origin (another subdomain, port or scheme too: the owner, 2026-11-23) waits for a card of its own. A step
 *     the user already allowed (a classified risky one) lets go only its own addresses (its form's, its link's), never
 *     an origin: anything else its page sends still asks (Claude's review 3).
 *   - **Between actions**, a card asks *Codex's tab wants to send data to its site* (`SendHoldDeps.ask`, the agent's
 *     own gate); what's sent to the same sites while it's up joins it, anything else waits for the next.
 *   Allow lets it go; Don't or no answer fails it, and the agent hears so with its next result. *Allow until done*
 *   (the owner, 2026-11-23) lets go what this tab sends to those origins from then on too, without a card, until the
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
import { pageAddressWhy, type RiskWhy } from '@chord/core';
import type { WebContents } from 'electron';

/** Each command's limit (those whose answer is waited on). */
const COMMAND_MS = 3000;
/** Reports: dropped, never asked. */
const REPORTS = new Set(['Ping', 'CSPViolationReport']);
/**
 * Methods that send nothing of the page's (a preflight's OPTIONS asks whether the real request may go: that one's
 * held). Only with no body: any request that carries one sends it, whatever its method (round 4 of #112: an OPTIONS
 * with a body went unasked).
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** At most this many origins on one card (the card lists 8): the rest wait for the next (round 4 of #112). */
export const CARD_ORIGINS = 8;

type Paused = { requestId: string; sessionId: string | undefined; url: string; type: string; why: RiskWhy | null };

/**
 * What the hold pauses: every request at its start (a redirect's next one too), and a document's response, to add
 * NO_DEFERRED_SENDS to it (one pause a page or frame load, never a subresource's).
 */
const PATTERNS = [{ requestStage: 'Request' }, { resourceType: 'Document', requestStage: 'Response' }];
/**
 * Every document an agent's tab loads, and every frame under it (a sandboxed one too, which no script of the hold's
 * reaches), has no deferred sends (`fetchLater`: they go after the tab closes, out of the hold's sight; round 4 of
 * #112, seen sent from a sandboxed frame once the tab closed), and no passkey, payment or sign-in dialogs (Chord
 * doesn't sign agents in: the final pass of #112). The browser's own policy, as one header in place of the page's
 * own: a page's header that doesn't parse would make Chromium drop the whole policy, ours too (Neon's final pass), so
 * an agent's tab is the stricter for it.
 */
export const AGENT_POLICY = {
  name: 'Permissions-Policy',
  value: 'deferred-fetch=(), deferred-fetch-minimal=(), publickey-credentials-get=(), publickey-credentials-create=(), payment=(), identity-credentials-get=()',
};

/** A send card's answer: Don't (or none), Allow, or *Allow until done* (those sites, this tab, until the agent's done). */
export type SendAnswer = 'deny' | 'once' | 'until';

/** What a tab's hold needs from its agent's chord (agents/chords.ts), once its page is wired. */
export interface SendHoldDeps {
  /** Whose the tab's sends are now: the agent's (held, asked), yours (they go), or no one's to ask (dropped). */
  /** `request`: the one held now (its resource type, its address, and whether it's the page's own target's, not a frame's in another process), when there is one. */
  whose(request?: { type: string; url: string; top: boolean }): 'agent' | 'user' | 'none';
  /** Between actions: the card, *Codex's tab wants to send data to …* (or the step an address is: `why`, `going` there). */
  ask(sites: string[], why: RiskWhy | null, signal: AbortSignal, going?: string): Promise<SendAnswer>;
  /** A request's origin: what a card covers (the owner, 2026-11-23: exactly that origin, never its whole site). */
  siteOf(url: string): string;
  /** A page of the tab's own going to `url` leaves where the assistant asked to go (a tab of yours: M2e-2c), so it asks. */
  leaving?(url: string): boolean;
  /**
   * Where *Allow for this chat* is kept (the assistant: control/user-watch.ts): the chat's own origins for this tab, so
   * a grant outlives the lease (the reviews of #147). The hold covers them and adds to them; failHeld lets go of them
   * for this hold, never empties them (the chat does, as it ends or you take the tab).
   */
  kept?: Set<string>;
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
  /**
   * Allow. A send card's: what's held for these origins goes, and what's sent to them from now on in this action
   * (`until`: and after it, until the agent's done). A step card's (a document going to an address that deletes or
   * signs out): only that address, never its origin.
   */
  allow(grant: { origins: ReadonlySet<string>; until?: boolean } | { url: string }): void;
  /** Don't: all of it dropped, and anything sent from now on in this action. */
  deny(): void;
  /** The action's over: anything still held is asked about as the tab's (the card between actions). */
  end(): void;
}

/**
 * What a step the user already allowed lets go (its card named it), each once: `urls`, any request to exactly that
 * address (its form's, when it submits); `documents`, a page or frame going to exactly that address (its link's).
 */
export interface Allowed {
  urls: ReadonlySet<string>;
  documents?: ReadonlySet<string>;
}

interface Action {
  denied: boolean;
  /** Origins a send card's Allow named: their requests go. */
  sites: Set<string>;
  /** Addresses a step card named (its form's, a held request's): a request to exactly one goes, once. */
  urls: Set<string>;
  /** Addresses a page or frame may go to (a link's the step card named): once. */
  documents: Set<string>;
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
  /** *Allow until done*: origins this tab's sends go to without a card, until the agent's done with it (failHeld, endUntil). */
  until: Set<string>;
  /** Documents the agent already asked about (open_tab's step card): the first load of each goes, once. */
  once: Set<string>;
  go(p: Paused): void;
  drop(p: Paused): void;
  /** Stops answering the tab's requests (unholdSends: a lease on a tab of yours ending, S18 M2e-2a). */
  stop(): void;
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

/** What a card covers for an address: its origin (the chord's deps say how; until then, the address's own). */
const siteBy = (hold: Hold, url: string) => hold.deps?.siteOf(url) ?? originOf(url);

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
    once: new Set(),
    stop: () => undefined,
    go: (p) => answer('Fetch.continueRequest', { requestId: p.requestId }, p.sessionId),
    drop: (p) =>
      p.type === 'Document'
        ? answer('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: [] }, p.sessionId)
        : answer('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, p.sessionId),
  };
  holds.set(contents, hold);
  const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
    if (method !== 'Fetch.requestPaused') return;
    const at = params as {
      requestId?: string;
      request?: { method?: string; url?: string; hasPostData?: boolean; postData?: string };
      resourceType?: string;
      responseStatusCode?: number;
      responseHeaders?: { name: string; value: string }[];
      responseErrorReason?: string;
    };
    if (!at.requestId) return;
    // A document's response that failed (a network error): let go at once, to fail as it would (never a request again).
    if (at.responseErrorReason !== undefined) return answer('Fetch.continueRequest', { requestId: at.requestId }, sessionId || undefined);
    // A document's response: on, with the agent's policy in place of the page's (AGENT_POLICY).
    if (at.responseStatusCode !== undefined) {
      const headers = (at.responseHeaders ?? []).filter((h) => h.name.toLowerCase() !== 'permissions-policy');
      // Its status as it is (Chromium overrides headers only with the status given too).
      return answer('Fetch.continueResponse', { requestId: at.requestId, responseCode: at.responseStatusCode, responseHeaders: [...headers, AGENT_POLICY] }, sessionId || undefined);
    }
    // The page's own target comes with an empty session id: answered without one (an empty one reaches no session).
    const type = String(at.resourceType ?? '');
    const how = String(at.request?.method ?? 'GET').toUpperCase();
    const url = String(at.request?.url ?? '');
    const read = READS.has(how) && !at.request?.hasPostData && !at.request?.postData;
    // What a step it is: a document going to, or anything sent to, an address that deletes or signs out; a DELETE
    // always (round 4 of #112: Allow until done never covers one). A script's read of such an address isn't.
    const why: RiskWhy | null = how === 'DELETE' ? 'delete' : !read || type === 'Document' ? pageAddressWhy(url) : null;
    // The tab's own page going on to another site than the one the assistant asked to go to (an open redirect: B3).
    const leave: RiskWhy | null = !why && read && type === 'Document' && !sessionId && hold.deps?.leaving?.(url) ? 'leave' : null;
    const p: Paused = { requestId: at.requestId, sessionId: sessionId || undefined, url, type, why: why ?? leave };
    // A document the agent already asked about (open_tab): its first load goes.
    if (read && type === 'Document' && hold.once.delete(normalUrl(url))) return hold.go(p);
    if (read && !p.why) return hold.go(p);
    const whose = hold.deps?.whose({ type, url, top: !sessionId }) ?? 'agent';
    if (whose === 'user') return hold.go(p);
    // A report: dropped, never asked (the owner's option A).
    if (REPORTS.has(type)) return hold.drop(p);
    // No one's to ask (its chord gone: the tab closing, Close all): fails, whatever an action allowed (Neon's final
    // pass: a keepalive POST on close inside an action's settle).
    if (whose === 'none') {
      countDropped(contents, 1);
      return hold.drop(p);
    }
    // Allowed until done: data to those origins goes (a step an address is still asks).
    if (whose === 'agent' && !p.why && hold.until.has(siteBy(hold, url))) return hold.go(p);
    const action = hold.action;
    if (action) {
      if (action.denied) return hold.drop(p);
      // The step's own addresses, each once: its form's (any request), its link's (a document going there).
      if (action.urls.delete(normalUrl(url)) || (read && type === 'Document' && action.documents.delete(normalUrl(url)))) return hold.go(p);
      if (!p.why && action.sites.has(siteBy(hold, url))) return hold.go(p);
      action.held.push(p);
      for (const wake of action.waiting.splice(0)) wake();
      return;
    }
    heldBetween(hold, [p]);
  };
  debug.on('message', onMessage);
  // Gone with its page: nothing held outlives it (a closed tab's requests go with its renderer).
  const gone = () => {
    hold.card?.cancel.abort();
    hold.action?.cancel.abort();
    holds.delete(contents);
  };
  contents.once('destroyed', gone);
  // The renderer gone (a crash): what's held fails and its cards come down (#115, SF1). The debugger let go (a detach):
  // nothing can be failed any more (Chromium resumes what it paused for a detaching client), so the cards come down and
  // a late answer counts for nothing. Hence the invariant (#322, Opus's S1; invariants.test.ts): Chord never detaches
  // the debugger while it holds something here; failHeld comes first.
  const lost = () => failHeld(contents);
  debug.on('detach', lost);
  contents.on('render-process-gone', lost);
  hold.stop = () => {
    debug.off('message', onMessage);
    debug.off('detach', lost);
    contents.off('render-process-gone', lost);
    contents.off('destroyed', gone);
    gone();
  };
}

/**
 * The hold on a tab of yours ends (the assistant's lease: control/user-watch.ts). What's still held fails first (its
 * cards come down); the caller then turns Fetch off, so the tab's requests go as they always did.
 */
export function unholdSends(contents: object): void {
  const hold = holds.get(contents);
  if (!hold) return;
  failHeld(contents);
  hold.stop();
}

/** Whether something is held, or on a card, now: a lease waits for it before it ends. */
export function holding(contents: object): boolean {
  const hold = holds.get(contents);
  return Boolean(hold && (hold.card || hold.idle.length || hold.action));
}

/** The tab's chord, once its page is wired (agents/chords.ts): what was held meanwhile is asked about now. */
export function sendHoldDeps(contents: object, deps: SendHoldDeps): void {
  const hold = holds.get(contents);
  if (!hold) return;
  hold.deps = deps;
  if (deps.kept) hold.until = deps.kept;
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
  let batch: Paused[];
  if (step) batch = hold.idle.splice(hold.idle.indexOf(step), 1);
  else {
    // At most CARD_ORIGINS origins: what goes to others waits for the next card.
    const named = new Set<string>();
    for (const p of hold.idle) if (!p.why && named.size < CARD_ORIGINS) named.add(siteBy(hold, p.url));
    batch = hold.idle.filter((p) => !p.why && named.has(siteBy(hold, p.url)));
    hold.idle = hold.idle.filter((p) => !batch.includes(p));
  }
  const sites = [...new Set(batch.map((p) => siteBy(hold, p.url)))];
  const card = { sites: new Set(step ? [] : sites), held: batch, cancel: new AbortController() };
  hold.card = card;
  void deps.ask(sites, step?.why ?? null, card.cancel.signal, step?.url).then(
    (answer) => settleCard(hold, card, answer),
    () => settleCard(hold, card, 'deny'),
  );
}

function settleCard(hold: Hold, card: NonNullable<Hold['card']>, answer: SendAnswer): void {
  if (hold.card !== card) return;
  hold.card = null;
  const allow = answer !== 'deny';
  if (answer === 'until' && hold.deps?.whose() === 'agent') for (const site of card.sites) if (realOrigin(site)) hold.until.add(site);
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
  // Allow until done ends too: you took the tab, or the agent was stopped. A chat's own set (kept) is let go of, never
  // emptied here: the chat ends it.
  if (hold.deps?.kept === hold.until) hold.until = new Set();
  else hold.until.clear();
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
 * card named it); nothing for an action no card asked about. What a card covers is a request's origin (the chord's
 * deps' siteOf). Null
 * if the tab has no send hold, or another action there still watches: nothing is sent then (tools.ts refuses).
 */
export function watchSends(contents: WebContents, allowed: Allowed | null): SendWatch | null {
  const hold = holds.get(contents);
  if (!hold || hold.action || contents.isDestroyed() || !contents.debugger.isAttached()) return null;
  const action: Action = { denied: false, sites: new Set(), urls: new Set(allowed?.urls ?? []), documents: new Set(allowed?.documents ?? []), held: [], waiting: [], cancel: new AbortController() };
  hold.action = action;
  return {
    held: () => action.held.map((p) => ({ url: p.url, why: p.why })),
    sitesOf: (urls) => [...new Set(urls.map((u) => siteBy(hold, u)))],
    nextHeld: () => (action.held.length || action.denied ? Promise.resolve('held' as const) : new Promise<'held'>((done) => action.waiting.push(() => done('held')))),
    cancelled: action.cancel.signal,
    allow: (grant) => {
      if (action.denied) return;
      // A step card's yes: what's held for that one address, nothing else (Claude's review 3 of #112), once.
      if ('url' in grant) {
        const still: Paused[] = [];
        for (const p of action.held.splice(0)) {
          if (p.url === grant.url) hold.go(p);
          else still.push(p);
        }
        action.held.push(...still);
        return;
      }
      // An opaque or unreadable origin (a data: address: `null`, or none) is never covered beyond what's held now.
      for (const origin of grant.origins) {
        if (!realOrigin(origin)) continue;
        action.sites.add(origin);
        if (grant.until) hold.until.add(origin);
      }
      const still: Paused[] = [];
      for (const p of action.held.splice(0)) {
        if (!p.why && grant.origins.has(siteBy(hold, p.url))) hold.go(p);
        else still.push(p);
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

/** open_tab's step card allowed this address: the tab's first load of it goes (it isn't asked again between actions). */
export function allowFirstLoad(contents: object, url: string): void {
  holds.get(contents)?.once.add(normalUrl(url));
}

/** open_tab's load is over (it came, or didn't): an address it allowed that wasn't used is allowed no more. */
export function forgetFirstLoad(contents: object, url: string): void {
  holds.get(contents)?.once.delete(normalUrl(url));
}

/** An address as the browser writes it (`new URL(u).href`), so two spellings of one compare equal; else as it is. */
export function normalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * An origin as a card shows it: its host; with its scheme too where that isn't https or isn't the page's (Neon's 7: an
 * http send from an https page says so). An opaque or unreadable one says so.
 */
export function shownOrigin(origin: string, pageUrl: string): string {
  if (!origin || origin === 'null') return 'an address with no site';
  try {
    const u = new URL(origin);
    const pageScheme = new URL(pageUrl).protocol;
    return u.protocol === 'https:' && pageScheme === 'https:' ? u.host : origin;
  } catch {
    return origin;
  }
}

/** An origin a card can cover: a real one, never `null` (opaque) or none. */
function realOrigin(origin: string): boolean {
  return origin !== '' && origin !== 'null';
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

/** An address's origin (scheme, host and port), or empty. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
