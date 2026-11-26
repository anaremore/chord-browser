/**
 * The control layer's tools (S18 M1a): ASSISTANT_TOOLS' handlers, moved from
 * the assistant's service, for any front door. Each call goes through the
 * agent's gate (Stop answers at once), reads pages through the page adapter
 * (page.ts), and asks the scope what this agent may see and when it must ask.
 * The refusals are one sentence each, as the assistant has always said them.
 */
import { phaseClock } from './phases';
import { firstLoadPending, pickersUnsecured } from '../agents/pickers';
import { createHash, randomBytes } from 'node:crypto';
import {
  addressWhy,
  VALUE_TYPES,
  valueFits,
  classifyStep,
  sentLabels,
  stepFields,
  type RiskAction,
  type RiskClass,
  type RiskWhy,
  type Grant,
  type RiskElement,
  type RiskForm,
  ASSISTANT_PDF_MAX_PAGES,
  CONTROL_REFUSALS,
  controlTool,
  diagnosticsEntries,
  diagnosticsResult,
  diagnosticsSummary,
  fieldCount,
  formRead,
  formResult,
  ACT_REFUSALS,
  actDone,
  actPhrase,
  barAddress,
  wholeAddress,
  ELEMENT_REFUSALS,
  ElementRefs,
  isActionTool,
  sensitiveField,
  isPressKey,
  CONTROL_WAIT_MS,
  NAVIGATE_URL_MAX,
  pressKeyEvents,
  quotedName,
  TYPE_TEXT_MAX,
  type ActDescription,
  type ActTool,
  type ElementTool,
  type PressKey,
  isNeverReadable,
  nodeOf,
  pageResult,
  pdfText,
  proposedFill,
  PROPOSED_FILL_NOTE,
  snapshotKeys,
  snapshotNote,
  snapshotOutline,
  snapshotResult,
  toolResult,
  type AssistantFillCard,
  type AssistantToolName,
  type NodeId,
  type State,
  type TabNode,
  SNAPSHOT_FIND_MAX,
  WAIT_FOR_DEFAULT_MS,
  WAIT_FOR_MAX_MS,
  WAIT_FOR_TEXT_MAX,
  snapshotDiff,
  snapshotLines,
  type SnapshotRead,
} from '@chord/core';
import type { WebContents, WebContentsView } from 'electron';
import { pageOf } from '../view-page';
import { controlPage, type ControlPage } from './page';
import type { ActAnswer, ActOp } from './act';
import type { DeepAnswer, DeepSession } from './deep';
import { CARD_ORIGINS, normalUrl, shownOrigin, type Allowed, type SendWatch } from './sends';
import type { PageRead } from './extract';
import type { WaitAnswer } from './snapshot';
import type { AgentInputEvent } from './input';
import { extractPdf, PdfError, pdfProblemCopy } from './pdf';
import type { ControlAgent, ControlCard } from './gate';
import type { ControlScope, ToolMemory, ToolOutput } from './scope';

/** What of the browser the tools use: its state, its tabs' pages and reader view. */
export interface ControlBrowser {
  readonly store: { readonly state: State };
  readonly tabs: { get(nodeId: NodeId): WebContentsView | undefined; ensure(nodeId: NodeId): WebContentsView | undefined };
  readonly readers: { viewFor(nodeId: NodeId): WebContentsView | undefined };
}

/** PDFs kept per agent for later ranges and citations; the oldest goes first. */
const PDFS_KEPT = 3;

const NEVER = 'This page can never be read (a private window, a Chord page, or a site the user keeps private).';

/** Why a tab the scope won't read is refused: the scope's own words if it has them (sharing ended), else NEVER. */
const unreadable = (scope: ControlScope, node: TabNode): string => scope.whyNot?.(node) ?? NEVER;

const refuse = (why: string, problems?: string[]): ToolOutput => ({ text: toolResult({ refused: why, ...(problems ? { problems } : {}) }, false), isError: true });

/** One call's view of its agent: the scope, the browser, and the call's own Stop. */
interface Call {
  scope: ControlScope;
  browser: ControlBrowser;
  signal: AbortSignal;
  /** The scope's card for this read, if it needs one: null to go on, else the refusal (`no`, in the front door's words, for a no). */
  card(tool: AssistantToolName, node: TabNode | null, description: string, target: string[], no: string): Promise<ToolOutput | null>;
  /** Stop came while the call waited: it answers already, and must change nothing more (the agent's memory, the chat). */
  stopped(): boolean;
  /** The scope's activity line, unless the call was stopped. */
  activity(tool: string, summary: string, detail?: string, ok?: boolean): Promise<void>;
}

/** A tool call from a model: through the gate, then its handler. */
/**
 * `cancelled`: the client gave up on this call (MCP's notifications/cancelled; Neon's review of M2g-1, B5): as Stop is for
 * it, so a long call (wait_for) ends and takes down what it left in the page.
 */
/**
 * `settled`: a snapshot taken for an action's answer (open_tab's snapshot: true): of the page as the action left it,
 * never waiting for a load (round 1 of #232, SF1).
 */
export async function runControlTool(scope: ControlScope, browser: ControlBrowser, name: string, args: Record<string, unknown>, cancelled?: AbortSignal, settled = false): Promise<ToolOutput> {
  const spec = controlTool(name);
  // M2's tools exist only where the scope offers them (a build that has M2), and acting only where it lets its agent
  // act (outside agents in M2c): elsewhere they're unknown, as they were.
  if (!spec || (isActionTool(spec.name) && (!scope.actions || (spec.level === 'act' && !scope.act)))) return { text: toolResult({ error: `Unknown tool ${name}` }, false), isError: true };
  const off = scope.off();
  if (off) return refuse(off);
  const ref = args['tab_id'];
  const tab = typeof ref === 'string' ? (scope.refs.get(ref) ?? null) : null;
  // The whole call's time, by tool (M2g-1's measurement: phases.ts), from here to its answer.
  const clock = phaseClock(spec.name);
  const answered = scope.agent.call(
    tab,
    async (gateSignal) => {
      const signal = cancelled ? AbortSignal.any([gateSignal, cancelled]) : gateSignal;
      const call: Call = {
        scope,
        browser,
        signal,
        card: async (tool, node, description, target, no) => {
          const needed = scope.needsCard(tool, node);
          if (!needed) return null;
          const answer = await scope.agent.ask({ ...needed, tool, description, target, tab: node?.id ?? null }, signal, scope.cardWaitMs);
          if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
          return answer === 'deny' ? refuse(no) : null;
        },
        stopped: () => signal.aborted,
        activity: async (tool, summary, detail = '', ok = true) => {
          if (!signal.aborted) await scope.activity(tool, summary, detail, ok);
        },
      };
      try {
        if (spec.name === 'read_form' || spec.name === 'propose_fill') return await formTool(call, spec.name, args);
        if (spec.name === 'page_diagnostics') return await diagnosticsTool(call, args);
        if (spec.name === 'snapshot') return await snapshotTool(call, args, settled);
        if (spec.name === 'wait_for') return scope.waits ? await waitForTool(call, args) : refuse('There’s no tool called wait_for.');
        if (spec.level === 'act') return await actTool(call, spec.name as ActTool, args);
        return await readTool(call, spec.name, args);
      } catch (error) {
        return { text: toolResult({ error: error instanceof Error ? error.message : String(error) }, false), isError: true };
      }
    },
    (why) => refuse(CONTROL_REFUSALS[why]),
    cancelled,
  );
  return answered.finally(() => clock.lap('total'));
}

const isTab = (browser: ControlBrowser) => (id: NodeId) => nodeOf(browser.store.state, id)?.kind === 'tab';

/** The tab a ref names, or the refusal: `unknown` in the front door's words, a closed tab's in the gate's. */
function resolveTab(call: Call, ref: unknown, unknown: string): TabNode | ToolOutput {
  const found = call.scope.refs.resolve(ref, isTab(call.browser));
  if (!found.ok) return refuse(found.why === 'closed' ? CONTROL_REFUSALS.closed : unknown);
  return nodeOf(call.browser.store.state, found.id) as TabNode;
}

const isOutput = (x: TabNode | ToolOutput): x is ToolOutput => !('kind' in x);

/** Addresses a page can be read at; anything else (blank, an error page, not loaded yet) is simply not readable now. */
const READABLE_ADDRESS = /^(https?|file):/i;

/**
 * Whether the tab can still be read where it is now, as its refusal; null if so. Asked again after the approval
 * card, after the load and after the read: a redirect or a navigation meanwhile can land on a *Never read* site,
 * and what was read there is thrown away. A tab that closed, or a page that's gone, is refused too. `page`: where
 * the page is, which can be ahead of the tab's saved address; `urls`: where the read itself says it was;
 * `unread`: what to say when one of them is no web address (the read's usual words).
 */
