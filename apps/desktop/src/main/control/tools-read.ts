/** The control layer's reading tools (split from tools.ts, #213): list_tabs, the searches, read_tab, read_selection, tab_screenshot, page_diagnostics, read_form and propose_fill. */
import { randomBytes } from 'node:crypto';
import { ASSISTANT_PDF_MAX_PAGES, CONTROL_REFUSALS, diagnosticsEntries, diagnosticsResult, diagnosticsSummary, fieldCount, formRead, formResult, isNeverReadable, nodeOf, pageResult, pdfText, proposedFill, PROPOSED_FILL_NOTE, toolResult, type AssistantFillCard, type AssistantToolName, type TabNode } from '@chord/core';
import { pageOf } from '../view-page';
import { controlPage, type ControlPage } from './page';
import { extractPdf, PdfError, pdfProblemCopy } from './pdf';
import type { ToolOutput } from './scope';
import { type Call, NEVER, PDFS_KEPT, READABLE_ADDRESS, blockedNow, crashedWhy, currentPage, isOutput, isPdf, loadedPage, markRead, refuse, resolveTab, safeHost, sameId, unreadable } from './tool-call';
import { FIRST_LOOK_MS, NOTHING_SHOWN } from './tools-outline';

/* ---------- Reading: list_tabs, searches, read_tab, read_selection, tab_screenshot ---------- */

export async function readTool(call: Call, tool: AssistantToolName, args: Record<string, unknown>): Promise<ToolOutput> {
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
  // One part, by its container ref (#207): where the scope reads parts.
  if (tool === 'read_tab' && args['ref'] !== undefined && scope.boxes) return readPart(call, node, page, pageId, ref, args);
  if (tool === 'tab_screenshot') {
    // What's on screen: a tab in reader view shows its article (its page waits, detached, where no picture can be taken).
    const reader = pageOf(browser.readers.viewFor(node.id));
    // A page that draws itself after it loads (the owner's first look at a new tab): waited for a moment, never
    // pictured empty (a reader view always shows its article).
    if (!reader && !(await page.shows(FIRST_LOOK_MS))) {
      if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
      return refuse(NOTHING_SHOWN('Take the picture'));
    }
    const shot = await (reader ? controlPage(reader, browser.tabs) : page).screenshot();
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
  // Whole numbers only (round 1 of #252, SF-1): a length that isn't one is none asked for, never a way past the
  // scope's default (#206: outside agents read 20000 at a time) or the one-character minimum.
  const start = wholeArg(args['start']) ?? 0;
  const length = wholeArg(args['length']) ?? call.scope.readDefault;
  const text = pageResult({ ref, url: read.url, text: read.text, start, ...(length !== undefined ? { length } : {}), retrievedAt: Date.now(), pageId: sameId(page, pageId) });
  await call.activity(tool, `Read “${node.title || safeHost(node.url)}”`, node.url);
  return { text };
}

/** A number argument as a whole number, or none (NaN, Infinity, anything else): round 1 of #252, SF-1. */
const wholeArg = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined);

/** read_tab by a part's ref (#207): Chord's words, never the page's. */
export const PART_REFUSALS = {
  unknown: 'That isn’t a ref of a part of that tab. Parts’ refs (c1, c2…) come from your latest snapshot of it.',
  stale: 'That part has changed since your snapshot, or the page moved on: call snapshot again.',
  editor: 'That part is an editor: what shows in it is what’s typed there, so it isn’t read.',
  act: 'A c ref names a part of a page to read with read_tab, never one to act on: use an element’s ref (e1, e2…).',
} as const;

/**
 * read_tab by a part's container ref (S18 M2g-2, #207): the part the agent's latest snapshot showed, found again in the
 * page and checked as an action checks its element (still there, its role and name as the outline gave them, shown), on
 * the page it's on now. Read under read_tab's rules (its card, the scope, Never sites before and after, on the read's own
 * address), by the page read's own walk, strict (never a field's value, an editor's contents, an ARIA text field's).
 * Changed means refused as stale, never read. Capped and in ranges as read_tab is, with which part it is.
 */
