/**
 * The page snapshot (S18 M2b; docs/decisions/S18-agent-mcp.md, "M2: plan"): an accessibility outline of a tab's main
 * frame, with refs on the elements an agent can act on. Its pure parts: the bounds, the refs (ElementRefs), the outline
 * (snapshotOutline) and the result (snapshotResult). The page script that reads the page is main's
 * (apps/desktop/src/main/control/snapshot.ts); acting on a ref comes in M2c.
 *
 * - **Elements, not pixels.** An agent names an element by its ref (`e14`) from the tab's latest snapshot, never by a
 *   position. A ref is counted per tab and never reused there, so an old one is never taken for another element.
 * - **States, never values.** A text field says `[empty]` or `[filled]`, never what's in it (the page can hold your
 *   data). A password, one-time-code or payment field (forms' `sensitiveField`) gets no ref at all.
 * - **Untrusted.** Names come from the page: cleaned (cleanPageText) and returned as untrusted JSON, like page text.
 */
import { sensitiveField, type AssistantFieldSensitive } from './assistant-forms';
import { ASSISTANT_READ_MAX, cleanPageText, pageIdField } from './control-tools';

// Core compiles without DOM types; URL is a global in Node and every browser.
declare const URL: new (url: string) => { origin: string };

/**
 * At most this many nodes are looked at (elements and text alike), and for at most this long (ms): past either, the
 * outline says so. A snapshot never has more nodes than that, and main keeps no more (cleanSnapshotRead).
 */
export const SNAPSHOT_SCAN = 20_000;
export const SNAPSHOT_SCAN_MS = 150;
/** At most this many refs in one snapshot; elements past it are listed without one, and the outline says so. */
export const SNAPSHOT_MAX_REFS = 2000;
/** Names and text runs are cut to this many characters. */
export const SNAPSHOT_NAME_MAX = 120;
/**
 * Owners whose latest snapshot a page keeps (for M2c's actions): each agent (an outside agent, a chat) keeps its own,
 * so one's snapshot never takes away another's; past this many, the oldest goes.
 */
export const SNAPSHOT_OWNERS = 16;

/** A field's description, as the page script gives it for a text-like element: what sensitiveField needs. */
export interface SnapshotField {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
}

/** One node of the outline, as the page script gives it, in document order. */
export interface SnapshotNode {
  /** How deep in the outline (0 at the top): only nodes with a role nest; plain containers don't. */
  depth: number;
  role: string;
  name: string;
  /** The page script's handle for an element an agent can act on; absent for the rest (headings, lists, text). */
  key?: number;
  /** A heading's level. */
  level?: number;
  /** checked, selected, expanded, pressed, disabled, required, empty, filled… */
  states?: string[];
  /** A select's choice, by its label (left out of the outline for a sensitive one). */
  choice?: string;
  /** For fields (inputs, text areas, selects, any text field): what decides whether it's one Chord never lets an agent touch. */
  field?: SnapshotField;
  /**
   * The page's own id for an element (M2g-1): the same element, the same id, in every snapshot of that document for that
   * agent; a replaced one gets another. Refs are made from it, so an element still there keeps its ref.
   */
  sid?: number;
  /** Its name is what it visibly shows (its own words, a shown label, a button's value): only then found by its name (M2g-1, B3, B-1). */
  seen?: boolean;
}

/** What the page script returns. */
export interface SnapshotRead {
  url: string;
  title: string;
  nodes: SnapshotNode[];
  /** Why it stopped early, if it did. */
  cut: { elements?: boolean; time?: boolean; refs?: boolean };
}

/* ---------- Refs ---------- */

/** What a ref names now: its snapshot's token and the page's key for the element, or why not. */
export type ElementLookup = { ok: true; token: string; key: number } | { ok: false; why: 'unknown' | 'stale' };

/**
 * A tab's element refs: `e1`, `e2`… for the tab, never reused for another element. Only the latest snapshot's are good,
 * and only on the page (page id) it was taken of: one from before a navigation is stale. With the page's element ids
 * (M2g-1: `sid`), an element still there keeps its ref from one snapshot to the next (what an action's diff counts on);
 * a page's ids are numbered above every ref the tab had before it, so no ref ever names another page's element.
 */
