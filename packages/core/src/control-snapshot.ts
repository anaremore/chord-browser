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
   * A part of the page read by its container ref (S18 M2g-2, #207): its place in the read's list of them (regions,
   * articles, landmarks, forms, tables). Its ref is `c` and its page id: read-only, only read_tab takes it.
   */
  box?: number;
  /**
   * The page's own id for an element (M2g-1): the same element, the same id, in every snapshot of that document for that
   * agent; a replaced one gets another. Refs are made from it, so an element still there keeps its ref.
   */
  sid?: number;
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
  /**
   * The latest FULL snapshot's outline: its later ranges (served as it was while the page is the same one), and the next
   * diff's baseline (its lines).
   */
  private kept: SnapshotOutline | null = null;
  /**
   * The latest outline without the page's text, when it's the tab's latest own read (#205, round 1 of #247): its later
   * ranges alone, as it was. Never a baseline (no lines): plan rule 1.
   */
  private textless: SnapshotOutline | null = null;
  private issued = 0;
  /**
   * The container refs of the agent's latest own snapshot (#207), in their own table: never an element ref's. Each names
   * its part in that snapshot's read (the page keeps it until the agent's next), as the outline showed it.
   */
  private boxes: { pageId: string; token: string; byRef: ReadonlyMap<string, ShownBox> } | null = null;

  /**
   * The container refs of a read's parts (round 1 of #260): numbered as element refs are, from the page's own ids above
   * every ref the tab had before this page, so a part's ref from another page never names one of this page (the page's
   * ids start over with each document). Only for the page its refs were just issued for (`issue` with its ids).
   */
  boxRefsFor(pageId: string, boxSids: ReadonlyMap<number, number>): Map<number, string> {
    const out = new Map<number, string>();
    if (!pageId || !this.base || this.base.pageId !== pageId) return out;
    for (const [box, sid] of boxSids) {
      if (!Number.isInteger(sid) || sid <= 0 || sid > SID_MAX) continue;
      const n = this.base.from + sid;
      out.set(box, `c${n}`);
      this.next = Math.max(this.next, n + 1);
    }
    return out;
  }

  /**
   * The element refs the agent was shown on this page (S18 M2g-2, #208; plan rule 1): only these are acted on. Refs are
   * still issued for every element (numbered by the page's ids, so none is ever rebound), but one on a line the agent was
   * never shown (a collapsed run's row, a line past the range it read, an element a find didn't list) is never acted on:
   * the acting tools ask `wasShown`. Gathered from each answer's own text, on the page it's of; another page starts over.
   */
  private shown: { pageId: string; refs: Set<string> } | null = null;

  /**
   * The element refs on the lines an answer showed, for this page: given by the outline itself (each line's own element,
   * `lineRefs` within the answer's range) and a diff's new and changed lines (by their ids), never read out of the text,
   * where a page's own words could say anything (round 1 of #263).
   */
  showRefs(pageId: string, refs: Iterable<string>): void {
    if (!pageId) return;
    if (!this.shown || this.shown.pageId !== pageId) this.shown = { pageId, refs: new Set() };
    for (const ref of refs) this.shown.refs.add(ref);
  }

  /** The page whose latest own read was a flat find (round 1 of #263): a diff's notes then say to snapshot without it. */
  private found: string | null = null;
  markFind(pageId: string): void {
    this.found = pageId || null;
  }
  lastWasFind(pageId: string): boolean {
    return Boolean(pageId) && this.found === pageId && this.current?.pageId === pageId;
  }

  /** Whether the agent was shown this ref on this page (#208): an acting tool's check before `resolve`. */
  wasShown(ref: unknown, pageId: string): boolean {
    return typeof ref === 'string' && Boolean(pageId) && this.shown?.pageId === pageId && this.shown.refs.has(ref);
  }

  /** The container refs an outline showed (#207): this page's, under its read's token, in place of the last ones. */
  issueBoxes(pageId: string, token: string, shown: ReadonlyMap<string, ShownBox>): void {
    this.boxes = pageId ? { pageId, token, byRef: new Map(shown) } : null;
  }

  /** What a container ref names on the page it's on now: its read's token and its part, or why not. */
  resolveBox(ref: unknown, pageId: string): ({ ok: true; token: string } & ShownBox) | { ok: false; why: 'unknown' | 'stale' } {
    if (typeof ref !== 'string' || !BOX_REF.test(ref)) return { ok: false, why: 'unknown' };
    const shown = this.boxes?.byRef.get(ref);
    if (!shown || !this.boxes) return { ok: false, why: 'unknown' };
    if (!pageId || this.boxes.pageId !== pageId) return { ok: false, why: 'stale' };
    return { ok: true, token: this.boxes.token, ...shown };
  }
  /** How many snapshots' refs were issued (round 1 of #247): a diff whose read was out while another landed gives way. */
  get issues(): number {
    return this.issued;
  }

  /** Keep the latest FULL snapshot's outline (its refs are this table's latest), and the agent's latest read is it. */
  remember(outline: SnapshotOutline): void {
    this.kept = outline;
    this.textless = null;
    this.found = null;
  }

  /** Keep an outline without the page's text for its later ranges: the agent's latest own read (never a baseline). */
  rememberTextless(outline: SnapshotOutline): void {
    const { lines: _lines, ...shown } = outline;
    this.textless = shown;
    this.found = null;
  }

  /** The outline without text kept for this page, if the agent's latest own read of it was one. */
  textlessOutline(pageId: string): SnapshotOutline | null {
    return pageId && this.textless?.pageId === pageId && this.current?.pageId === pageId ? this.textless : null;
  }

  /**
   * A shown diff's lines as the next diff's baseline (M2g-1), leaving the outline the agent read for its later ranges
   * (round 1 of #145: `start` pages through what the agent read, never a diff's whole read).
   */
  rebase(lines: ReadonlyMap<string, string>): void {
    if (this.kept) this.kept = { ...this.kept, lines };
  }

  /** The latest FULL outline, if it was taken of this page (a page that moved on, or one with no id, has none). */
  outline(pageId: string): SnapshotOutline | null {
    return pageId && this.kept?.pageId === pageId && this.current?.pageId === pageId ? this.kept : null;
  }

  /**
   * The refs of a new snapshot, for the page's keys, in order. An earlier ref is stale from now on, unless (with the
   * page's ids, `sids`: key → id) its element is in this snapshot too: then it's the same ref.
   */
  issue(pageId: string, token: string, keys: readonly number[], sids?: ReadonlyMap<number, number>, pinned = true): Map<number, string> {
    const { byKey, keyByRef } = this.refsFor(pageId, keys, sids);
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
    this.issued++;
    return byKey;
  }

  /**
   * The refs `issue` would give a read, without issuing them (round 1 of #145, B1): a diff that won't be shown (too
   * big) is never taken as seen. Nothing changes here; `issue` with the same read gives the same refs.
   */
  preview(pageId: string, keys: readonly number[], sids?: ReadonlyMap<number, number>): Map<number, string> {
    const saved = { next: this.next, base: this.base, current: this.current, earlier: this.earlier, kept: this.kept, textless: this.textless, issued: this.issued, boxes: this.boxes, shown: this.shown };
    try {
      return this.refsFor(pageId, keys, sids).byKey;
    } finally {
      Object.assign(this, saved);
    }
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
      this.kept = null;
      this.textless = null;
      this.boxes = null;
      this.shown = null;
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
      } else {
        // In turn, above every number the page's ids can map to (round 2 of #145): never one a later id of it takes.
        if (sid !== undefined && this.base && this.base.pageId === pageId) this.next = Math.max(this.next, this.base.from + SID_MAX + 1);
        ref = `e${this.next++}`;
      }
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
    // The latest snapshot first; then the ones kept behind it (an element the page replaced since is found again there).
    for (const snap of this.current?.pageId === pageId ? [this.current, ...this.earlier] : []) {
      const key = snap.keys.get(ref);
      if (key !== undefined && snap.pageId === pageId) return { ok: true, token: snap.token, key };
    }
    return { ok: false, why: 'stale' };
  }

  /**
   * Whether this table's latest refs are of this page (S18 M2g-2 slice 3b, #205): with no outline kept for it, they came
   * from a view that's no baseline (an outline without the page's text), so what an action changed can't be told.
   */
  onPage(pageId: string): boolean {
    return Boolean(pageId) && this.current?.pageId === pageId;
  }

  /** The page moved on (or the tab went to sleep): every ref is stale. */
  forget(): void {
    this.current = null;
    this.earlier = [];
    this.kept = null;
    this.textless = null;
    this.boxes = null;
    this.shown = null;
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
  /** Each line's element ref and where it starts (round 1 of #263): a later range shows its own. */
  lineRefs?: readonly LineRef[];
  /** Its lines by the page's ids (snapshotLines), for the diff after the agent's next action (M2g-1). */
  lines?: ReadonlyMap<string, string>;
  /** The read was cut short (too many elements, refs, or too slow): no baseline for a diff (round 1 of #145). */
  cut?: boolean;
}

