/**
 * Windows: setup replaces Chord while an agent is connected (issue #142).
 *
 * An agent's relay (`Chord.exe mcp`, started by Claude Code, Codex or Antigravity) runs from the install folder and
 * keeps Chord's files in use after Chord's window closes. Ending it once isn't enough: the agent starts it again on
 * its next tool call (Claude Code does, measured 2026-11-24), so a relay can come back at any moment during setup.
 * This test's agent restarts its relay as soon as it ends, the hardest case.
 *
 * It installs the last release (CHORD_PREVIOUS_INSTALLER, whose uninstaller is the one an update runs first), starts
 * the agent, then runs this build's setup over it twice: as a person does (`/S`), and as the in-app updater does
 * (`--updated /S`, electron-updater's NsisUpdater). Each must succeed, put this build's files in place, and leave the
 * agent able to start its relay again. It installs into the real per-user folder, so it runs only where
 * CHORD_INSTALLER says to: CI's Windows installer job, on a throwaway runner.
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
/** This build's unpacked app archive: after setup, the installed one must be the same bytes. */
const built = resolve(import.meta.dirname, '../../release/win-unpacked/resources/app.asar');

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Runs setup and waits for it. NSIS exits 0 when it installed, 1 when cancelled, 2 when it gave up. */
function setup(file: string, args: string[]): number {
  try {
    execFileSync(file, args, { stdio: 'ignore', timeout: 300_000 });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

/** The relays from the install folder that are running now. */
function relays(): number[] {
  const ps = `@(Get-CimInstance Win32_Process -Filter "Name='Chord.exe'" | ? { $_.CommandLine -match '\\smcp(\\s|$)' }) | % { $_.ProcessId }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number);
}

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
    const relay = spawn(exe, [`--user-data-dir=${profile}`, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
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

test('setup updates Chord while an agent keeps its relay running, and the agent starts it again after', async () => {
  test.setTimeout(900_000);
  expect(existsSync(installer!), `${installer} exists`).toBe(true);
  expect(existsSync(built), `${built} exists (pnpm package --win first)`).toBe(true);
  const profile = mkdtempSync(join(tmpdir(), 'chord-relay-'));
  // The release people have now; without one, this build stands in for it.
  expect(setup(previous ?? installer!, ['/S']), 'the first install').toBe(0);
  expect(existsSync(exe), `${exe} is installed`).toBe(true);

  const connected = agent(profile);
  try {
    await connected.answers();
    expect(relays().length, 'a relay runs from the install folder').toBeGreaterThan(0);

    // As a person runs setup: the old version's uninstaller first, then this build's files.
    expect(setup(installer!, ['/S']), 'setup over a running relay').toBe(0);
    expect(sha(join(installed, 'resources', 'app.asar')), "this build's files are installed").toBe(sha(built));
    await connected.answers();

    // As the in-app updater runs it, over this build's own uninstaller.
    expect(setup(installer!, ['--updated', '/S']), 'an in-app update over a running relay').toBe(0);
    expect(sha(join(installed, 'resources', 'app.asar'))).toBe(sha(built));
    await connected.answers();
    console.log(`The agent's relay, through both updates: ${connected.events.length} restarts (${[...new Set(connected.events)].join(', ')})`);
  } finally {
    connected.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
