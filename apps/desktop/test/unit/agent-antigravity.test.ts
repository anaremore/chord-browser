/**
 * Settings → Agents' *Add to Antigravity* (S18): Chord's own `chord` entry under
 * `mcpServers` in Antigravity's MCP config, edited in place as JSONC (comments,
 * trailing commas, a BOM kept); a missing or blank file is `{}`, one that can't
 * be parsed is left alone, a symbolic link never written through; Undo takes out
 * only Chord's entry, while it's still Chord's. Where the file is, and the
 * command it holds.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { addToAntigravity, antigravityConfig, AntigravityUndos, undoAntigravity } from '../../src/main/agents/antigravity';
import { mcpArgv, type SetupWhere } from '../../src/main/agents/settings';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chord-antigravity-'));
  dirs.push(dir);
  return dir;
};

/** Antigravity's config in a home of its own, holding `text` (null: no file at all). */
function config(text: string | null): string {
  const file = antigravityConfig(temp(), {});
  if (text !== null) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return file;
}

const CHORD = { command: 'C:\\Program Files\\Chord\\Chord.exe', args: ['mcp'] };
const GITHUB = { command: 'gh-mcp', args: [], env: { A: '1' } };
const servers = (file: string) => (parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { mcpServers: Record<string, unknown> }).mcpServers;