/** What an agent hears for a ref that isn't good (M2c's actions), one sentence each. */
export const ELEMENT_REFUSALS = {
  unknown: (ref: string) => `There’s no element ${ref.slice(0, 12)} in that tab. Call snapshot for the page’s elements.`,
  stale: 'That ref is from an earlier snapshot. Call snapshot again, then use its refs.',
  // A ref on no line the agent was shown (#208; round 1 of #263): where to get it.
  notShown: (ref: string) => `You weren’t shown ${ref.slice(0, 12)} on this page: a snapshot shows it, or find with its words.`,
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
 * `text: false` (S18 M2g-2 slice 3b, #205): the page's structure without its text runs (`- text:` lines), which carry no
 * ref: the full outline, its rows collapsed as they'd be, less its text lines (never a run the text kept apart, such as
 * headings between paragraphs, collapsed when the text goes).
 */
export function snapshotOutline(read: SnapshotRead, refs: ReadonlyMap<number, string>, opts: { find?: string; whole?: boolean; text?: boolean; boxes?: ReadonlyMap<number, string>; flat?: boolean } = {}): { text: string; refs: number; collapsed?: number; lines?: (string | null)[]; boxes?: Map<string, ShownBox>; matched?: number; nearest?: boolean; lineRefs: LineRef[] } {
  const nodes = read.nodes;
  const noText = opts.text === false;
  let count = 0;
  // Container refs (#207), on the lines shown: only those enter the agent's table of them.
  const shownBoxes = new Map<string, ShownBox>();
  const lineOf = (node: SnapshotRead['nodes'][number]): string | null => {
    if (noText && node.role === 'text') return null;
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
    } else if (opts.boxes && node.box !== undefined && opts.boxes.has(node.box)) {
      const box = opts.boxes.get(node.box)!;
      parts.push(`[ref=${box}]`);
      shownBoxes.set(box, { box: node.box });
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
  if (opts.whole) return { text: '', refs: 0, lines: nodes.map((n) => lineOf(n)), lineRefs: [] };
  const lines: string[] = [];
  // Each line's own node (-1 for Chord's: a run said in one line, how many more): its ref, structurally (round 1 of #263).
  const emitted: number[] = [];
  const emit = (line: string, i: number) => {
    lines.push(line);
    emitted.push(i);
  };
  const refOfNode = (i: number): string | undefined => {
    const n = nodes[i];
    if (!n || n.key === undefined || (n.field && sensitiveField(n.field))) return undefined;
    return refs.get(n.key);
  };
  const lineRefs = (): LineRef[] => {
    const out: LineRef[] = [];
    let at = 0;
    lines.forEach((line, k) => {
      const ref = emitted[k]! >= 0 ? refOfNode(emitted[k]!) : undefined;
      if (ref) out.push({ at, ref });
      at += line.length + 1;
    });
    return out;
  };
  // find: the matches, each with the elements it's in (those not shown yet).
  const find = opts.find?.trim().toLowerCase();
  // find, flat (S18 M2g-2, #208): at most FIND_MAX matches, one line each with the item it's in; none, the nearest names.
  if (find && opts.flat) {
    const out = flatFind(nodes, find, noText, (i) => lineOf(nodes[i]!), depthOf);
    out.lines.forEach((line, k) => emit(line, out.nodes[k]!));
    return { text: lines.join('\n'), refs: count, matched: out.matched, ...(out.nearest ? { nearest: true } : {}), ...(shownBoxes.size ? { boxes: shownBoxes } : {}), lineRefs: lineRefs() };
  }
  if (find) {
    const path: number[] = [];
    const shown = new Set<number>();
    for (let i = 0; i < nodes.length; i++) {
      const d = depthOf(i);
      while (path.length && depthOf(path[path.length - 1]!) >= d) path.pop();
      // Without the page's text, a text run is never a match (its words aren't shown).
      if (!(noText && nodes[i]!.role === 'text') && (nodes[i]!.name ?? '').toLowerCase().includes(find)) {
        for (const a of [...path, i]) {
          if (shown.has(a)) continue;
          shown.add(a);
          const line = lineOf(nodes[a]!);
          if (line) emit(line, a);
        }
      }
      path.push(i);
    }
    return { text: lines.join('\n'), refs: count, ...(shownBoxes.size ? { boxes: shownBoxes } : {}), lineRefs: lineRefs() };
  }
  // Each node's subtree ends where the next node at its depth or above begins.
  const ends: number[] = new Array(nodes.length);
  const open: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    while (open.length && depthOf(open[open.length - 1]!) >= depthOf(i)) ends[open.pop()!] = i;
    open.push(i);
  }
  for (const i of open) ends[i] = nodes.length;
  // A row's shape: its own and its subtree's roles and states, each at its depth below it (never names: rows alike
  // differ there; states do count, so a checked or disabled row is never hidden in a run: round 1 of #145). Made only
  // when a row has a next sibling of the same subtree size (round 1 of #145, SF4: it was made for every node, the page's
  // top ones whole, at every level).
  const shapeOf = (i: number) => {
    const base = depthOf(i);
    const parts: string[] = [];
    for (let k = i; k < ends[i]!; k++) parts.push(`${depthOf(k) - base}:${nodes[k]!.role}${nodes[k]!.states?.length ? `[${nodes[k]!.states!.join(' ')}]` : ''}`);
    return parts.join(',');
  };
  let collapsed = 0;
  const render = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const d = depthOf(i);
      // The run of rows alike from here: siblings (the same depth, one after another) of the same shape. A node with no
      // next sibling has no run, and no shape is made for it.
      const run = [i];
      let k = ends[i]!;
      const size = ends[i]! - i;
      let shape: string | undefined;
      while (k < to && depthOf(k) === d && ends[k]! - k === size && (shape ??= shapeOf(i)) === shapeOf(k)) {
        run.push(k);
        k = ends[k]!;
      }
      const shownRows = run.length > ROWS_COLLAPSE ? run.slice(0, ROWS_SHOWN) : run;
      for (const r of shownRows) {
        const line = lineOf(nodes[r]!);
        if (line) emit(line, r);
        render(r + 1, ends[r]!);
      }
      // A run of text said in one line goes with the text.
      if (shownRows.length < run.length && !(noText && nodes[i]!.role === 'text')) {
        const more = run.length - shownRows.length;
        collapsed += more;
        const role = /^[a-z][a-z-]{0,30}$/.test(nodes[i]!.role) ? nodes[i]!.role : 'generic';
        emit(`${'  '.repeat(d)}- … ${more} more ${role === 'text' ? 'lines' : role} like these (call snapshot with find to see one by its name)`, -1);
      }
      i = k;
    }
  };
  render(0, nodes.length);
  return { text: lines.join('\n'), refs: count, ...(collapsed ? { collapsed } : {}), ...(shownBoxes.size ? { boxes: shownBoxes } : {}), lineRefs: lineRefs() };
}

