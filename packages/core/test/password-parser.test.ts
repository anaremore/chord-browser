/*
 * Portions derived from Chromium, BSD-3-Clause.
 * Copyright 2018 The Chromium Authors. Use of this source code is governed by a BSD-style
 * license that can be found in Chromium's LICENSE file
 * (https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
 */

/**
 * Chromium's password form parser tests, transliterated, run against Chord's port
 * (password-parser.ts). Source:
 * `components/password_manager/core/browser/form_parsing/form_data_parser_unittest.cc` at
 * chromium/chromium@4e452b6233bdb0e5cbd67d8837a54cc3e407de91. Each `describe` is one upstream
 * TEST_F; each case keeps upstream's `description_for_logging`.
 *
 * The port has no server predictions, no model predictions, no UKM or UMA, no
 * `GetSignonRealm` and no URL check, so a case that sets `server_predicted_type`,
 * `model_predicted_type` or `is_server_override`, or whose point is one of those, is left out.
 * `form_has_autofilled_value` and `submission_event` aren't checked: the port has neither.
 * `is_enabled` is dropped: the port doesn't read it.
 *
 * Every upstream TEST_F, and what came over:
 *
 * - NotPasswordForm: both cases.
 * - SkipNotTextFields: the one case.
 * - OnlyPasswordFields: all 8 cases.
 * - TestFocusability: all 5 cases.
 * - TextAndPasswordFields: all 8 cases.
 * - TextFieldValueIsNotUsername: the one case.
 * - TestAutocomplete: all 10 cases.
 * - SkippingFieldsWithOTPAutocomplete: both cases.
 * - DisabledFields: the one case (`is_enabled` dropped; the case is that it's ignored).
 * - SkippingFieldsWithCreditCardFields: both cases.
 * - ReadonlyFields: all 5 cases.
 * - ServerPredictionsForClearTextPasswordFields: skipped, all 6 cases are server predictions.
 * - PasswordsWithLengthOneAreSavedOnlyOnManualFallback: skipped, its one case is server predictions.
 * - InferConfirmationPasswordField: 2 of 4; the 2 with server predictions skipped.
 * - ServerHints: 1 of 5 ("Empty server predictions don't cause panic"); 4 server predictions.
 * - Interactability: all 5 cases.
 * - AllAlternativePasswords: all 5 cases.
 * - UsernamePredictions: 4 of 5; "does not override server hints" is server predictions.
 * - ComplementingResults: 1 of 3; 2 server predictions.
 * - IgnoreCvcFields: 2 of 6 (by name); 4 server predictions.
 * - IgnoreIbanFields: skipped, both cases are server predictions.
 * - ServerHintsForCvcFieldsOverrideAutocomplete: skipped, both cases are server predictions.
 * - CCNumber: 1 of 3 (by name); 2 server predictions.
 * - SSN_and_OTP: both cases, for each of the 9 field names (18).
 * - OtpRegexMetric: skipped, a histogram (its form is SSN_and_OTP's first case).
 * - NotPasswordField, OneTimeCodeField, OneTimeCodeFieldNotUsername, NotUsernameField,
 *   NotUsernameFieldDespiteAutocompelteAtrribute, NotPasswordFieldDespiteAutocompleteAttribute,
 *   OneTimeCodeFieldDespiteAutocompleteAttribute: skipped, every case is server predictions.
 * - ReadonlyStatus: 5 of 6; "Server predictions prevent heuristics from using readonly" skipped.
 * - NoEmptyValues: 2 of 3; "Server hints overridden for non-empty values" skipped.
 * - MultipleUsernames, MultipleNewPasswords: skipped, every case is server predictions.
 * - HistogramsForUsernameDetectionMethod: 4 of 7, the ones without server predictions. The
 *   histogram records `UsernameDetectionMethod`, which the port returns as `usernameMethod`,
 *   so that is checked in its place (both modes, as the histogram expects two samples).
 * - SubmissionEvent: skipped, the port has no submission event.
 * - GetSignonRealm: skipped, not ported (main works out origins).
 * - TypedValues: all 3 cases.
 * - ContradictingPasswordServerPredictionAndAutocomplete: skipped, server predictions.
 * - SingleUsernameServerPrediction, BothSingleUsernameAndPassword: skipped, server predictions.
 * - InvalidURL: skipped, the port has no URL check.
 * - FindUsernameInHtmlParserResult_SkipPrediction: ported through `parsePasswordForm`
 *   (the port keeps `FindUsernameInHtmlParserResult` private): typed-into fields, predictions
 *   for "email" then "id".
 * - SkipHiddenValueField: all 3 forms.
 * - DontSkipNotHiddenValues: all 3 forms.
 * - AutocompleteAttributesError: both cases.
 * - UsernameWithTypePasswordAndServerPredictions: skipped, server predictions.
 * - AcceptsWebAuthnCredentials, SingleFieldAcceptsWebAuthnCredentials,
 *   AcceptsUsernameWebAuthnCredentials: the one case each.
 * - NoNewPasswordOnWebauthnForm: skipped, its one case is server predictions.
 * - UsernameFoundByServerPredictions: skipped, server predictions.
 * - BaseHeuristicsFindUsernameFieldWithStoredUsername: ported.
 * - PasswordFieldsWithMaxLength: both cases.
 * - ManualGenerationEnabledFields: both cases.
 * - ModelPredictions_Complete, ModelPredictions_Incomplete, ModelPredictionsHavePriority,
 *   ModelPredictions_ClearTextPasswordFields, ModelPredictionsAndManualOverrides,
 *   ModelPredictions_WebAuthnRationalization: skipped, model predictions.
 * - PasswordFieldIsMaskedMetric_Recorded, PasswordFieldIsMaskedMetric_NotRecorded,
 *   UnrelatedFieldsAnyFieldIsMaskedMetric_Recorded, UnrelatedFieldsAnyFieldIsMaskedMetric_NotRecorded:
 *   skipped, UKM and UMA (and model predictions).
 * - ConflictingUsernameAndPassword, ConflictingPasswordAndNewPasswordWithConfirmation,
 *   ConflictingPasswordAndNewPasswordWithoutConfirmation, ConflictingNewPasswordAndConfirmationPassword:
 *   skipped, server and model predictions.
 * - HeuristicsConflictSanitizesRole: the one case.
 */
