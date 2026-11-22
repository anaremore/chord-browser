import { describe, expect, it } from 'vitest';
import {
  agentToolList,
  agentTools,
  agentToolsVersion,
  ASSISTANT_READ_MAX,
  ASSISTANT_TOOLS,
  assistantTools,
  cleanSnapshotRead,
  ElementRefs,
  isActionTool,
  isNeverOffered,
  readNeedsApproval,
  SNAPSHOT_MAX_REFS,
  SNAPSHOT_SCAN,
  snapshotKeys,
  snapshotNote,
  snapshotOutline,
  snapshotResult,
  type SnapshotNode,
  type SnapshotRead,
} from '../src';

describe('Element refs (S18 M2b): per tab, never reused, good only from the latest snapshot of the same page', () => {
  it('issues e1… in order, one per element, and resolves each to its key on that page', () => {
    const refs = new ElementRefs();
    const issued = refs.issue('p1', 'tokA', [4, 7, 4, 9]);
    expect([...issued]).toEqual([
      [4, 'e1'],
      [7, 'e2'],
      [9, 'e3'],
    ]);
    expect(refs.resolve('e2', 'p1')).toEqual({ ok: true, token: 'tokA', key: 7 });
  });

  it('an earlier snapshot’s refs are stale, never another element; numbers go on', () => {
    const refs = new ElementRefs();
    refs.issue('p1', 'tokA', [0, 1]);
    const second = refs.issue('p1', 'tokB', [0, 1]);
    expect([...second.values()]).toEqual(['e3', 'e4']);
    // [ref, the page it's asked on, what it resolves to]
    const table: [unknown, string, ReturnType<ElementRefs['resolve']>][] = [
      ['e1', 'p1', { ok: false, why: 'stale' }],
      ['e2', 'p1', { ok: false, why: 'stale' }],
      ['e3', 'p1', { ok: true, token: 'tokB', key: 0 }],
      // The page moved on: every ref is stale.
      ['e3', 'p2', { ok: false, why: 'stale' }],
      // Never made, or not a ref at all.
      ['e5', 'p1', { ok: false, why: 'unknown' }],
      ['e0', 'p1', { ok: false, why: 'unknown' }],
      ['E3', 'p1', { ok: false, why: 'unknown' }],
      ['e3 ', 'p1', { ok: false, why: 'unknown' }],
      ['a1', 'p1', { ok: false, why: 'unknown' }],
      [3, 'p1', { ok: false, why: 'unknown' }],
      [null, 'p1', { ok: false, why: 'unknown' }],
      ['e99999999999', 'p1', { ok: false, why: 'unknown' }],
    ];
    for (const [ref, page, want] of table) expect(refs.resolve(ref, page), `${String(ref)} on ${page}`).toEqual(want);
  });

  it('refs issued against no page (it moved on during the read) are never good; forget makes all stale', () => {
    const refs = new ElementRefs();
    refs.issue('', 'tok', [0]);
    expect(refs.resolve('e1', '')).toEqual({ ok: false, why: 'stale' });
    refs.issue('p1', 'tok2', [0]);
    refs.forget();
    expect(refs.resolve('e2', 'p1')).toEqual({ ok: false, why: 'stale' });
  });

  it('keeps the latest outline for its later ranges, only while it’s that page’s and its refs are the latest', () => {
    const refs = new ElementRefs();
    const outline = { pageId: 'p1', retrievedAt: 1, url: 'https://x.example/', title: 'X', text: '- link "A" [ref=e1]', refs: 1 };
    refs.issue('p1', 't', [0]);
    refs.remember(outline);
    expect(refs.outline('p1')).toBe(outline);
    expect(refs.outline('p2')).toBeNull();
    expect(refs.outline('')).toBeNull();
    // A page that moved on during the read: its outline is never served again.
    refs.issue('', 't2', [0]);
    refs.remember({ ...outline, pageId: '' });
    expect(refs.outline('')).toBeNull();
    refs.issue('p1', 't3', [0]);
    refs.remember(outline);
    refs.forget();
    expect(refs.outline('p1')).toBeNull();
  });

  it('each tab counts its own', () => {
    const a = new ElementRefs();
    const b = new ElementRefs();
    a.issue('p1', 't', [0, 1]);
    expect([...b.issue('p9', 't', [0]).values()]).toEqual(['e1']);
  });
});

const field = (over: Partial<NonNullable<SnapshotNode['field']>> = {}) => ({ type: 'text', autocomplete: '', name: '', id: '', label: '', placeholder: '', ...over });

