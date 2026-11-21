/**
 * Peek's card, moved and resized (DESIGN.md §8.5): it stays wholly inside the
 * window's page area, no smaller than 360 × 240 unless the area is, and a
 * press takes the right grip: the header's empty part moves it, its buttons
 * and text don't, the edges and corners resize it.
 */
import { describe, expect, it } from 'vitest';
import { clampPeekCard, dragPeekCard, PEEK_GRIP, PEEK_MIN, peekGripAt, type PeekBox, type PeekGrip, type PeekTarget } from '../src/peek';

const area: PeekBox = { x: 248, y: 44, width: 1000, height: 700 };
const card: PeekBox = { x: 400, y: 150, width: 600, height: 400 };
const inside = (b: PeekBox, a: PeekBox) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;

describe('clampPeekCard', () => {
  it.each<[string, PeekBox, PeekBox, PeekBox]>([
    ['inside already: as it is', card, area, card],
    ['past the left edge', { ...card, x: 0 }, area, { ...card, x: 248 }],
    ['past the right edge', { ...card, x: 2000 }, area, { ...card, x: 648 }],
    ['past the top edge', { ...card, y: -100 }, area, { ...card, y: 44 }],
    ['past the bottom edge', { ...card, y: 900 }, area, { ...card, y: 344 }],
    ['past a corner', { ...card, x: 5000, y: 5000 }, area, { ...card, x: 648, y: 344 }],
    ['smaller than the minimum', { ...card, width: 100, height: 50 }, area, { ...card, width: 360, height: 240 }],
    ['bigger than the area', { x: 0, y: 0, width: 4000, height: 3000 }, area, area],
    ['the window shrank under it', card, { x: 248, y: 44, width: 500, height: 300 }, { x: 248, y: 44, width: 500, height: 300 }],
    ['the window shrank, a smaller card moves in', { x: 900, y: 500, width: 400, height: 250 }, { x: 248, y: 44, width: 800, height: 600 }, { x: 648, y: 394, width: 400, height: 250 }],
    ['the sidebar docked: the area starts further right', { ...card, x: 10 }, { x: 248, y: 44, width: 1028, height: 772 }, { ...card, x: 248 }],
    ['the sidebar collapsed: the area grows, it stays put', card, { x: 4, y: 44, width: 1272, height: 772 }, card],
    ['an area smaller than the minimum: the area', card, { x: 4, y: 44, width: 300, height: 200 }, { x: 4, y: 44, width: 300, height: 200 }],
    ['fractions round to whole pixels', { x: 400.4, y: 150.6, width: 600.5, height: 399.5 }, area, { x: 400, y: 151, width: 601, height: 400 }],
    ['an area with edges between pixels (150%): whole pixels inside it', { x: 240, y: 63, width: 489, height: 400 }, { x: 240, y: 4, width: 489.33, height: 458.67 }, { x: 240, y: 62, width: 489, height: 400 }],
  ])('%s', (_name, box, within, expected) => {
    const clamped = clampPeekCard(box, within);
    expect(clamped).toEqual(expected);
    expect(inside(clamped, within)).toBe(true);
  });
});