function blockedNow(call: Call, nodeId: NodeId, page: ControlPage | null, unread: string, ...urls: string[]): string | null {
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
function notTheirNo(call: Call, agent: ControlAgent, nodeId: NodeId, released: number): string | null {
  if (nodeOf(call.browser.store.state, nodeId)?.kind !== 'tab') return CONTROL_REFUSALS.closed;
  if (call.stopped()) return CONTROL_REFUSALS.stopped;
  if (agent.state(nodeId).paused) return CONTROL_REFUSALS.paused;
  if (agent.releases(nodeId) !== released) return ACT_REFUSALS.takenOver;
  return null;
}

/** The tab's page, loading it if it's asleep or wasn't opened since launch. */
async function loadedPage(browser: ControlBrowser, nodeId: NodeId, signal?: AbortSignal): Promise<ControlPage | null> {
  // A view whose page is gone (its renderer died) has none to wait on.
  const contents = pageOf(browser.tabs.ensure(nodeId));
  if (!contents) return null;
  // A page with a frame held unsecured never finishes loading (agents/pickers.ts): no waiting on it.
  // Stop and the client's cancel end the wait at once (round 1 of #145, SF3).
  if (!pickersUnsecured(contents)) await pageLoaded(contents, 15_000, signal);
  return contents.isDestroyed() ? null : controlPage(contents);
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
function currentPage(browser: ControlBrowser, nodeId: NodeId): ControlPage | null {
  const contents = pageOf(browser.tabs.get(nodeId));
  return contents ? controlPage(contents) : null;
}

/** A tab read, and where (the assistant's readFrom: its origin then, Neon's B3 on #151). */
function markRead(memory: ToolMemory, nodeId: NodeId, url: string): void {
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

/* ---------- Reading: list_tabs, searches, read_tab, read_selection, tab_screenshot ---------- */

async function readTool(call: Call, tool: AssistantToolName, args: Record<string, unknown>): Promise<ToolOutput> {
  const { scope, browser } = call;
  if (tool === 'list_tabs' || tool === 'search_history' || tool === 'search_archive') {
    if (tool !== 'list_tabs' && !scope.search) return { text: toolResult({ error: `Unknown tool ${tool}` }, false), isError: true };
    const what = tool === 'list_tabs' ? 'See the list of your tabs' : tool === 'search_history' ? `Search your history for “${String(args['query'] ?? '')}”` : `Search your archive for “${String(args['query'] ?? '')}”`;
    const refused = await call.card(tool, null, what, [], 'The user said no to this. Carry on without it, or ask them.');
    if (refused) return refused;
    if (tool === 'list_tabs') {
      const listed = scope.tabs();
      // Their titles and sites are read now (Neon's B3 on #151): a tab named here besides the one it acts on taints.
      for (const { node } of listed) scope.memory.listed?.add(node.id);
      const tabs = listed.map(({ node, given }) => ({ tab_id: scope.refs.refFor(node.id), title: node.title, site: safeHost(node.url), attached: given }));
      await call.activity(tool, `Listed ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`);
      return { text: toolResult({ tabs }) };
    }
    const query = String(args['query'] ?? '').slice(0, 200);
    const hits = await scope.search!(tool, query);
    await call.activity(tool, tool === 'search_history' ? `Searched history for “${query}”` : `Searched the archive for “${query}”`, `${hits.length} found`);
    return { text: toolResult({ results: hits }) };
  }

  // read_tab, read_selection, tab_screenshot
  const unknown = 'No such tab. Use list_tabs or an attached tab id.';
  const found = tool === 'read_selection' && args['tab_id'] === undefined ? (scope.defaultTab() ?? refuse(unknown)) : resolveTab(call, args['tab_id'], unknown);
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  const verb = tool === 'tab_screenshot' ? 'Take a picture of' : 'Read';
  const refused = await call.card(tool, node, `${verb} “${node.title || safeHost(node.url)}”`, [node.url], 'The user said no to reading that tab. Carry on without it, or ask them.');
  if (refused) return refused;
  const moved = blockedNow(call, node.id, null, 'That tab could not be loaded.');
  if (moved) return refuse(moved);
  const page = await loadedPage(browser, node.id, call.signal);
  if (!page) return refuse('That tab could not be loaded.');
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const loaded = blockedNow(call, node.id, page, 'That tab could not be loaded.');
  if (loaded) return refuse(loaded);
  // The page read, taken before reading (which starts following its navigations): one that moved on meanwhile has no id.
  const pageId = page.id;
  const ref = scope.refs.refFor(node.id);
  if (tool === 'tab_screenshot') {
    // What's on screen: a tab in reader view shows its article (its page waits, detached, where no picture can be taken).
    const reader = pageOf(browser.readers.viewFor(node.id));
    // A page that draws itself after it loads (the owner's first look at a new tab): waited for a moment, never
    // pictured empty (a reader view always shows its article).
    if (!reader && !(await page.shows(FIRST_LOOK_MS))) {
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      return refuse(NOTHING_SHOWN('Take the picture'));
    }
    const shot = await (reader ? controlPage(reader) : page).screenshot();
    // Kept only once the picture is taken, and never after Stop (as diagnostics and read_form do).
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    const taken = blockedNow(call, node.id, page, 'Could not take the picture.');
    if (taken) return refuse(taken);
    if (shot) markRead(scope.memory, node.id, page.url());
    await call.activity(tool, `Looked at “${node.title || safeHost(node.url)}”`, node.url, Boolean(shot));
    return shot ? { image: shot } : refuse('Could not take the picture.');
  }
  const read = await page.read();
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const pdf = isPdf(read, page.url());
  // A PDF's read is the viewer's: readPdf checks the address it fetches itself.
  const after = blockedNow(call, node.id, page, 'That page could not be read.', ...(read && !pdf ? [read.url] : []));
  if (after) return refuse(after);
  markRead(scope.memory, node.id, read?.url ?? page.url());
  if (pdf) {
    if (tool === 'read_selection') return refuse('What’s selected inside a PDF can’t be seen. Read the PDF with read_tab instead.');
    return readPdf(call, node, page, ref, args, pageId);
  }
  if (!read) return refuse('That page could not be read.');
  if (tool === 'read_selection') {
    await call.activity(tool, `Read your selection in “${node.title || safeHost(node.url)}”`, node.url);
    return { text: pageResult({ ref, url: read.url, text: read.selection, retrievedAt: Date.now(), pageId: sameId(page, pageId) }) };
  }
  const start = typeof args['start'] === 'number' ? args['start'] : 0;
  const length = typeof args['length'] === 'number' ? args['length'] : undefined;
  const text = pageResult({ ref, url: read.url, text: read.text, start, ...(length ? { length } : {}), retrievedAt: Date.now(), pageId: sameId(page, pageId) });
  await call.activity(tool, `Read “${node.title || safeHost(node.url)}”`, node.url);
  return { text };
}

/**
 * A PDF in Chromium's viewer: its bytes through the tab's own session, its
 * text from pdf.js in a utility process, with [Page n] markers. Reading on
 * from `start` reuses the same read; a new read fetches it again.
 */
async function readPdf(call: Call, node: TabNode, page: ControlPage, ref: string, args: Record<string, unknown>, pageId: string): Promise<ToolOutput> {
  const { memory } = call.scope;
  const title = node.title || safeHost(node.url);
  const url = page.url();
  const start = typeof args['start'] === 'number' ? args['start'] : 0;
  const length = typeof args['length'] === 'number' ? args['length'] : undefined;
  let pdf = memory.pdfs.get(node.id);
  if (!pdf || pdf.url !== url || start === 0) {
    /** The download ended up somewhere the scope won't read it (a shared tab's PDF on another site): its words, not *never*. */
    let offSite = false;
    try {
      // The address the tab shows now, and where the download ends up, must both be readable.
      const readable = (address: string) => {
        if (isNeverReadable(address, call.scope.neverSites())) return false;
        if (call.scope.siteOk && !call.scope.siteOk(node, address)) return !(offSite = true);
        return true;
      };
      if (!readable(url)) throw new PdfError('never');
      const bytes = await page.fetchPdf(url, readable);
      const { pages, totalPages } = await extractPdf(bytes, ASSISTANT_PDF_MAX_PAGES);
      pdf = { url, pages, totalPages, text: pdfText(pages) };
    } catch (error) {
      if (offSite) return refuse(unreadable(call.scope, node));
      const why = error instanceof PdfError ? pdfProblemCopy(error.problem, error.detail) : pdfProblemCopy('crashed');
      await call.activity('read_tab', `Couldn’t read “${title}”`, why, false);
      return { text: toolResult({ refused: `Couldn’t read this PDF: ${why}.` }, false), isError: true };
    }
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    memory.pdfs.delete(node.id);
    memory.pdfs.set(node.id, pdf);
    if (memory.pdfs.size > PDFS_KEPT) memory.pdfs.delete(memory.pdfs.keys().next().value!);
  }
  const read = pdf.pages.length;
  const notes = [
    pdf.totalPages > read ? `This PDF has ${pdf.totalPages} pages; pages 1–${read} were read, the most Chord reads.` : '',
    pdf.pages.every((p) => !p.trim()) ? 'This PDF has no text to read (it may be scanned pages); tab_screenshot shows the page on screen.' : '',
  ].filter(Boolean);
  const text = pageResult({ ref, url, text: pdf.text, start, ...(length ? { length } : {}), retrievedAt: Date.now(), pdf: { pages: pdf.totalPages, read }, ...(notes.length ? { note: notes.join(' ') } : {}), pageId: sameId(page, pageId) });
  await call.activity('read_tab', `Read “${title}”`, pdf.totalPages > read ? `PDF, pages 1–${read} of ${pdf.totalPages}` : `PDF, ${pdf.totalPages} page${pdf.totalPages === 1 ? '' : 's'}`);
  return { text };
}

/* ---------- snapshot (S18 M2b) ---------- */

/**
 * The tab's accessibility outline, with refs on what can be acted on (core's control-snapshot.ts). Read as read_tab
 * is: the scope's rules and card, every rule asked again after the card, the load and the read. Its refs are the tab's
 * new ones (ElementRefs): every earlier one is stale from now on, and they're good only on the page (page id) they
 * were taken of. Never in reader view, which hides the page. A later range (`start`) of the same page's latest
 * snapshot comes from the outline it made, without reading the page again: its refs stay good, its offsets are into
 * that outline, and it's as of when that snapshot was taken (`retrieved_at`). It asks no card: one approval covers a
 * snapshot, all its ranges (the rules on where it may be read are still asked). Refs of tabs that closed go with them.
 */
/**
 * `settled`: for an action's answer (open_tab's and navigate's snapshot: true): of the page as the action left it. No
 * wait for a load: a page loading, before the read or after it, or one that went elsewhere as it was read, gives no
 * outline (STILL_LOADING), never the page it was leaving (round 1 of #232, SF1).
 */
async function snapshotTool(call: Call, args: Record<string, unknown>, settled = false): Promise<ToolOutput> {
  const { scope, browser } = call;
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use list_tabs or an attached tab id.');
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its page. Ask the user to close reader view first.');
  const elements = (scope.memory.elements ??= new Map());
  for (const id of [...elements.keys()]) if (nodeOf(browser.store.state, id)?.kind !== 'tab') elements.delete(id);
  const start = typeof args['start'] === 'number' ? args['start'] : 0;
  // Only what has this text in its name (the owner, 2026-11-24: as few tokens as can be), with what it's in.
  const find = typeof args['find'] === 'string' ? args['find'].slice(0, SNAPSHOT_FIND_MAX) : undefined;
  // The structure without the page's text (S18 M2g-2 slice 3b, #205): a view the agent reads, never the diff's baseline.
  const outlineOnly = args['text'] === false;
  // Reading on: the same page's latest outline, as it was made, while the page is where it may be read. Of the same kind
  // as the call (round 1 of #247, Fable's S1): an outline without text from its own slot; a full one only while it's the
  // agent's latest own read (else its offsets are another outline's, and the page is read again).
  const now = currentPage(browser, node.id);
  const tabRefs = elements.get(node.id);
  const kept = start > 0 && !find && now && !now.gone() ? (outlineOnly ? tabRefs?.textlessOutline(now.id) : tabRefs?.textlessOutline(now.id) ? null : tabRefs?.outline(now.id)) : null;
  if (kept && now) {
    const blocked = blockedNow(call, node.id, now, 'That page could not be read.', kept.url);
    if (blocked) return refuse(blocked);
    return { text: snapshotResult({ ref: scope.refs.refFor(node.id), url: kept.url, title: kept.title, outline: kept.text, refs: kept.refs, start, retrievedAt: kept.retrievedAt, pageId: kept.pageId, ...(kept.note ? { note: kept.note } : {}) }) };
  }
  const title = node.title || safeHost(node.url);
  const refused = await call.card('snapshot', node, `Look over “${title}”`, [node.url], 'The user said no to reading that tab. Carry on without it, or ask them.');
  if (refused) return refused;
  const moved = blockedNow(call, node.id, null, 'That tab could not be loaded.');
  if (moved) return refuse(moved);
  const loadingNow = () => pageOf(browser.tabs.get(node.id))?.isLoading() === true;
  if (settled && loadingNow()) return refuse(STILL_LOADING);
  const page = settled ? currentPage(browser, node.id) : await loadedPage(browser, node.id, call.signal);
  if (!page) return refuse('That tab could not be loaded.');
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const loaded = blockedNow(call, node.id, page, 'That tab could not be loaded.');
  if (loaded) return refuse(loaded);
  const pageId = page.id;
  let token = randomBytes(12).toString('hex');
  let read = await page.snapshot(scope.agent.id, token);
  // Nothing in it: a page that draws itself after it loads (the owner, 2026-11-24: a new tab's first look came back
  // empty). Taken once more when the page shows something, at most FIRST_LOOK_MS later; still nothing, the result says so.
  // Not for a page that went somewhere it may not be read, or (for an action's answer) began loading or went elsewhere:
  // no wait, and no read, once the page has moved on (round 2 of #232).
  const movedOn = () => (read ? blockedNow(call, node.id, page, 'That page could not be read.', read.url) !== null : false) || (settled && (loadingNow() || !sameId(page, pageId)));
  if (read && read.nodes.length === 0 && !call.stopped() && !movedOn() && (await page.shows(FIRST_LOOK_MS)) && !call.stopped() && !movedOn()) {
    token = randomBytes(12).toString('hex');
    read = await page.snapshot(scope.agent.id, token);
  }
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const after = blockedNow(call, node.id, page, 'That page could not be read.', ...(read ? [read.url] : []));
  if (after) return refuse(after);
  // For an action's answer: a page that began loading, or went elsewhere, as it was read: no outline, no ref.
  if (settled && (loadingNow() || !sameId(page, pageId))) return refuse(STILL_LOADING);
  if (!read) return refuse('That page could not be read.');
  let refs = elements.get(node.id);
  if (!refs) elements.set(node.id, (refs = new ElementRefs()));
  // Refs for a page that moved on during the read are issued against no page: they resolve as stale.
  const samePage = sameId(page, pageId);
  // Never a ref for a sensitive field (snapshotKeys): not one shown, and not one that could be guessed.
  // Refs from the page's own ids (M2g-1): an element still there keeps its ref, for the diff after the agent's actions.
  const issued = refs.issue(samePage ?? '', token, snapshotKeys(read), sidsOf(read));
  const outline = snapshotOutline(read, issued, { ...(find ? { find } : {}), ...(outlineOnly ? { text: false } : {}) });
  // A page of nothing but text: said, with where its text is (#205). Decided from the read, never from an empty outline
  // (round 1 of #247): a find that matched nothing, or a read cut before it reached the page's structure, isn't one.
  const onlyText = outlineOnly && !find && !read.cut.elements && !read.cut.time && read.nodes.length > 0 && !read.nodes.some((n) => n.role !== 'text');
  const note = read.nodes.length === 0 ? NOTHING_SHOWN('Call snapshot') : onlyText ? ONLY_TEXT : snapshotNote(read.cut);
  const retrievedAt = Date.now();
  // Its later ranges are of the page's whole outline (of its kind), never a find's (N-3).
  const whole = find ? snapshotOutline(read, issued, outlineOnly ? { text: false } : {}) : outline;
  // An outline without the page's text is no baseline for the diff (plan rule 1: a view that shows part of the page
  // never commits one): its refs are issued, and the outline the next diff compares with stays the last whole one. It's
  // kept in a slot of its own for its later ranges (round 1 of #247), with no lines.
  if (outlineOnly) refs.rememberTextless({ pageId: samePage ?? '', retrievedAt, url: read.url, title: read.title, text: whole.text, refs: whole.refs, ...(note ? { note } : {}) });
  else
    refs.remember({ pageId: samePage ?? '', retrievedAt, url: read.url, title: read.title, text: whole.text, refs: whole.refs, lines: snapshotLines(read, issued), ...(note ? { note } : {}), ...(read.cut.elements || read.cut.time || read.cut.refs ? { cut: true } : {}) });
  markRead(scope.memory, node.id, read.url);
  await call.activity('snapshot', `Looked over “${title}”`, `${outline.refs} element${outline.refs === 1 ? '' : 's'} to act on`);
  return { text: snapshotResult({ ref: scope.refs.refFor(node.id), url: read.url, title: read.title, outline: outline.text, refs: outline.refs, start, retrievedAt, ...(samePage ? { pageId: samePage } : {}), ...(note ? { note } : {}) }) };
}

/** The page's own ids of a snapshot's keyed elements (key → id), for refs that stay (core's ElementRefs). */
function sidsOf(read: SnapshotRead): Map<number, number> {
  return new Map(read.nodes.filter((n) => n.key !== undefined && n.sid !== undefined).map((n) => [n.key!, n.sid!]));
}

/** A diff that found nothing changed (its lines empty): said by saying nothing. */
const emptyDiff = (changes: Record<string, unknown>): boolean => {
  const lines = (changes['page_changes'] as { lines?: unknown } | undefined)?.lines;
  return Array.isArray(lines) && lines.length === 0;
};

/** A diff past this many lines says to call snapshot instead (M2g-1: never more than the outline would have cost). */
const DIFF_MAX_LINES = 60;

/**
 * What changed in the page since the agent's last snapshot of it (M2g-1, the owner's token goal): after an action, or
 * when a wait is met. Read again as a snapshot is (its refs the tab's latest, an element still there with its ref), and
 * only the lines that differ: new (+), changed as they are now (~), gone (-). Null with no snapshot of this page to
 * compare with (then the agent calls snapshot), or if the page went elsewhere meanwhile.
 */
async function pageChanges(call: Call, nodeId: NodeId, page: NonNullable<Awaited<ReturnType<typeof loadedPage>>>): Promise<Record<string, unknown> | null> {
  const refs = call.scope.memory.elements?.get(nodeId);
  const kept = refs?.outline(page.id);
  // Its refs are this page's, from an outline without text, with no whole one to compare with (#205): said, never
  // silence, which would read as nothing changed.
  // (It follows an outline without text alone, so it says how to get a full one: round 2 of #247.)
  if (refs && !kept && refs.onPage(page.id)) return { page_changes: { page_id: page.id, url: page.url(), note: 'You have no full snapshot of this page to compare with, so what changed can’t be told: call snapshot without text: false to see it.' } };
  if (!refs || !kept?.lines) return null;
  // Where to look: a full snapshot. Said so after an outline without text (round 1 of #247, Fable's S2), which never
  // moves the baseline, so calling it again would loop.
  const textless = refs.textlessOutline(page.id) !== null;
  const again = textless ? 'call snapshot without text: false' : 'call snapshot';
  // A snapshot cut short is no baseline: what it didn't reach would show as new (round 1 of #145). After an outline
  // without text (whole, perhaps), the one cut short is the last full one (round 2 of #247).
  if (kept.cut) return { page_changes: { page_id: page.id, url: page.url(), note: `Your last ${textless ? 'full ' : ''}snapshot of this page was cut short, so what changed can’t be told: ${again} to see it.` } };
  const token = randomBytes(12).toString('hex');
  const issuedBefore = refs.issues;
  // A diff's snapshot: kept a while, never in place of the agent's own (pinned).
  const read = await page.snapshot(call.scope.agent.id, token, false);
  if (!read || call.stopped() || page.id !== kept.pageId) return null;
  // A snapshot of the agent's landed meanwhile: it wins (round 2 of #145), and this read is no diff of it. An outline
  // without text too, which keeps no baseline (round 1 of #247, Neon's SF2): any refs issued meanwhile.
  if (refs.outline(page.id) !== kept || refs.issues !== issuedBefore) return null;
  // Read under a read's rules (Neon's round 1 of M2g-1, B-6): never from a page that may not be read, nor of another
  // origin than the snapshot it's compared with. Nothing of it is kept then.
  if (blockedNow(call, nodeId, page, 'That page could not be read.', read.url)) return null;
  if (originOf(read.url) !== originOf(kept.url)) return null;
  // Its own envelope (S-4): the page and address it's of.
  const of = { page_id: page.id, url: read.url };
  // A read cut short (too big, or too slow) would show what it didn't reach as gone.
  if (read.cut.elements || read.cut.time || read.cut.refs) return { page_changes: { ...of, note: `The page is too big to compare all of it: ${again} to see it.` } };
  // Its refs as they'd be, not yet issued (round 1 of #145, B1): a diff too big to show is never taken as seen, so the
  // agent's refs, and the next diff's baseline, stay its last seen snapshot's.
  const keys = snapshotKeys(read);
  const sids = sidsOf(read);
  const lines = snapshotLines(read, refs.preview(page.id, keys, sids));
  const changes = snapshotDiff(kept.lines, lines);
  if (changes.length > DIFF_MAX_LINES) return { page_changes: { ...of, changed: changes.length, note: `Much of the page changed: ${again} to see it.` } };
  refs.issue(page.id, token, keys, sids, false);
  // The next diff compares with what this one showed; later ranges stay the agent's snapshot's (no outline text built).
  refs.rebase(lines);
  return { page_changes: { ...of, lines: changes } };
}

/* ---------- wait_for (S18 M2g-1) ---------- */

/** Agents waiting now (one wait each: Neon's review of M2g-1, B5). */
const waiting = new WeakSet<object>();
/** wait_for waits in chunks this long: between them, Stop, the client's cancel, your taking the tab and the page going elsewhere end it. */
const WAIT_CHUNK_MS = 1000;
/** Roles wait_for looks for: what the outline names. */
const WAIT_ROLE = /^[a-z]{1,40}$/;

/**
 * wait_for: until a text, or an element by its role and exact name, shows in the tab (or goes, with `gone`), as the
 * snapshot sees the page, at most timeout_ms. Read under read_tab's rules (the scope's readable, its card). One at a
 * time for each agent. In chunks of WAIT_CHUNK_MS: Stop, the client giving up, your taking the tab, the tab closing or
 * its page going elsewhere end it at once, and the page's watcher with it. With `snapshot`, the outline once it's met.
 */
async function waitForTool(call: Call, args: Record<string, unknown>): Promise<ToolOutput> {
  const { scope, browser } = call;
  const text = typeof args['text'] === 'string' ? args['text'] : undefined;
  const role = typeof args['role'] === 'string' ? args['role'].trim().toLowerCase() : undefined;
  const name = typeof args['name'] === 'string' ? args['name'] : undefined;
  if ((text === undefined) === (role === undefined)) return refuse('wait_for takes text, or role and name (one of them).');
  if (text !== undefined && (!text.trim() || text.length > WAIT_FOR_TEXT_MAX)) return refuse(`wait_for's text is 1 to ${WAIT_FOR_TEXT_MAX} characters.`);
  if (role !== undefined && (!WAIT_ROLE.test(role) || !name || name.length > WAIT_FOR_TEXT_MAX)) return refuse(`wait_for's role is a role from the outline (button, generic…) and its name the element's exact name, 1 to ${WAIT_FOR_TEXT_MAX} characters.`);
  const asked = typeof args['timeout_ms'] === 'number' && Number.isFinite(args['timeout_ms']) ? Math.min(WAIT_FOR_MAX_MS, Math.max(100, Math.round(args['timeout_ms']))) : WAIT_FOR_DEFAULT_MS;
  // Never past what's left of the call's time (an outside agent's: its cards' budget, under Codex's 60 s a call).
  const timeout = scope.cardWaitMs !== undefined ? Math.min(asked, Math.max(100, scope.cardWaitMs)) : asked;
  const gone = args['gone'] === true;
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use list_tabs or an attached tab id.');
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its page. Ask the user to close reader view first.');
  // Chord's words on the card and in the activity, never the agent's (what it waits for: B-4).
  const refused = await call.card('snapshot', node, `Watch “${node.title || safeHost(node.url)}” for a change`, [node.url], 'The user said no to reading that tab. Carry on without it, or ask them.');
  if (refused) return refused;
  // The agent's one wait, held from here (S-2): a second started meanwhile is refused, even while this one loads.
  if (waiting.has(scope.agent)) return refuse('You’re waiting already: one wait at a time.');
  waiting.add(scope.agent);
  let looked: WaitAnswer | null = null;
  let page: Awaited<ReturnType<typeof loadedPage>> = null;
  let pageId = '';
  let gaveUp: (() => void) | null = null;
  const began = Date.now();
  try {
    page = await loadedPage(browser, node.id, call.signal);
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    if (!page) return refuse('That tab could not be loaded.');
    const before = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (before) return refuse(before);
    pageId = page.id;
    const document = page.mark.document;
    // The user taking the tab over (its cards let go of) ends it too (S-2).
    const released = scope.agent.releases(node.id);
    scope.act?.doing(node.id, { tool: 'wait_for' });
    // The client's cancel and Stop answer at once (S-2): the page's chunk ends on its own within a second.
    const cancelled = new Promise<null>((resolve) => {
      if (call.signal.aborted) resolve(null);
      else {
        gaveUp = () => resolve(null);
        call.signal.addEventListener('abort', gaveUp, { once: true });
      }
    });
    let after = 0;
    for (;;) {
      const left = timeout - (Date.now() - began);
      if (left <= 0) break;
      const want = text !== undefined ? { text, gone, after } : { role: role!, name: name!, gone, after };
      const chunk = Math.min(WAIT_CHUNK_MS, left);
      const answer = await Promise.race([page.waitFor(want, chunk), cancelled]);
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      if (scope.agent.releases(node.id) !== released) return refuse(ACT_REFUSALS.takenOver);
      // During, and after: the tab closed, the page went somewhere it may not be read, or somewhere else at all.
      const during = blockedNow(call, node.id, page, 'That page could not be read.');
      if (during) return refuse(during);
      // Another document ends it; the same one going to another address (a pushState: a single-page app's) doesn't,
      // since what's waited for often comes with it (its refs are stale then: said in the result).
      if (page.mark.document !== document) return { text: toolResult({ tab_id: scope.refs.refFor(node.id), met: false, waited_ms: Date.now() - began, navigated: true, note: 'The page changed while you waited: call snapshot again.' }) };
      if (!answer) return refuse('That page didn’t answer while you waited.');
      if (answer.editor) return refuse('That page is an editor: what shows in it is what’s typed there, so wait_for looks only for an element by its role and name there.');
      if (answer.looked !== false) looked = answer;
      if (answer.met) break;
      // The next chunk's first look waits out the throttle from this one's last (S-2).
      // A chunk with no look (the throttle was longer than it) counts the throttle down by its length (SF2): a slow
      // look never stalls the wait.
      after = answer.looked === false ? Math.max(0, after - chunk) : Math.max(0, Math.round(Math.max(150, 4 * (answer.ms ?? 0)) - (answer.since ?? 0)));
    }
  } finally {
    waiting.delete(scope.agent);
    scope.act?.doing(node.id, null);
    if (gaveUp) call.signal.removeEventListener('abort', gaveUp);
  }
  const waited = Date.now() - began;
  const met = looked?.met === true;
  markRead(scope.memory, node.id, page.url());
  await call.activity('wait_for', `Watched “${node.title || safeHost(node.url)}” for a change`, met ? `met after ${waited} ms` : `not met after ${waited} ms`, met);
  const moved = page.id !== pageId;
  // Every note that's so (S-3): a cut look says what it couldn't tell, waiting to show or to go; a pushState, that refs
  // went with it.
  const notes = [
    ...(looked?.cut && !met ? [gone ? 'The page is too big to look at all of it, so it can’t be told whether that’s gone.' : 'The page is too big to look at all of it: it may be in the part not looked at.'] : []),
    ...(moved ? ['The page went to another address while you waited (the same document): refs from before are stale.'] : []),
  ];
  const result = { tab_id: scope.refs.refFor(node.id), met, waited_ms: waited, ...(moved ? { navigated: true } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) };
  if (!met || args['snapshot'] !== true) return { text: toolResult(result) };
  // Met, with what changed since the agent's last snapshot of this page (the owner's token goal); with none, the outline
  // as snapshot gives it (its refs the tab's latest): always the outline after a pushState (its refs went with it).
  const changes = moved ? null : await pageChanges(call, node.id, page);
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  // A diff with lines; one too big to show, or a cut read, is only a note: the outline instead (round 1 of #145, SF1).
  if (changes && Array.isArray((changes['page_changes'] as { lines?: unknown }).lines)) return { text: toolResult({ ...result, ...(emptyDiff(changes) ? {} : changes) }) };
  const snap = await snapshotTool(call, { tab_id: args['tab_id'] });
  if (snap.isError || !snap.text) return snap;
  return { text: JSON.stringify({ ...(JSON.parse(snap.text) as Record<string, unknown>), wait: result }) };
}
/** An outline without text of a page that has nothing else (#205). */
export const ONLY_TEXT = 'This page has nothing but text: read it with read_tab.';
/** How long a first look waits for a page that draws itself after it loads, at most. */
const FIRST_LOOK_MS = 2000;
/** A page that shows nothing yet, said so (never an empty outline or a blank picture as if that were the page). */
const NOTHING_SHOWN = (again: string) => `The page shows nothing yet (it may still be loading or drawing). ${again} again in a moment.`;

/* ---------- Acting (S18 M2c) ---------- */

/**
 * An action on one of the agent's own tabs (never a shared one, M2's answer: shared tabs stay read-only). Element tools
 * name a ref from the tab's latest snapshot, on the page it's on now (a stale one is refused), and the element is
 * checked again in the page before anything is sent (control/act.ts). The first action on a site asks the site card:
 * *Allow for now* (the agent's life), *Always on this site* (kept with its allowance), or a no that lasts as long.
 * Every rule is asked again after the card. The bar says what it's doing meanwhile; the result says whether the page
 * went somewhere else (its refs are then stale). navigate and back need no ref and no site card, as open_tab.
 */
async function actTool(call: Call, tool: ActTool, args: Record<string, unknown>): Promise<ToolOutput> {
  // A tab of yours (the assistant): its lease, begun in actOn once the tab's checked, always ended here.
  const leased: { node: TabNode | null } = { node: null };
  let out: ToolOutput;
  try {
    out = await actOn(call, tool, args, leased);
  } finally {
    if (leased.node) call.scope.act?.lease?.end(leased.node);
  }
  // With snapshot: true, the page it went to, as snapshot gives it (S18 M2g-2 slice 3a, #204): once the action is over
  // and its hold let go of, by snapshot's own call, every read rule with it.
  if (tool !== 'navigate' || args['snapshot'] !== true || !call.scope.outlineOnGo || out.isError) return out;
  return withOutline(out, 'navigate', () => snapshotTool(call, { tab_id: args['tab_id'] }, true));
}

/** No outline for a page still loading when the action answered: never a second wait (open_tab's limit stands). */
export const STILL_LOADING = 'The page was still loading, so its outline wasn’t taken: call snapshot in a moment.';

/**
 * An action's answer with the page's outline (S18 M2g-2 slice 3a, #204): snapshot's own answer, its envelope untouched,
 * with the action's words under the tool's name (less what the envelope says: the tab, page, address and title; and the
 * note to call snapshot, which the outline answers). No outline (the read refused, or the page still loading): the
 * action's answer as it was, saying why in `no_outline`, in Chord's words (snapshot's refusal), never the page's. The
 * action happened either way: never an error.
 */
export async function withOutline(action: ToolOutput, tool: 'open_tab' | 'navigate', look: () => Promise<ToolOutput>): Promise<ToolOutput> {
  if (action.isError || !action.text) return action;
  const acted = JSON.parse(action.text) as { data: Record<string, unknown> } & Record<string, unknown>;
  const noOutline = (why: string): ToolOutput => ({ text: JSON.stringify({ ...acted, data: { ...acted.data, no_outline: why } }) });
  if (acted.data['loading'] === true) return noOutline(STILL_LOADING);
  const snap = await look();
  if (snap.isError || !snap.text) return noOutline(refusalOf(snap));
  // (Its `loading` too: it's false when there's an outline.)
  const { tab_id: _tab, page_id: _page, url: _url, title: _title, note: _note, loading: _loading, ...rest } = acted.data;
  return { text: JSON.stringify({ ...(JSON.parse(snap.text) as Record<string, unknown>), [tool]: rest }) };
}

/** A refusal's sentence: the shared layer's `{data: {refused}}`, or an agent's plain text (toPlain). */
function refusalOf(out: ToolOutput): string {
  try {
    const data = (JSON.parse(out.text ?? '') as { data?: { refused?: unknown; error?: unknown } }).data;
    if (typeof data?.refused === 'string') return data.refused;
    if (typeof data?.error === 'string') return data.error;
  } catch {
    // Plain words already.
  }
  return out.text || 'That page could not be read.';
}

async function actOn(call: Call, tool: ActTool, args: Record<string, unknown>, leased: { node: TabNode | null }): Promise<ToolOutput> {
  const { scope, browser } = call;
  const host = scope.act!;
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use list_tabs for the tabs there are.');
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  const notHere = host.mayAct(node);
  if (notHere) return refuse(notHere);
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its page. Ask the user to close reader view first.');
  const page = await loadedPage(browser, node.id, call.signal);
  if (!page) return refuse('That tab could not be loaded.');
  if (page.unsecured()) return refuse(ACT_REFUSALS.unsecured);
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const loaded = blockedNow(call, node.id, page, 'That tab could not be loaded.');
  if (loaded) return refuse(loaded);
  // A tab of yours: its debugger and send hold for this action (control/user-watch.ts), begun only right before its
  // input or its load, once the cards and checks have passed (Neon's B5 on #147); ended by actTool.
  const leaseOn = async (): Promise<string | null> => {
    if (!host.lease || leased.node) return null;
    const no = await host.lease.begin(node);
    if (!no) leased.node = node;
    return no;
  };
  /** Where it may act, asked again at every step (A1: the tab switched away, a split, minimized: Neon's B6 on #147). */
  const notHereNow = () => host.mayAct(node);
  // Your taking the tab over lets go of its cards (S18 M2e-1): one no window shows isn't paused, so the count is how
  // an action hears of it (Claude's review 2 of #116).
  const releasedAtStart = scope.agent.releases(node.id);
  const takenOver = () => (scope.agent.releases(node.id) !== releasedAtStart ? ACT_REFUSALS.takenOver : null);
  const ref = scope.refs.refFor(node.id);
  const done = async (navigated: boolean, loading: boolean, what: string, droppedBefore = 0, refoundElement = false, focusTaken = false): Promise<ToolOutput> => {
    const after = blockedNow(call, node.id, page, 'That page went somewhere that can’t be read.');
    if (after) return refuse(after);
    if (navigated) scope.memory.elements?.get(node.id)?.forget();
    await call.activity(tool, what, page.url());
    const caught = host.caught?.(node) ?? [];
    // What changed since the agent's last snapshot, after an action on an element of a page that didn't go elsewhere
    // (M2g-1: the default; not between a batch's steps).
    const changes = !navigated && tool !== 'navigate' && tool !== 'back' && !scope.noDiff ? await pageChanges(call, node.id, page) : null;
    return {
      text: toolResult({
        tab_id: ref,
        done: what,
        navigated,
        ...(loading ? { loading: true } : {}),
        page_id: page.id,
        url: page.url(),
        title: page.title(),
        ...(navigated ? { note: 'The page changed: call snapshot again before using refs from before.' } : {}),
        // What the page tried to send since the agent's last action here, dropped (the user said no, didn't answer, or
        // took the tab: sends.ts).
        // A ref whose node the page had replaced, found again (the owner's bug #2).
        ...(refoundElement ? { refound: 'The page had redrawn that element; Chord found it again by its role, name, place and target.' } : {}),
        // Enter's keydown went, and the page then moved the focus (its handler did): done, once; never press it again.
        ...(focusTaken ? { focus: 'The page moved the focus away from that field after Enter. Enter was pressed once: call snapshot to see what it did, and don’t press it again.' } : {}),
        // What the page's response was caught doing (a tab of yours): never say done when the page said no.
        ...(caught.length ? { caught } : {}),
        ...(droppedBefore ? { dropped: 'Since your last action here, the page tried to send data and it wasn’t sent (the user said no, didn’t answer, or took the tab). If something didn’t save, ask the user.' } : {}),
        // Nothing changed: nothing extra (round 2 of #145: a diff costs nothing then).
        ...(changes && !emptyDiff(changes) ? changes : {}),
      }),
    };
  };

  if (tool === 'navigate' || tool === 'back') {
    let target = '';
    let back: { index: number; url: string } | null = null;
    if (tool === 'navigate') {
      target = typeof args['url'] === 'string' ? args['url'].trim() : '';
      if (!/^https?:\/\//i.test(target) || target.length > NAVIGATE_URL_MAX) return refuse(`navigate takes an http or https address of at most ${NAVIGATE_URL_MAX} characters.`);
      if (isNeverReadable(target, scope.neverSites())) return refuse(NEVER);
    } else {
      // Where back goes is checked before going, as navigate's address is: never a site kept private, never a Chord page.
      // And it goes to exactly that entry (goBack could skip it, to one further back).
      back = page.backEntry();
      if (!back) return refuse(ACT_REFUSALS.noBack);
      if (!/^https?:\/\//i.test(back.url) || isNeverReadable(back.url, scope.neverSites())) return refuse(NEVER);
    }
    const goingTo = tool === 'navigate' ? target : (back?.url ?? '');
    const goingSite = host.siteOf(goingTo);
    if (!goingSite) return refuse(ACT_REFUSALS.noSite);
    // Leaving the site (the assistant in a tab of yours): one card, the leaving card with the whole address, below. Going
    // to a page isn't acting on it: never that site's own card, nor its grant; acting on its page later asks it then (the
    // owner's test of the 0.15 preview). An outside agent's own tabs: the site card for where it goes, as before.
    const leavesSite = host.leaving?.(page.url(), goingTo) ?? false;
    // The site it goes to asks first, as any action on a site does (Neon's review of #112): the site card, once.
    const remembered = leavesSite ? null : scope.agent.granted('site', goingSite);
    if (remembered === 'deny') return refuse(ACT_REFUSALS.siteDenied(goingSite));
    if (!leavesSite && !remembered && !host.siteAllowed(goingSite)) {
      const released = scope.agent.releases(node.id);
      const answer = await scope.agent.ask({ kind: 'site', tool, description: `go to ${barAddress(goingTo)}`, target: [page.url()], tab: node.id, subject: goingSite }, call.signal, scope.cardWaitMs);
      if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
      if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.siteDenied(goingSite));
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      scope.agent.keep('site', goingSite, answer);
      if (answer === 'always') host.keepSite(goingSite);
    }
    // An address that deletes or signs out (core's addressWhy, as a link's): the step card first (#112 review 1). Leaving
    // the site, the leaving card names the whole address instead: one card.
    const goingWhy = addressWhy(goingTo);
    if (goingWhy && !leavesSite) {
      const released = scope.agent.releases(node.id);
      const answer = await scope.agent.ask(
        {
          kind: 'step',
          tool,
          description: `go to ${barAddress(goingTo)}`,
          target: [page.url()],
          tab: node.id,
          subject: JSON.stringify([node.id, page.id, tool, goingTo]),
          step: { why: goingWhy, site: goingSite, fields: [], more: 0 },
        },
        call.signal,
        scope.cardWaitMs,
      );
      if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
      if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      // Back must still go to the entry the card named.
      if (tool === 'back' && page.backEntry()?.url !== goingTo) return refuse(ELEMENT_REFUSALS.stale);
    }
    // Leaving the site (the assistant in a tab of yours, M2e-2c, B3): every time, showing the whole address, which can
    // carry data out. In a chat that read elsewhere, any address does, the same site's too (Claude's C-B3 on #151).
    const leaves = leavesSite || (host.typeAsks?.(node, page.url()) ?? false);
    if (leaves) {
      const released = scope.agent.releases(node.id);
      const answer = await scope.agent.ask(
        {
          kind: 'step',
          tool,
          description: `go to ${barAddress(goingTo)}`,
          target: [page.url()],
          tab: node.id,
          subject: JSON.stringify([node.id, page.id, tool, 'leave', goingTo]),
          step: { why: 'leave', site: goingSite, fields: [], more: 0, going: wholeAddress(goingTo) },
        },
        call.signal,
        scope.cardWaitMs,
      );
      if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
      if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      // Back must still go to the entry the card named (a pushState while it was up: Neon's SF2 on #151).
      if (tool === 'back' && page.backEntry()?.url !== goingTo) return refuse(ELEMENT_REFUSALS.stale);
    }
    // The list may have gained its site while a card was up (Neon's review 2 of #112).
    if (isNeverReadable(goingTo, scope.neverSites())) return refuse(NEVER);
    // Its hold on (Neon's final pass): a tab whose hold is lost, or never finished, loads nothing for the agent.
    if (page.unsecured()) return refuse(ACT_REFUSALS.unsecured);
    // An outside agent's tab: its hold tried again. A tab of yours: a loss is its last lease's, and this action's own
    // lease (below) starts clean (round 3 of #147).
    if (!host.lease && page.lost() && !(await page.retryHold())) return refuse(ACT_REFUSALS.noCheck);
    const before = page.id;
    // It runs: a late Allow given on this tab for another step is spent.
    scope.agent.dropLateSteps(node.id);
    host.doing(node.id, tool === 'navigate' ? { tool, to: barAddress(target) } : { tool });
    try {
      // The tab's load can take a while: the user taking the tab, or Stop, meanwhile stops it here.
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      // What its load sends, or a redirect to an address that deletes or signs out, is held as an action's is: only what
      // the card named goes (the address itself, when it asked).
      const notNow = notHereNow() ?? (await leaseOn());
      if (notNow) return refuse(notNow);
      const w = page.watchSends(goingWhy || leaves || host.lease ? { urls: new Set(), documents: new Set([normalUrl(goingTo)]) } : null);
      if (!w) return refuse(ACT_REFUSALS.noCheck);
      // Where it goes: a page there sending the tab on to another site asks too (an open redirect, M2e-2c). Told once
      // the hold is on (Neon's N2 on #151).
      host.lease?.going(node, goingTo);
      let went: { loading: boolean } | null;
      let sent: string | null;
      try {
        const going = tool === 'navigate' ? page.navigate(target) : page.back(back!);
        // The hold lost meanwhile (a detach, the renderer gone) is never a success (Neon's B5, round 2 of #147).
        // Your own taking over reads as yours, before the hold's loss (Neon's S1, round 3).
        const halt = () => (call.stopped() ? CONTROL_REFUSALS.stopped : scope.agent.state(node.id).paused ? CONTROL_REFUSALS.paused : (takenOver() ?? notHereNow() ?? (page.lost() ? ACT_REFUSALS.noCheck : null)));
        sent = await askHeld(
          w,
          going,
          (held, sites, why, takeDown) =>
            scope.agent.ask(
              {
                kind: 'step',
                tool,
                description: tool === 'navigate' ? `go to ${barAddress(target)}` : 'go back',
                target: [page.url()],
                tab: node.id,
                subject: JSON.stringify([node.id, tool, 'sends', randomBytes(4).toString('hex')]),
                step: heldStep(held, sites, why, page.url(), barAddress(goingTo)),
                takeDown,
              },
              AbortSignal.any([call.signal, w.cancelled]),
              // It holds the page's live requests: never longer than an outside agent's card (D2), whoever asks; an
              // outside agent's its full wait, never a call's budget for cards (M2g-1, B2; round 1, B-5).
              scope.sendWaitMs ?? scope.cardWaitMs ?? CONTROL_WAIT_MS,
            ),
          halt,
          originOf(page.url()),
        );
        went = await going;
      } finally {
        w.end();
      }
      if (sent) return refuse(sent);
      // The hold lost while it loaded (a detach, the renderer gone): never reported done (Neon's B5, round 2 of #147).
      if (page.lost()) return refuse(ACT_REFUSALS.noCheck);
      if (!went) return refuse(ACT_REFUSALS.noBack);
      const { loading } = went;
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      // You took the tab while it loaded: it went, but the agent hears it's yours now.
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      return await done(page.id !== before, loading, tool === 'navigate' ? `Went to ${barAddress(target)}` : 'Went back');
    } finally {
      host.doing(node.id, null);
    }
  }

  const refArg = args['ref'];
  // An element, by its ref from the tab's latest snapshot, on the page it's on now.
  const lookup = scope.memory.elements?.get(node.id)?.resolve(refArg, page.id) ?? { ok: false as const, why: 'unknown' as const };
  if (!lookup.ok) return refuse(lookup.why === 'unknown' ? ELEMENT_REFUSALS.unknown(String(refArg ?? '')) : ELEMENT_REFUSALS.stale);
  /**
   * One step in the page on the ref's element (act.ts). A ref whose node the page replaced may be found again there
   * (the owner's bug #2): the result says so.
   */
  let refound = false;
  const refToken = lookup.token;
  const refKey = lookup.key;
  const actOn = async (op: ActOp): Promise<ActAnswer> => {
    const answer = await page.act(owner, refToken, refKey, op);
    if (answer.ok && answer.refound) refound = true;
    return answer;
  };
  const owner = scope.agent.id;
  const key = args['key'];
  const text = args['text'];
  const asked = typeof args['option'] === 'string' ? args['option'].slice(0, 500) : '';
  if (tool === 'press_key' && !isPressKey(key)) return refuse(ACT_REFUSALS.key);
  if (tool === 'type' && (typeof text !== 'string' || text.length > TYPE_TEXT_MAX)) return refuse(ACT_REFUSALS.text);
  if (tool === 'select_option' && !asked) return refuse(ACT_REFUSALS.notSelect);
  // The page and its site, before anything is asked of it: everything after is for this page on this site only.
  const pageAtCheck = page.id;
  const site = host.siteOf(page.url());
  if (!site) return refuse(ACT_REFUSALS.noSite);
  // The element as it is now; for select_option, the choice matched against the page's own options before anything is
  // asked, so the card and the bar show the page's label, never the agent's words.
  // Its first look may find a replaced node again (the owner's bug #2); so may the look after a card, the pointer's move
  // and the hit test, never a later one (the review of #117): once it's checked and pointed at, a replacement refuses.
  // Where this action's time goes (phases.ts): its first look, its cards, its pointing, the debugger's session, the
  // checks to the press, the press or the input, and the page settling after.
  const phases = phaseClock(tool);
  const element = await actOn({ op: 'describe', refind: true, ...(tool === 'select_option' ? { option: asked } : {}) });
  phases.lap('look');
  // Stopped while it was described: nothing after it (round 2 of #145).
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  if (!element.ok) return refuse(actRefusal(element));
  // A field the page turned into a password, code or card field since the snapshot: never acted on (it'd have no ref now).
  if (element.field && sensitiveField(element.field)) return refuse(ACT_REFUSALS.sensitive);
  if (tool === 'type' && !element.editable) return refuse(ACT_REFUSALS.notEditable);
  // A field that isn't text (a time, a date, a month, a week: #112, the owner's hand test) is set, never typed into,
  // and only to a value in its format. (A color or a range field takes no text: refused above, as not editable.)
  const valueType = tool === 'type' && element.risk?.tag === 'input' && VALUE_TYPES.has(element.risk.type) ? element.risk.type : null;
  if (valueType && !valueFits(valueType, text as string)) return refuse(ACT_REFUSALS.badValue(valueType));
  const value = valueType ? (text as string) : null;
  if (tool === 'select_option' && !element.select) return refuse(ACT_REFUSALS.notSelect);
  if (tool !== 'hover' && element.disabled) return refuse(ACT_REFUSALS.disabled);
  const choice = element.choice ?? '';
  const description: ActDescription = { tool: tool as ElementTool, name: element.name, role: element.role, ...(isPressKey(key) ? { key } : {}), ...(tool === 'select_option' ? { choice } : {}) };
  /**
   * Whether input may go now: never after Stop, never while the user has the tab (their key or click pauses the agent
   * there; the card's wait can be long), never on a page that moved on since the element was checked. Asked right
   * before every input and every text put in, and right after the card.
   */
  /** This action has its own checks (deep) and, in a tab of yours, its own lease: a loss from then on is its own. */
  let holds = false;
  const halt = (): string | null => {
    if (call.stopped()) return CONTROL_REFUSALS.stopped;
    if (scope.agent.state(node.id).paused) return CONTROL_REFUSALS.paused;
    const taken = takenOver() ?? notHereNow();
    if (taken) return taken;
    // The hold lost (a detach, the renderer gone) since this action got its checks: nothing more goes, and nothing is
    // done (Neon's B5, round 2 of #147). Before then, a loss is an earlier one's: the checks (deep) try again or refuse
    // (round 3 of #147).
    if (holds && page.lost()) return ACT_REFUSALS.noCheck;
    // The page went somewhere: input now would land on another page's element.
    if (page.id !== pageAtCheck) return ELEMENT_REFUSALS.stale;
    return null;
  };
  /**
   * Text or a key goes where the focus is: only while it's this element's, and it's no field Chord never types in. The
   * page can still move the focus after this answers (a timer); the guard (see below) stops what would land elsewhere.
   */
  const focusOk = async (mark?: string): Promise<string | null> => {
    // Under the guard, the check marks the element for it (agent-guard.ts): input may reach it and nothing else.
    const now = await actOn({ op: 'focused', ...(mark ? { guard: mark } : {}) });
    if (!now.ok) return actRefusal(now);
    if (now.field && sensitiveField(now.field)) return ACT_REFUSALS.sensitive;
    if (!now.focused) return ACT_REFUSALS.focusMoved;
    return halt();
  };

  // The describe was on this page, on this site: one that went elsewhere meanwhile gets no card (it'd show the first
  // page's words for another site).
  if (page.id !== pageAtCheck || host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
  // The first action on a site asks the user; their answer lasts as long as the agent, or for good.
  // What the user said already: a no (for as long as the agent), a yes for now (the gate keeps it), or for good.
  const remembered = scope.agent.granted('site', site);
  if (remembered === 'deny') return refuse(ACT_REFUSALS.siteDenied(site));
  if (!remembered && !host.siteAllowed(site)) {
    const released = scope.agent.releases(node.id);
    const answer = await scope.agent.ask({ kind: 'site', tool, description: actPhrase(description), target: [page.url()], tab: node.id, subject: site }, call.signal, scope.cardWaitMs);
    if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
    if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.siteDenied(site));
    // The card's wait can be long: Stop, the user taking the tab, the page moving on meanwhile, all stop it here.
    const halted = halt();
    if (halted) return refuse(halted);
    const after = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (after) return refuse(after);
    if (!scope.memory.elements?.get(node.id)?.resolve(refArg, page.id).ok) return refuse(ELEMENT_REFUSALS.stale);
    // And on another site now, it'd need its own yes.
    if (host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
    // It runs, on the page and site the card named: the yes is kept now (the agent's life; a fresh Always for good).
    scope.agent.keep('site', site, answer);
    if (answer === 'always') host.keepSite(site);
  }

  // The step (S18 M2d): what it is, from the page as it is now (core's classifyStep), never from the agent's words. A
  // risky one asks every time (the step card); an `act` one goes, and if it sends data after all (a page's own script),
  // what it sends is held and the card asks then (control/sends.ts). No description from the page: as a form's submit.
  // A late Allow is for this very step: its tab, page, ref, action, and for type what it types (#112 review 1).
  const typed = tool === 'type' && typeof text === 'string' ? createHash('sha256').update(`${args['replace'] !== false}|${text}`).digest('hex').slice(0, 16) : '';
  // Typing in a chat that read anything but this tab (M2e-2c, B3; the owner's answer 6): the text shown first, every time.
  if (tool === 'type' && typeof text === 'string' && host.typeAsks?.(node, page.url())) {
    const released = scope.agent.releases(node.id);
    const answer = await scope.agent.ask(
      {
        kind: 'step',
        tool,
        description: actPhrase(description),
        target: [page.url()],
        tab: node.id,
        subject: JSON.stringify([node.id, page.id, String(refArg), 'taint', createHash('sha256').update(text).digest('hex').slice(0, 16)]),
        // Every character it will type (at most TYPE_TEXT_MAX, checked above): nothing typed that the card didn't show
        // (Neon's B2 on #151).
        step: { why: 'confirm', site, fields: [], more: 0, typed: text, taint: true },
        show: () => void actOn({ op: 'point', highlight: true }),
      },
      call.signal,
      scope.cardWaitMs,
    );
    if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
    if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
    const halted = halt();
    if (halted) return refuse(halted);
    // As after the site card (Neon's SF4 on #151): the page as it is now, the element still the one, the same site.
    const after = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (after) return refuse(after);
    if (!scope.memory.elements?.get(node.id)?.resolve(refArg, page.id).ok) return refuse(ELEMENT_REFUSALS.stale);
    if (host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
  }
  const step: RiskClass = stepOf(tool, args, element);
  // And what the card showed (Neon's review of #112): why it asks, and the element's shape (its link, its form's
  // address, method and fields). Any of it changed, it's another step: a late Allow never covers it.
  const shown = createHash('sha256').update(`${step.class === 'risky' ? step.why : 'act'}|${stepShape(element)}`).digest('hex').slice(0, 16);
  // As JSON (Neon's review of M2g-1, B4): no value can run into the next.
  const stepKey = JSON.stringify([node.id, page.id, String(refArg), tool, isPressKey(key) ? key : '', args['submit'] === true, typed, shown]);
  if (step.class === 'risky') {
    // Only what the submit sends (the owner's test of 982ce10): the risk checks above still see every field.
    const { fields, more } = stepFields(sentLabels(element.risk?.form?.fields ?? []));
    const released = scope.agent.releases(node.id);
    const answer = await scope.agent.ask(
      {
        kind: 'step',
        tool,
        description: actPhrase(description),
        target: [page.url()],
        tab: node.id,
        subject: stepKey,
        step: { why: step.why, site, fields, more, ...(element.risk?.text ? { shows: element.risk.text } : {}), ...(tool === 'type' && typeof text === 'string' ? { typed: text } : {}), ...targetOf(element, site, host.siteOf) },
        // Show me: the element outlined in its page, the card still up (the service shows the tab in the window).
        show: () => void actOn({ op: 'point', highlight: true }),
      },
      call.signal,
      scope.cardWaitMs,
    );
    if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
    if (answer === 'deny') return refuse(notTheirNo(call, scope.agent, node.id, released) ?? ACT_REFUSALS.stepDenied);
    // As after the site card: Stop, the user taking the tab, the page moving on or to another site, all stop it here.
    const halted = halt();
    if (halted) return refuse(halted);
    const after = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (after) return refuse(after);
    if (!scope.memory.elements?.get(node.id)?.resolve(refArg, page.id).ok) return refuse(ELEMENT_REFUSALS.stale);
    if (host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
    // What the card showed is what goes (#112 review 1): described again, the same step, the same name, the same form
    // (where it goes, how, and its fields). A page that changed any of it while the card was up gets nothing.
    const now = await actOn({ op: 'describe', refind: true, ...(tool === 'select_option' ? { option: asked } : {}) });
    if (!now.ok) return refuse(actRefusal(now));
    if (now.field && sensitiveField(now.field)) return refuse(ACT_REFUSALS.sensitive);
    const stepNow = stepOf(tool, args, now);
    if (now.name !== element.name || stepNow.class !== 'risky' || stepNow.why !== step.why || stepShape(now) !== stepShape(element)) return refuse(ACT_REFUSALS.stepChanged);
  }

  /**
   * The step as it is right before its input (Neon's review of #112): after the pointer moved (a page's mouseenter can
   * change a link, a form's address or its fields) and after any card. Not the step that was checked (named the same,
   * shaped the same, no riskier, and for a risky one the same why): nothing goes in.
   */
  const stepNow = async (): Promise<{ refused: string; why?: string } | null> => {
    const now = await actOn({ op: 'describe', ...(tool === 'select_option' ? { option: asked } : {}) });
    // Its why too: a node replaced since (`replaced`) is tried again from the pointer's move (below).
    if (!now.ok) return { refused: actRefusal(now), why: now.why };
    if (now.field && sensitiveField(now.field)) return { refused: ACT_REFUSALS.sensitive };
    if (now.name !== element.name || stepShape(now) !== stepShape(element)) return { refused: ACT_REFUSALS.stepChanged };
    const again = stepOf(tool, args, now);
    if (step.class === 'act' ? again.class !== 'act' : again.class !== 'risky' || again.why !== step.why) return { refused: ACT_REFUSALS.stepChanged };
    return null;
  };
  const sameStep = async (): Promise<string | null> => (await stepNow())?.refused ?? null;

  // It runs: a late Allow given on this tab for another step is spent (Neon's review of M2g-1, B1).
  scope.agent.dropLateSteps(node.id);
  phases.lap('cards');
  host.doing(node.id, description);
  /** The debugger's checks, for what presses or types (deep.ts): opened right before, let go once the page settled. */
  let deep: DeepSession | null = null;
  /** What the action sends, held (sends.ts): watched from before its input until a moment after it. */
  let watch: SendWatch | null = null;
  /** What the page sent after the agent's last action here, dropped: its result says so. */
  const droppedBefore = page.droppedAfter();
  try {
    let refused: string | null = null;
    /** The guard's mark while it's up (agent-guard.ts): an event name only main knows. */
    let guardMark = '';
    /**
     * Enter in a one-line field whose keydown handler took the focus elsewhere (a game takes the bet on Enter's keydown,
     * then focuses its table: the owner's retest of #117): the keydown did its work, so it's done, and the result says
     * the page moved the focus. Refused, the agent would press again: a second bet.
     */
    let enterMovedFocus = false;
    /** The key going in is Enter in a one-line field (see enterMovedFocus). */
    let enterOneLine = false;
    /**
     * The last guarded input was refused as the focus moved, and nothing of it reached the page: the focus went before
     * the input, or the guard stopped all of it (the review of #117, round 6: a game that takes the focus to its table
     * on a timer, on a slow machine). Then it's tried again, the element focused again (guardedTries).
     */
    let nothingWent = false;
    /**
     * A keydown sent that the page's guard hadn't seen by KEY_SEEN_MS: late, maybe still coming. Then nothing is ever
     * tried again, as it could land twice (Claude's review 5 of #117).
     */
    let keyUnseen = false;
    /**
     * Under the guard, before each input: the focus the element's (in this document, so not in a frame; the check marks
     * it for the guard, which takes no input until then), its insides all to be seen (no closed shadow root), the
     * file picker hold, Stop and a pause.
     */
    const stillOk = async (): Promise<string | null> => {
      // The tab's file picker hold, still on (it can be lost between steps: the debugger let go).
      if (!deep!.held()) return ACT_REFUSALS.noCheck;
      const focus = await focusOk(guardMark);
      if (focus) return focus;
      const open = await deep!.open();
      if (!open.ok) return deepRefusal(open);
      return halt();
    };
    /**
     * Text or keys in, with the page preload's guard up (the window's first listener; every frame's too), armed with a
     * mark only main knows: it takes no input until stillOk's focus check marks the element, then only for it. `input`
     * sends, and may check again between its events (a key's keydown, then its character); it says why it stopped, if
     * it did. A key or an insertion the page would get anywhere else is stopped there, and the action ends. The guard
     * always comes down.
     */
    const guarded = async (until: 'keyup' | 'beforeinput', input: () => Promise<string | null>, typesNothing = false): Promise<boolean> => {
      guardMark = `chord-guard-${randomBytes(16).toString('hex')}`;
      if (!(await page.guard(until, guardMark))) {
        await page.unguard();
        refused = ACT_REFUSALS.changed;
        return false;
      }
      // Where the page's documents are, right before this input (not before a card: a navigation started and dropped
      // while the card was up never counts as this input's).
      const markAtInput = page.mark;
      let failed: string | null;
      let inputBegan = false;
      // Fresh for this input: what a try before it found never counts (Neon's B2 of round 5).
      nothingWent = false;
      keyUnseen = false;
      enterMovedFocus = false;
      enterOneLine = false;
      try {
        failed = (await stillOk()) ?? ((inputBegan = true), await input());
      } catch {
        // The input itself failed (the page went mid-way): nothing more goes in.
        failed = ACT_REFUSALS.changed;
      }
      // Always down: the input's events are on their way (each its own message), and unguard waits for the last one
      // (none sent: no wait).
      const down = await page.unguard(inputBegan ? undefined : 0);
      if (failed) {
        refused = failed;
        // Nothing reached the page, for sure: nothing was sent, or all of it was seen by the guard, stopped (none went
        // through) and none of it is still on its way (lost: the input's last event never came; a keydown unseen).
        // Or nothing was sent at all, and the element was replaced before it (a page that redraws: the table on Wayland):
        // found again and checked again by the retry (refocus), as for the focus taken.
        nothingWent =
          (failed === ACT_REFUSALS.focusMoved && (!inputBegan || (typeof down === 'object' && down.moved && down.passed === 0 && !down.lost && !keyUnseen))) ||
          (failed === ACT_REFUSALS.changed && !inputBegan);
        return false;
      }
      // Another document (a submit's Enter, or Enter on a link, navigated the page): its focus went with it, and that's
      // done (no guard there, or the script asked went with the old one). A guard that ran out in the same document,
      // or the same document not answering: a no.
      if (down === 'gone' || down === 'timeout' || down === 'expired') {
        // Done only if the page committed another document since (no guard there, or the script asked went with the
        // old one); else a no. A navigation that started and never committed (a 204, a download) doesn't count, nor
        // does one to an error page (an unreachable server fires no did-navigate): a submit that lands there reads as
        // the focus moved. That fails closed, and the agent's snapshot shows the error page.
        if (await page.committedSince(markAtInput, 2000)) return true;
        refused = ACT_REFUSALS.focusLost;
        return false;
      }
      // Something stopped. Enter in a one-line field whose keydown went through, the rest stopped (the page took the focus
      // after the check: the review of #117, round 5): the keydown did its work, nothing was typed; done, said so.
      // Anything else stopped: a no.
      // Enter that moved the focus is done only when its keydown went through (Neon's B2 of round 5): else as anything.
      if (!down.keydownPassed) enterMovedFocus = false;
      if (down.moved && enterOneLine && down.keydownPassed) enterMovedFocus = true;
      else if (down.moved) {
        refused = ACT_REFUSALS.focusMoved;
        nothingWent = down.passed === 0 && !down.lost && !keyUnseen;
      }
      // A key that types nothing (Tab, an arrow, Escape) may take the focus anywhere, a frame too: its keyup there is
      // that, not text gone astray. So may Enter's keydown in a one-line field (its keyup's all that went after).
      else if (down.lost && !typesNothing && !enterMovedFocus) refused = ACT_REFUSALS.focusLost;
      return !refused;
    };
    /**
     * The step checked right before input that isn't a press (a key, a choice, a value), after `first` (the focus, for a
     * key). A node the page replaced on the way (a re-render) is looked for again from the pointer's move and checked
     * again, at most PRESS_TRIES times, as a press is (the review of #117, round 3); never once input went in.
     */
    const readyAgain = async (first?: () => Promise<ActAnswer>, tries = PRESS_TRIES): Promise<string | null> => {
      for (let attempt = 1; ; attempt++) {
        const halted = halt();
        if (halted) return halted;
        if (attempt > 1) {
          const repointed = await actOn({ op: 'point', highlight: false });
          if (!repointed.ok) return actRefusal(repointed);
          if (repointed.field && sensitiveField(repointed.field)) return ACT_REFUSALS.sensitive;
        }
        if (first) {
          const did = await first();
          if (!did.ok) {
            if (did.why === 'replaced' && attempt < tries) continue;
            return actRefusal(did);
          }
        }
        const changed = await stepNow();
        // Stop, the user taking the tab, the page gone on while the step was checked: nothing goes in (Neon, round 4).
        if (!changed) return halt();
        if (changed.why === 'replaced' && attempt < tries) continue;
        return changed.refused;
      }
    };
    /**
     * Input under the guard, tried again when nothing of it reached the page because the page took the focus first
     * (nothingWent): `again` focuses the element again and checks the step, and it goes once more, at most PRESS_TRIES
     * times. Anything that reached the page, or any other no, is never tried again.
     */
    const guardedTries = async (until: 'keyup' | 'beforeinput', input: () => Promise<string | null>, again: () => Promise<string | null>, typesNothing = false): Promise<boolean> => {
      for (let attempt = 1; ; attempt++) {
        if (await guarded(until, input, typesNothing)) return true;
        if (!nothingWent || attempt >= PRESS_TRIES) return false;
        const back = await again();
        if (back) {
          refused = back;
          return false;
        }
        refused = null;
      }
    };
    /**
     * The element focused again, and the step checked again (guardedTries): its own tries kept to RETRY_CHECKS, so a
     * key's tries and their checks stay at most PRESS_TRIES × RETRY_CHECKS steps (Claude's N3 of round 5).
     */
    const refocus = () => readyAgain(() => actOn({ op: 'focus' }), RETRY_CHECKS);
    /** After text or a value went in: this field changed, or now holds the text; and no other field changed. */
    const typedWhere = async (): Promise<string | null> => {
      const after = await actOn({ op: 'values', mode: 'compare', text: value ?? (text as string) });
      if (!after.ok) return after.why === 'no-values' ? ACT_REFUSALS.notTyped : actRefusal(after);
      if ((after.others ?? 0) > 0) return ACT_REFUSALS.typedElsewhere;
      // Text added to what's there (replace: false) must have changed the field: holding the text already proves nothing.
      if (!after.changed && (args['replace'] === false || !after.has)) return ACT_REFUSALS.notTyped;
      return null;
    };
    /**
     * A key. One that types a character into a field (Enter, Space in a text field): its keydown, then (the page's
     * keydown handlers have run) everything checked again, then the rest of it. Any other key goes in at once: its own
     * keydown may move the focus (Tab, an arrow in a radio group) or go somewhere (Enter on a link), and that's the key
     * working, not the page in its way.
     */
    const typesInto = (pressed: PressKey) => element.editable === true && (pressKeyEvents(pressed) as AgentInputEvent[]).some((e) => e.type === 'char');
    const pressKey = (pressed: PressKey) => async (): Promise<string | null> => {
      const [down, ...rest] = pressKeyEvents(pressed) as AgentInputEvent[];
      if (!typesInto(pressed)) {
        // No character at all (Tab, an arrow): in at once.
        if (!rest.some((e) => e.type === 'char')) {
          page.keys([down!, ...rest]);
          return null;
        }
        // A character, on something that isn't a field (Enter or Space on a button or a link): its keydown, then, if
        // the focus is no longer the element's or a closed root came in (Neon's review 7 of #110), no character, only
        // the key let go of. The keydown did what it does (a link went, a menu opened): that's done.
        const documentAtKey = page.mark.document;
        page.keys([down!]);
        // Its keydown handled first (its handlers have run), then the check: never the check before it.
        if (!(await page.keySeen(1, KEY_SEEN_MS))) keyUnseen = true;
        const again = await stillOk();
        // A menu that moves the focus on its keydown loses Enter's click (the character): harmless, the agent sees the
        // menu open and goes on from there.
        page.keys(again ? rest.filter((e) => e.type === 'keyUp') : rest);
        // The element itself gone, in the same document (a page that redraws it: the table on a slow runner, #117): a
        // button's click comes with the character, so the key may have done nothing. Never said done; never tried again
        // either (its keydown reached the page).
        if (again === ACT_REFUSALS.changed && page.mark.document === documentAtKey) return KEY_REDRAWN;
        // The hold lost, Stop, or the user taking the tab meanwhile: a no, not done (Neon's review 4), asked of each
        // directly. The focus gone elsewhere, or the page gone on (Enter on a link: its element's checks fail as its
        // document goes): the keydown did its work.
        if (!deep!.held()) return ACT_REFUSALS.noCheck;
        if (call.stopped()) return CONTROL_REFUSALS.stopped;
        if (scope.agent.state(node.id).paused) return CONTROL_REFUSALS.paused;
        return null;
      }
      enterOneLine = pressed === 'Enter' && element.risk?.multiline === false;
      page.keys([down!]);
      // Its keydown handled first (its handlers have run), then the check: never the check before it.
      if (!(await page.keySeen(1, KEY_SEEN_MS))) keyUnseen = true;
      const again = await stillOk();
      // Never the character: the key's let go of, nothing typed.
      if (again) {
        page.keys(rest.filter((e) => e.type === 'keyUp'));
        // Enter in a one-line field, the focus taken elsewhere by its keydown (a game's bet): that's done, as on a button
        // (above), and said so. In a field that takes more lines, or any key that types text, still a no.
        if (pressed === 'Enter' && again === ACT_REFUSALS.focusMoved && element.risk?.multiline === false) {
          if (!deep!.held()) return ACT_REFUSALS.noCheck;
          if (call.stopped()) return CONTROL_REFUSALS.stopped;
          if (scope.agent.state(node.id).paused) return CONTROL_REFUSALS.paused;
          enterMovedFocus = true;
          return null;
        }
        return again;
      }
      page.keys(rest);
      return null;
    };
    /** The card for what an action's page held: its sites, or the step a document's address is (askHeld). */
    const askSendCard = (held: { url: string; why: RiskWhy | null }[], sites: string[], why: RiskWhy | null, w: SendWatch, takeDown: AbortSignal) =>
      scope.agent.ask(
        {
          kind: 'step',
          tool,
          // What it did (it's done: what it sent waits): `Clicked “Mark as read”`.
          description: actDone(description),
          target: [page.url()],
          tab: node.id,
          // Never late: what was held is dropped when no one answers, so a late Allow would have nothing to send.
          // Subjects as JSON (N-5): no value runs into the next.
          subject: JSON.stringify([stepKey, 'sends', randomBytes(4).toString('hex')]),
          // Exact origins (the owner, 2026-11-23), each by its host, its scheme too where it isn't https or isn't the page's.
          step: heldStep(held, sites, why, page.url()),
          show: () => void actOn({ op: 'point', highlight: true }),
          takeDown,
        },
        AbortSignal.any([call.signal, w.cancelled]),
        // It holds the page's live requests: never longer than an outside agent's card (D2), whoever asks; an outside
        // agent's its full wait, never a call's budget for cards (M2g-1, B2).
        scope.sendWaitMs ?? scope.cardWaitMs ?? CONTROL_WAIT_MS,
      );
    /** Once the watch is on: what's held from then is asked about (below). */
    let watchOn: () => void = () => undefined;
    const watching = new Promise<void>((done) => (watchOn = done));
    /** The page's document when the action began: a send card's Allow counts only while it's still this one. */
    const markAtStart = page.mark;
    const acting = page.afterActing(async () => {
      const pointed = await actOn({ op: 'point', highlight: true });
      phases.lap('point');
      if (!pointed.ok || pointed.x === undefined || pointed.y === undefined) return void (refused = pointed.ok ? ACT_REFUSALS.changed : actRefusal(pointed));
      // The field as it is now, after any card's wait: never one the page made a password, code or card field.
      if (pointed.field && sensitiveField(pointed.field)) return void (refused = ACT_REFUSALS.sensitive);
      if ((refused = halt())) return;
      // From here input goes in: the debugger's checks (deep.ts), and the watch on what it sends (sends.ts): for an
      // `act` step anything that sends data is held for the card; a step the user allowed sends as it does. Reports
      // (beacons, pings) are dropped either way.
      if ((refused = await leaseOn())) return;
      deep = await page.deep(owner, lookup.token, lookup.key);
      phases.lap('debugger');
      if (!deep) return void (refused = ACT_REFUSALS.noCheck);
      holds = true;
      watch = page.watchSends(step.class === 'risky' ? allowedBy(element, stepSubmits(tool, args, element)) : null);
      if (!watch) return void (refused = ACT_REFUSALS.noCheck);
      watchOn();
      if ((refused = halt())) return;
      if (tool === 'hover') return void page.pointer(pointed.x, pointed.y);
      if (tool === 'select_option') {
        if ((refused = await readyAgain())) return;
        if (!deep.held()) return void (refused = ACT_REFUSALS.noCheck);
        // By the page's whole label, as describe matched it (the card showed it clipped).
        const chosen = await actOn({ op: 'choose', option: asked });
        if (!chosen.ok) refused = actRefusal(chosen);
        return;
      }
      if (tool === 'press_key') {
        if ((refused = await refocus())) return;
        return void (await guardedTries('keyup', pressKey(key as PressKey), refocus, !typesInto(key as PressKey)));
      }
      // A field that isn't text: set to its value, never clicked (its own picker would open) nor typed into; what else
      // changed in the page meanwhile is checked as for text.
      if (valueType) {
        if ((refused = await readyAgain())) return;
        // Every field's value, as it is now (a no: the element's gone, and nothing goes in).
        const remembered = await actOn({ op: 'values', mode: 'remember' });
        if (!remembered.ok) return void (refused = actRefusal(remembered));
        if ((refused = halt())) return;
        if (!deep.held()) return void (refused = ACT_REFUSALS.noCheck);
        const set = await actOn({ op: 'setValue', value: value as string });
        if (!set.ok) return void (refused = set.why === 'bad-value' ? ACT_REFUSALS.badValue(valueType) : actRefusal(set));
        if ((refused = await typedWhere())) return;
        if (args['submit'] !== true) return;
        if ((refused = await sameStep())) return;
        const focused = await actOn({ op: 'focus' });
        if (!focused.ok) return void (refused = actRefusal(focused));
        return void (await guardedTries('keyup', pressKey('Enter'), refocus));
      }
      // The pointer there, then a last hit test right before the button goes down, once the page has seen the move (its
      // mouseenter handlers have run): an overlay or a frame put over the point meanwhile gets no press. The page's
      // own test first, then the debugger's, which sees into closed shadow roots. It narrows the race; it can't close
      // it (the page runs between the test and the press too). A page that re-renders (the owner's retest of #117: a
      // game's controls rebuilt every frame) may replace the element anywhere on the way: then it starts over from the
      // pointer's move (which looks for it again), at most PRESS_TRIES times, never once anything's pressed.
      // Typing watches for its click (the page preload's guard counts presses), from before the press's checks: the
      // last check stays right before the press, nothing awaited between (Neon's B3 of round 5).
      const pressMark = tool === 'type' ? await page.watchPress() : null;
      let at = pointed;
      for (let attempt = 1; ; attempt++) {
        const again = (why: string | undefined) => why === 'replaced' && attempt < PRESS_TRIES;
        // Stop, the user taking the tab, the page gone on: never another try, nor another move of the pointer.
        if ((refused = halt())) return;
        if (attempt > 1) {
          const repointed = await actOn({ op: 'point', highlight: false });
          if (!repointed.ok || repointed.x === undefined || repointed.y === undefined) return void (refused = repointed.ok ? ACT_REFUSALS.changed : actRefusal(repointed));
          if (repointed.field && sensitiveField(repointed.field)) return void (refused = ACT_REFUSALS.sensitive);
          at = repointed;
        }
        const x = at.x!;
        const y = at.y!;
        if ((refused = halt())) return;
        page.pointer(x, y);
        let hit = await actOn({ op: 'hit', x, y });
        // The move to the point not seen as the page's last: the pointer was there already (a second click at the point:
        // no move was sent), or another move came after it (Windows sends the real cursor's move when a window changes
        // under it: CI's Windows x64, #112), and the page only keeps the last. One off and back, and the page must see
        // both, as any click's move (its mouseenter and mousemove handlers run before the test). A page that swallows
        // moves still sees neither: no press.
        if (!hit.ok && hit.why === 'no-move') {
          const off = { x: x + 3, y };
          if ((refused = halt())) return;
          page.pointer(off.x, off.y);
          const seen = await actOn({ op: 'hit', ...off, onlyMove: true });
          if (!seen.ok) {
            if (again(seen.why)) continue;
            return void (refused = actRefusal(seen));
          }
          if ((refused = halt())) return;
          page.pointer(x, y);
          hit = await actOn({ op: 'hit', x, y });
        }
        if (!hit.ok) {
          if (again(hit.why)) continue;
          return void (refused = actRefusal(hit));
        }
        const under = await deep.hit(x + (hit.scrollX ?? 0), y + (hit.scrollY ?? 0));
        if (!under.ok) {
          if (again(under.why)) continue;
          return void (refused = deepRefusal(under));
        }
        // Nothing in it hidden in a closed shadow root (the hit test can't see past one to say what's clicked: #112).
        const open = await deep.open();
        if (!open.ok) {
          if (again(open.why)) continue;
          return void (refused = deepRefusal(open));
        }
        const changed = await stepNow();
        if (changed) {
          if (again(changed.why)) continue;
          return void (refused = changed.refused);
        }
        break;
      }
      if ((refused = halt())) return;
      if (!deep.held()) return void (refused = ACT_REFUSALS.noCheck);
      phases.lap('checks');
      page.press(at.x!, at.y!);
      if (tool !== 'type') return;
      // Typing waits for the page to have seen its click (the caret goes where the click put it): only then the select
      // and the text (round 5: under load, 30 typed over 20 made 2030). Not seen: nothing typed.
      if (pressMark === null || !(await page.pressSeen(pressMark, PRESS_SEEN_MS))) return void (refused = ACT_REFUSALS.changed);
      if ((refused = halt())) return;
      if (args['replace'] !== false) {
        const selected = await actOn({ op: 'select' });
        if (!selected.ok) return void (refused = actRefusal(selected));
      }
      const typed = await guardedTries(
        'beforeinput',
        async () => {
          // Every field's value remembered first (in the page), to check where the text went; a no (the element's gone):
          // nothing goes in (the review of #117).
          const remembered = await actOn({ op: 'values', mode: 'remember' });
          if (!remembered.ok) return actRefusal(remembered);
          await page.insertText(text as string);
          return null;
        },
        // Focused and selected again by the select op (Neon's nit 3 of round 5). Text added to what's there is never
        // tried again: the caret could be elsewhere now (Claude's N2).
        async () => (args['replace'] === false ? ACT_REFUSALS.focusMoved : readyAgain(() => actOn({ op: 'select' }), RETRY_CHECKS)),
      );
      if (!typed) return;
      // Where it went: this field changed (or holds the text), and no other did (#112: text that lands in the field
      // that had the focus before is never *done*).
      if ((refused = await typedWhere())) return;
      if (args['submit'] !== true) return;
      // The step again right before Enter (Neon's review 2 of #112): what typing did to the page counts.
      if ((refused = await sameStep())) return;
      await guardedTries('keyup', pressKey('Enter'), refocus);
    },
    // Its input done (phases.ts).
    () => phases.lap('input'));
    // The action sent data after all (an `act` step: a page's own script, a toggle that saves): held, and a card asks
    // for it, naming its sites, before the action is done (it waits on what's held): askHeld.
    if ((await Promise.race([acting.then(() => 'acted' as const), watching.then(() => 'on' as const)])) === 'on' && watch) {
      const w = watch as SendWatch;
      // Allow lets go only if Stop, your taking the tab, or another document since the input (never the action's own
      // pushState, Neon's S16) haven't come between.
      // Its document as it was when the card opened, not when the action began (Claude's final pass: a page the action
      // went to that posts as it loads gets its Allow).
      const sendHalt = (opened: unknown) =>
        call.stopped()
          ? CONTROL_REFUSALS.stopped
          : scope.agent.state(node.id).paused
            ? CONTROL_REFUSALS.paused
            : (takenOver() ?? notHereNow() ?? (page.lost() ? ACT_REFUSALS.noCheck : page.mark.document !== (opened as typeof markAtStart).document ? ELEMENT_REFUSALS.stale : null));
      const sent = await askHeld(w, acting, (held, sites, why, takeDown) => askSendCard(held, sites, why, w, takeDown), sendHalt, originOf(page.url()), () => page.mark);
      refused ??= sent;
    }
    // The hold lost during the action (a detach, the renderer gone): what it sent wasn't asked about, so never done
    // (Neon's B5, round 2 of #147).
    if (!refused && holds && page.lost()) refused = ACT_REFUSALS.noCheck;
    const { navigated, loading } = await acting;
    phases.lap('settle');
    if (deep) await (deep as DeepSession).close();
    if (refused) return refuse(refused);
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    return await done(navigated, loading, actDone(description), droppedBefore, refound, enterMovedFocus);
  } finally {
    // What its page still sends from now is the tab's: held, and asked about between actions (sends.ts).
    (watch as SendWatch | null)?.end();
    if (deep) await (deep as DeepSession).close();
    host.doing(node.id, null);
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

/** The debugger's no, in words for the agent. */
function deepRefusal(answer: Extract<DeepAnswer, { ok: false }>): string {
  if (answer.why === 'closed') return ACT_REFUSALS.closed;
  if (answer.why === 'no-check') return ACT_REFUSALS.noCheck;
  return actRefusal(answer as Extract<ActAnswer, { ok: false }>);
}

/** What a step is (core's classifyStep), from what the page said of the element; none said: as a form's submit. */
function stepOf(tool: ActTool, args: Record<string, unknown>, element: Extract<ActAnswer, { ok: true }>): RiskClass {
  const action: RiskAction =
    tool === 'type' ? { tool, submit: args['submit'] === true } : tool === 'press_key' ? { tool, key: args['key'] as PressKey } : { tool: tool as 'click' | 'hover' | 'select_option' };
  if (tool === 'select_option' || tool === 'hover') return classifyStep(action, emptyRisk);
  const risk = element.risk;
  if (!risk) return { class: 'risky', why: 'submit' };
  const fields = risk.form?.fields ?? [];
  const kinds = fields.map((f) => sensitiveField(f));
  const form: RiskForm | null = risk.form
    ? {
        method: risk.form.method,
        search: risk.form.search,
        searchFields: risk.form.searchFields,
        hidden: risk.form.hidden,
        overflow: risk.form.overflow,
        textFields: fields.filter((f) => f.text).length,
        otherFields: fields.filter((f) => !f.text).length,
        payment: kinds.includes('payment'),
        password: kinds.includes('password') || fields.some((f) => f.type === 'password'),
        labels: fields.map((f) => f.label),
        action: risk.form.action,
      }
    : null;
  return classifyStep(action, { tag: risk.tag, role: element.role, type: risk.type, name: element.name, ...(risk.text ? { text: risk.text } : {}), href: risk.href, ...(risk.hrefUnknown ? { hrefUnknown: true } : {}), editable: element.editable === true, multiline: risk.multiline, submits: risk.submits, form });
}

/**
 * Tries at the pointer's move to the press when the page replaced the element on the way (a re-render: the owner's
 * retest of #117); then it's refused as changed, as before.
 */
const PRESS_TRIES = 5;

/** How long a key's check waits for its keydown to have been handled in the page (the guard's count), at most. */
const KEY_SEEN_MS = 500;

/** A key whose element the page redrew between its keydown and the rest: maybe nothing happened. */
const KEY_REDRAWN = 'The page redrew that element while the key went in, so it may not have worked. Call snapshot and check before pressing it again.';

/** A key's retry checks the step again with at most this many tries of its own. */
const RETRY_CHECKS = 2;

/** How long typing waits for the page to have seen its click, at most. */
const PRESS_SEEN_MS = 500;

/** Send cards in one action at most (each for sites the ones before didn't name): a page that keeps finding more is stopped. */
const SEND_CARDS = 3;

/**
 * What an action's page held (sends.ts), asked about until the action's done: a card for its sites, or the step a
 * document's address is (a script going to a delete address). Allow lets go what goes to the sites the card named,
 * and only after `halt` (Stop, the user taking the tab, the page gone on); something held for another site meanwhile
 * asks again (#112 review 2: Allow never releases more than the card named), at most SEND_CARDS times. Don't, no
 * answer, Stop or your taking the tab (the watch cancelled) drops it all. Returns why it refused, or null.
 */
async function askHeld(
  w: SendWatch,
  acting: Promise<unknown>,
  ask: (held: { url: string; why: RiskWhy | null }[], sites: string[], why: RiskWhy | null, takeDown: AbortSignal) => Promise<Grant | 'waiting'>,
  halt: (opened: unknown) => string | null,
  own: string,
  /** Where the page is when a card opens (its document): what `halt` checks Allow against. */
  mark: () => unknown = () => null,
): Promise<string | null> {
  const acted = acting.then(
    () => 'acted' as const,
    () => 'acted' as const,
  );
  let cards = 0;
  for (;;) {
    if (w.cancelled.aborted) return halt(mark());
    const next = await Promise.race([acted, w.nextHeld()]);
    const held = w.held();
    if (!held.length) {
      if (next === 'acted' || w.cancelled.aborted) return w.cancelled.aborted ? halt(mark()) : null;
      continue;
    }
    if (++cards > SEND_CARDS) {
      w.deny();
      return ACT_REFUSALS.sendsTooMany;
    }
    // A step an address is gets a card of its own; otherwise what's held now, by origin (the page's own first), at most
    // CARD_ORIGINS of them (the card lists that many: round 4 of #112), the rest on the next card.
    const step = held.find((h) => h.why);
    const found = w.sitesOf(step ? [step.url] : held.map((h) => h.url));
    const sites = (found.includes(own) ? [own, ...found.filter((s) => s !== own)] : found).slice(0, CARD_ORIGINS);
    // Each card its own: one no one answers comes down (Neon's S11), never left at the head of the queue.
    const down = new AbortController();
    const opened = mark();
    const answer = await ask(held, sites, step?.why ?? null, AbortSignal.any([w.cancelled, down.signal]));
    if (answer === 'waiting') down.abort();
    if (answer === 'once' || answer === 'always') {
      const halted = halt(opened);
      if (halted) {
        w.deny();
        return halted;
      }
      // A step card's yes: that address only. A send card's: those origins (*Allow until done*, its `always`: and after
      // this action too, until the agent's done: sends.ts).
      w.allow(step ? { url: step.url } : { origins: new Set(sites), until: answer === 'always' });
      continue;
    }
    w.deny();
    if (w.cancelled.aborted) return halt(opened);
    // A no that wasn't the user's (the tab taken over, Stop, the page gone: #116) says so.
    const halted = halt(opened);
    if (halted) return halted;
    return answer === 'waiting' ? ACT_REFUSALS.sendsDropped : ACT_REFUSALS.stepDenied;
  }
}

/** Where a risky step's form or link goes, when that's another site than the page's: the card says so. */
function targetOf(element: Extract<ActAnswer, { ok: true }>, site: string, siteOf: (url: string) => string | null): { to?: string } {
  const url = element.risk?.form?.url || element.risk?.hrefUrl || '';
  const to = url ? (siteOf(url) ?? hostOf(url)) : '';
  return to && to !== site ? { to } : {};
}

/**
 * What a risky step the user allowed lets go (its card named it): its form's address and its link's, exactly. Never an
 * origin: anything else its page sends meanwhile still asks (Claude's review 3 of #112: a POST next to the click's own
 * `location = '/logout'`).
 */
/**
 * Whether a step sends its form (its address is then the step's own): a submit button's click or Space, `type` with
 * `submit`, or Enter in a form's own field, as core's classifyStep has it; never any other key (Neon's final pass).
 */
export function stepSubmits(tool: string, args: Record<string, unknown>, element: { editable?: boolean; risk?: { submits?: boolean; tag?: string } }): boolean {
  if (args['submit'] === true) return true;
  if (tool === 'press_key') {
    const field = element.editable === true || ['input', 'select', 'textarea'].includes(element.risk?.tag ?? '');
    return (args['key'] === 'Enter' && field) || (element.risk?.submits === true && (args['key'] === 'Enter' || args['key'] === 'Space'));
  }
  return tool === 'click' && element.risk?.submits === true;
}

function allowedBy(element: Extract<ActAnswer, { ok: true }>, submits: boolean): Allowed {
  // Its form's address only when the step submits it (Neon's S9); its link's only as a page going there, each once.
  return {
    urls: new Set(submits && element.risk?.form?.url ? [normalUrl(element.risk.form.url)] : []),
    documents: new Set(element.risk?.hrefUrl ? [normalUrl(element.risk.hrefUrl)] : []),
  };
}


/** An address's origin (scheme, host and port), or empty. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * The step's element as a card shows it and a late Allow covers it: its name, the items it's in and its place (Neon's
 * round 1 of M2g-1, B-2: refs stay, so the same ref after a rename or a move is another step), then its risk's shape.
 */
function stepShape(element: Extract<ActAnswer, { ok: true }>): string {
  const risk = element.risk;
  const form = risk?.form;
  return JSON.stringify([element.name, element.items ?? '', element.path ?? '', !risk ? null : [risk.tag, risk.type, risk.submits, risk.href, risk.hrefUrl, risk.hrefUnknown === true, risk.text, form ? [form.hidden, form.overflow] : null, form ? [form.method, form.url, form.search, form.fields.map((f) => [f.type, f.autocomplete, f.name, f.label])] : null]]);
}


const emptyRisk: RiskElement = { tag: '', role: '', type: '', name: '', href: '', editable: false, multiline: false, submits: false, form: null };

/** The page's no, in words for the agent. */
function actRefusal(answer: Extract<ActAnswer, { ok: false }>): string {
  if (answer.why === 'stale') return ELEMENT_REFUSALS.stale;
  // Replaced again and again (the press's tries ran out): changed, as it always was.
  if (answer.why === 'replaced') return ACT_REFUSALS.changed;
  if (answer.why === 'covered') return ACT_REFUSALS.covered(answer.cover ? `${answer.cover.role} ${quotedName(answer.cover.name, answer.cover.role)}` : 'something');
  if (answer.why === 'not-select') return ACT_REFUSALS.notSelect;
  if (answer.why === 'no-answer') return 'The page didn’t answer in time. Call snapshot again, then try once more.';
  if (answer.why === 'no-choice') return ACT_REFUSALS.noChoice;
  if (answer.why === 'two-choices') return ACT_REFUSALS.twoChoices;
  if (answer.why === 'no-move') return ACT_REFUSALS.noMove;
  if (answer.why === 'file') return ACT_REFUSALS.file;
  return ACT_REFUSALS.changed;
}

/* ---------- page_diagnostics (ARCHITECTURE.md §11.3) ---------- */

/**
 * The problems Chromium kept of the tab on screen where the request came
 * from, and only where the agent may read. The scope's card rule applies as
 * for read_tab. Only this tab's debugger is attached, and only now.
 */
async function diagnosticsTool(call: Call, args: Record<string, unknown>): Promise<ToolOutput> {
  const { scope, browser } = call;
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use the tab id from "Attached:".');
  if (isOutput(found)) return found;
  const node = found;
  const page = currentPage(browser, node.id);
  /**
   * Every rule, as things are now: asked before reading, after the approval card (the user may have moved on
   * while it waited), and after the read (the page may have gone somewhere else meanwhile). `at`: the address
   * it must still be at.
   */
  const blocked = (at?: string): string | null => {
    const now = nodeOf(browser.store.state, node.id);
    if (now?.kind !== 'tab') return NEVER;
    if (!scope.readable(now)) return unreadable(scope, now);
    const inspect = scope.mayInspect(now, 'page_diagnostics');
    if (inspect) return inspect;
    if (!page || page.gone()) return 'That tab could not be read.';
    // Where the page is, which can be ahead of the tab's saved address.
    if (isNeverReadable(page.url(), scope.neverSites())) return NEVER;
    // Only a web address can be on another site: a page still loading (about:blank) isn't one, as in blockedNow.
    if (scope.siteOk && READABLE_ADDRESS.test(page.url()) && !scope.siteOk(now, page.url())) return unreadable(scope, now);
    if (at !== undefined && page.url() !== at) return 'The page went to another address while Chord was reading it. Ask the user to ask again once it has loaded.';
    return null;
  };
  const before = blocked();
  if (before || !page) return refuse(before ?? 'That tab could not be read.');
  const title = node.title || safeHost(node.url);
  const refused = await call.card('page_diagnostics', node, `Read the problems on “${title}”`, [node.url], 'The user said no to reading that page’s problems. Carry on without it, or ask them.');
  if (refused) return refused;
  const asked = blocked();
  if (asked) return refuse(asked);
  const url = page.url();
  const pageId = page.id;
  const read = await page.diagnostics();
  if (!read.ok) {
    await call.activity('page_diagnostics', `Couldn’t check “${title}” for problems`, read.why, false);
    return refuse(read.why);
  }
  // What was read belongs to the page that was asked about, still on screen and still readable.
  const after = blocked(url);
  if (after) return refuse(after);
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  // A frame of a *Never read* site inside the page (mail.example.com in www.example.com): its problems are left out.
  const { entries, total } = diagnosticsEntries(read.events, read.types, { sites: scope.neverSites(), contexts: read.contexts, page: url });
  markRead(scope.memory, node.id, url);
  const note = total > entries.length ? `The page has ${total} problems; the newest ${entries.length} are here.` : entries.length ? '' : 'Chromium kept no errors, warnings or failed requests for this page since it loaded.';
  await call.activity('page_diagnostics', `Checked “${title}” for problems`, diagnosticsSummary(entries));
  return { text: diagnosticsResult({ ref: scope.refs.refFor(node.id), url, retrievedAt: Date.now(), entries, total, ...(note ? { note } : {}), pageId: sameId(page, pageId) }) };
}

/* ---------- Forms: read_form, propose_fill (D16, ARCHITECTURE.md §11.6) ---------- */

/**
 * Only the tab on screen where the request came from, and only where the
 * agent may read (never a private window, a chord where it's off, a Never
 * site or a Chord page), never in reader view. Reading follows the scope's
 * card rule as read_tab does. A proposal is for fields of the last read only,
 * on a page still at the address it was read at, shown in the front door's card.
 */
async function formTool(call: Call, tool: 'read_form' | 'propose_fill', args: Record<string, unknown>): Promise<ToolOutput> {
  const { scope, browser } = call;
  if (tool === 'propose_fill' && !scope.fills) return { text: toolResult({ error: `Unknown tool ${tool}` }, false), isError: true };
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use the tab id from "Attached:".');
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  const inspect = scope.mayInspect(node, tool);
  if (inspect) return refuse(inspect);
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its form. Ask the user to close reader view first.');
  const title = node.title || safeHost(node.url);
  const { memory } = scope;
  if (tool === 'read_form') {
    const refused = await call.card(tool, node, `Read the form on “${title}”`, [node.url], 'The user said no to reading that form. Carry on without it, or ask them.');
    if (refused) return refused;
    const moved = blockedNow(call, node.id, null, 'That page could not be read.');
    if (moved) return refuse(moved);
    const page = await loadedPage(browser, node.id, call.signal);
    // Stopped, or the client gave up, while it loaded: the form is never read (round 2 of #145).
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    const loaded = page && blockedNow(call, node.id, page, 'That page could not be read.');
    if (loaded) return refuse(loaded);
    const token = randomBytes(12).toString('hex');
    const pageId = page?.id ?? '';
    const read = page ? await page.readForm(token) : null;
    if (!page || !read) return refuse('That page could not be read.');
    // A form read after Stop is never kept: a later propose_fill must not find it.
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    // Nor one read where the page went meanwhile, if that's a site the agent may never read.
    const after = blockedNow(call, node.id, page, 'That page could not be read.', read.url);
    if (after) return refuse(after);
    const form = formRead(read, memory.nextField);
    memory.nextField += form.fields.length;
    memory.form = { nodeId: node.id, token, read: form };
    markRead(memory, node.id, read.url);
    await call.activity(tool, `Read the form on “${title}”`, `${fieldCount(form.fields.length)}${form.leftOut.length ? ` · ${form.leftOut.length} left out` : ''}`);
    return { text: formResult(form, { ref: scope.refs.refFor(node.id), retrievedAt: Date.now(), ...(sameId(page, pageId) ? { pageId } : {}) }) };
  }
  const fills = scope.fills!;
  const form = memory.form;
  if (!form) return refuse('Read the form with read_form first.');
  if (form.nodeId !== node.id) return refuse('That isn’t the tab whose form you read. Read its form first.');
  const busy = fills.refuse();
  if (busy) return refuse(busy);
  const page = currentPage(browser, node.id);
  if (!page || page.gone()) return refuse('That tab could not be read.');
  const mapped = proposedFill(form.read, args, page.url());
  if (!mapped.ok) return refuse('Some values can’t go in this form. Fix them and call propose_fill again.', mapped.problems);
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const card: AssistantFillCard = { status: 'pending', title, site: safeHost(node.url), fields: mapped.fields, leftOut: form.read.leftOut, truncated: form.read.truncated };
  await fills.show(node, card, form);
  return {
    text: toolResult(
      {
        shown: true,
        fields: card.fields.length,
        // The card owns whether it's filled: what the model writes holds before Fill and after (the owner's preview).
        note: PROPOSED_FILL_NOTE,
      },
      false,
    ),
  };
}

/** The page id taken before a read, if the page is still that document: one that navigated meanwhile gets none. */
const sameId = (page: ControlPage, before: string): string | undefined => (before && page.id === before ? before : undefined);

/** Chromium's PDF viewer: the page's own document says application/pdf (and the extractor sees only the viewer). */
function isPdf(page: PageRead | null, url: string): boolean {
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