/** How many of an agent's snapshots of a page its refs name (the page keeps as many: snapshot.ts' SNAPSHOT_HISTORY). */
export const SNAPSHOT_KEPT = 4;

/** The largest ref number the pattern takes (e and at most 9 digits). */
const REF_MAX = 999_999_999;
/** A page's own ids above this (a million elements one agent saw in one document) get refs in turn instead (N-4). */
const SID_MAX = 1_000_000;

export class ElementRefs {
  private next = 1;
  private current: { pageId: string; token: string; keys: Map<string, number>; pinned: boolean } | null = null;
  /** The page its ids are numbered for, and from where (every ref before it is below). */
  private base: { pageId: string; from: number } | null = null;
  /**
   * The snapshots before the latest, newest first: the agent's own last one (pinned: it read it) until its next, and
   * the last SNAPSHOT_KEPT a diff took (the page keeps the same: snapshot.ts).
   */
  private earlier: { pageId: string; token: string; keys: Map<string, number>; pinned: boolean }[] = [];
  /** The latest snapshot's outline, for its later ranges: served as it was while the page is the same one. */
  private kept: SnapshotOutline | null = null;
  /** The last read made to find an element by its name: its own slot, never in place of a snapshot (S-1). */
  private named: { pageId: string; token: string; keys: Map<string, number> } | null = null;

  /** Keep the latest snapshot's outline (its refs are this table's latest). */
  remember(outline: SnapshotOutline): void {
    this.kept = outline;
  }

  /** The latest outline, if it was taken of this page (a page that moved on, or one with no id, has none). */
  outline(pageId: string): SnapshotOutline | null {
    return pageId && this.kept?.pageId === pageId && this.current?.pageId === pageId ? this.kept : null;
  }

  /**
   * The refs of a new snapshot, for the page's keys, in order. An earlier ref is stale from now on, unless (with the
   * page's ids, `sids`: key → id) its element is in this snapshot too: then it's the same ref.
   */
  issue(pageId: string, token: string, keys: readonly number[], sids?: ReadonlyMap<number, number>, pinned = true): Map<number, string> {
    const { byKey, keyByRef } = this.refsFor(pageId, keys, sids);
    if (this.named && this.named.pageId !== pageId) this.named = null;
    // The one before stays behind it, on the same page: a ref from it still names its element there (M2g-1).
    if (this.current && this.current.pageId === pageId) {
      const kept: typeof this.earlier = [];
      let pinnedKept = pinned;
      let diffs = pinned ? 0 : 1;
      for (const snap of [this.current, ...this.earlier]) {
        if (snap.pinned ? !pinnedKept : diffs < SNAPSHOT_KEPT) {
          kept.push(snap);
          if (snap.pinned) pinnedKept = true;
          else diffs++;
        }
      }
      this.earlier = kept;
    } else this.earlier = [];
    this.current = { pageId, token, keys: keyByRef, pinned };
    return byKey;
  }

  /**
   * The refs of a read made to find an element by its name (M2g-1), numbered as a snapshot's are: in a slot of its
   * own, so it never pushes out the agent's snapshot or a diff's (Neon's round 1 of M2g-1, S-1). The latest only.
   */
  issueNamed(pageId: string, token: string, keys: readonly number[], sids?: ReadonlyMap<number, number>): Map<number, string> {
    const { byKey, keyByRef } = this.refsFor(pageId, keys, sids);
    this.named = { pageId, token, keys: keyByRef };
    return byKey;
  }

