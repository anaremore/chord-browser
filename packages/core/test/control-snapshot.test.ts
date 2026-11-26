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
  SNAPSHOT_KEPT,
  snapshotDiff,
  snapshotLines,
  ROWS_COLLAPSE,
  ROWS_SHOWN,
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

  it('an earlier snapshot’s refs are stale once the agent takes another, never another element; numbers go on', () => {
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
    // wait_for is outside agents' alone (Neon's round 1 of M2g-1, B-4): never the assistant's, acting or not.
    expect(assistantTools(true, true).map((t) => t.name)).not.toContain('wait_for');
    expect(assistantTools(true, false).map((t) => t.name)).not.toContain('wait_for');
    expect(agentTools(true).map((t) => t.name)).toContain('wait_for');
  });

  it('asks like read_tab: under This chord, for a tab in another chord', () => {
    expect(readNeedsApproval({ scope: 'chord', attached: false, sameChord: false, tool: 'snapshot', granted: false })).toBe(true);
    expect(readNeedsApproval({ scope: 'chord', attached: false, sameChord: true, tool: 'snapshot', granted: false })).toBe(false);
  });
});

describe('the outline, for as few tokens (the owner, 2026-11-24)', () => {
  /** A list of `rows` rows, each a link, a note and a button; every link and button with a key. */
  const list = (rows: number) => {
    const nodes: SnapshotRead['nodes'] = [{ depth: 0, role: 'main', name: '' }, { depth: 1, role: 'heading', name: 'Rows', level: 1 }, { depth: 1, role: 'list', name: '' }];
    let key = 0;
    for (let i = 0; i < rows; i++) {
      nodes.push({ depth: 2, role: 'listitem', name: '' }, { depth: 3, role: 'link', name: `Row ${i}`, key: key++ }, { depth: 3, role: 'text', name: `Note ${i}` }, { depth: 3, role: 'button', name: `Act ${i}`, key: key++ });
    }
    nodes.push({ depth: 1, role: 'button', name: 'Load more', key });
    return { url: 'https://rows.test/', title: 'Rows', nodes, cut: {} } as SnapshotRead;
  };
  const refsOf = (read: SnapshotRead) => new ElementRefs().issue('p1', 't', snapshotKeys(read));

  it('a run of more than ROWS_COLLAPSE rows alike shows its first ROWS_SHOWN, says how many more, and goes on after it', () => {
    const read = list(300);
    const outline = snapshotOutline(read, refsOf(read));
    const lines = outline.text.split('\n');
    expect(lines.filter((l) => l.trim().startsWith('- listitem'))).toHaveLength(ROWS_SHOWN);
    expect(lines).toContain('    - … 295 more listitem like these (call snapshot with find to see one by its name)');
    // What follows the run is there, with its ref.
    expect(outline.text).toMatch(/- button "Load more" \[ref=e\d+\]$/);
    expect(outline.collapsed).toBe(295);
    // A short list is whole.
    const short = list(ROWS_COLLAPSE);
    expect(snapshotOutline(short, refsOf(short)).text.split('\n').filter((l) => l.trim().startsWith('- listitem'))).toHaveLength(ROWS_COLLAPSE);
  });

  it('a row whose state differs (a checked one, a disabled one) is never hidden in a run of rows alike (round 1 of #145)', () => {
    const read = list(300);
    // Row 200's button is checked: its own row, shown, so the agent sees it.
    const at = read.nodes.findIndex((n) => n.name === 'Act 200');
    read.nodes[at] = { ...read.nodes[at]!, states: ['checked'] };
    const text = snapshotOutline(read, refsOf(read)).text;
    expect(text).toContain('button "Act 200"');
  });

  it('find: only what has the text in its name (any case), with what it’s in, and its ref good', () => {
    const read = list(300);
    const issued = refsOf(read);
    const outline = snapshotOutline(read, issued, { find: 'act 150' });
    expect(outline.text).toBe(['- main', '  - list', '    - listitem', `      - button "Act 150" [ref=${issued.get(301)}]`].join('\n'));
    expect(outline.refs).toBe(1);
  });
});

