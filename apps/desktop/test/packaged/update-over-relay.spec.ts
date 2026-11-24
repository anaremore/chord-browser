/**
 * Windows: setup replaces Chord while an agent is connected (issue #142).
 *
 * An agent's relay (`Chord.exe mcp`, started by Claude Code, Codex or Antigravity) runs from the install folder and
 * keeps Chord's files in use after Chord's window closes. Ending it once isn't enough: the agent starts it again on
 * its next tool call (Claude Code does, measured 2026-11-24), so a relay can come back at any moment during setup.
 * This test's agent restarts its relay 100 ms after it ends, the hardest case.
 *
 * Both ways an update arrives go from the last release (CHORD_PREVIOUS_INSTALLER, whose uninstaller is the one an
 * update runs first) to this build, with the agent connected throughout:
 * - as a person runs setup (`/S`);
 * - as the in-app updater runs it (`--updated /S --force-run`: electron-updater's `quitAndInstall(true, true)`).
 * Each must succeed, put this build's files in place (its version and its app archive), and leave the agent able to
 * start its relay again. It installs into the real per-user folder, so it runs only where CHORD_INSTALLER says to:
 * CI's Windows installer job, on a throwaway runner.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const installer = process.env['CHORD_INSTALLER'];
const previous = process.env['CHORD_PREVIOUS_INSTALLER'];
test.skip(process.platform !== 'win32' || !installer, 'Windows only, with CHORD_INSTALLER set (CI installs Chord for real)');

const installed = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'chord');
const exe = join(installed, 'Chord.exe');
/** This build's unpacked app archive and version: after setup, the installed ones must be these. */
const built = resolve(import.meta.dirname, '../../release/win-unpacked/resources/app.asar');
const version = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }).version;

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const powershell = (command: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env: { ...process.env, CHORD_INSTDIR: `${installed}\\` } }).trim();

/** Runs setup and waits for it. NSIS exits 0 when it installed, 1 when cancelled, 2 when it gave up. */
function setup(file: string, args: string[]): number {
  try {
    execFileSync(file, args, { stdio: 'ignore', timeout: 300_000 });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

/** The installed Chord.exe's version (electron-builder writes the app's version as its file version). */
const installedVersion = () => powershell(`(Get-Item -LiteralPath (Join-Path $env:CHORD_INSTDIR 'Chord.exe')).VersionInfo.FileVersion`);

/** Relays running from the install folder. */
const relays = () => Number(powershell(`@(Get-CimInstance Win32_Process | ? { $_.Path -and $_.Path.StartsWith($env:CHORD_INSTDIR, 'OrdinalIgnoreCase') -and $_.CommandLine -match '\\smcp(\\s|$)' }).Count`));

/** Ends everything running from the install folder (Chord, reopened by --force-run, and relays). */
const endAll = () => powershell(`Get-CimInstance Win32_Process | ? { $_.Path -and $_.Path.StartsWith($env:CHORD_INSTDIR, 'OrdinalIgnoreCase') } | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);

/**
 * An agent with Chord connected: it starts `Chord.exe mcp` and says hello, and whenever the relay ends (or can't
 * start), it starts it again 100 ms later, as a client restarting its MCP server would.
 */
function agent(profile: string) {
  let child: ChildProcess | null = null;
  let stopped = false;
  let answered = 0;
  const events: string[] = [];
  const run = () => {
    if (stopped) return;
    let relay: ChildProcess;
    try {
      relay = spawn(exe, [`--user-data-dir=${profile}`, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      // Windows refuses at once (EPERM) while setup keeps the folder from running anything, or ENOENT mid-update.
      events.push(`couldn't start: ${(error as NodeJS.ErrnoException).code}`);
      setTimeout(run, 100);
      return;
    }
    child = relay;
    let buffer = '';
    relay.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      if (/"serverInfo"/.test(buffer)) {
        answered++;
        buffer = '';
      }
    });
    relay.stdin!.on('error', () => undefined);
    relay.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } } })}\n`);
    let again = false;
    const restart = (why: string) => {
      if (again) return;
      again = true;
      events.push(why);
      setTimeout(run, 100);
    };
    relay.once('error', (error: NodeJS.ErrnoException) => restart(`couldn't start: ${error.code}`));
    relay.once('exit', (code) => restart(`ended (${code})`));
  };
  run();
  return {
    events,
    /** Waits for a relay started from now on to answer. */
    async answers(): Promise<void> {
      const before = answered;
      child?.kill();
      await expect.poll(() => answered, { timeout: 60_000, message: `a relay answers (agent's log: ${events.slice(-5).join('; ')})` }).toBeGreaterThan(before);
    },
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

test('setup updates Chord from the last release while an agent keeps its relay running, by hand and in-app', async () => {
  test.setTimeout(900_000);
  expect(existsSync(installer!), `${installer} exists`).toBe(true);
  expect(existsSync(built), `${built} exists (pnpm package --win first)`).toBe(true);
  const from = previous ?? installer!;
  const profile = mkdtempSync(join(tmpdir(), 'chord-relay-'));

  /** Installs the last release with no agent running, then connects one. */
  const lastRelease = async () => {
    expect(setup(from, ['/S']), 'installing the last release').toBe(0);
    const connected = agent(profile);
    await connected.answers();
    expect(relays(), 'a relay runs from the install folder').toBeGreaterThan(0);
    return connected;
  };
  const isThisBuild = (how: string) => {
    expect(installedVersion(), `${how}: this build's version`).toBe(version);
    expect(sha(join(installed, 'resources', 'app.asar')), `${how}: this build's files`).toBe(sha(built));
  };

  try {
    let connected = await lastRelease();
    const fromVersion = installedVersion();
    // The last release can be newer than this branch's version number (main says 0.14.0 while 0.14.1 is out): the
    // version and the app archive both have to change to this build's, whichever way the numbers go.
    console.log(`Updating ${fromVersion} (${previous ? 'the last release' : 'this build, no release given'}) to this build, ${version}`);
    if (previous) expect(sha(join(installed, 'resources', 'app.asar')), 'the last release is installed, not this build').not.toBe(sha(built));

    // As a person runs setup.
    expect(setup(installer!, ['/S']), 'setup over a running relay').toBe(0);
    isThisBuild('by hand');
    await connected.answers();
    connected.stop();
    endAll();

    // As the in-app updater runs it.
    connected = await lastRelease();
    expect(setup(installer!, ['--updated', '/S', '--force-run']), 'an in-app update over a running relay').toBe(0);
    isThisBuild('in-app');
    await connected.answers();
    console.log(`The agent's relay, through both updates: ${connected.events.length} restarts (${[...new Set(connected.events)].join(', ')})`);
    connected.stop();
  } finally {
    endAll();
    rmSync(profile, { recursive: true, force: true });
  }
});
