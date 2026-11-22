/**
 * The control layer's tools (S18 M1a): ASSISTANT_TOOLS' handlers, moved from
 * the assistant's service, for any front door. Each call goes through the
 * agent's gate (Stop answers at once), reads pages through the page adapter
 * (page.ts), and asks the scope what this agent may see and when it must ask.
 * The refusals are one sentence each, as the assistant has always said them.
 */
import { randomBytes } from 'node:crypto';
import {
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
  ELEMENT_REFUSALS,
  ElementRefs,
  isActionTool,
  sensitiveField,
  isPressKey,
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
} from '@chord/core';
import type { WebContentsView } from 'electron';
import { pageOf } from '../view-page';
import { controlPage, type ControlPage } from './page';
import type { ActAnswer } from './act';
import type { PageRead } from './extract';
import type { AgentInputEvent } from './input';
import { extractPdf, PdfError, pdfProblemCopy } from './pdf';
import type { ControlScope, ToolOutput } from './scope';

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
export async function runControlTool(scope: ControlScope, browser: ControlBrowser, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const spec = controlTool(name);
  // M2's tools exist only where the scope offers them (a build that has M2), and acting only where it lets its agent
  // act (outside agents in M2c): elsewhere they're unknown, as they were.
  if (!spec || (isActionTool(spec.name) && (!scope.actions || (spec.level === 'act' && !scope.act)))) return { text: toolResult({ error: `Unknown tool ${name}` }, false), isError: true };
  const off = scope.off();
  if (off) return refuse(off);
  const ref = args['tab_id'];
  const tab = typeof ref === 'string' ? (scope.refs.get(ref) ?? null) : null;
  return scope.agent.call(
    tab,
    async (signal) => {
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
        if (spec.name === 'snapshot') return await snapshotTool(call, args);
        if (spec.level === 'act') return await actTool(call, spec.name as ActTool, args);
        return await readTool(call, spec.name, args);
      } catch (error) {
        return { text: toolResult({ error: error instanceof Error ? error.message : String(error) }, false), isError: true };
      }
    },
    (why) => refuse(CONTROL_REFUSALS[why]),
  );
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

