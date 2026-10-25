/**
 * Chord Player (ARCHITECTURE.md §9, §16 D4; spike S14): a small app on
 * castLabs ECS (Electron with Widevine) that plays the streaming services
 * Chord's stock Electron can't, in a window of its own, and hands every other
 * link back to Chord. Chord starts it, installed per user, and talks to it
 * over the control channel (@chord/player-protocol): Chord opens pages,
 * plays, pauses and mutes; the player reports what plays, links for Chord,
 * Back to Chord, and that it's closing.
 *
 * Started without Chord, it does nothing and exits. It quits when its window
 * closes or Chord goes away: a second engine left idle is a quarter to half
 * a gigabyte for nothing (S14 §8).
 */
import './guard';
import { connect, makeLock, parseTheme, parseUrl, PROTOCOL, rateLimiter, readLaunch, type Launch, type LinkReason, type Lock, type Peer } from '@chord/player-protocol';
import electron, { app, BrowserWindow, Menu, session, type BrowserWindowConstructorOptions } from 'electron';
import { lockContents, lockSession } from './lock';
import { MediaWatch } from './media';
import { chromiumUserAgent } from './user-agent';
import { BAR_URL, registerBarScheme, serveBar } from './bar-protocol';
import { barFiles, PlayerWindow } from './window';

/** Chord's AppUserModelID: the player's window joins Chord's taskbar button on Windows (S14 §2). */
const CHORD_APP_ID = 'com.chordbrowser.Chord';
const CDM_TIMEOUT_MS = 60_000;

// Read before anything else, and before `ready`, so the switches below can still apply. The
// launch line leaves the environment here, before Chromium starts any child process.
const launch = await readLaunch();
if (!launch) {
  console.error('[chord-player] Chord Player starts from Chord.');
  process.exit(64);
}

app.setName('Chord Player');
app.setPath('userData', launch.profile);
if (process.platform === 'win32') app.setAppUserModelId(launch.appUserModelId ?? CHORD_APP_ID);
if (launch.test) {
  // Tests only (a development Chord asked by a test): a local server standing in for a service.
  if (launch.test.hostResolverRules) app.commandLine.appendSwitch('host-resolver-rules', launch.test.hostResolverRules);
  if (launch.test.secureOrigins?.length) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', launch.test.secureOrigins.join(','));
}
app.enableSandbox();
registerBarScheme();
// One player per profile: a second one started on it leaves at once.
if (!app.requestSingleInstanceLock()) process.exit(0);
// Chromium's own user agent, as Chord's (no Electron or app tokens), so services see a Chromium browser.
app.userAgentFallback = chromiumUserAgent(app.userAgentFallback, app.getName());
app.on('window-all-closed', () => app.quit());

// Not awaited: Electron emits `ready` only once the entry module, top-level awaits included, has finished.
void run(launch);

async function run(launch: Launch): Promise<void> {
  await app.whenReady();
  // macOS: the few menu items a window you watch in needs (copy and paste in sign-in forms, full screen, quit).
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'togglefullscreen' }] }, { role: 'windowMenu' }])
      : null,
  );
  const peer = await connect({ path: launch.path }, launch.secret, { protocol: PROTOCOL, app: app.getVersion(), ecs: __ECS_VERSION__, pid: process.pid });
  new Player(peer, launch);
}

class Player {
  private readonly lock: Lock;
  private readonly window: PlayerWindow;
  private readonly media: MediaWatch;
  private cdm: Promise<boolean>;
  private cdmState: 'installing' | 'ready' | 'failed' = 'installing';
  private serviceName = '';
  private readonly handoffs: { url: string; why: LinkReason }[] = [];
  private focusRequests = 0;
  private readonly allowHandoff = rateLimiter(3, 10_000);
  private quitting = false;

  constructor(
    private readonly peer: Peer,
    private readonly launch: Launch,
  ) {
    this.lock = makeLock(undefined, { allowHttp: Boolean(launch.test) });
    const ses = session.fromPartition('persist:player');
    // No spellcheck dictionaries from Google's CDN (ECS downloads one on first use otherwise).
    ses.setSpellCheckerEnabled(false);
    const deps = { lock: this.lock, handoff: (url: string, why: LinkReason) => this.handoff(url, why), popup: () => this.popupOptions(ses) };
    lockSession(ses, deps);
    const files = barFiles(import.meta.dirname);
    const uiSession = session.fromPartition('player-ui');
    serveBar(uiSession, files.renderer);
    this.window = new PlayerWindow({
      session: ses,
      uiSession,
      preload: files.preload,
      barUrl: BAR_URL,
      onBack: () => peer.send('back'),
      onClosed: () => this.quit('closed'),
    });
    lockContents(this.window.page.webContents, deps);
    this.media = new MediaWatch(this.window.page.webContents, {
      service: () => this.serviceName,
      report: (media) => peer.send('media', { ...media }),
      artwork: (data) => peer.send('artwork', { data }),
    });
    this.cdm = this.installCdm();

    peer.on('close', () => this.quit('chord'));
    peer.handle('open', async (m) => this.open(m['url']));
    peer.handle('focus', () => this.focus());
    peer.handle('play', async () => {
      await this.media.play();
      return { playing: this.media.current?.playing ?? false };
    });
    peer.handle('pause', async () => {
      await this.media.pause();
      return { playing: this.media.current?.playing ?? false };
    });
    peer.handle('mute', async (m) => ({ muted: await this.media.mute(m['muted'] === true) }));
    peer.handle('theme', (m) => {
      const theme = parseTheme(m);
      if (theme) this.window.setTheme(theme);
    });
    peer.handle('close', () => {
      setTimeout(() => this.quit('chord'), 20);
      return true;
    });
    peer.handle('debug', () => this.debug());
    peer.handle('test', (m) => this.test(m));
  }