describe('the outline without the page’s text: snapshot’s text: false (S18 M2g-2 slice 3b, #205)', () => {
  const read = (nodes: SnapshotRead['nodes']): SnapshotRead => ({ url: 'https://pages.test/', title: 'Page', nodes, cut: {} });
  const prose = (depth: number, n: number) => Array.from({ length: n }, (_, i) => ({ depth, role: 'text', name: `Paragraph ${i}: ${'words of the page '.repeat(10)}` }));
  // [the page, its nodes]
  const pages: [string, SnapshotRead][] = [
    ['an article: headings, a region, a link in its text', read([{ depth: 0, role: 'main', name: '' }, { depth: 1, role: 'heading', name: 'The story', level: 1 }, ...prose(1, 3), { depth: 1, role: 'region', name: 'Aside' }, { depth: 2, role: 'heading', name: 'More', level: 2 }, ...prose(2, 2), { depth: 2, role: 'link', name: 'Read on', key: 0, sid: 1 }])],
    ['a form: fields, a password field, a button, a hint', read([{ depth: 0, role: 'form', name: 'Sign up' }, { depth: 1, role: 'textbox', name: 'Email', key: 0, sid: 1, field: field({ type: 'email', label: 'Email' }) }, { depth: 1, role: 'text', name: 'We never share it.' }, { depth: 1, role: 'textbox', name: 'Password', key: 1, sid: 2, field: field({ type: 'password', label: 'Password' }) }, { depth: 1, role: 'button', name: 'Create account', key: 2, sid: 3 }])],
    ['a list of 300 rows, each with a note', read([{ depth: 0, role: 'list', name: '' }, ...Array.from({ length: 300 }, (_, i) => [{ depth: 1, role: 'listitem', name: '' }, { depth: 2, role: 'link', name: `Row ${i}`, key: i, sid: i + 1 }, { depth: 2, role: 'text', name: `Note ${i}` }]).flat()])],
    ['twenty paragraphs in a row, then a button', read([{ depth: 0, role: 'main', name: '' }, ...prose(1, 20), { depth: 1, role: 'button', name: 'Next', key: 0, sid: 1 }])],
    ['nothing but text', read(prose(0, 4))],
    // The 50-section page as the page script gives it: a heading and its paragraph, side by side, fifty times. Without
    // the text, the headings are never a run of rows alike to collapse.
    ['fifty sections, a heading and its paragraph each', read([{ depth: 0, role: 'main', name: '' }, { depth: 1, role: 'heading', name: 'Fifty sections', level: 1 }, ...Array.from({ length: 50 }, (_, i) => [{ depth: 1, role: 'heading', name: `Section ${i + 1}`, level: 2 }, ...prose(1, 1)]).flat()])],
  ];
  /** The full outline's lines less its text runs (and a run of them said in one line). */
  const lessText = (text: string) => text.split('\n').filter((l) => !/^\s*- text:/.test(l) && !/^\s*- … \d+ more lines like these/.test(l)).join('\n');

  it.each(pages)('%s: every line of the full outline but its text, with the same refs', (_page, page) => {
    const refs = new ElementRefs().issue('p1', 't', snapshotKeys(page), new Map(page.nodes.filter((n) => n.key !== undefined).map((n) => [n.key!, n.sid!])));
    const full = snapshotOutline(page, refs);
    const outline = snapshotOutline(page, refs, { text: false });
    expect(outline.text).toBe(lessText(full.text));
    expect(outline.text).not.toMatch(/- text:/);
    expect(outline.refs).toBe(full.refs);
  });

  it('a password field keeps its line and no ref; find looks only at what it shows', () => {
    const [, form] = pages[1]!;
    const refs = new ElementRefs().issue('p1', 't', snapshotKeys(form));
    expect(snapshotOutline(form, refs, { text: false }).text).toContain('- textbox "Password" [password: the user signs in]');
    // A text run's words aren't found; an element's are.
    expect(snapshotOutline(form, refs, { text: false, find: 'never share' }).text).toBe('');
    expect(snapshotOutline(form, refs, { text: false, find: 'create' }).text).toMatch(/^- form "Sign up"\n {2}- button "Create account" \[ref=e\d+\]$/);
  });
});

