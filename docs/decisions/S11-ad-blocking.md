# S11: Ad and tracker blocking

**Result: both ways work, and they block exactly the same requests.** Neither alone covers what D5 asks for, so Chord uses both:

- **Chords' sessions:** EasyList and EasyPrivacy as `declarativeNetRequest` rules in an extension of Chord's own (b). Chromium matches every request in its own code; main runs no JavaScript per request, and other extensions, uBO Lite included, keep working.
- **Private windows:** Ghostery's engine (a), through one `onBeforeRequest` dispatcher per session, with the engine in a worker thread rather than in main. Electron loads no extension into an in-memory session, so (b) can't reach them.
- **Element hiding, everywhere:** the engine's `display: none` rules for each page's site, applied by main with `insertCSS`. No script goes into any page.

Built 2026-10-24 (ARCHITECTURE.md §9, D5 "As built").

## Why not one of them alone

**(a) everywhere** breaks extensions. Electron sends a session with any `session.webRequest` listener through its own proxy, and from then on the extensions' request handling, their `chrome.webRequest` listeners and their `declarativeNetRequest` rules alike, no longer applies to it ([electron_browser_client.cc @ v45.0.0](https://github.com/electron/electron/blob/v45.0.0/shell/browser/electron_browser_client.cc), `WillCreateURLLoaderFactory`: the extensions' proxy is only used when `!web_request->HasListener()`). uBO Lite would stop blocking in that chord. It also costs main more (below): a 12.7 ms task to load the engine, 7 MB more of main's heap, and cold matches up to 0.6 ms.

**(b) alone** can't reach private windows, can't hide elements, and its per-site switch as Chrome would write it doesn't work in Electron (below).

## The numbers

**Setup.** Electron 45.0.0 (Chromium 156) on Linux x64, in the E2E container (Ubuntu 24.04 under Docker in WSL 2 on the Windows 11 development machine, Xvfb): the work rules allow no Electron on the desktop. EasyList 202610241745 and EasyPrivacy 202610241737.

**The page** (`spikes/s11-ad-blocking/fixture.mjs`): a heavy news article of **368 requests** when nothing is blocked. 150 are its own (scripts, styles, fonts, 100 photos, API calls), plus a video embed, a library CDN, and the ad and tracking stack of a big news site: Google Publisher Tag with eight safeframes, AdSense, Prebid with ten bidders and a cookie-sync frame of 24 pixels, Amazon, Google Analytics, Meta, comScore, Chartbeat, Hotjar, Taboola, Outbrain, Segment and others. Every host is this machine (`--host-resolver-rules`), with a fixed delay of 5–34 ms each. An ad script that loads makes the requests it would on a real page, so blocking it also saves what it would have loaded.

**Method.** Each mode in a fresh profile: 3 warm-up loads, then 15 measured, nothing cached (`no-store`), three rounds. The table gives the median of the rounds' medians. Main's cost is its thread's CPU time (`process.threadCpuUsage()`) and event-loop delay (`monitorEventLoopDelay`, 1 ms). `performance.eventLoopUtilization()` reads 0 in Electron's main, whose libuv loop is driven by Chromium's message pump, so it can't be used. The callback time is measured inside the `onBeforeRequest` listener.

| Per page load | No blocking | (a) engine in main | (a′) engine in a worker | (b) rules |
|---|---|---|---|---|
| Requests that reached the server | 357 | 163 | 163 | 163 |
| Main thread CPU, ms (range of the rounds) | 201 (201–202) | 173 (163–203) | 162 (159–191) | **156** (155–174) |
| JavaScript in the request listener | — | 3.2 ms: 186 calls, p50 14.5 µs, p99 68 µs | 2.1 ms (posting only): p50 8.3 µs, p99 47 µs | **none** |
| First (cold) load: listener time, its p99 | — | 16.4 ms, 635 µs | 1.6 ms, 89 µs | none |
| Event-loop delay p99, ms | 2.6 | 1.8 | 1.8 | 1.8 |
| Load event, ms | 634 | 640 | 638 | 621 |
| Browser process memory, MB | 188 | 198 | 203 (the worker) | **188** |

- **Agreement:** on the first load of each, the hosts that got through under (a) and (b) are identical, request for request.
- **Blocking saves main more than it costs.** With nothing blocked, main does about 45 ms more per page, handling twice the requests. The pages' renderers use less too: 585 MB of working set without blocking, 261 MB with.
- **A busy main slows pages equally, whichever way blocks.** With main kept busy 20 ms of every 50, every mode's load took 937–941 ms, no blocking included. Navigations and frames go through main's thread anyway; (b)'s matching on Chromium's side adds no wait to that.

**Starting up.**