describe('dragPeekCard', () => {
  it.each<[string, PeekGrip, number, number, PeekBox]>([
    ['moved', 'move', 50, -30, { ...card, x: 450, y: 120 }],
    ['moved past the left edge: stops there', 'move', -1000, 0, { ...card, x: 248 }],
    ['moved past the right edge', 'move', 1000, 0, { ...card, x: 648 }],
    ['moved past the top edge', 'move', 0, -1000, { ...card, y: 44 }],
    ['moved past the bottom edge', 'move', 0, 1000, { ...card, y: 344 }],
    ['east edge out', 'e', 100, 0, { ...card, width: 700 }],
    ['east edge past the area: up to its edge', 'e', 1000, 0, { ...card, width: 848 }],
    ['east edge below the minimum', 'e', -1000, 0, { ...card, width: PEEK_MIN.width }],
    ['west edge out: the right edge stays', 'w', -100, 0, { ...card, x: 300, width: 700 }],
    ['west edge past the area', 'w', -1000, 0, { ...card, x: 248, width: 752 }],
    ['west edge below the minimum: the right edge stays', 'w', 1000, 0, { ...card, x: 640, width: PEEK_MIN.width }],
    ['south edge', 's', 0, 50, { ...card, height: 450 }],
    ['south edge past the area', 's', 0, 1000, { ...card, height: 594 }],
    ['north edge below the minimum: the bottom stays', 'n', 0, 1000, { ...card, y: 310, height: PEEK_MIN.height }],
    ['north edge past the area', 'n', 0, -1000, { ...card, y: 44, height: 506 }],
    ['north-west corner', 'nw', -50, -50, { x: 350, y: 100, width: 650, height: 450 }],
    ['north-east corner', 'ne', 50, -50, { x: 400, y: 100, width: 650, height: 450 }],
    ['south-west corner', 'sw', -50, 50, { x: 350, y: 150, width: 650, height: 450 }],
    ['south-east corner past both edges', 'se', 5000, 5000, { x: 400, y: 150, width: 848, height: 594 }],
    ['south-east corner below the minimum', 'se', -5000, -5000, { x: 400, y: 150, width: PEEK_MIN.width, height: PEEK_MIN.height }],
  ])('%s', (_name, grip, dx, dy, expected) => {
    const next = dragPeekCard(card, grip, dx, dy, area);
    expect(next).toEqual(expected);
    expect(inside(next, area)).toBe(true);
  });

  it('in an area smaller than the minimum, a resize keeps to the area', () => {
    const small = { x: 0, y: 0, width: 300, height: 200 };
    expect(dragPeekCard(small, 'se', -100, -100, small)).toEqual(small);
    expect(dragPeekCard(small, 'nw', 100, 100, small)).toEqual(small);
  });
});

describe('peekGripAt', () => {
  const { outside, inside: inner, corner } = PEEK_GRIP;
  const left = card.x;
  const right = card.x + card.width;
  const top = card.y;
  const bottom = card.y + card.height;
  const midX = card.x + card.width / 2;
  const midY = card.y + card.height / 2;
  it.each<[string, { x: number; y: number }, PeekTarget, PeekGrip | null]>([
    ['the header’s empty part moves it', { x: midX, y: top + 20 }, 'header', 'move'],
    ['a button in the header doesn’t', { x: right - 40, y: top + 20 }, 'control', null],
    ['the site’s name and title don’t', { x: left + 40, y: top + 20 }, 'control', null],
    ['a button even at the top edge doesn’t', { x: right - 40, y: top + 1 }, 'control', null],
    ['the header’s top edge resizes', { x: midX, y: top + inner - 1 }, 'header', 'n'],
    ['just above the card', { x: midX, y: top - 2 }, 'outside', 'n'],
    ['just below it', { x: midX, y: bottom + 2 }, 'outside', 's'],
    ['just left of it', { x: left - 2, y: midY }, 'outside', 'w'],
    ['just right of it', { x: right + 2, y: midY }, 'outside', 'e'],
    ['the top-left corner', { x: left - 2, y: top - 2 }, 'outside', 'nw'],
    ['the top-left corner, along the top', { x: left + corner - 1, y: top - 2 }, 'outside', 'nw'],
    ['the top-left corner, inside the header', { x: left + 2, y: top + 1 }, 'header', 'nw'],
    ['the top-right corner', { x: right + 2, y: top - 2 }, 'outside', 'ne'],
    ['the top-right corner, along the side', { x: right + 2, y: top + corner - 1 }, 'outside', 'ne'],
    ['the bottom-left corner', { x: left - 2, y: bottom + 2 }, 'outside', 'sw'],
    ['the bottom-right corner', { x: right + 2, y: bottom + 2 }, 'outside', 'se'],
    ['the bottom-right corner, along the bottom', { x: right - corner + 1, y: bottom + 2 }, 'outside', 'se'],
    ['too far out: the scrim’s', { x: midX, y: top - outside - 1 }, 'outside', null],
    ['too far right: the scrim’s', { x: right + outside + 1, y: midY }, 'outside', null],
    ['inside the card below the header: the page’s', { x: midX, y: midY }, 'outside', null],
  ])('%s', (_name, point, on, expected) => {
    expect(peekGripAt(point, card, on)).toBe(expected);
  });
});
