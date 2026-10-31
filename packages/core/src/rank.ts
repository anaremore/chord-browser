/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Portions derived from Crest, © 2026 Paul Davis (https://github.com/pauljoda/Crest):
 * text matching (PaletteQuery, TextMatch), signals (PaletteSignal), frecency
 * and learned picks (PaletteMemory).
 */

/**
 * Command bar ranking (ARCHITECTURE.md §10). A row's score is the sum of
 * its signals: how well the text matches it, how often and recently its page
 * was visited, how recently its tab was used, whether it's kept (pinned),
 * and what the person picked before for the same text.
 */

/** WHATWG URL, available in Node and every renderer; core has no DOM lib to declare it. */
declare const URL: new (url: string) => { protocol: string; hostname: string; port: string; pathname: string; search: string };

/** Points for where a typed word appears: at the start of the text, at the start of a word, or inside one. */
export const MATCH_POINTS = { textStart: 1000, wordStart: 700, inside: 300 } as const;
/** A word found only in a row's detail (its address) scores this much less. */
const DETAIL_PENALTY = 150;
const INITIALS_POINTS = 250;
const SUBSEQUENCE_POINTS = 150;

/** Frecency halves every 30 days. */
export const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;
const FRESH_USE_MS = 3_600_000;

/**
 * Texts folded already, and titles' initials: the command bar matches every
 * open tab's title and address on each keystroke (thousands of them, with
 * many pinned), the same texts each time. At most this many of each.
 */
const MAX_REMEMBERED = 20_000;
const foldedTexts = new Map<string, string>();
const titleInitials = new Map<string, readonly string[]>();
const remember = <T>(map: Map<string, T>, key: string, value: T): T => {
  if (map.size >= MAX_REMEMBERED) map.clear();
  map.set(key, value);
  return value;
};

const fold = (s: string) => foldedTexts.get(s) ?? remember(foldedTexts, s, s.toLocaleLowerCase().replace(/ς/g, 'σ'));
const isBoundary = (ch: string) => !/[\p{L}\p{N}]/u.test(ch);

/** The last text split into terms, and its terms: asked again for each row a keystroke matches. */
let lastTyped: string | null = null;
let lastTerms: readonly string[] = [];

/** What was typed, trimmed and split into folded words. */
export function terms(typed: string): readonly string[] {
  if (typed !== lastTyped) {
    lastTerms = fold(typed.trim()).split(/\s+/u).filter(Boolean);
    lastTyped = typed;
  }
  return lastTerms;
}

/** The first letter of each of a folded title's words, in order. */
function initialsOf(folded: string): readonly string[] {
  const known = titleInitials.get(folded);
  if (known) return known;
  const chars = [...folded];
  return remember(
    titleInitials,
    folded,
    chars.filter((ch, i) => !isBoundary(ch) && (i === 0 || isBoundary(chars[i - 1]!))),
  );
}

function bestMatch(term: string, text: string): number | null {
  const folded = fold(text);
  let best: number | null = null;
  for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + 1)) {
    if (at === 0) return MATCH_POINTS.textStart;
    const points = isBoundary(folded[at - 1]!) ? MATCH_POINTS.wordStart : MATCH_POINTS.inside;
    if (points === MATCH_POINTS.wordStart) return points;
    best = Math.max(best ?? 0, points);
  }
  return best;
}

/**
 * How well every typed word matches `title`, or `detail` for less: the
 * average of each word's best match. Null when any word matches neither.
 */
export function matchScore(typed: string, title: string, detail = ''): number | null {
  const words = terms(typed);
  if (words.length === 0) return null;
  let total = 0;
  for (const word of words) {
    const inTitle = bestMatch(word, title);
    if (inTitle !== null) {
      total += inTitle;
      continue;
    }
    const inDetail = detail ? bestMatch(word, detail) : null;
    if (inDetail === null) return null;
    total += Math.max(0, inDetail - DETAIL_PENALTY);
  }
  return Math.round(total / words.length);
}

