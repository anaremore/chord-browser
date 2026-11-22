/*
 * Portions derived from Chromium, BSD-3-Clause.
 * Copyright 2013 The Chromium Authors. Use of this source code is governed by a BSD-style
 * license that can be found in Chromium's LICENSE file
 * (https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
 *
 * Portions derived from duckduckgo-autofill, Apache-2.0.
 * Copyright (c) 2021 Duck Duck Go, Inc. Licensed under the Apache License, Version 2.0
 * (LICENSES/Apache-2.0.txt). Chord's changes: only the credential matchers are taken, as
 * JavaScript regular expressions, with the comments shortened.
 */

/**
 * The words the password detector reads fields by (S17 §3, §4). Data only, with no logic,
 * so a yearly diff against upstream is a diff of this file.
 *
 * - Chromium's regexes come from `components/password_manager/core/common/password_manager_constants.h`
 *   and `components/autofill/core/common/autofill_regex_constants.h` (`kCardCvcRe`). Its
 *   username word lists come from `components/autofill/content/renderer/html_based_username_detector_vocabulary.h`.
 *   All at chromium/chromium@4e452b6233bdb0e5cbd67d8837a54cc3e407de91 (main, 2026-11-15).
 * - DuckDuckGo's credential matchers come from `src/Form/matching-config/matching-config-source.js`
 *   (`ddgMatcher`) at duckduckgo/duckduckgo-autofill@4d5848619462c863d6bb7553cb090fc74b172be2
 *   (release 19.2.1, 2026-10-12). They cover what Chromium's vocabulary is thin on: the
 *   password's variant, and odd `type=password` fields.
 */

/** Chromium's `MatchesRegex`: case-insensitive, Unicode. */
const icu = (source: string) => new RegExp(source, 'iu');

// ----- Chromium: password_manager_constants.h -----

/** `kSocialSecurityRe`. */
export const SOCIAL_SECURITY_RE = icu('ssn|social.?security.?(num(ber)?|#)*');
/** `kOneTimePwdRe`. */
export const ONE_TIME_CODE_RE = icu(
  // "One time" is good signal that it is an OTP field.
  'one.?time|' +
    // The main tokens are good signals, but they are short, require word boundaries around them.
    '(?:\\b|_)(?:otp|otc|totp|sms|2fa|mfa)(?:\\b|_)|' +
    // Alternatively, require companion tokens before or after the main tokens.
    '(?:otp|otc|totp|sms|2fa|mfa).?(?:code|token|input|val|pin|login|verif|pass|pwd|psw|auth|field)|' +
    '(?:verif(?:y|ication)?|email|phone|text|login|input|txt|user).?(?:otp|otc|totp|sms|2fa|mfa)|' +
    // Sometimes the main tokens are combined with each other.
    'sms.?otp|mfa.?otp|' +
    // "code" is not so strong signal as the main tokens, but in combination with "verification" and its variations it is.
    'verif(?:y|ication)?.?code|(?:\\b|_)vcode|' +
    // 'Second factor' and its variations are good signals.
    '(?:second|two|2).?factor|' +
    // A couple of custom strings that are usually OTP fields.
    'wfls-token|email_code',
);
/** `kHiddenValueRe`: one repeated symbol, a value the site put there (`••••`), never saved. */
export const HIDDEN_VALUE_RE = /^(\W)\1+$/u;
/** `kPasswordRe`: an id or name that reads as a password field. */
export const PASSWORD_NAME_RE = icu(
  'pass(?:word|code)|pas(?:word|code)|pswrd|psw|pswd|pwd|parole|watchword|' +
    'pasahitza|parol|lozinka|sifr|contrasenya|heslo|adgangskode|losen|' +
    'wachtwoord|paswoord|salasana|passe|contrasinal|passwort|jelszo|' +
    'sandi|signum|slaptazodis|kata|passord|haslo|senha|geslo|contrasena|' +
    'khau',
);
/** `kMinimumPasswordLength`: a field whose maxlength is shorter can't take a generated password. */
export const MINIMUM_PASSWORD_LENGTH = 9;

// ----- Chromium: autofill_regex_constants.h -----

/** `kCardCvcRe`. */
export const CARD_CVC_RE = icu(
  'verification|card.?identification|security.?code|card.?code|security.?value|security.?number|card.?pin|c-v-v|' +
    'código de segurança|código de seguridad|karten.?prüfn|(?:cvn|cvv|cvc|csc|cvd|ccv)|\\bcid\\b|cccid',
);

// ----- Chromium: html_based_username_detector_vocabulary.h (generated there; copied as data) -----