async function readPart(call: Call, node: TabNode, page: ControlPage, pageId: string, tabRef: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const refs = call.scope.memory.elements?.get(node.id);
  const found = refs?.resolveBox(args['ref'], page.id) ?? { ok: false as const, why: 'unknown' as const };
  if (!found.ok) return refuse(found.why === 'unknown' ? PART_REFUSALS.unknown : PART_REFUSALS.stale);
  const answer = await page.readBox(call.scope.agent.id, found.token, found.box);
  if (call.stopped()) return refuse(CONTROL_REFUSALS.stopped);
  const after = blockedNow(call, node.id, page, 'That page could not be read.', ...(answer?.ok ? [answer.url] : []));
  if (after) return refuse(after);
  if (!answer) return refuse('That page could not be read.');
  if (!answer.ok) return refuse(answer.why === 'editor' ? PART_REFUSALS.editor : PART_REFUSALS.stale);
  // The page moved on as it was read: what was read may be another page's.
  if (!sameId(page, pageId)) return refuse(PART_REFUSALS.stale);
  markRead(call.scope.memory, node.id, answer.url);
  const start = wholeArg(args['start']) ?? 0;
  const length = wholeArg(args['length']) ?? call.scope.readDefault;
  const text = pageResult({ ref: tabRef, url: answer.url, text: answer.text, start, ...(length !== undefined ? { length } : {}), retrievedAt: Date.now(), pageId, part: { ref: String(args['ref']), role: answer.role, name: answer.name } });
  await call.activity('read_tab', `Read a part of “${node.title || safeHost(node.url)}”`, node.url);
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
  // Whole numbers only (round 1 of #252, SF-1): a length that isn't one is none asked for, never a way past the
  // scope's default (#206: outside agents read 20000 at a time) or the one-character minimum.
  const start = wholeArg(args['start']) ?? 0;
  const length = wholeArg(args['length']) ?? call.scope.readDefault;
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
  const text = pageResult({ ref, url, text: pdf.text, start, ...(length !== undefined ? { length } : {}), retrievedAt: Date.now(), pdf: { pages: pdf.totalPages, read }, ...(notes.length ? { note: notes.join(' ') } : {}), pageId: sameId(page, pageId) });
  await call.activity('read_tab', `Read “${title}”`, pdf.totalPages > read ? `PDF, pages 1–${read} of ${pdf.totalPages}` : `PDF, ${pdf.totalPages} page${pdf.totalPages === 1 ? '' : 's'}`);
  return { text };
}

/* ---------- page_diagnostics (ARCHITECTURE.md §11.3) ---------- */

/**
 * The problems Chromium kept of the tab on screen where the request came
 * from, and only where the agent may read. The scope's card rule applies as
 * for read_tab. Only this tab's debugger is attached, and only now.
 */
export async function diagnosticsTool(call: Call, args: Record<string, unknown>): Promise<ToolOutput> {
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
    // Its page crashed: said so (#336, Neon's NSF2).
    if (page.crashed?.()) return crashedWhy(call, node.id, false);
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
    // A crash while it read says so, never the read's own words (NSF2).
    const why = blocked() ?? read.why;
    await call.activity('page_diagnostics', `Couldn’t check “${title}” for problems`, why, false);
    return refuse(why);
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
export async function formTool(call: Call, tool: 'read_form' | 'propose_fill', args: Record<string, unknown>): Promise<ToolOutput> {
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
    // A crash while it read says so (NSF2), before the read's own failure.
    if (!page || !read) return refuse((page && blockedNow(call, node.id, page, 'That page could not be read.')) || 'That page could not be read.');
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
  if (page.crashed?.()) return refuse(crashedWhy(call, node.id, false));
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
