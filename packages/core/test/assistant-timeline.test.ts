/**
 * A long acting turn in the chat (the owner's card-game fixture run; mocks/assistant-long-turns.html, approved
 * 2026-11-25): each update between the assistant's steps is a paragraph of its own, between the steps that came before
 * and after it; past three, the earlier ones fold into one row (*Earlier in this task (N)*), with the latest two in view
 * while it works and only the final answer once it's done. A card still waiting for you is never folded away.
 */
import { describe, expect, it } from 'vitest';
import { timelineRows, type AssistantMessage, type TimelineRow } from '../src';

const user = (id: string): AssistantMessage => ({ id, threadId: 't', createdAt: 0, body: { role: 'user', text: 'Play until 500', attachments: [] } });
const tool = (id: string, summary = `Step ${id}`): AssistantMessage => ({ id, threadId: 't', createdAt: 0, body: { role: 'tool', tool: 'click', summary, detail: '', ok: true } });
/** What the page set off, caught, or "Stopped: you used the tab": an act note, not ok. */
const note = (id: string, summary: string): AssistantMessage => ({ id, threadId: 't', createdAt: 0, body: { role: 'tool', tool: 'act', summary, detail: '', ok: false } });
/** A fill card (propose_fill) waiting for you, or filled. */
const fill = (id: string, status: 'pending' | 'filled'): AssistantMessage => ({ id, threadId: 't', createdAt: 0, body: { role: 'tool', tool: 'propose_fill', summary: 'Suggested values', detail: '', ok: true, fill: { status } } as never });
const card = (id: string, decision: 'pending' | 'once'): AssistantMessage => ({ id, threadId: 't', createdAt: 0, body: { role: 'approval', tool: 'click', description: 'Allow?', target: [], decision } as never });
/** A reply of these updates, each after the item named (null: before any). */
const reply = (id: string, updates: [string, string | null][], status: 'streaming' | 'done' = 'done'): AssistantMessage => {
  let text = '';
  const blocks: { at: number; after: string | null }[] = [];
  for (const [words, after] of updates) {
    if (text) text += '\n\n';
    blocks.push({ at: text.length, after });
    text += words;
  }
  return { id, threadId: 't', createdAt: 0, body: { role: 'assistant', text, citations: [], status, blocks } };
};
/** A row, briefly: its kind and what's in it. */
const brief = (row: TimelineRow): unknown =>
  row.kind === 'message'
    ? row.message.id
    : row.kind === 'tools'
      ? `tools:${row.messages.map((m) => m.id).join(',')}`
      : row.kind === 'update'
        ? `“${row.text}”`
        : { earlier: row.count, tools: row.tools.map((m) => m.id), ...(row.notes.length ? { notes: row.notes.map((m) => m.id) } : {}), rows: row.rows.map(brief) };