/** An outline line's element ref and where the line starts in the outline's text (round 1 of #263). */
export interface LineRef {
  at: number;
  ref: string;
}

/** The refs on the lines within an answer's range of its outline ([start, end)): the lines it showed. */
export const refsInRange = (lineRefs: readonly LineRef[], range: { start: number; end: number }): string[] => lineRefs.filter((l) => l.at >= range.start && l.at < range.end).map((l) => l.ref);

/** How many matches a find shows (#208): past it, how many more, and a narrower find. */
export const FIND_MAX = 20;
/** How many nearest names a find with no match shows (#208). */
export const FIND_NEAREST = 5;
/** The roles an element's item is (the outline's names for them, as the page's itemsOf reads them). */
const FIND_ITEMS = new Set(['row', 'listitem', 'article', 'dialog', 'alertdialog', 'tabpanel', 'region']);
/** Words a find's nearest names never count (#208). */
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'with', 'from', 'is', 'it', 'this', 'that', 'my', 'your', 'our']);
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** How long an unnamed item's label from its contents may be (round 1 of #263). */
const ITEM_LABEL_MAX = 60;
/** How many nodes of an unnamed item's subtree its label looks at, at most (round 2 of #263: never a whole subtree). */
const ITEM_LABEL_SCAN = 40;

