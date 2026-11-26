/**
 * Chord's password generator (S17 §6, *Generating*; decided 2026-11-17). Pure: the random numbers come from the
 * caller, which in main is `crypto.randomInt` (main/passwords/generator.ts), never `Math.random`.
 *
 * - **The default:** 20 characters from letters and digits without look-alikes (Chromium's sets: no `l`, `o`, `I`,
 *   `O`, `0`, `1`), at least one lower case letter, one upper case letter and one digit, and `-` as the only symbol,
 *   at least once. About 105 bits, counting each class's one place at that class's own bits (`planBits`).
 * - **Site rules take precedence, in this order:** the field's `passwordrules` attribute; then Apple's
 *   `password-rules.json` for the site; then the field's `minlength` and `maxlength`. Rules come in Apple's language,
 *   parsed with Apple's parser (password-rules-parser.ts). A source that says nothing (empty, unreadable) passes to
 *   the next. A lower source narrows a higher one only where they agree: a `maxlength` shorter than the site's own
 *   `minlength` is ignored.
 * - **Within the rules, the default's style:** characters come from the default's alphabet wherever the rules allow
 *   them, and a required class with none of them (`required: [!#$]`) gets one of its own. The default's classes are
 *   asked for too, as far as the rules allow and the length leaves room.
 * - **Never a look-alike** (`LOOK_ALIKES`, the owner's decision of 2026-11-18), on every path: the default's alphabet,
 *   a required class's own characters, and the wider pool a password under the 40-bit floor is drawn from. Where that
 *   leaves too few bits, the password is made longer, within the rules' maximum and its run limits; under the floor
 *   whatever's done, it's offered as it is, weak, never with look-alikes for strength. Look-alikes come back only where
 *   the rules can't be met without them: a required class of look-alikes alone (`required: [0O]`) gets one of them, in
 *   one place, and rules allowing only look-alikes (`allowed: [0O]`) are drawn from what they allow (`planFor`).
 * - **Every password made is checked** against its rules (`passwordSatisfies`) before it's returned; one that can't
 *   be made (a `maxlength` shorter than the classes it requires, a required class with nothing allowed in it) is null,
 *   and nothing is offered.
 *
 * Nothing here keeps, logs or sends a password.
 */
import { PASSWORD_LIMITS } from './passwords';
import { CustomCharacterClass, parsePasswordRules, passwordRulesSaySomething, type CharacterClass, type PasswordRule } from './password-rules-parser';

/** The menu's ↻ by key: in `passwords.ts`, which renderers load, and here for main. */
export { PASSWORD_REGENERATE_KEYS } from './passwords';

/** The default's length (S17 §6 ⚠, the owner's decision of 2026-11-17). */
export const GENERATED_LENGTH = 20;

/** The default's alphabet, by class: Chromium's, without look-alikes (`password_generator.cc` ✅). */
export const GENERATOR_CLASSES = {
  lower: 'abcdefghijkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digit: '23456789',
  symbol: '-',
} as const;
const DEFAULT_ALPHABET = Object.values(GENERATOR_CLASSES).join('');

/**
 * The characters a generated password leaves out wherever the rules allow anything else: Chromium's look-alikes
 * (`l`, `o`, `I`, `O`, `0`, `1`), which the default's alphabet already leaves out, and `|`, which reads as `l` or `I`.
 * The one list, for every path (see the header).
 */
export const LOOK_ALIKES = '01IOlo|';
const withoutLookAlikes = (s: string) => [...s].filter((c) => !LOOK_ALIKES.includes(c)).join('');

/** How many tries a generation gets before it says the rules can't be met (a run limit is met by chance, often). */
const TRIES = 300;
/**
 * At most this many characters drawn in all, whatever the length (security review): a page's rules that can't be met,
 * at 1,000 characters, would otherwise cost main 300,000 draws a focus.
 */
const DRAW_BUDGET = 20_000;

/** `randomInt(n)`: a uniform integer in [0, n). */
export type RandomInt = (n: number) => number;