| | Main's cost |
|---|---|
| (a) engine in main | 2.4 ms to read 4.3 MB, then **12.7 ms deserializing**, one task |
| (a′) engine in a worker | 8.7 ms of main's CPU to start the worker (spread out); it answers 63 ms later (15 ms of that deserializing, on its own thread) |
| (b) first launch of a profile | The rulesets are off after `loadExtension` (Electron skips Chrome's install step, as S9 found). Turning them on from the control page: 203 ms, of which **22 ms** of main's CPU in small pieces (longest task 2.2 ms); the rules apply 32 ms after that. |
| (b) later launches | Chromium keeps the rulesets and the dynamic rules. Loading the extension cost main nothing measurable: 38 ms of CPU over the 800 ms after it, against 46 ms idle. |

**The lists** (`spikes/s11-ad-blocking/build.mjs`, Node 24 in the container):

| | EasyList | EasyPrivacy |
|---|---|---|
| Network filters | 60,926 | 56,369 |
| Rules written | 3,760 | 9,123 |
| Skipped | 2,962 popup, 167 element-hiding exceptions, 3 `$csp`, 3 patterns Chromium rejects | 3 `example.*` domains, 2 `$csp`, 1 `$redirect-rule`, 1 that would match everything |
| Rules JSON | 1.6 MB | 2.1 MB |

12,883 rules in all, under Chromium's 30,000 guaranteed per extension: filters that differ only in their host share one rule with all of them in `requestDomains` (the largest has 51,798). Converting takes 0.3 s. Parsing both lists into Ghostery's engine takes 0.4–0.6 s and gives 4.3 MB serialized. The engine on its own (`engine.mjs`): a warm match p50 4.6 µs, p99 28 µs; element hiding for one page 0.05 ms (2 ms the first time), 3.7 KB of CSS for cnn.com.

## What the extension's rules do in Electron 45

Measured in the same container (`main.mjs`, the `dnr-*` phases):

- **Rulesets** the manifest enables are off at load. Once the extension turns them on, Chromium keeps them across launches.
- **A list update in place.** Rewriting the rules files while the extension is loaded and turning its rulesets off and on fails with Chromium's "Internal error": it checks the new files against the old checksums. What works: remove the extension, rewrite the rules, delete Chromium's index (`_metadata`), load it, turn the rulesets on. That's **0.39 s** without blocking in that profile, with 71 ms of main's CPU spread out (longest task 5.5 ms). The new rules apply, and still do after a relaunch.
- **A new folder** for each version would mean a new extension ID, a fresh install with everything off. In place is simpler.
- **Removing the extension** stops all blocking in that session at once; loading it again brings back its rulesets and dynamic rules.
- **Per-site exceptions.** `allowAllRequests`, which is how Chrome and uBO Lite turn a site off, **doesn't work**: the site's ads were still blocked, from the page and from a frame. Electron never attaches Chromium's `declarative_net_request::WebContentsHelper`, which records the decision for each frame ([electron_extensions_api_client.cc @ v45.0.0](https://github.com/electron/electron/blob/v45.0.0/shell/browser/extensions/electron_extensions_api_client.cc), `AttachWebContentsHelpers`; Chrome attaches it in `chrome/browser/extensions/tab_helper.h`). An `allow` rule with **`topDomains`** works, from the page and from a third-party frame on it: Chromium finds a request's top-level frame from its `RenderFrameHost` ([request_params.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/api/declarative_net_request/request_params.cc)). Chord uses it for the sites you turn off, and for EasyList's `@@||site^$document` exceptions (one today; three more `$document` exceptions match paths, stay `allowAllRequests`, and so do nothing in Electron).
- **Knowing when the rules are in.** Chromium holds a just-loaded extension's `declarativeNetRequest` calls until its rulesets are loaded (`RulesMonitorService::ApiCallQueue`, [rules_monitor_service.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/api/declarative_net_request/rules_monitor_service.cc)), so a call from the control page that resolves means they apply.
- **The control page.** Main runs those calls in an empty page of the extension's own, opened for a change and closed after. No preload or IPC is involved, and nothing runs in the extension otherwise. Main can't reach a service worker without a preload in every worker of the session, which would include sites' workers.

## What each can do

| | (a) engine via `webRequest` | (b) `declarativeNetRequest` rules |
|---|---|---|
| Private windows | ✅ | ✗ Electron loads no extension into an in-memory session |
| Chords where extensions run | ✗ switches off extensions' `webRequest` and DNR in that session | ✅ beside them |
| Element hiding | ✅ from the engine, applied by main (`insertCSS`) | ✗ (uBO Lite uses content scripts) |
| A site turned off | ✅ in the listener | ✅ `allow` + `topDomains` (not `allowAllRequests`) |
| List updates | load the new engine | rewrite, reload, turn on: 0.4 s gap per profile |
| `$redirect` / `$rewrite` | blocks (the engine's replacement files aren't loaded) | blocks |
| `$csp`, popups | ✗ | ✗ |
| Main's work per request | 8–15 µs of JavaScript, plus Electron's marshalling | none |

## Decision

1. **Chords: (b).** It costs main nothing per request and nothing measurable after a profile's first launch, and it leaves extensions alone. Its gaps are covered by the engine.
2. **Private windows: (a), with the engine in a worker (a′).** That's the one place nothing else can do the job (rule 2), and the session has no extensions to break. In a worker rather than main: no 12.7 ms task, no engine in main's heap, and main's CPU per page was no higher (162 against 173 ms). Each request waits for one round trip to the worker, well under the network's time.
3. **Element hiding: the engine, for every page.** The same worker answers each page's site with `display: none` rules, filtered again in the worker so nothing else can get through (no other declaration, at-rule, comment or `url(`), and main inserts them as a user stylesheet. EasyList's generic rules indexed by class and id need the page's DOM, which would mean a script in the page: not done.
4. **Lists:** both compiled at build time from copies in the repository (`apps/desktop/build/ad-blocking`, refreshed with `pnpm --filter @chord/desktop lists`), refreshed from easylist.to when they say they expire (4 days), compiled in a short-lived worker, never on main.
5. **No native module** (rule 3): nothing here needed one.

## Not done, or uncertain

- ⚠ **At launch**, Chord waits for each chord's extension to load before any page does, as it does for other extensions. (Loading it beside the first navigation left restored tabs that never loaded on CI's macOS arm64 runner.) Its rules load a moment later, about 0.2 s here, and a page's first requests in that moment can get through.
- **Not covered:** generic element hiding by class and id, procedural (`:has-text`) filters and scriptlets, which all need code in pages. `$redirect` and `$rewrite` block instead of serving a stand-in (37 filters), and 2,962 popup filters do nothing.
- ⚠ **Measured on Linux only**, in a container, with a local page. Windows and macOS weren't measured (no Electron on the development desktop), and neither were real sites. Repeat `run.mjs` on CI or by hand to compare.
- ⚠ Electron could attach the per-tab DNR helper in a later version. If it does, `allowAllRequests` starts to work, and `topDomains` keeps working.