/**
 * A flat find (#208; rounds 1 and 2 of #263). A node matches when its own name has the whole query in it (any case; with
 * its spaces left out too: "signin" finds "Sign in"), or every one of the query's words is in its own name or its item's:
 * a word with a digit only as a whole word ("Cancel 150" never finds order 1500, "Cancel 1" never order 10), any other
 * word inside its own name ("Canc" finds Cancel) or as a whole word of its item's. Ranked: every word its own first,
 * then some, then its item's alone; the page's order within each. Capped at FIND_MAX first, and only the lines shown are
 * built (building one counts its ref and gives its part's c ref). Each the outline's own line, unindented, with the item
 * it's in: its nearest row, list item, article, dialog, tab panel or region, by its name, else (unnamed, the common case: a
 * plain tr, li or article) a label from its own contents: its first heading's name, else its texts (with the page's text)
 * and link names in the page's order, joined and clipped ("Order 150 Jane Doe Details"). Past FIND_MAX, how many more,
 * and (when they have items) to narrow by an item's words. None: the nearest names, by words in common with their own and
 * their item's (stop-words left out), at most FIND_NEAREST. Never an unnamed node, nor a text run without the page's text.
 */
function flatFind(nodes: SnapshotRead['nodes'], find: string, noText: boolean, lineOf: (i: number) => string | null, depthOf: (i: number) => number): { lines: string[]; nodes: number[]; matched: number; nearest: boolean } {
  const words = wordsOf(find);
  const compact = (s: string) => s.replace(/\s+/g, '');
  const nameOf = (i: number) => clipName(nodes[i]!.name ?? '');
  // Each item's label: its name, else from its own contents (at most ITEM_LABEL_SCAN nodes below it).
  const labelOf = (i: number): string => {
    const own = nameOf(i);
    if (own) return own;
    const d = depthOf(i);
    const parts: string[] = [];
    let length = 0;
    for (let k = i + 1, seen = 0; k < nodes.length && depthOf(k) > d && seen < ITEM_LABEL_SCAN && length < ITEM_LABEL_MAX; k++, seen++) {
      const n = nodes[k]!;
      const name = nameOf(k);
      if (!name) continue;
      // Its first heading names it, whatever came before.
      if (n.role === 'heading') return name.length > ITEM_LABEL_MAX ? `${name.slice(0, ITEM_LABEL_MAX - 1)}…` : name;
      if (n.role === 'link' || (n.role === 'text' && !noText)) {
        parts.push(name);
        length += name.length + 1;
      }
    }
    const label = parts.join(' ');
    return label.length > ITEM_LABEL_MAX ? `${label.slice(0, ITEM_LABEL_MAX - 1)}…` : label;
  };
  const labels = new Map<number, string>();
  const label = (i: number) => {
    if (!labels.has(i)) labels.set(i, labelOf(i));
    return labels.get(i)!;
  };
  // Each item's label in lower case, once.
  const lowered = new Map<number, string>();
  const labelLower = (i: number) => {
    if (!lowered.has(i)) lowered.set(i, label(i).toLowerCase());
    return lowered.get(i)!;
  };
  // Each item's words, once (round 2 of #263).
  const itemWords = new Map<number, Set<string>>();
  const wordsOfItem = (i: number) => {
    if (!itemWords.has(i)) itemWords.set(i, new Set(wordsOf(label(i))));
    return itemWords.get(i)!;
  };
  const path: number[] = [];
  const itemOf: (number | null)[] = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const d = depthOf(i);
    while (path.length && depthOf(path[path.length - 1]!) >= d) path.pop();
    let item: number | null = null;
    for (let k = path.length - 1; k >= 0; k--) {
      if (FIND_ITEMS.has(nodes[path[k]!]!.role) && label(path[k]!)) { item = path[k]!; break; }
    }
    itemOf[i] = item;
    path.push(i);
  }
  const withItem = (i: number): string | null => {
    const line = lineOf(i);
    if (line === null) return null;
    const item = itemOf[i];
    return `- ${line.trimStart().slice(2)}${item !== null && item !== undefined ? ` (in ${nodes[item]!.role} ${JSON.stringify(label(item))})` : ''}`;
  };
  const hasDigit = (w: string) => /\p{N}/u.test(w);
  // [node, rank]: 0 every word its own, 1 some, 2 its item's alone.
  const found: [number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (noText && n.role === 'text') continue;
    // Never an unnamed node, nor an empty text: its name as the outline gives it (clipped).
    const name = nameOf(i).toLowerCase();
    if (!name) continue;
    if (name.includes(find) || compact(name).includes(compact(find))) {
      // Every word a whole word of its own first ("Act 1" before "Act 150").
      found.push([i, words.length && words.every((w) => wordsOf(name).includes(w)) ? 0 : 1]);
      continue;
    }
    if (!words.length) continue;
    const item = itemOf[i];
    // A cheap look first (round 2 of #263): each word somewhere in its name or its item's, else no words are made.
    const hay = item !== null && item !== undefined ? `${name} ${labelLower(item)}` : name;
    if (!words.every((w) => hay.includes(w))) continue;
    const ownWords = new Set(wordsOf(name));
    const theirs = item !== null && item !== undefined ? wordsOfItem(item) : new Set<string>();
    const mine = (w: string) => ownWords.has(w) || (!hasDigit(w) && name.includes(w));
    if (!words.every((w) => mine(w) || theirs.has(w))) continue;
    const own = words.filter(mine).length;
    found.push([i, own === words.length ? 0 : own > 0 ? 1 : 2]);
  }
  found.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  // Every match has a line (unnamed nodes, and text without the page's text, never match), so the cap comes first and only
  // the lines shown are built: building one counts its ref and gives its part's c ref (round 1 of #263).
  const all = found.map(([i]) => i);
  const shown = all.slice(0, FIND_MAX).map((i) => [i, withItem(i)] as const).filter((x): x is readonly [number, string] => x[1] !== null);
  const lines = shown.map(([, l]) => l);
  const lineNodes = shown.map(([i]) => i);
  if (all.length > FIND_MAX) {
    const more = all.length - FIND_MAX;
    const items = all.some((i) => itemOf[i] !== null && itemOf[i] !== undefined);
    lines.push(`- … ${more} more match${more === 1 ? '' : 'es'}: make find narrower${items ? ' (an item’s words help: Cancel 150)' : ''}`);
    lineNodes.push(-1);
  }
  if (all.length) return { lines, nodes: lineNodes, matched: all.length, nearest: false };
  // The nearest names: the most words in common with the query's (stop-words left out), in their own names and their
  // items' (round 2 of #263: "Refund 150" finds order 150's), the page's order on ties.
  const wanted = new Set(words.filter((w) => !STOP_WORDS.has(w)));
  if (!wanted.size) return { lines: [], nodes: [], matched: 0, nearest: false };
  const scored: [number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const name = nameOf(i);
    if (n.role === 'text' || !name) continue;
    const item = itemOf[i];
    const theirs = item !== null && item !== undefined ? wordsOfItem(item) : new Set<string>();
    const common = new Set([...wordsOf(name), ...theirs].filter((w) => wanted.has(w))).size;
    if (common) scored.push([i, common]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const near = scored.slice(0, FIND_NEAREST).map(([i]) => [i, withItem(i)] as const).filter((x): x is readonly [number, string] => x[1] !== null);
  return { lines: near.map(([, l]) => l), nodes: near.map(([i]) => i), matched: 0, nearest: near.length > 0 };
}

/** A container ref's part (#207): its place in the read (the page checks its role and name again before reading it). */
export interface ShownBox {
  box: number;
}

/** A container ref (#207): `c` and the part's page id. Never an element's (`e`): read_tab alone takes it. */
export const BOX_REF = /^c[1-9][0-9]{0,8}$/;

/**
 * The outline's lines by what they show (M2g-1: the diff after an action): an element by the page's id for it, a text by
 * the element it's in and its place there; each line as the outline gives it, without its indent.
 */
export function snapshotLines(read: SnapshotRead, refs: ReadonlyMap<number, string>): Map<string, string> {
  return snapshotLinesWithRefs(read, refs).lines;
}

/**
 * snapshotLines, with each line's element ref by its id (round 1 of #263): a diff's new and changed lines show their
 * refs by these, never by reading the line's text.
 */
export function snapshotLinesWithRefs(read: SnapshotRead, refs: ReadonlyMap<number, string>): { lines: Map<string, string>; refs: Map<string, string> } {
  const lines = new Map<string, string>();
  const byId = new Map<string, string>();
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
    if (line !== null && line !== undefined && !lines.has(id)) {
      lines.set(id, line.trimStart());
      const ref = node.key !== undefined && !(node.field && sensitiveField(node.field)) ? refs.get(node.key) : undefined;
      if (ref) byId.set(id, ref);
    }
  });
  return { lines, refs: byId };
}