/** One typed word as the initials of a title's words ("tsv" → Toggle Split View), or its letters in order. */
export function abbreviationScore(typed: string, title: string): number | null {
  const words = terms(typed);
  if (words.length !== 1 || [...words[0]!].length < 2) return null;
  const word = [...words[0]!];
  const folded = fold(title);
  const initials = initialsOf(folded);
  if (word.every((ch, i) => initials[i] === ch)) return INITIALS_POINTS;
  let found = 0;
  for (const ch of folded) if (found < word.length && ch === word[found]) found++;
  return found === word.length ? SUBSEQUENCE_POINTS : null;
}

/** Whether what was typed, as one text, starts `text` ("amazon" starts "amazon.de/"). */
export function prefixes(typed: string, text: string): boolean {
  const t = terms(typed).join(' ');
  return t.length > 0 && fold(text).replace(/\s+/gu, ' ').startsWith(t);
}

/**
 * The key a page is known by: lower-case host without `www.`, port, path
 * and query; no scheme or fragment. Null for anything but http(s).
 */
export function placeKey(url: string): string | null {
  try {
    const u = new URL(url);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${u.port ? `:${u.port}` : ''}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** `at` as days since the Unix epoch. */
export const dayOf = (at: number) => at / DAY_MS;

/**
 * Frecency as one number: the day its score falls to 1. A use adds one to
 * the current score (a typed or picked one adds another), which halves
 * every 30 days.
 */
export function frecencyOn(decayDay: number, at: number): number {
  return 2 ** ((decayDay - dayOf(at)) / HALF_LIFE_DAYS);
}

/** The decay day after one more use at `at`. */
export function used(decayDay: number | null, at: number): number {
  const score = (decayDay === null ? 0 : frecencyOn(decayDay, at)) + 1;
  return dayOf(at) + HALF_LIFE_DAYS * Math.log2(score);
}

/** History rows: 60 points for each doubling of frecency, at most 300. */
export const usagePoints = (frecency: number) => Math.min(300, Math.round(60 * Math.log2(1 + frecency)));

/** Open tabs: 200 points if used within the hour, fading to none over a day. */
export function recencyPoints(lastUsedAt: number | null, now: number): number {
  if (lastUsedAt === null) return 0;
  const age = now - lastUsedAt;
  if (age <= FRESH_USE_MS) return 200;
  if (age >= DAY_MS) return 0;
  return Math.round((200 * (DAY_MS - age)) / (DAY_MS - FRESH_USE_MS));
}

/** A pick the person made after typing `text`, and how often, decayed to `lastUsedAt`. */
export interface Choice {
  text: string;
  destination: string;
  uses: number;
  lastUsedAt: number;
}

const DAILY_CHOICE_DECAY = 0.975;
const CHOICE_CARRY = 0.9;
/** What a pick remembers of the typed text. */
export const foldChoiceText = (typed: string) => terms(typed).join(' ').slice(0, 64);

export const choiceUses = (c: Choice, now: number) => c.uses * DAILY_CHOICE_DECAY ** Math.max(0, (now - c.lastUsedAt) / DAY_MS);

/** The uses after picking it again (or 1 for a new pick). */
export const pickedAgain = (previous: Choice | undefined, now: number) => (previous ? CHOICE_CARRY * choiceUses(previous, now) + 1 : 1);

/**
 * The boost for `destination` given what was typed: the strongest pick whose
 * text starts with it, by how often it was picked and how much of its text
 * was typed, doubled for the exact text.
 */
export function learnedPoints(choices: readonly Choice[], typed: string, destination: string, now: number): number {
  const text = foldChoiceText(typed);
  if (!text) return 0;
  let best = 0;
  for (const c of choices) {
    if (c.destination !== destination || !c.text.startsWith(text)) continue;
    const uses = choiceUses(c, now);
    best = Math.max(best, ((500 * uses) / (uses + 1)) * (text.length / c.text.length) * (c.text.length === text.length ? 2 : 1));
  }
  return Math.round(best);
}

/** What the person picked at least twice for exactly this text: it leads. */
export function habit(choices: readonly Choice[], typed: string, now: number): string | null {
  const text = foldChoiceText(typed);
  let best: Choice | null = null;
  for (const c of choices) {
    if (c.text !== text || choiceUses(c, now) < 1.8) continue;
    if (!best || choiceUses(c, now) > choiceUses(best, now)) best = c;
  }
  return best?.destination ?? null;
}
