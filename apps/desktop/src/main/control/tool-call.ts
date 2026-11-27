/** What every control tool shares (split from tools.ts, #213): one call's view of its agent, the tab it names, its page, and the refusals. */
import { firstLoadPending, pickersUnsecured } from '../agents/pickers';
import { type RiskWhy, CONTROL_REFUSALS, ACT_REFUSALS, barAddress, wholeAddress, isNeverReadable, nodeOf, toolResult, type AssistantToolName, type NodeId, type State, type TabNode } from '@chord/core';
import type { WebContents, WebContentsView } from 'electron';
import { pageOf } from '../view-page';
import { controlPage, type ControlPage, type LoadGate } from './page';
import { shownOrigin } from './sends';
import type { PageRead } from './extract';
import type { ControlAgent, ControlCard } from './gate';
import type { ControlScope, ToolMemory, ToolOutput } from './scope';

/** What of the browser the tools use: its state, its tabs' pages and reader view. */
export interface ControlBrowser {
  readonly store: { readonly state: State };
  readonly tabs: LoadGate & { get(nodeId: NodeId): WebContentsView | undefined; ensure(nodeId: NodeId): WebContentsView | undefined };
  readonly readers: { viewFor(nodeId: NodeId): WebContentsView | undefined };
}

/** PDFs kept per agent for later ranges and citations; the oldest goes first. */
export const PDFS_KEPT = 3;

export const NEVER = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';

/** Why a tab the scope won't read is refused: the scope's own words if it has them (sharing ended), else NEVER. */
export const unreadable = (scope: ControlScope, node: TabNode): string => scope.whyNot?.(node) ?? NEVER;

export const refuse = (why: string, problems?: string[]): ToolOutput => ({ text: toolResult({ refused: why, ...(problems ? { problems } : {}) }, false), isError: true });

/** One call's view of its agent: the scope, the browser, and the call's own Stop. */
export interface Call {
  scope: ControlScope;
  browser: ControlBrowser;
  signal: AbortSignal;
  /** The scope's card for this read, if it needs one: null to go on, else the refusal (`no`, in the front door's words, for a no). */
  card(tool: AssistantToolName, node: TabNode | null, description: string, target: string[], no: string): Promise<ToolOutput | null>;
  /** Stop came while the call waited: it answers already, and must change nothing more (the agent's memory, the chat). */
  stopped(): boolean;
  /** The scope's activity line, unless the call was stopped. */
  activity(tool: string, summary: string, detail?: string, ok?: boolean): Promise<void>;
  /** #143: when this call answers by (Date.now() time; scope.callDeadlineMs from its start), or null: no deadline. */
  deadline: number | null;
}


const isTab = (browser: ControlBrowser) => (id: NodeId) => nodeOf(browser.store.state, id)?.kind === 'tab';

/** The tab a ref names, or the refusal: `unknown` in the front door's words, a closed tab's in the gate's. */
export function resolveTab(call: Call, ref: unknown, unknown: string): TabNode | ToolOutput {
  const found = call.scope.refs.resolve(ref, isTab(call.browser));
  if (!found.ok) return refuse(found.why === 'closed' ? CONTROL_REFUSALS.closed : unknown);
  return nodeOf(call.browser.store.state, found.id) as TabNode;
}

export const isOutput = (x: TabNode | ToolOutput): x is ToolOutput => !('kind' in x);

/** Addresses a page can be read at; anything else (blank, an error page, not loaded yet) is simply not readable now. */
export const READABLE_ADDRESS = /^(https?|file):/i;

/**
 * Whether the tab can still be read where it is now, as its refusal; null if so. Asked again after the approval
 * card, after the load and after the read: a redirect or a navigation meanwhile can land on a *Never read* site,
 * and what was read there is thrown away. A tab that closed, or a page that's gone, is refused too. `page`: where
 * the page is, which can be ahead of the tab's saved address; `urls`: where the read itself says it was;
 * `unread`: what to say when one of them is no web address (the read's usual words).
 */
export function blockedNow(call: Call, nodeId: NodeId, page: ControlPage | null, unread: string, ...urls: string[]): string | null {
  // Settings' Nothing (or the scope's own off), turned on meanwhile: nothing more is read (round 1 of #232, SF2).
  const off = call.scope.off();
  if (off) return off;
  const now = nodeOf(call.browser.store.state, nodeId);
  if (now?.kind !== 'tab') return CONTROL_REFUSALS.closed;
  if (!call.scope.readable(now)) return unreadable(call.scope, now);
  if (page?.gone()) return unread;
  const addresses = [...(page ? [page.url()] : []), ...urls];
  const sites = call.scope.neverSites();
  if (addresses.some((url) => READABLE_ADDRESS.test(url) && isNeverReadable(url, sites))) return NEVER;
  // A tab shared on one site is never read on another (an outside agent's scope).
  if (call.scope.siteOk && addresses.some((url) => READABLE_ADDRESS.test(url) && !call.scope.siteOk!(now, url))) return unreadable(call.scope, now);
  return addresses.every((url) => READABLE_ADDRESS.test(url)) ? null : unread;
}

