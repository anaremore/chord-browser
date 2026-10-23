/**
 * The preload for Chord's internal pages (ARCHITECTURE.md §8): Settings sees
 * settings and one chord's theme, never tabs or history.
 */
import type { SettingsApi } from '@chord/ipc';
import { contextBridge } from 'electron';
import { invoke, subscribe, systemApi } from './bridge';

const api: SettingsApi = {
  system: systemApi,
  settings: {
    snapshot: () => invoke('settings:snapshot'),
    onChange: (listener) => subscribe('settings:changed', listener),
    onSection: (listener) => subscribe('settings:section', listener),
    set: (patch) => invoke('settings:set', patch),
    theme: (chordId, theme) => invoke('settings:theme', { chordId, theme }),
    saveTheme: (theme) => invoke('settings:saveTheme', { theme }),
    deleteTheme: (id) => invoke('settings:deleteTheme', { id }),
    copyText: (text) => invoke('settings:copyText', { text }),
    recordingShortcut: (recording) => invoke('settings:recordingShortcut', { recording }),
    chordSignIns: (chordId, separate) => invoke('settings:chordSignIns', { chordId, separate }),
    sitePermission: (origin, permission, decision) => invoke('settings:sitePermission', { origin, permission, decision }),
    forgetSite: (origin) => invoke('settings:forgetSite', { origin }),
    defaultBrowser: () => invoke('settings:defaultBrowser'),
    makeDefaultBrowser: () => invoke('settings:makeDefaultBrowser'),
    updateStatus: () => invoke('settings:updateStatus'),
    checkForUpdates: () => invoke('settings:checkForUpdates'),
    about: () => invoke('settings:about'),
    openUrl: (url) => invoke('settings:openUrl', { url }),
  },
  extensions: {
    install: (input) => invoke('extensions:install', { input }),
    remove: (profileId, id) => invoke('extensions:remove', { profileId, id }),
    options: (profileId, id) => invoke('extensions:options', { profileId, id }),
    update: () => invoke('extensions:update'),
  },
};

contextBridge.exposeInMainWorld('chord', Object.freeze(api));