/** The rules a generated password must meet, worked out from every source. */
export interface PasswordRuleSet {
  readonly minLength: number;
  readonly maxLength: number;
  /** Every character the password may use. */
  readonly allowed: string;
  /** Each class the password must have a character of. */
  readonly required: readonly string[];
  /** The most identical characters back to back (`aaa` is 3). */
  readonly maxRepeating: number | null;
  /** The most characters back to back in order within a-z, A-Z or 0-9, either way (`abc`, `321` are 3). */
  readonly maxSequential: number | null;
}

/** What a field says of itself, as the passwords agent reads it: never its value. */
export interface FieldPasswordRules {
  /** The `passwordrules` attribute, as written. */
  readonly passwordrules?: string;
  /** The `minlength` and `maxlength` attributes; -1 (or absent) when there's none. */
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** Where the rules came from: the field's attribute, Apple's list for the site, or Chord's default. */
export type PasswordRulesSource = 'field' | 'site' | 'default';

const ASCII_PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
const NAMED: Record<string, string> = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  special: ASCII_PRINTABLE.replace(/[A-Za-z0-9]/g, ''),
  'ascii-printable': ASCII_PRINTABLE,
  // Chord makes ASCII passwords: what a site allows beyond them is never needed.
  unicode: ASCII_PRINTABLE,
};

/** The characters of a list of classes, each once, in ASCII order. */
function charactersOf(classes: readonly CharacterClass[]): string {
  const set = new Set<string>();
  for (const c of classes) for (const ch of c instanceof CustomCharacterClass ? c.characters : (NAMED[c.name] ?? '')) set.add(ch);
  return [...set].sort().join('');
}

const intersect = (a: string, b: string) => [...a].filter((c) => b.includes(c)).join('');

/** Apple's parsed rules as a rule set: one allowed set, the required classes, the limits. */
export function ruleSetOf(rules: readonly PasswordRule[]): PasswordRuleSet {
  let allowed = ASCII_PRINTABLE;
  const required: string[] = [];
  let minLength = 0;
  let maxLength: number = PASSWORD_LIMITS.password;
  let maxRepeating: number | null = null;
  let maxSequential: number | null = null;
  const least = (a: number | null, b: number) => (a === null ? b : Math.min(a, b));
  for (const rule of rules) {
    switch (rule.name) {
      case 'allowed':
        allowed = charactersOf(rule.value);
        break;
      case 'required': {
        const chars = charactersOf(rule.value);
        // `required: []` asks for nothing.
        if (chars) required.push(chars);
        break;
      }
      case 'minlength':
        minLength = Math.max(minLength, rule.value);
        break;
      case 'maxlength':
        maxLength = Math.min(maxLength, rule.value);
        break;
      // Deprecated, and both limits at once (Apple's #1255).
      case 'max-consecutive':
        maxRepeating = least(maxRepeating, rule.value);
        maxSequential = least(maxSequential, rule.value);
        break;
      case 'max-repeating':
        maxRepeating = least(maxRepeating, rule.value);
        break;
      case 'max-sequential':
        maxSequential = least(maxSequential, rule.value);
        break;
    }
  }
  return { minLength, maxLength, allowed, required, maxRepeating, maxSequential };
}

/** Chord's own rules, when no source says anything: the default's alphabet and classes, any length. */
export const DEFAULT_RULE_SET: PasswordRuleSet = {
  minLength: 0,
  maxLength: PASSWORD_LIMITS.password,
  allowed: DEFAULT_ALPHABET,
  required: [],
  maxRepeating: null,
  maxSequential: null,
};

/**
 * The rules for a field (S17 §6): its `passwordrules`, else the site's (Apple's list, looked up by the caller), else
 * the default; then its `minlength` and `maxlength`, where they agree with what's above them.
 */
export function passwordRulesFor(field: FieldPasswordRules, siteRules: string | null): { source: PasswordRulesSource; rules: PasswordRuleSet } {
  const own = field.passwordrules?.slice(0, 2000) ?? '';
  const [source, base]: [PasswordRulesSource, PasswordRuleSet] = passwordRulesSaySomething(own)
    ? ['field', ruleSetOf(parsePasswordRules(own))]
    : siteRules && passwordRulesSaySomething(siteRules)
      ? ['site', ruleSetOf(parsePasswordRules(siteRules))]
      : ['default', DEFAULT_RULE_SET];
  let { minLength, maxLength } = base;
  const min = field.minLength ?? -1;
  const max = field.maxLength ?? -1;
  if (min > 0 && min <= maxLength) minLength = Math.max(minLength, min);
  if (max > 0 && max >= minLength) maxLength = Math.min(maxLength, max);
  return { source, rules: { ...base, minLength, maxLength } };
}

