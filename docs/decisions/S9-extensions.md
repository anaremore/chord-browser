# S9: Chrome extensions

**Result: partial.** Electron 45 alone runs only 2 of the 6 test extensions' service workers. The iamEvanYT fork of electron-chrome-extensions runs all 6, and uBO Lite blocks ads on its own. Password managers load up to their sign-in screens. Sign-in, unlock and autofill weren't exercised (no accounts in automation).

**Recommendation:** build M1.5 on the fork, vendored behind `ExtensionHost`. Write Chord's own Web Store installer, and ship binaries as a GPL-3 combined work (D1 option a). Details in [Recommendation](#recommendation).

## Results per extension

All six are the current Chrome Web Store builds, downloaded and verified by the spike. "Library" is electron-chrome-extensions 4.9.0 from npm; "fork" is `@iamevan/electron-chrome-extensions` 4.9.5.

| Extension | Electron 45 alone | Library 4.9.0 | Fork 4.9.5 |
|---|---|---|---|
| **uBO Lite** 2026.1021.1354 | **fail.** Worker dies on `chrome.commands`. Blocking works only after the rulesets are enabled by hand. | **fail.** Worker dies on `browser.commands`. | **pass.** Worker runs, enables its own 6 default rulesets, and blocks and redirects on first load. |
| **Dark Reader** 4.9.133 | **partial.** Pages are themed; the popup barely renders (20 chars of text). | **pass.** Pages themed; popup renders fully (1,198 chars). | **partial.** Pages themed; the popup barely renders again, because the worker loses `storage.sync`. |
| **Bitwarden** 2026.10.0 | **fail.** Worker dies on `webNavigation`; popup is blank. | **partial.** Worker runs; popup shows sign-in (480×600). | **partial.** Same as the library. |
| **1Password** 8.12.42.36 | **fail.** Worker dies on `contextMenus`. | **fail.** Worker dies on `browser.windows`. | **partial.** Worker runs, registers its context menu, and tries to reach the desktop app. It reopens its welcome tab on every launch. |
| **Proton Pass** 1.42.0 | **partial.** Worker runs, the inline dropdown iframe is injected, and the popup page loads (600×430). | **partial.** The library's own popup window is clipped to 32×56 (upstream #177). | **partial.** Popup window 616×469. |
| **Google Translate** 2.0.18 | **fail.** Worker dies on `contextMenus`. | **partial.** Worker and popup work; no "Translate" menu item, because it is created in `onInstalled`. | **partial.** Same as the library. |

## Results per capability