/**
 * Why a card's no wasn't the user's (S18 M2e-1, Neon's B2 on #116): the tab closed, Stop, or the user took the tab
 * over (its cards let go of since `released` was taken). Null: the user said no.
 */
export function notTheirNo(call: Call, agent: ControlAgent, nodeId: NodeId, released: number): string | null {
  if (nodeOf(call.browser.store.state, nodeId)?.kind !== 'tab') return CONTROL_REFUSALS.closed;
  if (call.stopped()) return CONTROL_REFUSALS.stopped;
  if (agent.state(nodeId).paused) return CONTROL_REFUSALS.paused;
  if (agent.releases(nodeId) !== released) return ACT_REFUSALS.takenOver;
  return null;
}

/** The tab's page, loading it if it's asleep or wasn't opened since launch. */
export async function loadedPage(browser: ControlBrowser, nodeId: NodeId, signal?: AbortSignal): Promise<ControlPage | null> {
  // A view whose page is gone (its renderer died) has none to wait on.
  const contents = pageOf(browser.tabs.ensure(nodeId));
  if (!contents) return null;
  // A page with a frame held unsecured never finishes loading (agents/pickers.ts): no waiting on it.
  // Stop and the client's cancel end the wait at once (round 1 of #145, SF3).
  if (!pickersUnsecured(contents)) await pageLoaded(contents, 15_000, signal);
  return contents.isDestroyed() ? null : controlPage(contents, browser.tabs);
}

/**
 * Waits (at most `ms`) for the tab's page to have loaded: not loading, and past an agent's tab's blank first page
 * (tabs.ts loads one first, to bypass service workers in, then the tab's address).
 */
export async function pageLoaded(contents: WebContents, ms: number, signal?: AbortSignal): Promise<void> {
  const until = Date.now() + ms;
  const waiting = () => !contents.isDestroyed() && (contents.isLoading() || firstLoadPending(contents));
  while (waiting() && Date.now() < until && !signal?.aborted) {
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        contents.off('did-stop-loading', finish);
        contents.off('destroyed', finish);
        done();
      };
      // An agent's tab between its blank page and its first: looked at again shortly (that load may not have started yet).
      const timer = setTimeout(finish, contents.isLoading() ? until - Date.now() : 50);
      signal?.addEventListener('abort', finish, { once: true });
      contents.once('did-stop-loading', finish);
      // Closed mid-load (#116): at once, not at the time limit.
      contents.once('destroyed', finish);
    });
  }
}

/** The tab's page as it is now, without waking it. */
export function currentPage(browser: ControlBrowser, nodeId: NodeId): ControlPage | null {
  const contents = pageOf(browser.tabs.get(nodeId));
  return contents ? controlPage(contents, browser.tabs) : null;
}

/** A tab read, and where (the assistant's readFrom: its origin then, Neon's B3 on #151). */
export function markRead(memory: ToolMemory, nodeId: NodeId, url: string): void {
  memory.read.add(nodeId);
  const origin = originOf(url);
  if (origin) memory.readFrom?.add(origin);
}

/**
 * The card's step for what an action's page held (askHeld): its sites, or the step a document's address is. Leaving:
 * the whole address, and what sent the tab on (`from`: the address navigate went to; else a page on the site), never the
 * bar's short one (Neon's B1 and N5 on #151). Another step (a delete or sign-out address): the short one.
 */
export function heldStep(held: { url: string; why: RiskWhy | null }[], sites: string[], why: RiskWhy | null, pageUrl: string, from?: string): NonNullable<ControlCard['step']> {
  if (!why) return { why: 'send', site: shownOrigin(originOf(pageUrl), pageUrl), fields: [], more: 0, sends: sites.map((o) => shownOrigin(o, pageUrl)) };
  const url = held.find((h) => h.why)?.url ?? '';
  const site = shownOrigin(sites[0] ?? '', pageUrl);
  if (why === 'leave') return { why, site, fields: [], more: 0, going: wholeAddress(url), from: from ?? `A page on ${shownOrigin(originOf(pageUrl), pageUrl)}` };
  return { why, site, fields: [], more: 0, going: barAddress(url) };
}

/** An address's origin (scheme, host and port), or empty. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
/** The page id taken before a read, if the page is still that document: one that navigated meanwhile gets none. */
export const sameId = (page: ControlPage, before: string): string | undefined => (before && page.id === before ? before : undefined);

/** Chromium's PDF viewer: the page's own document says application/pdf (and the extractor sees only the viewer). */
export function isPdf(page: PageRead | null, url: string): boolean {
  if (page) return page.contentType === 'application/pdf';
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
