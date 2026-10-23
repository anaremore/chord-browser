import { describe, expect, it } from 'vitest';
import { live } from '../../src/renderer/shared/live';

/** A stand-in for main: a fetch answered when the test says, and messages sent when the test says. */
function source<T>() {
  let listener: ((value: T) => void) | undefined;
  let answer: (value: T) => void = () => {};
  return {
    fetch: () => new Promise<T>((done) => (answer = done)),
    onChange: (l: (value: T) => void) => {
      listener = l;
      return () => (listener = undefined);
    },
    send: (value: T) => listener?.(value),
    answer: (value: T) => answer(value),
  };
}

describe('live', () => {
  it('starts from the answer when nothing was sent', async () => {
    const main = source<string>();
    const pending = live(main.fetch, main.onChange);
    main.answer('first');
    const value = await pending;
    expect(value.get()).toBe('first');
    main.send('second');
    expect(value.get()).toBe('second');
  });

  it('keeps a message that arrived before the answer: it can be the newer of the two', async () => {
    const main = source<string>();
    const pending = live(main.fetch, main.onChange);
    // Main answered "no prompt", then raised one, and the message beat the answer here.
    main.send('prompt');
    main.answer('no prompt');
    expect((await pending).get()).toBe('prompt');
  });

  it('tells subscribers about messages after the answer, not before', async () => {
    const main = source<number>();
    const pending = live(main.fetch, main.onChange);
    main.answer(1);
    const value = await pending;
    let heard = 0;
    value.subscribe(() => heard++);
    main.send(2);
    main.send(3);
    expect(heard).toBe(2);
    expect(value.get()).toBe(3);
  });
});
