// Spike S9, step 2: load real Chrome Web Store extensions into a persistent
// session, Chord-style (BaseWindow + WebContentsView tabs), and record what
// works. Never shows a window: views live in a hidden BaseWindow with
// backgroundThrottling off, which keeps pages "visible" to the Page
// Visibility API.
//
// Nothing here may wait on the user: main-process errors are logged as JSON
// and end the run (Electron would otherwise show a modal error box), page
// dialogs are disabled, and beforeunload never blocks a close.
//
// Run through run.mjs (it sets up logging and collects results):
//   node spikes/s9-extensions/run.mjs
// Args: <mode: builtin|lib|fork> <userData dir> <results file> <port>
import { app, BaseWindow, BrowserWindow, net, protocol, session, WebContentsView } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

function fatal(kind, error) {
  console.log(JSON.stringify({ s9Fatal: kind, error: String(error?.stack ?? error) }));
  try {
    finish({ ok: false, fatal: kind, error: String(error?.stack ?? error) }, 1);
  } catch {
    app.exit(1);
  }
}
process.on('uncaughtException', (error) => fatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-prevent-unload', (event) => event.preventDefault());
});
// No window may appear on the desktop: not ours, not the library's popup
// windows, not one an extension asks for through chrome.windows.
for (const method of ['show', 'showInactive', 'focus', 'maximize', 'setFullScreen']) {
  BaseWindow.prototype[method] = function () {};
  if (Object.hasOwn(BrowserWindow.prototype, method)) BrowserWindow.prototype[method] = function () {};
}