| Capability | Electron 45 alone | With the fork (+ the Chord work in the plan) |
|---|---|---|
| Load unpacked MV3, run classic and module service workers | pass ✅ | pass ✅ |
| Content scripts run in pages | pass ✅ (5 of 6; uBO Lite registers its own at runtime) | pass ✅ (6 of 6) |
| `declarativeNetRequest` block + redirect | engine pass ✅; manifest-enabled rulesets are **not** turned on at load ✅ | pass ✅ (uBO Lite enables its own) |
| Action popup page loads in a view | pass ✅; but `tabs.query({active, currentWindow})` returns `[]`, and badge/icon calls are no-ops | pass ✅ |
| `chrome.tabs` / `chrome.windows` | partial / missing ✅ | pass, through Chord callbacks ✅ |
| `chrome.contextMenus` | missing ✅ | pass ✅ (the probe's and 1Password's items reach Chord's menu). Items created in `onInstalled`, like Google Translate's, need Chord to dispatch it ⚠ |
| `runtime.onInstalled` | never fires ✅ | Chord must call `dispatchRuntimeInstalled` ✅ |
| `chrome.commands` | missing ✅ | `getAll` only; Chord wires the keys |
| `storage.sync` | throws ✅ | aliased to `local` (fork: not in workers ✅) |
| Native messaging (desktop apps) | not in Electron's supported list. `runtime.connectNative` exists when the permission is granted (1Password ✅), but whether it works is ⚠ untested | the library launches hosts registered for Chrome ✅ (source); framing bugs ⚠ |
| Extension iframe inside a web page reaches its worker via `navigator.serviceWorker` | fail ✅ (upstream #185); `chrome.runtime` messaging works | same ✅ |
| `sidePanel`, `userScripts`, `fontSettings`, `downloads`, `privacy` | missing ✅ | missing ✅ |
| Isolation from other profiles and from `chord-ui` | pass ✅ | pass ✅ |

## Evidence (2026-10-22, Windows 11 x64, Electron 45.0.0, Chromium 156.0.8078.48)

Run with `spikes/s9-extensions/` (usage is at the top of `run.mjs`):

- `fetch.mjs` downloads each CRX from the Web Store update endpoint, verifies it, and unpacks it.
- `main.mjs` loads all six into a `persist:` session. The views are WebContentsViews in a hidden BaseWindow, as in Chord.
- `main.mjs` also loads two generated probe extensions: the same tiny MV3 extension with a classic and with a module worker. They report what the worker sees.
- Runs: Electron only, library, library relaunch, fork, fork relaunch. Each run takes about a minute.
- Nothing is ever shown on screen: `show`/`focus` are patched to no-ops, dialogs are disabled, and errors exit with JSON.
- A local server stands in for ad hosts (`--host-resolver-rules`), so a request that reaches it was not blocked.

**Blocking (uBO Lite):**

| Request | Electron alone, fresh | After enabling uBO Lite's 6 default rulesets + 1 dynamic rule | Fork, fresh |
|---|---|---|---|
| `ib.adnxs.com` | loaded | blocked (`ERR_BLOCKED_BY_CLIENT`) | blocked |
| `securepubads.g.doubleclick.net/tag/js/gpt.js` | loaded | redirected to uBO Lite's `noop.txt`; never reached the server | redirected |
| `pagead2.googlesyndication.com/…/adsbygoogle.js` | loaded | redirected to `noop.js` | redirected |
| `tracker.s9.test` (the dynamic rule) | loaded | blocked | loaded until the rule was added, then blocked |
| `cdn.s9.test` (control) | loaded | loaded | loaded |

- Enabled rulesets and dynamic rules **survive a relaunch** ✅.
- The same rule did not touch a request from the in-memory UI session ✅.

**Why workers die.** All of these come from the worker's console, read through `session.serviceWorkers`:

- **Electron alone:** `chrome.commands`, `chrome.webNavigation` and `chrome.contextMenus` don't exist. Electron logs `Permission 'contextMenus' is unknown` (also `webNavigation`, `notifications`, `sidePanel`, `privacy`, `downloads`, `fontSettings`).
- **Library 4.9.0:** it patches only `chrome`. Chromium 148+ also exposes a native `browser` namespace ([Chrome docs](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace)).
  - The probe sees `browser !== chrome`, and `browser.windows` is undefined while `chrome.windows` exists ✅.
  - uBO Lite (`self.browser || self.chrome`) and 1Password (`self.browser || …`) take `browser`. The fork mirrors its APIs onto `browser` too ✅.
- **`onInstalled` never fires:** not in Electron, not with either library, in any probe run ✅.
  - Electron's loader only calls `ExtensionRegistrar::AddExtension` and skips Chrome's install step ([electron_extension_loader.cc @ v45.0.0](https://github.com/electron/electron/blob/v45.0.0/shell/browser/extensions/electron_extension_loader.cc)).
  - The same skipped step is the likely reason manifest-enabled DNR rulesets stay off ⚠ inference. 1Password's `ruleset_1` was also off.
  - The fork leaves this to the app: it exposes `dispatchRuntimeInstalled(id, details)` ✅.

**Popups.** Measured in a WebContentsView with `enablePreferredSizeMode` (Chrome clamps popups to 25×25–800×600, [extension_popup_types.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/extensions/extension_popup_types.h)):

| Popup | Preferred size |
|---|---|
| uBO Lite | 273×223 |
| Dark Reader | 276×516 |
| Bitwarden | 480×600 |
| 1Password | 600×450 |
| Proton Pass | 600×430 |
| Google Translate | 420×142 |

**Other checks:**
- `session.fetch` and `net.request` still return 200 after loading the webRequest and DNR extensions into a `persist:` partition ✅. Electron #54685 did not reproduce in this setup, which is Chord's favicon path. #55106 ties it to `defaultSession` ⚠.
- The library registers two preloads on the profile session: `frame` and `service-worker` ✅. So every web page in that profile gets a preload. It returns early unless the URL is `chrome-extension://` ✅ (source).

## Libraries

| | electron-chrome-extensions | electron-chrome-web-store | iamEvanYT fork |
|---|---|---|---|
| Version | 4.9.0 | 0.13.0 | `@iamevan/electron-chrome-extensions` 4.9.5, `@iamevan/electron-chrome-web-store` 0.13.5 |
| Last release | 2025-07-02 ✅ | 2025-07-02 ✅ | 2026-05-26 / 2026-07-01 ✅ |
| Activity | One maintainer (Samuel Maddock) ✅. Last commit 2026-09-01; no npm release in 15 months; 31 open issues ✅. | same repo | One maintainer; `patched` branch, last push 2026-07-01 ✅ |
| Electron 45 | Not declared. Upstream's own shell targets `^44.1.0` ✅. Works on 45 with the gaps above ✅. | — | Works on 45 ✅ |
| License | GPL-3.0 **or** the Patron License ✅ | MIT ✅ | Same dual-license files ✅ |

**What the fork fixes, from its commit log** ✅:
- Mirrors the APIs onto `browser`.
- Adds `storage.session`.
- Exposes `dispatchRuntimeInstalled`.
- Popup sizing.
- `tabs.getCurrent`.
- Web Store: an exact-origin check in the preload, and an ID pattern check before uninstall.

**Still broken in both:**
- The Web Store installer **verifies no CRX signature** ✅ (no verify call anywhere).
- Its main-process IPC check is still `origin.startsWith('https://chromewebstore.google.com')` ✅.
- `storage.managed` is aliased to `local`, which makes uBO's storage balloon (upstream #158) ⚠.
- Native messaging assumes one message per stdout chunk and sizes buffers by string length, not bytes. Both are wrong for large or non-ASCII messages ⚠ (from reading the source).

**Upstream regressions to watch:**
- #172: MV3 workers broke in Electron 40 and came back in 41 ⚠ (as reported).
- #184: "breaks quite a lot in Electron 42+".
- #185: nested extension iframes (reproduced here ✅).

**Size of an own implementation:** the library is about 163 KB of TypeScript, roughly 4,500 lines. A clean-room equivalent for the acceptance suite is about 4–6 engineer-weeks ⚠ estimate. That doesn't fit M1.5's week.

## License (decision D1)

**How the library enforces its license:**
- The constructor requires `license: 'GPL-3.0' | 'Patron-License-2020-11-19'` ✅.
- That value is a self-declared string, not a purchased key ✅.
- It also refuses two hashed project names. Chord's package names aren't among them ✅.

**The Patron License** ([LICENSE-PATRON.md](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/LICENSE-PATRON.md)):
- It lasts only while you sponsor at a qualifying tier.
- It names only Samuel Maddock as a participating contributor. So it would not cover the fork's changes by other authors ⚠ not legal advice.

**What option (a), GPL-3 combined binaries, requires.** Not legal advice; ✅ marks clauses read from the license texts.

> **Update 2026-10-22:** Chord's source moved from MPL-2.0 to MIT; the decision below (a) holds unchanged. MIT is GPL-compatible, and the one MPL-2.0 file (`core/rank.ts`) is covered by §3.3 as before.

1. **MPL-2.0 allows the combination.**
   - §3.3 lets a Larger Work combine MPL code with code under a "Secondary License".
   - §1.12 defines that as GPL 2.0 "or any later versions", which includes GPL-3.0 ✅.
   - Condition: no Chord file may carry Exhibit B ("Incompatible With Secondary Licenses"). None does ✅.
2. **The combined binary is distributed under GPL-3.0.**
   - Ship the GPL-3 text alongside MPL-2.0.
   - Offer the Corresponding Source, including build scripts (GPL-3 §6). The public repo at the release tag, with the vendored library inside it, does this.
3. **Chord's own source stays MPL-2.0.** Under §3.3, recipients of the binary may also take Chord files under GPL-3.
4. **Everything else in the binary must be GPL-3-compatible.**
   - The runtime dependencies checked are MIT, ISC or CC0 ✅. Electron is MIT ✅.
   - Chromium's bundled third-party code and the Onest font (OFL) need a license audit before 0.1 ⚠.
5. **Downstream redistributors** of Chord binaries inherit GPL-3. A fork that wants MPL-only binaries replaces the `ExtensionHost` implementation.
6. **README and About** say so in one line.

Option (b), the Patron License, costs a recurring sponsorship and doesn't cover the fork's fixes. Option (c), clean-room, is the multi-week project above.

## Recommendation

1. **Library, not own implementation, for Phase 1.** Vendor the fork's `packages/electron-chrome-extensions` into `packages/chrome-extensions`. The spike tested npm 4.9.5; the `patched` branch head is `25cf4d7`, so diff the two before pinning.
   - Keep its license files; it is GPL-3.0.
   - Chord code talks to it only through the MPL-2.0 `ExtensionHost` interface, one instance per profile session.
   - Send generic fixes upstream to both repos.
2. **D1 = (a).** GPL-3 combined binaries, as ARCHITECTURE.md §16 already recommends. The spike found no reason to change that, and (b) no longer even covers the code we need.
3. **Chord's own Web Store installer and updater (MPL-2.0).** Don't use electron-chrome-web-store.
   - It skips signature checks.
   - It needs a privileged preload in every frame.
   - `fetch.mjs` already does the verified download in about 150 lines with `node:crypto`.
4. **Chord owns the install step that Electron skips:**
   - Record installed versions per profile.
   - Dispatch `onInstalled` (`install` / `update`) once.
   - Enable manifest-enabled DNR rulesets on install. The spike did this from an extension page ✅; doing it from a worker preload is untested ⚠.
5. **Revisit clean-room after 1.0.** By then the acceptance suite defines exactly what our own layer needs.

## UI integration

- **Action buttons:**
  - Rendered by the shell from state that main reads through the library (icon, badge, title, enabled). No `<browser-action-list>` element and no `crx://` protocol on `chord-ui`.
  - Places: the sidebar URL pill, the minimal bar, and the Windows/Linux strip (DESIGN.md).
- **Popups** fit §5's model as a **popover-style view**:
  - A WebContentsView on the profile session, above the tab views, with bounds exactly the popup's rect.
  - Size comes from `preferred-size-changed`, clamped to 25×25–800×600 and to the window.
  - Because the view covers only its own rect, the shell keeps receiving clicks. A mousedown outside, Esc (`before-input-event`), tab or chord switches, and window blur close it.
  - This also works on Wayland, where the library's child-window popups can't be positioned.
  - Small windows clip the popup to the window, unlike Chrome ⚠ acceptable.
- **`chrome.tabs`** maps onto live `TabNode`s: tab ID = `webContents.id`.
  - `addTab` / `selectTab` / `removeTab` follow TabManager.
  - `createTab` becomes `tab.open` in the active chord's Today section.
  - Tabs of other chords stay visible to extensions, as all tabs of a Chrome window are.
  - Slept tabs have no WebContents, so Chrome's `discarded: true` is the closest match. That means a stable tab ID that isn't `webContents.id` ⚠ (decide in M1.5).
- **`chrome.windows`** maps onto Chord windows (`BaseWindow`). `create({type: 'popup'})` (password-manager "pop out") opens a child popup window like OAuth popups (§9).
- **Context menus:** append `getContextMenuItems(contents, params)` to Chord's native `Menu.popup()` in `context-menu.ts`.
- **Options pages:** open as a normal tab (`runtime.openOptionsPage`, `options_ui`).
- **Permission prompt at install:**
  - The popover lists Chrome's warning strings. Electron supports `chrome.management.getPermissionWarningsByManifest` ✅ (docs); whether main can reach it is ⚠ untested.
  - Optional-permission requests (`permissions.request`) use the same prompt through the library's `requestPermissions` hook.
- **Keyboard:**
  - Extension `commands` register in Chord's shortcut registry as page-first keys, unassigned unless `suggested_key` is set.
  - `_execute_action` opens the popup.

## Installing from the Chrome Web Store

- **Download:** `https://clients2.google.com/service/update2/crx?prodversion=156.0.8078.48&acceptformat=crx3&x=id%3D<id>%26v%3D<ver>%26uc`. It returns gupdate XML with `version`, `codebase` and `hash_sha256` ✅.
- **Verify:** the SHA-256 must match the update response (6/6 ✅). Then verify CRX3 the way [crx_verifier.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/crx_verifier.cc) does:
  - Every proof must verify over `"CRX3 SignedData\0" + len + signed_header + zip`.
  - One key must hash to the requested ID (the developer proof).
  - One must be the store's publisher key (SHA-256 `61f7f2a6…6367cf`).
  - Results: 6/6 verified; one flipped archive byte fails every proof; a wrong expected ID is rejected ✅.
- **Unpack** with a traversal-safe zip reader ✅. Write the developer key into `manifest.json` as `key`, so the ID stays the store ID. Native-messaging `allowed_origins` depend on that.
- **Updates:** check on launch and on a timer. Chrome's default interval is about 5 hours ⚠.
  - On a new version, download, verify, unpack beside the old version, reload, and dispatch `onInstalled {reason: 'update'}`.
  - Enabled rulesets and storage persist across reloads ✅ (relaunch run).
- **Entry point:** an "Add to Chord" button when the active tab is `chromewebstore.google.com/detail/…/<id>`, plus Settings › Extensions. No preload on the store page; the store's own "Add to Chrome" button stays inert ⚠ (it shows "Switch to Chrome" CTAs, upstream #174).
- **Terms:** the store's Developer Agreement governs publishers. We found no user-facing term about non-Chrome browsers installing from the store ⚠. Brave, Vivaldi, Opera and Edge all do, which is de-facto precedent ⚠.

## Security posture

- **Chord's UI is out of reach** (all modes ✅):
  - `chord-ui` is an in-memory session, and Electron refuses to load extensions there ("Extensions cannot be loaded in a temporary session").
  - A UI stand-in served over `http://` (as dev builds do) got 0 content-script worlds.
  - `scripting.executeScript` against it fails with "No tab with id".
  - `tabs.get` / `tabs.update` fail ("No such tab") with Electron alone. The library returns a stub `{id: -1}` and "ok", but the view is untouched.
  - An extension's DNR rule doesn't apply to UI-session requests.
  - The UI-only scheme can't be fetched from a profile-session page.
- **Profiles are isolated:** a second `persist:` session had 0 extensions and 0 content-script worlds, and its page stayed unthemed ✅.
- **Extension pages count as tabs:** with Electron alone, every WebContents on the profile session (popups, options pages) appears in `tabs.query({})` ✅. The library limits this to the tabs Chord registers.
- **New surface:**
  - The library's frame preload runs in every web page of a profile that has extensions. That relaxes §4's "web content: no preload". Measure its cost ⚠.
  - Native-messaging hosts are executables launched from Chrome's registrations. Keep the `allowed_origins` check (the library has it ✅).
  - Extension webContents need the same `setWindowOpenHandler` and navigation hardening as tabs, via `web-contents-created`.

## Plan for M1.5 (Nov 30 → Dec 7), in order

Steps 1–4 are about 6 working days for extensions alone, and M1.5 also holds auto-PiP, default browser, private windows and settings. Step 1 can start before M1.5, since it has no UI. If the week is short, step 5 moves to early Phase 2.

1. **Host and installer (first, 2 days):**
   - Vendor the fork and add `ExtensionHost` per profile.
   - Chord's verified installer and updater; load on boot per profile.
   - Install bookkeeping in chord-data: `onInstalled` dispatch and DNR rulesets on install.
   - The fork alone already runs all six workers (Electron alone: 2). The bookkeeping fixes context menus, welcome tabs, and rulesets for extensions without uBO Lite's self-repair.
2. **Toolbar and popups (2 days):**
   - Action buttons from state; popup popover view; tabs/windows mapping onto TabManager and windows.
   - Options pages as tabs.
3. **Menus and prompts (1 day):**
   - Context-menu merge; install permission prompt; Settings › Extensions (list, remove, update now).
4. **Acceptance suite (1 day):**
   - Turn this spike into an E2E run on every OS: cached CRXs, probe extensions, DNR, popups, isolation.
   - A by-hand checklist for sign-in and autofill.
5. **Last, if the week allows** (otherwise early Phase 2):
   - Fix native-messaging framing and add Chord's own host locations.
   - Extension keyboard commands.
   - `storage.managed` returns empty, and `storage.sync` works in workers.
   - The #185 iframe bridge, only if a password manager needs it in the by-hand tests.

Deferred: `sidePanel` (Bitwarden), `userScripts` (uBO Lite advanced mode), extensions in private windows (Electron can't load extensions into in-memory sessions ✅), and a clean-room layer.

## Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| The fork or upstream breaks on an Electron major (it happened in 40 and 42+) | High / high | Vendored code; the extension E2E suite becomes a gate in the §14.3 patch process. |
| Password-manager autofill fails in ways automation can't see (inline-menu iframes, #185) | Medium / severe (R2) | By-hand checks with real accounts on all three OSes in M1.5; the #185 bridge is ready to build. |
| 1Password's desktop link refuses an unknown or unsigned browser | High / low | Use account-password unlock. Its custom "trusted browsers" needs a valid code signature on macOS and is ⚠ unannounced on Windows. Depends on D3. |
| GPL-3 binaries deter some contributors or downstream users | Low / medium | The seam keeps (b) and (c) open; Chord's source stays MPL-2.0. |
| Google restricts non-Chrome downloads from the update endpoint | Low / high | Fall back to unpacked or `.crx` file install. Watch the store's terms. |
| Storage bloat (`storage.managed` alias, #158) and the cost of six workers per profile | Medium / medium | Fix the alias; measure memory with the suite loaded. |

## Still to check

- **By hand, Windows first:**
  - Sign in to Bitwarden, 1Password and Proton Pass.
  - Autofill from the popup and from the inline menu.
  - The context-menu autofill entries.
- **Popups on screen:** size, focus, dismissal, HiDPI icons. This spike never showed a window.
- **Desktop-app links** with Bitwarden Desktop and 1Password 8 installed. Neither is installed on the test machine.
- **uBO Lite on real ad-heavy pages:** cosmetic filtering, and settings that persist.
- **macOS and Linux (X11, Wayland):** run `node spikes/s9-extensions/run.mjs`. CI can run it headless if the CRXs are cached.
- **Electron #54685** on macOS, where it was reported, using `persist:` partitions.
- **The CWS "Add to Chord" flow end to end, and a real version update.**

## What M1.5 found while building it

- **Popup sizing.** `enablePreferredSizeMode` on a WebContentsView reports a size only for pages in the view's first renderer process. A minimal repro on Electron 45: a fixed-size page reports 300×200 when loaded first, and nothing after a cross-process navigation. An extension popup always moves into its extension's process, so `preferred-size-changed` never fires for it. (This spike measured sizes because its views happened to start there.)
  - Chord measures the page itself instead. A script in Chord's own isolated world (4321) watches the root element with a ResizeObserver, reads its max-content size, and reports it with a tagged `console.debug`. Main reads it from `console-message` and clamps it to 25×25 to 800×600 (`main/extensions/sizer.ts`).
  - A page could log the tag itself. All it could do is resize its own popup within that clamp, which is harmless.
- **The install step needs retries.** A service worker that's still starting can't be sent to, so the library's send fails. Chord retries with backoff for up to 15 s. With that, rulesets reach uBO Lite and 1Password, and `onInstalled` reaches every test extension that listens for it. uBO Lite doesn't listen for it.
- **`queueAndSendEvent()` in the library** ended its wait when *any* extension listened for the event, then sent it only to the target. That could drop `runtime.onInstalled`. Fixed in the vendored copy; a candidate for upstream.

## Corrections for ARCHITECTURE.md §12 (applied in M1.5)

- `declarativeNetRequest` **is** present and enforcing in Electron 45. The gap is that manifest-enabled rulesets aren't turned on at load. D5 can now consider uBO Lite.
- Issue references:
  - #172 is the Electron 40 worker regression.
  - #185 is the nested-iframe service-worker gap.
  - #177 is Proton Pass popup sizing.
- The fork's Web Store fixes:
  - The uninstall path check is fixed.
  - The lookalike-host check is fixed in the preload only.
  - Neither package verifies CRX signatures.
- `checkLicense()` needs a declared license string, not a purchased key.
- "The library doesn't support in-memory sessions": it is Electron that refuses.

## Sources

- Electron 45 extension docs: [extensions.md @ v45.0.0](https://github.com/electron/electron/blob/v45.0.0/docs/api/extensions.md); `Extensions` class in `electron.d.ts` (45.0.0)
- [electron_extension_loader.cc @ v45.0.0](https://github.com/electron/electron/blob/v45.0.0/shell/browser/extensions/electron_extension_loader.cc)
- [Chrome `browser` namespace](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace)
- [crx_verifier.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/crx_verifier.cc), [extension_popup_types.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/extensions/extension_popup_types.h)
- [electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell): LICENSE.md, LICENSE-PATRON.md, `src/browser/license.ts`; issues [#158](https://github.com/samuelmaddock/electron-browser-shell/issues/158), [#172](https://github.com/samuelmaddock/electron-browser-shell/issues/172), [#174](https://github.com/samuelmaddock/electron-browser-shell/issues/174), [#177](https://github.com/samuelmaddock/electron-browser-shell/issues/177), [#184](https://github.com/samuelmaddock/electron-browser-shell/issues/184), [#185](https://github.com/samuelmaddock/electron-browser-shell/issues/185)
- [iamEvanYT/electron-browser-shell `patched`](https://github.com/iamEvanYT/electron-browser-shell/tree/patched); npm [`@iamevan/electron-chrome-extensions`](https://www.npmjs.com/package/@iamevan/electron-chrome-extensions), [`@iamevan/electron-chrome-web-store`](https://www.npmjs.com/package/@iamevan/electron-chrome-web-store)
- Electron [#54685](https://github.com/electron/electron/issues/54685), [#55106](https://github.com/electron/electron/issues/55106)
- [Chrome Web Store Developer Agreement](https://developer.chrome.com/docs/webstore/terms)
- 1Password community on unsupported browsers ([Opera thread](https://www.1password.community/1password-at-home-31/opera-extensions-and-desktop-apps-cannot-be-used-together-18355)); Bitwarden community on [Chromium derivatives](https://community.bitwarden.com/t/extension-biometrics-unlock-in-chromium-and-derivatives-thorium-iridium-iron-etc/52702) ⚠ forum posts