  /** Refs for a read's keys, by the page's ids where it has them (the same element, the same ref). */
  private refsFor(pageId: string, keys: readonly number[], sids?: ReadonlyMap<number, number>): { byKey: Map<number, string>; keyByRef: Map<string, number> } {
    const byKey = new Map<number, string>();
    const keyByRef = new Map<string, number>();
    // A new page: numbered from above every ref before it. When too few numbers are left for it (N-4), they start over
    // at 1, and every snapshot before goes (none of their refs resolves again: no old ref names a new element).
    if (pageId && (!this.base || this.base.pageId !== pageId) && this.next + SID_MAX + keys.length > REF_MAX) {
      this.next = 1;
      this.current = null;
      this.earlier = [];
      this.named = null;
      this.kept = null;
    }
    if (sids && pageId && (!this.base || this.base.pageId !== pageId)) this.base = { pageId, from: this.next - 1 };
    const taken = new Set<string>();
    for (const key of keys) {
      if (byKey.has(key)) continue;
      const sid = sids?.get(key);
      let ref: string;
      if (sid !== undefined && this.base && this.base.pageId === pageId && Number.isInteger(sid) && sid > 0 && sid <= SID_MAX) {
        ref = `e${this.base.from + sid}`;
        // Two keys with one id (never from the page's script): the second gets a ref of its own.
        if (taken.has(ref)) ref = `e${this.next++}`;
        else this.next = Math.max(this.next, this.base.from + sid + 1);
      } else ref = `e${this.next++}`;
      taken.add(ref);
      byKey.set(key, ref);
      keyByRef.set(ref, key);
    }
    return { byKey, keyByRef };
  }

  /** What a model's ref names on the page it's on now (`pageId`). */
  resolve(ref: unknown, pageId: string): ElementLookup {
    if (typeof ref !== 'string' || !/^e[1-9][0-9]{0,8}$/.test(ref) || Number(ref.slice(1)) >= this.next) return { ok: false, why: 'unknown' };
    if (!pageId) return { ok: false, why: 'stale' };
    // The latest snapshot first; then the ones kept behind it (an element the page replaced since is found again there);
    // then the last read by name.
    for (const snap of [...(this.current?.pageId === pageId ? [this.current, ...this.earlier] : []), ...(this.named ? [this.named] : [])]) {
      const key = snap.keys.get(ref);
      if (key !== undefined && snap.pageId === pageId) return { ok: true, token: snap.token, key };
    }
    return { ok: false, why: 'stale' };
  }

  /** The page moved on (or the tab went to sleep): every ref is stale. */
  forget(): void {
    this.current = null;
    this.earlier = [];
    this.kept = null;
    this.named = null;
  }
}

/** A snapshot's outline as it was made: what a later range (`start`) is served from, without reading the page again. */
export interface SnapshotOutline {
  pageId: string;
  /** When the snapshot was taken: a later range is as of then. */
  retrievedAt: number;
  url: string;
  title: string;
  text: string;
  refs: number;
  note?: string;
  /** Its lines by the page's ids (snapshotLines), for the diff after the agent's next action (M2g-1). */
  lines?: ReadonlyMap<string, string>;
}

/** What an agent hears for a ref that isn't good (M2c's actions), one sentence each. */
export const ELEMENT_REFUSALS = {
  unknown: (ref: string) => `There’s no element ${ref.slice(0, 12)} in that tab. Call snapshot for the page’s elements.`,
  stale: 'That ref is from an earlier snapshot. Call snapshot again, then use its refs.',
} as const;

/* ---------- The outline ---------- */

/** Words for a field an agent never gets a ref for, in place of one. */
const SENSITIVE_NOTE: Record<AssistantFieldSensitive, string> = {
  password: 'password: the user signs in',
  code: 'one-time code: the user types it',
  payment: 'payment detail: the user fills it',
  identity: 'identity number: the user fills it',
};

