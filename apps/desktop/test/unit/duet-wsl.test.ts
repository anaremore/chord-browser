/**
 * Claude Code or Codex installed only inside WSL (ARCHITECTURE.md §11.1):
 * how Duet finds them, translates paths, and builds wsl.exe's arguments. The
 * last block runs the real thing (a fake CLI inside the default distro) and
 * is opt-in: CHORD_TEST_WSL=1 on a Windows computer with WSL and node there.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DUET_TOOLS } from '@chord/core';
import { describe, expect, it } from 'vitest';
import type { SessionEvents } from '../../src/main/duet/adapter';
import { ClaudeSession, claudeArgs } from '../../src/main/duet/claude';
import { codexArgs } from '../../src/main/duet/codex';
import {
  asWslTarget,
  cliPath,
  defaultWslDistro,
  parseLxss,
  parseWslProbe,
  probeWsl,
  quoteWindowsArg,
  removeInWsl,
  spawnSpec,
  toWslPath,
  wslClaudeSessionPaths,
  wslExe,
  wslLaunch,
  wslSignInArgs,
  wslTarget,
  type Launch,
  type WslTarget,
} from '../../src/main/duet/launch';

const target: WslTarget = {
  distro: 'Ubuntu',
  argv: ['/home/me/.local/bin/claude'],
  path: '/home/me/.local/bin:/usr/bin:/bin',
  env: {},
  mountRoot: '/mnt/',
  claudeConfigDir: '/home/me/.claude',
  shell: '/bin/bash',
};
const inWsl: Launch = { command: 'C:\\Windows\\System32\\wsl.exe', prefix: [], env: { PATH: 'C:\\Windows' }, wsl: target };

describe('WSL paths', () => {
  it('turns Windows paths into the distro’s', () => {
    expect(toWslPath('C:\\Users\\me\\AppData\\Roaming\\Chord\\duet\\empty', '/mnt/')).toBe('/mnt/c/Users/me/AppData/Roaming/Chord/duet/empty');
    expect(toWslPath('D:\\', '/mnt/')).toBe('/mnt/d');
    expect(toWslPath('z:/Projects/a b/', '/mnt')).toBe('/mnt/z/Projects/a b');
    // A custom automount root (wsl.conf root = /).
    expect(toWslPath('C:\\x', '/')).toBe('/c/x');
    // UNC paths have no drive to mount.
    expect(toWslPath('\\\\server\\share\\x', '/mnt/')).toBeNull();
  });

  it('only translates for a WSL launch', () => {
    expect(cliPath(inWsl, 'C:\\Users\\me\\i.md')).toBe('/mnt/c/Users/me/i.md');
    expect(cliPath({ command: 'claude.exe', prefix: [], env: {} }, 'C:\\Users\\me\\i.md')).toBe('C:\\Users\\me\\i.md');
  });
});

describe('Starting a CLI', () => {
  it('starts a Windows install exactly as before', () => {
    const native: Launch = { command: 'C:\\bin\\claude.exe', prefix: [], env: { PATH: 'C:\\bin' } };
    const spec = spawnSpec(native, ['-p', '--tools', ''], { cwd: 'C:\\empty', env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } });
    expect(spec).toEqual({ command: 'C:\\bin\\claude.exe', args: ['-p', '--tools', ''], env: { PATH: 'C:\\bin', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }, cwd: 'C:\\empty' });
  });

  it('runs a WSL install through wsl.exe with the same restricted flags, its own PATH, and the variables as env arguments', () => {
    const args = claudeArgs({ model: null, instructionsFile: cliPath(inWsl, 'C:\\Users\\me\\duet\\instructions\\t.md'), resumeId: null, newSessionId: 'abc' });
    const spec = spawnSpec(inWsl, args, { cwd: 'C:\\Users\\me\\duet\\empty', env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
    expect(spec.command).toBe(inWsl.command);
    expect(spec.args.slice(0, 10)).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '/mnt/c/Users/me/duet/empty',
      '-e',
      'env',
      'PATH=/home/me/.local/bin:/usr/bin:/bin',
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
      '/home/me/.local/bin/claude',
    ]);
    // Every browse-mode flag reaches the CLI unchanged, the empty --tools included.
    expect(spec.args.slice(10)).toEqual(args);
    expect(spec.args[spec.args.indexOf('--tools') + 1]).toBe('');
    expect(spec.args[spec.args.indexOf('--append-system-prompt-file') + 1]).toBe('/mnt/c/Users/me/duet/instructions/t.md');
    // Windows' own variables stay on wsl.exe's side.
    expect(spec.env).toEqual({ PATH: 'C:\\Windows' });
  });

  it('passes a CLAUDE_CONFIG_DIR the user’s shell sets, and runs checks from the home folder', () => {
    const custom = wslLaunch({ ...target, env: { CLAUDE_CONFIG_DIR: '/data/claude' } }, {});
    expect(spawnSpec(custom, ['--version']).args).toEqual(['-d', 'Ubuntu', '--cd', '~', '-e', 'env', `PATH=${target.path}`, 'CLAUDE_CONFIG_DIR=/data/claude', '/home/me/.local/bin/claude', '--version']);
    expect(spawnSpec({ ...inWsl, wsl: { ...target, argv: ['codex'] } }, codexArgs()).args.slice(7)).toEqual(['codex', ...codexArgs()]);
  });

  it('signs in inside WSL through the user’s login shell, and quotes it for a cmd.exe line', () => {
    const args = wslSignInArgs(target, ['auth', 'login'])!;
    expect(args).toEqual(['-d', 'Ubuntu', '--cd', '~', '-e', '/bin/bash', '-lic', "exec '/home/me/.local/bin/claude' 'auth' 'login'"]);
    expect(args.map(quoteWindowsArg).join(' ')).toBe(`-d Ubuntu --cd ~ -e /bin/bash -lic "exec '/home/me/.local/bin/claude' 'auth' 'login'"`);
    expect(wslSignInArgs({ ...target, argv: ["/home/o'neil/claude"] }, ['login'])![7]).toBe(`exec '/home/o'\\''neil/claude' 'login'`);
    // A part cmd.exe would mangle isn't offered at all.
    expect(wslSignInArgs({ ...target, argv: ['/home/100%/claude'] }, ['login'])).toBeNull();
  });

  it('quotes Windows arguments the way wsl.exe reads them back', () => {
    expect(quoteWindowsArg('plain')).toBe('plain');
    expect(quoteWindowsArg('')).toBe('""');
    expect(quoteWindowsArg('a b')).toBe('"a b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
  });
});

describe('Finding a CLI inside WSL', () => {
  it('reads the default distro from the registry', () => {
    const out = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss',
      '    DefaultDistribution    REG_SZ    {83584559-39d1-4221-9524-f7fd0d66d7a7}',
      '    DefaultVersion    REG_DWORD    0x2',
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-0000-4000-8000-000000000000}',
      '    DistributionName    REG_SZ    docker-desktop',
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{83584559-39d1-4221-9524-f7fd0d66d7a7}',
      '    State    REG_DWORD    0x1',
      '    DistributionName    REG_SZ    Ubuntu',
      '    BasePath    REG_SZ    C:\\Users\\me\\AppData\\Local\\wsl\\{83584559}',
    ].join('\r\n');
    expect(parseLxss(out)).toBe('Ubuntu');
    // WSL without a distro, or not installed: nothing.
    expect(parseLxss('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n    DefaultVersion    REG_DWORD    0x2')).toBeNull();
    expect(parseLxss('')).toBeNull();
  });

  it('reads the probe’s tagged lines and ignores anything a login shell prints', () => {
    const out = [
      'Welcome to Ubuntu 22.04.5 LTS',
      '@chord-distro=Ubuntu',
      '@chord-root=/mnt/',
      '@chord-shell=/bin/bash',
      '@chord-home=/home/me',
      '@chord-path=/home/me/.nvm/versions/node/v20.19.3/bin:/usr/bin',
      '@chord-ccd=',
      '@chord-claude=/home/me/.nvm/versions/node/v20.19.3/bin/claude',
      // A Windows install seen through interop isn't a WSL install.
      '@chord-codex=/mnt/c/nvm4w/nodejs/codex',
    ].join('\n');
    const probe = parseWslProbe(out)!;
    expect(probe).toEqual({
      distro: 'Ubuntu',
      mountRoot: '/mnt/',
      shell: '/bin/bash',
      home: '/home/me',
      path: '/home/me/.nvm/versions/node/v20.19.3/bin:/usr/bin',
      claudeConfigDir: null,
      bins: { claude: '/home/me/.nvm/versions/node/v20.19.3/bin/claude', codex: null },
    });
    expect(wslTarget(probe, [probe.bins.claude!])).toMatchObject({ claudeConfigDir: '/home/me/.claude', env: {} });
    const custom = parseWslProbe(out.replace('@chord-ccd=', '@chord-ccd=/data/claude'))!;
    expect(wslTarget(custom, ['claude'])).toMatchObject({ claudeConfigDir: '/data/claude', env: { CLAUDE_CONFIG_DIR: '/data/claude' } });
    // Incomplete (WSL broke off): nothing.
    expect(parseWslProbe('@chord-distro=Ubuntu\n')).toBeNull();
  });

  it('deletes a session where Claude Code keeps it inside WSL', () => {
    expect(wslClaudeSessionPaths(target, 'C:\\Users\\me\\AppData\\Roaming\\Chord\\duet\\empty', '0b1c-22')).toEqual([
      '/home/me/.claude/projects/-mnt-c-Users-me-AppData-Roaming-Chord-duet-empty/0b1c-22.jsonl',
      '/home/me/.claude/projects/-mnt-c-Users-me-AppData-Roaming-Chord-duet-empty/0b1c-22',
    ]);
  });

  it('only trusts a saved target that has every part', () => {
    expect(asWslTarget(target)).toEqual(target);
    expect(asWslTarget({ ...target, env: { CLAUDE_CONFIG_DIR: '/x', 'bad name': 'y' } })?.env).toEqual({ CLAUDE_CONFIG_DIR: '/x' });
    expect(asWslTarget({ ...target, argv: [] })).toBeNull();
    expect(asWslTarget({ distro: 'Ubuntu' })).toBeNull();
    expect(asWslTarget(null)).toBeNull();
  });
});

const realWsl = process.platform === 'win32' && process.env['CHORD_TEST_WSL'] === '1';
const run = (args: string[]) => new Promise<{ code: number; out: string }>((done) => execFile(wslExe(), args, { windowsHide: true, timeout: 30_000 }, (e, out) => done({ code: e ? Number(e.code ?? 1) : 0, out: String(out) })));

describe.runIf(realWsl)('Through real WSL (opt-in)', () => {
  it('finds the distro and the CLIs installed in it', { timeout: 60_000 }, async () => {
    const distro = await defaultWslDistro();
    expect(distro).toBeTruthy();
    const probe = await probeWsl(distro!);
    expect(probe?.distro).toBe(distro);
    console.log('WSL probe:', JSON.stringify(probe?.bins));
  });

  it('runs a Claude session, resumes it, ends the process inside WSL, and deletes the session there', { timeout: 120_000 }, async () => {
    const probe = (await probeWsl((await defaultWslDistro())!))!;
    const fake = toWslPath(resolve(import.meta.dirname, '../e2e/fake-claude.mjs'), probe.mountRoot)!;
    const config = `/tmp/chord-wsl-test-${Date.now()}`;
    const t = { ...wslTarget(probe, ['node', fake]), env: { CLAUDE_CONFIG_DIR: config }, claudeConfigDir: config };
    const dir = mkdtempSync(join(tmpdir(), 'chord-duet-wsl-'));
    const instructionsFile = join(dir, 'instructions.md');
    writeFileSync(instructionsFile, 'Duet test instructions');
    const options = { launch: wslLaunch(t), cwd: dir, model: null, instructions: '', instructionsFile, resumeId: null as string | null, newSessionId: '22222222-3333-4444-8555-666666666666', tools: DUET_TOOLS };
    const turn = async (resumeId: string | null, text: string) => {
      const seen = { text: '', tools: [] as string[], session: '', status: '', exited: false };
      let ended!: () => void;
      const done = new Promise<void>((r) => (ended = r));
      let exited!: () => void;
      const gone = new Promise<void>((r) => (exited = r));
      const events: SessionEvents = {
        onSessionId: (id) => (seen.session = id),
        onText: (d) => (seen.text += d),
        onTool: async (name) => {
          seen.tools.push(name);
          return { text: JSON.stringify({ content: 'Chords are three notes' }) };
        },
        onTurnEnd: (o) => {
          seen.status = o.status;
          ended();
        },
        onExit: () => {
          seen.exited = true;
          ended();
          exited();
        },
      };
      const session = new ClaudeSession({ ...options, resumeId }, events);
      session.send(text);
      await done;
      session.close();
      await gone;
      return seen;
    };
    const first = await turn(null, 'Summarize this page\n\nAttached: tab t1 · example.com');
    expect(first).toMatchObject({ status: 'done', tools: ['read_tab'], session: options.newSessionId });
    expect(first.text).toBe('Here is the gist. [[t1:"Chords are three notes"]]');
    const [file, folder] = wslClaudeSessionPaths(t, dir, options.newSessionId);
    expect((await run(['-d', t.distro, '-e', 'test', '-f', file!])).code).toBe(0);
    // Closing ends the CLI inside WSL, not just wsl.exe.
    await new Promise((r) => setTimeout(r, 500));
    expect((await run(['-d', t.distro, '-e', 'pgrep', '-f', fake])).out.trim()).toBe('');

    const again = await turn(options.newSessionId, 'hello again');
    expect(again).toMatchObject({ status: 'done', text: 'Hello from the fake.' });

    await removeInWsl(t, [file!, folder!]);
    expect((await run(['-d', t.distro, '-e', 'test', '-e', file!])).code).not.toBe(0);
    await run(['-d', t.distro, '-e', 'rm', '-rf', '--', config]);
  });
});
