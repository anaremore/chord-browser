/**
 * The shared control layer's pure parts (S18 M1a): the gate's states and
 * grants, its refusals, tab refs, and the tool list both front doors offer.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_KINDS,
  ASSISTANT_TOOLS,
  CONTROL_IDLE,
  CONTROL_NEVER_OFFERED,
  CONTROL_REFUSALS,
  CONTROL_TOOLS,
  TabRefs,
  controlAdmits,
  controlKind,
  controlStep,
  diagnosticsResult,
  formRead,
  formResult,
  grantAfter,
  isNeverOffered,
  pageResult,
  type ApprovalKind,
  type ControlEvent,
  type ControlState,
  type ControlStateKind,
  type Grant,
} from '../src';

const state = (over: Partial<ControlState> = {}): ControlState => ({ ...CONTROL_IDLE, ...over });

describe('The gate: one (agent, tab)’s state', () => {
  // [from, event, to, what the user sees after, whether a new call may start]
  const table: [string, ControlState, ControlEvent, ControlState, ControlStateKind, 'go' | 'wait' | 'stopped'][] = [
    ['a call starts', state(), { t: 'call' }, state({ calls: 1 }), 'working', 'go'],
    ['a second call runs alongside', state({ calls: 1 }), { t: 'call' }, state({ calls: 2 }), 'working', 'go'],
    ['a call ends', state({ calls: 1 }), { t: 'done' }, state(), 'idle', 'go'],
    ['done never goes below zero', state(), { t: 'done' }, state(), 'idle', 'go'],
    ['a card shows', state({ calls: 1 }), { t: 'ask', card: 'c1' }, state({ calls: 1, cards: ['c1'] }), 'waiting', 'go'],
    ['cards queue in order', state({ calls: 2, cards: ['c1'] }), { t: 'ask', card: 'c2' }, state({ calls: 2, cards: ['c1', 'c2'] }), 'waiting', 'go'],
    ['the same card twice is one', state({ cards: ['c1'] }), { t: 'ask', card: 'c1' }, state({ cards: ['c1'] }), 'waiting', 'go'],
    ['an answer takes its card', state({ calls: 1, cards: ['c1', 'c2'] }), { t: 'answer', card: 'c1' }, state({ calls: 1, cards: ['c2'] }), 'waiting', 'go'],
    ['the last answer goes back to working', state({ calls: 1, cards: ['c1'] }), { t: 'answer', card: 'c1' }, state({ calls: 1 }), 'working', 'go'],
    ['an answer for no card changes nothing', state({ calls: 1 }), { t: 'answer', card: 'c9' }, state({ calls: 1 }), 'working', 'go'],
    ['the user works in the tab', state({ calls: 1 }), { t: 'pause' }, state({ calls: 1, paused: true }), 'paused', 'wait'],
    ['paused outranks a card', state({ cards: ['c1'] }), { t: 'pause' }, state({ cards: ['c1'], paused: true }), 'paused', 'wait'],
    ['the user leaves the tab', state({ paused: true }), { t: 'unpause' }, state(), 'idle', 'go'],
    ['Stop drops the cards', state({ calls: 2, cards: ['c1'] }), { t: 'stop' }, state({ calls: 2, stopped: true }), 'stopped', 'stopped'],
    ['Stop ends a pause', state({ paused: true }), { t: 'stop' }, state({ stopped: true }), 'stopped', 'stopped'],
    ['stopped refuses a call', state({ stopped: true }), { t: 'call' }, state({ stopped: true }), 'stopped', 'stopped'],
    ['stopped shows no card', state({ stopped: true }), { t: 'ask', card: 'c1' }, state({ stopped: true }), 'stopped', 'stopped'],
    ['stopped can’t be paused', state({ stopped: true }), { t: 'pause' }, state({ stopped: true }), 'stopped', 'stopped'],
    ['a call that ran on after Stop still ends', state({ calls: 1, stopped: true }), { t: 'done' }, state({ stopped: true }), 'stopped', 'stopped'],
    ['the user lets it continue', state({ stopped: true }), { t: 'resume' }, state(), 'idle', 'go'],
    ['continue with calls still ending', state({ calls: 1, stopped: true }), { t: 'resume' }, state({ calls: 1 }), 'working', 'go'],
  ];
  it.each(table)('%s', (_name, from, event, to, kind, admits) => {
    const next = controlStep(from, event);
    expect(next).toEqual(to);
    expect(controlKind(next)).toBe(kind);
    expect(controlAdmits(next)).toBe(admits);
  });

  it('never changes the state it was given', () => {
    const from = Object.freeze(state({ calls: 1, cards: Object.freeze(['c1']) as readonly string[] }));
    for (const event of [{ t: 'call' }, { t: 'done' }, { t: 'ask', card: 'c2' }, { t: 'answer', card: 'c1' }, { t: 'pause' }, { t: 'stop' }] as ControlEvent[]) expect(() => controlStep(from, event)).not.toThrow();
  });
});

describe('The gate: what a grant leaves behind', () => {
  const table: [ApprovalKind, Grant, 'always' | 'deny' | null][] = [
    ['connection', 'once', null],
    ['connection', 'always', 'always'],
    ['connection', 'deny', 'deny'],
    ['read', 'once', null],
    ['read', 'always', 'always'],
    ['read', 'deny', null],
    ['site', 'once', null],
    ['site', 'always', 'always'],
    ['site', 'deny', null],
    ['step', 'once', null],
    ['step', 'always', null],
    ['step', 'deny', null],
  ];
  it.each(table)('%s answered %s → %s', (kind, grant, kept) => expect(grantAfter(kind, grant)).toBe(kept));
  it('covers every kind', () => expect(new Set(table.map(([k]) => k))).toEqual(new Set(APPROVAL_KINDS)));
});

describe('The gate: what a refused call says', () => {
  it.each(Object.entries(CONTROL_REFUSALS))('%s is one plain sentence or two for the model', (_key, text) => {
    expect(text).toMatch(/^[A-Z][^\n]{10,200}\.$/);
    expect(text).not.toMatch(/tab_id|t\d|https?:/);
  });
  it('tells the model to stop, wait or ask, never to retry by itself', () => {
    expect(CONTROL_REFUSALS.stopped).toContain('until the user asks you to');
    expect(CONTROL_REFUSALS.denied).toContain('tell the user');
    expect(CONTROL_REFUSALS.waiting).toContain('call this tool again');
  });
});

describe('Tab refs', () => {
  const open = new Set(['n1', 'n2', 'n3']);
  const isOpen = (id: string) => open.has(id);

  it('gives each tab one ref, in order, and never reuses one', () => {
    const refs = new TabRefs('t');
    expect([refs.refFor('n1'), refs.refFor('n2'), refs.refFor('n1'), refs.refFor('n3')]).toEqual(['t1', 't2', 't1', 't3']);
    open.delete('n2');
    expect(refs.resolve('t2', isOpen)).toEqual({ ok: false, why: 'closed' });
    // A tab opened later gets a new ref, never the closed one's.
    expect(refs.refFor('n4')).toBe('t4');
    open.add('n2');
  });

  // [ref the model sent, what it resolves to]
  const table: [unknown, ReturnType<TabRefs['resolve']>][] = [
    ['t1', { ok: true, id: 'n1' }],
    ['t3', { ok: false, why: 'closed' }],
    ['t5', { ok: false, why: 'closed' }],
    ['t2', { ok: false, why: 'unknown' }],
    ['t9', { ok: false, why: 'unknown' }],
    ['a1', { ok: false, why: 'unknown' }],
    [7, { ok: false, why: 'unknown' }],
    [undefined, { ok: false, why: 'unknown' }],
  ];
  it.each(table)('a saved chat’s refs: %s', (ref, expected) => {
    const refs = new TabRefs('t');
    // A chat's attachments as saved: t1's tab is open, t3's closed, t5's tab isn't found any more.
    refs.restore('t1', 'n1');
    refs.restore('t3', 'gone');
    refs.restore('t5', null);
    refs.restore('x7', 'n2');
    expect(refs.resolve(ref, isOpen)).toEqual(expected);
    // New refs number after the highest restored, so none is ever taken again.
    expect(refs.refFor('n2')).toBe('t6');
    expect(refs.refFor('n1')).toBe('t1');
    expect([...refs.entries()]).toEqual([
      ['t1', 'n1'],
      ['t3', 'gone'],
      ['t6', 'n2'],
    ]);
  });

  it('keeps per-scope prefixes apart', () => {
    const agent = new TabRefs('a');
    expect(agent.refFor('n1')).toBe('a1');
    expect(agent.resolve('t1', isOpen)).toEqual({ ok: false, why: 'unknown' });
  });
});

describe('The tools both front doors offer', () => {
  it('are the assistant’s tools and M2’s (snapshot so far), every one a read for now', () => {
    expect(CONTROL_TOOLS.map((t) => t.name)).toEqual([...ASSISTANT_TOOLS.map((t) => t.name), 'snapshot']);
    for (const tool of CONTROL_TOOLS) expect(tool).toMatchObject({ tier: 0, level: 'read' });
  });

  it('never offer what’s on the never-offered list', () => {
    for (const tool of CONTROL_TOOLS) expect(isNeverOffered(tool.name), tool.name).toBe(false);
    for (const word of CONTROL_NEVER_OFFERED) expect(isNeverOffered(`read_${word}s`)).toBe(true);
  });

  it('add page_id to every read’s result when it’s known, and nothing when it isn’t', () => {
    const form = formRead({ url: 'https://shop.test/', controls: [], forms: [], truncated: false }, 1);
    const results: [string, (pageId?: string) => string][] = [
      ['read_tab', (pageId) => pageResult({ ref: 't1', url: 'https://e.test/', text: 'x', retrievedAt: 0, ...(pageId ? { pageId } : {}) })],
      ['read_form', (pageId) => formResult(form, { ref: 't1', retrievedAt: 0, ...(pageId ? { pageId } : {}) })],
      ['page_diagnostics', (pageId) => diagnosticsResult({ ref: 't1', url: 'https://e.test/', retrievedAt: 0, entries: [], total: 0, ...(pageId ? { pageId } : {}) })],
    ];
    for (const [name, result] of results) {
      expect(JSON.parse(result('p7')), name).toMatchObject({ tab_id: 't1', page_id: 'p7', trust: 'untrusted' });
      expect(JSON.parse(result()), name).not.toHaveProperty('page_id');
    }
  });
});
