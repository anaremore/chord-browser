/*
 * Portions derived from Apple's password-manager-resources, MIT.
 * Copyright (c) 2019 - 2026 Apple Inc. Licensed under MIT License
 * (LICENSES/MIT-Apple-password-manager-resources.txt).
 */

/**
 * Apple's password rules parser, transliterated (S17 §6, *Generating*), at
 * apple/password-manager-resources@410bea26abe112dc3fe161a35e936e824316afdb (main, 2026-11-17):
 * `tools/PasswordRulesParser/PasswordRulesParser.js`, `parsePasswordRules` and what it calls.
 *
 * The rules language is what a field's `passwordrules` attribute holds (a Safari proposal, still
 * open at WHATWG) and what `quirks/password-rules.json` holds by site:
 * `minlength: 8; maxlength: 20; required: lower; required: digit; allowed: [-_.];`.
 *
 * Changed from the original only as a port needs: types; no `console` (a page's rules aren't
 * worth a log line, and nothing here sees a password); no HTML output (`toHTMLString`), which
 * Chord never shows. Character classes are kept as arrays of single ASCII characters, as there.
 * Pure functions: the passwords agent doesn't load this, main does (the generator).
 */

export type PasswordRuleIdentifier = 'ascii-printable' | 'digit' | 'lower' | 'special' | 'unicode' | 'upper';

const IDENTIFIERS: readonly PasswordRuleIdentifier[] = ['ascii-printable', 'digit', 'lower', 'special', 'unicode', 'upper'];

type PasswordRuleName = 'allowed' | 'max-consecutive' | 'max-repeating' | 'max-sequential' | 'required' | 'minlength' | 'maxlength';

const RULE_NAMES: readonly PasswordRuleName[] = ['allowed', 'max-consecutive', 'max-repeating', 'max-sequential', 'required', 'minlength', 'maxlength'];

/** A named class (`lower`, `digit`…). */
export class NamedCharacterClass {
  constructor(private readonly identifier: string) {}
  get name(): PasswordRuleIdentifier {
    return this.identifier.toLowerCase() as PasswordRuleIdentifier;
  }
  toString(): string {
    return this.identifier;
  }
}

/** A class written out: `[-_.!]`, each member one ASCII printable character. */
export class CustomCharacterClass {
  constructor(readonly characters: readonly string[]) {}
  toString(): string {
    return `[${this.characters.join('')}]`;
  }
}

export type CharacterClass = NamedCharacterClass | CustomCharacterClass;

export type PasswordRule =
  | { readonly name: 'required' | 'allowed'; value: CharacterClass[] }
  | { readonly name: 'max-consecutive' | 'max-repeating' | 'max-sequential' | 'minlength' | 'maxlength'; value: number };

/** A rule as parsed, before its value is checked: null for an empty or bad value. */
type RawRule = { name: PasswordRuleName; value: CharacterClass[] | number | null };

const CHARACTER_CLASS_START_SENTINEL = '[';
const CHARACTER_CLASS_END_SENTINEL = ']';
const PROPERTY_VALUE_SEPARATOR = ',';
const PROPERTY_SEPARATOR = ';';
const PROPERTY_VALUE_START_SENTINEL = ':';

const SPACE_CODE_POINT = ' '.codePointAt(0)!;

// MARK: Lexer functions

const isIdentifierCharacter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '-');
const isASCIIDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isASCIIPrintableCharacter = (c: string): boolean => c >= ' ' && c <= '~';
const isASCIIWhitespace = (c: string | undefined): boolean => c === ' ' || c === '\f' || c === '\n' || c === '\r' || c === '\t';

// MARK: ASCII printable character bit set and canonicalization functions

const bitSetIndexForCharacter = (c: string): number => c.codePointAt(0)! - SPACE_CODE_POINT;
const characterAtBitSetIndex = (index: number): string => String.fromCodePoint(index + SPACE_CODE_POINT);

function markBitsForNamedCharacterClass(bitSet: boolean[], namedCharacterClass: NamedCharacterClass): void {
  const fill = (from: string, to: string) => bitSet.fill(true, bitSetIndexForCharacter(from), bitSetIndexForCharacter(to) + 1);
  switch (namedCharacterClass.name) {
    case 'upper':
      return void fill('A', 'Z');
    case 'lower':
      return void fill('a', 'z');
    case 'digit':
      return void fill('0', '9');
    case 'special':
      fill(' ', '/');
      fill(':', '@');
      fill('[', '`');
      fill('{', '~');
      return;
    default:
      // `unicode` and `ascii-printable` are taken care of by the caller.
      return;
  }
}

