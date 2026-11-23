import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { holdFilePickers } from '../../src/main/agents/pickers';

// Neon's review of #110: an agent's tab holds file pickers for its whole life, in its page and its frames' targets.
describe('holdFilePickers', () => {
  const fake = (attachThrows = false) => {
    const events = new EventEmitter();
    const sent: [string, unknown, string | undefined][] = [];
    let attached = false;
    const contents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => attached,
        attach: () => {
          if (attachThrows) throw new Error('Another debugger is already attached');
          attached = true;
        },
        on: (e: string, f: (...a: unknown[]) => void) => events.on(e, f),
        sendCommand: async (method: string, params?: unknown, sessionId?: string) => void sent.push([method, params, sessionId]),
      },
    };
    return { contents: contents as unknown as WebContents, events, sent };
  };

  it('intercepts in the page and in each frame attached, and says when a picker was held', () => {
    const { contents, events, sent } = fake();
    const held: string[] = [];
    holdFilePickers(contents, (d) => void held.push(d));
    expect(sent.map(([m, , s]) => `${m}${s ? `@${s}` : ''}`)).toEqual(['Page.enable', 'Page.setInterceptFileChooserDialog', 'Target.setAutoAttach']);
    expect(sent[1]![1]).toEqual({ enabled: true });
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe' } });
    expect(sent.slice(3).map(([m, , s]) => `${m}@${s}`)).toEqual(['Page.enable@s1', 'Page.setInterceptFileChooserDialog@s1', 'Target.setAutoAttach@s1']);
    // A worker isn't a frame: nothing for it.
    events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 's2', targetInfo: { type: 'worker' } });
    expect(sent).toHaveLength(6);
    events.emit('message', {}, 'Page.fileChooserOpened', { mode: 'selectSingle' }, 's1');
    expect(held).toEqual(['a file picker']);
  });

  it('does nothing if the debugger can’t be had', () => {
    const { contents, sent } = fake(true);
    holdFilePickers(contents, () => undefined);
    expect(sent).toEqual([]);
  });
});
