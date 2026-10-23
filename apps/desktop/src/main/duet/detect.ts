/**
 * Finding the user's own Claude Code and Codex (ARCHITECTURE.md §11.1,
 * docs/research/duet.md §1.7, §3.5, §4.3–4.4). Chord spawns only real
 * executables with shell:false (npm's .cmd shims are followed to the binary
 * they wrap), reads sign-in state from each CLI's own exit code, and never
 * opens a credential file or logs a CLI's auth output.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { DuetProvider } from '@chord/core';
import { app } from 'electron';
import { defaultWslDistro, probeWsl, quoteWindowsArg, spawnSpec, wslLaunch, wslSignInArgs, wslTarget, type Launch, type WslTarget } from './launch';

export type { Launch } from './launch';

export interface ProviderStatus {
  provider: DuetProvider;
  installed: boolean;
  /** Shown in Settings so the user can see which install Chord uses. */
  path: string | null;
  version: string | null;
  signedIn: boolean | null;
  /** How it's billed: a subscription sign-in, or an API key the user set (research §1.7: say so). */
  billing: 'subscription' | 'api-key' | 'other' | null;
  /** Older than Chord's minimum: Duet warns but still tries (research §4.3: warn, don't block). */
  tooOld: boolean;
  /** Installed only inside WSL (Windows): the distro it runs in. */
  wsl: string | null;
}

/** A provider as detected: its status (shown in Setup and Settings), and how to start it (main only: never sent to a page). */
export interface Detected {
  status: ProviderStatus;
  launch: Launch | null;
}

export const notInstalled = (provider: DuetProvider): ProviderStatus => ({ provider, installed: false, path: null, version: null, signedIn: null, billing: null, tooOld: false, wsl: null });

/** research §11: the flags Duet uses arrived by these versions. */
export const MIN_VERSION: Record<DuetProvider, string> = { claude: '2.1.268', codex: '0.160.0' };
/** The newest versions Duet was checked against (docs/decisions/S10-claude-headless.md, S5-codex-restriction.md). */
export const TESTED_VERSION: Record<DuetProvider, string> = { claude: '2.1.309', codex: '0.160.1' };

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const parseVersion = (text: string): string | null => /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;

let shellPath: Promise<string> | null = null;
/** GUI apps don't inherit the login shell's PATH on macOS and Linux (research §4.3, lesson 2). */
function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('');
  shellPath ??= new Promise((done) => {
    const shell = process.env['SHELL'] || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf %s "$PATH"'], { timeout: 5000 }, (error, stdout) => done(error ? '' : stdout.trim()));
  });
  return shellPath;
}

async function searchPath(): Promise<string[]> {
  const home = homedir();
  const known =
    process.platform === 'win32'
      ? [
          join(home, '.local', 'bin'),
          join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'npm'),
          join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin'),
          join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'pnpm'),
          join(home, 'scoop', 'shims'),
          join(home, '.volta', 'bin'),
        ]
      : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin')];
  const fromEnv = (process.env['PATH'] ?? '').split(delimiter);
  const fromShell = (await loginShellPath()).split(':');
  return [...new Set([...known, ...fromEnv, ...fromShell].filter(Boolean))];
}

