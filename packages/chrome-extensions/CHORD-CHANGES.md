# Chord's changes to electron-chrome-extensions

Changes made by Chord contributors to the vendored source (fork commit `25cf4d7`). The diff against
the commit "Vendor electron-chrome-extensions 4.9.5 (iamEvanYT fork), unmodified" shows each one.

## 2026-10-22

- **`src/browser/index.ts`**
  - A `preloadPath` option: Chord bundles the preload itself, so the path is passed in rather than
    resolved from `node_modules`.
  - Methods for an app that draws its own toolbar: `getActionState()`, `getActionIcon()`,
    `activateAction()` and `getActionMenuItems()`.
  - `enableStaticRulesets()`: turns on declarativeNetRequest rulesets from the extension's service
    worker. Chrome does this at install; Electron skips that step.
- **`src/browser/impl.ts`**: an `openActionPopup` hook. When the app implements it, the library calls it
  instead of opening its own popup window. Chord shows popups in a view inside its window instead.
- **`src/browser/api/browser-action.ts`**
  - `getIcon()`, factored out of the `crx://` handler.
  - `getState()` and `activateClick()` are public.
  - The `openActionPopup` hook.
  - A `browser-action-updated` event on every change, not only when preload observers are registered.
  - The icon response body is a `Uint8Array`; `Buffer` isn't a `BodyInit` in current Node typings.
  - *(2026-10-25)* `getIcon()` reads icons an extension draws (`action.setIcon`'s `imageData`), which arrive as
    pixels (`src/browser/api/pixels.ts` makes them a PNG), picks the closest size from a set, and falls back to the
    extension's own icon when one it set can't be read, rather than none. Upstream dropped `imageData` from
    Manifest V3 extensions, so Tampermonkey, which draws its icon in its service worker, showed no icon at all.
- **`src/browser/api/pixels.ts`** *(new, 2026-10-25)*: pixels to PNG (RGBA, no filter, Node's `zlib`), with
  the checks on what an extension sends (sizes add up, at most 512 px a side).
- **`src/browser/router.ts`**: `queueAndSendEvent()` waits for the *target* extension's listener. Before,
  any extension's listener for the same event ended the wait, and the event could be sent to no one.
  This affected `dispatchRuntimeInstalled()`. A candidate for upstream.
- **`src/renderer/index.ts`** *(2026-10-25)*: `action.setIcon` turns `imageData` into `{ width, height, rgba }` (the bytes as
  base64) in the extension's own world, before the call crosses to the preload, where an `ImageData` can't go; the
  canvas-based conversion, which a service worker can't run, is gone.
- **`src/renderer/index.ts`**: extension service workers listen for `chord.enableStaticRulesets` and call
  `chrome.declarativeNetRequest.updateEnabledRulesets()`.
- **`src/preload.ts`**: no debug logging into every web page's console, and no `printIsolatedWorlds` debug
  global.
- **`src/browser/api/lib/native-messaging-host.ts`** and a new **`native-messaging-frames.ts`**: messages to a
  native host are sized in bytes, not characters. Messages from it are reassembled across stdout chunks, and
  several in one chunk are all delivered. A message over Chrome's 1 MB limit, or one that isn't JSON,
  disconnects. Before, non-ASCII or large messages (password managers send both) broke. A candidate for
  upstream.

New files, not from upstream: `package.json`, `tsconfig.json`, `build-types.mjs`, `types/` (generated),
`src/browser/api/lib/native-messaging-frames.ts`, `test/`, this file, and `README.md`. Upstream's README is kept as `UPSTREAM-README.md`.
