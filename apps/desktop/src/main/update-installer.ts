/**
 * In-app updates on Windows (the per-user installer) and the Linux AppImage
 * (ARCHITECTURE.md §14.4). When the update check (updates.ts) finds a newer
 * release, this downloads it in the background, but only once the release's
 * manifest passes Chord's Ed25519 check (update-signing.ts). electron-updater
 * then checks the download against the manifest's sha512, and "Restart to
 * update" installs it and reopens Chord.
 *
 * macOS (unsigned apps can't update in place, and signed ones need a Mac
 * updater that isn't built: docs/releasing/signing.md), the .deb and .rpm
 * (their package managers should update them), copies run from an unpacked
 * folder, and any build without the signing key stay notify-only.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, session } from 'electron';
import { autoUpdater, Provider, type AppUpdater, type ProgressInfo, type ResolvedUpdateFileInfo, type UpdateInfo } from 'electron-updater';
import { NET_SESSION_NAME } from 'electron-updater/out/electronHttpExecutor';
import { parseUpdateInfo, resolveFiles, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { proxies } from './proxy';
import type { Release } from './releases';
import { UPDATE_PUBLIC_KEY } from './update-key';
import { RELEASE_DOWNLOADS, downloadsFor, manifestFor, signatureFile, verifyManifest } from './update-signing';

interface ChordFeed {
  provider: 'custom';
  updateProvider: typeof SignedReleaseProvider;
  /** The release's download folder. */
  downloads: string;
  manifest: string;
  publicKey: string;
}

/** Reads one release's manifest and refuses it unless it's signed with Chord's update key. */
class SignedReleaseProvider extends Provider<UpdateInfo> {
  constructor(
    private readonly feed: ChordFeed,
    _updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    // GitHub's downloads answer one byte range per request, as electron-updater's own GitHub provider assumes.
    super({ ...runtimeOptions, isUseMultipleRangeRequest: false });
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const url = new URL(this.feed.manifest, this.feed.downloads);
    const [manifest, signature] = await Promise.all([this.httpRequest(url), this.httpRequest(new URL(signatureFile(this.feed.manifest), this.feed.downloads))]);
    if (!manifest || !signature || !verifyManifest(manifest, signature, this.feed.publicKey)) {
      throw new Error(`${this.feed.manifest} isn't signed with Chord's update key`);
    }
    return parseUpdateInfo(manifest, this.feed.manifest, url);
  }

  resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
    return resolveFiles(info, new URL(this.feed.downloads));
  }
}

export class UpdateInstaller {
  private readonly manifest = manifestFor(process.platform, process.arch);
  /** Development and E2E only: a test key and a local download folder. */
  private readonly publicKey = app.isPackaged ? UPDATE_PUBLIC_KEY : (process.env['CHORD_UPDATE_PUBLIC_KEY'] ?? '');
  private readonly downloads = app.isPackaged ? RELEASE_DOWNLOADS : process.env['CHORD_UPDATE_DOWNLOADS'];
  private updater: AppUpdater | null = null;
  private readyVersion: string | null = null;

  /** Whether this copy installs updates itself (otherwise it only says a new version is out). */
  readonly supported: boolean = Boolean(this.manifest && this.publicKey.trim() && this.downloads) && this.installable();

  /** The version waiting for a restart, if any. */
  get ready(): string | null {
    return this.readyVersion;
  }

  /** Download and verify a release in the background. Resolves when it's ready to install; rejects if it can't be. */
  async prepare(release: Release, onProgress: (percent: number) => void): Promise<void> {
    if (!this.supported) throw new Error('This copy of Chord can’t install updates itself');
    if (this.readyVersion === release.version) return;
    const updater = this.configure();
    const feed: ChordFeed = {
      provider: 'custom',
      updateProvider: SignedReleaseProvider,
      downloads: downloadsFor(release.tag, this.downloads),
      manifest: this.manifest!,
      publicKey: this.publicKey,
    };
    updater.setFeedURL(feed as unknown as Parameters<AppUpdater['setFeedURL']>[0]);
    const progress = (info: ProgressInfo) => onProgress(Math.round(info.percent));
    updater.on('download-progress', progress);
    try {
      // electron-updater downloads through a session of its own, made here first so the proxy for every chord is in
      // place before its first request (otherwise it would make it lazily, and ask at once).
      await proxies.ready(session.fromPartition(NET_SESSION_NAME, { cache: false }));
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable || !result.downloadPromise) throw new Error(`Release ${release.tag} has no update for this build`);
      await result.downloadPromise;
      this.readyVersion = release.version;
    } finally {
      updater.off('download-progress', progress);
    }
  }

  /** Quit, install the downloaded update, and reopen Chord. Development builds stop at "ready": their download is a test file. */
  restart(): void {
    if (app.isPackaged && this.readyVersion && this.updater) this.updater.quitAndInstall(true, true);
  }

  /** An installed copy: the Windows installer's uninstaller sits beside Chord.exe; an AppImage says where it is. */
  private installable(): boolean {
    if (!app.isPackaged) return process.platform === 'win32'; // E2E stops at "ready", so nothing is installed
    if (process.platform === 'win32') return existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`));
    return process.platform === 'linux' && Boolean(process.env['APPIMAGE']);
  }

  private configure(): AppUpdater {
    if (this.updater) return this.updater;
    const updater = autoUpdater;
    updater.autoDownload = true;
    // An update that's ready also installs when you quit, as in Chrome (never in development, whose download is a test file).
    updater.autoInstallOnAppQuit = app.isPackaged;
    // Only the blocks that changed are downloaded (the installer's .blockmap; an AppImage carries its
    // own). What they make is still checked against the signed manifest's SHA-512, and anything that
    // goes wrong falls back to the whole file. The web installer isn't used.
    updater.disableDifferentialDownload = false;
    updater.disableWebInstaller = true;
    updater.logger = null;
    // electron-updater reports failures as 'error' events too; prepare() already rejects with them.
    updater.on('error', () => undefined);
    if (!app.isPackaged) {
      // Development reads its config from a file it names itself; this one only names the download cache.
      const config = join(app.getPath('userData'), 'dev-app-update.yml');
      writeFileSync(config, 'provider: generic\nurl: http://127.0.0.1/\nupdaterCacheDirName: chord-dev-updater\n');
      updater.forceDevUpdateConfig = true;
      updater.updateConfigPath = config;
    }
    this.updater = updater;
    return updater;
  }
}
