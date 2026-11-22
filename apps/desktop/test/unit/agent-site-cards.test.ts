/**
 * The site card (S18 M2c, agents/site-cards.ts): an outside agent's first action on a site asks in the window used
 * last; only that window's popover answers; Always on this site only where it's offered; taken down, it's a no.
 */
import { describe, expect, it } from 'vitest';
import { SiteCards } from '../../src/main/agents/site-cards';

function setup(last: string | null = 'w1') {
  let lastWindow = last;
  let changes = 0;
  const cards = new SiteCards({ lastWindow: () => lastWindow, changed: () => void changes++ });
  return { cards, setLast: (w: string | null) => (lastWindow = w), changes: () => changes };
}

const question = (always: boolean) => ({ name: 'Claude Code', site: 'shop.example', action: 'click “Start a return”', always });

describe('The site card', () => {
  it('shows in the window used last, as Chord says it, and only that window answers', async () => {
    const t = setup();
    const asked = t.cards.ask(question(true), new AbortController().signal);
    const card = t.cards.cardFor('w1')!;
    expect(card).toMatchObject({ kind: 'site', name: 'Claude Code', site: 'shop.example', action: 'click “Start a return”', always: true });
    expect(t.cards.cardFor('w2')).toBeNull();
    expect(t.cards.answer(card.id, 'always', 'w2')).toBe(false);
    expect(t.cards.answer(card.id, 'always', 'w1')).toBe(true);
    expect(await asked).toBe('always');
    expect(t.cards.cardFor('w1')).toBeNull();
  });

  it('Always on this site only where it was offered: otherwise it counts as Allow for now', async () => {
    const t = setup();
    const asked = t.cards.ask(question(false), new AbortController().signal);
    const card = t.cards.cardFor('w1')!;
    expect(card.always).toBe(false);
    t.cards.answer(card.id, 'always', 'w1');
    expect(await asked).toBe('once');
  });

  it('taken down (Stop, the agent going) is a no; with no window it waits for one, and a closed window passes it on', async () => {
    const t = setup(null);
    const stop = new AbortController();
    const asked = t.cards.ask(question(true), stop.signal);
    expect(t.cards.cardFor('w1')).toBeNull();
    t.cards.windowFocused('w1');
    expect(t.cards.cardFor('w1')).not.toBeNull();
    t.setLast('w2');
    t.cards.windowClosed('w1');
    expect(t.cards.cardFor('w2')).not.toBeNull();
    stop.abort();
    expect(await asked).toBe('deny');
    expect(t.cards.cardFor('w2')).toBeNull();
  });

  it('shows text from the agent and the page as plain text', () => {
    const t = setup();
    void t.cards.ask({ name: 'Claude\u202E Code', site: 'shop.example', action: 'click “Go\u200B”', always: false }, new AbortController().signal);
    expect(t.cards.cardFor('w1')).toMatchObject({ name: 'Claude Code', action: 'click “Go”' });
  });
});
