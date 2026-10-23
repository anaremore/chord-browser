/**
 * How Duet starts a provider's CLI (ARCHITECTURE.md §11.1, §11.2): the
 * binary itself with shell:false, or, for Claude Code or Codex installed only
 * inside WSL (Windows), the same binary through `wsl.exe -e`. WSL needs three
 * translations, all made here: Windows paths become the distro's paths
 * (`/mnt/c/…`, from `wslpath`), Windows environment variables don't cross into
 * WSL so they travel as `env NAME=value` arguments, and the CLI gets the PATH
 * of the user's own login shell there (nvm and friends live in `.bashrc`).
 * `wsl.exe -e` passes every argument through as is: no shell, no quoting.
 *
 * No Electron here, so all of it is unit-tested.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DuetProvider } from '@chord/core';

/** A CLI installed only inside WSL, as Chord's probe found it. */
export interface WslTarget {
  distro: string;
  /** What runs inside the distro: the CLI's path (development: a fake, e.g. `node /mnt/…/fake-claude.mjs`). */
  argv: string[];
  /** The user's login-shell PATH in the distro, without Windows folders seen through interop. */
  path: string;
  /** Variables the user's shell sets that the CLI needs to find its own data (`CLAUDE_CONFIG_DIR`). */
  env: Record<string, string>;
  /** Where Windows drives are mounted in the distro, from `wslpath` ("/mnt/"). */
  mountRoot: string;
  /** Claude's config folder in the distro: its sessions are under `projects/`. */
  claudeConfigDir: string;
  /** The user's shell there: Sign in runs the CLI's login through it, in a terminal. */
  shell: string;
}

/** What a provider needs to run: the binary, plus a prefix when it's a development fake run by Node. */
export interface Launch {
  command: string;
  prefix: string[];
  env: NodeJS.ProcessEnv;
  /** Set when the CLI lives inside WSL; `command` is then wsl.exe. */
  wsl?: WslTarget;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Windows' working folder for the process (WSL's is passed as `--cd`). */
  cwd: string | undefined;
}

export const wslExe = (): string => join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'wsl.exe');

/** `C:\Users\me` → `/mnt/c/Users/me`, given WSL's mount root. Null for a path without a drive letter (UNC). */
export function toWslPath(path: string, mountRoot: string): string | null {
  const m = /^([A-Za-z]):(?:[\\/]+(.*))?$/.exec(path);
  if (!m) return null;
  const root = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`;
  const rest = (m[2] ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return `${root}${m[1]!.toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** A path on this computer as the CLI sees it: unchanged, or under WSL's drive mounts. */
export function cliPath(launch: Launch, path: string): string {
  return launch.wsl ? (toWslPath(path, launch.wsl.mountRoot) ?? path) : path;
}

/**
 * The process to start for a CLI with these arguments, extra environment and
 * working folder. Natively that's the binary as before. Through WSL it's
 * `wsl.exe -d <distro> --cd <folder> -e env PATH=… NAME=value … <cli> <args>`.
 */
export function spawnSpec(launch: Launch, args: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}): SpawnSpec {
  const extra = options.env ?? {};
  if (!launch.wsl) return { command: launch.command, args: [...launch.prefix, ...args], env: { ...launch.env, ...extra }, cwd: options.cwd };
  const w = launch.wsl;
  const folder = options.cwd ? toWslPath(options.cwd, w.mountRoot) : '~';
  const vars = { PATH: w.path, ...w.env, ...extra };
  return {
    command: launch.command,
    args: ['-d', w.distro, ...(folder ? ['--cd', folder] : []), '-e', 'env', ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), ...w.argv, ...args],
    env: launch.env,
    cwd: options.cwd,
  };
}

/** One argument on a Windows command line, quoted the way wsl.exe (and the C runtime) reads it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Sign in for a WSL install: the CLI's own login, inside the distro, through
 * the user's login shell (so it finds node and can open the browser), shown
 * in a terminal. Returns wsl.exe's arguments, or null if a part can't be
 * written safely on a cmd.exe line (a `"` or `%`).
 */
