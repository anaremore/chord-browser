import { describe, expect, it } from 'vitest';
import { actDone, actPhrase, agentInputAllowed, barAddress, barDoing, isPressKey, PRESS_KEYS, pressKeyEvents, quotedName, type ActDescription, type BarDoing } from '../src';

describe('press_key’s keys (S18 M2c)', () => {
  it('each is sent as down, its character where it types one, and up: every event one Chord ever sends', () => {
    for (const key of PRESS_KEYS) {
      const events = pressKeyEvents(key);
      for (const e of events) expect(agentInputAllowed(e), `${key}: ${JSON.stringify(e)}`).toBe(true);
      expect(events[0]!.type).toBe('keyDown');
      expect(events.at(-1)!.type).toBe('keyUp');
    }
    expect(pressKeyEvents('Enter')).toEqual([
      { type: 'keyDown', keyCode: 'Return' },
      { type: 'char', keyCode: '\r' },
      { type: 'keyUp', keyCode: 'Return' },
    ]);
    expect(pressKeyEvents('Shift+Tab')).toEqual([
      { type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] },
      { type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] },
    ]);
    expect(pressKeyEvents('ArrowDown').map((e) => e.keyCode)).toEqual(['Down', 'Down']);
  });

  // [what an agent sends, a key?]
  const keys: [unknown, boolean][] = [
    ['Enter', true],
    ['Shift+Tab', true],
    ['PageDown', true],
    ['enter', false],
    ['a', false],
    ['Ctrl+W', false],
    ['F12', false],
    [13, false],
    [null, false],
  ];
  it.each(keys)('%j is a key: %s', (key, yes) => expect(isPressKey(key)).toBe(yes));
});

describe('Chord’s words for an action: the site card, the activity line, the bar', () => {
  // [the action, the card's phrase, the activity line]
  const rows: [ActDescription, string, string][] = [
    [{ tool: 'click', name: 'Start a return', role: 'button' }, 'click “Start a return”', 'Clicked “Start a return”'],
    [{ tool: 'type', name: 'Search orders', role: 'searchbox' }, 'type in “Search orders”', 'Typed in “Search orders”'],
    [{ tool: 'press_key', name: 'Search orders', role: 'searchbox', key: 'Enter' }, 'press Enter in “Search orders”', 'Pressed Enter in “Search orders”'],
    [{ tool: 'select_option', name: 'Shipping', role: 'combobox', choice: 'Express' }, 'choose “Express” in “Shipping”', 'Chose “Express” in “Shipping”'],
    [{ tool: 'hover', name: 'Menu', role: 'button' }, 'point at “Menu”', 'Pointed at “Menu”'],
    // No name: what it is. A page's name with control or format characters, long: cleaned and cut.
    [{ tool: 'click', name: '', role: 'generic' }, 'click the element', 'Clicked the element'],
    [{ tool: 'click', name: '', role: 'link' }, 'click the link', 'Clicked the link'],
    [{ tool: 'click', name: 'Go\u202Eevil\u200B now', role: 'button' }, 'click “Goevil now”', 'Clicked “Goevil now”'],
  ];
  it.each(rows)('%j', (action, phrase, done) => {
    expect(actPhrase(action)).toBe(phrase);
    expect(actDone(action)).toBe(done);
  });

  it('cuts a long name to 60 characters', () => {
    expect(quotedName('x'.repeat(100), 'button')).toBe(`“${'x'.repeat(59)}…”`);
  });

  // [what it's doing, what the bar says after its name]
  const bar: [BarDoing, string][] = [
    [{ tool: 'click', name: 'Start a return', role: 'button' }, 'is clicking “Start a return”'],
    [{ tool: 'type', name: 'Search orders', role: 'searchbox' }, 'is typing in “Search orders”'],
    [{ tool: 'press_key', name: 'Search orders', role: 'searchbox', key: 'Enter' }, 'is pressing Enter'],
    [{ tool: 'select_option', name: 'Shipping', role: 'combobox', choice: 'Express' }, 'is choosing “Express” in “Shipping”'],
    [{ tool: 'hover', name: 'Menu', role: 'button' }, 'is pointing at “Menu”'],
    [{ tool: 'navigate', to: 'shop.example/returns' }, 'is going to shop.example/returns'],
    [{ tool: 'back' }, 'is going back'],
  ];
  it.each(bar)('%j: %s', (doing, text) => expect(barDoing(doing)).toBe(text));

  // [address, what the bar shows]: host and path, never the query or fragment.
  const addresses: [string, string][] = [
    ['https://shop.example/returns?token=secret#x', 'shop.example/returns'],
    ['https://shop.example/', 'shop.example'],
    ['http://127.0.0.1:8080/a/b', '127.0.0.1:8080/a/b'],
    [`https://shop.example/${'p'.repeat(100)}`, `shop.example/${'p'.repeat(46)}…`],
  ];
  it.each(addresses)('%s → %s', (url, shown) => expect(barAddress(url)).toBe(shown));
});
