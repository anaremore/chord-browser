# S17: Passwords, built in

*2026-11-15 · replaces D12 (ARCHITECTURE.md §16) and re-rates risk R2 (§17) · phase 1 is built: [the vault](#phase-1-the-vault-as-built-2026-11-15), [the detector](#phase-1-the-detector-built-2026-11-15), and [the menu, fill and the save cards](#phase-1-the-menu-fill-and-the-save-cards-built-2026-11-16). Phase 2's import and export: [built 2026-11-17](#phase-2-import-and-export-built-2026-11-17).*

**Decided 2026-11-15 by the maintainer:**
1. **D12 is reversed: option B.** Chord builds its own password manager, with its own detector (§2–§4). Extensions stay supported.
2. **A vault passphrase on every OS, from phase 1.** Protection must be the same on Windows, macOS and Linux, so the vault key is wrapped by a passphrase you choose (choice (b) in §7), not by the OS alone. This replaces the recommendation below of the OS-kept key by default. It also settles question 4: *Show*, *Copy* and *Export* ask for the passphrase, so no Windows Hello module is needed.
3. **One vault for every chord**, with the chord's own recent accounts listed first (§7, *One vault, every chord*).

**Decided 2026-11-15 by the maintainer, after M0** (§16's remaining questions, each the recommended option):
4. **Fill only on your choice**, never on load (Q2).
5. **Passwords sync only by choice:** their own switch inside sync, off by default, in phase 5 (Q5).
6. **Chord's export file carries passwords only when it's encrypted** with a passphrase; a plain export leaves them out and says so (Q6).
7. **One-time codes (TOTP):** not in phases 1–5; a later decision of its own (Q7).
8. **Private windows fill and never save** (Q8).
9. **Off by default in a chord with a password-manager extension,** with one switch to turn it on there (Q9).
10. **The corpus reaches CI as a hash-checked download,** pinned and cached, never in the repository (Q10).
11. **Proxy passwords are still never saved** (Q11, DESIGN.md §9).

**Decided 2026-11-17 by the maintainer** (phase 2):
12. **Two halves built at once:** import and export on one branch, the generator with the sign-up and change-password forms on another. They meet only in Settings → Passwords and `main/passwords/service.ts`.
13. **The generator's default:** 20 characters from letters and digits without look-alikes, at least one of each, with `-` as the only symbol; a site's own rules (Apple's list, the field's `passwordrules`) come first.
14. **Passwords go in Chord's encrypted file in phase 2** (decision 6 made concrete): a `login` record, in the encrypted `.chorddata` only, never a plain file; sync still never carries them (phase 5).
15. **The file's passphrase is its own.** An encrypted export keeps Your data's file passphrase, with *Suggest one*; Chord never offers to use the vault's passphrase for the file. Exporting passwords asks for the vault's passphrase as *Show* does, at the save.
16. **The interface,** from the owner's mock (`passwords-phase2.html`): the import preview is option 1C, *sentences and a switch, as Your data's import*: *From*, *What comes in* and *Left out*, the switch *Take the file's where they differ* (off: keeping yours is the default) with a checkbox per one that differs, a long list folded behind *Review all* (a search over a virtual list); the result with Undo, in the card and as the window's toast, and no confirm dialog. Export is option 2A, *two radio rows*: *Chord file, encrypted* and *CSV*, the CSV's row with *Anyone with the file can read your passwords.*; in Your data's export card, a *Passwords* row, off and disabled while the file isn't encrypted.
17. **Phase 2 ships as one release, 0.12.0.**

Where the text below still recommends otherwise, these win. M0's findings (at the end) confirm option B and change phase 1 as listed there.

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
| No `<form>`, a `div` and a button (SPAs) | Phase 1 for fill; saving in phase 3 with §6's rules ([3A, built 2026-11-18](#phase-3a-two-step-saving-and-formless-submits-built-2026-11-18)) | Medium |
| React, Vue, Angular controlled inputs | Phase 1: the native setter and `input`/`change` from an isolated world, already proven in §11.6 ✅ | High |
| Pages that re-render the field | Fields are held by `WeakRef` and re-read at focus and at fill | Medium |
| Sign-up and change password | Phase 2 | Medium: the two- and three-password rules are sound; telling sign-up from sign-in by words is fuzzy |
| Two-step sign-ins (Google, Microsoft, Okta) | Phase 3. Fill: the menu on the username step fills the username; the password step, a new document or a re-render, gets its own menu with the same account first. Save: the username you typed is remembered in main for that tab and site for a few minutes, as Chromium's `possible_usernames_` is ✅ (fill built in #46; save [built in 3A](#phase-3a-two-step-saving-and-formless-submits-built-2026-11-18)) | Medium-low without server hints. A by-hand list per provider |
| Open shadow roots (Reddit's components ⚠) | Phase 3: walk `shadowRoot`s, as the assistant's read does ✅; events are read through `composedPath()` ([3B, built 2026-11-18](#phase-3b-open-shadow-roots-built-2026-11-18)) | Medium |
| Closed shadow roots | **Not reachable.** Extensions get `chrome.dom.openOrClosedShadowRoot`; an isolated world doesn't ⚠ | A gap. Rare for sign-in ⚠ |
| Same-site frames | Phase 3: the main frame's world can reach a same-origin frame's document ✅ (M0 §2); [3C, built 2026-11-19](#phase-3c-same-origin-frames-built-2026-11-19): same origin only, never sandboxed, 3 levels and 20 frames | Medium |
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
| A sandboxed frame (with `allow-same-origin` too, phase 3C), `about:blank`, `srcdoc`, `data:`, `blob:` | — | Never |
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
- A switch: *Offer to save and fill passwords*, *In each chord below.*, and under it each chord's own switch, its color and name. A chord with a password manager extension shows off: *Off: 1Password is installed here.* Turning it on there is that chord alone; any chord can be turned off by hand. *(Built 2026-11-16, option A, after the owner missed the first build's single line.)*
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

**HTTP sign-in** (`AuthCard`, phase 3; [built 2026-11-16](#http-sign-in-built-2026-11-16)). The box gains *Remember*, and a saved sign-in for the origin and realm fills the box, never answers by itself. A proxy's password stays unsaved, as DESIGN.md §9 promises, unless the maintainer wants that too.

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
- **Bitwarden's test-the-web** (added 2026-11-16, §14): its sign-in pages, walked step by step, against Chord's own expectations, and filled through the real agent with a fake account. Its own baseline, ratcheting the same way. It runs as its own CI job, apart from any cache a release restores, since its build runs a third party's packages. When the site can't be fetched or built it skips locally and on pull requests, and fails on a push to main or a run by hand.

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
- **Bitwarden's `test-the-web`** is GPL-3.0 ✅: never a fixture source. Since 2026-11-16 it's also the corpus suite's second target (`test/forms/ttw.spec.ts`), tested against and never vendored: nothing from its repository is in Chord's tree, and Chord's expectations for its pages are Chord's own, written by looking at each page. It isn't hosted anywhere (no Pages site; its README builds and runs it), so a pinned, hash-checked download is built at test time into the git-ignored cache, as DuckDuckGo's corpus is fetched into it.

---

## 15. Build plan

Each phase ships by itself and leaves nothing half-on. Times are guesses ⚠.

**M0. Spike (about 4 days).** Throwaway code in `spikes/s17-passwords`. *Done 2026-11-15: see [M0 findings](#m0-findings-2026-11-15) at the end.*
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
*Every question below was answered on 2026-11-15; the answers are at the top of this document.*

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

---

## M0 findings (2026-11-15)

*The spike of §15, run on 2026-11-15. Code: `spikes/s17-passwords/` on the branch `spike/s17-passwords-m0`, kept off `main` (its README says how to run each part). Nothing in `apps/` or `packages/` changed, and no window opened on a desktop.*

**Marks here.** ✅ measured, saying where: *the container* is the Linux E2E container (`scripts/e2e-linux`; X11 under Xvfb with openbox unless it says Wayland, which is headless Weston; *4 CPUs* where it was pinned to four, as perf baselines are); *CI* is the spike's own job (`.github/workflows/s17-spike.yml`). ⚠ inferred, or not measured. Every Electron number is Electron 45.2.3 with the page sandboxed, context-isolated and its preloads registered on the session, as Chord's tabs are. The container shared the machine with other runs, so times are compared only within one run, with the conditions alternated.

### In short

| # | Question | Answer |
|---|---|---|
| 1 | A session-registered sandboxed preload wakes a script in world 4440 and bridges it with `exposeInIsolatedWorld` | **Yes** ✅ (container, X11 and Wayland; CI, Windows and macOS). The fallback isn't needed |
| 2 | That world reads and fills a same-origin frame's fields, React-controlled ones included | **Yes** ✅ (container; CI, Windows and macOS), from the top frame's world. Another site's frame and a sandboxed one are out of reach, as expected |
| 3 | A card under the field through zoom, scroll, resize and split view; keys through `before-input-event`, focus left in the page | **Yes** ✅ (container): placed to the pixel, 0–6 ms behind the page; keys routed with focus kept (X11). **But a click on the card takes focus from the page.** Main can give it back, at the cost of one blur on the field |
| 4 | The bake-off: Chromium's heuristics beside DuckDuckGo's own, on DuckDuckGo's corpus | **Option B holds.** The bare port finds the username and password fields as well as DuckDuckGo does (precision 98%, recall 85% and 98%, against 99% / 84% and 99.7%). It lags only at telling a new password from the current one, and S17 §4's additions close most of that: whole files right, 81% against DuckDuckGo's 83% |
| 5 | The cost of `nodeIntegrationInSubFrames` on a page with many ad frames | 61 frames: **+17% load time, +71 MB (+6%) in renderers, +25% renderer CPU** ✅ (container, 4 CPUs). Windows +5%, +124 MB; macOS +3% ✅ (CI). **Not affordable as a switch on every tab** |
| 6 | The preload's cost with the sentinel, as perf.spec measures | **Nothing measurable** ✅ (container, 4 CPUs): 0.1 ms to run, page memory within noise. Waking the agent costs 4–6 ms after parsing and +0.35 MB |
| 7 | Can `PerformanceObserver` in the isolated world see a fetch finish, with its status? | **Yes, with a condition** ✅: it sees exactly what the page's own observer sees, `responseStatus` included. A fetch shows up only once its body has been read |

### 1. The sentinel and world 4440

**Measured** ✅ (container, X11 and Wayland, the *world* probe in `probes/main.mjs`; with and without Chord's own built `page.cjs` and the extension library's preload registered beside it):
- `probes/preload.cjs` is registered with `session.registerPreloadScript({ type: 'frame' })`, as `preload/page.ts` is. It asks main for the agent with `ipcRenderer.invoke`, then calls `contextBridge.exposeInIsolatedWorld(4440, 'chordPasswords', …)` (four functions, with callbacks both ways), `webFrame.setIsolatedWorldInfo(4440, …)` and `webFrame.executeJavaScriptInIsolatedWorld(4440, …)`. All of them work from the sandboxed preload. The `invoke` took 1.7–4.1 ms and the agent's run 0.2–2.1 ms (React sign-in page, nine launches).
- **Who sees what:** the agent's globals and the bridge exist in 4440 only. The page's main world, the assistant's 4400 and the preload's own 999 all see `undefined` for both; the agent sees `undefined` for the page's globals (`window.reactState`, `window.React`).
- Main gets each message with `event.senderFrame.origin`, which §5's policy needs, and can tell whether it came from the top frame.
- **A strict page** (`default-src 'self'; script-src 'self'; require-trusted-types-for 'script'`): the agent wakes, scans and fills as on any other page. The page's CSP doesn't apply to code run with `executeJavaScriptInIsolatedWorld`.
- **The sentinel stays asleep** on a page with only a search box, even when the box is focused. It wakes on a password field once the document is parsed (in every run, React 19 had rendered the form by `DOMContentLoaded`). It also wakes on focus in an email field, which is wider than it needs to be but cheap.
- **Turning the feature off needs no restart:** `session.unregisterPreloadScript(id)`, and registering it again, take effect from the next navigation. That answers §8's ⚠ on how the preload learns the feature is off: register the sentinel only while it's on.
- **The fallback** (the agent compiled into the preload and run in 999) also works. It costs every page about 1.9 ms more to load (§6 below), and it isn't needed.

### 2. Frames

**Measured** ✅ (container, X11 and Wayland):
- From the top frame's 4440, `iframe.contentDocument` can be reached for a **same-origin frame** and a **`srcdoc` frame**. It is `null` for **another site's frame** and for a **sandboxed frame** without `allow-same-origin`. A frame's elements belong to the frame's own realm: its `HTMLInputElement` isn't the top frame's.
- **Filling a React 19 controlled form in the same-origin frame works** the way §11.6 fills, whether the native setter and `Event` come from the top frame's world or from the frame's own. Either way, the frame's page saw `input` and `change` on each field, and React's state held the values.
- Once the top frame's agent listens on the frame's document, focus in the frame's field reaches it. The rect it reports in the tab's coordinates, with the frame's position added, matches the page's own measurement exactly (X11; on Wayland a scripted `.focus()` fires no focus events, since Weston never activates the window).
- **Phase 3 has to add two things.** The preload doesn't run inside the frame (no agent woke in a subframe), so:
  - the sentinel has to look inside same-origin frames itself and add its `focusin` listener to their windows. The spike's sentinel does this at `load`: it woke with `password-in-frame-at-load` on a page whose only password field was in a frame;
  - the agent has to do the same for a frame that's added or navigated later.

### 3. The card, and keys

**Measured** ✅ (container, the *card* probe in `probes/main.mjs`). The probe lays out a `BaseWindow` as Chord does: a 240 px sidebar view, one or two page views, and the popover view above them, sized to the card only. The agent sends the focused field's rect in its page's CSS pixels. Main places the card at the view's origin plus the rect times the page's zoom factor, 4 px under the field. The system pointer (xdotool, X11) checks each placement: a click at the field's centre must land on the field (the page's own `click` listener reports it), and a press just under the field's bottom-left corner must land on the card.

| State | Card under the field (±1 px), X11 and Wayland | Pointer on the field / on the card (X11) |
|---|---|---|
| 100% | ✅ | ✅ / ✅ |
| Zoom 150% | ✅ | ✅ / ✅ |
| Zoom 80% | ✅ | ✅ / ✅ |
| Scrolled 120 px | ✅ | ✅ / ✅ |
| Window resized (1400×900 → 1100×760) | ✅ | ✅ / ✅ |
| Split view, right pane | ✅ | ✅ / ✅ |

- **Following the page:** zoom, resize and scroll each reach the agent as the page's own `resize` or `scroll` event. The card moved 0–6 ms after the page's event (79 placements over three runs on X11, 15 on Wayland). Closing the menu on scroll, as §9 has it, is still the simpler choice, but following the field works too.
- **Keys** ✅ (X11): with the card open and the field focused, real key presses (xdotool) of ↓ ↓ ↑ Enter went to main's `before-input-event`, which took them with `preventDefault`. The card's highlight moved to the second row, Enter filled the React field, and **the page's own `keydown` listener saw none of the four keys**. Typing `zz` afterwards reached the page as usual: the field held the filled username plus `zz`, and focus stayed in the field throughout (`document.hasFocus()`, `activeElement`). The routing is a pure function (`probes/keys.mjs`), unit-tested in `probes/keys.test.mjs` with 11 cases: closed menu, key up, both ends of the list, Enter, Escape, Tab (closes the menu and goes to the page), letters and modifiers.
- **Electron's own synthetic keys do reach `before-input-event`** ✅ (X11 and Wayland): the handler took `webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })`. So Chord's E2E *can* press the menu's keys end to end through a test hook, which corrects half of §13's ⚠: Playwright's key presses still don't arrive there.
- **A click on the card takes focus from the page** ✅ (X11). The card's view gets focus on the press, the field gets `focusout`, and `document.hasFocus()` goes false. Two remedies were measured:
  - main focuses the page again once the press is over (on the popover webContents' `focus` event, then `setTimeout(0)`);
  - main takes the press in the popover's `before-mouse-event`, so the card never sees the click, and focuses the page on mouse up.

  **Both put focus back in the field, and with both the field still gets one `focusout` and then `focusin`.** A site that validates on blur ("Enter a valid email") will react to that. The keyboard path has none of this.

### 4. The bake-off

**The corpus.** `corpus.mjs` fetches DuckDuckGo's `duckduckgo-autofill` at release 19.2.1 (commit `4d5848619462c863d6bb7553cb090fc74b172be2`) into the git-ignored `spikes/s17-passwords/.cache/`. It checks the tarball's SHA-256 (`9c3e0f78efd8cce6844242963e8319c978dc7512377a4ec15516747f88fbfe56`) and, because GitHub doesn't promise a tarball's bytes stay the same, the tree hash of `test-forms/` (every file's path and SHA-256: `5cceaedd7cdf11ec9999565e78bba313fd69e2c1c04bccbafa946acb120630ce`). Nothing from the corpus is committed.

**Chord's side** ✅ (container, Playwright's headless Chromium, no Electron). Each of the 563 forms is loaded the way DuckDuckGo's harness loads it (`body > div > snapshot`, with its index's title), with the page's scripts blocked and every other request aborted. `agent/scan.js` turns each form into field records, grouped as Chromium groups them (3,160 fields). Two classifiers then run in Node:
- (a) **Chromium:** a TypeScript port of `form_data_parser.cc` in `chromium/form-parser.ts` (BSD-3, `chromium/chromium@4e452b6233bdb0e5cbd67d8837a54cc3e407de91`), 353 lines. It covers `autocomplete`, the base heuristics, the HTML username detector with Chromium's vocabulary, conflicts and `Sanitize`, and gives no suggestions for an `only_for_fallback` parse.
- (b) **Chord:** the same, plus §4's additions in `chord-detector.ts`:
  - the form's kind, from its buttons, headings, attributes and title;
  - a password field's own words (*new*, *confirm*, *current*);
  - the username-only first step;
  - vetoes for search, code and newsletter fields;
  - the email field preferred as username when the nearest field was chosen only for being nearest.

The port with the additions, the scan and the agent come to 46 KB of source, 15 KB gzipped, unminified.

**DuckDuckGo's side** ✅ (container): DuckDuckGo's own classifier, run through its own Jest and jsdom harness (`src/Form/input-classifiers.test.js`) at the same commit. The harness passed exactly as published. `ddg-run.mjs` adds one line so that it keeps every field's score, not only the failures.

**Scoring** (`bakeoff.ts`) goes field by field over DuckDuckGo's `data-manual-scoring` labels: 2,476 labelled fields, 13 of which aren't inputs the scan takes and so count as missed for Chord.
- *username* and *username OR emailAddress* count as username.
- *password.current* and *password.new* count as that variant.
- A plain *password* label counts as any password. In the variant rows it counts as current in a `_login` file, and as new in a `_signup` or change file.
- *emailAddress* isn't scored as username: it's the username when there's a password to save with it, and nothing otherwise. It does count against a system that makes it a password.
- Every other field must get no credential role.

**A correction to §13:** DuckDuckGo's "expected failures on 176 of 563" includes 157 fields labelled *username OR emailAddress*, which its harness can never match, because it compares the label as a single type. Its real misses are about 70 fields.

**Precision / recall, all 563 forms** (a plain *password* takes the variant its file's type implies):

| Role | n | Chromium port | Chromium + Chord's additions | DuckDuckGo |
|---|---|---|---|---|
| Username | 427 | 98.1% / 84.8% | 98.1% / 86.2% | 99.2% / 84.1% |
| Password (any) | 596 | 98.5% / 97.8% | 98.5% / 97.8% | 99.7% / 99.7% |
| Current password | 315 | 69.2% / 94.3% | 90.6% / 91.7% | 93.3% / 92.7% |
| New password | 270 | 87.5% / 49.3% | 89.3% / 86.7% | 91.2% / 91.9% |

Counting only the fields whose label names a variant (59 current, 85 new), precision / recall in the same column order:
- current: 73.6 / 89.8, 87.3 / 93.2, 100 / 100;
- new: 85.1 / 74.1, 88.0 / 85.9, 97.7 / 98.8.

**By form type** (precision / recall):

| Type (files) | Role (n) | Chromium port | + Chord's additions | DuckDuckGo |
|---|---|---|---|---|
| Sign-in (282) | Username (320) | 99.3 / 90.6 | 99.3 / 92.2 | 99.6 / 88.1 |
| | Password (304) | 100 / 98.4 | 100 / 98.4 | 100 / 99.7 |
| | Current (301) | 100 / 94.0 | 100 / 91.4 | 100 / 92.4 |
| Sign-up (150) | Username (96) | 94.1 / 66.7 | 94.3 / 68.8 | 98.5 / 69.8 |
| | Password (232) | 99.6 / 97.4 | 99.6 / 97.4 | 100 / 100 |
| | New (231) | 99.0 / 44.6 | 99.5 / 87.0 | 100 / 92.6 |
| Change, reset (17) | Password (43) | 100 / 95.3 | 100 / 95.3 | 100 / 97.7 |
| | New (34) | 100 / 73.5 | 100 / 82.4 | 100 / 85.3 |

**Whole files right** (every labelled field right, variant included, over the 457 files that have credential fields):

| Files | Chromium port | + Chord's additions | DuckDuckGo |
|---|---|---|---|
| All (457) | 297 (65.0%) | 369 (80.7%) | 380 (83.2%) |
| Sign-in (291) | 86.9% | 86.6% | 84.9% |
| Sign-up (135) | 17.0% | 70.4% | 78.5% |

**The two halves apart.** Chord's additions were written from about a dozen failures read across the whole corpus, so the corpus was also scored in two halves (alternate files of DuckDuckGo's index). F1, first half / second half:

| Role | Chromium port | + Chord's additions | DuckDuckGo |
|---|---|---|---|
| Username | 90.7 / 91.2 | 91.2 / 92.3 | 91.1 / 91.0 |
| Current password | 76.5 / 83.0 | 93.7 / 88.9 | 93.6 / 92.4 |
| New password | 61.4 / 64.9 | 92.4 / 82.8 | 92.9 / 89.9 |

On the first half the additions match DuckDuckGo, so they don't merely fit the failures that were read. On the second, Chord is 3.5 points behind on current passwords and 7 on new ones.

**Where each fails most** (number of fields; examples are a corpus file and a field):

| Failure | Chromium port | + Chord's | DuckDuckGo | Examples |
|---|---|---|---|---|
| A new password taken as current (sign-up forms) | 129 | 28 | 21 | `yahoo_signup` `usernamereg-password`, `usps_signup` `tPassword` |
| A current password taken as new | 13 | 21 | 22 | `pinterest_login` (`autocomplete=new-password` on a sign-in form), `hackernews_login_signup` |
| Username missed: another field chosen | 33 | 33 | 60 | `ifixit_signup` (a *Name* field named `reg-username` wins), `fanfiction_signup` (`penname`) |
| Username missed: no password in its form (first steps) | 24 | 18 | 7 | `homedepot_login`, `microsoft_signup` `MemberName` |
| A field that isn't a credential given a credential role | 16 | 16 | 5 | security answers and tax ids as `type=password` (`usps_signup` `tsecAnswer1`, `irsgov_refund` `TIN2`), a PIN (`hulu_account-pin`), a nickname or a phone number as username |
| A password field not chosen | 9 | 9 | 0 | decoys such as `regPassword-prevent` (`reddit_signup`) and `hiddenPassword` (`nytimes_login_signup`) |

Other counts:
- **Card codes typed as `type=password`** (`walmart_checkout` `cvv`, `containerstore_checkout`) get no role from either port. Chromium's CVC rule rejects them, and the only parse that keeps them is a fallback one, which gets no suggestions.
- **Email fields taken as username:** 85 of the 263 *emailAddress* fields, all but four of them in forms with a password. That's Chrome's behaviour, and it's what saving needs. DuckDuckGo did this for 3.
- **Unlabelled fields given a credential role** (not in the scores; mostly honeypots and decoys): Chromium port 32, with Chord's additions 41, DuckDuckGo 43.

**What it means.** The bare port already matches DuckDuckGo on what decides a fill: which field is the username and which the password, above all on sign-in forms. Its one large gap is the password's variant, which Chromium gets from Google's servers, and the local rules S17 §4 planned close most of it. DuckDuckGo is still better on sign-up forms and at ignoring odd `type=password` fields, mostly thanks to its vocabulary (its matching config), which §3 already allows Chord to copy with its notice. **So option B is confirmed, and C's matching code isn't needed.** Two cautions: the variant matters for generating and saving passwords (phase 2) much more than for phase 1's fill; and these are DuckDuckGo's labels on 563 forms that DuckDuckGo collected for its own detector.

### 5. `nodeIntegrationInSubFrames`

**Measured** ✅ (container, 4 CPUs, the *frames* probe in `probes/main.mjs`).
- **The page:** a synthetic news front page of 30 stories. Each story has an ad frame from a site of its own (`adN.test`) running a 40 KB script, and each ad nests a 1×1 frame from a third site. That's 61 frames, and with site isolation 61 renderer processes.
- **The preloads:** Chord's own built `page.cjs` and the extension library's preload, registered on the session beside the sentinel, as Chord would have them.
- **The runs:** five launches with the switch off and five with it on, alternated, three loads in each. Memory is counted as perf.spec counts it (`RssAnon + VmSwap`), 3 s after the last load.

| | Switch off | Switch on | Difference |
|---|---|---|---|
| Frames that ran the session's preloads | 1 | 61 | |
| First load, median | 1,507 ms | 1,764 ms | +257 ms (+17%) |
| Reloads, median | 1,659 ms | 1,881 ms | +222 ms (+13%) |
| Renderers' private memory, median | 1,171 MB | 1,243 MB | +71 MB (+6%), about 1.2 MB a frame; every run within 2 MB |
| All processes | 1,310 MB | 1,381 MB | +71 MB |
| Renderers' CPU time over the launch | 3.42 s | 4.26 s | +25% |

The sentinel itself ran in 0.2 ms a frame (13 ms over 61 frames). Most of the cost is probably a preload context in every frame, plus Chord's other two preloads running there ⚠ (the two weren't measured apart). A real news site's ads share fewer sites, so it would have fewer processes, but just as many frames and so just as many preload runs ⚠. The switch belongs to a `webContents` and is fixed when the webContents is created, so it can't be turned on only for a page that needs it.

**Verdict: not affordable as a switch on every tab.** Phase 4 (other sites' frames) should wait for a cheaper route ⚠: either Electron running a preload in subframes per script rather than per `webContents`, or an isolated-world call on `WebFrameMain`. Neither exists today.

### 6. The preload's cost, in perf.spec's terms

**Measured** ✅ (container, 4 CPUs, the *preload* probe in `probes/main.mjs`). Two measures:
- **memory:** the page process's private memory (`RssAnon + VmSwap`), 3 s after load and after a garbage collection, the median of five launches. That's perf.spec's *Memory at idle* for *the page*;
- **load time:** each page load, 19 reloads per launch on the plain page and 4 on the sign-in page.

The conditions were alternated each round.

| Session's preloads | Plain page: memory | Load | Sign-in page: memory | Load |
|---|---|---|---|---|
| None | 23.35 MB | 8.9 ms | | |
| Chord's (`page.cjs`, extensions) | 24.75 MB | 11.0 ms | 22.95 MB | 22.5 ms |
| Chord's + the sentinel | 24.44 MB | 11.3 ms | 23.30 MB (agent woken) | 22.2 ms |
| Chord's + the agent compiled in (the fallback) | 24.51 MB | 12.9 ms | 22.86 MB | 23.1 ms |

- **The sentinel costs nothing measurable.** It runs in 0.1 ms, and the page's memory stays within the spread between runs (±0.3 MB).
- **On a sign-in page,** the woken agent adds about 0.35 MB. Waking it took 4–6 ms, all after the page was parsed. Probably none of that is on the main thread's way to first paint ⚠ (not traced).
- **The fallback** would cost about 1.9 ms on every page load, for parsing the agent. Given question 1's answer, it isn't needed.
- **An aside:** Chord's two existing preloads cost 1.4 MB and about 2 ms a page, compared with no preloads at all.

### 7. `PerformanceObserver` from the isolated world

**Measured** ✅ (container, X11 and Wayland). An observer for `resource` entries ran in world 4440 while the page (its main world) made five requests:
- a failing and a successful `fetch` sign-in (401, then 200);
- an XHR (204);
- another site's `fetch` with CORS (200);
- another site's `fetch` without it (`no-cors`).

The page's own observer was the control. What was seen:
- **The isolated world sees exactly what the page's own observer sees,** `responseStatus` included: 401, 200, 204, and 200 across sites with CORS.
- **A `fetch` shows up only once its body has been read.** When the page read only `.status`, neither observer had the fetches 1.5 s later, nor did `performance.getEntriesByType`; the XHR was there. An app that never reads the reply's body (rare for a sign-in, which usually reads its JSON) leaves no entry ⚠.
- A `no-cors` request to another site left no entry.

So it's a good **extra** signal for step 3 of §6: after a submit signal, a 2xx from a request to the form's own origin makes success likelier, and a 4xx makes failure likelier. It should never be the only signal, since an entry carries no request body and doesn't say what the request was for.

### What changes in the plan

**Option B is confirmed**, and so is the shape of the decision. For phase 1:
1. **Register the sentinel only while passwords are on,** with `registerPreloadScript` and `unregisterPreloadScript` (no restart needed). The preload then has no flag to read.
2. **Ship the port with §4's additions, and take DuckDuckGo's vocabulary early** (Apache-2.0, §3), for the password variant and for odd `type=password` fields such as security answers, tax ids and PINs. That's where the remaining gap is. The corpus baseline in CI starts from this spike's numbers: about 81% of files right.
3. **Score *username OR emailAddress* as either one,** or the baseline counts 157 failures that no detector can fix.
4. **Clicking a row:** main takes the press in the popover's `before-mouse-event` and focuses the page again. The agent ignores the one blur that main announces, so the menu doesn't close on it and the fill goes ahead. Pressing Enter needs none of this.
5. **E2E presses the menu's keys with `webContents.sendInputEvent`** through a test hook. That lifts half of §13's ⚠.
6. **Nothing else in phase 1 changes.** Other sites' frames move out of the plan: with `nodeIntegrationInSubFrames`, **phase 4's frames aren't affordable**. Until Electron offers a per-frame route, *Copy* from Settings remains the answer for them.
7. **For phase 3's same-origin frames,** the sentinel looks into same-origin frames itself and listens there, and the agent follows frames added later (§2 above).

### Windows and macOS

**Measured** ✅ (CI, run 43768098813: `windows-latest` x64 and `macos-26` arm64, three rounds each, artifacts `s17-probes-*`). CI's runners have no system pointer, so the card was checked by arithmetic only, and keys only through `sendInputEvent`.

- **Questions 1, 2 and 7 come out the same on both:** the agent wakes in 4440 and is invisible to the main world; the React fill works in the top frame and in the same-origin frame; the same-origin and `srcdoc` frames can be reached and the other two can't; the observer sees 401, 200, 204 and 200 once the bodies are read. The same holds with Chord's own preloads registered beside the sentinel.
- **Question 3:** the card sits under the field in all six states, and `sendInputEvent` reaches `before-input-event`, on both.
- **Question 5** (61 frames, switch off → on, medians):

| | Windows x64 | macOS arm64 |
|---|---|---|
| First load | 3,054 → 3,220 ms (+5%) | 5,548 → 5,720 ms (+3%) |
| Reloads | 1,718 → 1,829 ms (+6%) | 2,436 → 2,798 ms (+15%) |
| Renderers' memory | 1,617 → 1,741 MB (+124 MB, +8%, about 2 MB a frame) | 5,407 → 5,687 MB (+280 MB, +5%; resident set, shared pages included, so it isn't comparable with the others) |

- **Question 6** (page memory, medians of three; Windows private bytes, macOS resident set):

| Session's preloads | Windows | macOS |
|---|---|---|
| None | 29.84 MB (28.66–32.44) | 97.61 MB |
| Chord's | 30.80 MB (30.76–30.87) | 100.94 MB |
| Chord's + the sentinel | 31.91 MB (30.88–33.34) | 101.27 MB |
| Chord's + the agent compiled in | 30.95 MB | 101.61 MB |

  On macOS the sentinel costs 0.3 MB. On Windows three launches can't resolve it: the bare page alone spread over 3.8 MB, and the sentinel's lowest launch equals Chord's own. ⚠ Five launches or more, or perf.spec's own memory test once the sentinel is in the app, will settle it. The sentinel ran in 0.1–0.2 ms on both, and waking the agent took 3–11 ms on macOS and 4–9 ms on Windows.

The workflow runs only on pushes to this branch and goes with the spike.

### What the owner checks by hand

Only what a real desktop can show; everything else above was measured.
- **Keys and focus with a real keyboard and pointer, on macOS and Windows.** CI has no system pointer, and the container runs Linux. These checks need phase 1's menu, since the spike has no product UI. Then, in Chord:
  1. Focus a sign-in field and press ↓ ↓ ↑ Enter. The page must see none of the four keys, and the field must keep its caret.
  2. Click a row. Focus must come back to the field.
  3. Do both again at 150% zoom, and again in split view.

  Before then, the spike's placement checks can be run on a machine nobody is using; it opens a window for about 20 s: `pnpm install`, `pnpm --filter @chord/desktop build`, then `node spikes/s17-passwords/probes/run.mjs --only world,card`. The results land in `spikes/s17-passwords/results/probes/`.
- **A Wayland desktop** (GNOME or KDE): the same checks, since headless Weston never activates a window.
- **A real news site** for question 5's ratio, if wanted: the page measured here was synthetic, and real ads share sites.

---

## Phase 1: the vault, as built (2026-11-15)

*Phase 1's first half, beside the form detector (`feat/passwords-detector`). The menu under the field, filling and the save cards come once both are in. Where this differs from the text above, this is what was built.*

**Built.**
- **Storage** (migration 24, `packages/data/src/passwords.ts`): §7's format. One meta row, `passwords`, holds the KDF, the wrapped key, a check and the OS-kept copy, rather than three keys. `login_use` is keyed by **chord** (`chord_id`), not profile, since chords that share sign-ins are still different chords (§7, *One vault, every chord*). `login_never` seals each site's name too, so Settings can list *Sites Chord never saves for* (§9).
- **The passphrase** is chosen with the first password: Settings' *Add a password…* asks for it, the save card will (its step is `renderer/shared/PassphraseStep.tsx`), or Settings' **Choose…** while there's none.
- **Locking**: after every launch and after *Lock after* unused (default 30 minutes, *Never* allowed), counted from the last use; *Lock now* in Settings. With *Keep unlocked on this computer*, idling still drops the key from memory, and the next use opens it again with the OS's copy; *Lock now* holds until the passphrase is typed, across a relaunch too (`held` in `meta`). *Lock after* stays on each computer, never synced or exported (the maintainer's decision, review round 1): *Never* on one mustn't stop locking on the others. No *Lock passwords* menu item yet: it belongs in the menu under the field.
- **Keep unlocked** isn't offered on Linux without a keyring (`basic_text`), unlike sync's *remember anyway*: there it would be a key in a file any program can read.
- **Show and Copy** ask again after 5 minutes, and also when the passphrase hasn't been typed this launch (the vault opened with the kept key). Touch ID can't stand in yet (phase 4).
- **A copied password** leaves the clipboard after 60 s if unchanged, and at quit; main keeps its hash, not the password.
- **Honest limit: clipboard history.** Windows' clipboard history (Win+V) and its cloud clipboard keep a copied password after Chord clears it. Chrome marks its copies with `ExcludeClipboardContentFromMonitorProcessing`; Electron's `clipboard` can't add that format beside text, so it needs a native helper (performance rule 3: a decision of its own). Until then, Settings' *Copy* is best avoided with clipboard history on. macOS's and Linux's clipboard managers are the same story ⚠.
- **After review round 1** (the planning thread's): opening with the kept key starts the lock's clock, whatever opened it; a lock always hides a password Settings shows (`passwords:changed` with `hide`), and a shown one hides itself after 5 minutes; turning *Keep unlocked* on asks for the passphrase as *Show* does (the popover's card, where it's typed anyway, doesn't); main checks a fill's origin match itself too; a chord id main doesn't know gets nothing (`off`), a private window's fills only; deletions aren't shown while locked; *Start over* is refused while open; Undo's entries go when chord-data starts again; the never list's names are sealed under a key of their own (`chord passwords v1 never`); every copy of the key is wiped once used (HKDF outputs, the wrap's copy, chord-data's reply).
- **Old copies of the key** (review round 1): a new passphrase, *Keep unlocked* going on or off, and *Start over* are written with `secure_delete` on, then the write-ahead log is checkpointed and truncated, and each migration backup (`chord.db.v<n>.bak`, kept as the rollback copy it is) gets the vault's row as it is now, without the OS-kept copy or *Lock now*, or has it taken out (no journal on disk while it's written). A checkpoint another connection holds up (an export reading, sync's own) is tried again every 2 s and at close, until it goes through (review round 2). **Honest limit:** what SQLite or the OS freed before (a deleted rollback journal's blocks, an SSD's remapped pages, the filesystem's or a backup tool's snapshots, a copy of the profile elsewhere) can still hold an old wrap; the old one opens only with the old passphrase, and the OS's copy only for this user on this computer. **And `held`** (*Lock now* across a relaunch) isn't authenticated: anything that can write chord.db can clear it, which is no worse than *Keep unlocked* itself (it can read the OS's copy as you).
- **After a security review** (a subagent's, of this half): *Lock now* during an unlock, or while the kept key is read, leaves the vault locked (chord-data counts locks, and refuses an `open` or an `unlock` from before the latest); changing a sign-in's address in Settings needs the passphrase typed in the last 5 minutes, as *Show* does, since the address decides where it fills; idle with the key kept, Settings isn't told, so it doesn't open the vault again just by refreshing.
- **Delete** has Undo for the session (chord-data keeps the sealed row in memory).
- **The extension rule** (§11): `PASSWORD_MANAGER_EXTENSIONS` (store ids from memory ⚠, unchecked against the store); `settings.passwords.onChords` for a chord's switch turned on despite one, and `settings.passwords.offChords` for one turned off by hand where none is (it wins over `onChords`). Core's `passwordChordPatch` keeps each chord in one list at most, and turning a chord off where a manager is just takes it out of `onChords`, back to the rule.
- **Settings → Passwords** as the owner's mock draws it (DESIGN.md §8.9), and the popover's unlock card (§7.1).
- **The API the menu and save cards call** (`main/passwords/service.ts`, agreed with the detector's half through the planning thread): `accountsFor(origin, chordId)`, `passwordFor(accountId, origin, chordId?)`, `candidateFor(…)`, `saveCandidate({ origin, username, password, chordId, passphrase? })`, `never`, `askUnlock`. Each takes the frame's origin as Chromium reports it (`event.senderFrame.origin`) and the tab's chord; the menu gets usernames and hosts only; private windows fill and never save, and record no use; a proxy's sign-in is refused (DESIGN.md §9); a *Never* site gets no card. The page-side IPC (§8's `passwords:focus`, `:candidate`, `:fill`) is the detector half's.
- **The detector's switch:** the setting is `settings.passwords.enabled`, with each chord's own in `settings.passwords.onChords` and `offChords`. The detector reads neither: `attachDetector` and `stateChanged` call its `setEnabled(on, profileIds)` with core's `passwordProfiles` (each profile with a chord where it's on, and private windows', which fill only), and only when that changes. Wired once both halves were in: `main/index.ts` makes the detector (`passwordDetector`) and attaches it to the vault's service as soon as the state exists.
- **Matching** (§5) is `core/password-sites.ts` (`tldts` 7.4.19, a subpath of core so no renderer bundles the list): same origin, `http` upgraded to `https` on the same host and port, same site on `https`; never `https` for an `http` page.

**Left out, as decided:** import and export (phase 2), sync (phase 5). Sync and Chord's export carry no passwords: the tables aren't record types (docs/data-format.md).

**Tests:** layer 4 in `packages/data/test/passwords.test.ts` (and `export.test.ts`: an export never holds the vault); the clock, extension rule, settings and matching in `packages/core/test/passwords.test.ts`; main's side in `apps/desktop/test/unit/passwords-service.test.ts`; layer 3's vault journey in `apps/desktop/test/e2e/passwords-vault.spec.ts` (light and dark, axe, captures), and Settings → Passwords in `a11y.spec.ts`'s every-section audit.

## Phase 1: the detector (built 2026-11-15)

*Branch `feat/passwords-detector`. The half of phase 1 with no interface. The vault and Settings are being built beside it, and the menu, filling and the save cards follow both. ARCHITECTURE.md §9, *Passwords: the detector*, has the details.*

**What was built**, as §4, §6 and §8 planned, with M0's changes:
- **The classifier** in `packages/core`:
  - `password-parser.ts` is Chromium's `form_data_parser.cc` and HTML username detector, transliterated at chromium@4e452b6 (BSD-3, `LICENSES/BSD-3-Clause-Chromium.txt`). Server and model predictions are left out, as §3 planned.
  - `password-forms.ts` adds §4's layer: the kind of form, vetoes, the password's variant, the username-only first step.
  - `password-vocabulary.ts` holds Chromium's word lists and regexes and DuckDuckGo's credential matchers (Apache-2.0, with its notice), as M0's change 2 asked.
- **The sentinel** (`preload/passwords.ts`) is registered only while passwords are on (M0's change 1). It wakes **the agent** (`passwords/agent/`) in world 4440 through `exposeInIsolatedWorld`. The agent scans the main frame (`<form>` and formless), reports candidates and the focused field's box, and adds nothing to the page.
- **Saving detection** (`main/passwords/saving.ts`): on submit and on navigation, the reappeared-form check, the form going with no navigation, and the `PerformanceObserver` as a hint only (M0 Q7).
- **The corpus in CI** (`apps/desktop/test/forms`, the `forms` job): a hash-checked, cached download (decision 10), with a ratcheting baseline. *username OR emailAddress* is scored as either (M0's change 3).

**Decided with the planning thread** (not owner decisions):
- **No field value goes to main in this phase.** `passwords:candidate` carries the form's id, kind and signal, each role's field by type, id and name, and whether the username and password are filled. The values stay in world 4440. The save card's phase adds one optional `values` field under its own review. So until then, a sign-in that navigates can be *known*, but its password can't be saved, which nothing does yet. §6 step 1 and §8's table have the candidate carrying values; that waits for that phase.
- **The main-side API** for the vault: `createPasswordDetector()` with `setEnabled(on, profileIds?)` (the vault owns the setting and the extension rule), `attachSession`, `attachPage`, and the events `focus` (with the page's zoom), `blur`, `submitted`, `signedIn` and `failed`.
- **Phase 1 is the main frame only:** messages from any other frame are dropped.
- **Private windows** never get `signedIn` or `failed`; the detector enforces it too.

**How it differs from the plan:**
- **No sign-in without a submit signal.** §6's table listed a navigation the page started after you used the form (`PROBABLE_FORM_SUBMISSION`) as a signal by itself. Review found that a link clicked after typing a password then read as a sign-in, so a navigation counts only after a submit signal, as §6 step 2 says. A navigation that never commits (a 204, a download, an aborted one) decides nothing.
- **Rate limits.** The agent sends `forms`, focus and blur at most once an animation frame (focus at most every 100 ms, with a trailing send, so a smooth scroll's last box always gets through), the last state only and nothing unchanged, one candidate per submit, and a blur candidate only after typing (at most once a second). Main holds each page to two token buckets (20 a second, a burst of 10): one for focus and blur, one for the sign-in's messages, so focus traffic can't crowd out the candidate or the `forms` that decide a sign-in.
- **An error vetoes success.** A request to the page's origin answered 400 or more after the submit (the `PerformanceObserver`'s hint) means no sign-in, whatever the page does next: a script that got a 401, showed *wrong password*, and was followed by a click on *Forgot password?*. The veto is sticky: a later 2xx (a captcha refreshed) doesn't lift it. A new submit (a corrected retry) starts afresh.
- **What it can't tell:** a script's sign-in that answers 200 with an error in its body, shows *wrong password*, and is followed by a link you click within the 10 s watch reads as a sign-in. Nothing the agent can see tells it apart; the save card's own wording and the update card's previous password are the remedy.
- **The page can clobber the document's own properties** (`<form name="addEventListener">`, `<img name="title">`): the agent and its scan read the document and forms through their prototypes. The sentinel doesn't; such a page can only keep it asleep.
- **A plain button can submit.** In a `<form>`, a `type="button"` whose words say sign in, sign up, Next or Continue, or the form's only button, is a submit signal: React apps and banks sign in with one.
- **The reappeared-form check matches a field by its type and its id or name.** A held password field with neither is matched by type alone, cautiously: any form on the new page with a password field reads as the form back (a failure), since a wrong failure only loses an offer to save. Matching by position would be a refinement.
- **Channels.** §8 named `focus`, `blur`, `candidate`, `gone` and `still`. Two were added: `forms` (each credential form's fields by type, id and name, which the reappeared-form check needs once the old page is gone) and `hint` (the PerformanceObserver's status). There's no `passwords:fill` yet: it's the menu's.
- **The agent's bridge** is one function (`send`), not four; main sends the agent nothing yet.
- **Vetoes:** a PIN typed as a password is the password where it's the form's only one (Qantas, Deutsche Bank and McGill sign in so). It isn't one beside another password field, or as one of several (gift cards). One-character password boxes are never passwords (§4).
- **The variant:** `autocomplete=current-password` is trusted over the page's words; `new-password` isn't, since sign-in forms carry it (M0 §4: pinterest, oppo, realme, orange).
- **The kind of form** reads the submit buttons' words first (the scan records them apart), then the other buttons', and the nearest heading just outside a form.
- **The username:** an email after the passwords (Chromium's HTML detector reads "Email address" as one of its technical words, `laddress`) is passed over for the username before them. A username field asked for after the passwords stays.

**Measured:**
- **The corpus**, in Playwright's Chromium (headless, Windows and Linux): **394 of 458 files wholly right (86.0%)**, and 82.1% counting *username OR emailAddress* as username only. M0's bake-off had 80.7% by that stricter count, and DuckDuckGo 83.2%. 95 of 2,476 labelled fields are wrong, and every one is in `baseline.json`. An *emailAddress* field taken as the username counts as wrong in a file with no password or username field (a newsletter's). ⚠ The additions were tuned on the whole corpus, file by file through its failures; M0 also scored them on two halves, and this pass didn't.
- **What's still wrong**, by kind:
  - DuckDuckGo labels hidden decoys too (reddit's `-prevent` copies, idme's hidden form);
  - a plain *password* label scored by its file's name, where the form's own words say otherwise (a sign-up form in a `_login` file);
  - `type=text` password fields;
  - first steps whose field names say nothing;
  - a few sign-up forms whose only words are a *Sign in* link.
- **The sentinel**, in perf.spec's terms (Linux container, X11): 3.2 KB built; a plain page's memory +0.2 MB with it registered against without, within noise; load time unchanged (−3 ms, noise). Held in perf.spec: 4 KB, 1.5 MB, and 2 ms on reference hardware.
- **The agent**: 28 KB minified, 11 KB gzipped, within §2's guess of 25–40 KB.

**Tests**, layers 1 to 3 as far as the detector goes:
- **Layer 1:**
  - Chromium's unit-test cases, transliterated (`core/test/password-parser.test.ts`): 100 cases ported, as 116 tests, all passing with no change to the port; 95 left out, each named with its reason (73 need server predictions, 14 model predictions, 5 metrics, 3 URLs or submission events);
  - Chord's own table of kinds, vetoes, variants and first steps (`core/test/password-forms.test.ts`);
  - properties over 1,500 random forms;
  - the tracker's every path, the channels and the sender checks (`apps/desktop/test/unit`).
- **Layer 2:** the corpus, and 20 of Chord's own fixtures, all passing.
- **Layer 3** (`test/e2e/passwords.spec.ts`, X11 and Wayland in the container):
  - the agent asleep without a sign-in field, and gone once off;
  - awake in 4440 only, with the DOM untouched;
  - focus and its box;
  - a sign-in that navigates, one that fails, and a formless one with its hint;
  - forged payloads refused;
  - no typed value in anything main received.
- Firefox's test tables (MPL-2.0, they need a DOM) aren't ported yet.

**Left for the next phases of phase 1:**
- the vault and Settings (being built beside this);
- values in the candidate, under the save card's review;
- the menu under the field and the fill (`passwords:fill`, with M0's change 4 for clicks);
- the save and update cards, and the parts of layer 3 that need them;
- Firefox's tables.

## Phase 1: the menu, fill and the save cards (built 2026-11-16)

*Branch `feat/passwords-fill`: phase 1's last piece, joining the detector's events to the vault's API, as the owner's mock (`passwords-phase1.html`, sections 1 and 3) draws it. ARCHITECTURE.md §9, *Passwords: the menu, fill and the save cards*, has the details.*

**Built**, as §5, §6 and §9 planned:
- **The menu under the field** (`main/passwords/assist.ts`, the popover's `PasswordMenuCard`): focus → `accountsFor` → the menu under the field, placed from the agent's box and the page's zoom, within a frame of the vault's answer. Usernames and hosts, *Other passwords…* (opens Settings → Passwords), *Unlock passwords* while locked, *This page isn't secure* on `http`. Once per focus.
- **Keys** through `before-input-event`, listened to only while a menu is open and until the keys it took are over (their keyUp, and Enter's character, are the menu's too), routed by the spike's function, ported (`menu-keys.ts`). E2E presses them with `sendInputEvent` (M0's change 5).
- **Fill** (`passwords:fill`): only to the frame, origin and document the menu was shown for, checked in main; the agent checks the form again (§5, *At fill*), then the native setter, `input` and `change`, and the outline. Its answer, `filled`, says when nothing was written; a toast tells you.
- **The save and update cards** (`SavePasswordCardView`): `signedIn` → `candidateFor` → the card → `saveCandidate`, or `neverFor` for *Never for this site*. The first one chooses the passphrase with #29's `PassphraseStep`, then the toast.
- **Values on the candidate**, as a commit of its own: only a submit signal's candidate carries the username and the password to save, within the vault's limits. They go page → main only, are never logged, and leave memory once the card is answered, closed or gone (or at once, in a private window or after a failed sign-in).
- **The gates** stay where they were (the switch, the extension rule, Chord's pages, private windows never saving, proxies never), and the tab's are added: nothing for a page that isn't a tab's, or a tab that isn't on screen.

**How it differs from the plan:**
- **Clicks (M0's change 4).** Main hears the press in the popover's `before-mouse-event`, but doesn't stop it: the row gets the click, so main needn't work out which row was under the pointer. For a second after the press, main itself lets the field's blur go by without closing the menu (rather than the agent ignoring it, since the menu is main's), and focuses the page again once the press is over. The field still sees one `focusout` and `focusin`, as M0 measured with both remedies.
- **The menu has a small view of its own** (the owner's answer, 2026-11-16), anchored to the field: the popover's cards (save, update, unlock and the rest) stay where they are, and keep what's typed in them, while it opens and closes. The view is made the first time a sign-in field takes focus in a window (loading while the vault answers), then only shown and hidden. It's the popover's page and API (`#menu`), so it costs a renderer per window that has used it, not one per focus.
- **The menu follows its field** through a scroll, a zoom or a resize (M0 §3 found it 0–6 ms behind), instead of closing on a scroll, and waits out of sight while the field is scrolled away.
- **The key in the address brings a closed card back** (the owner's answer, 2026-11-16, as §9 and the mock have it). × or a minute unused hides the card; the key (`live.passwordOffer`) shows while the candidate lasts, and a click brings the card back. What was typed stays in main only that long: until the candidate's own deadline (`HOLD_MS` after it was typed, which the tracker hands over with `signedIn` as `valuesUntil`, so the card never gets a fresh 5 minutes), *Save* or *Never*, passwords turned off for the chord, leaving the site, a navigation of your own (one without a page initiator: the address bar, a bookmark, Back), a failed sign-in on the tab, or the tab or window closing. Private windows keep nothing.
- **The save card's eye** fetches the password from main when pressed (`passwords:saveCardReveal`, to that card's window's popover only); the popover's state carries the username alone.
- **Sign-up, change and reset forms** get no menu and no card yet: the generator and the change form's matching are phase 2's (§15).
- **A locked vault at a sign-in** still gets the card; Save asks to unlock, then the vault decides between new and update.
- **The card hides** after a minute unused (not while focus is in it), and goes when the candidate does (above), or when another sign-in on the tab replaces it.

**Tests:** the wiring and the gates table-driven in `unit/passwords-assist.test.ts` and `unit/passwords-menu-keys.test.ts`; the values in `unit/passwords-saving.test.ts` and `passwords-detector.test.ts`; the agent's fill in `forms/agent.spec.ts`; and one journey in `e2e/passwords-fill.spec.ts`: save with the first passphrase, offer and fill by keys (the page sees none of them) and by click, update, *Never*, and a private window that fills and never saves, with axe and captures.

**Left for later:** *Lock passwords* in the menu (the vault's note); generating, sign-up and change forms (phase 2); the owner's by-hand checks of keys and clicks on macOS and Windows (M0, *What the owner checks by hand*), which this piece makes possible.

## HTTP sign-in (built 2026-11-16)

*Branch `feat/passwords-http-auth`, for 0.11.1: §10's *HTTP sign-in*, the browser's own box (`AuthCard`) for HTTP Basic and Digest. ARCHITECTURE.md §9, *Sites that ask for a password*, has the wiring.*

**Built**, as §10 planned:
- **Fill.** The box asks the vault (`httpAccountsFor`) for sign-ins saved from the box for the request's own origin (scheme, host and port, from the request main answers, never from the page) and realm (the challenge's, as the box shows it). The popover gets their usernames only (`AuthPrompt.accounts`), best first by this chord's use. It opens filled with the first, the password field holding a mask, never the password, and Sign in focused; a chooser of usernames picks another. Sign in sends `{ account, username }`: main refuses it unless the box's list still has that username there (the list can change under the popover: locked, unlocked, deleted), and unless it came from the popover of the window the box's tab is in; then it answers Chromium's callback from the vault (`httpPasswordFor`, checked in main and in chord-data). Nothing is sent before Sign in. A box waits up to 400 ms for the vault, then shows unfilled and fills when the answer comes, unless you've typed.
- **A frame of another page** (security review): a box for a subframe navigating to another origin than its page's says so (*Asked by router.test, inside evil.example.*, or *…inside another page.* when the page has no origin of its own, a `file:` one say) and isn't filled; the saved usernames are the chooser, so signing in takes a click, never one Enter on a box another site raised. A navigation main couldn't place in a frame, to another site, isn't filled either. Top-level navigations and same-origin frames fill as above.
- **Clicks and Enter wait** (security review, round 2): Sign in, the chooser and *Unlock passwords* are disabled for the box's first 500 ms (`durations.promptInputDelay`), as Chrome's permission prompts ignore input, so a page can't time the box to appear under a click or a held Enter. Cancel and Escape always work; a filled box holds the keyboard itself until Sign in can take it.
- **Locked.** An *Unlock passwords* row (the vault can't tell, locked, whether it holds one for the site, as the menu can't); unlocking fills the box.
- **Remember.** Off for a site with nothing saved, on when the box was filled. What's typed with it ticked stays in main (`http-auth.ts`), never logged, never in a zod message (`auth:` channels are parsed as `passwords:` ones are), until the server answers **the navigation that was answered** (security review, two rounds). `attachPage` follows every frame's navigation on every page: a number at its `did-start-navigation` (by frame tree node id), kept through its `did-redirect-navigation`s, ending at its commit (`did-frame-navigate`) or its failure (`did-fail-provisional-load`, matched by address so a cancelled one's late failure can't end the next). A box is tied to the navigations asking for its address when it asks, and **closes once all of them are gone** (the frame started another navigation, or the request failed or was cancelled), so a box never outlives its request and an answer can't reach a navigation the page swapped in. What's held is tied to those navigations' numbers: only that navigation, through its own redirects, committing that address with a **2xx** saves it (`saveCandidate` with the realm: new, or the same username's new password with the one before it kept). Another navigation starting in the frame drops it, as does any other status (a 401, a router's 403), the request failing, Chromium's retry (the same box again), Cancel, a navigation of the tab, the tab closing, or 5 minutes (`HOLD_MS`). Another frame's commit, even of the same site, says nothing, and neither does a later navigation of the same frame, even one that redirects to the router and gets a 200. Once accepted, a navigation doesn't drop it (the server took it) but the tab closing does, during the unlock card too. A locked vault at that moment shows the unlock card first. The first save ever goes to the form save card (`offerFirstSave`), which chooses the passphrase in its step.
- **An update says so**, with Undo (security review): *Password updated for router.test:8080*; Undo puts the one before it back (chord-data's `revert`), once, from that window's toast only, for as long as the toast could last (`durations.toast` five times over, as a toast pauses under the pointer), and only while the password is still the one that update wrote (its `changedAt`): changed since, by hand or another save, Undo is refused rather than bring back the wrong one. A new sign-in is saved quietly.
- **Storage.** The sealed blob's `realm`. chord-data keeps the two kinds apart in every op (`fits`): a form is never offered, filled from, compared with or updated into a box's sign-in, nor the box a form's; the box's match is exact (no http→https upgrade, no rest of the site).
- **Never** for a proxy: its box doesn't ask the vault, and `saveCandidate` refuses one. **Private windows** fill and never save (*Remember* hidden). **Where passwords are off** (the switch, a chord's own, a password manager's extension), the box is as before.
- **Settings → Passwords** shows *Realm: …* under the site; search reads it too. Edit and Delete are a form sign-in's.

**Decided here** (not the owner's):
- ***Never for this site* doesn't stop *Remember*.** It stops offers to save; ticking *Remember* is asking.
- **No save card when the vault is open:** you ticked *Remember*, so a new sign-in is saved quietly; an update gets its toast with Undo. The first save's card says where it went, as a form's does.

**What it can't tell:** a box answered for a page's own script request (not a navigation) has no commit to read the answer from, so it offers no *Remember*. And a server that answers a wrong password with a 2xx page saying *login failed* reads as accepted; a 403 doesn't.

**Tests:** chord-data's matching, comparing and updating by realm in `packages/data/test/passwords.test.ts`; the service's gates in `unit/passwords-service.test.ts`; the box's fill, stale or foreign answers refused, a frame of another site's page, *Remember*'s default, saving only on the answered navigation's 2xx commit (a sibling frame's says nothing, nor the frame's next navigation redirecting to a router page), a box closing when its request goes (sent elsewhere, failed, a late failure leaving the next box alone), the drops, private windows, proxies, the switch, unlocking and the update's Undo, table-driven in `unit/http-auth.test.ts`; `auth:` requests refused without detail in `unit/ipc-secrets.test.ts`; the first save's card in `unit/passwords-assist.test.ts`; and `e2e/passwords-http-auth.spec.ts` on the Linux runner: a wrong password not saved, *Remember* and the first passphrase, a reload filled, another site's page framing the router (the frame sent elsewhere closes the box), a private window that fills and doesn't save, and a proxy's box without *Remember*, with axe and captures.

## The sign-in sweep (2026-11-16)

*Branch `test/passwords-top-sites`. A reusable tool, `scripts/dev/signin-sweep` (its README says how to run it), and what it found on the top of the Tranco list. The report names sites and stays outside the repo; this note describes patterns only.*

**The tool:** the agent in world 4440 of an Electron window per site, in the Linux container: the page with no credentials, its *Sign in* link followed once, the scan and `classifyPasswordForm(…, 'filling')`, focus on each field a person would use, the agent's fill with a fake account as main sends it, and on a first step one press of Next (never on a page that would send a code or a link). Nothing is submitted beyond that. The S17 §13 weekly canary could be built on it.

**Swept:** 570 sites (after taking out infrastructure, adult and gambling sites), about 255 sign-in pages reached; the rest blocked automated browsers, hid their sign-in behind a menu or another site's buttons, or didn't load.

**Fixed** (each with a unit case or fixture in Chord's own markup; the corpus unchanged at 393 of 458 files):
- A password step that carries the username from the step before, read-only or hidden and already filled (identity providers' hosted pages): the fill writes the password alone when the carried username is the account picked.
- Sign-in and sign-up forms that reuse ids: a `label[for]` counts only from the field's own form or outside any form, so the sign-in password no longer reads as a new one.
- *Log in or sign up* over one email field, its Continue outside the `<form>`: a first step.
- A first step whose next password field is in the same form, focusable but transparent: a first step, not a sign-in the fill then refused.
- A first step swapped into its password step in place, focus moved by the page with no blur: the password gets its menu (main's "not again in this form" holds while the form keeps its role or its kind (it reopens only when both change)).

**Left as proposals:** phone-number first steps (mostly one-time codes: no password to fill); fields a page clears or re-renders after a fill; a step after an unknown email that reads both as sign-up and as a current password; and the later phases' patterns: open shadow roots and same-origin frames (phase 3), other sites' frames (phase 4).

## Phase 2: import and export (built 2026-11-17)

*Branch `feat/passwords-import-export`, the half of phase 2 beside the generator and its forms (`feat/passwords-generator`), for 0.12.0. Where this differs from §10, this is what was built.*

**Built**, as §10 planned:
- **CSV import** (Settings → Passwords → *Import…*). Main shows the open dialog and keeps the path; the import-file process reads the file a megabyte at a time (`core/password-import.ts`'s `PasswordCsv`: RFC 4180, a byte-order mark, `\r\n`, `\n` or `\r`, quotes and line breaks in notes, lenient where exporters are) and sends its sign-ins **straight to chord-data over a port**, never through main. They're staged there, in memory, by an id main made, until imported, let go, or 10 minutes pass. Only chord-data, which alone holds the vault key, compares and writes (`data/password-transfer.ts`).
- **Columns by name**, compared without case, spaces, `_` or `-`, with each manager's names: Chrome, Edge and Brave; Firefox (`httpRealm` makes a sign-in box's sign-in); Safari and Apple Passwords; Bitwarden (`login_uri`…; its notes, cards and identities are listed as *not a sign-in*); 1Password 8's and the older header; and the common names (`website`, `login`, `email`, `notes`…), so an unknown manager's file mostly works. A file without an address or a password column is refused, saying which. Whose export it is shows in *From*, read from the header.
- **The preview, before anything is written:** new, the same, and different. A file's sign-in is yours when its origin, username and realm are the same: exactly, not the rest of its site, so `login.example.com` is never folded into `example.com`. It's the same when the password is (and the file's note is empty or yours); different when the password or the note isn't, and the preview says which. Settings gets addresses and usernames, never a password.
- **Rows left out are listed** with their row (the header being row 1) and why: no address, an app's (`android://`, `ios-app://`), not a web page's (`chrome://`, `file:`, `javascript:`), no password, too long (S17 §8's limits: refused, never cut), not a sign-in. A field may hold several addresses: the first that works.
- **One-time-code secrets** (`OTPAuth`, `login_totp`, *One-time password*) are never kept, and counted (decision 7).
- **The vault must be open**, or made: with none, the preview shows everything as new and *Import* asks for the first passphrase (`PassphraseStep`); locked, the file is read but nothing is compared until it's unlocked, in the card.
- **Never another browser's store:** Chord reads only the file you chose.
- **CSV export** in Chrome's shape (`name,url,username,password,note`), written by chord-data to the file the save dialog chose (`<name>.part`, then renamed), after the passphrase as *Show* asks for it, and with §9's warning on the CSV's row.
- **Chord's encrypted file** (decision 6, docs/data-format.md *Passwords*): a `login` record per sign-in, after everything else, in the encrypted frames only; `includes` names `passwords`. The export process can't open the vault, so chord-data sends the records a page at a time over a port main makes only after the passphrase check, and only while the vault stays open: one that locks part way stops the file, which isn't kept. A plain export never has them, and Your data's card says so. Settings → Passwords → *Export…*'s *Chord file, encrypted* writes the passwords alone.
- **Importing a Chord file** stages its `login` records the same way while Your data's import reads it, with the same preview (its *Passwords* row, which unlocks or chooses the passphrase in place), and brings them in last, keeping yours where they differ; one Undo takes them back with the rest. A plain file's `login` records are passed over and counted.
- **Undo** for the session, from the card and from the window's toast (the shell's `import.undo`, routed to the passwords): what came in goes, and what was replaced comes back as it was, sealed (no key needed). One you've changed since stays as you left it, and Undo says so.

**After a security review** (a subagent's, of this half): it found no way for a password to reach a renderer or main, no export without the passphrase check, and no password in a plain file. What it found, each fixed: an import that failed part way (a full disk) left its rows without Undo, so now it says it stopped and keeps its Undo; chord-data took what the import process sent on a stage's port into a handler that could throw, and passed its listed rows on unchecked, so now every batch is checked whole (rows, kinds, text cut, the problem one Chord knows, a change time within the year 9999) and never crashes it; a file's sign-ins in memory are capped at 64 M characters (a Chord file had no cap, as a CSV's size is one); *Lock now* or idle lets a staged file go; a CSV export chord-data didn't finish has its `.part` removed by main; the export port is closed if the export fails before its process takes it; and `export:` and `importFile:` requests, which can carry a passphrase, are refused without detail as `passwords:` ones are.

**After review round 1** (the planning thread's):
- **Several addresses in one field** (Bitwarden joins them with a comma or a line break, no space) are read as pieces first, the first that works; the whole field only when it has no separator, and a host with `,` or `;` is never one. Before, `https://a.com,https://b.com` came in as the origin `https://a.com,https`, which could never fill.
- **Never the vault's passphrase for a file** is enforced, not only promised: before an export with passwords, chord-data checks the file's passphrase against the vault's (`verify`, which leaves the vault as it is) and refuses it: *Use a different passphrase from the one your passwords are locked with.*
- **Never in a plain file** is held at each place, table-tested (`unit/passwords-plain-file.test.ts`): main asks for the passwords' port only for an encrypted file; the export process closes any port it's given unless the file is encrypted and asked for them (`export/passwords.ts`); the import reads a `login` record only from an encrypted file (core's `loginFromFile`); and a reader that doesn't know them passes over the record and the `passwords` part. A file saved without them (plain, or *Passwords* off) says how many were left out.
- **A budget:** CI runs the 5,000-row import alone (`CHORD_PASSWORD_PERF=1`, its own step) and fails it when chord-data's longest task passes 100 ms: measured 9.4 ms there (Linux, CI's runner), and 10.6 ms on an SSD and 40 ms on a slower drive on Windows.
- **Unlisted conflicts** (past 10,000) take the file's only with the switch itself on, never because many rows were ticked by hand (core's `importChoices`).
- **Smaller ones:** the key comparing sign-ins is JSON, not parts joined by NUL; a username with a control character is left out (*a username with characters a page can't hold*); a too-long field counts only in a column an import reads (Bitwarden's `fields` no longer refuses its row); a CSV must be a file and is read no further than the size limit, whatever its size said; a stage's 10 minutes start again when its import starts; an Undo that fails part way keeps the rest to be tried again, taking nothing back twice; Your data's export card counts passwords without opening the vault (which would restart *Lock after*).

**After review round 2:** an Undo that fails part way is kept by main too, not only chord-data: pressing Undo again (in the card, which says *Chord couldn't undo all of the import. Try Undo again.*, or the toast's *Try again*) takes back the rest, and two at once (the card's and the toast's) run one at a time. The check that a file's passphrase isn't the vault's fails closed: when it can't be made, the export doesn't go ahead. With the switch on, its line and the bar count the conflicts past the list too.

**Decided here** (not the owner's):
- **The same file again** imports nothing: everything reads as the same.
- **A sign-in twice in one file** is one, the later row's, and the preview counts it.
- **A conflict's choice** is by its place in the file; Settings sends whichever list is shorter (*keep yours except* or *take the file's except*). More than 10,000 that differ are listed to 10,000; the rest follow the switch.
- **A sign-in box's realm goes out as its address** in a CSV (CSV has no realm), so a CSV brought back makes it a form's. Chord's file keeps the realm.
- **A CSV's values are never changed:** no spreadsheet-formula escaping (`=`, `+`, `-`, `@`), which would change a password. Opened in a spreadsheet, such a field is the spreadsheet's to interpret.
- **What a `login` record leaves out:** the password before the last change, which chords used it, and the never list.
- **Limits:** 64 MB of CSV, 50,000 rows (the rest counted), 64 KB a field, 200 columns, 1,000 listed rows, 10,000 listed conflicts, 64 M characters of sign-ins held from one file.

**Measured:**
- **In the app** (`e2e/passwords-transfer.spec.ts`, the Linux container, X11): the 6,240-row Bitwarden file into a vault of 329, from *Import* to its result line, **414 ms**.
- **chord-data's side, 5,000 rows** against a vault of 500 (`data/test/password-transfer.test.ts` with `CHORD_PASSWORD_PERF=1`, Windows 11, Node 24): the preview 22–24 ms; the import 0.7–1.0 s; its Undo 80–245 ms. A row is a seal, a tag and an insert, 100–250 µs (Node's cipher and HMAC objects are most of it), so the import writes for 4 ms, then lets chord-data answer anything else (the command bar's searches), and SQLite's checkpoints come smaller meanwhile, as for history's imports. chord-data's longest task during the import: **9.4 ms** on CI's Linux runner, **10.6 ms** on an SSD and **40 ms** on a slower drive on Windows (there, a commit carrying a checkpoint, as S15 §12 found for history). CI holds it to 100 ms. Main does nothing but route, and the renderer draws only the lines in view.

**Tests:** the reader, each manager's header, CSV's corners, which rows come in, the diff and the `login` record, table-driven in `core/test/password-import.test.ts`; staging, the preview (open, locked, none), the import as chosen, a lock part way, the same file again, Undo, the CSV export read back and the records' pages in `data/test/password-transfer.test.ts`; main's gates (busy, no vault, locked, the passphrase), the toast and its Undo in `unit/passwords-transfer.test.ts`; and three journeys in `e2e/passwords-transfer.spec.ts` on the Linux runner: a Chrome CSV with its preview, ticked, Undo, the same file again, both exports (light and dark, axe, captures); an encrypted file's passwords through Your data into a new profile; and the 6,240-row Bitwarden file with *Review all*.

**Left for later:** Settings → Passwords → *Import…* takes CSVs only (a Chord file goes through Your data); the FIDO Credential Exchange Format (§10); sync (phase 5).

## Phase 2: the generator, sign-up and change (built 2026-11-17)

*Branch `feat/passwords-generator`: half of phase 2, beside import and export (`feat/passwords-import-export`). The interface is the owner's choice of 2026-11-17, option A of each of the planning thread's mocks (`passwords-phase2.html`, sections 3–6). Where this differs from §6 and §9 above, this is what was built.*

**Built**, as §6 (*Generating*, *Change-password forms*) and §9 planned:
- **The generator** (`core/password-generator.ts`, run in main by `main/passwords/generator.ts` with `crypto.randomInt`). The default is 20 characters from letters and digits without look-alikes (Chromium's sets: no `l o I O 0 1`), at least one lower case letter, one capital, one digit and one `-`, about 105 bits (each of those four places counted at its own class's bits).
- **Site rules take precedence, in this order:** the field's `passwordrules`, then Apple's `password-rules.json` for the site, then `minlength`/`maxlength`. A source that says nothing (empty, unreadable) passes to the next. A lower source narrows a higher one only where they agree: a `maxlength` under the site's own `minlength` is ignored. Within the rules, the default's alphabet is used wherever they allow it. Every password made is checked against its rules; rules that can't be met (a `maxlength` shorter than the classes required, nothing but a space allowed) give no row.
- **Apple's files, vendored** at `apple/password-manager-resources@410bea2` (2026-11-17), MIT (`LICENSES/MIT-Apple-password-manager-resources.txt`):
  - the parser, transliterated in `core/password-rules-parser.ts`, and checked against Apple's own test cases (`core/test/apple-password-rules-cases.json`);
  - `password-rules.json` and `change-password-URLs.json`, unchanged, in `core/vendor/apple-password-manager-resources` (its README says how to update).

  `@chord/core/password-quirks` and `@chord/core/password-generator` are subpaths that main loads the first time a new password's field takes focus, never at launch or in a renderer.
- **The menu on a new password's field** (3A): *Use a strong password* first, built like an account row. The password is in mono on its second line, the site's rules in words under it where they shaped it (*Letters and digits, 12–16, as this site asks*), and ↻ at the row's end. The accounts and *Other passwords…* follow, past a hairline. ↓ ↑ Enter as ever.
  - **↻ by key: Ctrl+Shift+K (⇧⌘K)**, shown in its tooltip, taken only while the menu is open. Arrows are the page's caret's. It's free in Chord's shortcuts (S8) and isn't Chrome's. It doesn't edit text: Ctrl+Shift+V pastes, Z redoes, and GTK's U starts Unicode input. It types no character, as Alt or Option would. While the menu is open it wins over a shortcut of your own on the same key (Settings → Keyboard shortcuts), as the menu's arrows and Enter do.
  - **On a form that reads as a sign-in** (its password field carrying `autocomplete=new-password`, as some sites' do), the first account is highlighted; the generator's row stays first.
  - **A floor under "strong"** (review round 1): rules that hold the password under 8 characters, or under about 40 bits, still get the strongest password they allow, as *Use a password this site allows*, with the limit in words (*Only 4 digits, as this site asks*). No color or badge: the words say it. Its bits are counted from the pool it was drawn from alone (review round 2).
  - **Never a look-alike** (the owner's decision of 2026-11-18): one list, `LOOK_ALIKES` (`0 O o 1 l I |`), left out on every path. Where the default's alphabet is under the floor, the password is drawn from everything the rules allow but look-alikes; where that's still under it, it's made longer, within the rules' maximum, and only while the rules' run limits are still met easily (a union bound of at most 1/2 per try).
  - **Under the floor too** (review rounds 2 and 3 of #56): when that clean password can't reach 40 bits (a short maximum, run limits), it's offered as long as they let it be, weak, and still without look-alikes: four digits are from 2–9, and one clean character allowed (`allowed: [a0O]`) is that character alone. Look-alikes come back only where the rules can't be met without them: a required class of look-alikes alone (`required: [0O]`) gets one of them in one place, every other place clean; and rules allowing only look-alikes (`allowed: [0O]`: 42 of them) are drawn from those.
  - **Bits are a lower bound** (review rounds 1 and 2 of #56): each forced place (the rules' required classes and the default's own: a lower case letter, a capital, a digit, the dash) counts at its own class's bits, every other place at the pool's. The known exception is run limits: passwords that break them are drawn again, which takes a little from that count and isn't subtracted yet ([#60](https://github.com/anaremore/chord-browser/issues/60)).
  - It's offered on a `new-password` or `confirmation-password` field of any form but a first step, as the menu's accounts are on the others. Not in a private window (it never saves), nor where passwords are off.
- **Saved the moment it's filled** (presave), before any submit: a new sign-in for the frame's origin, no username yet, *Not confirmed*.
  - Locked, the unlock card comes first. With no vault yet, the save card's passphrase step comes first, and nothing is filled until it's saved; cancel either, and nothing is filled.
  - It's saved on a site you said never to save for: generating is asking.
- **Filled** only into the frame, origin and document main showed the menu for. The agent writes it only into the form's new password's field and its confirmation, each a visible `type=password` field you could type in, never the username or the current password. It refuses (*the form changed*) when the new password's field isn't the one it knew before its rescan, or when a field it saw as a password is text now (a show-password toggle).
- **The tab remembers its presave for the site for 10 minutes** (`PRESAVE_MS`), in memory. A second step's confirmation, or the page reloaded, is offered *the same* password, so nothing is made twice. A new one (↻) in the same form, or in a form of the same kind on the site's page loaded again, before any submit, changes that entry, keeping the one before; a change or reset form's entry never goes to a sign-up's, nor the other way round. A submit of that form the site rejected (`failed`) counts as none; another form failing on the site says nothing about it. After a submit nothing failed, it's a new entry, since the site may have the first. Another form on the same page is another entry.
- **The entry takes its username at the submit** of its own form (`submitted` now carries the username, never the password). A sign-in that worked with it confirms it, and the **saved card** says so (5A): *Your new password for example.com is saved.*, the username, **Done**, *Delete it*.
- **Sign-up with a password you typed:** phase 1's save card, titled *Save the password for your new account on example.com?*
- **Change and reset forms:** the agent's candidate at a submit carries the current password beside the new one (`values.current`), for main only.
  - The account is the saved one on the site whose password is the current field (chord-data's `matchCurrent`), as the owner decided. The form's username only chooses among several that match; it never stands in for the current password. The change's own presave is never a match, nor among the chooser's rows.
  - Locked when the change worked: the update card, titled by the site (*Update a password for example.com?*), since which account it is waits for the unlock. Its **Update** unlocks, then finds the account as above. It updates at once only if exactly one account matched and the form showed that username, or none. Otherwise it shows the account it found, or the chooser, and waits for a second **Update** (review round 2), so a form showing one username never updates another account. The form's current password is held only as long as the card.
  - Filling an account into a change form puts its password in the current field only: the new one and its confirmation stay empty, yours to choose (review round 1; phase 1's *never half a fill* left them in the way).
  - One → the update card, for a generated password too, applied on **Update** only. Updating also deletes the change's presave.
  - None or several → *Which account on example.com did you change?*, with the sign-in box's chooser rows. **Update** waits for a pick; *Save as new* keeps it as another sign-in. None saved for the site at all → the save card.
- ***Not confirmed*** (4A).
  - In Settings → Passwords it replaces the date in the right column; *No username yet* where there's none. The row's detail says it in one line: *Not confirmed: Chord made this password today and kept it, but hasn't seen the site take it. If the sign-up didn't go through, delete it.*
  - In the menu it reads *Not confirmed · made today*, after the confirmed accounts.
  - Never lost: an entry no submit confirmed stays in the vault and in Settings for good. It's in the menu for a day after it was made (`UNCONFIRMED_IN_MENU_MS`), long enough to come back to a sign-up that failed, then in Settings only. A sign-in that works with it, or a save over it, confirms it.
- ***Change password on the site*** (6A): Apple's page for the site where its list has one, else the site's `/.well-known/change-password`. Apple's lists are looked up by the host and its parents down to its registrable domain (`tldts`, private suffixes on), never a public suffix such as `co.uk`.
  - Only `https`: an `http` sign-in's detail says *This site isn't on HTTPS, so Chord doesn't open its pages for you.* Main works out the address from the sign-in Settings was shown (`passwords:changeOnSite`), never from the renderer.
  - Once it's opened, one line: *Opened in a new tab. Use a strong password there, and Chord updates this one when the site takes it.*

**Decided here** (not the owner's):
- **Private windows get no generator:** they never save, and a generated password that isn't saved is one you can lose.
- **An account picked on a new password's field** (a sign-in read as a sign-up) fills its password into that field and the confirmation (`intoNew`), when the form has no current password's field. Picked anywhere else, such a form still gets nothing (phase 1's *never half a fill*).
- **The sign-up's saved card replaces a quiet confirmation, and the matched change's update card a quiet update:** the mocks show both. A generated password is applied to an account only on **Update**. Closing the card leaves the presave as it was, *Not confirmed*.
- **A password typed over the generated one before the submit** isn't told at the submit (that would send it before a sign-in worked). The sign-in that works offers the save card for it, and the presave stays *Not confirmed*.

**After a security review** (a subagent's, of this half):
- **A page can't make main generate in a loop.** Each generation draws at most 20,000 characters, whatever the length. Rules that can't be met are remembered for the document, so moving focus between such fields costs one generation, not one per focus.
- **The tab's presave is offered again only while the vault is open.** Locked (by you or its clock) or started over, it's forgotten: a new password is made, and choosing asks to unlock. One offered just before a lock asks to unlock before it's filled.
- **The generator's row takes no Enter, and no click, for `durations.promptInputDelay`** (500 ms) after it opens, as the sign-in box's buttons don't, so a page can't focus a field by script under an Enter or a click meant for something else.
- **The frame is checked before the password is saved,** as well as before it's sent: a page that went meanwhile gets nothing and leaves no presave behind.
- **↻ sits over the row's end, outside its option** (axe's *nested-interactive*: a button can't be inside an option). The look is the mock's.

**The parser is Apple's, transliterated,** not a dependency: Apple publishes it as a tool, not a package, so Chord keeps a TypeScript port at the vendored commit, checked against Apple's own test cases, to update with the lists.

**What it can't tell:** a sign-up whose submit Chord doesn't see (a formless one, phase 3) leaves its presave *Not confirmed*, with no username; the next sign-in with it confirms it. A change form with neither a username nor a current password's field can't be matched, so the card asks.

**Measured:** the corpus is unchanged at **393 of 458 files** (the classifier wasn't touched); the agent is a few hundred bytes larger.

**Tests:**
- **Generator:** Apple's parser cases, the default, which source wins, rules in words and rules that can't be met (`core/test/password-generator.test.ts`). As properties: a password for every site in Apple's list, ten times each, checked against its rules, and 3,000 random rule sets.
- **Data:** presave, pending, confirm and `matchCurrent`, and nothing of them in chord.db's bytes (`data/test/passwords.test.ts`).
- **Service:** the gates, the menu's day, the change's update and *Change password on the site* (`unit/passwords-service.test.ts`).
- **Assist** (`unit/passwords-assist.test.ts`), table-driven: which field gets the row, choosing it locked, with no vault or cancelled, the frame checks, the presave offered again, the submit's username, the saved card, every change case, the key.
- **Agent** (`forms/agent.spec.ts`): the field's rules at focus, the generated fill (only visible `type=password` fields, never the current one), `intoNew`, and the change form's current password.
- **Journey** (`e2e/passwords-generate.spec.ts`, Linux runner): a sign-up with no vault yet (the rules in words, ↻ by key unseen by the page, the passphrase, the fill, the site's post), the saved card, the sign-in's fill, a change matched by its current password and updated, and a presave never submitted in Settings, *Not confirmed*; with axe and captures.

## Phase 3A: two-step saving and formless submits (built 2026-11-18)

*Branch `feat/passwords-3a-two-step`: the first of phase 3's slices (3A two-step saving and formless submits, 3B open shadow roots, 3C same-origin frames, 3D recipes and the appended-code list), as the planning thread and the owner approved them on 2026-11-18. No new interface: the save card and the menu are phase 1's.*

*Split on 2026-11-18 (the owner's decision, after review round 4):* this is **3A-1**. Deciding that a sign-in with no navigation worked (the form going, or a same-document route change: the agent's watch and the tracker) is as phase 1 built it; a new check for it, with Save held until a late error could take the sign-in back, is **3A-2**, built after this merges.

**Built**, as §4's table and §6 planned:
- **A first step's username.** A form the classifier reads as `username-only` (for saving too, so a value is in it) sends main the username at its submit signal, on a channel of its own (`step`), once per submit. At your Enter or click it's taken as it is, typed or not (an email the site remembered is yours too, and a person often types before the agent wakes); at a form's `submit` alone, which a script can make, only one typed or filled. Never one or two digits (Chromium's rule), never at a blur, never for a search, newsletter or sign-up's email (table rows in `core/test/password-forms.test.ts` and `forms/agent.spec.ts`).
- **Main keeps it** for the tab and site (the registrable domain, as saving reads it), in memory only, for 5 minutes (`FIRST_STEP_MS` = `HOLD_MS`), one per site. **It's used at most once:** the next sign-in on its site, worked or failed, with a card or without, takes it away, so a second account picked from the site's own chooser (no new first step) never gets the first one's username. It's gone too at 5 minutes, when passwords are turned off there, or when the tab closes, and a newer first step replaces only its own site's. The checks after each wait (the tab, private, the switch, the document) are made again before it's kept or used. Never from a private window (the detector drops `step` there, and the assist keeps none), and never in a log.
- **A password step with no username of its own** (a new document, or a re-render that drops the field) takes it for the save card, and for a generated password's presave at its submit. A change form never does: its account is found by its current password.
- **The password step's menu** lists that account first (by username, ignoring case).
- **Formless submits.** A `div` or `span` with no button's role counts as a submit signal when it shows it can be pressed (a `tabindex`, an `onclick` or the pointer cursor), says four words or fewer with no question, and they fit the form: Next or Continue anywhere, sign in on any form but a sign-up, sign up on a sign-up only. Never a heading, label, paragraph or link (`<a>` or `role=link`), a toggle, help or recovery, a sign-in with single sign-on or a passkey (no password: the same goes for buttons), an element holding a field, or one more than six levels from the fields of a formless form. A first step's button is looked for near its username (its own wrapper is no show-password toggle).

**Measured:**
- **Submit signals on the corpus** (new in `corpus.spec.ts`; `submit-baseline.json` holds them): every element a person could click on DuckDuckGo's 563 files (34,258) run through the click rule against its `data-manual-submit` labels. Main: 279 of 410 labelled submits found, 367 false (1.07%). 3A-1: **279 found, 363 false (1.06%)**. The first try, which also took links and words anywhere in the element, had 767 false; the rule above is what cut them. ⚠ **The corpus can't see a stylesheet's `cursor: pointer`:** its files are snapshots without their sites' stylesheets, so a plain element shows the pointer there only by an inline style. Live pages, whose stylesheets do give `div`s the pointer, may count more plain elements as submits than 363 of 34,258 suggests, rightly and wrongly; `forms/agent.spec.ts` covers the rule's cases with styles.
- **The corpus** is unchanged at 393 of 458 files.
- **Cost** (Playwright's Chromium, a page of about 4,200 elements, medians of three runs of 15): the scan unchanged (0.8 ms); the click rule 0.24 → 1.45 µs a click (it reads the computed cursor only for an element with no button's role); the agent 35.2 → 37.2 KB minified (14.6 → 15.3 KB gzipped).

**Moved to 3A-2** (review rounds 2 to 4 of #59): a form drawn again after a wrong password (a re-render) read as `still`, a spinner standing in for the form not read as a sign-in, and a late request error taking a sign-in back. [Built in 3A-2](#phase-3a-2-did-a-sign-in-with-no-navigation-work-built-2026-11-19).

**Tried and dropped:** narrowing a formless form to the container holding its password field and a button (§4's refinement) cost the corpus 6 files (393 → 387), so it's left as a follow-up rather than tuned here.

**Tests:** the first step's username and its negatives, the click rule's table, and a typed password in a form read as a first step in `forms/agent.spec.ts`; the saving-mode first step and `submitWords` in `core/test/password-forms.test.ts`; `step`'s schema and its private rule in `unit/passwords-detector.test.ts`; keeping, using, ordering and forgetting it, and the checks again after each wait, in `unit/passwords-assist.test.ts`; and the journey in `e2e/passwords-two-step.spec.ts`: a sign-in in two documents whose password page has no username, saved under the email from step 1.

## Phase 3A-2: did a sign-in with no navigation work? (built 2026-11-19)

*Branch `feat/passwords-3a-2-success-check`, from main after 3A-1 (#59), built on review rounds 2 to 4 of #59. The interface is the owner's choice of 2026-11-18 from the planning thread's mock (`passwords-3a2.html`): 1A, 2A and 3A. A sign-in that navigates is unchanged: it's decided by the new page, and saves at once.*

**The agent's watch after a submit** (rounds 2 to 4 of #59):
- It holds only the password fields that submit's classification used, by WeakRef, with their descriptions (never their values), built outside the watch's closures.
- **A field drawn again** (a framework re-rendering the form after a wrong password) is the form still there. It must be a password field not shown at the submit (a snapshot from a scan made then), never a new password's where the held one wasn't, and one of these:
  - its id and name are the held one's; or
  - its words are (a generated id that changed, a name dropped); or
  - where the held field had nothing to know it by, it's inside the submitted `<form>` (or, on a formless page, any new one).
- **`gone` waits for quiet:** 1.5 s with no change to the document, no request answered (whatever its origin), and no busy marker (`aria-busy="true"`, `role=progressbar`). Only an added input makes it scan again, at most every 500 ms. A spinner, then the form back with *Wrong password*, is `still`; a page that never stops changing is decided at the 10 s deadline.
- **At the deadline,** a busy marker still shown is `still`. After a `gone` there, the page's errors are still reported for 3 s (`DEADLINE_TAIL_MS`).
- **Hints:** only requests started at or after the submit count, and, after `gone`, only those started before it (what the app asks once signed in isn't the sign-in's answer). Errors (400 or more) have a cap of their own (10), so a page answering its polls with 200s can't use up the hints before a 401.

**Main's tracker** keeps a sign-in read from its form going (`lately`) for `LATE_ERROR_MS` (10 s): a 400 or more for its form then turns it into `failed`. Its `signedIn` says until when (`lateUntil`), null after a navigation.
- **A navigation the page makes during the window is judged** as a submit's is (review round 1 of #62): an error response, or the new page showing the sign-in's password field again, is `failed`; a new page without it, or a navigation that never commits, is `lateJudged`. A navigation you start yourself forgets the sign-in, and its card goes.
- **Until it's judged, nothing held commits.** The judging is the tab's (the tracker's, read through `detector.judging` when a held write comes due), so a card or confirmation made after the navigation began is covered too, and an old judgment can't clear a newer navigation. A second navigation before the first was judged goes on being judged for the same sign-in. At `LATE_NAV_CAP_MS` after the window (the new page never settling), a timer ends it as unjudged (`lateUnjudged`, review round 3 of #62): the sign-in's card goes, a pressed one with the toast below, and so does a held confirmation, so a Save pressed after the cap writes nothing. A miss is a missing offer, never a save nobody judged. Until that outcome is out, the tab counts as judging. Turning passwords off there ends it too, and so does a new submit on the tab (the page came back to the form and you tried again): the old sign-in's judgment ends first, as `failed` with `superseded`, quietly, so its outcome can't land on the new one. Cards with no late window of their own (a navigation's sign-in, the browser box's first save) don't wait on the tab's judging. The window is open before `lateUntil` and closed at it, the millisecond the assist's held writes come due. A Save or Update that comes due while it's judged is cancelled with its own toast, *Chord couldn't tell whether that worked, so it didn't save.* (*…didn't update.*), which claims no refusal. A generated password's confirmation never runs then (it stays *Not confirmed*), nor once the vault locks. Losing a save is better than a wrong one.

**The late window, in the cards** (the owner's designs):
- **1A:** Save, Update or *Save as new* pressed before `lateUntil` waits. The card says *Saving…* (*Updating…*) with a spinner (still, for reduced motion), the username read-only, *Never for this site* and *Save as new* disabled, and *Waiting a moment for example.com to confirm the sign-in.* The save runs when the window closes. × closes the card and cancels it.
- **2A:** a late error cancels it. Nothing is written to the vault, and the window's toast says *The site didn't accept that password, so Chord didn't save it.* (*…didn't update it.* for an update). A card for the sign-in goes, pressed or not.
- **3A:** a generated password's entry is confirmed only once the window has closed with no error, the tab still open, passwords still on there, and the site not left. A late error leaves it *Not confirmed* (never lost), and its saved card turns into *example.com didn't take your new password.*, *Chord kept it in Settings → Passwords, Not confirmed, in case the sign-up went through after all.*, with *Delete it* and **Done**. *Delete it* while the window is open deletes it, and nothing is confirmed after.
- **A `failed` on the tab is counted**, and the save card's path checks the count after every wait (the vault's answer, the site's name), so a sign-in taken back while Chord was asking the vault never shows a card.
- **Private windows** never get `signedIn`, so nothing waits or says anything there.

**What Chord can't see.** The agent sees a request only once it has answered and its body has been read (M0 Q7: the PerformanceObserver from the isolated world). A sign-in whose 401 body the page never reads, or whose request goes to another origin, or is a WebSocket message, is never visible. There, a sign-in with no navigation is decided by the form alone: drawn again, still shown, or gone after the quiet wait. A slow refusal the page shows only by words, with nothing busy shown, can still read as a sign-in. The save card's own words and the update card's previous password remain the remedy (phase 1).

**Tests:**
- `forms/agent.spec.ts`:
  - the redraw cases;
  - the spinner, the beacon's 200 and the slow 401, the busy marker at the deadline;
  - three 200s before a 401;
  - a poll started before the submit, and a request started after `gone`;
  - the `<form>` that stays;
  - a page that never stops.
- `unit/passwords-saving.test.ts` and `unit/passwords-detector.test.ts`: the take-back and its negatives, and `lateUntil`.
- `unit/passwords-assist.test.ts`:
  - Save and Update waiting, then saved;
  - a late error after Save, after Update, before anything was pressed, and during the vault's answer;
  - × cancelling;
  - a navigating sign-in, and Save pressed after the window, saving at once;
  - the generated password confirmed at the end, refused, deleted, and **Done**;
  - private windows.
- **Journey** (`e2e/passwords-late.spec.ts`, fixture `formless-optimistic.html`): a wrong password's late 401 after Save is the toast with nothing saved; the right one, *Saving…* with the fields read-only, is saved after the window.

## Phase 3B: open shadow roots (built 2026-11-18)

*Branch `feat/passwords-3b-shadow`, after 3A-1 (#59). No new interface: the menu, fill and cards are phase 1's, for fields that a web component keeps in its open shadow root.*

**Built**, as §4's table planned:
- **The scan walks open roots** (`deepControls`): the document and every open root in it, roots inside roots too, in tree order. It visits a host, then its root, then its light children, so a slotted input (the host's child, drawn through its root) is scanned once, in the page's tree.
  - It's bounded like the scan: 2,000 controls and 250 ms, with at most 1,000 roots.
  - `createTreeWalker`, `shadowRoot` and `tagName` are read through the prototypes (a page can clobber them).
- **A field in a root with no `<form>` of its own belongs to the form its host is in** (`formOfControl`). That's how a design system's text fields sit in a page's form (Bitwarden's test-the-web page uses Material Web's `md-outlined-text-field`).
  - Labels are read in the field's own root.
- **Events through roots.** Focus, typing, Enter and clicks were already read from `composedPath()[0]`. A `submit`, which doesn't cross a root, is listened for in each root that holds a form. The focused element is followed through each root's `activeElement` (a chain of hosts), at the agent's start and at each flush. The watch after a submit also observes the roots its fields are in.
- **The fill** writes into the field in its root, as into any other: the native setter, then `input` (composed) and `change`.
- **Shown, in a root:** a design system's text field fades its empty, unfocused input under the resting label (Material Web's outlined field does, on test-the-web), while the field is plainly on screen. So opacity is waived only when all of these hold (review round 1 of #61):
  - the field is in an open root that holds no other field (a text field component's, not an app shell's around everything);
  - it's empty;
  - it's rendered, not `visibility: hidden`, and 4 px or more each way;
  - its own root's host (or, for a host with `display: contents`, its first composed ancestor with a box) is shown, opacity included, with the field's box inside the host's.

  A field with a value, a component that hides itself, or a field in an app shell's root gets nothing. The rule still lets a page hide its own empty field in its own visible component; the fill writes only the account you picked, to that page's origin.
- **Which button submits stays main's** (the owner's decision on #61's review round 4, and again on #65's: its fallback after round 4). In a `<form>`, a field in a root counts as the form's, so its buttons submit it as on main. For a formless field, `submitButtonFor` and `formlessScope` are main's: they look in the field's own tree only, so a formless field inside a component isn't submitted by a click on a button (Enter and the form going still are), and a component's own `<button>` beside a formless field isn't a submit. Both are a known gap, deferred to [#66](https://github.com/anaremore/chord-browser/issues/66) with #65's review blockers, the form-wrapped case and the formless words through roots. `forms/agent.spec.ts` and `forms/scope-probe.spec.ts` pin main's answer for every case #65's reviews probed, the deferred ones marked.
  - *Back* and *view* read as a toggle's or a link's anywhere (*Click to view password* is an eye), except in a label that starts by saying sign in, so *Sign back in* and *Sign in to view your account* submit (#65).
  - A click inside a root that no known form answers scans the page afresh once, then asks again, unless a scan has just run. `getRootNode` is read through the prototype, since a form with a field named so clobbers it.
- **The sentinel adds no deep look at load** (the planning thread's decision, 2026-11-18): pages pay nothing new.
  - It wakes on focus or typing in a sign-in field inside a root, read through the event's `composedPath()` (its target is only the host).
  - At parse and load it also looks at the focused element through the chain of roots, for a field focused before it looked (autofocus in a component).
  - A page whose only password field is in a root, never focused, keeps the agent asleep, as it should: nothing to fill or save until you use it.
- **A page without roots keeps main's scan.** The agent's first scan walks the page. Where it found no root, and no event since has come from inside one, the scans after it use the document's own `querySelectorAll`, as before 3B. An event from inside a root (a component rendered after the first scan) turns the walk on for good.
- **Closed roots** stay out of reach of any page script, the agent's too. A fixture pins that nothing is taken from one, and nothing beside it is taken for a username.

**Measured** (`test/forms/scan-cost.spec.ts`, Playwright's headless Chromium, medians of 15, three runs):

| Page | Scan before 3B | Scan, first (walk) | Scan, later |
|---|---:|---:|---:|
| ~4,200 elements, no roots, the form in the page's tree | 0.22 ms | 0.36–0.38 ms | 0.22 ms (no walk) |
| ~5,100 elements, the form's fields in roots, 300 other components | 0.14–0.18 ms (fields not seen) | 0.46–0.54 ms | 0.46–0.54 ms |
| ~5,100 elements, 300 components, no sign-in | — (the agent sleeps) | — | — |

The sentinel's look stays one `querySelectorAll` (0.02 ms) plus the active element's chain. Its built preload is 2,367 bytes, held in bytes to 4,096 (perf.spec): since review round 1 the preloads' build drops JSDoc comments, keeping legal and annotation ones, so the budget is for code (3,664 bytes on main, comments included). A deep look for a password field would have cost 0.22–0.26 ms on every page, twice per load, and isn't made.

**Tests:**
- **Fixtures** (`test/forms/fixtures/shadow-*.html`, declarative shadow DOM, since the fixtures' pages run no script):
  - fields in text fields in a page's `<form>`;
  - a whole form in one root;
  - roots three deep with no form, and a search box that must stay none;
  - inputs two roots down in a page's form;
  - slotted light-DOM inputs;
  - a closed root, as a negative.

  The fixtures' check now fails a field with an expectation that the scan never reached.
- **`forms/agent.spec.ts`:**
  - focus on a field in a root, and autofocus in a component before the agent starts;
  - a sign-in in roots, whose one submit is one candidate with its values and whose fill goes in through the roots;
  - a component rendered after a scan that found no root;
  - main's formless submits unchanged: `<button>Submit</button>`, *Go*, an icon-only button and `<input type=submit>` beside a lone password field, or a lone username's step.
- **Test-the-web:** `login/shadow-root-inputs` (Material Web) is scored now. The closed-root page stays listed and skipped.
- **Journey:** `e2e/passwords-shadow.spec.ts`. A form of web components is saved from the card, which offers the email, then filled by the menu through the roots, and the page's own script posts it.

## Phase 3C: same-origin frames (built 2026-11-19)

*Branch `feat/passwords-3c-frames`, after 3B (#61, #65) and 3A-2 (#62), as the planning thread approved it on 2026-11-19. No new interface: the menu, fill and cards are phase 1's, for a sign-in in a frame of the page's own origin.*

**Built**, as M0 §2 found it must be:
- **The preload runs in the top frame only** (Chord's tabs don't set `nodeIntegrationInSubFrames`), so the top frame's agent reaches into each frame it may use, from its own world, and runs an agent there (`passwords/agent/frames.ts`, `startAgents`). Each frame's agent is the top's own (`startAgent` with a `FrameContext`), on the frame's document.
- **Which frames.** `<iframe>` and `<frame>` in the document and its open roots (a TreeWalker, as the scan's walk), 3 levels deep at most, and 20 used at once: a frame keeps its slot while it's used, and one found past 20 is skipped quietly, however the page orders its frames later (review round 1 of #67). One look goes through 100 frame elements at most. A frame is used only while all of these hold:
  - **its watcher saw its current document from its start**, and never saw it with a `sandbox` attribute (`allow-same-origin` included: the flags last until the frame's next navigation, so one whose attribute went is still sandboxed). That's decided from a record kept from the document's start, never from what a later look sees, with no cap and wherever the frame sits now (review rounds 2 and 3 of #67):
    - **the top document's frames:** the sentinel runs at the top document's start. It watches every `sandbox` attribute change with one attribute-only `MutationObserver`, and keeps each frame's document as of its last `load` heard in the document's own tree. A frame's `load` isn't composed, so it's heard only while the frame is in that tree, never in a shadow root, whose attributes nothing watches. Only the browser's own `load` counts (`isTrusted`): a page's `dispatchEvent(new Event('load'))` reaches listeners in every world, and vouches for nothing. The agent asks it per frame (`vouched(el)` on the bridge). A frame is vouched for only with no attribute change ever, no attribute now, and its current document the one whose load was heard. So a frame loaded in a shadow root and moved into the page's tree with `moveBefore`, which keeps its window, is never used;
    - **a frame's own frames:** its agent keeps the same record of its document from when it starts. A frame whose current document's load it didn't hear (already there, or loaded in a shadow root) isn't used; its later navigations are, once heard;
    - **a frame inside an open shadow root:** nothing watches attributes there, so it isn't used;
    - no record (no sentinel): no frame is used;
  - its document is reachable (`contentDocument`: another site's is null), and its window's own `origin` is the top's (a sandbox without `allow-same-origin`, an attribute's or a CSP header's, makes it opaque);
  - that document's address is http(s) (never `about:blank`, `about:srcdoc`, `data:` or `blob:`), and **a real navigation made it as it is now**: its window has a navigation timing entry naming its address (the hash aside) with a response's content type. A `javascript:` URL's document gets an entry under the old address with none; `document.open()` from another document changes the address and keeps the old entry. A document just loaded whose entry isn't there yet is looked at again, 10 times at most;
  - its `documentElement` is still the one it had when first used: another one means it was rewritten (`document.open()`, by the page above or by itself), and its agent is released at once (an observer of the document's own children) and the document refused for good;
  - its origin is the top's exactly, and not opaque;
  - every frame above it holds the same.
- **Checked at every use**, never cached: each event (focus, typing, Enter, a click, a submit), the focus box, and a fill, right before anything is written. A frame that navigated, was given a `sandbox` attribute, went to another site or left the page answers nothing, sends no focus and gets no fill.
- **Released when its frame goes** (removed, navigated, sandboxed, another origin): at the next look, which a frame's `load` and its window's `pagehide` start (50 ms after the last of a batch), its agent's listeners (on its document and every one above), its forms in the report, its fill, its form ids and its slot all go. A blur goes to main for its field if it had focus. A watch it was running ends on its own. A watch already running after a submit there ends as at the top: a frame that navigates after its submit is the form going (`gone`, from the old window's `pagehide`), with 3A-2's late window.
- **Main is unchanged.** Every message comes from the top frame, whose origin main checks, and a frame's agent only ever touches a document of that same origin: a password for an origin only reaches a document of that origin.
- **One bridge** (a hub in `frames.ts`): form ids from one counter; the forms of every agent as one report (main's reappeared-form check reads the page's whole set); a fill routed to the agent whose form it names; a `blur` dropped when another agent has sent `focus` since (focus moved into another frame).
- **The focus box** is the field's, plus each frame's box, border and padding up to the top: the tab's CSS pixels, as main places the menu. A frame's field moves with every document above it, whose scrolls and resizes it hears.
- **The top realm's getters and setters** for every read and the fill on a frame's nodes: a frame's elements are its own realm's, so `instanceof` fails on them, and a frame's script can patch its own prototypes (`HTMLInputElement.prototype.value`). Values are read and written with the top realm's native getter and setter, events dispatched with its `dispatchEvent`, an event's path read with its `composedPath`, boxes and visibility with its `getBoundingClientRect`, `getClientRects` and `checkVisibility`, and nodes told apart by `nodeType` and `tagName` through the prototypes. (In the product the agent runs in world 4440, whose view of a frame's prototypes the page can't touch either: this holds in any world.)
- **A transformed frame:** the focus box is scaled by each frame's drawn width over its layout width, so the menu lands under the field. Under a CSS zoom (`currentCSSZoom` not 1), a rotation or a skew (a computed `transform`, `rotate` or `scale` that isn't one scale and a translation, on the frame or anything above it), there's no focus box, so no menu: none rather than one in the wrong place.
- **The sentinel** keeps the top document's sandbox record (above), and looks into the frames the agent may use (never sandboxed, of the top's origin, in the page's tree) at parse and load, for a password field or the focused element, and listens for focus and typing in their windows (each document once: a frame's window is the same object across its navigations). Its cap counts only those frames, 20, and it looks at 100 at most: 20 other sites' ad frames ahead of a sign-in's don't keep it asleep. A frame that loads later (added, or navigated) is looked at then. It doesn't look into frames inside shadow roots: that's a walk of every element on every page, which 3B ruled out for the sentinel (pages pay nothing new). Once the agent is awake, it finds those frames.
- **Cost:** frames are found once at wake and after frames load (50 ms after the first of a batch), not at each scan; each frame's agent scans its own document on its own schedule.

**How it differs from the plan:**
- **What 3C refuses, failing closed, that a later design could use** (review round 2 of #67):
  - a frame whose page called `history.pushState` (its address is no longer its navigation's);
  - a frame inside an open shadow root;
  - a frame whose document loaded before the frame above it was in use, or loaded inside a shadow root (its watcher never heard it): a nested sign-in that was there before the agent woke, and so a frame in a frame's own initial HTML, until it navigates;
  - a frame under a CSS zoom, a rotation or a skew (no menu).
- **Accepted (the owner, review round 3 of #67): `document.open()` the provenance check can't see.** A frame that rewrites itself before the agent wakes keeps its address, its entry and (to the agent, which never saw the one before) its root; and a page that opens a frame's document, then `history.replaceState`s it back to the entry's address, does too. Both are a same-origin script's doing, which could read the frame's fields anyway, beside `pushState` above.
- **A CSP `sandbox` header that includes `allow-same-origin`** is a known gap: it sandboxes a document with no attribute and leaves its origin the page's, so nothing in the page can tell. It's a weak sandbox a site set on its own content. Main could see it in the response headers: #68 (phase 4 candidate) records subframe navigations in main, with this header and the HTTP status.
- **The frame's HTTP status is a known gap** (#68 too). Main's tracker follows main-frame navigations only, and nothing tells main which frame is a form's. So a frame's sign-in that navigates the frame is judged by the form going and its page's requests, not by the frame navigation's response code: an error status there isn't read. Main stays unchanged; a frame navigation's status would need `did-frame-navigate` matched to the form's frame.
- **One agent per frame** rather than one agent walking every frame: each frame's document gets the top's whole agent (its scan, watch and fill), and the hub joins them.

**Measured** (`test/forms/scan-cost.spec.ts`, Playwright's headless Chromium, medians of 15, two runs; main has no frame code, so its scan is the top document's alone):

| Page | Top scan (main and this branch) | Frames: finding them and scanning each |
|---|---:|---:|
| ~4,200 elements, the form in the main tree, 30 other sites' ad frames | 0.38 ms | 0.26 ms (none used) |
| ~4,200 elements, 5 same-origin frames, the sign-in in one | 0.28–0.30 ms | 0.42 ms (5 used) |
| ~4,200 elements, no frame | 0.38 ms | 0.24 ms |

The sentinel is 4,070 bytes built (main 2,367), held to 4,096 (perf.spec). Its sandbox observer costs about 50 ns an attribute change on a page that changes thousands, and nothing measurable otherwise; its page load, on − off, is within the runners' noise, which main's own runs show (macOS x64 from −4 to 6.3 ms, of 2).

**Tests:**
- **`forms/frames.spec.ts`:** a same-origin frame's focus in the tab's pixels, its form in the one report, the fill (the frame's page sees `input` and `change`), the submit's values; a frame whose page patched its own `HTMLInputElement` value setter, still filled; another site's frame, a sandboxed one with and without `allow-same-origin`, `srcdoc`, `about:blank` and `data:`, none used; 2 and 3 levels used, 4 not; 20 frames used, the 21st not; a frame added later and one that navigates within the site; a formless frame's button; focus moving from the top's field into a frame's; a frame given a `sandbox` between focus and submit (no candidate), one sent to another site between the menu and the fill (nothing written), and one that navigates after its submit (`gone`); 30 ad frames beside the top's form.
- **Test-the-web:** `login/iframe-login`, `login/nested-iframe-login` (two forms three frames deep) and `multi-step/iframe-formless-login` are scored now; `login/iframe-sandboxed-login` is a negative whose field must stay unscanned. Selectors step into a frame with ` >>| `.
- **Journey:** `e2e/passwords-frames.spec.ts`. A page holding only a frame of its origin: the sentinel wakes on the frame's field, the sign-in typed there is saved from the card, and after a reload the menu under the frame's field fills both, which the frame's own script posts.

## Phase 3D: providers' recipes and codes after the password (built 2026-11-19)

*Branch `feat/passwords-3d-recipes`. The plan was approved by the planning thread on 2026-11-19. The card line for a trimmed code is the owner's choice of 2026-11-19, option 1A of `passwords-3d-code.html` (§1A and §2).*

**Recipes** (`core/password-recipes.ts`, applied in the agent by `agent/recipes.ts`) cover Google, Microsoft (work or school, and personal), Okta (the Identity Engine's widget and the classic one) and Auth0's Universal Login. A recipe applies to the agent's own document's host only: a host the recipe names, or under one of its `*.` patterns, never the bare domain. It only adds:
- **Fields.** The field its `username` selector matches is the username. The field its `password` selector matches is the current password, but only on a `type=password` field. With the password shown, the form is a sign-in; without it, a first step. Any other field that held those roles loses them. A sign-up, change or reset form is never touched.
- **Submits.** The element its `submits` selector matches, or one inside it, submits the form holding the recipe's fields when the click rule takes nothing. It goes through the click rule's own refusals (`safeSubmit` in `scan.ts`): never a toggle's, help's or another way in's words, never a pressed button, one holding or controlling the field, or the password's own wrapper's eye.
- **Never frames.** A frame is used or not before any recipe runs. A sandboxed frame at a provider's host, or another site's frame of it, is never used.
- **A redesign.** A selector that matches nothing changes nothing, so the generic detector reads the page.

**The read-only sweep** of the providers' public sign-in pages (`scripts/dev/signin-sweep/providers.mjs`, by hand, never in CI) loads each identifier step, reads its fields and focuses them. It never types, presses Next or submits; no account is used. Results stay outside the repo. Only the selectors a recipe needs came from it, and each recipe's `verified` date is when they last matched. On 2026-11-19:
- **Google:** the email is found, but Next is a button after the `<form>`, in its own wrapper, so the click rule never took it. The recipe adds it.
- **Microsoft (both hosts), Okta (both widgets) and Auth0:** the generic detector already reads their identifier steps and Next. Their recipes hold the fields and buttons in place if a redesign moves them.
- **Password steps** can't be reached without submitting an identifier, so their selectors are the providers' documented field names (`Passwd`, `passwd`, `credentials.passcode`, `password`). The rows check them on Chord's own markup.
- **Known false submits on first steps, low harm:** Microsoft's *Sign-in options*, live.com's *Create an account* and Okta's *Okta FastPass* read as submits. A first step's submit only carries its username to the next step's card, so nothing is saved by them. Left as they are.

**A one-time code typed after the password** (Apple's `websites-that-append-2fa-to-password.json`, vendored at the same commit as the other two files):
- **Matching.** `appendsCodeToPassword` in `password-quirks.ts` matches the origin's host or a parent, down to its registrable domain: `www.example.com` for `example.com`, never `example.com` for `auth.example.com`. Main loads the list the first time a sign-in is submitted and tells chord-data's `compare` (`appendsCode`).
- **On a listed site,** the saved password followed by 6 to 8 digits is the same password: no Update card for a code (`withAppendedCode`). 5 or 9 digits are another password. On any other site, 6 digits after the saved password are a new password, as before.
- **Trimming** (the owner's design 1A). On a listed site, a new sign-in's save card (or a locked one's, which the vault decides at Save) whose password ends in 6 to 8 digits saves it without the last 6 (`trimAppendedCode`). A sign-up's, an update's, a generated password's and the sign-in box's never do. Main holds both passwords and which one the card will save.
  - The card's muted line says *This site takes a sign-in code after the password, so Chord left off the last 6 digits.*, and its inline *Keep them* switches to *Chord will save the password as you typed it.*, with *Leave off the code*.
  - Nothing is saved until Save, and the eye shows exactly the password Save will save; a revealed password follows the switch. While Save waits on the late window, the switch is disabled.
  - Main loads Apple's list only for a password that ends in 6 to 8 digits.

**Tests:**
- core: the hosts table, the patterns and the recipes' shape; the list's hosts; codes after a password, and trimming;
- chord-data: `compare` with and without `appendsCode`;
- main (`passwords-assist.test.ts`): which cards get the line (new and locked on a listed site, 6 and 8 digits; never 5 or 9 digits, an unlisted site, an update or a sign-up), what the eye shows and Save saves, *Keep them* and *Leave off the code*;
- journey (`e2e/passwords-code.spec.ts`, at a listed host on this machine): the first save, trimmed, then filled without the code; the same password with the next code, no card; another account's password that really ends in 6 digits, the eye before and after *Keep them*, then filled as typed;
- the forms project (`test/forms/recipes.spec.ts`): each provider's step on Chord's own markup, served at the provider's host, and the same markup on other hosts;
- refusals: a recipe's submit that reads as *Show password*, is pressed, or is the password's own eye; a sign-up left alone; frames.