import { describe, expect, it } from 'vitest';
import {
  parsePasswordForm,
  type AlternativeValue,
  type ParseMode,
  type PasswordField,
  type ReadonlyStatus,
  type UsernameMethod,
} from '../src/password-parser';

/** `ElementRole`. */
type Role = 'NONE' | 'USERNAME' | 'CURRENT_PASSWORD' | 'NEW_PASSWORD' | 'CONFIRMATION_PASSWORD' | 'WEBAUTHN';

/** `FieldDataDescription`. A missing `value`, `id` or `name` is `kNonimportantValue`: a unique stamped one. */
interface FieldDesc {
  readonly role?: Role;
  readonly roleFilling?: Role;
  readonly roleSaving?: Role;
  readonly focusable?: boolean;
  readonly readOnly?: boolean;
  /** `properties_mask = kUserTyped`. */
  readonly userTyped?: boolean;
  /** `properties_mask = kAutofilled` (or `kAutofilledOnPageLoad`, `kAutofilledOnUserTrigger`). */
  readonly autofilled?: boolean;
  readonly autocomplete?: string;
  readonly value?: string;
  readonly userInput?: string;
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
  readonly predictedUsername?: number;
  readonly maxLength?: number;
  /** Defaults to the field being `type=password`. */
  readonly manualGeneration?: boolean;
}

/** `FormParsingTestCase`. */
interface TestCase {
  readonly name: string;
  readonly fields: readonly FieldDesc[];
  readonly alternativePasswordCount?: number;
  readonly alternativeUsernameCount?: number;
  readonly alternativePasswords?: readonly AlternativeValue[];
  readonly alternativeUsernames?: readonly AlternativeValue[];
  readonly readonlyStatus?: ReadonlyStatus;
  readonly readonlyStatusForSaving?: ReadonlyStatus;
  readonly readonlyStatusForFilling?: ReadonlyStatus;
  readonly fallbackOnly?: boolean;
  readonly newPasswordReliable?: boolean;
  readonly acceptsWebauthn?: boolean;
  /** Chord: what HistogramsForUsernameDetectionMethod records, checked in both modes. */
  readonly usernameMethod?: UsernameMethod;
}

/** `ParseResultIds`. */
interface Expected {
  username: number | null;
  password: number | null;
  newPassword: number | null;
  confirmation: number | null;
  readonly webauthn: number[];
  readonly manualGeneration: number[];
}

/** Chromium's `kDefaultMaxLength`. */
const DEFAULT_MAX_LENGTH = 524288;

/** `renderer_id_counter_`: one per TEST_F, starting at 10, shared by keys and stamped strings. */
class Ids {
  private next = 10;
  unique(): number {
    return this.next++;
  }
  stamp(base: string): string {
    return `${base}_${this.unique()}`;
  }
}

const emptyExpected = (): Expected => ({ username: null, password: null, newPassword: null, confirmation: null, webauthn: [], manualGeneration: [] });

/** `UpdateResultWithIdByRole`. */
function setRole(into: Expected, key: number, role: Role | undefined): void {
  switch (role) {
    case 'USERNAME':
      into.username = key;
      break;
    case 'CURRENT_PASSWORD':
      into.password = key;
      break;
    case 'NEW_PASSWORD':
      into.newPassword = key;
      break;
    case 'CONFIRMATION_PASSWORD':
      into.confirmation = key;
      break;
    case 'WEBAUTHN':
      into.webauthn.push(key);
      break;
    default:
      break;
  }
}

interface Built {
  readonly fields: PasswordField[];
  readonly usernamePredictions: number[];
  readonly filling: Expected;
  readonly saving: Expected;
}

/** `GetFormDataAndExpectation`. */
function build(test: TestCase, ids: Ids): Built {
  const fields: PasswordField[] = [];
  const predictions: (number | undefined)[] = [];
  const filling = emptyExpected();
  const saving = emptyExpected();
  for (const d of test.fields) {
    const key = ids.unique();
    const id = d.id ?? ids.stamp('html_id');
    const name = d.name ?? ids.stamp('html_name');
    const value = d.value ?? ids.stamp('value');
    const type = d.type ?? 'text';
    fields.push({
      key,
      type,
      id,
      name,
      autocomplete: d.autocomplete ?? '',
      label: '',
      placeholder: '',
      maxLength: d.maxLength ?? DEFAULT_MAX_LENGTH,
      readOnly: d.readOnly ?? false,
      focusable: d.focusable ?? true,
      visible: d.focusable ?? true,
      userTyped: d.userTyped ?? false,
      autofilled: d.autofilled ?? false,
      value,
      ...(d.userInput ? { userInput: d.userInput } : {}),
    });
    if (d.role === undefined || d.role === 'NONE') {
      setRole(filling, key, d.roleFilling);
      setRole(saving, key, d.roleSaving);
    } else {
      setRole(filling, key, d.role);
      setRole(saving, key, d.role);
    }
    if (d.manualGeneration ?? type === 'password') {
      filling.manualGeneration.push(key);
      // Only non-empty fields are considered in the saving mode.
      if (d.value !== '') saving.manualGeneration.push(key);
    }
    if (d.predictedUsername !== undefined && d.predictedUsername >= 0) predictions[d.predictedUsername] = key;
  }
  // Unused ranks get fresh keys, which no field has.
  const usernamePredictions = Array.from(predictions, (k) => k ?? ids.unique());
  return { fields, usernamePredictions, filling, saving };
}