describe('refs that stay, and the diff after an action (M2g-1)', () => {
  it('a ref given in turn (an id past the cap) never takes a number a later id of the page maps to (round 2 of #145)', () => {
    const refs = new ElementRefs();
    const first = refs.issue('p1', 'a', [0], new Map([[0, 2_000_000]]));
    // The page's next snapshot: another element, with a small id.
    const second = refs.issue('p1', 'b', [0, 1], new Map([[0, 2_000_000], [1, 1]]));
    expect(second.get(1)).not.toBe(first.get(0));
    // The first ref never names the new element: stale (the agent's next snapshot), never key 1.
    expect(refs.resolve(first.get(0), 'p1')).toEqual({ ok: false, why: 'stale' });
  });

  it('refs stay inside their pattern however large the page’s ids and however many pages (N-4)', () => {
    const refs = new ElementRefs();
    // A page past a million ids (in turn), and a thousand-odd pages at a million each (the numbers start over).
    for (let p = 0; p < 1100; p++) {
      const issued = refs.issue(`p${p}`, `t${p}`, [0, 1], new Map([[0, p === 0 ? 99_999_999 : 1_000_000], [1, 1]]));
      for (const ref of issued.values()) {
        expect(ref).toMatch(/^e[1-9][0-9]{0,8}$/);
        expect(refs.resolve(ref, `p${p}`)).toMatchObject({ ok: true });
      }
    }
  });

  it('the agent’s own snapshot stays behind the ones a diff takes, until its next; a diff’s, for SNAPSHOT_KEPT diffs', () => {
    const refs = new ElementRefs();
    refs.issue('p1', 'mine', [0]);
    // Diffs after actions (not pinned): the agent's own snapshot's refs still name their elements there.
    for (let i = 1; i <= SNAPSHOT_KEPT + 2; i++) refs.issue('p1', `d${i}`, [0], undefined, false);
    expect(refs.resolve('e1', 'p1')).toMatchObject({ ok: true, token: 'mine' });
    // The oldest diffs' refs went (only the last SNAPSHOT_KEPT are kept), the newest are good.
    expect(refs.resolve('e2', 'p1')).toEqual({ ok: false, why: 'stale' });
    expect(refs.resolve(`e${SNAPSHOT_KEPT + 3}`, 'p1')).toMatchObject({ ok: true, token: `d${SNAPSHOT_KEPT + 2}` });
    // The agent's next snapshot: its last one's refs are stale.
    refs.issue('p1', 'next', [0]);
    expect(refs.resolve('e1', 'p1')).toEqual({ ok: false, why: 'stale' });
  });

  const read = (nodes: SnapshotRead['nodes']) => ({ url: 'https://game.test/', title: 'Table', nodes, cut: {} }) as SnapshotRead;
  const sidsOf = (r: SnapshotRead) => new Map(r.nodes.filter((n) => n.key !== undefined && n.sid !== undefined).map((n) => [n.key!, n.sid!]));
  const table = (status: string, buttons: [string, number][]) =>
    read([
      { depth: 0, role: 'region', name: 'Table 3', sid: 1 },
      { depth: 1, role: 'text', name: status },
      ...buttons.map(([name, sid], key) => ({ depth: 1, role: 'button', name, key, sid })),
    ]);

  it('an element still there keeps its ref; one replaced gets a new one; another page’s ids never take an old ref', () => {
    const refs = new ElementRefs();
    const a = table('Waiting', [['Fold', 2], ['Call', 3]]);
    const first = refs.issue('p1', 't1', snapshotKeys(a), sidsOf(a));
    // Call replaced (a new id), Fold still there.
    // A diff after an action (not the agent's own snapshot).
    const b = table('Your turn', [['Fold', 2], ['Call', 9]]);
    const second = refs.issue('p1', 't2', snapshotKeys(b), sidsOf(b), false);
    expect(second.get(0)).toBe(first.get(0));
    expect(second.get(1)).not.toBe(first.get(1));
    expect(refs.resolve(first.get(0), 'p1')).toMatchObject({ ok: true, token: 't2', key: 0 });
    // The replaced one's ref still names it in the agent's own snapshot (found again there, #117).
    expect(refs.resolve(first.get(1), 'p1')).toMatchObject({ ok: true, token: 't1', key: 1 });
    // Another page: its ids start again at 1 in the page, but its refs are above every ref before.
    const c = table('Lobby', [['Join', 2]]);
    const third = refs.issue('p2', 't3', snapshotKeys(c), sidsOf(c));
    expect(Number(third.get(0)!.slice(1))).toBeGreaterThan(Math.max(...[...first.values(), ...second.values()].map((r) => Number(r.slice(1)))));
    expect(refs.resolve(first.get(0), 'p2')).toEqual({ ok: false, why: 'stale' });
  });

  it('the diff: lines new (+), changed (~, as they are now) and gone (-), by what they show; nothing for what didn’t change', () => {
    const refs = new ElementRefs();
    const a = table('Waiting', [['Fold', 2], ['Call', 3]]);
    const before = snapshotLines(a, refs.issue('p1', 't1', snapshotKeys(a), sidsOf(a)));
    const b = table('Your turn: 15 s', [['Fold', 2], ['Raise', 7]]);
    const issued = refs.issue('p1', 't2', snapshotKeys(b), sidsOf(b));
    const diff = snapshotDiff(before, snapshotLines(b, issued));
    expect(diff).toEqual(['~ - text: "Your turn: 15 s"', `+ - button "Raise" [ref=${issued.get(1)}]`, expect.stringMatching(/^- - button "Call" \[ref=e\d+\]$/)]);
    expect(snapshotDiff(before, before)).toEqual([]);
  });
});