describe('A turn’s updates between its steps', () => {
  it('each update in its place, between the steps before and after it; three or fewer fold nothing', () => {
    const rows = timelineRows([user('u'), tool('a'), tool('b'), tool('c'), reply('r', [['Looking at the table.', 'a'], ['Hand 1: fold.', 'c']])]);
    expect(rows.map(brief)).toEqual(['u', 'tools:a', '“Looking at the table.”', 'tools:b,c', '“Hand 1: fold.”']);
  });

  it('a long turn while it works: the latest two in view, the earlier ones in one row with their steps', () => {
    const updates: [string, string | null][] = [['U1', 'a'], ['U2', 'b'], ['U3', 'c'], ['U4', 'd'], ['U5', 'e']];
    const rows = timelineRows([user('u'), ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => tool(x)), reply('r', updates, 'streaming')]);
    expect(rows.map(brief)).toEqual([
      'u',
      { earlier: 3, tools: ['a', 'b', 'c'], rows: ['tools:a', '“U1”', 'tools:b', '“U2”', 'tools:c', '“U3”'] },
      'tools:d',
      '“U4”',
      'tools:e',
      '“U5”',
      // The step under way.
      'tools:f',
    ]);
  });

  it('done: only the final answer in view, in full', () => {
    const rows = timelineRows([user('u'), tool('a'), tool('b'), tool('c'), tool('d'), reply('r', [['U1', 'a'], ['U2', 'b'], ['U3', 'c'], ['Done: 512 after 28 hands.\n\nThe page copied something.', 'd']])]);
    expect(rows.map(brief)).toEqual(['u', { earlier: 3, tools: ['a', 'b', 'c'], rows: ['tools:a', '“U1”', 'tools:b', '“U2”', 'tools:c', '“U3”'] }, 'tools:d', '“Done: 512 after 28 hands.\n\nThe page copied something.”']);
    const last = rows.at(-1);
    expect(last?.kind === 'update' && last.last).toBe(true);
  });

  it('a card still waiting is never folded away; answered ones fold with their steps', () => {
    const updates: [string, string | null][] = [['U1', 'a'], ['U2', 'k'], ['U3', 'b'], ['U4', 'c'], ['U5', 'd']];
    const answered = timelineRows([user('u'), tool('a'), card('k', 'once'), tool('b'), tool('c'), tool('d'), reply('r', updates, 'streaming')]);
    expect(answered[1]).toMatchObject({ kind: 'earlier', count: 3 });
    const waiting = timelineRows([user('u'), tool('a'), card('k', 'pending'), tool('b'), tool('c'), tool('d'), reply('r', updates, 'streaming')]);
    expect(waiting.some((r) => r.kind === 'earlier')).toBe(false);
    // A fill card waiting for your Fill is a card too (Claude's review of #190); a filled one folds.
    const filling = timelineRows([user('u'), tool('a'), fill('k', 'pending'), tool('b'), tool('c'), tool('d'), reply('r', updates, 'streaming')]);
    expect(filling.some((r) => r.kind === 'earlier')).toBe(false);
    const filled = timelineRows([user('u'), tool('a'), fill('k', 'filled'), tool('b'), tool('c'), tool('d'), reply('r', updates, 'streaming')]);
    expect(filled[1]).toMatchObject({ kind: 'earlier' });
  });

  it('what the page set off, and "Stopped: you used the tab", stay in view under the closed row, never in its line (Claude’s review of #190)', () => {
    const updates: [string, string | null][] = [['U1', 'a'], ['U2', 'n'], ['U3', 'b'], ['U4', 'c'], ['U5', 'd']];
    const rows = timelineRows([user('u'), tool('a'), note('n', 'The page tried to open a file picker; it wasn’t shown'), tool('b'), tool('c'), tool('d'), reply('r', updates, 'streaming')]);
    expect(rows[1]).toMatchObject({ kind: 'earlier', count: 3 });
    const earlier = rows[1] as Extract<TimelineRow, { kind: 'earlier' }>;
    expect(earlier.tools.map((m) => m.id)).toEqual(['a', 'b']);
    expect(earlier.notes.map((m) => m.id)).toEqual(['n']);
  });

  it('after a reload (the store’s order: the reply first, at its turn’s start), each update is still in its place (Claude’s review of #190)', () => {
    const updates: [string, string | null][] = [['U1', 'a'], ['U2', 'b'], ['U3', 'c'], ['U4', 'd'], ['U5', 'e']];
    const live = timelineRows([user('u'), ...['a', 'b', 'c', 'd', 'e'].map((x) => tool(x)), reply('r', updates)]);
    const reloaded = timelineRows([user('u'), reply('r', updates), ...['a', 'b', 'c', 'd', 'e'].map((x) => tool(x))]);
    expect(reloaded.map(brief)).toEqual(live.map(brief));
    expect(live.map(brief).at(-1)).toBe('“U5”');
  });

  it('a reply from before (no blocks) is the message it always was; one of a single update is in its place, so it doesn’t jump when a second starts (Claude’s review of #190)', () => {
    const old: AssistantMessage = { id: 'r0', threadId: 't', createdAt: 0, body: { role: 'assistant', text: 'One answer.', citations: [], status: 'done' } };
    expect(timelineRows([user('u0'), tool('a'), tool('b'), old, user('u'), tool('c'), reply('r', [['U1', 'c']])]).map(brief)).toEqual(['u0', 'tools:a,b', 'r0', 'u', 'tools:c', '“U1”']);
    // Its first update before any step: it stays above the steps after it.
    expect(timelineRows([user('u'), tool('a'), reply('r', [['Let me look.', null]], 'streaming')]).map(brief)).toEqual(['u', '“Let me look.”', 'tools:a']);
  });
});
