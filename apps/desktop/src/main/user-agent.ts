/**
 * Chord's user agent (decision S2, docs/decisions/S2-google-signin.md):
 * Electron's default minus the "Electron/x" and app-name tokens, which is
 * the standard Chromium format other Chromium browsers send. Client-hint
 * brands are left alone and still say "Chromium", not "Google Chrome".
 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function chromiumUserAgent(electronUserAgent: string, appName: string): string {
  const appToken = appName.replace(/\s+/g, '');
  return electronUserAgent
    .replace(/ Electron\/\S+/, '')
    .replace(new RegExp(` ${escapeRegExp(appToken)}/\\S+`), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
