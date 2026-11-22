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
 * A tab's element refs: `e1`, `e2`… counted for the tab and never reused. Only the latest snapshot's are good, and
 * only on the page (page id) it was taken of: an older snapshot's, or one from before a navigation, is stale.
 */
export class ElementRefs {
  private next = 1;
  private current: { pageId: string; token: string; keys: Map<string, number> } | null = null;
  /** The latest snapshot's outline, for its later ranges: served as it was while the page is the same one. */
  private kept: SnapshotOutline | null = null;

  /** Keep the latest snapshot's outline (its refs are this table's latest). */
  remember(outline: SnapshotOutline): void {
    this.kept = outline;
  }

  /** The latest outline, if it was taken of this page (a page that moved on, or one with no id, has none). */
  outline(pageId: string): SnapshotOutline | null {
    return pageId && this.kept?.pageId === pageId && this.current?.pageId === pageId ? this.kept : null;
  }

  /** The refs of a new snapshot, for the page's keys, in order. Every earlier ref is stale from now on. */
  issue(pageId: string, token: string, keys: readonly number[]): Map<number, string> {
    const byKey = new Map<number, string>();
    const keyByRef = new Map<string, number>();
    for (const key of keys) {
      if (byKey.has(key)) continue;
      const ref = `e${this.next++}`;
      byKey.set(key, ref);
      keyByRef.set(ref, key);
    }
    this.current = { pageId, token, keys: keyByRef };
    return byKey;
  }

  /** What a model's ref names on the page it's on now (`pageId`). */
  resolve(ref: unknown, pageId: string): ElementLookup {
    if (typeof ref !== 'string' || !/^e[1-9][0-9]{0,8}$/.test(ref) || Number(ref.slice(1)) >= this.next) return { ok: false, why: 'unknown' };
    const key = this.current?.keys.get(ref);
    if (key === undefined || this.current!.pageId !== pageId || !pageId) return { ok: false, why: 'stale' };
    return { ok: true, token: this.current!.token, key };
  }

  /** The page moved on (or the tab went to sleep): every ref is stale. */
  forget(): void {
    this.current = null;
    this.kept = null;
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
const STATE = /^(checked|mixed|selected|expanded|collapsed|pressed|disabled|required|empty|filled|readonly)$/;

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
export function snapshotOutline(read: SnapshotRead, refs: ReadonlyMap<number, string>): { text: string; refs: number } {
  const lines: string[] = [];
  let count = 0;
  for (const node of read.nodes) {
    const depth = Math.max(0, Math.min(40, Math.floor(node.depth)));
    const role = /^[a-z][a-z-]{0,30}$/.test(node.role) ? node.role : 'generic';
    const name = clipName(node.name ?? '');
    const parts = [`${'  '.repeat(depth)}- ${role === 'text' ? 'text:' : role}`];
    if (name) parts.push(quoted(name));
    else if (role === 'text') continue;
    const sensitive = node.field ? sensitiveField(node.field) : null;
    const ref = !sensitive && node.key !== undefined ? refs.get(node.key) : undefined;
    if (ref) {
      parts.push(`[ref=${ref}]`);
      count++;
    }
    if (node.level && node.level >= 1 && node.level <= 6) parts.push(`[level=${node.level}]`);
    for (const state of node.states ?? []) if (STATE.test(state) && !(sensitive && (state === 'empty' || state === 'filled'))) parts.push(`[${state}]`);
    if (node.choice && !sensitive) parts.push(`[choice=${quoted(clipName(node.choice))}]`);
    if (sensitive) parts.push(`[${SENSITIVE_NOTE[sensitive]}]`);
    lines.push(parts.join(' '));
  }
  return { text: lines.join('\n'), refs: count };
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