/** What cleanPageText strips: most names have none of it, and skip its passes (thousands of names a snapshot). */
const HIDDEN_CHARS = /[\u{E0000}-\u{E007F}\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/u;

const clipName = (text: string): string => {
  const clean = (HIDDEN_CHARS.test(text) ? cleanPageText(text) : text.trim()).replace(/\s+/g, ' ');
  return clean.length > SNAPSHOT_NAME_MAX ? `${clean.slice(0, SNAPSHOT_NAME_MAX - 1)}…` : clean;
};
const quoted = (text: string) => JSON.stringify(text);
const STATE = /^(checked|mixed|selected|expanded|collapsed|pressed|disabled|required|empty|filled|readonly|other-site)$/;

/**
 * The keys that get refs: every keyed node but a field Chord never lets an agent touch (forms' `sensitiveField`). A
 * sensitive field is never given a ref at all, shown or not, so no ref can ever reach it (an agent guessing `e17`).
 */
export function snapshotKeys(read: SnapshotRead): number[] {
  return read.nodes.flatMap((n) => (n.key === undefined || (n.field && sensitiveField(n.field)) ? [] : [n.key]));
}

/**
 * The outline as text (Playwright MCP's indented form): `- role "name" [ref=e3] [checked]`, two spaces a level. `refs`:
 * the refs issued for the read's keys (ElementRefs.issue). A field Chord never lets an agent touch has no ref and
 * says why. Returns the text and how many refs it holds.
 */
/**
 * Runs of rows alike (a list, a table): past ROWS_COLLAPSE of them, the first ROWS_SHOWN are shown and the rest said in
 * one line (the owner, 2026-11-24: as effective, for as few tokens). `find` shows them.
 */
export const ROWS_COLLAPSE = 8;
export const ROWS_SHOWN = 5;

/**
 * The outline's text. With `find`, only the elements whose name has that text (any case), each with the elements it's
 * in; else runs of more than ROWS_COLLAPSE rows alike (each the same roles, the same shape) show their first ROWS_SHOWN.
 */
export function snapshotOutline(read: SnapshotRead, refs: ReadonlyMap<number, string>, opts: { find?: string; whole?: boolean } = {}): { text: string; refs: number; collapsed?: number; lines?: (string | null)[] } {
  const nodes = read.nodes;
  let count = 0;
  const lineOf = (node: SnapshotRead['nodes'][number]): string | null => {
    const depth = Math.max(0, Math.min(40, Math.floor(node.depth)));
    const role = /^[a-z][a-z-]{0,30}$/.test(node.role) ? node.role : 'generic';
    const name = clipName(node.name ?? '');
    const parts = [`${'  '.repeat(depth)}- ${role === 'text' ? 'text:' : role}`];
    if (name) parts.push(quoted(name));
    else if (role === 'text') return null;
    const sensitive = node.field ? sensitiveField(node.field) : null;
    const ref = !sensitive && node.key !== undefined ? refs.get(node.key) : undefined;
    if (ref) {
      parts.push(`[ref=${ref}]`);
      count++;
    }
    if (node.level && node.level >= 1 && node.level <= 6) parts.push(`[level=${node.level}]`);
    for (const state of node.states ?? []) {
      if (!STATE.test(state) || (sensitive && (state === 'empty' || state === 'filled'))) continue;
      // A frame of another site: what's in it can't be read (#112: never an empty node).
      parts.push(state === 'other-site' ? '[contents not accessible: another site]' : `[${state}]`);
    }
    if (node.choice && !sensitive) parts.push(`[choice=${quoted(clipName(node.choice))}]`);
    if (sensitive) parts.push(`[${SENSITIVE_NOTE[sensitive]}]`);
    return parts.join(' ');
  };
  const depthOf = (i: number) => Math.max(0, Math.min(40, Math.floor(nodes[i]!.depth)));
  // Every node's own line, uncollapsed (snapshotLines).
  if (opts.whole) return { text: '', refs: 0, lines: nodes.map((n) => lineOf(n)) };
  const lines: string[] = [];
  // find: the matches, each with the elements it's in (those not shown yet).
  const find = opts.find?.trim().toLowerCase();
  if (find) {
    const path: number[] = [];
    const shown = new Set<number>();
    for (let i = 0; i < nodes.length; i++) {
      const d = depthOf(i);
      while (path.length && depthOf(path[path.length - 1]!) >= d) path.pop();
      if ((nodes[i]!.name ?? '').toLowerCase().includes(find)) {
        for (const a of [...path, i]) {
          if (shown.has(a)) continue;
          shown.add(a);
          const line = lineOf(nodes[a]!);
          if (line) lines.push(line);
        }
      }
      path.push(i);
    }
    return { text: lines.join('\n'), refs: count };
  }
  // Each node's subtree ends where the next node at its depth or above begins.
  const ends: number[] = new Array(nodes.length);
  const open: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    while (open.length && depthOf(open[open.length - 1]!) >= depthOf(i)) ends[open.pop()!] = i;
    open.push(i);
  }
  for (const i of open) ends[i] = nodes.length;
  // A row's shape: its own and its subtree's roles, each at its depth below it (never names: rows alike differ there).
  const shapeOf = (i: number) => {
    const base = depthOf(i);
    const parts: string[] = [];
    for (let k = i; k < ends[i]!; k++) parts.push(`${depthOf(k) - base}:${nodes[k]!.role}`);
    return parts.join(',');
  };
  let collapsed = 0;
  const render = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const d = depthOf(i);
      const shape = shapeOf(i);
      // The run of rows alike from here: siblings (the same depth, one after another) of the same shape.
      const run = [i];
      let k = ends[i]!;
      while (k < to && depthOf(k) === d && shapeOf(k) === shape) {
        run.push(k);
        k = ends[k]!;
      }
      const shownRows = run.length > ROWS_COLLAPSE ? run.slice(0, ROWS_SHOWN) : run;
      for (const r of shownRows) {
        const line = lineOf(nodes[r]!);
        if (line) lines.push(line);
        render(r + 1, ends[r]!);
      }
      if (shownRows.length < run.length) {
        const more = run.length - shownRows.length;
        collapsed += more;
        const role = /^[a-z][a-z-]{0,30}$/.test(nodes[i]!.role) ? nodes[i]!.role : 'generic';
        lines.push(`${'  '.repeat(d)}- … ${more} more ${role === 'text' ? 'lines' : role} like these (call snapshot with find to see one by its name)`);
      }
      i = k;
    }
  };
  render(0, nodes.length);
  return { text: lines.join('\n'), refs: count, ...(collapsed ? { collapsed } : {}) };
}