const SYMBOLS = NAMED['special']!.replace(' ', '');

/**
 * The floor under *Use a strong password* (review round 1 of #53, the planning thread's decision): a password the
 * site's rules hold under 8 characters, or under about 40 bits, is still offered, the strongest they allow, but as
 * *Use a password this site allows*.
 */
export const STRONG_PASSWORD = { length: 8, bits: 40 } as const;

/** How a password for a rule set is drawn. */
interface Plan {
  /** The characters every place but the forced ones is drawn from. */
  readonly pool: string;
  readonly length: number;
  /**
   * The forced places, one each, as each is drawn: the rules' required classes (the default's alphabet, else without
   * look-alikes, else whole), then the default's classes as far as the rules allow them and the length leaves room.
   */
  readonly forced: readonly string[];
  /** The longest the pool can fill under the run limits, with the required classes between its runs (`maxFillable`). */
  readonly fill: number;
}

/** Whether the rules limit runs: then a password is built a place at a time (`buildWith`), never breaking them. */
const limitsRuns = (rules: PasswordRuleSet) => rules.maxRepeating !== null || rules.maxSequential !== null;

/**
 * The most characters the run limits can rule out at one place of a password of `chars` (#60): the one that would
 * repeat a run too long, and the one that would carry a run in order too far, or with `max-sequential: 1` both of the
 * last character's neighbours. A limit on runs in order longer than `chars` can make rules out nothing.
 */
function ruledOut(rules: PasswordRuleSet, chars: string): number {
  const s = rules.maxSequential;
  const sequential = s !== null && s < runs(longestInOrder(chars)).sequential;
  return (rules.maxRepeating === null ? 0 : 1) + (!sequential ? 0 : s <= 1 ? 2 : 1);
}

/** The longest run in order (a-z, A-Z, 0-9) that `chars` can make: `abcx` makes `abc`. */
function longestInOrder(chars: string): string {
  let best = '';
  for (const range of ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789']) {
    let run = '';
    for (const c of range) {
      run = chars.includes(c) ? run + c : '';
      if (run.length > best.length) best = run;
    }
  }
  return best;
}

/**
 * A lower bound on a plan's bits at `length` (never more than it has): each forced place at log2 of its own class,
 * whether or not its characters are in the pool too (review round 2 of #56), and every other place at log2(pool).
 * Shuffling the forced places in only adds to it.
 *
 * Under run limits (#60) each place is drawn from its class less what the limits rule out there, so it counts
 * log2(class − ruledOut) at least. A place can run out of characters only where its class has no more than that: a
 * pool that small counts nothing (`planFor` keeps its password short); a small forced class (a lone required `-`) can
 * leave a try with no character for it, which is then made again, and the chance of that (`stuckChance`) comes off.
 */
function planBits(plan: Pick<Plan, 'pool' | 'forced'>, length: number, rules: PasswordRuleSet): number {
  const out = limitsRuns(rules) ? ruledOut(rules, plan.pool + plan.forced.join('')) : 0;
  const placeBits = (size: number) => (size - out > 1 ? Math.log2(size - out) : 0);
  if (out && plan.pool.length <= out) return 0;
  let bits = 0;
  for (const cls of plan.forced) bits += placeBits(new Set(cls).size);
  const free = Math.max(0, length - plan.forced.length);
  bits += free * placeBits(plan.pool.length);
  if (!out) return bits;
  const stuck = stuckChance(plan, length, out);
  return stuck >= 1 ? 0 : Math.max(0, bits + Math.log2(1 - stuck));
}