function markBitsForCustomCharacterClass(bitSet: boolean[], customCharacterClass: CustomCharacterClass): void {
  for (const character of customCharacterClass.characters) bitSet[bitSetIndexForCharacter(character)] = true;
}

/**
 * A custom character class is only valid when '-' is its first member, when present in the class, and ']' its last,
 * when present in the set. Canonicalization therefore always hoists them (Apple's #1841).
 */
function canonicalizedPropertyValues(propertyValues: readonly CharacterClass[]): CharacterClass[] {
  const asciiPrintableBitSet: boolean[] = new Array<boolean>('~'.codePointAt(0)! - ' '.codePointAt(0)! + 1).fill(false);

  for (const propertyValue of propertyValues) {
    if (propertyValue instanceof NamedCharacterClass) {
      if (propertyValue.name === 'unicode') return [new NamedCharacterClass('unicode')];
      if (propertyValue.name === 'ascii-printable') return [new NamedCharacterClass('ascii-printable')];
      markBitsForNamedCharacterClass(asciiPrintableBitSet, propertyValue);
    } else {
      markBitsForCustomCharacterClass(asciiPrintableBitSet, propertyValue);
    }
  }

  let charactersSeen: string[] = [];

  const checkRange = (start: string, end: string): boolean => {
    const temp: string[] = [];
    for (let i = bitSetIndexForCharacter(start); i <= bitSetIndexForCharacter(end); ++i) {
      if (asciiPrintableBitSet[i]) temp.push(characterAtBitSetIndex(i));
    }
    const result = temp.length === bitSetIndexForCharacter(end) - bitSetIndexForCharacter(start) + 1;
    if (!result) charactersSeen = charactersSeen.concat(temp);
    return result;
  };

  const hasAllUpper = checkRange('A', 'Z');
  const hasAllLower = checkRange('a', 'z');
  const hasAllDigits = checkRange('0', '9');

  // Special characters, with '-' and ']' given their places.
  let hasDash = false;
  let hasRightSquareBracket = false;
  const temp: string[] = [];
  for (let i = bitSetIndexForCharacter(' '); i <= bitSetIndexForCharacter('/'); ++i) {
    if (!asciiPrintableBitSet[i]) continue;
    const character = characterAtBitSetIndex(i);
    if (character === '-') hasDash = true;
    else temp.push(character);
  }
  for (let i = bitSetIndexForCharacter(':'); i <= bitSetIndexForCharacter('@'); ++i) {
    if (asciiPrintableBitSet[i]) temp.push(characterAtBitSetIndex(i));
  }
  for (let i = bitSetIndexForCharacter('['); i <= bitSetIndexForCharacter('`'); ++i) {
    if (!asciiPrintableBitSet[i]) continue;
    const character = characterAtBitSetIndex(i);
    if (character === ']') hasRightSquareBracket = true;
    else temp.push(character);
  }
  for (let i = bitSetIndexForCharacter('{'); i <= bitSetIndexForCharacter('~'); ++i) {
    if (asciiPrintableBitSet[i]) temp.push(characterAtBitSetIndex(i));
  }
  if (hasDash) temp.unshift('-');
  if (hasRightSquareBracket) temp.push(']');

  const numberOfSpecialCharacters =
    bitSetIndexForCharacter('/') -
    bitSetIndexForCharacter(' ') +
    1 +
    (bitSetIndexForCharacter('@') - bitSetIndexForCharacter(':') + 1) +
    (bitSetIndexForCharacter('`') - bitSetIndexForCharacter('[') + 1) +
    (bitSetIndexForCharacter('~') - bitSetIndexForCharacter('{') + 1);
  const hasAllSpecial = temp.length === numberOfSpecialCharacters;
  if (!hasAllSpecial) charactersSeen = charactersSeen.concat(temp);

  const result: CharacterClass[] = [];
  if (hasAllUpper && hasAllLower && hasAllDigits && hasAllSpecial) return [new NamedCharacterClass('ascii-printable')];
  if (hasAllUpper) result.push(new NamedCharacterClass('upper'));
  if (hasAllLower) result.push(new NamedCharacterClass('lower'));
  if (hasAllDigits) result.push(new NamedCharacterClass('digit'));
  if (hasAllSpecial) result.push(new NamedCharacterClass('special'));
  if (charactersSeen.length) result.push(new CustomCharacterClass(charactersSeen));
  return result;
}

// MARK: Parser functions

function indexOfNonWhitespaceCharacter(input: string, position = 0): number {
  const length = input.length;
  while (position < length && isASCIIWhitespace(input[position])) ++position;
  return position;
}

function parseIdentifier(input: string, position: number): [string, number] {
  const length = input.length;
  const seenIdentifiers: string[] = [];
  do {
    const c = input[position];
    if (!isIdentifierCharacter(c)) break;
    seenIdentifiers.push(c!);
    ++position;
  } while (position < length);
  return [seenIdentifiers.join(''), position];
}