/**
 * The outline's lines by what they show (M2g-1: the diff after an action): an element by the page's id for it, a text by
 * the element it's in and its place there; each line as the outline gives it, without its indent.
 */
export function snapshotLines(read: SnapshotRead, refs: ReadonlyMap<number, string>): Map<string, string> {
  const lines = new Map<string, string>();
  const text = snapshotOutline({ ...read, nodes: read.nodes }, refs, { whole: true }).lines!;
  const parents: { depth: number; id: string }[] = [];
  const texts = new Map<string, number>();
  read.nodes.forEach((node, i) => {
    const line = text[i];
    while (parents.length && parents[parents.length - 1]!.depth >= node.depth) parents.pop();
    const parent = parents.length ? parents[parents.length - 1]!.id : 'top';
    let id: string;
    if (node.sid !== undefined) id = `s${node.sid}`;
    else {
      const k = (texts.get(parent) ?? 0) + 1;
      texts.set(parent, k);
      id = `${parent}/${node.role}${k}`;
    }
    if (node.sid !== undefined) parents.push({ depth: node.depth, id });
    if (line !== null && line !== undefined && !lines.has(id)) lines.set(id, line.trimStart());
  });
  return lines;
}

/** What changed between two outlines' lines (snapshotLines): new ones (+), changed ones as they are now (~), gone ones (-). */
export function snapshotDiff(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [id, line] of after) {
    const was = before.get(id);
    if (was === undefined) out.push(`+ ${line}`);
    else if (was !== line) out.push(`~ ${line}`);
  }
  for (const [id, line] of before) if (!after.has(id)) out.push(`- ${line}`);
  return out;
}

/** Chord's note on what the snapshot left out, if anything. */
export function snapshotNote(cut: SnapshotRead['cut']): string | undefined {
  const notes = [
    cut.elements || cut.time ? 'The page is too big to read whole in one snapshot: this is its start.' : '',
    cut.refs ? `Only the first ${SNAPSHOT_MAX_REFS} elements that can be acted on have refs.` : '',
  ].filter(Boolean);
  return notes.length ? notes.join(' ') : undefined;
}

