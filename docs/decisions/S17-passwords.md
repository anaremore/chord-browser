# S17: Passwords, built in

*2026-11-15 · replaces D12 (ARCHITECTURE.md §16) and re-rates risk R2 (§17) · nothing is built yet.*

**Decided 2026-11-15 by the maintainer:**
1. **D12 is reversed: option B.** Chord builds its own password manager, with its own detector (§2–§4). Extensions stay supported.
2. **A vault passphrase on every OS, from phase 1.** Protection must be the same on Windows, macOS and Linux, so the vault key is wrapped by a passphrase you choose (choice (b) in §7), not by the OS alone. This replaces the recommendation below of the OS-kept key by default. It also settles question 4: *Show*, *Copy* and *Export* ask for the passphrase, so no Windows Hello module is needed.
3. **One vault for every chord**, with the chord's own recent accounts listed first (§7, *One vault, every chord*).

Where the text below still recommends otherwise, these win. Questions 2 and 5–11 in §16 are still open; until they're answered, phase 1 takes their recommended defaults (fill only on your choice; private windows fill and never save; off by default in a chord with a password-manager extension).

**Marks.** ✅ read in the upstream source, the docs or this repo during this research. ⚠ inferred, from memory, or an estimate: check it before relying on it. Upstream files were read on their `main` branches on 2026-11-15; a port pins a commit and names it in the file's header.

**In short.** D12 said no built-in store because autofill means owning form detection, origin matching and filling inside pages. S9 and R2 show the other side: on Electron, password managers' extensions half-work, and that isn't Chord's to fix. This document says what owning it costs, and how to borrow enough that Chord gets it right.

- **I recommend building it (option B below):** Chord's own small detector in TypeScript, a port of Chromium's password form parser (BSD-3) with Firefox's and DuckDuckGo's field vocabulary added, run in an isolated world of its own. No library is adopted whole.
- **The form parser is the part worth copying, and it's portable.** Chromium's `form_data_parser.cc` works on plain field records, never the DOM, and comes with a 4,088-line table of test cases ✅. That table, Firefox's unit-test tables and DuckDuckGo's 563 labelled snapshots of real sites' forms ✅ are the regression suite. The corpus is how "all the varied forms on the web" becomes a number CI holds.
- **Nothing fills until you choose.** Chord never fills when a page loads. Focusing a sign-in field opens a menu in Chord's own popover view, under the field, outside the page; picking an account fills. That removes the worst class of autofill attacks (a script reading a field filled without you) and most of the detector's risk: a wrong guess shows a menu, it doesn't leak a password.
- **Main decides who gets a password, from the frame's origin as Chromium reports it,** never from what a page's script says. A password goes only into a `type=password` field you can see.
- **Nothing is added to the page:** no icon in the field, no attribute, class, element or stylesheet, as with the assistant's fill (§11.6).
- **Storage:** rows in chord.db, each sealed with AES-256-GCM under a vault key that `safeStorage`'s async API wraps (Keychain, DPAPI, the Linux keyring), as sync's root key is kept today. One vault for every chord; private windows fill and never save. A vault passphrase is an option later, and the only real defence against other programs running as you on Windows and Linux.
- **Sync, import, passkeys:** CSV import and export in phase 2. Sync later, as its own switch inside S15's sync, off by default. Passkeys stay with the OS and security keys.
- **Extensions stay.** A chord with 1Password, Bitwarden or another known manager installed has Chord's own turned off by default, so nothing asks twice. One switch turns Chord's off everywhere.
- **Phase 1** is save and fill on ordinary single-page sign-in forms in a tab's main frame, with Settings → Passwords: about 3 weeks ⚠ after a 4-day spike ⚠. Sign-up, generation, CSV, multi-step sign-ins, frames and sync follow in separately shippable phases (§15).
- **The honest gaps:** forms in another site's frame need preloads in iframes, which Chord doesn't run today (S16 §2) and whose cost isn't measured; closed shadow roots can't be reached at all; Windows and Linux have no OS prompt Chord can use for *Show password* without a native module.

---

## 1. The question

Should Chord keep and fill passwords itself, and if so, how does it handle the web's forms well enough to be trusted with it?

**What changed since D12 (2026-10-24).**
- S9 measured the extension route: 1Password's worker dies or half-works, an extension's frame inside a page can't reach its worker (#185, which is the inline menu every manager draws), and desktop links need native messaging that can refuse a browser it doesn't know. R2 rates this High / severe, and the mitigations are other people's fixes.
- Chord has since built most of the pieces a password manager stands on, for other features:
  - an isolated-world fill that works on React-controlled fields, with fields checked again at fill time (§11.6, `main/assistant/forms.ts`) ✅;
  - a popover view above the page for cards a page can't draw over or read (`AuthCard`, `PasskeyCard`) ✅;
  - a preload on every web session (`preload/page.ts`) ✅;
  - a key kept with `safeStorage`'s async API and handed to chord-data (sync's root key, §9) ✅;
  - scrypt and AES-256-GCM in `packages/data/src/crypto.ts` ✅;
  - a sensitive-field table (`classifyField` in `core/assistant-forms.ts`) ✅.

**What doesn't change.** The assistant never sees a password (D16). Passkeys aren't Chord's to store. Extensions remain supported.

---

## 2. Options