const isEmpty = (e: Expected) => e.username === null && e.password === null && e.newPassword === null && e.confirmation === null && e.webauthn.length === 0;

function expectUnique(values: readonly AlternativeValue[]): void {
  expect(new Set(values.map((v) => v.value)).size).toBe(values.length);
}

/** One case, in one mode: `CheckTestData`'s loop body. */
function check(test: TestCase, built: Built, mode: ParseMode, storedUsernames: ReadonlySet<string> = new Set()): void {
  const expected = mode === 'filling' ? built.filling : built.saving;
  const { form, readonlyStatus } = parsePasswordForm(built.fields, mode, { storedUsernames, usernamePredictions: built.usernamePredictions });
  if (isEmpty(expected)) {
    expect(form, 'expected no parsed results').toBeNull();
  } else {
    expect(form, 'expected successful parsing').not.toBeNull();
    if (!form) return;
    if (test.newPasswordReliable !== undefined && mode === 'filling') expect(form.isNewPasswordReliable, 'is_new_password_reliable').toBe(test.newPasswordReliable);
    expect(form.acceptsWebauthn, 'accepts_webauthn_credentials').toBe((test.acceptsWebauthn ?? false) && mode === 'filling');
    expect(form.username?.key ?? null, 'username').toBe(expected.username);
    expect(form.password?.key ?? null, 'password').toBe(expected.password);
    expect(form.newPassword?.key ?? null, 'new password').toBe(expected.newPassword);
    expect(form.confirmation?.key ?? null, 'confirmation').toBe(expected.confirmation);
    expect(form.manualGeneration, 'manual generation').toEqual(expect.arrayContaining(expected.manualGeneration));
    expectUnique(form.alternativePasswords);
    expectUnique(form.alternativeUsernames);
    if (test.alternativePasswordCount !== undefined) expect(form.alternativePasswords, 'all_alternative_passwords').toHaveLength(test.alternativePasswordCount);
    if (test.alternativePasswords) expect(form.alternativePasswords).toEqual(test.alternativePasswords);
    if (test.alternativeUsernameCount !== undefined) expect(form.alternativeUsernames, 'all_alternative_usernames').toHaveLength(test.alternativeUsernameCount);
    if (test.alternativeUsernames) expect(form.alternativeUsernames).toEqual(test.alternativeUsernames);
    if (mode === 'saving') expect(form.isFallback, 'fallback_only').toBe(test.fallbackOnly ?? false);
    if (test.usernameMethod) expect(form.usernameMethod, 'username detection method').toBe(test.usernameMethod);
  }
  const status = test.readonlyStatus ?? (mode === 'saving' ? test.readonlyStatusForSaving : test.readonlyStatusForFilling);
  if (status) expect(readonlyStatus, 'readonly status').toBe(status);
}

/** `CheckTestData`: each case parsed for filling and for saving. Pass `ids` to share a TEST_F's counter across calls. */
function checkTestData(tests: readonly TestCase[], ids: Ids = new Ids(), suffix = ''): void {
  for (const test of tests) {
    const built = build(test, ids);
    it(`${test.name}${suffix}`, () => {
      for (const mode of ['filling', 'saving'] as const) {
        try {
          check(test, built, mode);
        } catch (error) {
          if (error instanceof Error) error.message = `[${mode}] ${error.message}`;
          throw error;
        }
      }
    });
  }
}

describe('NotPasswordForm', () => {
  checkTestData([
    {
      name: 'No fields',
      fields: [],
    },
    {
      name: 'No password fields',
      fields: [
        {},
        {},
      ],
      alternativePasswordCount: 0,
      alternativeUsernameCount: 0,
    },
  ]);
});

