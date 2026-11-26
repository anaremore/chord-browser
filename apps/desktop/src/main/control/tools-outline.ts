/** The control layer's outline tools (split from tools.ts, #213): snapshot, and wait_for. */
import { randomBytes } from 'node:crypto';
import { CONTROL_REFUSALS, ACT_REFUSALS, ElementRefs, nodeOf, snapshotKeys, snapshotNote, snapshotOutline, snapshotResult, toolResult, type NodeId, type TabNode, SNAPSHOT_FIND_MAX, WAIT_FOR_DEFAULT_MS, WAIT_FOR_MAX_MS, WAIT_FOR_TEXT_MAX, snapshotDiff, snapshotDiffShown, snapshotLines, snapshotLinesWithRefs, snapshotRange, refsInRange, type SnapshotRead } from '@chord/core';
import { pageOf } from '../view-page';
import type { WaitAnswer } from './snapshot';
import type { ControlScope, ToolOutput } from './scope';
import { type Call, blockedNow, currentPage, isOutput, loadedPage, markRead, originOf, refuse, resolveTab, safeHost, sameId, unreadable } from './tool-call';
import { STILL_LOADING } from './tools-act';

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

/**
 * Refs inside same-origin frames (#210's B3): only in an agent's own tab (acting there, no lease, nothing against its
 * acting: #320's SF1), never a tab of yours, nor one shared with an outside agent.
 */
function frameRefsFor(scope: ControlScope, node: TabNode): boolean {
  return Boolean(scope.act) && !scope.act?.lease && scope.act?.mayAct(node) === null;
}