describe('Add to Antigravity', () => {
  // [the config before, the servers after, the servers after Undo]
  const table: [string, string | null, Record<string, unknown>, Record<string, unknown>][] = [
    ['missing', null, { chord: CHORD }, {}],
    ['blank (Antigravity writes 0 bytes before any server)', '', { chord: CHORD }, {}],
    ['an empty object', '{}', { chord: CHORD }, {}],
    ['with other servers', JSON.stringify({ theme: 'dark', mcpServers: { github: GITHUB } }, null, 2), { github: GITHUB, chord: CHORD }, { github: GITHUB }],
    ['already with an older chord entry', JSON.stringify({ mcpServers: { chord: { command: '/old/chord', args: ['mcp'] } } }), { chord: CHORD }, { chord: { command: '/old/chord', args: ['mcp'] } }],
    ['JSONC: comments and a trailing comma', '{\n  // mine\n  "mcpServers": {\n    /* gh */ "github": {"command": "gh-mcp", "args": [], "env": {"A": "1"}},\n  },\n}\n', { github: GITHUB, chord: CHORD }, { github: GITHUB }],
    ['with a BOM', '\uFEFF{"mcpServers": {}}', { chord: CHORD }, {}],
  ];
  it.each(table)('%s: adds only chord, and Undo takes out only chord', (_what, before, after, undone) => {
    const file = config(before);
    const result = addToAntigravity(CHORD, file);
    if (!result.ok) throw new Error(`not added: ${result.why}`);
    expect(servers(file)).toEqual(after);
    // Written whole: nothing left beside it.
    expect(readdirSync(dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(undoAntigravity(result.undo)).toEqual({ ok: true });
    expect(servers(file)).toEqual(undone);
  });

  it('keeps the rest of a JSONC file as it was: its comments, its other keys, its BOM, the other servers', () => {
    const text = '\uFEFF{\n  // my servers\n  "theme": "dark", /* keep */\n  "mcpServers": {\n    "github": {"command": "gh-mcp", "args": []},\n  },\n}\n';
    const file = config(text);
    const result = addToAntigravity(CHORD, file);
    if (!result.ok) throw new Error('not added');
    const now = readFileSync(file, 'utf8');
    expect(now.startsWith('\uFEFF')).toBe(true);
    expect(now).toContain('// my servers');
    expect(now).toContain('"theme": "dark", /* keep */');
    // Inside mcpServers, the editor lays the servers out again; their values stay.
    expect(servers(file)['github']).toEqual({ command: 'gh-mcp', args: [] });
  });

  it('a file that can’t be parsed as JSONC, isn’t an object, or gives a key twice is left alone', () => {
    const twice = '{"mcpServers": {"chord": {"command": "a", "args": []}, "chord": {"command": "b", "args": []}}}';
    for (const text of ['{ not json', '[]', '"servers"', JSON.stringify({ mcpServers: ['chord'] }), twice, '{"mcpServers": {}, "mcpServers": {}}']) {
      const file = config(text);
      expect(addToAntigravity(CHORD, file), text).toEqual({ ok: false, why: 'invalid' });
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });

  it('a file with CRLF line endings keeps them, with no LF alone', () => {
    const file = config('{\r\n  "mcpServers": {\r\n    "github": {"command": "gh-mcp", "args": []}\r\n  }\r\n}\r\n');
    expect(addToAntigravity(CHORD, file).ok).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('"chord"');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('Undo by token: one that couldn’t read or write the file keeps its token to try again; done or changed, it goes', () => {
    const file = config(JSON.stringify({ mcpServers: { github: GITHUB } }));
    const undos = new AntigravityUndos(() => file);
    const added = undos.add(CHORD);
    if (!added.ok || !added.token) throw new Error('not added');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, '{ broken');
    expect(undos.undo(added.token)).toEqual({ ok: false, why: 'invalid' });
    writeFileSync(file, good);
    expect(undos.undo(added.token)).toEqual({ ok: true, token: null });
    expect(servers(file)).toEqual({ github: GITHUB });
    expect(undos.undo(added.token)).toEqual({ ok: false, why: 'gone' });
    // Changed since: nothing to undo, and the token goes.
    const again = undos.add(CHORD);
    if (!again.ok || !again.token) throw new Error('not added');
    writeFileSync(file, JSON.stringify({ mcpServers: { chord: { command: 'other', args: [] } } }));
    expect(undos.undo(again.token)).toEqual({ ok: false, why: 'changed' });
    expect(undos.undo(again.token)).toEqual({ ok: false, why: 'gone' });
  });

  it('Undo re-reads the file: what Antigravity changed meanwhile stays; a chord entry that isn’t Chord’s any more is left', () => {
    const file = config(JSON.stringify({ mcpServers: { github: GITHUB } }));
    const result = addToAntigravity(CHORD, file);
    if (!result.ok) throw new Error('not added');
    const text = readFileSync(file, 'utf8').replace('"github"', '"linear": {"command": "linear-mcp", "args": []},\n    "github"');
    writeFileSync(file, text);
    expect(undoAntigravity(result.undo)).toEqual({ ok: true });
    expect(servers(file)).toEqual({ linear: { command: 'linear-mcp', args: [] }, github: GITHUB });
    // Added again, then someone else's chord entry: Undo leaves it.
    const again = addToAntigravity(CHORD, file);
    if (!again.ok) throw new Error('not added');
    writeFileSync(file, JSON.stringify({ mcpServers: { chord: { command: 'other', args: [] } } }));
    expect(undoAntigravity(again.undo)).toEqual({ ok: false, why: 'changed' });
    expect(servers(file)).toEqual({ chord: { command: 'other', args: [] } });
    writeFileSync(file, '{ broken');
    expect(undoAntigravity(again.undo)).toEqual({ ok: false, why: 'invalid' });
  });

  it.skipIf(process.platform === 'win32')('a new file is 0600 in a 0700 folder; an existing one keeps its mode; a symbolic link is never written through', () => {
    const file = config(null);
    expect(addToAntigravity(CHORD, file).ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    const kept = config('{}');
    chmodSync(kept, 0o640);
    expect(addToAntigravity(CHORD, kept).ok).toBe(true);
    expect(statSync(kept).mode & 0o777).toBe(0o640);
    const target = join(temp(), 'elsewhere.json');
    writeFileSync(target, '{}');
    const link = config(null);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    expect(addToAntigravity(CHORD, link)).toEqual({ ok: false, why: 'link' });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  it('the file: ~/.gemini/config/mcp_config.json, under GEMINI_HOME if set; an older build’s only when it alone exists', () => {
    const home = temp();
    expect(antigravityConfig(home, {})).toBe(join(home, '.gemini', 'config', 'mcp_config.json'));
    const gemini = temp();
    expect(antigravityConfig(home, { GEMINI_HOME: gemini })).toBe(join(gemini, 'config', 'mcp_config.json'));
    const older = join(home, '.gemini', 'antigravity', 'mcp_config.json');
    mkdirSync(dirname(older), { recursive: true });
    writeFileSync(older, '');
    expect(antigravityConfig(home, {})).toBe(older);
    const current = join(home, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(dirname(current), { recursive: true });
    writeFileSync(current, '');
    expect(antigravityConfig(home, {})).toBe(current);
  });

  it('the entry runs the same command as the setup lines, as an argv (no shell quoting)', () => {
    const where = (over: Partial<SetupWhere>): SetupWhere => ({ platform: 'win32', packaged: true, exe: 'C:\\Program Files\\Chord\\Chord.exe', appPath: 'x', flatpak: null, ...over });
    expect(mcpArgv(where({}))).toEqual({ command: 'C:\\Program Files\\Chord\\Chord.exe', args: ['mcp'] });
    expect(mcpArgv(where({ platform: 'linux', exe: '/opt/Chord/chord' }))).toEqual({ command: '/opt/Chord/chord', args: ['--ozone-platform=headless', 'mcp'] });
    expect(mcpArgv(where({ platform: 'linux', exe: '/tmp/.mount/chord', appImage: '/home/me/Chord.AppImage' }))).toEqual({ command: '/home/me/Chord.AppImage', args: ['--ozone-platform=headless', 'mcp'] });
    expect(mcpArgv(where({ platform: 'linux', flatpak: 'io.github.anaremore.chord-browser' }))).toEqual({ command: 'flatpak', args: ['run', 'io.github.anaremore.chord-browser', 'mcp'] });
    expect(mcpArgv(where({ packaged: false, exe: 'Z:\\e\\electron.exe', appPath: 'Z:\\my app' }))).toEqual({ command: 'Z:\\e\\electron.exe', args: ['Z:\\my app', 'mcp'] });
  });
});
