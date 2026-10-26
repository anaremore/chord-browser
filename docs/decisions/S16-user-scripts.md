# S16: User scripts (Tampermonkey)

*2026-10-25 · ROADMAP.md, Later · for review: nothing is built, and nothing here is decided until the maintainer says so.*

**In short.** In Manifest V3, Tampermonkey runs your scripts through Chrome's `chrome.userScripts`. In Chord that API is undefined, so Tampermonkey says "Please enable the `Allow User Scripts` extension setting" and your scripts don't run.

- **Electron already compiles Chromium's own userScripts implementation and leaves it switched off.** It registers the functions and creates Chromium's user script manager. It never supplies the availability check that `userScripts` requires, so the API isn't bound, and it has no way to set an extension's *Allow* switch. That's two small gaps in Electron, not a missing feature. *(Corrected 2026-10-25: a store for registered scripts arrived on 2026-10-23, in electron/electron#55155, #55283 on 45-x-y. Asked upstream in [electron/electron#55337](https://github.com/electron/electron/issues/55337), offering the PR.)*
- **Tampermonkey 5.5.1 uses only part of the API:** `register`, `unregister`, `getScripts`, `configureWorld({csp, messaging: true})`, and `runtime.onUserScriptMessage` and `onUserScriptConnect`. Everything it registers runs at `document_start`, in every frame, in the `USER_SCRIPT` world. It never calls `execute`. Violentmonkey does call `execute`, and ScriptCat uses `MAIN`-world scripts.
- **Chord could build the API itself,** with a preload per registered script, Electron's new preload URL filters (in the next 45.x), and isolated worlds that have their own CSP. It works, but it costs main a file read per matching frame on every navigation. It also needs preloads in iframes, which Chord's tabs don't run today.
- **Performance:** both ways cost nothing while no extension has user scripts allowed. With scripts, Chromium's own way keeps one copy of the scripts per renderer process and matches them in the renderer, with no file reads or copies on main per navigation. Chord's own way can't share a copy between documents, so it delivers the code with every frame.
- **Security:** a switch per extension, *Allow user scripts*, off by default and turned on by you in Settings → Extensions, as Chrome 138 does. Never in Chord's pages, the Web Store, the PDF viewer, reader view or private windows.
- **I recommend (d):** turn Chromium's implementation on in Electron, upstream. It's about 1.5–2 weeks for the Electron patch ⚠ plus Electron's review, then 3–4 days in Chord ⚠. If Electron says no, or it isn't merged by mid-December, build (b) in Chord instead, which is Tampermonkey's subset in about 3 weeks ⚠.

---

## 1. What Tampermonkey needs

### The API, as Chrome has it

| | Since | Tampermonkey 5.5.1 | Violentmonkey 2.49 | ScriptCat 1.5 |
|---|---|---|---|---|
| `register`, `getScripts`, `unregister` | Chrome 120 | ✓ | ✓ | ✓ |
| `update` | 120 | wraps it, never calls it (no call site found) | ✓ | ✓ |
| `configureWorld({csp, messaging})` | 120 | ✓, default world only | ✓ | ✓ |
| `worldId`, `getWorldConfigurations`, `resetWorldConfiguration` | 133 | — | — | `resetWorldConfiguration` only |
| `execute` | 135 | — | ✓ (`injectImmediately`, `frameIds`) | — |
| `world: 'MAIN'` | 120 | — | — | ✓ (its default for scripts) |
| `runtime.onUserScriptMessage` / `onUserScriptConnect` | MV3 | both | message only | both |
| `js: [{file}]` / `[{code}]` | 120 | both | both | code |