export const kNegativeLatin: readonly string[] = [
  "pin", "parola", "wagwoord", "wachtwoord", "fake", "parole", "givenname", "achinsinsi", "token", "parool",
  "firstname", "facalfaire", "fname", "lozinka", "pasahitza", "focalfaire", "lname", "passord", "pasiwedhi",
  "iphasiwedi", "geslo", "huahuna", "passwuert", "katalaluan", "heslo", "fullname", "phasewete", "adgangskode",
  "parol", "optional", "wachtwurd", "contrasenya", "sandi", "lastname", "cyfrinair", "contrasinal", "senha",
  "kupuhipa", "katasandi", "kalmarsirri", "hidden", "password", "loluszais", "tenimiafina", "second",
  "passwort", "middlename", "paroladordine", "codice", "pasvorto", "familyname", "inomboloyokuvula", "modpas",
  "salasana", "motdepasse", "numeraeleiloaesesi", "captcha",
];
export const kNegativeNonLatin: readonly string[] = [
  "fjalëkalim", "የይለፍቃል", "كلمهالسر", "գաղտնաբառ", "пароль", "পাসওয়ার্ড", "парола", "密码", "密碼", "დაგავიწყდათ",
  "κωδικόςπρόσβασης", "પાસવર્ડ", "סיסמה", "पासवर्ड", "jelszó", "lykilorð", "paswọọdụ", "パスワード", "ಪಾಸ್ವರ್ಡ್",
  "пароль", "ការពាក្យសម្ងាត់", "암호", "şîfre", "купуясөз", "ລະຫັດຜ່ານ", "slaptažodis", "лозинка", "पासवर्ड",
  "нууцүг", "စကားဝှက်ကို", "पासवर्ड", "رمز", "کلمهعبور", "hasło", "пароль", "лозинка", "پاسورڊ", "මුරපදය",
  "contraseña", "lösenord", "гузарвожа", "கடவுச்சொல்", "పాస్వర్డ్", "รหัสผ่าน", "пароль", "پاسورڈ", "mậtkhẩu",
  "פּאַראָל", "ọrọigbaniwọle",
];
export const kUsernameLatin: readonly string[] = [
  "gatti", "uzantonomo", "solonanarana", "nombredeusuario", "olumulo", "nomenusoris", "enwdefnyddiwr",
  "nomdutilisateur", "lolowera", "notandanafn", "nomedeusuario", "vartotojovardas", "username", "ahanjirimara",
  "gebruikersnaam", "numedeutilizator", "brugernavn", "benotzernumm", "jinalamtumiaji", "erabiltzaileizena",
  "brukernavn", "benutzername", "sunanmaiamfani", "foydalanuvchinomi", "mosebedisi", "kasutajanimi",
  "ainmcleachdaidh", "igamalomsebenzisi", "nomdusuari", "lomsebenzisi", "jenengpanganggo", "ingoakaiwhakamahi",
  "nomeutente", "namapengguna",
];
// Chromium's kUsernameNonLatin isn't carried: its classifier reads kUsernameLatin in its place (password-parser.ts).
export const kUserLatin: readonly string[] = [
  "user", "wosuta", "gebruiker", "utilizator", "usor", "notandi", "gumagamit", "vartotojas", "fammi",
  "olumulo", "maiamfani", "cleachdaidh", "utent", "pemakai", "mpampiasa", "umsebenzisi", "bruger", "usuario",
  "panganggo", "utilisateur", "bruker", "benotzer", "uporabnik", "doutilizador", "numake", "benutzer",
  "covneegsiv", "erabiltzaile", "usuari", "kasutaja", "defnyddiwr", "kaiwhakamahi", "utente", "korisnik",
  "mosebedisi", "foydalanuvchi", "uzanto", "pengguna", "mushandisi",
];
export const kUserNonLatin: readonly string[] = [
  "用户", "użytkownik", "tagatafaʻaaogā", "دکارونکيعکس", "用戶", "užívateľ", "корисник", "карыстальнік", "brûker",
  "kullanıcı", "истифода", "អ្នកប្រើ", "ọrụ", "ተጠቃሚ", "באַניצער", "хэрэглэгчийн", "يوزر", "istifadəçi",
  "ຜູ້ໃຊ້", "пользователь", "صارف", "meahoʻohana", "потребител", "वापरकर्ता", "uživatel", "ユーザー", "מִשׁתַמֵשׁ",
  "ผู้ใช้งาน", "사용자", "bikaranîvan", "колдонуучу", "વપરાશકર્તા", "përdorues", "ngườidùng", "корисникот",
  "उपयोगकर्ता", "itilizatè", "χρήστης", "користувач", "օգտվողիանձնագիրը", "használó", "faoiúsáideoir",
  "შესახებ", "ব্যবহারকারী", "lietotājs", "பயனர்", "ಬಳಕೆದಾರ", "ഉപയോക്താവ്", "کاربر", "యూజర్", "පරිශීලක",
  "प्रयोगकर्ता", "användare", "المستعمل", "пайдаланушы", "အသုံးပြုသူကို", "käyttäjä",
];
export const kTechnicalWords: readonly string[] = [
  "uid", "newtel", "uaccount", "regaccount", "ureg", "loginid", "laddress", "accountreg", "regid", "regname",
  "loginname", "membername", "uname", "ucreate", "loginmail", "accountname", "umail", "loginreg", "accountid",
  "loginaccount", "ulogin", "regemail", "newmobile", "accountlogin",
];
export const kWeakWords: readonly string[] = [
  "id", "login", "mail",
];

