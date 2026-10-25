/**
 * The bar of a tab's developer tools in a window of their own (DESIGN.md
 * §7.15): it shows the tab's site and docks them back. It sees no tabs,
 * history or settings.
 */
import type { DevtoolsBarApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, subscribe, systemApi } from './bridge';

const api: DevtoolsBarApi = {
  system: systemApi,
  devtools: {
    bar: () => invoke('devtools:bar'),
    onBar: (listener) => subscribe('devtools:bar', listener),
    dock: () => invoke('devtools:do', { do: 'dock' }),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