/**
 * A bound on how likely one try is to leave a place with no character (#60), under run limits that rule out at most
 * `out` at a place. Only a forced class of `out` characters or fewer can be left with none, and only by the character
 * before it: its own, or one next to it in order (three at most can do it). That one came from a class of at least
 * `wide` characters, drawn from `wide − out` of them or more, unless it was another small forced class, whose places
 * are anywhere in the password (the forced places are shuffled in): a chance of (small − 1)/(length − 1).
 */
function stuckChance(plan: Pick<Plan, 'pool' | 'forced'>, length: number, out: number): number {
  const sizes = plan.forced.slice(0, length).map((cls) => new Set(cls).size);
  const small = sizes.filter((size) => size <= out).length;
  if (!small) return 0;
  const wide = Math.min(plan.pool.length, ...sizes.filter((size) => size > out));
  const byOther = length > 1 ? (small - 1) / (length - 1) : 0;
  return small * (3 / (wide - out) + byOther);
}

/**
 * The longest password a pool can fill under the run limits, with one character of each required class (`separators`)
 * between its runs (Argon's design review of #60, B2). Any length, except in two cases: one character under
 * `max-repeating` (`aa` at most, with `max-repeating: 2`), and two characters next to each other in order under
 * `max-repeating` and `max-sequential: 1` (neither `ab` nor, past r, `aa…`). Then r characters a run, and a separator
 * between runs where one of its characters can stand beside each of the pool's. Three characters or more, or two not in
 * order, can always go on (`abab…`, `acac…`).
 */
function maxFillable(pool: string, separators: readonly string[], rules: PasswordRuleSet): number {
  const r = rules.maxRepeating;
  const s = rules.maxSequential;
  if (r === null) return Infinity;
  const chars = [...new Set(pool)];
  const inOrder = (a: string, b: string) => Math.abs(stepOf(a, b)) === 1;
  const pair = chars.length === 2 && inOrder(chars[0]!, chars[1]!) && s !== null && s <= 1;
  if (chars.length !== 1 && !pair) return Infinity;
  const between = (c: string) => !chars.includes(c) && (s === null || s > 1 || chars.every((p) => !inOrder(p, c)));
  const k = separators.filter((cls) => [...cls].some(between)).length;
  return (k + 1) * r + k;
}

/** The run a password ends with, as it's built a character at a time (Argon's N1: no pass over the whole password). */
interface Tail {
  readonly last: string;
  readonly repeating: number;
  readonly sequential: number;
  /** The run in order's direction: 1 up, -1 down, 0 none. */
  readonly dir: number;
}
const NO_TAIL: Tail = { last: '', repeating: 0, sequential: 0, dir: 0 };

/** How far apart two characters are within a-z, A-Z or 0-9 (0 when they aren't in the same one). */
function stepOf(a: string, b: string): number {
  for (const range of ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789']) {
    const i = range.indexOf(a);
    const j = range.indexOf(b);
    if (i >= 0 && j >= 0) return j - i;
  }
  return 0;
}

/** The tail once `c` follows it. */
function extend(tail: Tail, c: string): Tail {
  if (!tail.last) return { last: c, repeating: 1, sequential: 1, dir: 0 };
  const repeating = c === tail.last ? tail.repeating + 1 : 1;
  const d = stepOf(tail.last, c);
  if (d !== 1 && d !== -1) return { last: c, repeating, sequential: 1, dir: 0 };
  return { last: c, repeating, sequential: tail.sequential === 1 || d === tail.dir ? tail.sequential + 1 : 2, dir: d };
}

const allows = (tail: Tail, rules: PasswordRuleSet) =>
  (rules.maxRepeating === null || tail.repeating <= rules.maxRepeating) && (rules.maxSequential === null || tail.sequential <= rules.maxSequential);

/** Tests only (Argon's N1): whether a password meets the rules' run limits, checked a character at a time. */
export function runsAllow(password: string, rules: PasswordRuleSet): boolean {
  let tail = NO_TAIL;
  for (const c of password) if (!allows((tail = extend(tail, c)), rules)) return false;
  return true;
}