describe('The outline', () => {
  const read: SnapshotRead = {
    url: 'https://shop.example/orders',
    title: 'Your orders',
    cut: {},
    nodes: [
      { depth: 0, role: 'banner', name: '' },
      { depth: 1, role: 'link', name: 'Home', key: 0 },
      { depth: 1, role: 'searchbox', name: 'Search orders', key: 1, states: ['filled'], field: field({ type: 'search' }) },
      { depth: 0, role: 'main', name: '' },
      { depth: 1, role: 'heading', name: 'Your orders', level: 1 },
      { depth: 1, role: 'text', name: 'Returns are free within 30 days.' },
      { depth: 1, role: 'button', name: 'Start a return', key: 2 },
      { depth: 1, role: 'checkbox', name: 'Gift receipt', key: 3, states: ['checked', 'required'] },
      { depth: 1, role: 'combobox', name: 'Shipping', key: 4, choice: 'Express' },
      // Never a ref, whatever the page says: a password, a one-time code, a card number.
      { depth: 1, role: 'textbox', name: 'Password', key: 5, states: ['empty'], field: field({ type: 'password' }) },
      { depth: 1, role: 'textbox', name: 'Code', key: 6, states: ['filled'], field: field({ autocomplete: 'one-time-code' }) },
      { depth: 1, role: 'textbox', name: 'Card number', key: 7, field: field({ autocomplete: 'cc-number' }) },
      // A page's odd role, state or name: kept to what an outline can say.
      { depth: 1, role: 'Button<script>', name: 'Odd', key: 8, states: ['focused', 'disabled', 'x]'] },
      { depth: 1, role: 'text', name: '' },
      { depth: 1, role: 'link', name: 'Tag\u{E0041}s\u200Bhidden', key: 9 },
      // Review 1 of #104: a rich-text field described as one (a card number in a contenteditable), and a select whose
      // choice is a card's expiry month: no ref, no choice.
      { depth: 1, role: 'textbox', name: 'Card number', key: 10, states: ['filled'], field: field({ label: 'Card number' }) },
      { depth: 1, role: 'combobox', name: 'Expires', key: 11, choice: '07', field: field({ type: 'select-one', autocomplete: 'cc-exp-month' }) },
    ],
  };
  const table = new ElementRefs();
  const refs = table.issue('p1', 't', snapshotKeys(read));

  it('is Playwright MCP’s indented form, refs only on what may be acted on, states never values', () => {
    const { text, refs: count } = snapshotOutline(read, refs);
    expect(text.split('\n')).toEqual([
      '- banner',
      '  - link "Home" [ref=e1]',
      '  - searchbox "Search orders" [ref=e2] [filled]',
      '- main',
      '  - heading "Your orders" [level=1]',
      '  - text: "Returns are free within 30 days."',
      '  - button "Start a return" [ref=e3]',
      '  - checkbox "Gift receipt" [ref=e4] [checked] [required]',
      '  - combobox "Shipping" [ref=e5] [choice="Express"]',
      '  - textbox "Password" [password: the user signs in]',
      '  - textbox "Code" [one-time code: the user types it]',
      '  - textbox "Card number" [payment detail: the user fills it]',
      '  - generic "Odd" [ref=e6] [disabled]',
      '  - link "Tagshidden" [ref=e7]',
      '  - textbox "Card number" [payment detail: the user fills it]',
      '  - combobox "Expires" [payment detail: the user fills it]',
    ]);
    expect(count).toBe(7);
    // A sensitive field never gets a ref at all: none to show, none to guess (the agents.spec journey found e17 used up).
    expect(snapshotKeys(read)).toEqual([0, 1, 2, 3, 4, 8, 9]);
    expect([...refs.values()]).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
    expect(table.resolve('e8', 'p1')).toEqual({ ok: false, why: 'unknown' });
  });

  it('cuts long names, and says what a cut snapshot left out', () => {
    const long = snapshotOutline({ ...read, nodes: [{ depth: 0, role: 'text', name: 'x'.repeat(500) }] }, new Map());
    expect(long.text).toBe(`- text: "${'x'.repeat(119)}…"`);
    expect(snapshotNote({})).toBeUndefined();
    expect(snapshotNote({ time: true })).toBe('The page is too big to read whole in one snapshot: this is its start.');
    expect(snapshotNote({ elements: true, refs: true })).toBe(`The page is too big to read whole in one snapshot: this is its start. Only the first ${SNAPSHOT_MAX_REFS} elements that can be acted on have refs.`);
  });
});

