import { describe, expect, it } from 'vitest';
import {
  abbreviationScore,
  frecencyOn,
  habit,
  learnedPoints,
  matchScore,
  pickedAgain,
  placeKey,
  prefixes,
  recencyPoints,
  usagePoints,
  used,
  type Choice,
} from '../src';

const DAY = 86_400_000;

describe('matchScore', () => {
  it('prefers the start of the title, then the start of a word, then anywhere', () => {
    expect(matchScore('chord', 'Chord progressions')).toBe(1000);
    expect(matchScore('prog', 'Chord progressions')).toBe(700);
    expect(matchScore('ress', 'Chord progressions')).toBe(300);
  });

  it('averages every word, and scores address-only matches lower', () => {
    expect(matchScore('chord prog', 'Chord progressions')).toBe(850);
    expect(matchScore('github', 'Pull requests', 'github.com/pulls')).toBe(850);
    expect(matchScore('chord harp', 'Chord progressions')).toBeNull();
  });
});

describe('abbreviations and prefixes', () => {
  it('reads initials and letters in order', () => {
    expect(abbreviationScore('tsv', 'Toggle Split View')).toBe(250);
    expect(abbreviationScore('tgl', 'Toggle Split View')).toBe(150);
    expect(abbreviationScore('x', 'Toggle')).toBeNull();
  });

  it('matches the typed text at the very start, ignoring case', () => {
    expect(prefixes('amazon', 'amazon.de/')).toBe(true);
    expect(prefixes('Crest br', 'Crest Browser')).toBe(true);
    expect(prefixes('zon', 'amazon.de')).toBe(false);
  });
});

describe('placeKey', () => {
  it('keys pages by host, port, path and query, without www, scheme or fragment', () => {
    expect(placeKey('https://www.GitHub.com/pulls?q=1#top')).toBe('github.com/pulls?q=1');
    expect(placeKey('http://localhost:3000/')).toBe('localhost:3000');
    expect(placeKey('chord://settings')).toBeNull();
  });
});

describe('frecency', () => {
  it('adds one per use and halves every 30 days', () => {
    const t0 = 1_700_000_000_000;
    let decay = used(null, t0);
    expect(frecencyOn(decay, t0)).toBeCloseTo(1);
    decay = used(decay, t0);
    expect(frecencyOn(decay, t0)).toBeCloseTo(2);
    expect(frecencyOn(decay, t0 + 30 * DAY)).toBeCloseTo(1);
  });

  it('turns frecency into at most 300 points', () => {
    expect(usagePoints(0)).toBe(0);
    expect(usagePoints(1)).toBe(60);
    expect(usagePoints(1_000)).toBe(300);
  });

  it('counts a tab used within the hour fully, fading over a day', () => {
    const now = 10 * DAY;
    expect(recencyPoints(now - 30 * 60_000, now)).toBe(200);
    expect(recencyPoints(now - DAY, now)).toBe(0);
    expect(recencyPoints(null, now)).toBe(0);
  });
});

describe('learned picks', () => {
  const now = 100 * DAY;
  const pick = (text: string, destination: string, uses: number): Choice => ({ text, destination, uses, lastUsedAt: now });

  it('boosts what was picked for text that starts the same, most for the exact text', () => {
    const choices = [pick('gh', 'github.com', 3)];
    expect(learnedPoints(choices, 'gh', 'github.com', now)).toBe(750);
    expect(learnedPoints(choices, 'g', 'github.com', now)).toBe(188);
    expect(learnedPoints(choices, 'gh', 'gitlab.com', now)).toBe(0);
  });

  it('makes a habit of a pick made twice for the same text', () => {
    const once = pick('mail', 'mail.google.com', pickedAgain(undefined, now));
    expect(habit([once], 'mail', now)).toBeNull();
    const twice = { ...once, uses: pickedAgain(once, now) };
    expect(habit([twice], 'Mail', now)).toBe('mail.google.com');
  });
});