- **The `USER_SCRIPT` world** is an isolated world per extension (or per `worldId`), exempt from the page's CSP. Neither the page nor other extensions can see it. Its own CSP is whatever `configureWorld` sets. The default is the extension's isolated-world CSP: `script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' chrome-extension://<id>/; object-src 'self';`. Its security origin is the extension's.
- **Messaging is off by default.** With `messaging: true`, the world gets `runtime.sendMessage`, `connect`, `onMessage`, `onConnect` and `lastError`, and nothing else from `chrome`. Its messages reach the extension on `runtime.onUserScriptMessage` and `onUserScriptConnect`, never on `onMessage`.
- **Matching:** `matches` *or* `includeGlobs`, minus `excludeMatches` and `excludeGlobs`. That's an OR, unlike content scripts, which need both. `allFrames` checks each frame on its own URL. User scripts never inherit an origin into `about:blank`, `data:` or `blob:` frames. `runAt` defaults to `document_idle`: 200 ms after `DOMContentLoaded`, or when the page has loaded, whichever comes first.
- **Limits:** 100 configured worlds per extension; world IDs up to 256 characters; IDs starting with `_` are reserved.
- **Lifetime:** registered scripts persist across restarts and are cleared when the extension updates. Extensions register them again from `runtime.onInstalled`.

### What Tampermonkey registers

Read from its 5.5.1 package (`background.js`):

- **`configureWorld`, once:** `{csp: "script-src 'self' 'unsafe-inline' *", messaging: true}`, with `'unsafe-eval'` added when its sandbox setting allows it. `'unsafe-inline'` is how it puts scripts into the page's own world on sites with a strict CSP: the world's CSP replaces the page's for whatever the world itself does.
- **Its default mode, "UserScripts API",** registers two scripts: `page.js` and `content.js` (about 95 KB together), as `{file}` sources. Both are `matches: ['<all_urls>']`, `runAt: 'document_start'`, `allFrames: true`, `world: 'USER_SCRIPT'`. Your scripts then travel over messaging when each page loads.
- **"UserScripts API Dynamic"** also registers each of your scripts on its own as `{code}`:
  - `matches` comes from `@match`, with `http*` expanded to both schemes;
  - `includeGlobs` comes from `@include`, with `.tld` turned into `.*`;
  - `excludeGlobs` comes from `@exclude`;
  - `allFrames` is false only for `@noframes`;
  - it always uses `document_start`, so it must handle `@run-at` itself.

  A script with only `@include`s gets `matches: ['http://willneverexist.tmnk.net/']` plus its globs, so it relies on Chrome's OR. A RegExp `@include` becomes `<all_urls>` with a check in the script.
- **Messaging:** its worker adds the same handler to `onMessage` and `onUserScriptMessage`, and to `onConnect` and `onUserScriptConnect`. Its `content.js` calls `runtime.sendMessage` at 11 places. It keeps a long-lived `runtime.connect` port per frame, listens on `runtime.onMessage` for its worker's `tabs.sendMessage`, and reads `lastError`.

### How it notices the API is off

- **The check** is `try { return !!chrome.userScripts } catch { return false }`. It doesn't look at Chrome's version.
- **While it's off,** it shows its notice ("Please enable the `Allow User Scripts` extension setting", linking to its FAQ, Q209) and checks again every 3 s, and once a minute on an alarm. When the check passes, it clears the notice and registers.
- **Q209 says:** right-click Tampermonkey's icon, choose *Manage extension*, turn on *Allow User Scripts* (Chrome 138+), or turn on Developer mode (older Chrome). It also notes that the `userScripts` permission alone adds no install warning.
- **Violentmonkey** matches the error text and shows a message chosen by Chrome version (138+ or older). **ScriptCat** registers and removes a dummy script to test the API, and opens its help page.

### The switch, in Chrome

- **Chrome 120–137** bound `chrome.userScripts` only in Developer mode. **Chrome 138+** has a per-extension *Allow User Scripts* switch on the extension's details page.
- **The switch is a per-extension preference** (`kUserScriptsAllowedPref`). It's offered only to extensions that ask for `userScripts`, as a required or an optional permission.
- **While it's off,** `chrome.userScripts` is undefined (`requires_delegated_availability_check`), and the extension's registered user scripts stop injecting. They're kept, and come back when it's turned on.
- **Turning it on** updates the extension's bindings in running renderers. Chrome's docs say a running service worker keeps what it had until it restarts.

### What its GM functions need, and where Chord stands today

