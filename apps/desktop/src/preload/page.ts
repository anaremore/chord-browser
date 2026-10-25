/**
 * Web pages' preload (ARCHITECTURE.md §9, "Page compatibility"): runs in
 * every web page's frame before the page's own scripts, and gives the page
 * nothing of Chord's. It changes two things in the page's own world, where
 * Electron differs from every Chromium browser in ways sites act on:
 *
 * - `window.chrome.app`. Chromium has it; Electron leaves `window.chrome`
 *   empty. Google's sign-in turns away a browser that says it's Chromium
 *   without it ("This browser or app may not be secure"; measured on
 *   Electron 45 by another project: admitted 5 of 5 with it, refused without).
 *   Its shape is Chromium's, for a page that isn't an installed app.
 * - Passkey autofill. Chrome shows passkeys in its autofill list under the
 *   field; Electron has no such list, so a site's autofill request
 *   (`mediation: 'conditional'`) opens the system's passkey dialog at once,
 *   every time (Windows Security, on Windows). Chord says autofill isn't
 *   available, and such a request just waits, as Chrome's does until you pick
 *   a passkey. A passkey you ask for (the site's "Use a passkey") works as before.
 *
 * Changed functions keep reading as built-in, wrapped in a Proxy (or bound),
 * so a site that checks for tampered APIs sees Chromium's.
 */
import { contextBridge } from 'electron';

/** The page's globals this touches (the preload's project has no DOM types; this runs in the page's own world). */
interface Signal {
  aborted: boolean;
  reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options: { once: boolean }): void;
}
interface PageGlobals {
  chrome?: Record<string, unknown>;
  PublicKeyCredential?: Record<string, unknown>;
  CredentialsContainer?: { prototype: object };
  DOMException: new (message: string, name: string) => unknown;
  setTimeout(handler: () => void, ms: number): unknown;
}

function compatibility(): void {
  const page = globalThis as unknown as PageGlobals;
  // ----- window.chrome.app, as Chromium has it on a page that isn't an installed app -----
  const chromeObject = page.chrome;
  if (chromeObject && !('app' in chromeObject)) {
    const native = <T extends (...args: never[]) => unknown>(fn: T): T => fn.bind(null) as T;
    const InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
    const RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
    const app = {
      isInstalled: false,
      getDetails: native(() => null),
      getIsInstalled: native(() => false),
      installState: native((callback?: (state: string) => void) => {
        if (typeof callback === 'function') page.setTimeout(() => callback('not_installed'), 0);
      }),
      runningState: native(() => 'cannot_run'),
      InstallState,
      RunningState,
    };
    Object.defineProperty(chromeObject, 'app', { value: app, writable: true, enumerable: true, configurable: true });
  }

  // ----- Passkey autofill: not available, so no system dialog pops up by itself -----
  const PKC = page.PublicKeyCredential;
  const wrap = (owner: object, name: string, apply: (target: (...args: unknown[]) => unknown, self: unknown, args: unknown[]) => unknown) => {
    const original = (owner as Record<string, unknown>)[name];
    if (typeof original !== 'function') return;
    Object.defineProperty(owner, name, { value: new Proxy(original as (...args: unknown[]) => unknown, { apply }), writable: true, enumerable: false, configurable: true });
  };
  if (PKC) {
    wrap(PKC, 'isConditionalMediationAvailable', () => Promise.resolve(false));
    wrap(PKC, 'getClientCapabilities', (target, self, args) =>
      (Reflect.apply(target, self, args) as Promise<Record<string, boolean>>).then((caps) => ({ ...caps, conditionalGet: false, conditionalCreate: false })),
    );
  }
  // An autofill request a site makes anyway waits, as Chrome's does until you pick a passkey; aborting it ends it.
  const waiting = (options: { signal?: Signal } | undefined) =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return;
      const abort = () => reject(signal.reason ?? new page.DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  const container = page.CredentialsContainer?.prototype;
  if (container) {
    for (const name of ['get', 'create'] as const) {
      wrap(container, name, (target, self, args) => {
        const options = args[0] as { mediation?: string; publicKey?: unknown; signal?: Signal } | undefined;
        return options?.mediation === 'conditional' && options.publicKey ? waiting(options) : Reflect.apply(target, self, args);
      });
    }
  }
}

// Web pages only: not an extension's pages, which share the session, nor a blank frame's.
const { protocol } = (globalThis as unknown as { location: { protocol: string } }).location;
if (protocol === 'https:' || protocol === 'http:') contextBridge.executeInMainWorld({ func: compatibility });
