// Chord's own user agent rule (apps/desktop/src/main/user-agent.ts): Chrome's,
// without the Electron and app tokens, with the reduced version.
export function chromiumUserAgent(electronUserAgent, appName) {
  const appToken = appName.replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return electronUserAgent
    .replace(/ Electron\/\S+/, '')
    .replace(new RegExp(` ${appToken}/\\S+`), '')
    .replace(/Chrome\/(\d+)(?:\.\d+){3}/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