/**
 * How a password for these rules is drawn (as `generatePassword` draws it), the first of these that reaches the floor
 * (`planBits`):
 * 1. the default's alphabet where the rules allow it, at the default's length (within the rules');
 * 2. everything the rules allow but look-alikes (`LOOK_ALIKES`), at that length, else made longer to reach the floor;
 * 3. only where the rules allow nothing but look-alikes (`allowed: [0O]`), everything they allow, the same way.
 * A required class of look-alikes alone (`required: [0O]`) gets one forced place of its own in 1 and 2, and every free
 * place stays clean (review round 3 of #56); one clean character allowed (`allowed: [a0O]`) is `aaaa…`, weak.
 * Made longer only within the rules' maximum (and the vault's); under run limits each place counts what they leave
 * of it (`planBits`), and a pool they could leave with no character is kept as short as it can fill (`maxFillable`,
 * #60). When none reaches the floor, it's the last of them the rules allow, as long as the maximum and the
 * run limits let it be, and weak: never look-alikes for strength alone, under the floor too (the owner's decision of
 * 2026-11-18; four digits are from 2–9). Null when the rules allow no character or no length.
 */
function planFor(rules: PasswordRuleSet): Plan | null {
  const minLength = Math.max(1, rules.minLength);
  const maxLength = Math.min(rules.maxLength, PASSWORD_LIMITS.password);
  if (minLength > maxLength) return null;
  const length = Math.min(Math.max(GENERATED_LENGTH, minLength), maxLength);
  // Never a space: a site that allows one may still trim it, and it can't be seen.
  const allowed = [...new Set(rules.allowed.replace(/ /g, ''))].join('');
  if (!allowed) return null;
  const floor = STRONG_PASSWORD.bits;
  const preferred = intersect(DEFAULT_ALPHABET, allowed);
  const clean = withoutLookAlikes(allowed);
  // A class with nothing allowed is left to `generatePassword`, which offers nothing.
  const owns = rules.required.map((cls) => intersect(cls, allowed)).filter((own) => own);
  // Look-alikes in the free places only when the rules allow nothing else (review round 3 of #56).
  const onlyLookAlikes = !clean;
  const planOf = (pool: string, full: boolean): Plan | null => {
    // Drawn from more than the default's alphabet (preferred ⊆ clean ⊆ allowed): the default's classes take their own whole.
    const wide = pool.length !== preferred.length;
    // Each class from the default's alphabet where it can be, else without look-alikes where it can be: only a class of
    // look-alikes alone (`required: [0O]`) gets one of them, and only for that class.
    const forced = owns.map((own) => (full ? own : (!wide && intersect(own, DEFAULT_ALPHABET)) || withoutLookAlikes(own) || own));
    // As long as the run limits let the pool fill, with the required classes between its runs (#60): never under the
    // minimum, nor too short for the required classes.
    const fill = maxFillable(pool, forced, rules);
    const capped = Math.min(length, fill);
    if (capped < Math.max(minLength, forced.length)) return null;
    // Then the default's classes, as far as the rules allow them and the length leaves room: a site that only bounds
    // the length gets the default's style.
    const classes = wide ? [NAMED['lower']!, NAMED['upper']!, NAMED['digit']!, GENERATOR_CLASSES.symbol] : Object.values(GENERATOR_CLASSES);
    for (const cls of classes) {
      const own = intersect(cls, pool);
      if (own && forced.length < capped && !forced.some((r) => [...r].every((c) => own.includes(c)))) forced.push(own);
    }
    return { pool, length: capped, forced, fill };
  };
  const reaching = (pool: string, full: boolean, lengthen: boolean): Plan | null => {
    if (!pool) return null;
    const plan = planOf(pool, full);
    if (!plan) return null;
    if (planBits(plan, plan.length, rules) >= floor) return plan;
    // Made longer only where each place adds something (Argon's B3: a pool the run limits leave one character a place).
    if (!lengthen || planBits(plan, plan.length + 1, rules) <= planBits(plan, plan.length, rules)) return null;
    // The shortest length that reaches the floor, a place at a time (each adds what the run limits leave of the pool).
    const longest = Math.min(maxLength, plan.fill);
    for (let needed = plan.length + 1; needed <= longest; needed++) if (planBits(plan, needed, rules) >= floor) return { ...plan, length: needed };
    return null;
  };
  const strong = reaching(preferred, false, false) ?? reaching(clean, false, true) ?? (onlyLookAlikes ? reaching(allowed, true, true) : null);
  if (strong) return strong;
  // Under the floor whatever's done: the clean pool (or only look-alikes, when that's all the rules allow), as long as
  // it can be. A pool of one character is no stronger for being longer.
  const pool = onlyLookAlikes ? allowed : clean;
  const plan = planOf(pool, onlyLookAlikes);
  if (!plan) return null;
  // A pool of one character (or one the run limits leave one of at a place) is no stronger for being longer.
  return planBits(plan, plan.length + 1, rules) > planBits(plan, plan.length, rules) ? { ...plan, length: Math.min(maxLength, plan.fill) } : plan;
}

