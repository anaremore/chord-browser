/**
 * Chord's own user agent rule (apps/desktop/src/main/user-agent.ts, decision
 * S2): Electron's default without the Electron and app tokens, with Chrome's
 * reduced version, so the services see the Chromium browser the player is.
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
