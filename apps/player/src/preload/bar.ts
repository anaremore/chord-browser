/** The bar's door to the player's main process: what to show, and Back to Chord. Nothing else. */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld(
  'player',
  Object.freeze({
    onState(listener: (state: unknown) => void): void {
      ipcRenderer.on('bar:state', (_event, state: unknown) => listener(state));
      ipcRenderer.send('bar:ready');
    },
    back(): void {
      ipcRenderer.send('bar:back');
    },
  }),
);