const [mode = 'builtin', userData, outFile, portArg = '47391'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PORT = Number(portArg);
const here = import.meta.dirname;
const extRoot = join(here, '.cache', 'ext');
const fetched = JSON.parse(readFileSync(join(here, 'results', 'fetch.json'), 'utf8')).filter((x) => x.ok);

const UBOL = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const DARK_READER = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';

if (userData) app.setPath('userData', userData);
// Point ad/tracker hosts at the local server: a request that reaches it was not blocked.
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP s9.test 127.0.0.1, MAP *.s9.test 127.0.0.1, MAP *.doubleclick.net 127.0.0.1, MAP *.googlesyndication.com 127.0.0.1, MAP *.adnxs.com 127.0.0.1',
);
protocol.registerSchemesAsPrivileged([{ scheme: 's9ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const results = {
  mode,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: `${process.platform}-${process.arch}`,
  startedAt: new Date().toISOString(),
  extensions: {},
};
const ext = (id) => (results.extensions[id] ??= { swConsole: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

// ---- Local test server -------------------------------------------------------
const hits = [];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>S9 test page</title></head>
<body style="background:#ffffff;color:#000000">
<h1>Chord S9</h1><p>Plain text for Dark Reader to theme.</p>
<form action="/login" method="post"><input type="email" name="username" autocomplete="username">
<input type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>
<ins class="adsbygoogle" id="ad_slot" style="display:block;width:300px;height:50px">ad slot</ins>
<script src="/page.js"></script></body></html>`;
const PAGE_JS = `
window.__s9 = { probes: {}, done: false };
const probes = {
  doubleclick: 'http://securepubads.g.doubleclick.net:${PORT}/tag/js/gpt.js',
  adsense: 'http://pagead2.googlesyndication.com:${PORT}/pagead/js/adsbygoogle.js',
  adnxs: 'http://ib.adnxs.com:${PORT}/ut/v3/prebid',
  dynamicRuleTarget: 'http://tracker.s9.test:${PORT}/pixel.js',
  control: 'http://cdn.s9.test:${PORT}/lib.js',
};
(async () => {
  for (const [k, u] of Object.entries(probes)) {
    try { await fetch(u, { mode: 'no-cors', cache: 'no-store' }); window.__s9.probes[k] = 'loaded'; }
    catch (e) { window.__s9.probes[k] = 'failed: ' + e.message; }
  }
  window.__s9.done = true;
})();`;
const server = createServer((req, res) => {
  hits.push(`${req.headers.host}${req.url}`);
  if (req.url === '/page.html' || req.url === '/ui.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(req.url === '/ui.html' ? '<!doctype html><title>Chord UI stand-in</title><p>shell</p>' : PAGE);
  }
  if (req.url === '/page.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(PAGE_JS);
  }
  res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
  res.end('/* ok */');
});
server.listen(PORT, '127.0.0.1');
const BASE = `http://s9.test:${PORT}`;

// ---- Helpers -----------------------------------------------------------------
const within = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no answer in ${ms} ms`)), ms))]);
const webPrefs = (ses, extra = {}) => ({
  session: ses,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false,
  disableDialogs: true, // alert/confirm from a page would otherwise open a native box
  ...extra,
});

/** Attach CDP to record isolated worlds (content scripts) and blocked requests. */
async function instrument(contents) {
  // CDP commands sent before the first navigation never resolve; start from about:blank.
  await contents.loadURL('about:blank');
  const seen = { isolated: [], failed: [], redirected: [] };
  const urls = new Map();
  contents.debugger.attach('1.3');
  contents.debugger.on('message', (_e, method, params) => {
    if (method === 'Runtime.executionContextCreated') {
      const c = params.context;
      if (c.auxData?.type === 'isolated') seen.isolated.push({ origin: c.origin, name: c.name });
    } else if (method === 'Network.requestWillBeSent') {
      urls.set(params.requestId, params.request.url);
      if (params.redirectResponse) seen.redirected.push({ from: params.redirectResponse.url, to: params.request.url });
    } else if (method === 'Network.loadingFailed') {
      seen.failed.push({ url: urls.get(params.requestId), error: params.errorText, blockedReason: params.blockedReason ?? null });
    }
  });
  await within(contents.debugger.sendCommand('Runtime.enable'), 5000, 'Runtime.enable');
  await within(contents.debugger.sendCommand('Network.enable'), 5000, 'Network.enable');
  return seen;
}

function collectConsole(contents, sink) {
  contents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      if (sink.length < 15) sink.push(`${details.level}: ${short(details.message, 240)}`);
    }
  });
}

async function waitFor(fn, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep polling
    }
    await sleep(step);
  }
  return null;
}

// Runs inside an extension page (popup/options), which has the full chrome.* surface.
const PAGE_PROBE = (extra) => `(async () => {
  const r = { url: location.href, visibility: document.visibilityState, title: document.title,
              textLength: (document.body && document.body.innerText || '').length,
              namespaces: typeof chrome === 'object' ? Object.keys(chrome).sort() : null };
  const short = (v) => { try { const s = JSON.stringify(v); return s && s.length > 200 ? s.slice(0, 200) + '…' : s; } catch { return String(v); } };
  const call = async (label, fn) => {
    try {
      const v = await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 3s')), 3000))]);
      r[label] = { ok: true, value: short(v) };
    } catch (e) { r[label] = { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
  };
  await call('tabs.query(active,currentWindow)', () => chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t.map((x) => ({ id: x.id, url: x.url, windowId: x.windowId }))));
  await call('tabs.query(all)', () => chrome.tabs.query({}).then((t) => t.map((x) => x.id)));
  await call('windows.getCurrent', () => chrome.windows.getCurrent());
  await call('action.setBadgeText', () => chrome.action.setBadgeText({ text: 's9' }));
  await call('storage.local.get', () => chrome.storage.local.get(null).then((x) => Object.keys(x).length + ' keys'));
  await call('storage.sync.get', () => chrome.storage.sync.get(null).then((x) => Object.keys(x).length + ' keys'));
  await call('storage.session.get', () => chrome.storage.session.get(null).then((x) => Object.keys(x).length + ' keys'));
  await call('commands.getAll', () => chrome.commands.getAll());
  await call('i18n.getUILanguage', () => chrome.i18n.getUILanguage());
  await call('permissions.getAll', () => chrome.permissions.getAll());
  await call('runtime.connectNative is a function', () => { if (typeof chrome.runtime.connectNative !== 'function') throw new Error('missing'); return true; });
  ${extra ?? ''}
  return r;
})()`;

/**
 * Two tiny generated extensions, identical except for the service worker type,
 * that report which chrome.* namespaces their worker sees and which lifecycle
 * events fire. Real extensions can't be inspected from inside the worker.
 */
function writeProbeExtensions(dir) {
  const paths = {};
  for (const type of ['classic', 'module']) {
    const root = join(dir, `s9-probe-${type}`);
    mkdirSync(root, { recursive: true });
    const manifest = {
      manifest_version: 3,
      name: `S9 probe (${type} worker)`,
      version: '1.0',
      background: type === 'module' ? { service_worker: 'sw.js', type: 'module' } : { service_worker: 'sw.js' },
      permissions: ['contextMenus', 'storage', 'tabs'],
      action: {},
      commands: { 'probe-command': { description: 'S9 probe command' } },
      // Password managers draw inline menus as extension iframes inside web pages.
      web_accessible_resources: [{ resources: ['frame.html'], matches: ['<all_urls>'] }],
    };
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(root, 'frame.html'), '<!doctype html><meta charset="utf-8"><title>s9 frame</title><script src="frame.js"></script>');
    writeFileSync(
      join(root, 'frame.js'),
      `window.__probe = (async () => {
  const sw = navigator.serviceWorker;
  const r = { top: top === self, secureContext: isSecureContext, controller: Boolean(sw && sw.controller) };
  r.registrations = sw ? (await sw.getRegistrations()).length : 'no navigator.serviceWorker';
  r.ready = sw ? await Promise.race([sw.ready.then(() => 'resolved'), new Promise((res) => setTimeout(() => res('timeout 2s'), 2000))]) : 'n/a';
  r.runtimeMessage = await new Promise((res) => {
    try { chrome.runtime.sendMessage({ s9: 'ping' }, (reply) => res(chrome.runtime.lastError ? 'error: ' + chrome.runtime.lastError.message : reply)); }
    catch (e) { res('threw: ' + e.message); }
  });
  return r;
})();`,
    );
    writeFileSync(
      join(root, 'sw.js'),
      `const report = (what) => console.warn('S9PROBE ' + JSON.stringify(what));
report({ stage: 'top', windows: typeof chrome.windows, windowIdNone: chrome.windows && chrome.windows.WINDOW_ID_NONE, commands: typeof chrome.commands,
  contextMenus: typeof chrome.contextMenus, webNavigation: typeof chrome.webNavigation, action: typeof chrome.action, tabsCreate: typeof (chrome.tabs && chrome.tabs.create),
  notifications: typeof chrome.notifications, cookies: typeof chrome.cookies, offscreen: typeof chrome.offscreen, sidePanel: typeof chrome.sidePanel,
  browserNamespace: typeof self.browser, browserIsChrome: self.browser === self.chrome,
  browserWindows: typeof (self.browser && self.browser.windows), browserCommands: typeof (self.browser && self.browser.commands) });
chrome.runtime.onInstalled.addListener((d) => report({ stage: 'onInstalled', reason: d.reason }));
chrome.runtime.onMessage.addListener((m, _sender, reply) => { if (m && m.s9 === 'ping') reply('pong'); });
chrome.runtime.onStartup.addListener(() => report({ stage: 'onStartup' }));
try {
  chrome.contextMenus.create({ id: 's9-${type}', title: 'S9 probe item (${type})', contexts: ['all'] }, () => report({ stage: 'menuCreated', lastError: chrome.runtime.lastError && chrome.runtime.lastError.message }));
} catch (e) { report({ stage: 'menuThrew', error: String(e && e.message || e) }); }
`,
    );
    paths[type] = root;
  }
  return paths;
}

const PERMISSION_API = {
  alarms: 'alarms', contextMenus: 'contextMenus', cookies: 'cookies', declarativeNetRequest: 'declarativeNetRequest',
  declarativeNetRequestWithHostAccess: 'declarativeNetRequest', downloads: 'downloads', fontSettings: 'fontSettings',
  idle: 'idle', management: 'management', notifications: 'notifications', offscreen: 'offscreen', privacy: 'privacy',
  scripting: 'scripting', sidePanel: 'sidePanel', storage: 'storage', tabs: 'tabs', userScripts: 'userScripts',
  webNavigation: 'webNavigation', webRequest: 'webRequest',
};

// ---- Main --------------------------------------------------------------------
async function run() {
  const ses = session.fromPartition('persist:s9');
  const win = new BaseWindow({ show: false, width: 1280, height: 800 });
  const views = [];
  const addView = (view, bounds = { x: 0, y: 0, width: 1280, height: 800 }) => {
    win.contentView.addChildView(view);
    view.setBounds(bounds);
    views.push(view);
    return view;
  };

  // Service worker console output, attributed to extensions by scope.
  const scopeOf = new Map();
  const probeIds = new Map();
  results.probeWorkers = {};
  ses.serviceWorkers.on('console-message', (_e, d) => {
    const info = (() => {
      try {
        return ses.serviceWorkers.getInfoFromVersionID(d.versionId);
      } catch {
        return null;
      }
    })();
    const id = (info?.scope ?? d.sourceUrl ?? '').match(/^chrome-extension:\/\/([a-p]{32})/)?.[1];
    if (id) scopeOf.set(d.versionId, id);
    if (d.message.startsWith('S9PROBE ')) {
      const type = probeIds.get(id) ?? id;
      (results.probeWorkers[type] ??= []).push(JSON.parse(d.message.slice(8)));
      return;
    }
    if (!id || d.level < 2) return;
    const sink = ext(id).swConsole;
    if (sink.length < 15) sink.push(`${d.level === 3 ? 'error' : 'warning'}: ${short(d.message, 240)} (${(d.sourceUrl ?? '').split('/').pop()}:${d.lineNumber})`);
  });

  // Library mode: electron-chrome-extensions must be set up before extensions load.
  let lib = null;
  const created = [];
  if (mode === 'lib' || mode === 'fork') {
    // lib: electron-chrome-extensions from npm. fork: the iamEvanYT fork (@iamevan/…).
    const name = mode === 'fork' ? '@iamevan/electron-chrome-extensions' : 'electron-chrome-extensions';
    const dir = join(here, '.cache', mode === 'fork' ? 'lib-fork' : 'lib');
    const { ElectronChromeExtensions } = createRequire(join(dir, 'package.json'))(name);
    const pkg = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    results.library = { name, version: JSON.parse(readFileSync(pkg, 'utf8')).version };
    lib = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: ses,
      // The fork's scoped name defeats its own preload lookup; point it at the package.
      ...(mode === 'fork' ? { modulePath: dirname(pkg) } : {}),
      async createTab(details) {
        created.push({ api: 'tabs.create', url: details.url ?? null });
        const view = addView(new WebContentsView({ webPreferences: webPrefs(ses) }), { x: 0, y: 0, width: 1, height: 1 });
        lib.addTab(view.webContents, win);
        if (details.url) void view.webContents.loadURL(details.url).catch(() => {});
        return [view.webContents, win];
      },
      selectTab() {},
      removeTab(tab) {
        if (!tab.isDestroyed()) tab.close();
      },
      async createWindow(details) {
        created.push({ api: 'windows.create', url: details.url ?? null, type: details.type ?? null });
        const w = new BaseWindow({ show: false, width: 400, height: 600 });
        return w;
      },
      removeWindow(w) {
        w.destroy();
      },
    });
    results.library.preloadScripts = ses.getPreloadScripts().map((p) => ({ id: p.id, type: p.type }));
  }

  // Electron #54685: session.fetch breaks once a webRequest/DNR extension loads. Chord's favicons use it.
  const sessionFetch = () =>
    within(ses.fetch(`${BASE}/fetch-check`, { cache: 'no-store' }), 8000, 'session.fetch').then(
      (r) => `status ${r.status}`,
      (e) => `failed: ${e.message}`,
    );
  results.sessionFetch = { beforeExtensions: await sessionFetch() };

  // The two generated probe extensions first, then every fetched extension.
  for (const [type, path] of Object.entries(writeProbeExtensions(app.getPath('userData')))) {
    try {
      const loaded = await ses.extensions.loadExtension(path);
      probeIds.set(loaded.id, type);
    } catch (error) {
      results.probeWorkers[type] = [{ loadError: short(String(error?.message ?? error)) }];
    }
  }
  for (const f of fetched) {
    const e = ext(f.id);
    e.name = f.label;
    e.version = f.version;
    const t = performance.now();
    try {
      const loaded = await ses.extensions.loadExtension(join(extRoot, f.id), { allowFileAccess: false });
      e.loaded = loaded.id === f.id;
      e.loadMs = Math.round(performance.now() - t);
    } catch (error) {
      e.loaded = false;
      e.loadError = short(String(error?.message ?? error));
    }
  }
  results.loadedCount = ses.extensions.getAllExtensions().length - probeIds.size;

  // Wait for each MV3 service worker to be running.
  const swRunning = () => Object.values(ses.serviceWorkers.getAllRunning()).map((w) => w.scope);
  await waitFor(() => fetched.every((f) => swRunning().some((s) => s.includes(f.id))), 20_000, 250);
  for (const f of fetched) ext(f.id).serviceWorkerRunning = swRunning().some((s) => s.includes(f.id));
  await sleep(4000); // let first-run work (rulesets, settings, welcome tabs) settle
  results.sessionFetch.afterExtensions = await sessionFetch();
  results.sessionFetch.netRequestWithSession = await within(
    new Promise((resolve) => {
      const req = net.request({ url: `${BASE}/fetch-check`, session: ses });
      req.on('response', (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(`status ${res.statusCode}`));
      });
      req.on('error', (e) => resolve(`failed: ${e.message}`));
      req.end();
    }),
    8000,
    'net.request',
  ).catch((e) => `failed: ${e.message}`);

  // ---- A browsing tab -------------------------------------------------------
  results.stage = 'tab';
  /** Open the test page in a new tab and report what the extensions did to it. */
  async function testPage() {
    const tab = addView(new WebContentsView({ webPreferences: webPrefs(ses) }));
    const seen = await instrument(tab.webContents);
    if (lib) {
      lib.addTab(tab.webContents, win);
      lib.selectTab(tab.webContents);
    }
    hits.length = 0;
    await within(tab.webContents.loadURL(`${BASE}/page.html`), 15_000, 'test page');
    await waitFor(() => tab.webContents.executeJavaScript('window.__s9 && window.__s9.done'), 10_000);
    await sleep(4000); // Dark Reader and uBOL cosmetic filtering apply asynchronously
    const page = await tab.webContents.executeJavaScript(`({
      probes: window.__s9.probes,
      visibility: document.visibilityState,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      darkReaderStyles: document.querySelectorAll('style.darkreader').length,
      adSlotDisplay: getComputedStyle(document.getElementById('ad_slot')).display,
    })`);
    page.serverHits = hits.filter((h) => !h.startsWith(`s9.test:${PORT}/page`)).map((h) => h.replace(`:${PORT}`, ''));
    page.cdpFailed = seen.failed.map((f) => ({ url: f.url?.replace(`:${PORT}`, ''), error: f.error, blockedReason: f.blockedReason }));
    page.cdpRedirected = seen.redirected.map((r) => ({ from: r.from.replace(`:${PORT}`, ''), to: r.to }));
    page.contentScriptWorlds = Object.fromEntries(
      fetched.map((f) => [f.label, seen.isolated.filter((c) => c.origin === `chrome-extension://${f.id}`).length]),
    );
    return { tab, page };
  }
  const { tab, page } = await testPage();
  results.page = page;
  for (const f of fetched) ext(f.id).contentScriptWorlds = page.contentScriptWorlds[f.label];

  // ---- Chord UI stand-in: in-memory session, like chord-ui ------------------
  results.stage = 'ui';
  const ui = session.fromPartition('s9-ui');
  ui.protocol.handle('s9ui', () => new Response('<!doctype html><title>chord ui</title>', { headers: { 'content-type': 'text/html' } }));
  try {
    await ui.extensions.loadExtension(join(extRoot, DARK_READER));
    results.inMemorySessionLoad = 'loaded (unexpected)';
  } catch (error) {
    results.inMemorySessionLoad = `refused: ${short(String(error?.message ?? error), 160)}`;
  }
  const uiView = addView(new WebContentsView({ webPreferences: webPrefs(ui) }), { x: 0, y: 0, width: 300, height: 800 });
  const uiSeen = await instrument(uiView.webContents);
  // Worst case: Chord's dev build serves its UI over http://localhost, a URL extensions may script.
  await uiView.webContents.loadURL(`${BASE}/ui.html`);
  await sleep(1500);

  // ---- Extension pages: popups and options ------------------------------------
  results.stage = 'extension pages';
  const popupOf = new Map(fetched.filter((f) => f.action?.default_popup).map((f) => [f.id, f.action.default_popup.replace(/^\//, '')]));
  for (const f of fetched) {
    const e = ext(f.id);
    const manifest = JSON.parse(readFileSync(join(extRoot, f.id, 'manifest.json'), 'utf8'));
    const pages = [];
    if (popupOf.has(f.id)) pages.push(['popup', popupOf.get(f.id)]);
    const opts = manifest.options_ui?.page ?? manifest.options_page;
    if (opts && opts !== popupOf.get(f.id)) pages.push(['options', opts.replace(/^\//, '')]);
    for (const [kind, path] of pages) {
      const view = addView(new WebContentsView({ webPreferences: webPrefs(ses, { enablePreferredSizeMode: kind === 'popup' }) }), { x: 900, y: 40, width: 360, height: 600 });
      const errors = [];
      collectConsole(view.webContents, errors);
      let preferred = null;
      view.webContents.on('preferred-size-changed', (_ev, size) => (preferred = size));
      let extra = '';
      if (f.id === UBOL) {
        extra = `
        await call('dnr.getEnabledRulesets', () => chrome.declarativeNetRequest.getEnabledRulesets());
        await call('dnr.getAvailableStaticRuleCount', () => chrome.declarativeNetRequest.getAvailableStaticRuleCount());
        await call('dnr.getDynamicRules', () => chrome.declarativeNetRequest.getDynamicRules().then((x) => x.length + ' rules'));
        await call('scripting.getRegisteredContentScripts', () => chrome.scripting.getRegisteredContentScripts().then((x) => x.length + ' scripts'));`;
        if (kind === 'popup') {
          // Stage 2: is the DNR engine itself working? Enable uBOL's default rulesets the way its
          // service worker would, and add one dynamic rule for a host no list knows about.
          extra += `
        await call('dnr.updateEnabledRulesets(defaults)', () => chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ${JSON.stringify(
          fetched.find((x) => x.id === UBOL).dnrRulesets.filter((x) => x.enabled).map((x) => x.id),
        )} }).then(() => chrome.declarativeNetRequest.getEnabledRulesets()));
        await call('dnr.updateDynamicRules(block tracker.s9.test)', () => chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 9001, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||tracker.s9.test^', resourceTypes: ['xmlhttprequest', 'script', 'image', 'other'] } }] }).then(() => chrome.declarativeNetRequest.getDynamicRules()).then((x) => x.length + ' rules'));`;
        }
      }
      if (f.id !== UBOL && f.dnrRulesets?.length) {
        // Rulesets marked "enabled" in the manifest: does Electron turn them on at load?
        extra += `
        await call('dnr.getEnabledRulesets', () => chrome.declarativeNetRequest.getEnabledRulesets());`;
      }
      if (f.id === DARK_READER && kind === 'popup') {
        const ids = { tab: tab.webContents.id, ui: uiView.webContents.id };
        extra = `
        await call('xs.scripting.executeScript(browsing tab)', () => chrome.scripting.executeScript({ target: { tabId: ${ids.tab} }, func: () => document.title }).then((x) => x.map((y) => y.result)));
        await call('xs.scripting.executeScript(UI view)', () => chrome.scripting.executeScript({ target: { tabId: ${ids.ui} }, func: () => document.title }).then((x) => x.map((y) => y.result)));
        await call('xs.tabs.get(UI view)', () => chrome.tabs.get(${ids.ui}));
        await call('xs.tabs.update(UI view, url)', () => chrome.tabs.update(${ids.ui}, { url: '${BASE}/hijacked' }));
        await call('xs.tabs.sendMessage(UI view)', () => chrome.tabs.sendMessage(${ids.ui}, { s9: true }));
        await call('xs.fetch(s9ui://)', () => fetch('s9ui://app/').then((r) => r.status));`;
      }
      const t = performance.now();
      try {
        await within(view.webContents.loadURL(`chrome-extension://${f.id}/${path}`), 10_000, 'load');
        await sleep(kind === 'popup' ? 2500 : 1500);
        const probe = await within(view.webContents.executeJavaScript(PAGE_PROBE(extra)), 60_000, 'probe');
        const missing = [...new Set([...(manifest.permissions ?? [])].map((p) => PERMISSION_API[p]).filter(Boolean))].filter(
          (ns) => !probe.namespaces?.includes(ns),
        );
        if (manifest.action && !probe.namespaces?.includes('action')) missing.push('action');
        if (manifest.commands && !probe.namespaces?.includes('commands')) missing.push('commands');
        e[kind] = { loaded: true, ms: Math.round(performance.now() - t), preferredSize: preferred, consoleErrors: errors, missingApis: missing, probe };
      } catch (error) {
        e[kind] = { loaded: false, error: short(String(error?.message ?? error)), consoleErrors: errors };
      }
      win.contentView.removeChildView(view);
      view.webContents.close();
    }
  }
  results.uiViewAfterExtensionCalls = {
    url: uiView.webContents.getURL().replace(`:${PORT}`, ''),
    title: uiView.webContents.getTitle(),
    contentScriptWorlds: uiSeen.isolated.length,
  };
  // An extension page as a top-level view vs. as an iframe inside a web page (upstream #185).
  const probeId = [...probeIds].find(([, type]) => type === 'classic')?.[0];
  if (probeId) {
    const frameUrl = `chrome-extension://${probeId}/frame.html`;
    const top = addView(new WebContentsView({ webPreferences: webPrefs(ses) }), { x: 0, y: 0, width: 200, height: 200 });
    results.extensionFrame = {};
    try {
      await within(top.webContents.loadURL(frameUrl), 10_000, 'frame top-level');
      results.extensionFrame.topLevel = await within(top.webContents.executeJavaScript('window.__probe'), 10_000, 'frame probe');
      // Host page on localhost: a secure context, like the https pages password managers run on.
      const host = addView(new WebContentsView({ webPreferences: webPrefs(ses) }));
      await within(host.webContents.loadURL(`http://localhost:${PORT}/ui.html`), 10_000, 'frame host');
      await host.webContents.executeJavaScript(
        `new Promise((r) => { const f = document.createElement('iframe'); f.src = ${JSON.stringify(frameUrl)}; f.onload = r; document.body.appendChild(f); })`,
      );
      const frames = host.webContents.mainFrame.framesInSubtree;
      // Other extensions inject their own inline UI as iframes too (Proton Pass does).
      results.extensionFrame.extensionIframesInPage = frames.filter((f) => f.url.startsWith('chrome-extension://')).map((f) => f.url.replace(/[#?].*$/, ''));
      const frame = frames.find((f) => f.url === frameUrl);
      await sleep(2500); // the frame's probe needs up to 2 s for its `ready` check
      results.extensionFrame.nestedInWebPage = frame
        ? await within(
            frame.executeJavaScript(
              `(window.__probe ? window.__probe.then((r) => JSON.stringify(r)) : Promise.resolve(JSON.stringify({ href: location.href, probe: typeof window.__probe, readyState: document.readyState, scripts: document.scripts.length })))`,
            ),
            10_000,
            'nested probe',
          ).then((s) => JSON.parse(s))
        : 'frame not found';
    } catch (error) {
      results.extensionFrame.error = short(String(error?.message ?? error));
    }
  }

  results.webPageFetchOfUiScheme = await tab.webContents.executeJavaScript(
    `fetch('s9ui://app/').then((r) => 'status ' + r.status, (e) => 'failed: ' + e.message)`,
  );

  results.stage = 'page after DNR enable';
  results.pageAfterDnrEnable = (await testPage()).page;
  // The same blocked URL, requested from the Chord-UI session: extension rules must not reach it.
  results.uiSessionRequestToBlockedHost = await uiView.webContents.executeJavaScript(
    `fetch('http://tracker.s9.test:${PORT}/pixel.js', { mode: 'no-cors', cache: 'no-store' }).then(() => 'loaded', (e) => 'failed: ' + e.message)`,
  );

  // ---- Library-only: context menus and the library's own popup window ----------
  results.stage = 'library';
  if (lib) {
    const base = { x: 10, y: 10, frame: null, linkURL: '', linkText: '', pageURL: `${BASE}/page.html`, frameURL: '', srcURL: '', mediaType: 'none', hasImageContents: false, isEditable: false, selectionText: '', titleText: '', altText: '', suggestedFilename: '', selectionRect: { x: 0, y: 0, width: 0, height: 0 }, selectionStartOffset: 0, referrerPolicy: { policy: 'default', url: '' }, misspelledWord: '', dictionarySuggestions: [], frameCharset: '', formControlType: 'none', spellcheckEnabled: false, menuSourceType: 'mouse', mediaFlags: {}, editFlags: {} };
    const labels = (items) => items.map((i) => (i.submenu?.items?.length ? `${i.label} › [${i.submenu.items.map((s) => s.label).join(', ')}]` : i.label));
    results.library.contextMenus = {
      page: labels(lib.getContextMenuItems(tab.webContents, { ...base })),
      selection: labels(lib.getContextMenuItems(tab.webContents, { ...base, selectionText: 'hello world' })),
      passwordField: labels(lib.getContextMenuItems(tab.webContents, { ...base, isEditable: true, formControlType: 'input-password' })),
      registered: [...lib.api.contextMenus.menus].map(([id, items]) => ({
        extension: ext(id).name ?? probeIds.get(id) ?? id,
        items: [...items.values()].map((p) => ({ title: p.title, contexts: p.contexts })),
      })),
    };
    // The library opens popups as frameless child BrowserWindows (kept hidden by the patch at the top).
    const popups = {};
    for (const [id] of popupOf) {
      const r = (popups[ext(id).name] = {});
      let popup = null;
      try {
        const createdPopup = new Promise((resolve) => lib.once('browser-action-popup-created', resolve));
        lib.api.browserAction.activateClick({ extensionId: id, tabId: tab.webContents.id, anchorRect: { x: 1200, y: 8, width: 28, height: 28 } });
        popup = await Promise.race([createdPopup, sleep(3000).then(() => null)]);
        if (!popup) throw new Error('no popup created');
        await Promise.race([popup.whenReady(), sleep(5000)]);
        await sleep(1500);
        const wc = popup.browserWindow.webContents;
        r.isChildWindow = popup.browserWindow.getParentWindow() !== null;
        r.bounds = popup.browserWindow.getBounds();
        r.probe = await within(
          wc.executeJavaScript(
            `chrome.tabs.query({active:true,currentWindow:true}).then((t) => ({ url: location.pathname, activeTabUrl: t[0] && t[0].url }), (e) => ({ url: location.pathname, error: e.message }))`,
          ),
          5000,
          'popup probe',
        );
      } catch (error) {
        r.error = short(String(error?.message ?? error));
      } finally {
        if (popup && !popup.isDestroyed()) popup.destroy();
      }
    }
    results.library.popups = popups;
    results.library.tabsCreatedByExtensions = created.map((c) => ({ ...c, url: c.url?.slice(0, 120) ?? null }));
  }

  // ---- Profile isolation: a second persistent session --------------------------
  results.stage = 'other profile';
  const other = session.fromPartition('persist:s9-other');
  const otherTab = addView(new WebContentsView({ webPreferences: webPrefs(other) }));
  const otherSeen = await instrument(otherTab.webContents);
  await otherTab.webContents.loadURL(`${BASE}/page.html`);
  await sleep(2500);
  results.otherProfile = {
    extensionsLoaded: other.extensions.getAllExtensions().length,
    contentScriptWorlds: otherSeen.isolated.length,
    bodyBackground: await otherTab.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'),
  };

  for (const [id, type] of probeIds) {
    if (!results.probeWorkers[id]) continue;
    results.probeWorkers[type] = [...results.probeWorkers[id], ...(results.probeWorkers[type] ?? [])];
    delete results.probeWorkers[id];
  }
  results.serviceWorkersRunningAtEnd = swRunning().map((s) => s.replace(/^chrome-extension:\/\/([a-p]{32})\/$/, (_m, id) => ext(id).name ?? id));
  for (const v of views) if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close();
  win.destroy();
}

function finish(extra, code = 0) {
  Object.assign(results, extra);
  results.finishedAt = new Date().toISOString();
  if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
  else console.log(JSON.stringify(results, null, 2));
  server.close();
  app.exit(code);
}

const watchdog = setTimeout(() => finish({ watchdog: 'timed out after 240 s; partial results' }, 1), 240_000);
app.on('window-all-closed', () => {});
app.whenReady().then(run).then(
  () => {
    clearTimeout(watchdog);
    finish({ ok: true });
  },
  (error) => {
    clearTimeout(watchdog);
    finish({ ok: false, error: String(error?.stack ?? error) });
  },
);
