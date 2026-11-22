import { describe, expect, it } from 'vitest';
import { AGENT_KEYS, agentInputAllowed, type AgentInputLike } from '../src/agent-input';

describe('What input Chord ever sends a page for an agent (S18 M2a)', () => {
  // [event, allowed]
  const cases: [AgentInputLike, boolean][] = [
    // press_key's list, plain.
    ...AGENT_KEYS.map((keyCode): [AgentInputLike, boolean] => [{ type: 'keyDown', keyCode }, true]),
    [{ type: 'keyUp', keyCode: 'Return' }, true],
    [{ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }, true],
    [{ type: 'keyDown', keyCode: 'Down', modifiers: ['isAutoRepeat'] }, true],
    // Chord's, the OS's and pages' shortcuts: never.
    [{ type: 'keyDown', keyCode: 'W', modifiers: ['control'] }, false],
    [{ type: 'keyDown', keyCode: 'W', modifiers: ['ctrl'] }, false],
    [{ type: 'keyDown', keyCode: 'T', modifiers: ['meta'] }, false],
    [{ type: 'keyDown', keyCode: 'Q', modifiers: ['cmd'] }, false],
    [{ type: 'keyDown', keyCode: 'I', modifiers: ['control', 'shift'] }, false],
    [{ type: 'keyDown', keyCode: 'Left', modifiers: ['alt'] }, false],
    [{ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] }, false],
    [{ type: 'keyDown', keyCode: 'Delete', modifiers: ['shift'] }, false],
    [{ type: 'keyDown', keyCode: 'F12' }, false],
    [{ type: 'keyDown', keyCode: 'F5' }, false],
    // Letters and other characters: a web app's shortcuts (text goes in by insertText).
    [{ type: 'keyDown', keyCode: 'A' }, false],
    [{ type: 'keyDown', keyCode: '#' }, false],
    [{ type: 'keyDown' }, false],
    [{ type: 'char', keyCode: 'a' }, false],
    [{ type: 'char', keyCode: '\r' }, true],
    [{ type: 'char', keyCode: ' ' }, true],
    [{ type: 'char', keyCode: '\r', modifiers: ['control'] }, false],
    // The mouse: the left button, moves and the wheel, with nothing held.
    [{ type: 'mouseMove' }, true],
    [{ type: 'mouseDown', button: 'left' }, true],
    [{ type: 'mouseUp', button: 'left' }, true],
    [{ type: 'mouseWheel' }, true],
    [{ type: 'mouseDown', button: 'right' }, false],
    [{ type: 'mouseDown', button: 'middle' }, false],
    [{ type: 'mouseDown', button: 'left', modifiers: ['control'] }, false],
    [{ type: 'mouseDown', button: 'left', modifiers: ['meta'] }, false],
    [{ type: 'mouseWheel', modifiers: ['control'] }, false],
    [{ type: 'contextMenu' }, false],
    [{ type: 'gestureScrollBegin' }, false],
  ];
  it.each(cases)('%j: %s', (event, allowed) => expect(agentInputAllowed(event)).toBe(allowed));
});