describe('SkipNotTextFields', () => {
  checkTestData([
    {
      name: 'A \'select\' between username and password fields',
      fields: [
        { role: 'USERNAME' },
        { type: 'select' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      alternativePasswordCount: 1,
      alternativeUsernameCount: 1,
    },
  ]);
});

describe('OnlyPasswordFields', () => {
  checkTestData([
    {
      name: '1 password field',
      fields: [
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      alternativePasswordCount: 1,
      alternativeUsernameCount: 0,
    },
    {
      name: '2 password fields, new and confirmation password',
      fields: [
        { role: 'NEW_PASSWORD', value: 'pw', type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', value: 'pw', type: 'password' },
      ],
      newPasswordReliable: false,
    },
    {
      name: '2 password fields, current and new password',
      fields: [
        { role: 'CURRENT_PASSWORD', value: 'pw1', type: 'password' },
        { role: 'NEW_PASSWORD', value: 'pw2', type: 'password' },
      ],
      newPasswordReliable: false,
    },
    {
      name: '3 password fields, current, new, confirm password',
      fields: [
        { role: 'CURRENT_PASSWORD', value: 'pw1', type: 'password' },
        { role: 'NEW_PASSWORD', value: 'pw2', type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', value: 'pw2', type: 'password' },
      ],
      newPasswordReliable: false,
    },
    {
      name: '3 password fields with different values',
      fields: [
        { role: 'CURRENT_PASSWORD', value: 'pw1', type: 'password' },
        { value: 'pw2', type: 'password' },
        { value: 'pw3', type: 'password' },
      ],
      alternativePasswordCount: 3,
    },
    {
      name: '4 password fields, only the first 3 are considered',
      fields: [
        { role: 'CURRENT_PASSWORD', value: 'pw1', type: 'password' },
        { role: 'NEW_PASSWORD', value: 'pw2', type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', value: 'pw2', type: 'password' },
        { value: 'pw3', type: 'password' },
      ],
    },
    {
      name: '4 password fields, 4th same value as 3rd and 2nd, only the first 3 are considered',
      fields: [
        { role: 'CURRENT_PASSWORD', value: 'pw1', type: 'password' },
        { role: 'NEW_PASSWORD', value: 'pw2', type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', value: 'pw2', type: 'password' },
        { value: 'pw2', type: 'password' },
      ],
    },
    {
      name: '4 password fields, all same value',
      fields: [
        { role: 'CURRENT_PASSWORD', value: 'pw', type: 'password' },
        { value: 'pw', type: 'password' },
        { value: 'pw', type: 'password' },
        { value: 'pw', type: 'password' },
      ],
    },
  ]);
});

describe('TestFocusability', () => {
  checkTestData([
    {
      name: 'non-focusable fields are considered when there are no focusable fields',
      fields: [
        { role: 'CURRENT_PASSWORD', focusable: false, type: 'password' },
        { role: 'NEW_PASSWORD', focusable: false, type: 'password' },
      ],
    },
    {
      name: 'non-focusable should be skipped when there are focusable fields',
      fields: [
        { focusable: false, type: 'password' },
        { role: 'CURRENT_PASSWORD', focusable: true, type: 'password' },
      ],
    },
    {
      name: 'non-focusable text fields before password',
      fields: [
        { focusable: false },
        { role: 'USERNAME', focusable: false },
        { role: 'CURRENT_PASSWORD', focusable: true, type: 'password' },
      ],
      alternativeUsernameCount: 2,
    },
    {
      name: 'focusable and non-focusable text fields before password',
      fields: [
        { role: 'USERNAME', focusable: true },
        { focusable: false },
        { role: 'CURRENT_PASSWORD', focusable: true, type: 'password' },
      ],
    },
    {
      name: 'many passwords, some of them focusable',
      fields: [
        { focusable: false, type: 'password' },
        { role: 'CURRENT_PASSWORD', focusable: true, type: 'password' },
        { role: 'NEW_PASSWORD', focusable: true, value: 'pw', type: 'password' },
        { focusable: false, type: 'password' },
        { focusable: false, type: 'password' },
        { focusable: false, type: 'password' },
        { focusable: false, type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', focusable: true, value: 'pw', type: 'password' },
        { focusable: false, type: 'password' },
        { focusable: false, type: 'password' },
      ],
      alternativePasswordCount: 9,
    },
  ]);
});

describe('TextAndPasswordFields', () => {
  checkTestData([
    {
      name: 'Simple empty sign-in form',
      fields: [
        { roleFilling: 'USERNAME', value: '' },
        { roleFilling: 'CURRENT_PASSWORD', value: '', type: 'password' },
      ],
      alternativePasswordCount: 0,
      alternativeUsernameCount: 0,
    },
    {
      name: 'Simple sign-in form with filled data',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      alternativePasswordCount: 1,
    },
    {
      name: 'Empty sign-in form with an extra text field',
      fields: [
        { value: '' },
        { roleFilling: 'USERNAME', value: '' },
        { roleFilling: 'CURRENT_PASSWORD', value: '', type: 'password' },
      ],
    },
    {
      name: 'Non-empty sign-in form with an extra text field',
      fields: [
        { roleSaving: 'USERNAME' },
        { roleFilling: 'USERNAME', value: '' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Empty sign-in form with an extra invisible text field',
      fields: [
        { roleFilling: 'USERNAME', value: '' },
        { focusable: false, value: '' },
        { roleFilling: 'CURRENT_PASSWORD', value: '', type: 'password' },
      ],
    },
    {
      name: 'Non-empty sign-in form with an extra invisible text field',
      fields: [
        { role: 'USERNAME' },
        { focusable: false },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Simple empty sign-in form with empty username',
      fields: [
        { roleFilling: 'USERNAME', value: '' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Simple empty sign-in form with empty password',
      fields: [
        { roleFilling: 'USERNAME' },
        { roleFilling: 'CURRENT_PASSWORD', value: '', type: 'password' },
      ],
    },
  ]);
});

describe('TextFieldValueIsNotUsername', () => {
  checkTestData([
    {
      name: 'Text field value is unlikely username so it should be ignored on saving',
      fields: [
        { roleFilling: 'USERNAME', value: '12' },
        { role: 'CURRENT_PASSWORD', value: 'strong_pw', type: 'password' },
      ],
    },
  ]);
});

describe('TestAutocomplete', () => {
  checkTestData([
    {
      name: 'All alternative password autocomplete attributes and some fields without autocomplete',
      fields: [
        { role: 'USERNAME', autocomplete: 'username' },
        {},
        { type: 'password' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'np', type: 'password' },
        { type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', autocomplete: 'new-password', value: 'np', type: 'password' },
      ],
      alternativePasswordCount: 4,
      newPasswordReliable: true,
    },
    {
      name: 'Non-password autocomplete attributes are skipped',
      fields: [
        { autocomplete: 'email' },
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
        { role: 'NEW_PASSWORD', value: 'pw', type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', value: 'pw', type: 'password' },
        { autocomplete: 'password', type: 'password' },
      ],
      alternativePasswordCount: 3,
      alternativeUsernameCount: 2,
    },
    {
      name: 'Basic heuristics kick in if autocomplete analysis fails',
      fields: [
        { role: 'USERNAME', autocomplete: 'email' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'password', type: 'password' },
        { role: 'NEW_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Partial autocomplete analysis doesn\'t fail if no passwords are found',
      fields: [
        { role: 'USERNAME', autocomplete: 'username' },
        {},
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Multiple username autocomplete attributes, fallback to base heuristics',
      fields: [
        { autocomplete: 'username' },
        { autocomplete: 'username' },
        { role: 'USERNAME' },
        { type: 'password' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
      ],
    },
    {
      name: 'Parsing complex autocomplete attributes',
      fields: [
        { role: 'USERNAME', autocomplete: 'section-test billing username' },
        {},
        { role: 'CURRENT_PASSWORD', autocomplete: 'new-password current-password', type: 'password' },
        { type: 'password' },
      ],
    },
    {
      name: 'Ignored autocomplete attributes',
      fields: [
        { role: 'USERNAME', autocomplete: 'off' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'new-password abc', type: 'password' },
        { role: 'NEW_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Swapped username/password autocomplete attributes',
      fields: [
        { role: 'USERNAME', autocomplete: 'current-password' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
        { role: 'NEW_PASSWORD', autocomplete: 'username', type: 'password' },
      ],
    },
    {
      name: 'Autocomplete mark-up overrides visibility',
      fields: [
        { role: 'USERNAME', focusable: false, autocomplete: 'username' },
        { focusable: true },
        { focusable: true, type: 'password' },
        { role: 'CURRENT_PASSWORD', focusable: false, autocomplete: 'current-password', type: 'password' },
      ],
    },
    {
      name: 'Autocomplete single username',
      fields: [
        { role: 'USERNAME', focusable: false, autocomplete: 'username' },
      ],
    },
  ]);
});

describe('SkippingFieldsWithOTPAutocomplete', () => {
  checkTestData([
    {
      name: 'The only password field marked as OTP in autocomplete',
      fields: [
        { role: 'USERNAME', autocomplete: 'username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'one-time-code', type: 'password' },
      ],
      fallbackOnly: true,
    },
    {
      name: 'Non-OTP fields are considered',
      fields: [
        { role: 'USERNAME' },
        { autocomplete: 'one-time-code' },
        { autocomplete: 'one-time-code', type: 'password' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      alternativePasswordCount: 2,
    },
  ]);
});

describe('DisabledFields', () => {
  checkTestData([
    {
      name: 'The disabled attribute is ignored',
      fields: [
        {},
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
        { role: 'NEW_PASSWORD', type: 'password' },
      ],
      alternativePasswordCount: 2,
    },
  ]);
});

describe('SkippingFieldsWithCreditCardFields', () => {
  checkTestData([
    {
      name: 'Simple form, all fields are credit-card-related',
      fields: [
        { role: 'USERNAME', autocomplete: 'cc-name' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'cc-any-string', type: 'password' },
      ],
      fallbackOnly: true,
    },
    {
      name: 'Non-CC fields are considered',
      fields: [
        { role: 'USERNAME' },
        { autocomplete: 'cc-name' },
        { autocomplete: 'cc-any-string', type: 'password' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      alternativePasswordCount: 2,
    },
  ]);
});

describe('ReadonlyFields', () => {
  checkTestData([
    {
      name: 'For usernames, readonly does not matter',
      fields: [
        { role: 'USERNAME', readOnly: true },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'For passwords, readonly means: \'give up\', perhaps there is a virtual keyboard, filling might be ignored',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', readOnly: true, type: 'password' },
      ],
      fallbackOnly: true,
    },
    {
      name: 'But correctly marked passwords are accepted even if readonly',
      fields: [
        { role: 'USERNAME', autocomplete: 'username' },
        { role: 'NEW_PASSWORD', readOnly: true, autocomplete: 'new-password', value: 'newpass', type: 'password' },
        { role: 'CONFIRMATION_PASSWORD', readOnly: true, autocomplete: 'new-password', value: 'newpass', type: 'password' },
        { role: 'CURRENT_PASSWORD', readOnly: true, autocomplete: 'current-password', value: 'oldpass', type: 'password' },
      ],
      newPasswordReliable: true,
    },
    {
      name: 'And passwords already filled by user or Chrome on pageload are accepted even if readonly',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', readOnly: true, autofilled: true, type: 'password' },
        { role: 'NEW_PASSWORD', readOnly: true, userTyped: true, type: 'password' },
        { readOnly: true, type: 'password' },
      ],
      alternativePasswordCount: 3,
    },
    {
      name: 'And passwords already filled by user or Chrome with FOAS are accepted even if readonly',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', readOnly: true, autofilled: true, type: 'password' },
        { role: 'NEW_PASSWORD', readOnly: true, userTyped: true, type: 'password' },
        { readOnly: true, type: 'password' },
      ],
      alternativePasswordCount: 3,
    },
  ]);
});

describe('InferConfirmationPasswordField', () => {
  checkTestData([
    {
      name: 'Infer confirmation password during saving with auto-complete attribute.',
      fields: [
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'pw', type: 'password' },
        { roleSaving: 'CONFIRMATION_PASSWORD', autocomplete: 'off', value: 'pw', type: 'password' },
      ],
    },
    {
      name: 'Don\'t infer confirmation password during saving with autocomplete attribute and different passwords.',
      fields: [
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'pw1', type: 'password' },
        { role: 'NONE', value: 'pw2', type: 'password' },
      ],
    },
  ]);
});

describe('ServerHints', () => {
  checkTestData([
    {
      name: 'Empty server predictions don\'t cause panic',
      fields: [
        {},
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
  ]);
});

describe('Interactability', () => {
  checkTestData([
    {
      name: 'If all fields are hidden, all are considered',
      fields: [
        { focusable: false },
        { role: 'USERNAME', focusable: false },
        { role: 'CURRENT_PASSWORD', focusable: false, type: 'password' },
        { role: 'NEW_PASSWORD', focusable: false, type: 'password' },
      ],
    },
    {
      name: 'If some fields are hidden, only visible are considered',
      fields: [
        { role: 'USERNAME', focusable: true },
        { focusable: false },
        { focusable: false, type: 'password' },
        { role: 'CURRENT_PASSWORD', focusable: true, type: 'password' },
      ],
      alternativePasswordCount: 2,
    },
    {
      name: 'If user typed somewhere, only typed-into fields are considered, even if not currently visible',
      fields: [
        { role: 'USERNAME', focusable: false, userTyped: true },
        { focusable: true },
        { focusable: false, type: 'password' },
        { role: 'CURRENT_PASSWORD', focusable: true, autofilled: true, type: 'password' },
        { role: 'NEW_PASSWORD', focusable: true, userTyped: true, type: 'password' },
      ],
      alternativePasswordCount: 3,
    },
    {
      name: 'Interactability for usernames is only considered before the first relevant password. That way, if, e.g., the username gets filled and hidden (to let the user enter password), and there is another text field visible below, the maximum Interactability won\'t end up being kPossible, which would exclude the hidden username.',
      fields: [
        { role: 'USERNAME', focusable: false, autofilled: true },
        { role: 'CURRENT_PASSWORD', focusable: true, autofilled: true, type: 'password' },
        { focusable: true, value: '' },
      ],
    },
    {
      name: 'Interactability also matters for HTML classifier.',
      fields: [
        { focusable: false, predictedUsername: 0 },
        { role: 'USERNAME', focusable: true },
        { role: 'CURRENT_PASSWORD', focusable: true, type: 'password' },
      ],
    },
  ]);
});

describe('AllAlternativePasswords', () => {
  const kPasswords: AlternativeValue[] = [
    { value: 'password1', key: 10, name: 'p1' },
    { value: 'password2', key: 22, name: 'p3' },
  ];
  const kUsernames: AlternativeValue[] = [
    { value: 'username1', key: 12, name: 'chosen' },
    { value: 'username2', key: 17, name: 'first' },
  ];
  const [p0, p1] = kPasswords as [AlternativeValue, AlternativeValue];
  const [u0, u1] = kUsernames as [AlternativeValue, AlternativeValue];
  checkTestData([
    {
      name: 'It is always the first field name which is associated with a duplicated password value',
      fields: [
        { value: p0.value, name: p0.name, type: 'password' },
        { role: 'USERNAME', autocomplete: 'username', value: u0.value, name: u0.name },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', value: p0.value, type: 'password' },
        { value: u1.value, name: u1.name },
        { value: u1.value },
        { value: p1.value, name: p1.name, type: 'password' },
        { value: p1.value, type: 'password' },
      ],
      alternativePasswordCount: 2,
      alternativeUsernameCount: 2,
      alternativePasswords: kPasswords,
      alternativeUsernames: kUsernames,
    },
    {
      name: 'Empty values don\'t get added to all_alternative_passwords',
      fields: [
        { value: '', type: 'password' },
        { roleFilling: 'USERNAME', autocomplete: 'username', value: '' },
        { roleFilling: 'CURRENT_PASSWORD', autocomplete: 'current-password', value: '', type: 'password' },
        {},
        {},
        { value: '', type: 'password' },
        { value: '', type: 'password' },
      ],
      alternativePasswordCount: 0,
    },
    {
      name: 'Empty values don\'t get added to all_alternative_passwords even if form gets parsed',
      fields: [
        { value: '', type: 'password' },
        { role: 'USERNAME', autocomplete: 'username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
        {},
        {},
        { value: '', type: 'password' },
        { value: '', type: 'password' },
      ],
      alternativePasswordCount: 1,
    },
    {
      name: 'A particular type of a squashed form (sign-in + sign-up)',
      fields: [
        { role: 'USERNAME', autocomplete: 'username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
        {},
        {},
        { type: 'password' },
        { type: 'password' },
      ],
      alternativePasswordCount: 3,
    },
    {
      name: 'A strange but not squashed form',
      fields: [
        { role: 'CURRENT_PASSWORD', type: 'password' },
        {},
        {},
        { type: 'password' },
        { type: 'password' },
        { type: 'password' },
      ],
      alternativePasswordCount: 4,
    },
  ]);
});

describe('UsernamePredictions', () => {
  checkTestData([
    {
      name: 'Username prediction overrides structure',
      fields: [
        { role: 'USERNAME', predictedUsername: 0 },
        {},
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Username prediction does not override structure if empty and mode is SAVING',
      fields: [
        { roleFilling: 'USERNAME', value: '', predictedUsername: 2 },
        { roleSaving: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
    {
      name: 'Username prediction does not override autocomplete analysis',
      fields: [
        { predictedUsername: 0 },
        { role: 'USERNAME', autocomplete: 'username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
      ],
    },
    {
      name: 'Username prediction order matters',
      fields: [
        { role: 'USERNAME', predictedUsername: 1 },
        { predictedUsername: 4 },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
    },
  ]);
});

describe('ComplementingResults', () => {
  checkTestData([
    {
      name: 'Current password from autocomplete analysis, username from basic heuristics',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
      ],
    },
  ]);
});

describe('IgnoreCvcFields', () => {
  checkTestData([
    {
      name: 'Name of \'verification_type\' matches the CVC pattern, ignore that one.',
      fields: [
        { role: 'USERNAME' },
        { name: 'verification_type', type: 'password' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      fallbackOnly: false,
    },
    {
      name: 'Create a fallback for the only password being a CVC field.',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', name: 'verification_type', type: 'password' },
      ],
      fallbackOnly: true,
    },
  ]);
});

describe('CCNumber', () => {
  checkTestData([
    {
      name: 'Name of \'ccnumber\' matches the CC Number regex pattern (but there is no confirmation from the server), ignore that one.',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', name: 'ccnumber', type: 'password' },
      ],
    },
  ]);
});

describe('SSN_and_OTP', () => {
  const ids = new Ids();
  for (const fieldName of ['SocialSecurityNumber', 'OneTimePassword', 'SMS-token', 'otp-code', 'input_SMS', 'second.factor', '2FA', 'Sms{Otp}', 'login$$verif_vcode']) {
    checkTestData(
      [
        {
          name: 'Field name matches the SSN/OTP pattern,Ignore that one.',
          fields: [
            { role: 'USERNAME' },
            { name: fieldName, type: 'password' },
            { role: 'CURRENT_PASSWORD', type: 'password' },
          ],
          fallbackOnly: false,
        },
        {
          name: 'Create a fallback for the only password field being an SSN/OTP field.',
          fields: [
            { role: 'USERNAME' },
            { role: 'CURRENT_PASSWORD', name: fieldName, type: 'password' },
          ],
          fallbackOnly: true,
        },
      ],
      ids,
      ` (${fieldName})`,
    );
  }
});

describe('ReadonlyStatus', () => {
  checkTestData([
    {
      name: 'Autocomplete attributes prevent heuristics from using readonly.',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', readOnly: true, autocomplete: 'current-password', type: 'password' },
      ],
      readonlyStatus: 'no-heuristics',
    },
    {
      name: 'No password fields are a special case of not going through local heuristics.',
      fields: [
        {},
      ],
      readonlyStatus: 'no-heuristics',
    },
    {
      name: 'No readonly passwords ignored.',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', readOnly: true, autofilled: true, type: 'password' },
        { role: 'NEW_PASSWORD', readOnly: false, type: 'password' },
      ],
      readonlyStatus: 'none-ignored',
    },
    {
      name: 'Some readonly passwords ignored.',
      fields: [
        { role: 'USERNAME' },
        { readOnly: true, type: 'password' },
        { role: 'CURRENT_PASSWORD', readOnly: false, type: 'password' },
      ],
      readonlyStatus: 'some-ignored',
      fallbackOnly: false,
    },
    {
      name: 'All readonly passwords ignored, only returned as a fallback.',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', readOnly: true, type: 'password' },
      ],
      readonlyStatus: 'all-ignored',
      fallbackOnly: true,
    },
  ]);
});

describe('NoEmptyValues', () => {
  checkTestData([
    {
      name: 'Autocomplete attributes overridden for non-empty values.',
      fields: [
        { roleFilling: 'USERNAME', autocomplete: 'username', value: '' },
        { roleSaving: 'USERNAME' },
        { roleFilling: 'CURRENT_PASSWORD', autocomplete: 'current-password', value: '', type: 'password' },
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', type: 'password' },
      ],
      newPasswordReliable: true,
    },
    {
      name: 'Structure heuristics overridden for non-empty values.',
      fields: [
        { roleSaving: 'USERNAME' },
        { roleFilling: 'USERNAME', value: '' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
        { roleFilling: 'NEW_PASSWORD', value: '', type: 'password' },
      ],
    },
  ]);
});

describe('HistogramsForUsernameDetectionMethod', () => {
  // Skipped: "No username", "Reporting server analysis" and "Mixing server analysis on password
  // and HTML classifier on username is reported as HTML classifier" (server predictions).
  checkTestData([
    {
      name: 'Reporting autocomplete analysis',
      fields: [
        { role: 'USERNAME', autocomplete: 'username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
      ],
      usernameMethod: 'autocomplete',
    },
    {
      name: 'Reporting HTML classifier',
      fields: [
        { role: 'USERNAME', predictedUsername: 0 },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      usernameMethod: 'html',
    },
    {
      name: 'Reporting basic heuristics',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', type: 'password' },
      ],
      usernameMethod: 'base',
    },
    {
      name: 'Mixing autocomplete analysis on password and basic heuristics on username is reported as basic heuristics',
      fields: [
        { role: 'USERNAME' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', type: 'password' },
      ],
      usernameMethod: 'base',
    },
  ]);
});

describe('TypedValues', () => {
  checkTestData([
    {
      name: 'Form with changed by JavaScript values',
      fields: [
        { role: 'USERNAME', autocomplete: 'username', value: 'js_username', userInput: 'typed_username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', value: 'js_password', userInput: 'typed_password', type: 'password' },
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'js_new_password', userInput: 'typed_new_password', type: 'password' },
      ],
    },
    {
      name: 'Form with cleared by JavaScript values',
      fields: [
        { role: 'USERNAME', autocomplete: 'username', value: '', userInput: 'typed_username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', value: '', userInput: 'typed_password', type: 'password' },
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: '', userInput: 'typed_new_password', type: 'password' },
      ],
    },
    {
      name: 'Form autocomplete with cleared by JavaScript values',
      fields: [
        { role: 'USERNAME', value: '', userInput: 'typed_username' },
        { role: 'CURRENT_PASSWORD', autocomplete: 'current-password', value: '', userInput: 'typed_password', type: 'password' },
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: '', userInput: 'typed_new_password', type: 'password' },
      ],
    },
  ]);
});

describe('FindUsernameInHtmlParserResult_SkipPrediction', () => {
  // Searching username field should skip prediction that is less likely to be user
  // interaction. For example, if a field has no user input while others have, the field
  // cannot be an username field. Upstream calls FindUsernameInHtmlParserResult with
  // Interactability::kCertain; here the typed-into fields make that the bar.
  it('skips a prediction for a field you did not type in', () => {
    const ids = new Ids();
    const { fields } = build(
      {
        name: '',
        fields: [
          { name: 'username' },
          { name: 'email' },
          { name: 'id', userTyped: true },
          { name: 'password', type: 'password', userTyped: true },
          { name: 'submit' },
        ],
      },
      ids,
    );
    const [, email, id] = fields as [PasswordField, PasswordField, PasswordField];
    // "email" is in front of "id", so more reliable; the username is still "id".
    const { form } = parsePasswordForm(fields, 'filling', { usernamePredictions: [email.key, id.key] });
    expect(form?.username?.name).toBe('id');
  });
});

describe('SkipHiddenValueField', () => {
  // The form parser is not considering fields with values consisting of one repeated non
  // alphanumeric symbol for saving.
  const ids = new Ids();
  for (const hidden of ['***********', '**', '••••••••']) {
    it(`a password of ${hidden}`, () => {
      const { fields } = build({ name: '', fields: [{ value: 'foo', name: 'username' }, { value: hidden, name: 'password', type: 'password' }] }, ids);
      expect(parsePasswordForm(fields, 'filling').form).not.toBeNull();
      expect(parsePasswordForm(fields, 'saving').form).toBeNull();
    });
  }
});

describe('DontSkipNotHiddenValues', () => {
  const ids = new Ids();
  for (const shown of ['a*******a', '.....*****', '0 0 0 0 0']) {
    it(`a password of ${shown}`, () => {
      const { fields } = build({ name: '', fields: [{ value: 'foo', name: 'username' }, { value: shown, name: 'password', type: 'password' }] }, ids);
      expect(parsePasswordForm(fields, 'filling').form).not.toBeNull();
      expect(parsePasswordForm(fields, 'saving').form).not.toBeNull();
    });
  }
});

describe('AutocompleteAttributesError', () => {
  checkTestData([
    {
      name: 'Wrong autocomplete attributes, 2 fields.',
      fields: [
        { roleFilling: 'NEW_PASSWORD', roleSaving: 'CURRENT_PASSWORD', autocomplete: 'new-password', value: 'oldpass', name: 'password1', type: 'password' },
        { roleFilling: 'CONFIRMATION_PASSWORD', roleSaving: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'newpass', name: 'password2', type: 'password' },
      ],
    },
    {
      name: 'Wrong autocomplete attributes, 3 fields.',
      fields: [
        { roleFilling: 'NEW_PASSWORD', roleSaving: 'CURRENT_PASSWORD', autocomplete: 'new-password', value: 'oldpass', name: 'password1', type: 'password' },
        { roleFilling: 'CONFIRMATION_PASSWORD', roleSaving: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'newpass', name: 'password2', type: 'password' },
        { roleSaving: 'CONFIRMATION_PASSWORD', autocomplete: 'new-password', value: 'newpass', name: 'password3', type: 'password' },
      ],
    },
  ]);
});

describe('AcceptsWebAuthnCredentials', () => {
  checkTestData([
    {
      name: 'Field tagged with autofill="webauthn"',
      fields: [
        { role: 'USERNAME', autocomplete: 'webauthn', value: 'rosalina', name: 'username' },
        { role: 'CURRENT_PASSWORD', value: 'luma', name: 'password', type: 'password' },
      ],
      acceptsWebauthn: true,
    },
  ]);
});

describe('SingleFieldAcceptsWebAuthnCredentials', () => {
  checkTestData([
    {
      name: 'Single field tagged with autofill="webauthn"',
      fields: [
        { roleFilling: 'WEBAUTHN', autocomplete: 'webauthn', value: 'rosalina', name: 'username' },
      ],
      acceptsWebauthn: true,
    },
  ]);
});

describe('AcceptsUsernameWebAuthnCredentials', () => {
  checkTestData([
    {
      name: 'Field tagged with autocomplete="username webauthn"',
      fields: [
        { role: 'USERNAME', autocomplete: 'username webauthn', value: 'rosalina', name: 'username' },
        { role: 'CURRENT_PASSWORD', value: 'luma', name: 'password', type: 'password' },
      ],
      acceptsWebauthn: true,
    },
  ]);
});

describe('BaseHeuristicsFindUsernameFieldWithStoredUsername', () => {
  it('a stored username wins', () => {
    const kUsername = 'the_username';
    // CreateField: only a type, a value and a renderer id.
    const field = (key: number, type: string, value: string): PasswordField => ({
      key,
      type,
      id: '',
      name: '',
      autocomplete: '',
      label: '',
      placeholder: '',
      maxLength: DEFAULT_MAX_LENGTH,
      readOnly: false,
      focusable: true,
      visible: true,
      userTyped: false,
      autofilled: false,
      value,
    });
    const fields = [field(1, 'text', kUsername), field(2, 'text', ''), field(3, 'password', '')];
    const { form } = parsePasswordForm(fields, 'filling', { storedUsernames: new Set([kUsername]) });
    expect(form).not.toBeNull();
    expect(form?.usernameMethod).toBe('base');
    expect(form?.username?.value).toBe(kUsername);
    expect(form?.username?.key).toBe(1);
  });
});

describe('PasswordFieldsWithMaxLength', () => {
  checkTestData([
    {
      name: 'New password with maxlength attr sufficient for password generation',
      fields: [
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'LoooongStrooongPassword', type: 'password', maxLength: 13 },
      ],
      newPasswordReliable: true,
    },
    {
      name: 'New password with small maxlength attr',
      fields: [
        { role: 'NEW_PASSWORD', autocomplete: 'new-password', value: 'Short', type: 'password', maxLength: 5 },
      ],
      newPasswordReliable: false,
    },
  ]);
});

describe('ManualGenerationEnabledFields', () => {
  const ids = new Ids();
  checkTestData(
    [
      {
        name: 'Fields with variations of the word password are eligible for manual password generation.',
        fields: [{ name: 'password', manualGeneration: true }],
      },
    ],
    ids,
  );
  checkTestData(
    [
      {
        name: 'One field must be classified as password while others must be eligible for manual password generation.',
        fields: [
          { role: 'CURRENT_PASSWORD', value: 'helloworld', name: 'password1', type: 'password' },
          { name: 'password2', type: 'password', manualGeneration: true },
          { name: 'password3', type: 'password', manualGeneration: true },
        ],
      },
    ],
    ids,
  );
});

describe('HeuristicsConflictSanitizesRole', () => {
  checkTestData([
    {
      name: 'Conflicting heuristic prediction (PASSWORD) and HTML context prediction (USERNAME) on the same field.',
      fields: [
        { role: 'CURRENT_PASSWORD', type: 'password', predictedUsername: 0 },
        { role: 'NEW_PASSWORD', type: 'password' },
      ],
    },
  ]);
});