/** A diff's new and changed lines' ids (round 1 of #263): the lines it shows that name an element as it is now. */
export function snapshotDiffShown(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [id, line] of after) if (before.get(id) !== line) out.push(id);
  return out;
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
/**
 * The range of an outline an answer gives from `start` (ASSISTANT_READ_MAX at most): it starts at a line (a start inside
 * one moves back to its beginning) and ends at one. At or past the end it's empty: never the last line again. Shared by
 * snapshotResult and what it shows (refsInRange: round 1 of #263).
 */
export function snapshotRange(outline: string, from = 0): { start: number; end: number } {
  const total = outline.length;
  let start = Math.max(0, Math.min(Math.floor(from), total));
  if (start > 0 && start < total && outline[start - 1] !== '\n') start = outline.lastIndexOf('\n', start) + 1;
  let end = Math.min(total, start + ASSISTANT_READ_MAX);
  if (end < total) {
    const cut = outline.lastIndexOf('\n', end);
    if (cut > start) end = cut + 1;
  }
  return { start, end };
}

export function snapshotResult(snap: { ref: string; url: string; title: string; outline: string; refs: number; start?: number; retrievedAt: number; pageId?: string; note?: string }): string {
  const total = snap.outline.length;
  const { start, end } = snapshotRange(snap.outline, snap.start ?? 0);
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
  const boxes = new Set<number>();
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
    // A container's place (#207): a whole number, at most once, at most SNAPSHOT_MAX_REFS of them, with its page id.
    if (typeof n['box'] === 'number' && Number.isInteger(n['box']) && n['box'] >= 0 && node.sid !== undefined && !boxes.has(n['box']) && boxes.size < SNAPSHOT_MAX_REFS) {
      node.box = n['box'];
      boxes.add(n['box']);
    }
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