export async function snapshotTool(call: Call, args: Record<string, unknown>, settled = false): Promise<ToolOutput> {
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
  // Trimmed: a find of nothing but spaces is no find (round 1 of #263).
  const find = typeof args['find'] === 'string' && args['find'].trim() ? args['find'].trim().slice(0, SNAPSHOT_FIND_MAX) : undefined;
  // A flat find (#208): where the scope asks for it (outside agents; the assistant behind its flag).
  const flat = Boolean(find && scope.findFlat);
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
    const text = snapshotResult({ ref: scope.refs.refFor(node.id), url: kept.url, title: kept.title, outline: kept.text, refs: kept.refs, start, retrievedAt: kept.retrievedAt, pageId: kept.pageId, ...(kept.note ? { note: kept.note } : {}) });
    // The refs on the lines this range shows (#208: rule 1), by each line's own element (round 1 of #263).
    tabRefs!.showRefs(kept.pageId, refsInRange(kept.lineRefs ?? [], snapshotRange(kept.text, start)));
    return { text };
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
  // A flat find's read is unpinned (round 1 of #263): it never takes the agent's full snapshot's place in the page.
  let read = await page.snapshot(scope.agent.id, token, !flat, Boolean(scope.boxes), frameRefsFor(scope, node));
  // Nothing in it: a page that draws itself after it loads (the owner, 2026-11-24: a new tab's first look came back
  // empty). Taken once more when the page shows something, at most FIRST_LOOK_MS later; still nothing, the result says so.
  // Not for a page that went somewhere it may not be read, or (for an action's answer) began loading or went elsewhere:
  // no wait, and no read, once the page has moved on (round 2 of #232).
  const movedOn = () => (read ? blockedNow(call, node.id, page, 'That page could not be read.', read.url) !== null : false) || (settled && (loadingNow() || !sameId(page, pageId)));
  if (read && read.nodes.length === 0 && !call.stopped() && !movedOn() && (await page.shows(FIRST_LOOK_MS)) && !call.stopped() && !movedOn()) {
    token = randomBytes(12).toString('hex');
    read = await page.snapshot(scope.agent.id, token, !flat, Boolean(scope.boxes), frameRefsFor(scope, node));
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
  const issued = refs.issue(samePage ?? '', token, snapshotKeys(read), sidsOf(read), !flat);
  // Container refs (#207), where the scope reads parts: on the lines shown, numbered as element refs are (round 1 of #260).
  const boxes = scope.boxes && samePage ? { boxes: refs.boxRefsFor(samePage, new Map(read.nodes.filter((n) => n.box !== undefined && n.sid !== undefined).map((n) => [n.box!, n.sid!]))) } : {};
  const outline = snapshotOutline(read, issued, { ...(find ? { find } : {}), ...(flat ? { flat: true } : {}), ...(outlineOnly ? { text: false } : {}), ...boxes });
  // A page of nothing but text: said, with where its text is (#205). Decided from the read, never from an empty outline
  // (round 1 of #247): a find that matched nothing, or a read cut before it reached the page's structure, isn't one.
  const onlyText = outlineOnly && !find && !read.cut.elements && !read.cut.time && read.nodes.length > 0 && !read.nodes.some((n) => n.role !== 'text');
  // A flat find that matched nothing (#208): said in Chord's words, never the page's (the nearest names are in the
  // content, inside the untrusted envelope).
  const findNote = flat && outline.matched === 0 ? (outline.nearest ? FIND_NEAREST_NOTE : FIND_NONE_NOTE) : undefined;
  // (A read cut short says so too, a find's with it: round 1 of #263.)
  const cutNote = snapshotNote(read.cut);
  const note = read.nodes.length === 0 ? NOTHING_SHOWN('Call snapshot') : onlyText ? ONLY_TEXT : findNote ? [findNote, cutNote].filter(Boolean).join(' ') : cutNote;
  const retrievedAt = Date.now();
  // Its later ranges are of the page's whole outline (of its kind), never a find's (N-3). A flat find keeps none: its
  // lines are all it shows (round 1 of #263).
  const whole = find && !flat ? snapshotOutline(read, issued, { ...(outlineOnly ? { text: false } : {}), ...boxes }) : outline;
  // The container refs it gave (#207), in their own table: the outline's, and its whole's (its later ranges); a flat
  // find's, its own lines' alone. A part read by one is never more than read_tab reads of the whole page; never an
  // element ref's table, and never an action's.
  if (scope.boxes) refs.issueBoxes(samePage ?? '', token, new Map([...(whole.boxes ?? []), ...(outline.boxes ?? [])]));
  // An outline without the page's text is no baseline for the diff (plan rule 1: a view that shows part of the page
  // never commits one): its refs are issued, and the outline the next diff compares with stays the last whole one. It's
  // kept in a slot of its own for its later ranges (round 1 of #247), with no lines.
  // A flat find is no baseline either, and keeps no outline (#208): its lines are all it shows, and the outline the next
  // diff compares with stays the last whole one.
  if (flat) refs.markFind(samePage ?? '');
  else if (outlineOnly) refs.rememberTextless({ pageId: samePage ?? '', retrievedAt, url: read.url, title: read.title, text: whole.text, refs: whole.refs, lineRefs: whole.lineRefs, ...(note ? { note } : {}) });
  else
    refs.remember({ pageId: samePage ?? '', retrievedAt, url: read.url, title: read.title, text: whole.text, refs: whole.refs, lineRefs: whole.lineRefs, lines: snapshotLines(read, issued), ...(note ? { note } : {}), ...(read.cut.elements || read.cut.time || read.cut.refs ? { cut: true } : {}) });
  markRead(scope.memory, node.id, read.url);
  await call.activity('snapshot', `Looked over “${title}”`, `${outline.refs} element${outline.refs === 1 ? '' : 's'} to act on`);
  const text = snapshotResult({ ref: scope.refs.refFor(node.id), url: read.url, title: read.title, outline: outline.text, refs: outline.refs, start, retrievedAt, ...(samePage ? { pageId: samePage } : {}), ...(note ? { note } : {}) });
  // Only the refs on the lines this answer shows are acted on (#208: rule 1): its range of the outline, or the find's
  // lines, by each line's own element, never read out of the text (round 1 of #263).
  if (samePage) refs.showRefs(samePage, refsInRange(outline.lineRefs, snapshotRange(outline.text, start)));
  return { text };
}

/** A flat find's notes (#208): Chord's words alone. */
export const FIND_NEAREST_NOTE = 'Nothing here is named with that. The nearest names are below: a find with their words finds them.';
export const FIND_NONE_NOTE = 'Nothing here is named with that, nor with any of its words.';

/** The page's own ids of a snapshot's keyed elements (key → id), for refs that stay (core's ElementRefs). */
function sidsOf(read: SnapshotRead): Map<number, number> {
  return new Map(read.nodes.filter((n) => n.key !== undefined && n.sid !== undefined).map((n) => [n.key!, n.sid!]));
}

/** A diff that found nothing changed (its lines empty): said by saying nothing. */
export const emptyDiff = (changes: Record<string, unknown>): boolean => {
  const lines = (changes['page_changes'] as { lines?: unknown } | undefined)?.lines;
  return Array.isArray(lines) && lines.length === 0;
};

/**
 * What changed, inside an action's answer (S18 M2g-2, #206): its page and address said once. Its page is always the
 * answer's (a page that went to another document meanwhile is said navigated, with no diff: round 1 of #252); its
 * address is kept only where it differs (the same document gone to another address, a pushState, as it was read).
 */
export function saidOnce(changes: Record<string, unknown>, url: string): Record<string, unknown> {
  const { page_id: _of, url: at, ...rest } = changes['page_changes'] as Record<string, unknown>;
  return { page_changes: { ...(at !== url ? { url: at } : {}), ...rest } };
}

/** A diff past this many lines says to call snapshot instead (M2g-1: never more than the outline would have cost). */
const DIFF_MAX_LINES = 60;

/**
 * What changed in the page since the agent's last snapshot of it (M2g-1, the owner's token goal): after an action, or
 * when a wait is met. Read again as a snapshot is (its refs the tab's latest, an element still there with its ref), and
 * only the lines that differ: new (+), changed as they are now (~), gone (-). Null with no snapshot of this page to
 * compare with (then the agent calls snapshot), or if the page went elsewhere meanwhile.
 */
export async function pageChanges(call: Call, nodeId: NodeId, page: NonNullable<Awaited<ReturnType<typeof loadedPage>>>): Promise<Record<string, unknown> | null> {
  const refs = call.scope.memory.elements?.get(nodeId);
  const kept = refs?.outline(page.id);
  // Its refs are this page's, from an outline without text, with no whole one to compare with (#205): said, never
  // silence, which would read as nothing changed.
  // (It follows an outline without text alone, so it says how to get a full one: round 2 of #247.)
  // Where to look: a full snapshot. Said so after an outline without text (round 1 of #247, Fable's S2) or a find (round
  // 1 of #263), neither of which moves the baseline, so calling it again would loop.
  const found = refs?.lastWasFind(page.id) ?? false;
  const textless = refs?.textlessOutline(page.id) !== null && refs?.textlessOutline(page.id) !== undefined;
  const again = found ? 'call snapshot without find' : textless ? 'call snapshot without text: false' : 'call snapshot';
  if (refs && !kept && refs.onPage(page.id)) return { page_changes: { page_id: page.id, url: page.url(), note: `You have no full snapshot of this page to compare with, so what changed can’t be told: ${found ? again : 'call snapshot without text: false'} to see it.` } };
  if (!refs || !kept?.lines) return null;
  // A snapshot cut short is no baseline: what it didn't reach would show as new (round 1 of #145). After an outline
  // without text (whole, perhaps), the one cut short is the last full one (round 2 of #247).
  if (kept.cut) return { page_changes: { page_id: page.id, url: page.url(), note: `Your last ${textless || found ? 'full ' : ''}snapshot of this page was cut short, so what changed can’t be told: ${again} to see it.` } };
  const token = randomBytes(12).toString('hex');
  const issuedBefore = refs.issues;
  // A diff's snapshot: kept a while, never in place of the agent's own (pinned).
  const tab = nodeOf(call.browser.store.state, nodeId);
  const read = await page.snapshot(call.scope.agent.id, token, false, false, tab?.kind === 'tab' && frameRefsFor(call.scope, tab as TabNode));
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
  const { lines, refs: lineRefs } = snapshotLinesWithRefs(read, refs.preview(page.id, keys, sids));
  const changes = snapshotDiff(kept.lines, lines);
  if (changes.length > DIFF_MAX_LINES) return { page_changes: { ...of, changed: changes.length, note: `Much of the page changed: ${again} to see it.` } };
  refs.issue(page.id, token, keys, sids, false);
  // The next diff compares with what this one showed; later ranges stay the agent's snapshot's (no outline text built).
  refs.rebase(lines);
  // The refs on its new and changed lines are shown (#208: rule 1), by their ids, never read out of the text, nor a gone
  // line's (round 1 of #263).
  refs.showRefs(page.id, snapshotDiffShown(kept.lines, lines).map((id) => lineRefs.get(id)).filter((r): r is string => r !== undefined));
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
export async function waitForTool(call: Call, args: Record<string, unknown>): Promise<ToolOutput> {
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
export const FIRST_LOOK_MS = 2000;
/** A page that shows nothing yet, said so (never an empty outline or a blank picture as if that were the page). */
export const NOTHING_SHOWN = (again: string) => `The page shows nothing yet (it may still be loading or drawing). ${again} again in a moment.`;
