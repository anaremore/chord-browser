// The sign-in sweep's Electron app (sweep.spec.ts): no Chord, only windows the spec opens, one per
// site, each in an in-memory session of its own. It asks for nothing and lets a page do nothing
// beyond loading: no pop-ups, permissions or downloads.
import { app } from 'electron';

// A normal Chrome's user agent, of this Electron's Chromium, with no "Electron" or app name in it.
const chrome = process.versions.chrome.split('.')[0];
app.userAgentFallback = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`;

app.on('window-all-closed', () => {});
app.on('session-created', (s) => {
  s.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  s.setPermissionCheckHandler(() => false);
  s.on('will-download', (event) => event.preventDefault());
});
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