/**
 * A password's strength as it was made for these rules (`planBits`, from the actual alphabet: the pool its free places
 * were drawn from, look-alikes left out where they were, and each forced place at its own class's bits).
 */
export function passwordBits(password: string, rules: PasswordRuleSet): number {
  const plan = planFor(rules);
  return plan ? planBits(plan, password.length, rules) : 0;
}

/** Whether a password made for these rules may be called strong (`STRONG_PASSWORD`). */
export const isStrongPassword = (password: string, rules: PasswordRuleSet): boolean =>
  password.length >= STRONG_PASSWORD.length && passwordBits(password, rules) >= STRONG_PASSWORD.bits;

/** The kinds of character a set holds, in words: `digits`, `letters and digits`, `letters, digits and symbols`. */
function kindsOf(chars: string): string | null {
  const kinds = [/[A-Za-z]/.test(chars) && 'letters', /[0-9]/.test(chars) && 'digits', [...SYMBOLS].some((c) => chars.includes(c)) && 'symbols'].filter((k): k is string => !!k);
  if (!kinds.length) return null;
  return kinds.length === 1 ? kinds[0]! : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`;
}

/** Why a password isn't strong, in words, for the row's second line: `Only 4 digits, as this site asks`. */
export function describeWeakPassword(password: string, rules: PasswordRuleSet): string {
  // The pool and the forced places' classes: a required 0 beside capitals is a digit too (review round 4 of #56).
  const plan = planFor(rules);
  const chars = plan ? plan.pool + plan.forced.join('') : '';
  return `Only ${password.length} ${kindsOf(chars) ?? 'characters'}, as this site asks`;
}

/**
 * In plain words, what a site's rules asked of a password (S17 §9, the owner's design 3A): its characters where they
 * were narrowed, its length where it was bounded, a symbol where one was required. `Letters and digits, 12–16, as this
 * site asks`. Null for Chord's own default, with nothing narrowed.
 */
export function describePasswordRules(source: PasswordRulesSource, rules: PasswordRuleSet): string | null {
  const allowed = rules.allowed.replace(/ /g, '');
  const letters = /[A-Za-z]/.test(allowed);
  const digits = /[0-9]/.test(allowed);
  const symbols = [...SYMBOLS].some((c) => allowed.includes(c));
  const all = [...ASCII_PRINTABLE.replace(' ', '')].every((c) => allowed.includes(c));
  const kinds = [letters && 'letters', digits && 'digits', symbols && 'symbols'].filter((k): k is string => !!k);
  // The default's own alphabet (no look-alikes, `-` only) is Chord's choice, not the site's.
  const chars = source === 'default' || all || kinds.length === 0 ? null : kinds.length === 1 ? kinds[0]! : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`;
  const min = rules.minLength;
  const max = rules.maxLength < PASSWORD_LIMITS.password ? rules.maxLength : null;
  const length = min > 0 && max !== null ? (min === max ? `${min}` : `${min}–${max}`) : min > 0 ? `at least ${min}` : max !== null ? `up to ${max}` : null;
  const symbol = rules.required.some((cls) => [...cls].every((c) => SYMBOLS.includes(c))) ? 'with a symbol' : null;
  const parts = [chars, length && (chars ? length : `${length} characters`), symbol].filter((p): p is string => !!p);
  if (!parts.length) return null;
  const text = `${parts.join(', ')}, as this site asks`;
  return text[0]!.toUpperCase() + text.slice(1);
}

