/**
 * Where `chord mcp` keeps its own Chromium files (Local State and the like):
 * never the profile it serves, and never a shared, fixed path another user
 * could create first (a symlink to clobber a file, or a folder to block it).
 * Linux with a runtime folder: `$XDG_RUNTIME_DIR/chord-mcp` (the user's own,
 * 0700 by the spec). Otherwise the user's cache folder (userCache: under their
 * home, or Local AppData on Windows). The folder must be a real folder of this user's,
 * 0700 on POSIX; if it isn't, a fresh private one for this run, removed on exit.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The user's own cache folder: $XDG_CACHE_HOME or ~/.cache, ~/Library/Caches, %LOCALAPPDATA%. */
export function userCache(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
  if (platform === 'darwin') return join(home, 'Library', 'Caches');
  return env['XDG_CACHE_HOME'] || join(home, '.cache');
}

export function relayFolder(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, cache: string, packaged: boolean): string {
  const runtime = env['XDG_RUNTIME_DIR'];
  if (platform !== 'win32' && platform !== 'darwin' && runtime) return join(runtime, packaged ? 'chord-mcp' : 'chord-dev-mcp');
  return join(cache, packaged ? 'Chord MCP' : 'Chord Dev MCP');
}

/** Whether `path` is a folder that's this user's alone (POSIX: owned, 0700, not a link); made if missing. */
export function privateFolder(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (platform === 'win32') return true;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
    return true;
  } catch {
    return false;
  }
}

/** The relay's folder: the usual one if it's private, else a fresh one for this run (and how to remove it). */
export function relayUserData(usual: string): { path: string; dispose(): void } {
  if (privateFolder(usual)) return { path: usual, dispose: () => undefined };
  const path = mkdtempSync(join(tmpdir(), 'chord-mcp-'));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}
