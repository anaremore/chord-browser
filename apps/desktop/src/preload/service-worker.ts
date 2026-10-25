/**
 * Web pages' service workers' preload (ARCHITECTURE.md §9, counts on tabs):
 * a site's service worker can set the app badge too (`self.navigator.setAppBadge`,
 * on a push while its tab sleeps), which Electron would put on Chord's own
 * icon. Here it reports to Chord instead, which shows it on the site's tabs
 * that are under the worker's scope. Wrapped in the worker's own world, as the
 * page preload wraps a page's: nothing is exposed to it.
 */
import { contextBridge, ipcRenderer } from 'electron';

type Badge = number | 'dot' | null;

interface WorkerGlobals {
  WorkerNavigator?: { prototype: object };
  TypeError: new (message: string) => Error;
}

function badging(report: (badge: Badge) => void): void {
  const scope = globalThis as unknown as WorkerGlobals;
  const navigator = scope.WorkerNavigator?.prototype;
  if (!navigator) return;
  const wrap = (name: string, apply: (args: unknown[]) => Promise<void>) => {
    const original = (navigator as Record<string, unknown>)[name];
    if (typeof original !== 'function') return;
    Object.defineProperty(navigator, name, {
      value: new Proxy(original as (...args: unknown[]) => unknown, { apply: (_target, _self, args: unknown[]) => apply(args) }),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };
  // As the Badging API takes it: no number is a dot, 0 clears, anything that isn't a whole number ≥ 0 is refused.
  wrap('setAppBadge', (args) => {
    const value = args[0];
    const n = value === undefined ? null : Math.trunc(Number(value));
    if (n !== null && !(Number.isSafeInteger(n) && n >= 0)) return Promise.reject(new scope.TypeError(`Failed to execute 'setAppBadge' on 'WorkerNavigator': Value is outside the 'unsigned long long' value range.`));
    report(n === null ? 'dot' : n === 0 ? null : n);
    return Promise.resolve();
  });
  wrap('clearAppBadge', () => {
    report(null);
    return Promise.resolve();
  });
}

const report = (badge: Badge) => ipcRenderer.send('page:badge', badge);
contextBridge.executeInMainWorld({ func: badging, args: [report] });