  /** Widevine: the component updater installs the CDM from Google on first use, then checks for updates. */
  private async installCdm(): Promise<boolean> {
    this.peer.send('status', { cdm: 'installing' });
    const components = (electron as unknown as { components?: Electron.Components }).components;
    const ready = components
      ? await Promise.race([components.whenReady().then(() => true, () => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CDM_TIMEOUT_MS))])
      : false;
    this.cdmState = ready ? 'ready' : 'failed';
    this.peer.send('status', { cdm: this.cdmState });
    if (!this.window.destroyed && this.window.barState.status !== 'starting') this.window.update({ status: ready ? 'ready' : 'failed' });
    return ready;
  }

  /** A page Chord asks for: a service's, or refused. The window comes forward either way. */
  private async open(value: unknown): Promise<{ ok: boolean; why?: string }> {
    const url = parseUrl(value);
    const service = url ? this.lock.service(url) : null;
    if (!url || !service) return { ok: false, why: 'not-a-service' };
    this.serviceName = service.name;
    this.window.update({ service: service.name, status: this.cdmState === 'installing' ? 'cdm' : this.cdmState === 'failed' ? 'failed' : 'ready' });
    this.focus();
    // EME needs the CDM in place before the page asks for it.
    const ready = await this.cdm;
    if (!ready) return { ok: false, why: 'cdm' };
    this.window.update({ status: 'ready' });
    void this.window.page.webContents.loadURL(url).catch(() => {});
    return { ok: true };
  }

  private focus(): { focused: boolean } {
    this.focusRequests++;
    // macOS doesn't let a background app take activation unless asked to (S14 §4); this came from your click in Chord.
    if (process.platform === 'darwin') app.focus({ steal: true });
    this.window.focus();
    return { focused: !this.window.destroyed && this.window.window.isFocused() };
  }

  /** A page or popup the lock refused: Chord opens it, a few at most, http(s) only. */
  private handoff(url: string, why: LinkReason): void {
    const target = parseUrl(url);
    if (!target || !this.allowHandoff()) return;
    this.handoffs.push({ url: target, why });
    this.peer.send('link', { url: target, why });
  }

  /** A service's sign-in popup: a small window of the player's, on its session, with the same lock. */
  private popupOptions(ses: Electron.Session): BrowserWindowConstructorOptions {
    return { width: 520, height: 700, autoHideMenuBar: true, webPreferences: { session: ses, sandbox: true, contextIsolation: true, spellcheck: false } };
  }

  private quit(why: 'closed' | 'chord'): void {
    if (this.quitting) return;
    this.quitting = true;
    this.media.stop();
    if (why === 'closed') this.peer.send('bye', { why });
    // A moment for the goodbye to leave, then out.
    setTimeout(() => app.quit(), why === 'closed' ? 50 : 0);
  }

  /* ---------- Tests only: refused unless Chord launched the player for a test ---------- */

  private async debug(): Promise<unknown> {
    if (!this.launch.test) throw new Error('not launched for tests');
    const page = this.window.page.webContents;
    const video = await Promise.race([
      page
        .executeJavaScript(
          `(() => { const v = document.querySelector('video'); return v ? { currentTime: v.currentTime, paused: v.paused, muted: v.muted, readyState: v.readyState, width: v.videoWidth, height: v.videoHeight, error: v.error ? v.error.code : null, frames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null } : null; })()`,
        )
        .catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    const win = this.window.window;
    return {
      url: page.getURL(),
      video,
      muted: page.isAudioMuted(),
      cdm: this.cdmState,
      focused: win.isFocused(),
      visible: win.isVisible(),
      focusRequests: this.focusRequests,
      handoffs: this.handoffs,
      bar: this.window.barState,
      windows: BrowserWindow.getAllWindows().length,
    };
  }

  private async test(m: Record<string, unknown>): Promise<unknown> {
    if (!this.launch.test) throw new Error('not launched for tests');
    const page = this.window.page.webContents;
    switch (m['do']) {
      case 'navigate-page':
        // The page itself moving on, as a link it follows would.
        await page.executeJavaScript(`location.assign(${JSON.stringify(String(m['url']))})`, true);
        return true;
      case 'popup':
        await page.executeJavaScript(`void window.open(${JSON.stringify(String(m['url']))}, '_blank')`, true);
        return true;
      case 'back':
        // The bar's own button, clicked in the bar's page.
        await this.window.bar.webContents.executeJavaScript(`document.querySelector('[data-action="back"]').click()`, true);
        return true;
      case 'capture':
        return (await this.window.capture()).toString('base64');
      case 'close-window':
        this.window.close();
        return true;
      default:
        throw new Error('unknown test action');
    }
  }
}
