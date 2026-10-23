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

/** macOS checks spelling with the system's own spellchecker: no dictionaries, no language choice. */
const systemManaged = process.platform === 'darwin';

/** Each session's languages before Chord changed anything: what "System" goes back to. */
const systemLanguages = new WeakMap<Session, string[]>();

/** The dictionaries Chord can offer in Settings (none on macOS). */
export function spellcheckLanguages(): string[] {
  return systemManaged ? [] : [...session.defaultSession.availableSpellCheckerLanguages];
}

/** Apply the spelling settings to a profile's session. */
export function applySpellcheck(ses: Session, settings: SpellcheckSettings): void {
  ses.setSpellCheckerEnabled(settings.enabled);
  if (systemManaged) return;
  if (!systemLanguages.has(ses)) {
    systemLanguages.set(ses, ses.getSpellCheckerLanguages());
    ses.setSpellCheckerDictionaryDownloadURL(SPELLCHECK_DICTIONARIES_URL);
  }
  const available = new Set(ses.availableSpellCheckerLanguages);
  const wanted = settings.language && available.has(settings.language) ? [settings.language] : systemLanguages.get(ses)!;
  // Electron throws for a language it has no dictionary for.
  const languages = wanted.filter((language) => available.has(language));
  if (languages.length > 0 && languages.join() !== ses.getSpellCheckerLanguages().join()) ses.setSpellCheckerLanguages(languages);
}