| | What | For | Against |
|---|---|---|---|
| **A** | Keep D12: extensions only | No new attack surface. No work. | R2 stays High / severe and out of Chord's hands. Private windows have no password manager at all (Electron refuses extensions in in-memory sessions ✅ §12). |
| **B** | **Chord's own detector: a TypeScript port of Chromium's parser, plus vocabulary from Firefox and DuckDuckGo, tested against their corpora** | Small (I'd guess 25–40 KB minified ⚠), no DOM changes, fits the existing isolated-world pattern, every rule has an upstream test to port. BSD-3, MPL-2.0 and Apache-2.0 sources, all usable. | Chord owns it from then on. No server predictions, which Chrome leans on for multi-step sign-ins. |
| **C** | Adopt `duckduckgo-autofill` whole (Apache-2.0 ✅) | Maintained (release 19.2.1, 2026-10-12 ✅), built for native hosts, has the corpus. | It writes into the page: attributes, inline icon styles and a class on inputs (`decorateInput`, `addAutofillStyles`, `classList.add('ddg-autofilled')`; I read `src/Form/Form.js` ✅), against Chord's rule. 822 KB unminified ✅, with Email Protection, cards, identities and pixels to stub. Not on npm ✅. Configured by string replacement, with the host posing as DDG's Windows app ⚠. Exits on any page that isn't a secure context ✅, so no `http://` router or intranet pages. |
| **D** | Bundle Firefox's modules unchanged, as firefox-ios does (MPL-2.0 ✅) | Battle-tested heuristics; firefox-ios proves they run outside Gecko with a shim (`Helpers.ios.mjs`, `Overrides.ios.js`) ✅. | The shim is a second thing to maintain against Gecko's churn. Pulls in Fathom, which is archived and marked deprecated ✅. The parts worth having are a few hundred lines of plain rules that are simpler to restate. |
| **E** | Proton's Fathom models (`@protontech/fathom`, `@protontech/autofill`, MPL-2.0 on npm ✅) | Classifies login, register, recovery and password-change forms and their fields with trained models. | No public source repository found ✅, versions look internal (0.0.42001045), 19.7 MB unpacked ✅, upstream Fathom is archived. Too much to trust blind inside every page. |
| **F** | A reader for another manager's vault (`.kdbx`, 1Password, Bitwarden) | No storage to own. | Still needs all of detection and fill, which is the hard part, plus someone else's format and sign-in. |

**Recommendation: B.** C is the fallback if the spike's bake-off (§15, M0) shows B's detector well behind DuckDuckGo's on DuckDuckGo's own corpus: then take only its matching code (`src/Form/matching.js`, `matching-config/`, `FormAnalyzer.js`), without its `Form.js` decoration or device layer. Whether those three files come apart cleanly isn't checked ⚠.

Crest's own password manager (ROADMAP.md, *Borrowed from Crest*) is Swift over the system Keychain ✅ (its README), so there's nothing to port.

---

## 3. What to borrow, and from where

| From | License | Exact path | What Chord takes | How |
|---|---|---|---|---|
| Chromium | BSD-3 ✅ | `components/password_manager/core/browser/form_parsing/form_data_parser.cc` (1,651 lines) | The parsing pipeline (§4) | Transliterated to TypeScript in `packages/core/src/password-forms.ts`, header naming the commit and "Portions derived from Chromium, BSD-3" |
| Chromium | BSD-3 ✅ | `…/form_parsing/form_data_parser_unittest.cc` (4,088 lines, 72 tests, table-driven) | Test cases | Transliterated into a Vitest table |
| Chromium | BSD-3 ✅ | `components/password_manager/core/common/password_manager_constants.h` | `kOneTimePwdRe`, `kSocialSecurityRe`, `kPasswordRe`, `kHiddenValueRe` | Copied as constants |
| Chromium | BSD-3 ✅ | `components/autofill/content/renderer/html_based_username_detector.cc` and `html_based_username_detector_vocabulary.h` | Multilingual username word lists, matched on id, name, label, placeholder | Copied as data; the matcher restated |
| Chromium | BSD-3 ✅ | `components/password_manager/core/browser/password_form_filling.cc` | The list of reasons not to fill on load (§5) | Idea only |
| Chromium | BSD-3 ✅ | `components/autofill/content/renderer/form_submission_tracker.cc`; `SubmissionIndicatorEvent` in `components/autofill/core/common/mojom/autofill_types.mojom`; `PasswordManager::OnPasswordFormsRendered` | How a successful sign-in is told from a failed one (§6) | Idea only; Blink-bound |
| Chromium | BSD-3 ✅ | `components/password_manager/core/browser/generation/password_generator.cc` | Generator defaults: no `l o I O 0 1`, at least one of each class, no `--` or `__` | Restated |
| Firefox | MPL-2.0 ✅ | `toolkit/components/passwordmgr/LoginManagerChild.sys.mjs` (`_getPasswordFields`, `_getFormFields`), `LoginHelper.sys.mjs` (`isUsernameFieldType`, `isInferredUsernameField`, `isInferredEmailField`, `isInferredNonUsernameField`, `isInferredLoginForm`) | Username-only form rule; the email preference; at most 5 password fields; confirm field within 3 fields | Ideas restated in Chord's code. Nothing copied, so no MPL file |
| Firefox | MPL-2.0 ⚠ (test files carry no header; repo default) | `toolkit/components/passwordmgr/test/unit/test_getFormFields.js` (28 cases), `test_getPasswordFields.js` (19), `test_isInferredUsernameField.js`, `test_getUsernameFieldFromUsernameOnlyForm.js` and neighbours | Test cases: inline HTML with expected field ids | Copied into one test file that keeps MPL-2.0, as `core/rank.ts` does |
| Firefox | MPL-2.0 | `LoginRecipes.sys.mjs` | The recipe format (`hosts`, `pathRegex`, `usernameSelector`, `passwordSelector`, `notUsernameSelector`, `notPasswordSelector`) | Format only. The live recipe data states no license ⚠, so Chord writes its own entries |
| DuckDuckGo | Apache-2.0 ✅ | `duckduckgo-autofill`: `test-forms/` (565 files, `index.js`, fields labelled `data-manual-scoring`) | The real-site corpus | Pinned by commit, fetched for tests, **not vendored**: the snapshots are other sites' markup (§14) |
| DuckDuckGo | Apache-2.0 ✅ | `src/Form/matching-config/matching-config-source.js` | Regexes for username, email, password variants, one-time codes | Copied where Chromium's vocabulary is thin, with the notice |
| Apple | MIT ✅ | `password-manager-resources`: `quirks/password-rules.json`, `quirks/shared-credentials.json`, `quirks/change-password-URLs.json`, `quirks/websites-that-append-2fa-to-password.json`; `tools/PasswordRulesParser/PasswordRulesParser.js` | Per-site password rules for the generator; sites that share one sign-in; *Change password* links | Bundled at build time, refreshed with releases. Firefox ships the same parser ✅ |
| Public Suffix List | MPL-2.0 data ✅ | through `tldts` (MIT, 7.5.4 ✅) | Registrable domains | A dependency in main. `psl` 1.15.0 bundles a 2024 list ✅: not that one |
| Bitwarden, Proton Pass, KeePassXC-Browser | GPL-3.0 ✅ | — | **Nothing copied.** Ideas only: Bitwarden's keyword lists for one-time-code and recovery fields, its warning before filling a frame, its refusal to fill sandboxed frames | Read, not ported. `bitwarden/test-the-web` (GPL-3.0) can be tested against by hand, never vendored |

`LICENSES/THIRD-PARTY-NOTICES.md` gains Chromium (BSD-3), DuckDuckGo (Apache-2.0, text already in `LICENSES/`), Apple (MIT), `tldts` and the PSL.

**`websites-with-shared-credential-backends.json`, named in the brief, no longer exists** ✅: `shared-credentials.json` replaced it. Apple's README says the list "should not be used as part of any user experience that releases user credentials to a website without the user's explicit review and consent" ✅, which §5 follows.

---

## 4. Detection

### Two parts

- **The agent** (`apps/desktop/src/passwords/agent/`, built to one self-contained script, as the assistant's scripts are plain source): runs in the page's renderer, in isolated world **4440**. It turns elements into field records, calls the classifier, keeps each field by `WeakRef`, and fills. It is the only code that touches the DOM.
- **The classifier** (`packages/core/src/password-forms.ts`): pure functions over field records, with no DOM. It's the Chromium port, compiled into the agent and unit-tested in Node.

A field record is what Chromium's `FormFieldData` carries for this purpose: `type`, `id`, `name`, `autocomplete`, label text, placeholder, `maxLength`, `readOnly`, focusable, visible, whether you typed in it, whether Chord filled it, and its value **only inside the page** (the classifier compares values in the page; they never leave it except as §6 says).

### The pipeline, as Chromium has it ✅

Two modes: **filling** (which field is which, before you type) and **saving** (what you just submitted).

1. **Keep text-like inputs.** When saving, drop empty ones and values that are one repeated symbol (`kHiddenValueRe`).
2. **Rank by how reachable a field is:** you typed in it, then focusable, then neither. Only the best rank present is used.
3. **`autocomplete`,** last token after dropping a trailing `webauthn`: `username`, `current-password`, `new-password`, `one-time-code`, `cc-*`. Ignored if it gives more than one username, one current password or two new ones.
4. **Site overrides:** Chord's own recipes for named hosts (§3). Empty at first.
5. **Base heuristics.**
   - Password candidates are `type=password` fields, minus read-only ones you didn't type in, minus fields whose id or name reads as a card code, a national id or a one-time code, minus one-character fields (split PIN boxes).
   - One password: current. Two: equal and non-empty is new and confirm; otherwise current and new. Three: second equals third is current, new, confirm; first equals second is new and confirm; all equal is current.
   - Username: the nearest text field before the first password, preferring one whose value is a saved username, then a focusable one. When saving, never an empty value or one or two digits.
6. **Vocabulary:** Chromium's username word lists and DuckDuckGo's regexes break ties and veto (`search`, `code`, `captcha`).
7. **After each stage, if one field has two roles, throw the stage away.**

Then Chord adds what Chromium gets from Google's server and Firefox does locally:

- **The kind of form:** sign-in, sign-up, change password, reset (new password, no username), or unknown. From the password roles, `autocomplete`, and the words on the form and its button (*Sign in*, *Log in* against *Sign up*, *Create*, *Register*). Firefox's `isInferredLoginForm` is the model ✅.
- **A username-only form** (the first step of a two-step sign-in): exactly one username-type field, no password field, and either the field or the form reads as sign-in; never a search or code field (Firefox ✅). Chromium recognises these locally only from `autocomplete=username` and otherwise asks its server ✅, so this rule is where Chord will be weaker than Chrome.
- **Fields outside a `<form>`:** all unowned fields count as one form, as Chromium does ✅. A later refinement is to narrow that to the closest container that holds the password field and a button ⚠.

### What it covers, and what it doesn't

| Pattern | Plan | Confidence |
|---|---|---|
| One page, username and password in a `<form>` | Phase 1 | High: every upstream handles it the same way |
| No `<form>`, a `div` and a button (SPAs) | Phase 1 for fill; saving in phase 3 with §6's rules | Medium |
| React, Vue, Angular controlled inputs | Phase 1: the native setter and `input`/`change` from an isolated world, already proven in §11.6 ✅ | High |
| Pages that re-render the field | Fields are held by `WeakRef` and re-read at focus and at fill | Medium |
| Sign-up and change password | Phase 2 | Medium: the two- and three-password rules are sound; telling sign-up from sign-in by words is fuzzy |
| Two-step sign-ins (Google, Microsoft, Okta) | Phase 3. Fill: the menu on the username step fills the username; the password step, a new document or a re-render, gets its own menu with the same account first. Save: the username you typed is remembered in main for that tab and site for a few minutes, as Chromium's `possible_usernames_` is ✅ | Medium-low without server hints. A by-hand list per provider |
| Open shadow roots (Reddit's components ⚠) | Phase 3: walk `shadowRoot`s, as the assistant's read does ✅; events are read through `composedPath()` | Medium |
| Closed shadow roots | **Not reachable.** Extensions get `chrome.dom.openOrClosedShadowRoot`; an isolated world doesn't ⚠ | A gap. Rare for sign-in ⚠ |
| Same-site frames | Phase 3: the main frame's world can reach a same-origin frame's document ⚠ (to prove in the spike) | Medium |
| Another site's frame (embedded sign-in, some banks, Apple ID ⚠) | Phase 4, and only if preloads in iframes are affordable (§8) | Open |
| One-time codes | Never filled, never saved. Detected only so they aren't mistaken for passwords | High |
| `type=text` password fields (a *show* toggle, or a custom mask) | A field that was `type=password` when first seen stays a password field for saving. Chord fills only while it is `type=password` | Medium |
| Sign-in in a pop-up window or a mini window | The same agent; the menu needs a popover, which mini windows lack ✅ (ARCHITECTURE.md §9), so there: no menu, phase 4 at best | Low |
| CAPTCHA, WebAuthn-only, magic links | Nothing to do | — |

---

## 5. Matching and fill policy

**Each saved sign-in has an origin** (scheme, host, port) and a site: its registrable domain from the Public Suffix List with private suffixes on, so `a.github.io` and `b.github.io` are different sites, as in Chromium (`INCLUDE_PRIVATE_REGISTRIES` ✅). An IP address, `localhost` or a single-label host is its own site, with its port.

| The page | The saved sign-in | What Chord does |
|---|---|---|
| `https`, tab's main frame | Same origin | Listed first; Enter or a click fills |
| `https`, main frame | Same site, another host (`login.x.com` saved, on `app.x.com`) | Listed below, with its host shown; a click fills |
| `https` | Saved on `http` for the same host | Listed (Firefox's `schemeUpgrades` ✅). Saving afterwards moves it to `https` |
| `http` | Saved on `https` | Never offered in the menu |
| `http` | Saved on `http`, same origin (a router, an intranet page) | Listed, with *This page isn't secure* in the menu |
| Any | On Apple's shared-credentials list for this site (phase 4) | Listed last under *From [other site]*; a click fills. Never without that click |
| Any | Something else | Only through *Other passwords…*, which searches the vault and asks: *This password was saved for x.com. Fill it on y.com?* |
| A frame of another site (phase 4) | Matches the **frame's** origin | The menu names the frame's site, not the tab's: *This form is from pay.example. Fill x@y.z?* |
| A sandboxed frame without `allow-same-origin`, `about:blank`, `data:`, `blob:` | — | Never |
| Chord's pages, extension pages, reader view, the PDF viewer | — | The agent never runs there |

**Never on load.** Chromium fills on load only when none of a long list applies (cross-origin frame, PSL match, insecure page, incognito, a `webauthn` field, a prefilled password ✅), and still gets attacked through it: a script that runs in the page can read a field the moment it's filled. Filling on your choice costs a click or a key, removes the leak, and makes a wrong detection harmless. Safari and 1Password work this way ⚠.

**Main decides.** The agent asks; main reads `event.senderFrame.origin` and the tab's own address from Chromium, works out the matches, and releases a password only for an account you picked in the popover, to that frame, if its origin is still the one the menu was shown for. A compromised renderer can ask for its own site's passwords, which it could read as you typed them, and nobody else's.

**At fill,** the agent checks what §11.6 checks: the fields are still connected and described as they were, the password field is `type=password`, both are visible (`checkVisibility` with opacity, at least a few pixels, on screen), and the document hasn't navigated. Otherwise nothing is written and the menu says the form changed.

---

## 6. Saving, updating, generating

### Knowing you signed in

Chromium and Firefox both hold what you typed, wait for a sign that the form was submitted, then decide whether it worked ✅:

| Signal | Chromium ✅ | Firefox ✅ | Chord |
|---|---|---|---|
| The form's `submit` event | `HTML_FORM_SUBMISSION` | `form-submit-event` | The agent's capturing `submit` listener |
| A navigation the page started after you used the form | `PROBABLE_FORM_SUBMISSION` | `page-navigation` | Main's `did-start-navigation` on the frame, with a candidate held |
| XHR or fetch finished, then the form went | `XHR_SUCCEEDED`, only if the form disappeared | `form-removal-after-fetch` | The form or its password field removed or hidden after a submit signal (below). Chord can't see requests without a `webRequest` listener (performance rule 2) or patching `fetch` in the page's world, and does neither |
| Same-document navigation | `SAME_DOCUMENT_NAVIGATION`, if the form disappeared | — | `did-navigate-in-page` plus the same check |
| The frame went away | `FRAME_DETACHED` | `iframe-pagehide` | Phase 4, with frames |

**In Chord:**
1. When you type in a password field, or Chord fills one, the agent sends main the form's candidate: the username and password values and their roles. Main holds it in memory for that frame, never on disk, for at most 5 minutes ⚠. It's sent as you leave the field and at each submit signal, because after a navigation it's too late to ask the page (Chromium sends on every edit for the same reason ⚠).
2. **A submit signal** is the form's `submit` event, Enter in one of its fields, or a click or key on a button inside the form's scope. Without one, a form that vanishes (a closed dialog) is not a sign-in.
3. **It worked** if, after a signal, either
   - the frame navigated, the response wasn't an error (`did-navigate`'s `httpResponseCode` under 400), and once the new page has settled it doesn't show a sign-in form with the same password field (Chromium's reappeared-form check ✅); or
   - with no navigation, the password field is gone or hidden within 10 s ⚠ (the agent watches with a `MutationObserver` only for that window).
4. **It failed** if the same form is still there, or back. The candidate is kept in case you correct the password and try again.
5. Then main compares with the vault: nothing saved for that username on this site → the save card; the same username with another password → the update card; identical → nothing, and its *last used* moves.

A possible refinement for step 3, to try in the spike: a `PerformanceObserver` for resource timing sees fetches finish from an isolated world, with `responseStatus` ⚠.

**Change-password forms** have no username. The account is the saved one on this site whose password equals the *current* field (Chromium does this ⚠); if none or several match, the card asks which.

**Sites on Apple's `websites-that-append-2fa-to-password.json`** have the code cut from the end before saving (phase 3).

### Generating

- Offered in the menu on a field classified new-password: `autocomplete=new-password`, or a sign-up or change form's new field.
- **Default:** 20 characters ⚠ from letters and digits without look-alikes, at least one of each class, and `-` as the only symbol, the one most sites accept (Chromium's default is 15 with no symbols ✅). Made in main with `crypto.randomInt`.
- **Site rules** override it: the field's `passwordrules` attribute (a Safari proposal, still open at WHATWG ✅), then Apple's `password-rules.json` by site, then `minlength`/`maxlength`. Parsed with Apple's parser (MIT).
- **Saved the moment it's filled,** before you submit, as Chromium presaves ⚠: a generated password that exists only in a page is one you can lose. The entry takes its username when the form is submitted, and the list marks it *Not confirmed* until a submit worked.
- Chord fills the confirmation field with it too.

---

## 7. Storage, keys, unlocking

### What Electron 45 gives ✅

- `safeStorage`'s synchronous methods are deprecated in 45 and removed in 46 (breaking-changes.md, and the typings in `node_modules/electron/electron.d.ts`, which I read). The replacements are `isAsyncEncryptionAvailable()`, `encryptStringAsync()` and `decryptStringAsync()`, which returns `{ result, shouldReEncrypt }`. Chord already uses them for sync's key.
- **Backends:** the Keychain on macOS (tied to the app's signature; an unsigned build can be asked again after an update, §15.2); DPAPI on Windows, "protected from other users on the same machine, but not from other apps running in the same userspace"; on Linux the Secret portal, libsecret or KWallet, or `basic_text`, which is no protection (`getSelectedStorageBackend()`).
- Chrome's app-bound encryption on Windows isn't in Electron ⚠.
- **Asking you to prove it's you:** `systemPreferences.promptTouchID()` on macOS only, and its docs say it protects nothing by itself. Nothing for Windows Hello, nothing for Linux.

### The choices

| | How the vault key is kept | For | Against |
|---|---|---|---|
| **(a) The OS keeps it** (recommended default) | A random 256-bit key, wrapped by `safeStorage` | No extra password. What Chrome, Edge and Brave do ⚠. Chord already does it for sync | A program running as you can ask the OS for the key on Windows and Linux, as with Chrome |
| **(b) A vault passphrase** (recommended option, phase 4) | The key wrapped under scrypt of a passphrase you type after each launch, S15's parameters | Protects against other programs while locked, a copied disk, and a `basic_text` Linux | One more passphrase. Lose it and the vault is gone. Autofill waits for it |
| (c) Each password as its own Keychain or Credential Manager item | — | The OS's own UI lists them | A native module per OS (performance rule 3), no Linux equivalent, slow in bulk, nothing to sync |
| (d) Always a master password | — | Strongest | Not what someone leaving Chrome expects; most would turn the feature off |

~~**Recommendation: (a) now, (b) as an option, and (b) required where the OS offers nothing** (Linux on `basic_text`), with the same plainly worded *Remember on this computer* escape sync has (S15 question 6).~~

**Decided 2026-11-15: (b) on every OS, from phase 1.**
- You choose the passphrase when you first turn passwords on, or the first time Chord offers to save one. Its card says plainly that Chord can't get it back, as the export passphrase does (DESIGN.md §9).
- The vault key `K` is random, as below. It's wrapped under scrypt of the passphrase with S15's parameters, and the wrapped key lives in `meta`. Changing the passphrase rewraps `K`; no row is resealed.
- Unlocked once per launch, and locked again after a time you choose (default 30 minutes idle ⚠, *Never* allowed); also on *Lock passwords* in the menu and in Settings.
- *Remember on this computer* (off by default) keeps a second copy of `K` wrapped by `safeStorage`, so the vault opens with your OS session as in (a). Its wording says what that gives up: other programs running as you on Windows and Linux can then read it.
- *Show*, *Copy* and *Export* ask for the passphrase again if it was last typed more than 5 minutes ago ⚠. Touch ID can stand in on a Mac when *Remember* is on. No native module.
- A forgotten passphrase loses the vault. Settings offers *Export passwords* (an encrypted CSV, phase 2) and *Start over*, which deletes the rows.

### The format

- **Vault key** `K`: 32 random bytes. From it, HKDF-SHA256 gives `K_item` and `K_index` (labels `chord passwords v1 item` and `… index`). `nodeCrypto` in `packages/data/src/crypto.ts` has everything needed ✅.
- **Each sign-in is one sealed blob:** AES-256-GCM, a random 96-bit nonce, and as associated data its id and format version, so a blob moved to another row doesn't open. Inside, JSON: origin, username, password, HTTP realm if any, a note, when the password last changed, and the one password before it (to recover from a wrong update).
- **Its site is stored as a tag,** HMAC-SHA256 under `K_index` of the registrable domain, cut to 16 bytes. Lookup needs no decryption, and the file doesn't list where you have accounts to someone without the key. With the key, it hides nothing.
- **Usernames are inside the blob.** Chrome leaves them plain ⚠; Firefox encrypts them ⚠.

### Where the key lives

As sync's does (§9, *The key*):
- chord-data keeps the wrapped key in `meta`. Main unwraps it with `safeStorage` the first time it's needed, not at launch, and hands it to chord-data, which holds it for the session and does all sealing, opening and tagging.
- Main sees a password only on its way to a frame, the clipboard or Settings' *Show*. It caches none.
- **Honest limits.** JavaScript strings can't be wiped; `decryptStringAsync` itself returns the key as a string. So hygiene means: the key as a `Buffer` in one process, no plaintext cache, nothing in logs, crash reports, the launch timeline or zod error messages, IPC payloads never echoed, and the popover given usernames only. It doesn't mean secrets are erased from memory.

### Locking

- With (a) there's no lock: the vault opens with your OS session, as Chrome's does.
- With (b): locked after launch and after a time you choose. A locked vault shows *Unlock passwords* in the menu, and the passphrase box is a card in the popover, like `AuthCard`.
- **Show, copy and export** ask first: Touch ID on a Mac that has it; the vault passphrase where one is set; otherwise nothing, and Settings says so. Windows Hello or the Windows password box needs a native module (`UserConsentVerifier`), which performance rule 3 makes a decision of its own. The npm options are young or stale ✅ (`electron-windows-hello` 0.1.0, one maintainer; `node-ms-passport`, 2022). See question 4.
- A copied password is cleared from the clipboard after 60 s if it's still there.

### One vault, every chord

- A chord with its own sign-ins keeps its own cookies, not its own identity: the same person, and usually the same passwords.
- Chord remembers which chord last used each sign-in, on this computer only, and lists those first, so a Work chord offers the work account before the personal one.
- A vault per chord would hide passwords in a new chord and wouldn't sync cleanly (profiles aren't synced, §9). See question 3.

### Private windows

Fill works: it's your vault, and nothing about the visit is kept (not *last used* either). Chord never offers to save there. Extensions can't run in private windows, so today they have no password manager at all.

---

## 8. Architecture

### Processes

```
page's renderer                      main                         chord-data (utility)
┌──────────────────────────┐   ┌────────────────────────┐   ┌──────────────────────┐
│ world 999: preload/page  │   │ main/passwords/        │   │ @chord/data/passwords│
│  sentinel (≈1 KB)        │──▶│  service.ts  policy,   │──▶│  login rows, sealed  │
│ world 4440: the agent    │◀──│   candidates, matching │◀──│  the vault key       │
│  fields · classify · fill│   │  agent.ts    the script│   │  seal · open · tag   │
└──────────────────────────┘   │  generator.ts          │   └──────────────────────┘
   never the page's world      │  keys.ts  safeStorage  │   import worker: CSV
                               └───────┬────────────────┘
                     popover (menu, save card)   Settings (chord://, internal)
```

### In the page

- **The sentinel** is a few lines added to `preload/page.ts`, in the preload's world (999), on web pages only. It does nothing until one of:
  - the document has an `input[type=password]` when it has loaded;
  - focus or typing lands in a password field, or a text field whose `autocomplete`, type or name reads as a username or email;
  - main says this site has saved sign-ins (main knows at navigation, from the site's tag).

  It adds two capturing listeners (`focusin`, `input`) and no `MutationObserver`.
- **Waking** loads the agent into world 4440 of that frame. The preload asks main for the script once (`ipcRenderer.invoke`) and runs it with `webFrame.executeJavaScriptInIsolatedWorld`. `contextBridge.exposeInIsolatedWorld(4440, …)` gives the agent a bridge of four functions. Both exist in Electron 45's typings ✅; that they work from a session-registered sandboxed preload is the spike's first check ⚠. If they don't: compile the agent into the preload, and pay its size on every page.
- **Why its own world:** page scripts can't see or change it; the assistant's world (4400) can't either, which keeps D16's promise by construction; and a bug in it can't break `preload/page.ts`.
- **Frames.** Electron 45 runs preloads in the main frame only unless `nodeIntegrationInSubFrames` is set, which Chord's tabs don't (S16 §2 ✅). `WebFrameMain` has `executeJavaScript` (the page's own world) and no isolated-world call ✅ (typings). So phases 1 to 3 are the main frame plus same-origin frames reached through it. Another site's frame needs that switch on, which also runs `preload/page.ts` and the extension library's preload in every ad frame. S16 flagged the cost as unmeasured; the spike measures it.

### IPC (names to settle in `packages/ipc`)

| Channel | From → to | Carries |
|---|---|---|
| `passwords:agent` | preload → main | Nothing; answers with the agent's source |
| `passwords:focus` | agent → main | The form's kind, the field's role and rectangle, a per-document form id. **No values** |
| `passwords:blur` | agent → main | The form id: close the menu |
| `passwords:candidate` | agent → main | Form id, username and password values with roles, the submit signal if any |
| `passwords:gone` / `passwords:still` | agent → main | Form id: the form went, or is still shown |
| `passwords:fill` | main → that frame | A one-use token, the form id, the values |
| `passwords:menu` (state patch), `passwords:choose`, `passwords:save`, `passwords:never`, `passwords:dismiss`, `passwords:unlock` | main ↔ popover | Usernames, hosts, ids; never a password, except the save card's own, which the popover shows masked and can reveal |
| `passwords:list`, `:reveal`, `:copy`, `:edit`, `:delete`, `:add`, `:import`, `:export` | Settings ↔ main | As named; `reveal` after the check in §7 |

Every handler validates its sender (the tab's frame for page channels, by `senderFrame`; the window's popover; Settings), with zod schemas and size limits (a username 500 characters, a password 1,000 ⚠), per §8's allowlist. Page channels are refused from Chord's pages, extension pages and a frame that isn't in a tab or Peek.

### Schema (the next migration: 24, the newest today being 23 ✅)

```sql
CREATE TABLE login (
  id TEXT PRIMARY KEY,
  site_tag BLOB NOT NULL,          -- HMAC of the registrable domain
  sealed BLOB NOT NULL,            -- nonce ‖ AES-256-GCM(JSON) ‖ tag
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX login_site ON login (site_tag);
CREATE TABLE login_use (            -- this computer only, never synced
  login_id TEXT NOT NULL REFERENCES login(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (login_id, profile_id)
) STRICT;
CREATE TABLE login_never (site_tag BLOB PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
-- meta: 'passwords.key' (wrapped), 'passwords.kdf' (passphrase mode), 'passwords.check'
```

Sign-ins aren't in the model or the reducer: nothing in the shell renders them, and state patches go to every window. Main asks chord-data for what it needs, as it does for history. Export, import and sync name their record types, so `login` is left out of all three until §10 puts it in.

### Performance

- **No vault, or the feature off:** the sentinel isn't installed (the preload reads one flag ⚠ how, with a sandboxed preload, is for the spike: main can answer one `invoke`, or register a second tiny preload only while it's on).
- **A page with no sign-in field:** two passive capturing listeners and one `querySelector` after load.
- **A sign-in page:** one script compile, a scan bounded like the assistant's read (2,000 fields, 250 ms ✅ `ASSISTANT_FORM_SCAN`), one small message per focus.
- **Main:** a `tldts` parse (microseconds ⚠) and routing. Sealing, opening and SQLite are chord-data's. CSV parsing is the import worker's.
- `perf.spec.ts` gains a page load with and without the feature, and the preload's size is held like other budgets.

---

## 9. The interface (sketch, in DESIGN.md's voice; the maintainer designs it)

**The menu under the field** (`PasswordMenu`, in the popover, beside `AuthCard` and `PasskeyCard`).
- Opens when a sign-in field takes focus and there's something to offer; its left edge on the field's, just below it, or above when there's no room. It never covers the sidebar (ARCHITECTURE.md §5). It closes on Escape, a click elsewhere, a scroll, a resize, a tab change, or when the field loses focus.
- Rows: the account's username over its site's host when that differs from the page's. The first is highlighted. ↓ ↑ move, Enter fills, Escape closes. Keys go through main's `before-input-event` while the menu is open, so focus never leaves the page's field and the page never sees them.
- Under the rows: *Other passwords…*, and on a new-password field, first: **Use a strong password**, with the password shown in mono and ↻ for another.
- Nothing saved for the site: no menu at all, except on a new-password field.
- Locked: one row, *Unlock passwords*.
- After a fill, the fields are outlined in the chord's accent for a moment, as §11.6 does.

**The save card** (`SavePasswordCard`, popover, top right of the tab, not modal and never taking focus).
- A key, *Save this password for example.com?*, the username (editable, with the other candidates in a list when Chord isn't sure), the password as dots with an eye. **Save** · *Never for this site* · ×.
- Updating: *Update the password for ada@example.com?* **Update** · ×.
- It stays through the next navigation and goes after a minute ⚠ or when you leave the tab's site. A key glyph in the address pill brings it back while the candidate lasts.
- Saved: a quiet toast, *Saved. It’s in Settings → Passwords.*, the first time only.

**Settings → Passwords.**
- A switch: *Offer to save and fill passwords*. Under it, when a chord has a password manager extension: *Off in Work, where 1Password is installed.* with **Turn on there too**.
- A search field and the list: site, username, when it was last used; a row opens to the address, username, password (dots, *Show*, *Copy*), a note, *Change password on the site* (`/.well-known/change-password`, or Apple's list), **Delete**. Delete has Undo for this session.
- *Add a password…*, *Import…*, *Export…*, *Sites Chord never saves for*.
- Empty: *No passwords yet. Sign in somewhere and Chord offers to keep it.*
- Export warns: *Anyone with the file can read your passwords.*

**Copy to change if this is decided:** DESIGN.md §8.7's *Chord never copies passwords, cookies or extensions*, §7.8's left-out line (still true: it's about the assistant), S15's *Left out* table, ROADMAP.md's *Not planned* entry, D12 and R2.

---

## 10. Sync, import, export, passkeys, HTTP sign-in

**Import** (phase 2). A CSV file you exported from the other browser or manager, parsed in the import-file utility process:

| From | Header |
|---|---|
| Chrome, Edge, Brave | `name,url,username,password,note` ✅ (`password_csv_writer.cc`) |
| Firefox | `url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged` ✅ (`LoginExport.sys.mjs`) |
| Safari, Apple Passwords | `Title,URL,Username,Password,Notes,OTPAuth` ⚠ (secondary sources) |
| Bitwarden | `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp` ✅ |
| 1Password | Title, Website, Username, Password, One-time password, Notes and more; the exact header strings aren't confirmed ⚠ |

- Columns are found by name, case-insensitively, with Firefox's aliases (`login_uri`, `login_username`, `login_password` ✅), so an unknown manager's file mostly works.
- A preview before anything is written: how many are new, the same, or differ from one you have (keep yours, take the file's). Rows without a usable address are listed, not dropped silently.
- One-time-code secrets in a file are ignored and counted.
- Chord doesn't read other browsers' password stores directly: Chrome ties its to Chrome (app-bound encryption on Windows), and reading them is what malware does. That part of the *Import from other browsers* rule stands.
- The FIDO Credential Exchange Format is a Proposed Standard (2025-08-14 ✅), but today's exchanges run through mobile and macOS system APIs an Electron app can't easily join ⚠. Later.

**Export.** Chrome's CSV shape, which everything imports, after the check in §7. Chord's own data file (S15) doesn't carry passwords unless the file is encrypted with a passphrase (question 6).

**Sync** (phase 5, its own decision).
- S15's design fits: a `login` record whose fields merge last-writer-wins (username, password, note, the site), with tombstones, inside the folder's end-to-end encryption.
- **Its own switch,** *Sync passwords too*, off by default, shown only once sync is on. D14 said sync carries setup; passwords are neither setup nor activity, and you should choose it knowingly.
- **The risk it adds:** the folder sits with a cloud provider, protected by a passphrase you chose, and anyone with a copy can guess offline for as long as they like. S15's scrypt parameters and *Suggest one* help. Chord should refuse a weak passphrase for a folder that carries passwords ⚠ how to judge that.
- A changed or deleted password stays in older log segments until that computer compacts (S15 §6). Turning password sync on should compact first, and deleting a password should say it may linger in the folder until then.
- The vault key isn't synced. Records are sealed under the sync key in the folder and re-sealed under each computer's own vault key.

**Passkeys** don't change (§9, *Passkeys*): Windows Hello, Touch ID once builds are signed, security keys. Chord storing passkeys would mean being a WebAuthn authenticator, which Electron doesn't let an app be ⚠. The menu built here is the list *Later: Chord's own passkey list, like Chrome's* needs, so passkey autofill (`mediation: 'conditional'`) can come back through it one day.

**HTTP sign-in** (`AuthCard`, phase 3). The box gains *Remember*, and a saved sign-in for the origin and realm fills the box, never answers by itself. A proxy's password stays unsaved, as DESIGN.md §9 promises, unless the maintainer wants that too.

**One-time codes (TOTP):** not planned. Keeping the second factor beside the password is a decision of its own (question 7).

---

## 11. Living with extensions, and with the assistant

- **A known password manager installed in a chord's profile turns Chord's off there** by default: no menu, no save card. Known by Web Store id: 1Password, Bitwarden, Proton Pass, KeePassXC-Browser, Dashlane, LastPass, NordPass, Keeper, Enpass, RoboForm ⚠ (ids to confirm from the store). Chrome lets an extension turn its own off through `chrome.privacy`, which Electron lacks ⚠, so the list stands in for it.
- Settings says which chords are affected and lets you turn Chord's on there anyway. The vault is still there for Settings and for other chords.
- The first time Chord would show a save card in a chord with an unknown extension that also draws in the field, nothing can be detected; the switch is the answer.
- **The assistant.**
  - Its world (4400) and the agent's (4440) can't see each other, and no assistant tool reaches `main/passwords`.
  - `read_form` already leaves out password fields and never reads values ✅.
  - Settings is a Chord page, which the assistant can't read ✅.
  - A field Chord filled looks to `read_tab` and `tab_screenshot` exactly like one you typed: dots.
  - `classifyField`'s word lists (one-time codes, cards) and the detector's should be one table in core, so they can't drift.
- **Effects** never see form values (D13 ✅).

---

## 12. Security

**What it defends against.**

| Threat | Defence |
|---|---|
| A page's scripts reading a password you didn't mean to give it | Nothing fills without your choice in Chord's own view; only `type=password`, visible fields; the fill is checked against the form as it was shown |
| A look-alike site (`paypa1.com`) | No match, so no menu. *Other passwords…* names both sites and asks |
| A hostile frame inside a real site | Matches are for the frame's own origin and the menu says whose form it is (phase 4); before that, other sites' frames get nothing |
| A real site's frame inside a hostile page | Same rule, same wording: the tab's site is named when it differs |
| A page drawing a fake menu, or over the real one | The menu is a separate view above the page; the page can't draw over it, read it or click it. A fake one can't fill anything |
| A page focusing fields by script to make menus appear | A menu fills nothing. It opens at most once per focus and not for a field that isn't visible |
| A compromised renderer asking for other sites' passwords | Main matches on the origin Chromium reports for the sender's frame, and sends values only to that frame |
| A compromised renderer flooding candidates | One per frame, size-limited, memory only, a card only for the tab on screen |
| Markup or scripts in a username or site name | The popover and Settings render text, never markup; lengths are capped |
| Someone with a copy of chord.db (a backup, a synced folder) | Sealed rows and tagged sites; useless without the OS-kept key or the passphrase |
| Someone at your unlocked computer | *Show*, *Copy* and *Export* ask first where the OS lets Chord ask; elsewhere, only a vault passphrase helps. Fill itself doesn't ask, as in Chrome |
| The assistant, or a prompt injected through a page | §11 |
| A hostile CSV | Parsed in a utility process, size and row limits, every address parsed and checked, nothing loaded or opened |

**What it doesn't.**
- **Programs running as you.** With the OS-kept key they can ask the OS for it on Windows and Linux, as infostealers do with Chrome ⚠. The vault passphrase narrows this to the time the vault is unlocked. Settings should say this in plain words rather than imply more.
- **A compromised main process, or a debugger attached to Chord.**
- **A site's own XSS while you sign in:** it reads what you fill, as it would read what you type.
- **Phishing you confirm:** *Other passwords…* with its warning is still your click.

**For ARCHITECTURE.md §14:** the agent is a new, always-present code path next to every page; the page channels are new IPC from web content; and Chord becomes worth attacking in a way it wasn't. SECURITY.md should say how to report password bugs, and the 72-hour process (§14.3) should cover them.

---

## 13. Tests

The maintainer asked for tests that catch real breakage. Five layers, the first three in CI on every push.

**1. The classifier, in Node** (`packages/core/test/password-forms.test.ts`).
- Chromium's `form_data_parser_unittest.cc` cases, transliterated: each is a list of field records with the expected role per mode.
- Firefox's `TESTCASES` (inline HTML and expected ids), in a file that keeps MPL-2.0. They need a DOM: either run them in layer 2, or add a DOM to Vitest (none is set up today ✅).
- Chord's own table for form kinds, username-only forms and the vetoes.
- Property tests: the classifier never throws, never gives one field two roles, and is stable under reordering of unrelated fields.

**2. The corpus, in real Chromium** (a new suite, e.g. `test/forms`, Playwright's bundled Chromium, no Electron, seconds to run).
- DuckDuckGo's `test-forms`, pinned to a commit and checked by hash. Each file is loaded into a page; the agent's scan runs; its roles are compared with the file's `data-manual-scoring` labels, mapped to Chord's roles.
- **Not vendored:** the files are snapshots of other sites' pages, under Apache-2.0 only as far as DuckDuckGo could grant. A git submodule or a cached, hash-checked download keeps them out of Chord's tree and out of its releases while keeping CI offline after checkout. The maintainer picks which.
- **A baseline file** lists every form Chord gets wrong today, by name and field, as DuckDuckGo's `expectedFailures` and Chord's `perf-baseline.json` do. A form that was right and is now wrong fails CI. One that's newly right fails too, until the baseline is updated, so the number only ratchets up. The total is printed on every run.
- DuckDuckGo's own run has expected failures on 176 of 563 ✅, so the first baseline will not be zero, and shouldn't pretend to be.
- Chord's own fixtures (below) are also run here, and those must all pass.

**3. Journeys, in Chord** (`test/e2e/passwords.spec.ts` and `test/fixtures/passwords/`, served by a local server that records what each form posted).
Each fixture is a page Chord wrote, one pattern each:

- a plain `<form>`; `autocomplete` attributes right, wrong, and absent;
- no `<form>`, a button with a click handler and `fetch`;
- React-style controlled inputs (the assistant's fixture has one ✅);
- a form re-rendered after load, and one replaced while the menu is open;
- username first, then the password on a new page; the same on one page;
- email and username both present; a search box above the form; a newsletter field beside it;
- sign-up with a confirmation; change password with three fields; reset with two;
- a one-time-code step after the password; six one-character boxes;
- a card form with a CVC `type=password`;
- a *show password* toggle;
- a hidden duplicate form (desktop and mobile copies); a honeypot field; a field under an overlay;
- a sign-in in a dialog that closes without submitting;
- a failed sign-in that re-shows the form, then a corrected one;
- an open shadow root; a same-origin frame; another site's frame; a sandboxed frame;
- `http://` and a self-signed `https://`; a sub-domain of a saved site; a look-alike domain; a page under a private suffix.

Each journey asserts end to end: you type and submit, the card offers the right username, you save, the page is reloaded, the field is focused, the menu lists the account, a choice fills, **the page's own script saw the events and the server received the right username and password.** And the negatives: no menu on the look-alike, nothing sent to the other site's frame, nothing written when the form changed.

Also here:
- a forged `passwords:candidate` and `passwords:focus` from a page whose origin doesn't match (run in the page's preload world through a test hook), refused;
- a private window fills and never offers to save;
- a chord with a known manager's extension shows nothing;
- the assistant's journey, extended: after a fill, `read_form`, `read_tab` and the chat's stored rows hold no password;
- chord.db searched as bytes for the test password after a save: absent;
- relaunch: the vault opens again (`--use-mock-keychain` on macOS, per the packaged tests ✅); a wrong or missing OS key says so and loses nothing;
- axe on the menu, the cards and Settings → Passwords, and the capture matrix.

⚠ Playwright's key presses never reach `before-input-event` (§15.5 ✅), so the menu's arrow keys can't be pressed in e2e. As elsewhere: the key routing is unit-tested, and e2e drives the menu through the popover's page.

**4. Data** (`packages/data/test`): the migration; seal and open; a blob moved to another row fails; a wrong key fails closed; tags; CSV parsing against a sample file per source, including quoted commas, newlines in notes, a byte-order mark and 50,000 rows. Later, sync's simulator (`test/sim`) with `login` records.

**5. By hand** (`docs/testing/passwords.md`), per release that touches this, on each OS:
- Google, Microsoft, Apple, GitHub, Amazon, Facebook, X, Netflix, Reddit, Discord, PayPal, Shopify's sign-in, an Okta and an Auth0 hosted page, WordPress's `wp-login.php`, a bank, a router's page on `http`.
- For each: does the menu appear, does it fill, does the site accept it, is saving offered once and only after a sign-in that worked.
- Keychain prompts on an unsigned macOS build after an update; KWallet and GNOME Keyring; a Linux session with neither; Touch ID.

**And a weekly canary** (not blocking): load the public sign-in pages of a fixed list of sites and report where the detector's answer changed since last week. No accounts, no typing. It's flaky by nature, so it files a report rather than failing a build; a real change becomes a fixture.

---

## 14. Corpus and license notes

- **Chromium's and Firefox's test tables** are source code under their licenses: fine to port, Firefox's in an MPL file.
- **DuckDuckGo's snapshots** are the only real-site corpus I found under a permissive license. The Fathom training sets Firefox's model was built on (`mozilla-services/fathom-login-forms`, `fathom-form-autofill`) now return 404 ✅.
- **Academic sets:** `oeschsec/pwmsecurity-usenix2020` exists but has no license ✅, so it can be read, not copied. A Zenodo artifact for a 2024 autofill-leak paper surfaced in search and wasn't checked ⚠.
- **Bitwarden's `test-the-web`** is GPL-3.0 ✅: a good by-hand target, never a fixture source.

---

## 15. Build plan

Each phase ships by itself and leaves nothing half-on. Times are guesses ⚠.

**M0. Spike (about 4 days).** Throwaway code in `spikes/s17-passwords`, findings appended here.
1. A session-registered sandboxed preload wakes a script in world 4440 with `webFrame`, and bridges it with `exposeInIsolatedWorld`. Yes or no.
2. The world can read a same-origin frame's fields and fill them.
3. A card in the popover placed under a field, tracking zoom, scroll and split view; keys through `before-input-event` with focus left in the page.
4. **The bake-off:** a quick port of Chromium's base heuristics run over DuckDuckGo's corpus, beside DuckDuckGo's own result. This is the number that confirms option B or sends the plan to C's matching code.
5. The cost of `nodeIntegrationInSubFrames` on a heavy page (a news site with 30 ad frames): time and memory, with and without.
6. The preload's cost with the sentinel, in `perf.spec.ts`'s terms.
7. `PerformanceObserver` from the isolated world: does it see a fetch finish, with its status.

**Phase 1. Save and fill, the plain case (about 3 weeks).**
- Vault: migration, chord-data's store, the key wrapped by the vault passphrase (decided 2026-11-15, §7): the set-up card, the unlock card in the popover, auto-lock, *Lock passwords*, *Remember on this computer* with `safeStorage`, and the passphrase asked again for *Show* and *Copy*.
- Sentinel, agent, classifier with `autocomplete` and base heuristics; main frame; `<form>` and formless fill.
- Matching: same origin and same site; `tldts`.
- Menu, save card, update card, *Never*.
- Saving on `submit` and on navigation; the reappeared-form check.
- Settings → Passwords: list, search, show, copy, edit, delete, add; the switch; the extension rule.
- Private windows: fill only.
- Layers 1 to 4 of the tests as far as these patterns go, with the corpus baseline in CI.
- D12 rewritten, R2 re-rated, the copy in §9 changed.

**Phase 2. Bring them in, make new ones (about 2 weeks).** CSV import and export; the generator with Apple's rules; sign-up and change-password forms; presaved generated passwords; `/.well-known/change-password`.

**Phase 3. The harder forms (about 2 to 3 weeks).** Two-step sign-ins; saving on formless SPAs (removal after a submit signal); open shadow roots; same-origin frames; recipes for named sites; the appended-code list; `AuthCard`'s *Remember*.

**Phase 4. Frames and locks (about 2 weeks, if M0 says frames are affordable).** Other sites' frames with the named-origin menu; Apple's shared-credentials list; Touch ID. (The vault passphrase and auto-lock moved to phase 1 on 2026-11-15.)

**Phase 5. Sync (about 2 weeks),** as §10, with its own review as S15 had.

**Later, each a decision:** passkeys in the same menu; one-time codes; a check for passwords known from breaches (a request to a third party, so off in Google-free mode's spirit unless asked); the Credential Exchange Format.

---

## 16. Open questions

Questions 1, 3 and 4 were answered on 2026-11-15 (top of this document).

1. ~~**Reverse D12 and take option B?**~~ **Yes.**
2. **Fill only on your choice, never on load?** I recommend it firmly. It's one more key press than Chrome on every sign-in.
3. ~~**One vault for every chord?**~~ **Yes, one vault,** the chord's own recent accounts listed first.
4. ~~**How much protection?**~~ **A vault passphrase on every OS, from phase 1** (§7). No Windows Hello module.
5. **Should passwords ever sync through the folder?** If yes: its own switch, off by default, in phase 5.
6. **Passwords in Chord's own export file:** never, or only when the file is encrypted with a passphrase?
7. **One-time codes (TOTP) in the vault:** never, or later?
8. **Private windows:** fill but never save, as recommended? Or nothing at all there.
9. **With a password manager extension installed,** off in that chord by default, as recommended, or on with a one-time question?
10. **The corpus:** a git submodule of DuckDuckGo's repository, or a hash-checked download cached in CI?
11. **Saved proxy passwords:** still never (DESIGN.md §9)?

---

## 17. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| The detector is wrong on sites people use daily, and trust goes with the first failure | High / high | The corpus ratchet and the by-hand list before each phase ships; fill-on-choice makes a miss a missing menu, not a leak; *Other passwords…* and Settings' *Copy* always work; recipes for named sites |
| Saving offers the wrong thing: a failed sign-in, a one-time code, a search | Medium / medium | A submit signal plus the reappeared-form check; OTP and card vetoes; the username editable in the card; the previous password kept |
| A vulnerability leaks passwords across sites | Low / severe | Main matches on Chromium's origin; values go to one frame; a security review per phase as S15 had; fixtures for every row of §12's table |
| Other sites' frames turn out unaffordable or impossible | Medium / medium | Measured in M0; phases 1 to 3 don't depend on it; *Copy* from Settings is the fallback |
| No server-side hints: two-step sign-ins lag Chrome | High / medium | Local rules, recipes, and the per-provider hand list for Google, Microsoft, Okta, Auth0 |
| Upstream drift: Chromium's parser changes and the port goes stale | Medium / low | The port names its commit; a yearly diff of the upstream file and its tests; the rules change slowly ⚠ |
| The OS key store misbehaves: a Keychain prompt after an unsigned update, a Linux keyring that isn't unlocked | Medium / medium | Already met for sync (§15.2); the vault says it's waiting and loses nothing; the passphrase option |
| The key is lost (an OS reinstall, a new user profile) and the vault can't be opened | Low / high | Say so in Settings; export; sync when it exists; the rows are kept in case the key comes back |
| Expectation: people will treat it as they treat 1Password | Medium / medium | Say what it is: a browser's password manager. No sharing, no vaults, no apps, no breach reports, and extensions still work |
| Maintenance: form heuristics are never finished | Certain / medium | Budget for it; the canary and the baseline turn reports into fixtures |

---

## What was checked, and what wasn't

**Read in this repo ✅:** ARCHITECTURE.md §1, §4, §9, §11.6, §12, §14.1, §15.5, §16, §17; S9, S15 and S16; DESIGN.md §2, §3.4, §7.1; ROADMAP.md; `preload/page.ts`, `main/assistant/forms.ts`, `main/passkeys.ts`, `main/page-call.ts`, `packages/data/src/crypto.ts` and `migrations.ts`; Electron 45.2.3's typings for `safeStorage`, `systemPreferences`, `WebFrameMain`, `webFrame` and `contextBridge`.

**Read upstream ✅** (research passes run for this document; I rechecked DuckDuckGo's `Form.js` and its corpus documentation myself): the Chromium, Firefox, DuckDuckGo, Apple, Bitwarden and Proton facts marked ✅ above, Electron's breaking-changes and `safe-storage` docs, and the CSV headers marked ✅.

**Not verified ⚠:**
- That `webFrame.executeJavaScriptInIsolatedWorld` and `contextBridge.exposeInIsolatedWorld` behave as needed from a session-registered sandboxed preload; that an isolated world reaches same-origin frames' documents; that it can't reach closed shadow roots by any route.
- The cost of preloads in iframes.
- Whether DuckDuckGo's matching code separates from the rest of the library, its policy for other sites' frames, and how its labels map onto Chord's roles in every case.
- Chromium's presave of generated passwords, its matching of the current password on change forms, and its sending of candidates on every edit: from memory, not read this time. `IsPasswordFormReappeared`, named in the brief, no longer exists by that name; the check is inline in `OnPasswordFormsRendered` ✅.
- Safari's and 1Password's fill-on-choice behaviour, Chrome's and Firefox's treatment of stored usernames, and infostealers' methods: general knowledge.
- Safari's and 1Password's exact CSV headers.
- The password managers' Web Store ids.
- The license of Firefox's passwordmgr test files (no header) and of its recipes data.
- Whether `promptTouchID` falls back to the account password on a Mac without Touch ID.
- Every time estimate, the agent's size, and the 20-character default.
- Nothing was run: no spike, no measurement.

## Sources

- Chromium (`https://github.com/chromium/chromium/blob/main/` + the paths in §3), also `components/password_manager/core/browser/password_manager.cc`, `…/password_store/psl_matching_helper.cc`, `components/autofill/core/browser/proto/password_requirements.proto`, `components/password_manager/core/browser/export/password_csv_writer.cc`
- Firefox (`https://github.com/mozilla-firefox/firefox/blob/main/` + the paths in §3), also `toolkit/components/passwordmgr/shared/LoginFormFactory.sys.mjs`, `…/shared/NewPasswordModel.sys.mjs`, `toolkit/components/satchel/FormHandlerChild.sys.mjs`, `modules/libpref/init/all.js`
- firefox-ios's bundle of the same modules: https://github.com/mozilla-mobile/firefox-ios/tree/main/firefox-ios/Client/Assets/CC_Script
- Fathom (archived): https://github.com/mozilla/fathom
- DuckDuckGo autofill: https://github.com/duckduckgo/duckduckgo-autofill (`docs/real-world-html-tests.md`, `docs/matcher-configuration.md`, `docs/runtime.windows.md`, `src/Form/Form.js`)
- Apple: https://github.com/apple/password-manager-resources
- Bitwarden: https://github.com/bitwarden/clients (`apps/browser/src/autofill/`), https://github.com/bitwarden/test-the-web, https://bitwarden.com/help/uri-match-detection/, https://bitwarden.com/help/condition-bitwarden-import/
- Proton: https://github.com/ProtonMail/WebClients/tree/main/applications/pass-extension, https://registry.npmjs.org/@protontech%2ffathom
- Electron: https://github.com/electron/electron/blob/main/docs/breaking-changes.md, https://github.com/electron/electron/blob/45-x-y/docs/api/safe-storage.md
- Public Suffix List: https://github.com/publicsuffix/list ; `tldts`: https://github.com/remusao/tldts
- WHATWG autofill tokens: https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill ; `passwordrules`: https://github.com/whatwg/html/issues/3518 ; change-password URL: https://github.com/w3c/webappsec-change-password-url
- FIDO Credential Exchange Format: https://fidoalliance.org/specs/cx/cxf-v1.0-ps-20250814.html
- 1Password export: https://support.1password.com/export/
- Crest: https://github.com/pauljoda/Crest