| Function | Chrome APIs (Tampermonkey's worker) | In Chord today |
|---|---|---|
| `GM_xmlhttpRequest`, `@connect` | `fetch` or XHR in its worker; an offscreen document for blob and document responses; `declarativeNetRequest` session rules for forbidden headers; `webRequest`; `cookies`. It checks `@connect` and asks you itself. | `declarativeNetRequest` and `webRequest` are Electron's own and apply in chords' sessions ✓. `cookies` comes from the library ✓. `chrome.offscreen` is in Chromium's `//extensions`, which Electron builds; whether it works is ⚠ untested. electron-browser-shell's PR #187 adds its own. |
| `GM_setValue`, `GM_getValue`, value listeners | `storage.local`, and a port per frame | `storage.local` ✓. The ports are this work. |
| `GM_registerMenuCommand` | its action popup, `contextMenus` | ✓ (Chord's popups, the library's menus) |
| `GM_notification` | `notifications` | the library: title, text and icon, clicks and closes; no buttons |
| `GM_openInTab` | `tabs.create` | ✓ (opens a tab in the chord) |
| `GM_download` | `downloads`, an optional permission | ✗: neither Electron nor the library has `downloads`, and Chord refuses `permissions.request` |
| `GM_setClipboard` | the offscreen document | ⚠ as offscreen |
| `GM_cookie` | `cookies` | ✓ |
| `GM_addStyle`, `GM_addElement` | the world's CSP | this work |

Elsewhere, its worker also uses:
- `alarms` and `idle`, which are in `//extensions` and ⚠ probably work;
- `storage.sync`, which the library aliases to `local` but not in workers (S9);
- `commands.onCommand`, which never fires (the library has `getAll` only);
- `runtime.getContexts`, ⚠ missing.

The maintainer uses Tampermonkey in Chord already, so its worker, popup and dashboard run.

## 2. What Electron gives Chord

### Chromium's implementation is already inside Electron

From Electron 45.0.0's source:
- **The functions are registered.** `userScripts` is in `//extensions`' API list (`schema.gni`), and Electron registers `//extensions`' functions (`CoreExtensionsBrowserAPIProvider`, per `electron_extensions_browser_api_provider.cc`).
- **Chromium's user script manager is there.** `ElectronExtensionSystem` creates a `UserScriptManager`, which is what Electron's content scripts already go through.
- **The API isn't bound.** `ElectronExtensionsClient` has no delegated availability check, and without one Chromium's `SimpleFeature` reports `userScripts` as unavailable (`kMissingDelegatedAvailabilityCheck`). There's also no call to turn the per-extension preference on.
- **Registered scripts persist.** *(Corrected 2026-10-25.)* `ElectronExtensionSystem` has created a `StateStore` for them (`dynamic_user_scripts_store()`, backend `SCRIPTS`) since electron/electron#55155 (2026-10-23; #55283 on 45-x-y), after Electron 45.0.0. Before that it returned `nullptr`.
- **The rest is Chromium's:** worlds and their CSP (`IsolatedWorldManager`), messaging from `user_script` contexts, `execute`, and the switch's renderer side (`Dispatcher::SetUserScriptsAllowed`).

So native support is (d) below: Electron provides the check and a method on `session.extensions` to set the switch, and keeps registered scripts in a store.

### What Chord could build it with, in its own code

- **Preloads.** Chord registers its page preload on every web session (`main/index.ts`, `registerPreloadScript`), and the library adds its own. A preload runs before the page's scripts, in Electron's isolated world (999), and can use `webFrame`, `contextBridge` and `ipcRenderer`.
- **In iframes only with `nodeIntegrationInSubFrames`.** Electron 45 runs preloads in the main frame only, unless the page's `webPreferences` set that switch (`ShouldLoadPreload` in `renderer_client_base.cc`). Chord's tabs, Peek and mini windows don't set it (`tabs.ts`). With `sandbox: true` it adds no Node; it only runs preloads in every frame, Chord's page preload and the library's included. It's fixed when a page is created.
- **A world per extension.** The loader would call:
  - `webFrame.setIsolatedWorldInfo(id, {securityOrigin: 'chrome-extension://<ext>', csp, name})`, where a CSP needs a security origin;
  - then `webFrame.executeJavaScriptInIsolatedWorld(id, [{code, url}])`.

  Electron runs that synchronously (`EvaluationTiming::kSynchronous`), so a call from the preload is `document_start`. `document_end` is `DOMContentLoaded`; `document_idle` is Chrome's rule above. `MAIN` scripts go through `webFrame.executeJavaScript`.
- **World IDs.** Chord uses 999 (Electron's preload world, which holds the preloads' IPC), 1007, 1008, 4321, and 4400–4430. The library's preload puts its emulated `chrome.*` into any world in `[1 << 20, 1 << 29)`, the range Electron keeps for extensions. User-script worlds would sit in a range of their own below that (say from 100,000), one per extension and `worldId`, assigned by main. Profiles never share a renderer process, so the numbers are per profile.
- **Preload URL filters.** These are new: Electron PR #54903, merged 2026-10-21, and backported to 45-x-y in #55181 on 2026-10-22. They're not in 45.0.0, which Chord pins; the next 45.x will have them ⚠. A preload can carry `matches`, `excludeMatches`, `includeGlobs`, `excludeGlobs` and `matchOriginAsFallback`. Main checks them in C++ when each frame commits, and a preload that doesn't match isn't read or sent.
  - Their globs AND with `matches`, as content scripts' do. A user script with both becomes two registrations, one for its `matches` and one for its globs, and the loader runs it once.
  - `allFrames: false` is a check in the loader (`process.isMainFrame` ⚠), after delivery.
- **The code arrives with each frame.** Electron 45 reads each matching preload from disk, hashes it and sends it with the commit, on main's UI thread (`ScopedAllowBlockingForElectron` in `SendRendererStartupData`). It caches the compiled preload, but a user script passed as a string is compiled in the renderer each time. Electron has no way to share one copy between documents. Chromium's own path puts the scripts in read-only shared memory, one copy per renderer process (`UserScriptSet::UpdateUserScripts`).
- **Messaging to the worker.** The loader exposes a bridge into the user-script world with `contextBridge.exposeInIsolatedWorld`, and a small first script builds `chrome.runtime.sendMessage`, `connect`, `onMessage`, `onConnect` and `lastError` on it, only when the world has messaging.
  - The bridge goes over IPC to the library's router in main. The router wakes the worker (`startWorkerForScope`) and delivers `runtime.onUserScriptMessage` or `onUserScriptConnect` there, as it already delivers `runtime.onInstalled`.
  - Replies and port traffic need a request ID and connection IDs, as the library's native-messaging ports already have.
  - `tabs.sendMessage` and `tabs.connect` are Electron's own and only reach content scripts. Chord would wrap them in the worker so they also reach the tab's user-script worlds, with the first reply winning.
  - In the worker, `chrome.userScripts` is defined while the switch is on and undefined while it's off, on `chrome` and on `browser`. Tampermonkey's 3-second check then sees the change without a restart.
- **Navigations.** Each new document gets a fresh preload context and runs its matching scripts again. Same-document navigations (`pushState`, `#`) and pages restored from the back/forward cache run nothing again, as in Chrome. A slept tab that wakes, a reload, and tabs restored at launch all run them again. Registered scripts would be kept by Chord and their preloads registered before any window opens, like extensions themselves (§1 of ARCHITECTURE.md, *Launch order*). Registering costs nothing until a frame matches.
- **Private windows** load no extensions at all: Electron refuses in-memory sessions. **Peek and mini windows** use the chord's own session, so session preloads (and content scripts) already reach them. They aren't extension tabs until adopted, though, so messages from them would have no `sender.tab`.

### Prior art: electron-browser-shell PR #187

It's open since 2026-10-06, about 900 lines, adding `chrome.userScripts` and `chrome.offscreen` to upstream electron-chrome-extensions, the library Chord vendors a fork of.
- **How it injects:** from main through `tabs.executeScript`, as each frame commits, into the extension's content-script world.
- **What it doesn't do:** it doesn't guarantee `document_start`, and messages arrive on `onMessage`. `configureWorld` does nothing, and registrations are in memory.
- **For Tampermonkey,** the CSP and the timing matter: it registers everything at `document_start` and needs its CSP for strict sites. So it isn't enough as it is. Its offscreen half is worth taking if Electron's own `chrome.offscreen` doesn't work ⚠.

## 3. Security

User scripts are code the extension supplies, usually written or installed by you, run on the sites the extension can reach. That's the point, and it's why Chrome puts it behind a switch.

**Decided, if the maintainer agrees:**

- **A switch per extension, per profile: *Allow user scripts*.**
  - It's off by default. It's shown only for extensions that ask for `userScripts`, on the extension's row in Settings → Extensions. The extension button's right-click *Manage in Settings*, the path Tampermonkey's FAQ describes, lands there.
  - Its line: "Lets Tampermonkey run scripts you add to it, on the sites it can reach. A script can read and change those pages, including what you type. Takes effect on pages you open or reload."
  - There's no prompt at install, as in Chrome, and no confirmation dialog: the switch is the choice.
  - It's kept with the extension in chord-data, survives updates, and goes when the extension is removed.
  - Turned off, the scripts stop on the next page load and stay registered, as in Chrome.
- **Where scripts never run:**

  | Place | Why |
  |---|---|
  | Chord's own pages (`chord://`: the shell, Settings, reader view, Duet) | They're on Chord's in-memory UI session, where no extension can load (S9). |
  | Other extensions' pages, and the PDF viewer (`chrome-extension://`) | Only `http:` and `https:` pages are matched. `file:` is out too: Chord loads extensions without file access. |
  | The Chrome Web Store (`chromewebstore.google.com`, `chrome.google.com/webstore`) | Chrome refuses scripts there, so one extension can't drive installs of others. Chord adds both to every registration's exclusions. |
  | Private windows | No extensions load there. |
  | Peek and mini windows | **They do run,** as content scripts already do: they're ordinary pages of the chord (Q4 below). |

- **Worlds and CSP.** Each extension, and each of its `worldId`s, gets its own world, never Electron's preload world (999), which holds IPC. The page can't see it, and nor can Chord's worlds or other extensions. The world's CSP is the one the extension configured, or Chrome's default. It applies only to what that world does: the page's own CSP is untouched, and Chord's worlds keep none.
- **IPC.** This is a second exception to "web content gets no IPC" (ARCHITECTURE.md §8), beside the library's preload. It's narrower:
  - it exists only in profiles where you allowed an extension's user scripts, and only in frames its scripts match;
  - it carries only that extension's messages, to that extension.

  Main checks the sender frame, that the extension is allowed and has a script matching that frame's URL, and a size cap (Chrome's messaging limit is 64 MiB ⚠). With (d) none of this is Chord's: Chromium's messaging does it.