const isValidRequiredOrAllowedPropertyValueIdentifier = (identifier: string): boolean => !!identifier && (IDENTIFIERS as readonly string[]).includes(identifier.toLowerCase());

function parseCustomCharacterClass(input: string, position: number): [string[] | null, number] {
  const length = input.length;
  ++position;
  if (position >= length) return [null, position];

  const initialPosition = position;
  const result: string[] = [];
  do {
    const c = input[position]!;
    if (!isASCIIPrintableCharacter(c)) {
      ++position;
      continue;
    }
    // A '-' may only appear as the first character in a character class.
    if (c === '-' && position - initialPosition > 0) {
      ++position;
      continue;
    }
    result.push(c);
    ++position;
    if (c === CHARACTER_CLASS_END_SENTINEL) break;
  } while (position < length);

  if ((position < length && input[position] !== CHARACTER_CLASS_END_SENTINEL) || (position === length && input[position - 1] === CHARACTER_CLASS_END_SENTINEL)) {
    // Over consumed: the ']' just taken ends the class.
    result.pop();
    return [result, position];
  }
  if (position < length && input[position] === CHARACTER_CLASS_END_SENTINEL) return [result, position + 1];
  // End of line instead of the end of the class.
  return [null, position];
}

function parsePasswordRequiredOrAllowedPropertyValue(input: string, position: number): [CharacterClass[] | null, number] {
  const length = input.length;
  const propertyValues: CharacterClass[] = [];
  while (true) {
    if (isIdentifierCharacter(input[position])) {
      const identifierStartPosition = position;
      const [propertyValue, next] = parseIdentifier(input, position);
      position = next;
      if (!isValidRequiredOrAllowedPropertyValueIdentifier(propertyValue)) return [null, identifierStartPosition];
      propertyValues.push(new NamedCharacterClass(propertyValue));
    } else if (input[position] === CHARACTER_CLASS_START_SENTINEL) {
      const [propertyValue, next] = parseCustomCharacterClass(input, position);
      position = next;
      if (propertyValue && propertyValue.length) propertyValues.push(new CustomCharacterClass(propertyValue));
    } else {
      return [null, position];
    }

    position = indexOfNonWhitespaceCharacter(input, position);
    if (position >= length || input[position] === PROPERTY_SEPARATOR) break;

    if (input[position] === PROPERTY_VALUE_SEPARATOR) {
      position = indexOfNonWhitespaceCharacter(input, position + 1);
      if (position >= length) return [null, position];
      continue;
    }
    return [null, position];
  }
  return [propertyValues, position];
}

function parseInteger(input: string, position: number): [number | null, number] {
  if (!isASCIIDigit(input[position])) return [null, position];
  const length = input.length;
  let result = 0;
  do {
    result = 10 * result + parseInt(input[position]!, 10);
    // Past Number.MAX_SAFE_INTEGER: ignored, and the rest of its digits skipped, so the other statements still count.
    if (result > Number.MAX_SAFE_INTEGER) {
      while (position < length && isASCIIDigit(input[position])) ++position;
      return [null, position];
    }
    ++position;
  } while (position < length && input[position] !== PROPERTY_SEPARATOR && isASCIIDigit(input[position]));

  position = indexOfNonWhitespaceCharacter(input, position);
  if (position >= length || input[position] === PROPERTY_SEPARATOR) return [result, position];
  return [null, position];
}

function parsePasswordRule(input: string, position: number): [RawRule | null, number] {
  const length = input.length;
  const mayBeIdentifierStartPosition = position;
  const [identifier, afterIdentifier] = parseIdentifier(input, position);
  position = afterIdentifier;
  if (!(RULE_NAMES as readonly string[]).includes(identifier)) return [null, mayBeIdentifierStartPosition];
  const name = identifier as PasswordRuleName;
  if (position >= length) return [null, position];
  if (input[position] !== PROPERTY_VALUE_START_SENTINEL) return [null, position];

  position = indexOfNonWhitespaceCharacter(input, position + 1);
  // An empty value.
  if (position >= length || input[position] === PROPERTY_SEPARATOR) return [{ name, value: null }, position];

  switch (name) {
    case 'allowed':
    case 'required': {
      const [value, next] = parsePasswordRequiredOrAllowedPropertyValue(input, position);
      return [{ name, value }, next];
    }
    case 'max-consecutive':
    case 'max-repeating':
    case 'max-sequential':
    case 'minlength':
    case 'maxlength': {
      const [value, next] = parseInteger(input, position);
      // Apple's `if (propertyValue)`: a 0 is no value.
      return [{ name, value: value ? value : null }, next];
    }
  }
}

