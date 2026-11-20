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
  isNeverReadable,
  nodeOf,
  pageResult,
  pdfText,
  proposedFill,
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
import type { PageRead } from './extract';
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

const refuse = (why: string, problems?: string[]): ToolOutput => ({ text: toolResult({ refused: why, ...(problems ? { problems } : {}) }, false), isError: true });

/** One call's view of its agent: the scope, the browser, and the call's own Stop. */
interface Call {
  scope: ControlScope;
  browser: ControlBrowser;
  signal: AbortSignal;
  /** Ask the user to read; true for yes. */
  ask(tool: AssistantToolName, description: string, target: string[], node: TabNode | null): Promise<boolean>;
  /** The scope's activity line, unless the call was stopped. */
  activity(tool: string, summary: string, detail?: string, ok?: boolean): Promise<void>;
}

/** A tool call from a model: through the gate, then its handler. */
export async function runControlTool(scope: ControlScope, browser: ControlBrowser, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const spec = controlTool(name);
  if (!spec) return { text: toolResult({ error: `Unknown tool ${name}` }, false), isError: true };
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
        ask: async (tool, description, target, node) =>
          (await scope.agent.ask({ kind: 'read', tool, description, target, tab: node?.id ?? null, subject: tool }, signal)) !== 'deny',
        activity: async (tool, summary, detail = '', ok = true) => {
          if (!signal.aborted) await scope.activity(tool, summary, detail, ok);
        },
      };
      try {
        if (spec.name === 'read_form' || spec.name === 'propose_fill') return await formTool(call, spec.name, args);
        if (spec.name === 'page_diagnostics') return await diagnosticsTool(call, args);
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
    if (scope.needsCard(tool, null)) {
      const what = tool === 'list_tabs' ? 'See the list of your tabs' : tool === 'search_history' ? `Search your history for “${String(args['query'] ?? '')}”` : `Search your archive for “${String(args['query'] ?? '')}”`;
      if (!(await call.ask(tool, what, [], null))) return refuse('The user said no to this. Carry on without it, or ask them.');
    }
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
  if (!scope.readable(node)) return refuse(NEVER);
  if (scope.needsCard(tool, node)) {
    const verb = tool === 'tab_screenshot' ? 'Take a picture of' : 'Read';
    if (!(await call.ask(tool, `${verb} “${node.title || safeHost(node.url)}”`, [node.url], node))) return refuse('The user said no to reading that tab. Carry on without it, or ask them.');
  }
  const page = await loadedPage(browser, node.id);
  if (!page) return refuse('That tab could not be loaded.');
  scope.memory.read.add(node.id);
  const ref = scope.refs.refFor(node.id);
  if (tool === 'tab_screenshot') {
    // What's on screen: a tab in reader view shows its article (its page waits, detached, where no picture can be taken).
    const reader = pageOf(browser.readers.viewFor(node.id));
    const shot = await (reader ? controlPage(reader) : page).screenshot();
    await call.activity(tool, `Looked at “${node.title || safeHost(node.url)}”`, node.url, Boolean(shot));
    return shot ? { image: shot } : refuse('Could not take the picture.');
  }
  const read = await page.read();
  if (isPdf(read, page.url())) {
    if (tool === 'read_selection') return refuse('What’s selected inside a PDF can’t be seen. Read the PDF with read_tab instead.');
    return readPdf(call, node, page, ref, args);
  }
  if (!read) return refuse('That page could not be read.');
  if (tool === 'read_selection') {
    await call.activity(tool, `Read your selection in “${node.title || safeHost(node.url)}”`, node.url);
    return { text: pageResult({ ref, url: read.url, text: read.selection, retrievedAt: Date.now(), pageId: page.id }) };
  }
  const start = typeof args['start'] === 'number' ? args['start'] : 0;
  const length = typeof args['length'] === 'number' ? args['length'] : undefined;
  const text = pageResult({ ref, url: read.url, text: read.text, start, ...(length ? { length } : {}), retrievedAt: Date.now(), pageId: page.id });
  await call.activity(tool, `Read “${node.title || safeHost(node.url)}”`, node.url);
  return { text };
}

/**
 * A PDF in Chromium's viewer: its bytes through the tab's own session, its
 * text from pdf.js in a utility process, with [Page n] markers. Reading on
 * from `start` reuses the same read; a new read fetches it again.
 */