- **Not exported or synced.** Registered scripts stay with the extension, which keeps its own data (S15 leaves extensions out).

## 4. Performance

**With no extension allowed, both ways cost nothing.** No preload is registered and no IPC added. Chord's page preload doesn't change, and nothing turns on `nodeIntegrationInSubFrames`. The only work is reading a flag when an extension loads.

**With scripts registered,** for Tampermonkey's default mode (about 95 KB of its own code at `document_start` in every frame):

| | (d) Chromium's own | (b) Chord's own |
|---|---|---|
| Matching | In the renderer, per frame, in C++ | In main, per frame commit, in C++ (preload filters) |
| Code delivery | One read-only shared copy per renderer process, refreshed only when scripts change | Read from disk, hashed and copied into every matching frame's commit, on main's UI thread |
| Work on main per navigation | No reads or copies. Chromium's injection tracker checks URLs at each commit, as it already does for content scripts | ⚠ about 0.1–0.3 ms per frame for 95 KB, so a page with 20 frames costs 2–6 ms of main's time over its load |
| Compiling | In the renderer. `document_start` scripts may compile on a background thread (`ExtensionScriptStreamer`, behind a feature flag ⚠) | In the renderer, from a string, every document. V8's per-process cache may help ⚠ |
| Iframes | Chromium's own, in every frame | Needs `nodeIntegrationInSubFrames`. Chord's page preload and the library's then run in every iframe too, so the cost is counted per iframe ⚠ |
| `document_start` | Exact | Exact (the preload runs first) |