/**
 * The snapshot as a tool result: untrusted JSON with provenance (as pageResult), its outline in ranges of
 * ASSISTANT_READ_MAX characters (`start` to continue), cut at a line.
 */
export function snapshotResult(snap: { ref: string; url: string; title: string; outline: string; refs: number; start?: number; retrievedAt: number; pageId?: string; note?: string }): string {
  const total = snap.outline.length;
  let start = Math.max(0, Math.min(Math.floor(snap.start ?? 0), total));
  // A range starts at a line (a start inside one moves back to its beginning) and ends at one. At or past the end it's
  // empty: never the last line again.
  if (start > 0 && start < total && snap.outline[start - 1] !== '\n') start = snap.outline.lastIndexOf('\n', start) + 1;
  let end = Math.min(total, start + ASSISTANT_READ_MAX);
  if (end < total) {
    const cut = snap.outline.lastIndexOf('\n', end);
    if (cut > start) end = cut + 1;
  }
  let origin = '';
  try {
    origin = new URL(snap.url).origin;
  } catch {
    // Not an address: no origin.
  }
  return JSON.stringify({
    source: 'web_snapshot',
    tab_id: snap.ref,
    ...pageIdField(snap.pageId),
    origin,
    url: snap.url,
    title: clipName(snap.title),
    retrieved_at: new Date(snap.retrievedAt).toISOString(),
    trust: 'untrusted',
    refs: snap.refs,
    range: { start, end, total },
    ...(snap.note ? { note: snap.note } : {}),
    content: snap.outline.slice(start, end),
  });
}

/** The page script's answer, kept to what it can be: anything else is no read. */
export function cleanSnapshotRead(raw: unknown): SnapshotRead | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['url'] !== 'string' || !Array.isArray(r['nodes'])) return null;
  const nodes: SnapshotNode[] = [];
  const keys = new Set<number>();
  // No more nodes than the script looks at: a page that answered with more is cut, before anything is done with them.
  for (const n of (r['nodes'] as Record<string, unknown>[]).slice(0, SNAPSHOT_SCAN)) {
    if (!n || typeof n !== 'object' || typeof n['role'] !== 'string' || typeof n['depth'] !== 'number') continue;
    const node: SnapshotNode = { depth: n['depth'], role: n['role'], name: typeof n['name'] === 'string' ? n['name'].slice(0, 2000) : '' };
    // A key is a whole number, at most once in a read, at most SNAPSHOT_MAX_REFS of them.
    if (typeof n['key'] === 'number' && Number.isInteger(n['key']) && n['key'] >= 0 && !keys.has(n['key']) && keys.size < SNAPSHOT_MAX_REFS) {
      node.key = n['key'];
      keys.add(n['key']);
    }
    if (typeof n['level'] === 'number') node.level = n['level'];
    if (Array.isArray(n['states'])) node.states = (n['states'] as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 8);
    if (typeof n['choice'] === 'string') node.choice = n['choice'].slice(0, 2000);
    if (typeof n['sid'] === 'number' && Number.isInteger(n['sid']) && n['sid'] > 0 && n['sid'] < 1e8) node.sid = n['sid'];
    if (n['seen'] === true) node.seen = true;
    const f = n['field'] as Record<string, unknown> | undefined;
    if (f && typeof f === 'object') {
      const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).slice(0, 200) : '');
      node.field = { type: s('type'), autocomplete: s('autocomplete'), name: s('name'), id: s('id'), label: s('label'), placeholder: s('placeholder') };
    }
    nodes.push(node);
  }
  const cut = (r['cut'] && typeof r['cut'] === 'object' ? r['cut'] : {}) as Record<string, unknown>;
  return {
    url: r['url'],
    title: typeof r['title'] === 'string' ? r['title'].slice(0, 2000) : '',
    nodes,
    cut: { ...(cut['elements'] === true ? { elements: true } : {}), ...(cut['time'] === true ? { time: true } : {}), ...(cut['refs'] === true ? { refs: true } : {}) },
  };
}
