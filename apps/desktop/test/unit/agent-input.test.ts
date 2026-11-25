/**
 * Input Chord sends a page for an agent (S18 M2a, control/input.ts), against a stand-in page: what's sent, what's
 * refused, what counts as the agent's, and the menu's accelerators, off from an agent's keys until your next key.
 */
import { describe, expect, it } from 'vitest';
import { AgentInputRefused, clicksTheTab, inputWhy, isAgentInput, sendAgentInput, usesTheTab, yourKey, type AgentInputEvent } from '../../src/main/control/input';

function page() {
  const log: string[] = [];
  let destroyed = false;
  const p = {
    isDestroyed: () => destroyed,
    sendInputEvent: (event: AgentInputEvent) => void log.push(`${event.type}${isAgentInput(p) ? ' (agent)' : ' (yours)'}`),
    setIgnoreMenuShortcuts: (ignore: boolean) => void log.push(`menu ${ignore ? 'off' : 'on'}`),
    destroy: () => (destroyed = true),
  };
  return { p, log };
}

const click: AgentInputEvent[] = [
  { type: 'mouseDown', x: 1, y: 1, button: 'left', clickCount: 1 },
  { type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 },
];
const escape: AgentInputEvent[] = [
  { type: 'keyDown', keyCode: 'Escape' },
  { type: 'keyUp', keyCode: 'Escape' },
];

describe('Your key in a tab: what counts as using it (the owner’s Alt+Tab in the 0.15 preview)', () => {
  it('a modifier alone never does (Alt+Tab’s Alt reaches the page, its Tab goes to the OS); a key the page gets does', () => {
    // [the key, with which modifiers held, whether it's using the tab]
    const rows: [string, Partial<Record<'alt' | 'control' | 'shift' | 'meta', boolean>>, boolean][] = [
      ['Alt', { alt: true }, false],
      ['Control', { control: true }, false],
      ['Shift', { shift: true }, false],
      ['Meta', { meta: true }, false],
      ['OS', {}, false],
      ['AltGraph', {}, false],
      ['CapsLock', {}, false],
      ['NumLock', {}, false],
      ['f', { alt: true }, true],
      ['a', { control: true }, true],
      ['a', {}, true],
      ['Enter', {}, true],
      ['Tab', {}, true],
      ['Escape', {}, true],
      ['Process', {}, true],
      ['Dead', {}, true],
      // No key the page could act on (Windows sends some with none): not using the tab.
      ['Unidentified', {}, false],
      ['', {}, false],
    ];
    for (const [key, held, uses] of rows) expect(usesTheTab({ type: 'keyDown', key, ...held }), `${key} ${JSON.stringify(held)}`).toBe(uses);
    // A key let go of is no new use of the tab.
    expect(usesTheTab({ type: 'keyUp', key: 'a' })).toBe(false);
    expect(usesTheTab({ type: 'keyUp', key: 'Alt' })).toBe(false);
  });

  it('a click is a button pressed: never the pointer moving, entering, leaving, a release alone, or the wheel (the owner’s test of 9d1ad40)', () => {
    // [the event, whether it's using the tab]
    const rows: [{ type: string; button?: string }, boolean][] = [
      [{ type: 'mouseDown', button: 'left' }, true],
      [{ type: 'mouseDown', button: 'right' }, true],
      [{ type: 'mouseDown', button: 'middle' }, true],
      [{ type: 'mouseDown' }, false],
      [{ type: 'mouseUp', button: 'left' }, false],
      [{ type: 'mouseMove' }, false],
      [{ type: 'mouseEnter' }, false],
      [{ type: 'mouseLeave' }, false],
      [{ type: 'mouseWheel' }, false],
    ];
    for (const [event, uses] of rows) expect(clicksTheTab(event), JSON.stringify(event)).toBe(uses);
  });

  it('what it was, said: a key by its code, a click by its button (so the next preview tells which)', () => {
    expect(inputWhy({ type: 'keyDown', key: 'a', code: 'KeyA' })).toBe('a key: KeyA');
    expect(inputWhy({ type: 'keyDown', key: 'Enter', code: 'Enter', control: true })).toBe('a key: Ctrl+Enter');
    expect(inputWhy({ type: 'mouseDown', button: 'left' })).toBe('a click: left');
  });
});

describe('Input Chord sends a page for an agent', () => {
  it('counts as the agent’s while it’s sent, and only then', () => {
    const { p, log } = page();
    sendAgentInput(p, click);
    expect(log).toEqual(['mouseDown (agent)', 'mouseUp (agent)']);
    expect(isAgentInput(p)).toBe(false);
  });

  it('refuses a whole batch with anything off the list, sending none of it', () => {
    const { p, log } = page();
    expect(() => sendAgentInput(p, [...click, { type: 'keyDown', keyCode: 'W', modifiers: ['control'] }])).toThrow(AgentInputRefused);
    expect(log).toEqual([]);
  });

  it('turns the menu’s accelerators off with its keys, until your next key there', () => {
    const { p, log } = page();
    // A click alone leaves them as they are.
    sendAgentInput(p, click);
    expect(log.filter((l) => l.startsWith('menu'))).toEqual([]);
    sendAgentInput(p, escape);
    sendAgentInput(p, escape);
    expect(log.filter((l) => l.startsWith('menu'))).toEqual(['menu off']);
    yourKey(p);
    yourKey(p);
    expect(log.filter((l) => l.startsWith('menu'))).toEqual(['menu off', 'menu on']);
    // A page that went meanwhile is left alone.
    sendAgentInput(p, escape);
    p.destroy();
    yourKey(p);
    expect(log.filter((l) => l.startsWith('menu'))).toEqual(['menu off', 'menu on', 'menu off']);
  });
});