- **Delivering the code once per process isn't possible for Chord's own code.** Preload contexts are per document, and Electron offers apps no shared memory. A synchronous IPC per frame (what Chord's own code would need on 45.0.0, without filters) is worse: the frame waits on main, and main still copies the code.
- **To measure, for either option:** a perf.spec case loading a page with 10 iframes in four setups: no extensions; the switch off; a fixture with a 95 KB `<all_urls>`, all-frames script; and, with (b), a large set (50 scripts). Measure main's busiest task and its total busy time during the load, the time to `DOMContentLoaded`, and each renderer's memory. Hold them to the runner's baseline, as memory and launches are.

## 5. Options

| | What you get | Effort ⚠ |
|---|---|---|
| **(a) The whole API, in Chord** | Tampermonkey, Violentmonkey and ScriptCat. (b), plus `MAIN` worlds, `execute` (which needs a small listener preload in every frame of those profiles), world IDs and their configurations, and offscreen documents and downloads for their GM functions | about 5 weeks |
| **(b) Tampermonkey's subset, in Chord** | Tampermonkey in both its modes: `register`, `update`, `unregister`, `getScripts`, `configureWorld` (default world); `USER_SCRIPT` only; `{file}` and `{code}`; `matches`, globs, `allFrames`, `runAt`; both messaging events, ports and `tabs.sendMessage` into the world; the switch; scripts kept across restarts and cleared on update; iframes. Main's work per frame as in §4. Violentmonkey still fails (it needs `execute`), and ScriptCat's `MAIN`-world scripts don't run. | about 3 weeks: the API and its store 3 days, the switch 2, the loader and worlds 3, messaging 3–4, iframes and measuring 2, tests 2–3 |
| **(c) Not building it** | Tampermonkey installs and its dashboard works; your scripts don't run. Instead: Effects (built, D13) covers style-only changes such as CSS and hiding elements. Tampermonkey's MV2 build (its Q408) isn't an answer: Chord can't install a CRX by hand, and Chromium is removing MV2 ⚠. Otherwise, another browser for those sites. | none |
| **(d) Chromium's own, turned on in Electron** | The whole API, exactly as Chrome has it, for all three managers, with no file reads or copies on main per navigation. Electron provides the availability check and `session.extensions` methods to set and read the switch (the store for registered scripts is there since #55155). Chord adds the switch in Settings and keeps its value. | Electron patch: 1.5–2 weeks, including a first Electron build (about 100 GB of disk and hours ⚠, on a cloud machine, not your PC), then review and a release. #54903 took 7 days to merge and a day to reach 45-x-y. Chord: 3–4 days. |

Whichever option, Tampermonkey's other gaps (§1) are separate items:
- check `chrome.offscreen`, and take #187's offscreen half if it's missing (about 2 days ⚠);
- `downloads` and an optional-permission prompt for `GM_download`, which is bigger and not part of this.

**I recommend (d), time-boxed, with (b) as the fallback.**
- **Performance first:** it's the only way with no file reads or copies on main per navigation, and one shared copy per process. Chord's own way puts a file read in every frame's commit.
- **Less code:** Electron already compiles Chromium's implementation, so Electron needs three small pieces, and Chord needs a switch. Chrome's own matching, worlds, messaging and `execute` come with it, so Violentmonkey and ScriptCat work too.
- **Risk:** Electron's docs call Chrome-extension compatibility a non-goal. But they took `chrome.scripting` (#39395) and the preload filters this month, and backported the filters to 45 within a day. Open an issue first (a day) to ask. If the answer is no, or the patch isn't merged by mid-December, build (b) behind `ExtensionHost`, where (d) can later replace it.

## 6. Tests

As the maintainer prefers: a few journeys in the Linux container and CI, never on the desktop, plus unit tables. The same journeys test (d) and (b), since they test what pages see.

**The fixture:** `apps/desktop/test/fixtures/user-scripts/`, beside the existing `fixtures/extension/`. It's MV3, with `userScripts` and `<all_urls>`. Its worker:
- configures the world with `{csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval'", messaging: true}`;
- registers:
  - a `document_start` script that records `document.readyState`, and whether a global set by the page's first inline script exists yet (it mustn't);
  - an all-frames script;
  - an `@include`-style script (a never-matching `matches` plus `includeGlobs`) with an `excludeMatches`;
  - a script that calls `eval` and inserts an inline `<script>` into a page served with a strict CSP;
  - a messaging script: `sendMessage` answered from `onUserScriptMessage`, a port echoed through `onUserScriptConnect`, and the worker's `tabs.sendMessage` answered from the world;
