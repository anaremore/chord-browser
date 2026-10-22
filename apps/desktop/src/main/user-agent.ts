/**
 * Chord's user agent (decision S2, docs/decisions/S2-google-signin.md):
 * Electron's default minus the "Electron/x" and app-name tokens, with the
 * Chrome version reduced to `<major>.0.0.0` the way Chromium itself reports
 * it. That is byte-for-byte the format other Chromium browsers send.
 * Client-hint brands are left alone and still say "Chromium".
 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function chromiumUserAgent(electronUserAgent: string, appName: string): string {
  const appToken = appName.replace(/\s+/g, '');
  return electronUserAgent
    .replace(/ Electron\/\S+/, '')
    .replace(new RegExp(` ${escapeRegExp(appToken)}/\\S+`), '')
    .replace(/Chrome\/(\d+)(?:\.\d+){3}/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