/** The tab's page, loading it if it's asleep or wasn't opened since launch. */
async function loadedPage(browser: ControlBrowser, nodeId: NodeId): Promise<ControlPage | null> {
  // A view whose page is gone (its renderer died) has none to wait on.
  const contents = pageOf(browser.tabs.ensure(nodeId));
  if (!contents) return null;
  if (contents.isLoading()) {
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 15_000);
      contents.once('did-stop-loading', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
  return contents.isDestroyed() ? null : controlPage(contents);
}

/** The tab's page as it is now, without waking it. */
function currentPage(browser: ControlBrowser, nodeId: NodeId): ControlPage | null {
  const contents = pageOf(browser.tabs.get(nodeId));
  return contents ? controlPage(contents) : null;
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
      const tabs = scope.tabs().map(({ node, given }) => ({ tab_id: scope.refs.refFor(node.id), title: node.title, site: safeHost(node.url), attached: given }));
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
  const page = await loadedPage(browser, node.id);
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
    const shot = await (reader ? controlPage(reader) : page).screenshot();
    // Kept only once the picture is taken, and never after Stop (as diagnostics and read_form do).
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    const taken = blockedNow(call, node.id, page, 'Could not take the picture.');
    if (taken) return refuse(taken);
    if (shot) scope.memory.read.add(node.id);
    await call.activity(tool, `Looked at “${node.title || safeHost(node.url)}”`, node.url, Boolean(shot));
    return shot ? { image: shot } : refuse('Could not take the picture.');
  }
  const read = await page.read();
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const pdf = isPdf(read, page.url());
  // A PDF's read is the viewer's: readPdf checks the address it fetches itself.
  const after = blockedNow(call, node.id, page, 'That page could not be read.', ...(read && !pdf ? [read.url] : []));
  if (after) return refuse(after);
  scope.memory.read.add(node.id);
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
async function snapshotTool(call: Call, args: Record<string, unknown>): Promise<ToolOutput> {
  const { scope, browser } = call;
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use list_tabs or an attached tab id.');
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its page. Ask the user to close reader view first.');
  const elements = (scope.memory.elements ??= new Map());
  for (const id of [...elements.keys()]) if (nodeOf(browser.store.state, id)?.kind !== 'tab') elements.delete(id);
  const start = typeof args['start'] === 'number' ? args['start'] : 0;
  // Reading on: the same page's latest outline, as it was made, while the page is where it may be read.
  const now = currentPage(browser, node.id);
  const kept = start > 0 && now && !now.gone() ? elements.get(node.id)?.outline(now.id) : null;
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
  const page = await loadedPage(browser, node.id);
  if (!page) return refuse('That tab could not be loaded.');
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const loaded = blockedNow(call, node.id, page, 'That tab could not be loaded.');
  if (loaded) return refuse(loaded);
  const pageId = page.id;
  const token = randomBytes(12).toString('hex');
  const read = await page.snapshot(scope.agent.id, token);
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const after = blockedNow(call, node.id, page, 'That page could not be read.', ...(read ? [read.url] : []));
  if (after) return refuse(after);
  if (!read) return refuse('That page could not be read.');
  let refs = elements.get(node.id);
  if (!refs) elements.set(node.id, (refs = new ElementRefs()));
  // Refs for a page that moved on during the read are issued against no page: they resolve as stale.
  const samePage = sameId(page, pageId);
  // Never a ref for a sensitive field (snapshotKeys): not one shown, and not one that could be guessed.
  const issued = refs.issue(samePage ?? '', token, snapshotKeys(read));
  const outline = snapshotOutline(read, issued);
  const note = snapshotNote(read.cut);
  const retrievedAt = Date.now();
  refs.remember({ pageId: samePage ?? '', retrievedAt, url: read.url, title: read.title, text: outline.text, refs: outline.refs, ...(note ? { note } : {}) });
  scope.memory.read.add(node.id);
  await call.activity('snapshot', `Looked over “${title}”`, `${outline.refs} element${outline.refs === 1 ? '' : 's'} to act on`);
  return { text: snapshotResult({ ref: scope.refs.refFor(node.id), url: read.url, title: read.title, outline: outline.text, refs: outline.refs, start, retrievedAt, ...(samePage ? { pageId: samePage } : {}), ...(note ? { note } : {}) }) };
}

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
  const { scope, browser } = call;
  const host = scope.act!;
  const found = resolveTab(call, args['tab_id'], 'No such tab. Use list_tabs for the tabs there are.');
  if (isOutput(found)) return found;
  const node = found;
  if (!scope.readable(node)) return refuse(unreadable(scope, node));
  const notHere = host.mayAct(node);
  if (notHere) return refuse(notHere);
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its page. Ask the user to close reader view first.');
  const page = await loadedPage(browser, node.id);
  if (!page) return refuse('That tab could not be loaded.');
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const loaded = blockedNow(call, node.id, page, 'That tab could not be loaded.');
  if (loaded) return refuse(loaded);
  const ref = scope.refs.refFor(node.id);
  const done = async (navigated: boolean, loading: boolean, what: string): Promise<ToolOutput> => {
    const after = blockedNow(call, node.id, page, 'That page went somewhere that can’t be read.');
    if (after) return refuse(after);
    if (navigated) scope.memory.elements?.get(node.id)?.forget();
    await call.activity(tool, what, page.url());
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
    const before = page.id;
    host.doing(node.id, tool === 'navigate' ? { tool, to: barAddress(target) } : { tool });
    try {
      // The tab's load can take a while: the user taking the tab, or Stop, meanwhile stops it here.
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      if (scope.agent.state(node.id).paused) return refuse(CONTROL_REFUSALS.paused);
      const went = tool === 'navigate' ? await page.navigate(target) : await page.back(back!);
      if (!went) return refuse(ACT_REFUSALS.noBack);
      const { loading } = went;
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      return await done(page.id !== before, loading, tool === 'navigate' ? `Went to ${barAddress(target)}` : 'Went back');
    } finally {
      host.doing(node.id, null);
    }
  }

  // An element, by its ref from the tab's latest snapshot, on the page it's on now.
  const lookup = scope.memory.elements?.get(node.id)?.resolve(args['ref'], page.id) ?? { ok: false as const, why: 'unknown' as const };
  if (!lookup.ok) return refuse(lookup.why === 'unknown' ? ELEMENT_REFUSALS.unknown(String(args['ref'] ?? '')) : ELEMENT_REFUSALS.stale);
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
  const element = await page.act(owner, lookup.token, lookup.key, { op: 'describe', ...(tool === 'select_option' ? { option: asked } : {}) });
  if (!element.ok) return refuse(actRefusal(element));
  // A field the page turned into a password, code or card field since the snapshot: never acted on (it'd have no ref now).
  if (element.field && sensitiveField(element.field)) return refuse(ACT_REFUSALS.sensitive);
  if (tool === 'type' && !element.editable) return refuse(ACT_REFUSALS.notEditable);
  if (tool === 'select_option' && !element.select) return refuse(ACT_REFUSALS.notSelect);
  if (tool !== 'hover' && element.disabled) return refuse(ACT_REFUSALS.disabled);
  const choice = element.choice ?? '';
  const description: ActDescription = { tool: tool as ElementTool, name: element.name, role: element.role, ...(isPressKey(key) ? { key } : {}), ...(tool === 'select_option' ? { choice } : {}) };
  /**
   * Whether input may go now: never after Stop, never while the user has the tab (their key or click pauses the agent
   * there; the card's wait can be long), never on a page that moved on since the element was checked. Asked right
   * before every input and every text put in, and right after the card.
   */
  const halt = (): string | null => {
    if (call.stopped()) return CONTROL_REFUSALS.stopped;
    if (scope.agent.state(node.id).paused) return CONTROL_REFUSALS.paused;
    // The page went somewhere: input now would land on another page's element.
    if (page.id !== pageAtCheck) return ELEMENT_REFUSALS.stale;
    return null;
  };
  /**
   * Text or a key goes where the focus is: only while it's this element's, and it's no field Chord never types in. The
   * page can still move the focus after this answers (a timer); the guard (see below) stops what would land elsewhere.
   */
  const focusOk = async (now?: ActAnswer): Promise<string | null> => {
    now ??= await page.act(owner, lookup.token, lookup.key, { op: 'focused' });
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
    const answer = await scope.agent.ask({ kind: 'site', tool, description: actPhrase(description), target: [page.url()], tab: node.id, subject: site }, call.signal, scope.cardWaitMs);
    if (answer === 'waiting') return refuse(CONTROL_REFUSALS.waiting);
    if (answer === 'deny') return refuse(ACT_REFUSALS.siteDenied(site));
    // The card's wait can be long: Stop, the user taking the tab, the page moving on meanwhile, all stop it here.
    const halted = halt();
    if (halted) return refuse(halted);
    const after = blockedNow(call, node.id, page, 'That tab could not be loaded.');
    if (after) return refuse(after);
    if (!scope.memory.elements?.get(node.id)?.resolve(args['ref'], page.id).ok) return refuse(ELEMENT_REFUSALS.stale);
    // And on another site now, it'd need its own yes.
    if (host.siteOf(page.url()) !== site) return refuse(ELEMENT_REFUSALS.stale);
    // It runs, on the page and site the card named: the yes is kept now (the agent's life; a fresh Always for good).
    scope.agent.keep('site', site, answer);
    if (answer === 'always') host.keepSite(site);
  }

  host.doing(node.id, description);
  try {
    let refused: string | null = null;
    /**
     * Text or keys in, with the page's guard up: a key or an insertion the page would get anywhere but the element (the
     * focus moved after focusOk: a timer, between two key events) is stopped there, and the action ends. False then.
     */
    const guarded = async (until: 'keyup' | 'beforeinput', input: () => void | Promise<void>): Promise<boolean> => {
      const up = await page.act(owner, lookup.token, lookup.key, { op: 'guard', until });
      if (!up.ok) {
        refused = actRefusal(up);
        return false;
      }
      await input();
      // The input's events are on their way (each its own message): unguard waits for the last one. No answer counts as
      // done: the page went (a submit's Enter navigated it), so its document, and where its focus was, are gone too.
      const down = await page.act(owner, lookup.token, lookup.key, { op: 'unguard' });
      if (down.ok && down.moved) refused = ACT_REFUSALS.focusMoved;
      else if (down.ok && down.lost) refused = ACT_REFUSALS.focusLost;
      return !refused;
    };
    const { navigated, loading } = await page.afterActing(async () => {
      const pointed = await page.act(owner, lookup.token, lookup.key, { op: 'point', highlight: true });
      if (!pointed.ok || pointed.x === undefined || pointed.y === undefined) return void (refused = pointed.ok ? ACT_REFUSALS.changed : actRefusal(pointed));
      if ((refused = halt())) return;
      if (tool === 'select_option') {
        // By the page's whole label, as describe matched it (the card showed it clipped).
        const chosen = await page.act(owner, lookup.token, lookup.key, { op: 'choose', option: asked });
        if (!chosen.ok) refused = actRefusal(chosen);
        return;
      }
      if (tool === 'press_key') {
        // focus answers whether it has it now, as focused would.
        if ((refused = await focusOk(await page.act(owner, lookup.token, lookup.key, { op: 'focus' })))) return;
        return void (await guarded('keyup', () => page.keys(pressKeyEvents(key as PressKey) as AgentInputEvent[])));
      }
      // The pointer there, then a last hit test right before the button goes down, once the page has seen the move (its
      // mouseenter handlers have run): an overlay or a frame put over the point meanwhile gets no press. It narrows the
      // race; it can't close it (the page runs between the test and the press too).
      page.pointer(pointed.x, pointed.y);
      if (tool === 'hover') return;
      const hit = await page.act(owner, lookup.token, lookup.key, { op: 'hit', x: pointed.x, y: pointed.y });
      if (!hit.ok) return void (refused = actRefusal(hit));
      if ((refused = halt())) return;
      page.press(pointed.x, pointed.y);
      if (tool !== 'type') return;
      if (args['replace'] !== false) {
        const selected = await page.act(owner, lookup.token, lookup.key, { op: 'select' });
        if (!selected.ok) return void (refused = actRefusal(selected));
      }
      // Text goes where the focus is: this element's, and no field Chord never types in, checked right before.
      if ((refused = await focusOk())) return;
      if (!(await guarded('beforeinput', () => page.insertText(text as string)))) return;
      if (args['submit'] !== true) return;
      if ((refused = await focusOk())) return;
      await guarded('keyup', () => page.keys(pressKeyEvents('Enter') as AgentInputEvent[]));
    });
    if (refused) return refuse(refused);
    if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
    return await done(navigated, loading, actDone(description));
  } finally {
    host.doing(node.id, null);
  }
}

/** The page's no, in words for the agent. */
function actRefusal(answer: Extract<ActAnswer, { ok: false }>): string {
  if (answer.why === 'stale') return ELEMENT_REFUSALS.stale;
  if (answer.why === 'covered') return ACT_REFUSALS.covered(answer.cover ? `${answer.cover.role} ${quotedName(answer.cover.name, answer.cover.role)}` : 'something');
  if (answer.why === 'not-select') return ACT_REFUSALS.notSelect;
  if (answer.why === 'no-answer') return 'The page didn’t answer in time. Call snapshot again, then try once more.';
  if (answer.why === 'no-choice') return ACT_REFUSALS.noChoice;
  if (answer.why === 'two-choices') return ACT_REFUSALS.twoChoices;
  if (answer.why === 'no-move') return ACT_REFUSALS.noMove;
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
  scope.memory.read.add(node.id);
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
    const page = await loadedPage(browser, node.id);
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
    memory.read.add(node.id);
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
        note: 'The user now checks these in a card in this chat, changes or leaves out what they like, and presses Fill themselves. Nothing is in the page yet, and Chord never submits: tell them to check the card, and that they send the form with the page’s own button.',
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