- for (a) or (d) also: a `MAIN` script and `execute`.

**Journeys:**
1. **Allow, run, turn off.**
   - With the fixture loaded, `chrome.userScripts` is undefined.
   - Turn the switch on in Settings; the fixture's worker then has `chrome.userScripts`.
   - Reload: each script ran when it should, in the top frame and an iframe; the page can't see the world's globals; the strict-CSP script ran; the messages made their round trips.
   - Turn it off: the next load runs nothing, and the scripts are still registered.
2. **Restart and update.**
   - Relaunch: the first restored page runs the scripts before the worker has started.
   - Update the fixture's version: its scripts are cleared, and it gets `onInstalled` with `update`.
3. **Never here.** Nothing runs in:
   - a private window;
   - the Web Store's addresses, mapped to the test server with `--host-resolver-rules`;
   - a `chord://` page;
   - a PDF;
   - another profile.

**Unit tables:**
- **Matching**, Chrome's rules:
  - `matches` or `includeGlobs`, minus the exclusions;
  - match patterns' schemes, `*.` hosts, ports, paths and `<all_urls>`;
  - globs' `*` and `?`;
  - no inheritance into `about:blank`.

  Its rows include Tampermonkey's real registrations: the `willneverexist` placeholder with globs, expanded `http*`, `.tld`, and the RegExp fallback.