describe('The result', () => {
  const outline = Array.from({ length: 4000 }, (_, i) => `- link "Item ${i}" [ref=e${i + 1}]`).join('\n');

  it('is untrusted JSON with provenance and ranges that start and end at a line', () => {
    const first = JSON.parse(snapshotResult({ ref: 'a1', url: 'https://shop.example/x?q=1', title: 'Shop', outline, refs: 4000, retrievedAt: 0, pageId: 'p3', note: 'Cut.' })) as Record<string, unknown> & { range: { start: number; end: number; total: number }; content: string };
    expect(first).toMatchObject({ source: 'web_snapshot', tab_id: 'a1', page_id: 'p3', origin: 'https://shop.example', trust: 'untrusted', refs: 4000, note: 'Cut.' });
    expect(first.range.start).toBe(0);
    expect(first.range.end).toBeLessThanOrEqual(ASSISTANT_READ_MAX);
    expect(first.content.endsWith('\n')).toBe(true);
    // Asked to go on from the middle of a line: it starts at that line.
    const next = JSON.parse(snapshotResult({ ref: 'a1', url: 'x', title: '', outline, refs: 4000, retrievedAt: 0, start: first.range.end + 5 })) as { range: { start: number }; content: string; origin: string };
    expect(next.range.start).toBe(first.range.end);
    expect(next.content.startsWith('- link')).toBe(true);
    expect(next.origin).toBe('');
    // At or past the end: empty, never the last line again.
    for (const start of [outline.length, outline.length + 50]) {
      const past = JSON.parse(snapshotResult({ ref: 'a1', url: 'x', title: '', outline, refs: 4000, retrievedAt: 0, start })) as { range: { start: number; end: number }; content: string };
      expect(past).toMatchObject({ range: { start: outline.length, end: outline.length }, content: '' });
    }
  });
});

describe('The page script’s answer, cleaned', () => {
  it('keeps nodes as they can be, and keys once each, at most SNAPSHOT_MAX_REFS', () => {
    const nodes = [
      { depth: 0, role: 'link', name: 'A', key: 0 },
      { depth: 0, role: 'link', name: 'B', key: 0 },
      { depth: 0, role: 'link', name: 'C', key: -1 },
      { depth: 0, role: 'link', name: 'D', key: 1.5 },
      { depth: 'x', role: 'link' },
      { role: 'link' },
      null,
      { depth: 1, role: 'textbox', name: 5, key: 2, states: ['filled', 3], field: { type: 'password', label: 7 } },
      ...Array.from({ length: SNAPSHOT_MAX_REFS + 5 }, (_, i) => ({ depth: 0, role: 'button', name: '', key: 10 + i })),
    ];
    const read = cleanSnapshotRead({ url: 'https://x.example/', title: 9, nodes, cut: { time: true, refs: 'yes' } })!;
    expect(read.title).toBe('');
    expect(read.cut).toEqual({ time: true });
    expect(read.nodes.slice(0, 5)).toEqual([
      { depth: 0, role: 'link', name: 'A', key: 0 },
      { depth: 0, role: 'link', name: 'B' },
      { depth: 0, role: 'link', name: 'C' },
      { depth: 0, role: 'link', name: 'D' },
      { depth: 1, role: 'textbox', name: '', key: 2, states: ['filled'], field: { type: 'password', autocomplete: '', name: '', id: '', label: '', placeholder: '' } },
    ]);
    expect(read.nodes.filter((n) => n.key !== undefined)).toHaveLength(SNAPSHOT_MAX_REFS);
    // No more nodes than the script ever looks at, whatever an answer holds (review 1 of #104).
    const flood = cleanSnapshotRead({ url: 'https://x.example/', nodes: Array.from({ length: SNAPSHOT_SCAN * 3 }, () => ({ depth: 0, role: 'text', name: 'x' })) })!;
    expect(flood.nodes).toHaveLength(SNAPSHOT_SCAN);
    for (const bad of [null, 'x', {}, { url: 1, nodes: [] }, { url: 'x', nodes: 'no' }]) expect(cleanSnapshotRead(bad)).toBeNull();
  });
});

describe('Which builds and front doors offer snapshot', () => {
  it('only a build with M2: the assistant’s and outside agents’ lists, and their fingerprint', () => {
    expect(assistantTools(false)).toBe(ASSISTANT_TOOLS);
    expect(assistantTools(true).map((t) => t.name)).toContain('snapshot');
    expect(agentTools(false).map((t) => t.name)).not.toContain('snapshot');
    expect(agentToolList(true).find((t) => t.name === 'snapshot')).toMatchObject({ annotations: { readOnlyHint: true, openWorldHint: true }, inputSchema: { required: ['tab_id'] } });
    expect(agentToolsVersion(agentToolList(true))).not.toBe(agentToolsVersion(agentToolList(false)));
    expect(isActionTool('snapshot')).toBe(true);
    expect(isActionTool('read_tab')).toBe(false);
    expect(isNeverOffered('snapshot')).toBe(false);
  });

  it('asks like read_tab: under This chord, for a tab in another chord', () => {
    expect(readNeedsApproval({ scope: 'chord', attached: false, sameChord: false, tool: 'snapshot', granted: false })).toBe(true);
    expect(readNeedsApproval({ scope: 'chord', attached: false, sameChord: true, tool: 'snapshot', granted: false })).toBe(false);
  });
});
