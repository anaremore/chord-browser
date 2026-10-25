// Host census for the navigation lock (S14 question 3), on stock Electron: for
// each DRM service, open its home page, press its own "Sign in" / "Log in", and
// open its sign-in page, and record which hosts each one navigates to (main
// frame, redirects included), frames, opens popups on, and loads subresources
// from. No account, nothing typed. Each service gets its own in-memory session.
//
//   electron census --out <dir> [--only Netflix,Spotify] [--settle 12000]
import '../shared/guard.mjs';
import { deadline } from '../shared/guard.mjs';
import electron from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumUserAgent } from '../shared/user-agent.mjs';

const { app, BrowserWindow, session } = electron;
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const out = arg('out', join(process.cwd(), 'census-results'));
const settle = Number(arg('settle', '12000'));
const only = arg('only', '')?.split(',').filter(Boolean);
deadline(20 * 60_000, 'census');

const SERVICES = [
  { name: 'Netflix', home: 'https://www.netflix.com/', signin: 'https://www.netflix.com/login' },
  { name: 'Spotify', home: 'https://open.spotify.com/', signin: 'https://accounts.spotify.com/en/login' },
  { name: 'Disney+', home: 'https://www.disneyplus.com/', signin: 'https://www.disneyplus.com/login' },
  { name: 'Prime Video', home: 'https://www.primevideo.com/', signin: 'https://www.amazon.com/gp/video/storefront' },
  { name: 'HBO Max', home: 'https://www.hbomax.com/', signin: 'https://auth.hbomax.com/login' },
  { name: 'Hulu', home: 'https://www.hulu.com/', signin: 'https://auth.hulu.com/web/login' },
  { name: 'Apple Music', home: 'https://music.apple.com/us/browse', signin: null },
  { name: 'Apple TV', home: 'https://tv.apple.com/', signin: null },
  { name: 'Peacock', home: 'https://www.peacocktv.com/', signin: 'https://www.peacocktv.com/signin' },
  { name: 'Paramount+', home: 'https://www.paramountplus.com/', signin: 'https://www.paramountplus.com/account/signin/' },
  { name: 'Tidal', home: 'https://listen.tidal.com/', signin: 'https://login.tidal.com/' },
];

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clicks the page's own sign-in control, if it has one, and says what it clicked. */
const CLICK_SIGN_IN = `(() => {
  const wanted = /^\\s*(sign in|log in|login|sign in to (your )?account)\\s*$/i;
  const all = [...document.querySelectorAll('a, button, [role=button]')];
  const el = all.find((e) => wanted.test(e.textContent || '') && e.offsetParent !== null) || all.find((e) => wanted.test(e.getAttribute('aria-label') || ''));
  if (!el) return null;
  el.click();
  return (el.tagName + ' ' + (el.textContent || el.getAttribute('aria-label') || '').trim()).slice(0, 60);
})()`;

function recorder(ses) {
  const rec = { main: [], redirects: [], frames: new Map(), popups: [], sub: new Map(), blockedByClient: 0 };
  ses.webRequest.onBeforeRequest((details, done) => {
    const host = hostOf(details.url);
    if (details.resourceType === 'mainFrame') rec.main.push(details.url.replace(/\?.*/, '?…'));
    else if (details.resourceType === 'subFrame') rec.frames.set(host, details.url.replace(/\?.*/, '?…').slice(0, 160));
    else if (host) rec.sub.set(host, (rec.sub.get(host) ?? 0) + 1);
    done({});
  });
  ses.webRequest.onBeforeRedirect((details) => {
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')
      rec.redirects.push(`${details.resourceType}: ${hostOf(details.url)} -> ${hostOf(details.redirectURL)} (${details.statusCode})`);
  });
  return rec;
}

function snapshot(rec, win) {
  const frames = win.isDestroyed() ? [] : win.webContents.mainFrame.framesInSubtree.map((f) => hostOf(f.url)).filter(Boolean);
  return {
    finalUrl: win.isDestroyed() ? null : win.webContents.getURL().replace(/\?.*/, '?…'),
    title: win.isDestroyed() ? null : win.webContents.getTitle(),
    mainFrameRequests: [...rec.main],
    mainFrameHosts: [...new Set(rec.main.map(hostOf))],
    redirects: [...rec.redirects],
    subFrameRequests: Object.fromEntries(rec.frames),
    framesNow: [...new Set(frames)],
    popups: [...rec.popups],
    subresourceHosts: Object.fromEntries([...rec.sub].sort((a, b) => b[1] - a[1])),
  };
}

function reset(rec) {
  rec.main.length = 0;
  rec.redirects.length = 0;
  rec.frames.clear();
  rec.popups.length = 0;
  rec.sub.clear();
}

async function survey(service) {
  const ses = session.fromPartition(`census-${service.name}`, { cache: false });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const rec = recorder(ses);
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  const popupWindows = [];
  const watchOpen = (contents) =>
    contents.setWindowOpenHandler(({ url, disposition }) => {
      rec.popups.push(`${disposition}: ${url.replace(/\?.*/, '?…').slice(0, 160)}`);
      return { action: 'allow', overrideBrowserWindowOptions: { show: true, webPreferences: { session: ses, sandbox: true } } };
    });
  watchOpen(win.webContents);
  win.webContents.on('did-create-window', (child) => {
    popupWindows.push(child);
    watchOpen(child.webContents);
  });
  const result = { name: service.name, steps: [] };
  const step = async (label, run) => {
    reset(rec);
    let note;
    try {
      note = await run();
    } catch (error) {
      note = `error: ${error.message}`;
    }
    await sleep(settle);
    const popups = popupWindows.filter((w) => !w.isDestroyed()).map((w) => w.webContents.getURL().replace(/\?.*/, '?…'));
    result.steps.push({ label, note, ...snapshot(rec, win), popupWindowUrls: popups });
    console.log(`[census] ${service.name} · ${label}: ${win.isDestroyed() ? '-' : win.webContents.getURL().slice(0, 100)}`);
  };
  await step('home', () => win.loadURL(service.home).then(() => null, (e) => `load: ${e.code ?? e.message}`));
  await step('click sign-in', () => win.webContents.executeJavaScript(CLICK_SIGN_IN, true).then((clicked) => clicked ?? 'no sign-in control found'));
  if (service.signin) await step('sign-in page', () => win.loadURL(service.signin).then(() => null, (e) => `load: ${e.code ?? e.message}`));
  for (const w of popupWindows) if (!w.isDestroyed()) w.destroy();
  win.destroy();
  await ses.clearStorageData();
  return result;
}

app.userAgentFallback = chromiumUserAgent(app.userAgentFallback, app.getName());
app.on('window-all-closed', () => {});
// Not awaited at the top level: Electron emits ready only after the entry module has finished.
void main();
async function main() {
await app.whenReady();
mkdirSync(out, { recursive: true });
const results = { electron: process.versions.electron, chrome: process.versions.chrome, userAgent: app.userAgentFallback, when: new Date().toISOString(), services: [] };
for (const service of SERVICES.filter((s) => !only?.length || only.includes(s.name))) {
  results.services.push(await survey(service));
  writeFileSync(join(out, 'census.json'), JSON.stringify(results, null, 2));
}
console.log(`[census] done: ${join(out, 'census.json')}`);
app.exit(0);
}