/** Each statement with a value, in order; null when a statement can't be told from the next. */
function parsePasswordRulesInternal(input: string): RawRule[] | null {
  const parsedProperties: RawRule[] = [];
  const length = input.length;

  let position = indexOfNonWhitespaceCharacter(input);
  while (position < length) {
    if (!isIdentifierCharacter(input[position])) return parsedProperties;

    const [parsedProperty, next] = parsePasswordRule(input, position);
    position = next;
    // Apple's `parsedProperty.value` truthiness: an empty class list (`required: []`) counts, a 0 doesn't (it's null).
    if (parsedProperty && parsedProperty.value !== null) parsedProperties.push(parsedProperty);

    position = indexOfNonWhitespaceCharacter(input, position);
    if (position >= length) break;

    if (input[position] === PROPERTY_SEPARATOR) {
      position = indexOfNonWhitespaceCharacter(input, position + 1);
      if (position >= length) return parsedProperties;
      continue;
    }
    return null;
  }
  return parsedProperties;
}

/**
 * Whether the rules say anything at all: a statement with a value. `parsePasswordRules` answers even an empty or
 * unreadable string (with `allowed: ascii-printable`), so a caller choosing among sources asks this first.
 */
export function passwordRulesSaySomething(input: string): boolean {
  return (parsePasswordRulesInternal(input) ?? []).length > 0;
}

/**
 * Apple's `parsePasswordRules`: the statements canonicalized and merged, the required classes copied into the allowed
 * ones (`formatRulesForMinifiedVersion` false), and at most one of each limit (the strictest).
 */
export function parsePasswordRules(input: string, formatRulesForMinifiedVersion = false): PasswordRule[] {
  const passwordRules = parsePasswordRulesInternal(input) ?? [];

  // Formatting for the minified version keeps the rules close to the input: required classes aren't copied to allowed.
  const suppressCopyingRequiredToAllowed = formatRulesForMinifiedVersion;

  const newPasswordRules: PasswordRule[] = [];
  let newAllowedValues: CharacterClass[] = [];
  let minimumMaximumConsecutiveCharacters: number | null = null;
  let minimumMaxRepeating: number | null = null;
  let minimumMaxSequential: number | null = null;
  let maximumMinLength = 0;
  let minimumMaxLength: number | null = null;

  for (const rule of passwordRules) {
    switch (rule.name) {
      case 'max-consecutive':
        minimumMaximumConsecutiveCharacters = minimumMaximumConsecutiveCharacters ? Math.min(rule.value as number, minimumMaximumConsecutiveCharacters) : (rule.value as number);
        break;
      case 'max-repeating':
        minimumMaxRepeating = minimumMaxRepeating ? Math.min(rule.value as number, minimumMaxRepeating) : (rule.value as number);
        break;
      case 'max-sequential':
        minimumMaxSequential = minimumMaxSequential ? Math.min(rule.value as number, minimumMaxSequential) : (rule.value as number);
        break;
      case 'minlength':
        maximumMinLength = Math.max(rule.value as number, maximumMinLength);
        break;
      case 'maxlength':
        minimumMaxLength = minimumMaxLength ? Math.min(rule.value as number, minimumMaxLength) : (rule.value as number);
        break;
      case 'required': {
        const value = canonicalizedPropertyValues(rule.value as CharacterClass[]);
        newPasswordRules.push({ name: 'required', value });
        if (!suppressCopyingRequiredToAllowed) newAllowedValues = newAllowedValues.concat(value);
        break;
      }
      case 'allowed':
        newAllowedValues = newAllowedValues.concat(rule.value as CharacterClass[]);
        break;
    }
  }

  newAllowedValues = canonicalizedPropertyValues(newAllowedValues);
  if (!suppressCopyingRequiredToAllowed && !newAllowedValues.length) newAllowedValues = [new NamedCharacterClass('ascii-printable')];
  if (newAllowedValues.length) newPasswordRules.push({ name: 'allowed', value: newAllowedValues });

  if (minimumMaximumConsecutiveCharacters !== null) newPasswordRules.push({ name: 'max-consecutive', value: minimumMaximumConsecutiveCharacters });
  if (minimumMaxRepeating !== null) newPasswordRules.push({ name: 'max-repeating', value: minimumMaxRepeating });
  if (minimumMaxSequential !== null) newPasswordRules.push({ name: 'max-sequential', value: minimumMaxSequential });
  if (maximumMinLength > 0) newPasswordRules.push({ name: 'minlength', value: maximumMinLength });
  if (minimumMaxLength !== null) newPasswordRules.push({ name: 'maxlength', value: minimumMaxLength });

  return newPasswordRules;
}
