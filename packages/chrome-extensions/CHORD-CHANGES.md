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
- **`src/browser/router.ts`**: `queueAndSendEvent()` waits for the *target* extension's listener. Before,
  any extension's listener for the same event ended the wait, and the event could be sent to no one.
  This affected `dispatchRuntimeInstalled()`. A candidate for upstream.
- **`src/renderer/index.ts`**: extension service workers listen for `chord.enableStaticRulesets` and call
  `chrome.declarativeNetRequest.updateEnabledRulesets()`.
- **`src/preload.ts`**: no debug logging into every web page's console, and no `printIsolatedWorlds` debug
  global.

New files, not from upstream: `package.json`, `tsconfig.json`, `build-types.mjs`, `types/` (generated), this
file, and `README.md`. Upstream's README is kept as `UPSTREAM-README.md`.
