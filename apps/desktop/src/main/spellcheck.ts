/**
 * Spelling in text fields (ARCHITECTURE.md §9). On Windows and Linux,
 * Chromium checks spelling with Hunspell dictionaries it downloads the first
 * time a language is used; macOS uses its own spellchecker, which chooses its
 * languages itself. Suggestions and "Add to dictionary" are at the top of the
 * right-click menu (context-menu.ts).
 */
import type { SpellcheckSettings } from '@chord/core';
import { session, type Session } from 'electron';

/**
 * Where Hunspell dictionaries come from: Chromium's own default, a Google
 * CDN (seen in a net log, 2026-10-23). One constant, so the Google-free mode
 * (ROADMAP Phase 3) can point it somewhere else.
 */
export const SPELLCHECK_DICTIONARIES_URL = 'https://redirector.gvt1.com/edgedl/chrome/dict/';

/**
 * Google-free mode's dictionary "server": port 9 on this computer, a port
 * Chromium refuses to connect to (its restricted-ports list), so a dictionary
 * that isn't downloaded yet fails at once and nothing leaves the computer.
 * Dictionaries already downloaded keep working, and so does the system's own
 * spellchecker (macOS always; Windows for the languages it checks itself).
 */
export const SPELLCHECK_OFFLINE_URL = 'http://127.0.0.1:9/';

/** macOS checks spelling with the system's own spellchecker: no dictionaries, no language choice. */
const systemManaged = process.platform === 'darwin';

/** Each session's languages before Chord changed anything: what "System" goes back to. */
const systemLanguages = new WeakMap<Session, string[]>();
/** Where dictionaries download from now. */
let dictionarySource: string | null = null;

/** The dictionaries Chord can offer in Settings (none on macOS). */
export function spellcheckLanguages(): string[] {
  return systemManaged ? [] : [...session.defaultSession.availableSpellCheckerLanguages];
}

/**
 * Where dictionaries download from. Electron keeps one place for the whole
 * app, whichever session sets it, and a session starts downloading its saved
 * languages as soon as spelling is on in it. So this is set before any
 * session exists (offline, until the saved settings are read), then from the
 * settings, and before every change to a session's spelling.
 */
export function setDictionarySource(googleFree: boolean): void {
  if (systemManaged) return;
  const source = googleFree ? SPELLCHECK_OFFLINE_URL : SPELLCHECK_DICTIONARIES_URL;
  if (source === dictionarySource) return;
  session.defaultSession.setSpellCheckerDictionaryDownloadURL(source);
  dictionarySource = source;
}

/** Apply the spelling settings to a session; in Google-free mode, only dictionaries already downloaded. */
export function applySpellcheck(ses: Session, settings: SpellcheckSettings, googleFree: boolean): void {
  setDictionarySource(googleFree);
  ses.setSpellCheckerEnabled(settings.enabled);
  if (systemManaged) return;
  if (!systemLanguages.has(ses)) systemLanguages.set(ses, ses.getSpellCheckerLanguages());
  const available = new Set(ses.availableSpellCheckerLanguages);
  const wanted = settings.language && available.has(settings.language) ? [settings.language] : systemLanguages.get(ses)!;
  // Electron throws for a language it has no dictionary for.
  const languages = wanted.filter((language) => available.has(language));
  if (languages.length > 0 && languages.join() !== ses.getSpellCheckerLanguages().join()) ses.setSpellCheckerLanguages(languages);
}