## Reproduce

`spikes/s11-ad-blocking/`, usage at the top of each file:

- `run-linux.mjs <lists folder> [--rounds 3] [--loads 15] [--lifecycle-only]` runs everything in the Linux E2E container. Results go to `results/linux/` (gitignored).
- `run.mjs` is the same, on any machine with a virtual display. It runs `build.mjs` (compiles the lists both ways, with Chord's converter), `engine.mjs` (the engine in Node), then `main.mjs` in Electron once per mode, round and lifecycle phase.
- Get the lists into a folder of their own first: `pnpm --filter @chord/desktop lists` writes them to `apps/desktop/build/ad-blocking`.

## Sources

- Ghostery adblocker: [`@ghostery/adblocker`](https://www.npmjs.com/package/@ghostery/adblocker) 2.20.1, MPL-2.0, published 2026-10-09; its dependencies are MPL-2.0 (`@remusao/*`, `@ghostery/url-parser`, `@ghostery/adblocker-*`) and MIT (`tldts`).
- EasyList and EasyPrivacy: [easylist.to](https://easylist.to/), dual licensed under GPL-3.0 and CC BY-SA 3.0 or any later version ([licence](https://easylist.to/pages/licence.html)). Served through Cloudflare from GitHub Pages (response headers, 2026-10-24).
- Electron 45.0.0: [electron_browser_client.cc](https://github.com/electron/electron/blob/v45.0.0/shell/browser/electron_browser_client.cc), [electron_api_web_request.cc](https://github.com/electron/electron/blob/v45.0.0/shell/browser/api/electron_api_web_request.cc), [electron_extensions_api_client.cc](https://github.com/electron/electron/blob/v45.0.0/shell/browser/extensions/electron_extensions_api_client.cc), [electron_extension_loader.cc](https://github.com/electron/electron/blob/v45.0.0/shell/browser/extensions/electron_extension_loader.cc).
- Chromium `declarativeNetRequest`: [declarative_net_request.webidl](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/api/declarative_net_request.webidl) (`topDomains`), [request_params.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/api/declarative_net_request/request_params.cc), [rules_monitor_service.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/api/declarative_net_request/rules_monitor_service.cc), [ruleset_manager.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/api/declarative_net_request/ruleset_manager.cc).
- S9: [S9-extensions.md](S9-extensions.md) (rulesets stay off at load in Electron; uBO Lite blocks).