async function readPdf(call: Call, node: TabNode, page: ControlPage, ref: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const { memory } = call.scope;
  const title = node.title || safeHost(node.url);
  const url = page.url();
  const start = typeof args['start'] === 'number' ? args['start'] : 0;
  const length = typeof args['length'] === 'number' ? args['length'] : undefined;
  let pdf = memory.pdfs.get(node.id);
  if (!pdf || pdf.url !== url || start === 0) {
    try {
      // The address the tab shows now, and where the download ends up, must both be readable.
      const readable = (address: string) => !isNeverReadable(address, call.scope.neverSites());
      if (!readable(url)) throw new PdfError('never');
      const bytes = await page.fetchPdf(url, readable);
      const { pages, totalPages } = await extractPdf(bytes, ASSISTANT_PDF_MAX_PAGES);
      pdf = { url, pages, totalPages, text: pdfText(pages) };
    } catch (error) {
      const why = error instanceof PdfError ? pdfProblemCopy(error.problem, error.detail) : pdfProblemCopy('crashed');
      await call.activity('read_tab', `Couldn’t read “${title}”`, why, false);
      return { text: toolResult({ refused: `Couldn’t read this PDF: ${why}.` }, false), isError: true };
    }
    memory.pdfs.delete(node.id);
    memory.pdfs.set(node.id, pdf);
    if (memory.pdfs.size > PDFS_KEPT) memory.pdfs.delete(memory.pdfs.keys().next().value!);
  }
  const read = pdf.pages.length;
  const notes = [
    pdf.totalPages > read ? `This PDF has ${pdf.totalPages} pages; pages 1–${read} were read, the most Chord reads.` : '',
    pdf.pages.every((p) => !p.trim()) ? 'This PDF has no text to read (it may be scanned pages); tab_screenshot shows the page on screen.' : '',
  ].filter(Boolean);
  const text = pageResult({ ref, url, text: pdf.text, start, ...(length ? { length } : {}), retrievedAt: Date.now(), pdf: { pages: pdf.totalPages, read }, ...(notes.length ? { note: notes.join(' ') } : {}), pageId: page.id });
  await call.activity('read_tab', `Read “${title}”`, pdf.totalPages > read ? `PDF, pages 1–${read} of ${pdf.totalPages}` : `PDF, ${pdf.totalPages} page${pdf.totalPages === 1 ? '' : 's'}`);
  return { text };
}

/* ---------- page_diagnostics (ARCHITECTURE.md §11.3) ---------- */

/**
 * The problems Chromium kept of the tab on screen where the request came
 * from, and only where the agent may read. The scope's card rule applies as
 * for read_tab. Only this tab's debugger is attached, and only now.
 */
async function diagnosticsTool(call: Call, args: Record<string, unknown>): Promise<ToolOutput> {
  const { scope, browser } = call;
  const offScreen = "Only the tab on screen's problems can be read. Ask the user to switch to it, then to ask again.";
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
    if (now?.kind !== 'tab' || !scope.readable(now)) return NEVER;
    if (scope.onScreen() !== node.id) return offScreen;
    if (!page || page.gone()) return 'That tab could not be read.';
    // Where the page is, which can be ahead of the tab's saved address.
    if (isNeverReadable(page.url(), scope.neverSites())) return NEVER;
    if (at !== undefined && page.url() !== at) return 'The page went to another address while Chord was reading it. Ask the user to ask again once it has loaded.';
    return null;
  };
  const before = blocked();
  if (before || !page) return refuse(before ?? 'That tab could not be read.');
  const title = node.title || safeHost(node.url);
  if (scope.needsCard('page_diagnostics', node)) {
    if (!(await call.ask('page_diagnostics', `Read the problems on “${title}”`, [node.url], node))) return refuse('The user said no to reading that page’s problems. Carry on without it, or ask them.');
  }
  const asked = blocked();
  if (asked) return refuse(asked);
  const url = page.url();
  const read = await page.diagnostics();
  if (!read.ok) {
    await call.activity('page_diagnostics', `Couldn’t check “${title}” for problems`, read.why, false);
    return refuse(read.why);
  }
  // What was read belongs to the page that was asked about, still on screen and still readable.
  const after = blocked(url);
  if (after) return refuse(after);
  // A frame of a *Never read* site inside the page (mail.example.com in www.example.com): its problems are left out.
  const { entries, total } = diagnosticsEntries(read.events, read.types, { sites: scope.neverSites(), contexts: read.contexts, page: url });
  scope.memory.read.add(node.id);
  const note = total > entries.length ? `The page has ${total} problems; the newest ${entries.length} are here.` : entries.length ? '' : 'Chromium kept no errors, warnings or failed requests for this page since it loaded.';
  await call.activity('page_diagnostics', `Checked “${title}” for problems`, diagnosticsSummary(entries));
  return { text: diagnosticsResult({ ref: scope.refs.refFor(node.id), url, retrievedAt: Date.now(), entries, total, ...(note ? { note } : {}), pageId: page.id }) };
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
  if (!scope.readable(node)) return refuse(NEVER);
  if (scope.onScreen() !== node.id) return refuse('Forms are filled only on the tab on screen. Ask the user to switch to it, then to ask again.');
  if (browser.readers.viewFor(node.id)) return refuse('That tab is in reader view, which hides its form. Ask the user to close reader view first.');
  const title = node.title || safeHost(node.url);
  const { memory } = scope;
  if (tool === 'read_form') {
    if (scope.needsCard(tool, node)) {
      if (!(await call.ask(tool, `Read the form on “${title}”`, [node.url], node))) return refuse('The user said no to reading that form. Carry on without it, or ask them.');
    }
    const page = await loadedPage(browser, node.id);
    const token = randomBytes(12).toString('hex');
    const read = page ? await page.readForm(token) : null;
    if (!page || !read) return refuse('That page could not be read.');
    const form = formRead(read, memory.nextField);
    memory.nextField += form.fields.length;
    memory.form = { nodeId: node.id, token, read: form };
    memory.read.add(node.id);
    await call.activity(tool, `Read the form on “${title}”`, `${fieldCount(form.fields.length)}${form.leftOut.length ? ` · ${form.leftOut.length} left out` : ''}`);
    return { text: formResult(form, { ref: scope.refs.refFor(node.id), retrievedAt: Date.now(), pageId: page.id }) };
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