export function wslSignInArgs(target: WslTarget, loginArgs: readonly string[]): string[] | null {
  const inner = `exec ${[...target.argv, ...loginArgs].map(shQuote).join(' ')}`;
  const args = ['-d', target.distro, '--cd', '~', '-e', target.shell, '-lic', inner];
  return args.some((a) => /["%\r\n]/.test(a)) ? null : args;
}

/* ---------- Finding a CLI inside WSL ---------- */

/** WSL can take several seconds to start; past this, the check gives up (and Setup shows nothing more). */
export const WSL_PROBE_MS = 25_000;

const LXSS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

/** The default distro's name from `reg query <Lxss> /s`: null when there's none. */
export function parseLxss(out: string): string | null {
  const id = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/.exec(out)?.[1]?.toLowerCase();
  if (!id) return null;
  const block = out.split(/\r?\n(?=HKEY_)/).find((b) => b.split(/\r?\n/)[0]!.trim().toLowerCase().endsWith(id));
  const name = block ? /DistributionName\s+REG_SZ\s+(\S.*?)\s*$/m.exec(block)?.[1] : undefined;
  return name && /^[\w.-]{1,64}$/.test(name) ? name : null;
}

/**
 * The default WSL distro, read from the registry: cheap, and it doesn't start
 * WSL. Null when WSL isn't installed or has no distro, so Setup shows nothing.
 */
export function defaultWslDistro(): Promise<string | null> {
  if (process.platform !== 'win32' || !existsSync(wslExe())) return Promise.resolve(null);
  const reg = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((done) => {
    execFile(reg, ['query', LXSS, '/s'], { windowsHide: true, timeout: 5000 }, (error, stdout) => done(error ? null : parseLxss(String(stdout))));
  });
}

/**
 * Run by `sh` inside the distro, once per check. The user's login shell
 * (interactive, as nvm lives in .bashrc) gives PATH and any
 * CLAUDE_CONFIG_DIR; folders under Windows' drive mounts are dropped, so a
 * Windows CLI seen through interop doesn't count; then each CLI's path. Only
 * tagged lines are read back: a login banner or anything else is ignored.
 */
export const WSL_PROBE = [
  `r=$(wslpath -u 'C:\\' 2>/dev/null); r=\${r%c/}`,
  's=${SHELL:-/bin/sh}',
  `o=$("$s" -ilc 'printf "\\n@chord-path=%s\\n@chord-ccd=%s\\n" "$PATH" "$CLAUDE_CONFIG_DIR"' </dev/null 2>/dev/null)`,
  `p=$(printf '%s\\n' "$o" | sed -n 's/^@chord-path=//p' | tail -n 1)`,
  `c=$(printf '%s\\n' "$o" | sed -n 's/^@chord-ccd=//p' | tail -n 1)`,
  '[ -n "$p" ] || p=$PATH',
  'q=',
  'set -f',
  'IFS=:',
  'for d in $p; do case $d in "$r"?|"$r"?/*|"") ;; *) q=${q:+$q:}$d ;; esac; done',
  'unset IFS',
  'set +f',
  `printf '@chord-distro=%s\\n@chord-root=%s\\n@chord-shell=%s\\n@chord-home=%s\\n@chord-path=%s\\n@chord-ccd=%s\\n' "$WSL_DISTRO_NAME" "$r" "$s" "$HOME" "$q" "$c"`,
  `for n in claude codex; do printf '@chord-%s=%s\\n' "$n" "$(PATH=$q; command -v "$n" 2>/dev/null)"; done`,
].join('\n');

export interface WslProbe {
  distro: string;
  mountRoot: string;
  shell: string;
  home: string;
  path: string;
  /** Set only when the user's shell sets it. */
  claudeConfigDir: string | null;
  bins: Record<DuetProvider, string | null>;
}

/** WSL_PROBE's output → what was found; null if it's incomplete. */
export function parseWslProbe(out: string): WslProbe | null {
  const tag = (name: string): string => {
    const lines = out.split(/\r?\n/).filter((l) => l.startsWith(`@chord-${name}=`));
    return (lines.at(-1) ?? '').slice(name.length + 8).trim();
  };
  const absolute = (p: string) => (p.startsWith('/') ? p : null);
  const distro = tag('distro');
  const mountRoot = tag('root');
  const home = tag('home');
  const path = tag('path');
  if (!/^[\w.-]{1,64}$/.test(distro) || !/^\/(.*\/)?$/.test(mountRoot) || !absolute(home) || !path) return null;
  // A CLI under the drive mounts is a Windows install seen through interop: not a WSL one.
  const drive = new RegExp(`^${mountRoot.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&')}[A-Za-z](/|$)`);
  const bin = (name: DuetProvider) => {
    const p = absolute(tag(name));
    return p && !drive.test(p) ? p : null;
  };
  return {
    distro,
    mountRoot,
    shell: absolute(tag('shell')) ?? '/bin/sh',
    home,
    path,
    claudeConfigDir: absolute(tag('ccd')),
    bins: { claude: bin('claude'), codex: bin('codex') },
  };
}

/** Runs the probe in a distro, with a timeout. Null if WSL didn't answer in time or found nothing usable. */
export function probeWsl(distro: string, timeout = WSL_PROBE_MS): Promise<WslProbe | null> {
  return new Promise((done) => {
    execFile(wslExe(), ['-d', distro, '-e', 'sh', '-c', WSL_PROBE], { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (error, stdout) =>
      done(error ? null : parseWslProbe(String(stdout))),
    );
  });
}

/** The target for a CLI found by the probe (or a development stand-in for it). */
export function wslTarget(probe: WslProbe, argv: string[]): WslTarget {
  return {
    distro: probe.distro,
    argv,
    path: probe.path,
    env: probe.claudeConfigDir ? { CLAUDE_CONFIG_DIR: probe.claudeConfigDir } : {},
    mountRoot: probe.mountRoot,
    claudeConfigDir: probe.claudeConfigDir ?? `${probe.home.replace(/\/$/, '')}/.claude`,
    shell: probe.shell,
  };
}

export const wslLaunch = (target: WslTarget, env: NodeJS.ProcessEnv = process.env): Launch => ({ command: wslExe(), prefix: [], env: { ...env }, wsl: target });

/** A target as saved in Duet's panel.json, checked field by field; null if it isn't one. */
export function asWslTarget(value: unknown): WslTarget | null {
  const t = value as Partial<WslTarget> | null;
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!t || !text(t.distro) || !Array.isArray(t.argv) || !t.argv.length || !t.argv.every(text) || !text(t.path) || !text(t.mountRoot) || !text(t.claudeConfigDir) || !text(t.shell)) return null;
  const env = Object.fromEntries(Object.entries(t.env ?? {}).filter((e): e is [string, string] => /^[A-Z_][A-Z0-9_]*$/.test(e[0]) && text(e[1])));
  return { distro: t.distro, argv: t.argv, path: t.path, env, mountRoot: t.mountRoot, claudeConfigDir: t.claudeConfigDir, shell: t.shell };
}

/**
 * Where Claude Code keeps a session inside WSL: `<config>/projects/<the
 * distro's path to Chord's empty folder, other characters as dashes>/`, the
 * `<id>.jsonl` file and a `<id>/` folder (S10). Deleting a chat removes both.
 */
export function wslClaudeSessionPaths(target: WslTarget, cwd: string, id: string): string[] {
  const folder = `${target.claudeConfigDir.replace(/\/+$/, '')}/projects/${(toWslPath(cwd, target.mountRoot) ?? cwd).replace(/[^a-zA-Z0-9]/g, '-')}`;
  return [`${folder}/${id}.jsonl`, `${folder}/${id}`];
}

/** Removes files inside the distro (`rm -rf -- …`, no shell). */
export function removeInWsl(target: WslTarget, paths: readonly string[]): Promise<void> {
  return new Promise((done) => {
    execFile(wslExe(), ['-d', target.distro, '-e', 'rm', '-rf', '--', ...paths], { windowsHide: true, timeout: WSL_PROBE_MS }, () => done());
  });
}