- **Validation,** with Chromium's messages: no `matches`, empty `js`, both `code` and `file`, a `_` ID, a `worldId` with `MAIN`, over 256 characters, a 101st world; and `update` changing only what it names.
- **For (b):** how a script becomes Electron filters (one registration or two), world-ID assignment, the default CSP, and injection order.
- **For (d):** the switch's state per extension and profile, and which extensions get it.

**Performance:** the perf.spec case in §4.

**Real managers:**
- **Violentmonkey** (MIT) can be cached and run in CI as a smoke test with (a) or (d): install, allow, run a script.
- **Tampermonkey can't be.**
  - Its package says "Copyright 2018 Jan Biniok. All rights reserved."
  - Its EULA (the one on addons.mozilla.org ⚠ for the Chrome build) says "you may not distribute Tampermonkey or any portion thereof to any third parties", which rules out a copy in the repo or a CI cache. It also forbids "automated data collection methods, data mining, robots, scraping", which is unclear for tests.
  - The Web Store's update endpoint does serve it: version 5.5.1, 1.7 MB.
  - So it gets a checklist in `docs/testing/` that the maintainer runs by hand on Windows: install, allow, a `@match` script, a `document-start` script, a `GM_xmlhttpRequest` with `@connect`, a menu command, `GM_setValue` across two tabs, an iframe script.

## 7. Open questions

1. **(d) first, or (b) now?** I recommend (d): an issue to Electron this week, then the patch if they're open to it, with (b) if it stalls by mid-December.
2. **Where would an Electron build happen?** About 100 GB and hours ⚠. I recommend a cloud machine or a CI workflow, not your PC.
3. **With (b), iframes: turn on preloads in every frame for tabs in profiles where a script manager is allowed?** I recommend yes, measured first. Without it, Tampermonkey's scripts miss every iframe. It applies to pages opened after the switch; open tabs pick it up when they're next created.
4. **Peek and mini windows:** run user scripts there? I recommend yes, as content scripts already do. Their pages should become extension tabs of the window they float in, so messages carry `sender.tab` ⚠ (what Tampermonkey does without it is unchecked).
5. **The Web Store: never, as in Chrome?** I recommend yes.
6. **The switch only in Settings → Extensions,** with no prompt at install? I recommend yes, as Chrome does. Tampermonkey's own notice points there.
7. **Tampermonkey's tests:** a hand checklist, with Violentmonkey in CI? I recommend yes. Ask Tampermonkey's author for permission only if the hand checks aren't enough.
8. **`GM_download`** needs `downloads` and an optional-permission prompt, which Chord doesn't have. Leave it out of this? I recommend yes, as an item of its own.