/** npm installs leave a shim; the real binary lives in the package (research §3.7, §4.4). */
function behindShim(provider: DuetProvider, dir: string): string | null {
  const modules = [join(dir, 'node_modules'), join(dir, '..', 'lib', 'node_modules')];
  if (provider === 'claude') {
    for (const m of modules) {
      const bin = join(m, '@anthropic-ai', 'claude-code', 'bin', exe('claude'));
      if (existsSync(bin)) return bin;
    }
    return null;
  }
  const triple =
    process.platform === 'win32'
      ? process.arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : 'x86_64-pc-windows-msvc'
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'aarch64-apple-darwin'
          : 'x86_64-apple-darwin'
        : process.arch === 'arm64'
          ? 'aarch64-unknown-linux-musl'
          : 'x86_64-unknown-linux-musl';
  const pkg = `codex-${process.platform}-${process.arch}`;
  for (const m of modules) {
    for (const root of [join(m, '@openai', 'codex', 'node_modules', '@openai', pkg), join(m, '@openai', pkg)]) {
      const bin = join(root, 'vendor', triple, 'bin', exe('codex'));
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

/** Development and tests: a fake CLI (a .mjs script run by Electron's Node) or another binary. */
function devOverride(provider: DuetProvider): string | null {
  if (app.isPackaged) return null;
  return process.env[provider === 'claude' ? 'CHORD_DUET_CLAUDE' : 'CHORD_DUET_CODEX'] || null;
}

/**
 * Development: run this inside WSL instead of the CLI found there, e.g.
 * `CHORD_DUET_CLAUDE_WSL="node /mnt/c/…/fake-claude.mjs"`, or just `claude`
 * to use the WSL install on a computer that also has a Windows one.
 */
function devWslArgv(provider: DuetProvider): string[] | null {
  if (app.isPackaged) return null;
  const value = process.env[provider === 'claude' ? 'CHORD_DUET_CLAUDE_WSL' : 'CHORD_DUET_CODEX_WSL']?.trim();
  return value ? value.split(/\s+/) : null;
}

/** Whether to look inside WSL for a provider not found on Windows (never when a development override points elsewhere). */
export function mayBeInWsl(provider: DuetProvider): boolean {
  return process.platform === 'win32' && (devWslArgv(provider) !== null || devOverride(provider) === null);
}

export async function findBinary(provider: DuetProvider): Promise<string | null> {
  if (devWslArgv(provider)) return null;
  const override = devOverride(provider);
  if (override) return existsSync(override) ? override : null;
  for (const dir of await searchPath()) {
    const direct = join(dir, exe(provider));
    if (existsSync(direct) && !direct.endsWith('.cmd')) {
      // npm on macOS/Linux symlinks a JS launcher; prefer the native binary it would run.
      if (process.platform !== 'win32') return behindShim(provider, dirname(direct)) ?? direct;
      return direct;
    }
    if (process.platform === 'win32' && (existsSync(join(dir, `${provider}.cmd`)) || existsSync(join(dir, provider)))) {
      const real = behindShim(provider, dir);
      if (real) return real;
    }
  }
  return null;
}

/** How to start a binary: directly, or a development .mjs fake through Electron's own Node. */
export function launchFor(path: string, env: NodeJS.ProcessEnv = process.env): Launch {
  if (/\.m?js$/.test(path)) return { command: process.execPath, prefix: [path], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  return { command: path, prefix: [], env: { ...env } };
}

function run(launch: Launch, args: string[], timeout = 15000): Promise<{ code: number; stdout: string }> {
  const spec = spawnSpec(launch, args);
  return new Promise((done) => {
    const child = execFile(spec.command, spec.args, { env: spec.env, timeout, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) =>
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout) }),
    );
    child.stdin?.end();
  });
}

/** The provider installed on this computer itself (not WSL: see detectInWsl). */
export async function detect(provider: DuetProvider): Promise<Detected> {
  const path = await findBinary(provider);
  if (!path) return { status: notInstalled(provider), launch: null };
  return check(provider, launchFor(path), path);
}

/**
 * Claude Code or Codex installed only inside the default WSL distro
 * (Windows). The distro comes from the registry, so with no WSL nothing
 * starts and nothing shows; otherwise one probe, with a timeout, looks for
 * every provider asked for. Each one found runs through wsl.exe from then on.
 * Null when WSL didn't answer (as opposed to answering "not here").
 */
export async function detectInWsl(providers: readonly DuetProvider[], distro?: string | null): Promise<Detected[] | null> {
  const name = distro === undefined ? await defaultWslDistro() : distro;
  if (!name || providers.length === 0) return [];
  const probe = await probeWsl(name);
  if (!probe) return null;
  const found: Detected[] = [];
  for (const provider of providers) {
    const argv = devWslArgv(provider) ?? (probe.bins[provider] ? [probe.bins[provider]] : null);
    if (argv) found.push(await check(provider, wslLaunch(wslTarget(probe, argv)), argv.join(' '), probe.distro));
  }
  return found;
}

/** A WSL install remembered from an earlier look: its last status, launched through wsl.exe again. */
export function rememberedInWsl(status: ProviderStatus, target: WslTarget): Detected {
  return { status: { ...status, wsl: target.distro }, launch: wslLaunch(target) };
}

async function check(provider: DuetProvider, launch: Launch, path: string, wsl: string | null = null): Promise<Detected> {
  const version = parseVersion((await run(launch, ['--version'])).stdout);
  const status: ProviderStatus = { ...notInstalled(provider), installed: true, path, version, tooOld: version ? compareVersions(version, MIN_VERSION[provider]) < 0 : false, wsl };
  // Claude Code 1.x has no `auth` command: `claude auth status` would start a session with that as its prompt.
  // An old one is reported as needing an update, sign-in unknown (seen with 1.0.34 inside WSL).
  if (provider === 'claude' && status.tooOld) return { status, launch };
  if (provider === 'claude') {
    // Exit 0 when signed in. Only authMethod is read; the JSON can hold account details, never logged.
    const auth = await run(launch, ['auth', 'status']);
    let method: string;
    try {
      method = String((JSON.parse(auth.stdout) as { authMethod?: unknown }).authMethod ?? '');
    } catch {
      method = '';
    }
    status.signedIn = auth.code === 0 && method !== 'none';
    status.billing = method === 'claude.ai' || method === 'oauth_token' ? 'subscription' : method === 'api_key' || method === 'api_key_helper' ? 'api-key' : method ? 'other' : null;
  } else {
    const auth = await run(launch, ['login', 'status']);
    status.signedIn = auth.code === 0;
    status.billing = status.signedIn ? 'subscription' : null;
  }
  return { status, launch };
}

/** "Sign in": the provider's own login, in a terminal. Chord never sees the result, only the next status. */
export function openSignIn(provider: DuetProvider, launch: Launch): void {
  const args = provider === 'claude' ? ['auth', 'login'] : ['login'];
  if (launch.wsl) {
    // Inside WSL, through the user's login shell, in a console window of its own.
    const wslArgs = wslSignInArgs(launch.wsl, args);
    if (!wslArgs) return;
    const line = `start "Sign in" ${[launch.command, ...wslArgs].map(quoteWindowsArg).join(' ')}`;
    spawn('cmd.exe', ['/d', '/s', '/c', line], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const path = launch.prefix.at(-1) ?? launch.command;
  const command = `"${path}" ${args.join(' ')}`;
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', `start "Sign in" ${command}`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`;
    spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      const child = spawn(term, term === 'gnome-terminal' ? ['--', path, ...args] : ['-e', path, ...args], { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
      break;
    }
  }
}

/** Claude names a project folder after its working directory, every other character a dash. */
export const claudeProjectFolder = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');
export const claudeConfigDir = (): string => process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