// ----- DuckDuckGo: matching-config-source.js, ddgMatcher (credentials only) -----

/**
 * One of DuckDuckGo's matchers. A field's words match `match` unless they match `skip`;
 * `forceUnknown` makes the field nothing at all. DuckDuckGo tests them against a field's
 * label, its name, id and placeholder, and the text near it.
 */
export interface WordMatcher {
  readonly match: RegExp;
  readonly skip?: RegExp;
  readonly forceUnknown?: RegExp;
}

/** DuckDuckGo compiles its strings with `new RegExp(s, 'u')` after lower-casing the text; `i` does the same here. */
const ddg = (source: string) => new RegExp(source, 'iu');

/** `unknown`: a field that is none of the credentials (search, captcha, a title, an SSN, two-factor). */
export const DDG_UNKNOWN: WordMatcher = {
  match: ddg(
    'search|find|filter|subject|title|captcha|social security number|ssn' +
      '|cerca|filtr|oggetto|titolo|(due|2|più).?fattori' +
      '|suche|filtern|betreff' +
      '|zoeken|filter|onderwerp|titel' +
      '|chercher|filtrer|objet|titre|authentification multifacteur|double authentification|à usage unique' +
      '|busca|busqueda|filtra|dos pasos|un solo uso' +
      '|sök|filter|ämne|multifaktorsautentisering|tvåfaktorsautentisering|två.?faktor|engångs',
  ),
  skip: ddg('phone|mobile|email|password'),
};
/** `emailAddress`. */
export const DDG_EMAIL: WordMatcher = {
  match: ddg('.mail\\b|apple.?id|posta elettronica|e.?mailadres|correo electr|correo-e|^correo$|\\be.?post|e.?postadress'),
  skip: ddg('phone|(first.?|last.?)name|number|code|\\bdate\\b'),
  forceUnknown: ddg('search|filter|subject|title|\\btab\\b|otp'),
};
/** `password`. */
export const DDG_PASSWORD: WordMatcher = {
  match: ddg('password|passwort|kennwort|wachtwoord|mot de passe|clave|contraseña|lösenord'),
  skip: ddg('email|one-time|error|hint|^username$'),
  forceUnknown: ddg('search|captcha|pin'),
};
/** `newPassword`: the words that make a password field a new one. */
export const DDG_NEW_PASSWORD: WordMatcher = { match: ddg('new|confirm|re.?(enter|type)|repeat|update\\b') };
/** `currentPassword`. */
export const DDG_CURRENT_PASSWORD: WordMatcher = { match: ddg('current|old|previous|expired|existing') };
/** `username`. */
export const DDG_USERNAME: WordMatcher = {
  match: ddg(
    '(user|account|online.?id|membership.?id|log(i|o)n|net)((.)?(name|i.?d.?|log(i|o)n).?)?(.?((or|/).+|\\*|:)( required)?)?$' +
      '|(nome|id|login).?utente|(nome|id) (dell.)?account|codice (cliente|uten)' +
      '|nutzername|anmeldename' +
      '|gebruikersnaam' +
      '|nom d.utilisateur|identifiant|pseudo' +
      '|usuari|cuenta|identificador|apodo' +
      '|\\bdni\\b|\\bnie\\b| del? documento|documento de identidad' +
      '|användarnamn|kontonamn|användar-id',
  ),
  skip: ddg('phone|first.?name|last.?name'),
  forceUnknown: ddg('search|policy|choose a user\\b'),
};

/** How a DuckDuckGo matcher reads `text`: `'yes'`, `'no'`, or `'unknown'` when its `forceUnknown` matches. */
export function matchWords(matcher: WordMatcher, text: string): 'yes' | 'no' | 'unknown' {
  if (!text) return 'no';
  if (matcher.forceUnknown?.test(text)) return 'unknown';
  if (matcher.skip?.test(text)) return 'no';
  return matcher.match.test(text) ? 'yes' : 'no';
}