## Where I looked, and what isn't verified

**Read for this document (2026-10-25):**
- **Chrome's docs:** the `chrome.userScripts` reference.
- **Chromium (main, from chromium.googlesource.com):**
  - `extensions/common/api/user_scripts.webidl`, `_api_features.json`, `_permission_features.json`, `schema.gni`;
  - `extensions/browser/api/user_scripts/user_scripts_api.cc`, `user_script_manager.cc`, `extension_user_script_loader.cc`;
  - `extensions/common/user_scripts_availability.cc`, `user_scripts_allowed_state.cc`, `user_script.{h,cc}`, `api/scripts_internal/script_serialization.cc`, `manifest_handlers/csp_info.cc`, `features/simple_feature.cc`;
  - `extensions/renderer/isolated_world_manager.cc`, `user_script_set.cc`, `script_injection_manager.cc`, `dispatcher.cc`;
  - `extensions/browser/renderer_startup_helper.cc`, `script_injection_tracker.cc`.
- **Electron v45.0.0:**
  - docs: `extensions.md`, `web-frame.md`, `web-frame-main.md`, `context-bridge.md`, `structures/web-preferences.md`, `tutorial/sandbox.md`;
  - `shell/common/world_ids.h`;
  - `shell/renderer/api/electron_api_web_frame.cc`, `electron_sandboxed_renderer_client.cc`, `renderer_client_base.cc`;
  - `shell/browser/renderer_startup_data.cc`, `preload_script.cc`;
  - `shell/browser/extensions/electron_extension_system.cc`, `electron_extensions_browser_api_provider.cc`, `electron_browser_context_keyed_service_factories.cc`;
  - `shell/common/extensions/electron_extensions_client.cc`, `api/_api_features.json`, `api/_permission_features.json`.
- **Electron PRs:** #54903 (its diff) and its backport #55181. GitHub's issue search found no request for `userScripts`.
- **Tampermonkey 5.5.1,** downloaded from the Web Store's update endpoint into an empty temporary folder, read only (code review, which its EULA allows), and deleted: `manifest.json`, `background.js`, `content.js`, `page.js`, `offscreen.js`, `_locales/en/messages.json`, `LICENSE`. Also its FAQ (Q209, Q408), its `@connect` documentation, and its EULA on addons.mozilla.org.
- **Violentmonkey and ScriptCat:** their current sources on GitHub (`src/common/browser-scripts-api.js`, `src/background/`; `src/app/service/service_worker/runtime.ts`, `gm_api/`), read by a research agent. Their `configureWorld` and `execute` calls were checked again by hand.
- **electron-browser-shell** PR #187.
- **Chord:**
  - `packages/chrome-extensions` (`router.ts`, `preload.ts`, `renderer/index.ts`, `api/`, `CHORD-CHANGES.md`);
  - `apps/desktop/src/main/extensions/`, `preload/page.ts`;
  - in `apps/desktop/src/main/`: `index.ts`, `tabs.ts`, `peek.ts`, `mini-window.ts`, `reader/service.ts`.

**Not verified (⚠ above):**
- Chromium's main branch, not the exact 156 branch in Electron 45;
- that Electron's own `chrome.offscreen`, `alarms` and `idle` work;
- whether Electron would take the patch, and what an Electron build costs here;
- every cost in §4, which are estimates until measured;
- V8's compile cache across preload contexts, and the order Electron runs several session preloads in;
- `process.isMainFrame` in a sandboxed preload;
- Chrome delivering `tabs.sendMessage` to user-script worlds (inferred from `runtime.onMessage` being available there);
- Tampermonkey without `sender.tab`, and its `GM_xmlhttpRequest` and `GM_setClipboard` without an offscreen document;
- that the addons.mozilla.org EULA governs the Chrome build;
- the release that will carry the preload filters (the next 45.x);
- every estimate.