/** The longest run of identical characters, and of characters in order (a-z, A-Z, 0-9, either way). */
function runs(password: string): { repeating: number; sequential: number } {
  let tail = NO_TAIL;
  let repeating = 0;
  let sequential = 0;
  for (const c of password) {
    tail = extend(tail, c);
    repeating = Math.max(repeating, tail.repeating);
    sequential = Math.max(sequential, tail.sequential);
  }
  return { repeating, sequential };
}

/** Whether a password meets a rule set: its length, its characters, each required class, the run limits. */
export function passwordSatisfies(password: string, rules: PasswordRuleSet): boolean {
  if (password.length < rules.minLength || password.length > rules.maxLength) return false;
  if (![...password].every((c) => rules.allowed.includes(c))) return false;
  if (!rules.required.every((cls) => [...password].some((c) => cls.includes(c)))) return false;
  const { repeating, sequential } = runs(password);
  if (rules.maxRepeating !== null && repeating > rules.maxRepeating) return false;
  if (rules.maxSequential !== null && sequential > rules.maxSequential) return false;
  return true;
}

/**
 * A password for a rule set, from `randomInt` (crypto's in main), or null when the rules can't be met. Its length is
 * the default's 20, within the rules' own (longer where that's what reaches the floor); its characters the default's
 * alphabet where the rules allow them, and never a look-alike where they allow anything else (`planFor`).
 */
export function generatePassword(rules: PasswordRuleSet, randomInt: RandomInt): string | null {
  const plan = drawable(rules);
  if (!plan) return null;
  const tries = Math.max(1, Math.min(TRIES, Math.floor(DRAW_BUDGET / (plan.length * 2))));
  for (let attempt = 0; attempt < tries; attempt++) {
    const password = drawWith(plan, rules, randomInt);
    if (password !== null) return password;
  }
  return null;
}

/** The plan a password is drawn by, or null when the rules can't be met. */
function drawable(rules: PasswordRuleSet): Plan | null {
  const plan = planFor(rules);
  if (!plan) return null;
  const allowed = rules.allowed.replace(/ /g, '');
  if (!rules.required.every((cls) => intersect(cls, allowed))) return null;
  return plan.forced.length > plan.length ? null : plan;
}

/** One try at a password by `plan`: the password, or null when this try broke the rules (another may not). */
function drawWith(plan: Plan, rules: PasswordRuleSet, randomInt: RandomInt): string | null {
  if (limitsRuns(rules)) return buildWith(plan, rules, randomInt);
  const { pool, length, forced } = plan;
  const pick = (from: string) => from[randomInt(from.length)]!;
  const chars = forced.map(pick);
  while (chars.length < length) chars.push(pick(pool));
  // Fisher–Yates, so the required characters are anywhere.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  const password = chars.join('');
  return passwordSatisfies(password, rules) ? password : null;
}

/**
 * One try under run limits (#60): where the forced places go first (shuffled, as `drawWith` shuffles them in), then
 * each place in turn from its class less the characters that would break a run there. Never a run too long, so no try
 * is thrown away for one; a try is lost only where a small class has nothing left (`stuckChance`).
 */
function buildWith(plan: Plan, rules: PasswordRuleSet, randomInt: RandomInt): string | null {
  const { pool, length, forced } = plan;
  const places = [...forced];
  while (places.length < length) places.push(pool);
  for (let i = places.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [places[i], places[j]] = [places[j]!, places[i]!];
  }
  let password = '';
  let tail = NO_TAIL;
  for (const cls of places) {
    const left = [...new Set(cls)].filter((c) => allows(extend(tail, c), rules));
    if (!left.length) return null;
    const c = left[randomInt(left.length)]!;
    password += c;
    tail = extend(tail, c);
  }
  return passwordSatisfies(password, rules) ? password : null;
}

/** Tests only (#60): one try, as `generatePassword` makes each, so every outcome of its random numbers can be counted. */
export function drawOnce(rules: PasswordRuleSet, randomInt: RandomInt): string | null {
  const plan = drawable(rules);
  return plan ? drawWith(plan, rules, randomInt) : null;
}
