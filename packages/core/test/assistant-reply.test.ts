/**
 * A long acting turn in the chat (the owner's card-game fixture run on 982ce10): what the model writes between tool calls
 * is a paragraph of its own, never glued to the last ("to act.Only Arthur called"), and the activity row says how many
 * times it looked at one tab, never that one tab was 69 tabs.
 */
import { describe, expect, it } from 'vitest';
import { nextReplyText, replyBlocks, replyBlockStart, toolRowLabel } from '../src';

describe('A reply’s text across tool calls', () => {
  it('text after a tool call starts a paragraph; within one block it runs on', () => {
    // [the reply so far, what's after it, a tool ran since, the reply then, still waiting for a block to start]
    const rows: [string, string, boolean, string, boolean][] = [
      ['Waiting for the bots to act.', 'Only Arthur called.', true, 'Waiting for the bots to act.\n\nOnly Arthur called.', false],
      ['I won that pot.', ' I’m up to 240.', false, 'I won that pot. I’m up to 240.', false],
      ['Dealing the next hand. ', '  62o, fold.', true, 'Dealing the next hand.\n\n62o, fold.', false],
      // A block's first piece only space: the break waits for its words.
      ['Check.', ' ', true, 'Check.', true],
      // Nothing before it: no break.
      ['', 'Let me look.', true, 'Let me look.', false],
    ];
    for (const [text, delta, newBlock, after, waiting] of rows) expect(nextReplyText(text, delta, newBlock), JSON.stringify([text, delta])).toEqual({ text: after, newBlock: waiting });
  });
});

describe('Where an update starts (Claude’s review of #190)', () => {
  it('its first words, or the first after a step; never within a block, never on space alone', () => {
    // [the reply so far, the reply then, a tool ran since, still waiting for a block, where an update starts (or null)]
    const rows: [string, string, boolean, boolean, number | null][] = [
      ['', 'Let me look.', false, false, 0],
      ['', '  ', false, false, null],
      ['Waiting.', 'Waiting.\n\nOnly Arthur called.', true, false, 'Waiting.'.length + 2],
      ['Waiting.', 'Waiting. Still.', false, false, null],
      // A tool ran, but only space came: the update waits for its words.
      ['Waiting.', 'Waiting.', true, true, null],
    ];
    for (const [was, next, afterTool, newBlock, at] of rows) expect(replyBlockStart(was, next, afterTool, newBlock), JSON.stringify([was, next])).toBe(at);
  });

  it('saved or imported, kept only when each is an update’s start in order and what came before it', () => {
    expect(replyBlocks([{ at: 0, after: null }, { at: 12, after: 'm1' }])).toEqual([{ at: 0, after: null }, { at: 12, after: 'm1' }]);
    for (const bad of [null, 'x', [{ at: -1, after: null }], [{ at: 1.5, after: null }], [{ at: 0, after: 3 }], [{ at: 5, after: null }, { at: 2, after: null }], [{}]]) expect(replyBlocks(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('The activity row of a run of steps', () => {
  it('the same look at one tab, counted; tabs read, by how many tabs; never one tab as many', () => {
    const looks = Array.from({ length: 69 }, () => ({ tool: 'tab_screenshot', summary: 'Looked at “Table 7”' }));
    const clicks = Array.from({ length: 44 }, (_, i) => ({ tool: 'click', summary: i % 2 ? 'Clicked “Call”' : 'Clicked “Check”' }));
    // [what, the steps, the row]
    const rows: [string, { tool: string; summary: string }[], string][] = [
      ['one tab looked at 69 times', looks, 'Looked at “Table 7” (69 times)'],
      ['one tab, looked at and clicked in', [...looks, ...clicks], 'Looked at “Table 7” (69 times) · Clicked “Check” (22 times) · Clicked “Call” (22 times)'],
      ['three tabs read', [{ tool: 'read_tab', summary: 'Read “A”' }, { tool: 'read_tab', summary: 'Read “B”' }, { tool: 'read_tab', summary: 'Read “A”' }, { tool: 'read_tab', summary: 'Read “C”' }], 'Read 3 tabs'],
      ['two tabs read and a click', [{ tool: 'read_tab', summary: 'Read “A”' }, { tool: 'tab_screenshot', summary: 'Looked at “B”' }, { tool: 'click', summary: 'Clicked “Go”' }], 'Read 2 tabs · 1 more'],
      ['different steps, each said (what the page set off among them)', [{ tool: 'click', summary: 'Clicked “Upload”' }, { tool: 'act', summary: 'The page tried to open a file picker; it wasn’t shown' }, { tool: 'click', summary: 'Clicked “Copy”' }, { tool: 'click', summary: 'Clicked “Passkey”' }], 'Clicked “Upload” · The page tried to open a file picker; it wasn’t shown · Clicked “Copy” · Clicked “Passkey”'],
      ['one step', [{ tool: 'snapshot', summary: 'Looked over “Table 7”' }], 'Looked over “Table 7”'],
    ];
    for (const [what, steps, label] of rows) expect(toolRowLabel(steps), what).toBe(label);
  });
});
