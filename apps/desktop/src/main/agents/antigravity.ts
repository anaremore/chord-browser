/**
 * Settings → Agents' *Add to Antigravity* (S18; the owner's mock B, 2026-11-21):
 * Chord's entry, `chord`, under `mcpServers` in Antigravity's MCP config, as
 * `{command, args}`: this Chord's own `mcp`, the same command the Claude Code
 * and Codex lines give, as a real argv (Antigravity starts it without a shell,
 * so nothing is quoted).
 *
 * - **Only that entry changes.** The file is JSONC as Antigravity reads it
 *   (comments, trailing commas, a BOM): it's edited in place, so every other
 *   server, key, comment and its layout stay as they were. Missing or blank is
 *   `{}` (Antigravity writes an empty file before any server exists); a file
 *   that can't be parsed, or isn't an object, is left alone and the user told.
 * - **Undo** takes out only `mcpServers.chord`, and only while it's still the
 *   entry Chord wrote, putting back the one before if there was one. It reads
 *   the file again first: Antigravity rewrites it itself.
 * - **Safely written:** atomically (a file beside it, then a rename); a new
 *   file is 0600 in a 0700 folder, an existing one keeps its mode; a symbolic
 *   link is never written through.
 * - **Where:** `<GEMINI_HOME or ~/.gemini>/config/mcp_config.json`, the global
 *   file Google's docs name on every OS. Older builds read
 *   `…/antigravity/mcp_config.json`: if only that one exists, it's the one the
 *   installed Antigravity uses, so it's the one changed.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

/** An MCP server as Antigravity lists it. */
export interface McpServerEntry {
  command: string;
  args: string[];
}

/** Antigravity's global MCP config: the current file, or an older build's if only that one exists. */
export function antigravityConfig(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const base = env['GEMINI_HOME'] || join(home, '.gemini');
  const current = join(base, 'config', 'mcp_config.json');
  const older = join(base, 'antigravity', 'mcp_config.json');
  return !exists(current) && exists(older) ? older : current;
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** What Undo needs: the file, the entry Chord wrote, and the one before it (undefined: none). */
export interface AntigravityUndo {
  file: string;
  wrote: McpServerEntry;
  before: unknown;
}

/** `invalid`: not JSONC Chord can read, or not an object; `link`: a symbolic link; `unwritable`: couldn't be read or written; `changed`: Chord's entry isn't the one it wrote any more. */
export type AntigravityProblem = 'invalid' | 'link' | 'unwritable' | 'changed';

const BOM = '\uFEFF';
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The file as text and parsed: missing is null text. Null for one Chord won't touch. */
function load(file: string): { text: string | null; config: Json; mode: number | null } | AntigravityProblem {
  let mode: number | null = null;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return 'link';
    mode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unwritable';
  }
  let text: string | null = null;
  if (mode !== null) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return 'unwritable';
    }
  }
  const body = (text ?? '').replace(/^\uFEFF/, '');
  if (body.trim() === '') return { text, config: {}, mode };
  const errors: ParseError[] = [];
  const config: unknown = parse(body, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !isObject(config)) return 'invalid';
  const servers = config['mcpServers'];
  if (servers !== undefined && !isObject(servers)) return 'invalid';
  return { text, config, mode };
}

/** `chord`'s new value (undefined: none) set in the file's text, keeping everything else as it was. */
function edited(text: string | null, value: unknown): string {
  const bom = text?.startsWith(BOM) ? BOM : '';
  const body = (text ?? '').replace(/^\uFEFF/, '');
  const base = body.trim() === '' ? '{}' : body;
  const next = applyEdits(base, modify(base, ['mcpServers', 'chord'], value, FORMAT));
  return bom + (next.endsWith('\n') || body.trim() !== '' ? next : `${next}\n`);
}

/** Written beside it, then renamed over it: a reader never sees half a file. New: 0600 in a 0700 folder; existing: its mode. */
function writeAtomic(file: string, text: string, mode: number | null): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { mode: mode ?? 0o600 });
    if (mode !== null) chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Chord's entry in the config: added, or put in place of the one there. */
export function addToAntigravity(entry: McpServerEntry, file = antigravityConfig()): { ok: true; undo: AntigravityUndo } | { ok: false; why: AntigravityProblem } {
  const now = load(file);
  if (typeof now === 'string') return { ok: false, why: now };
  const servers = now.config['mcpServers'] as Json | undefined;
  const wrote = { command: entry.command, args: [...entry.args] };
  try {
    writeAtomic(file, edited(now.text, wrote), now.mode);
  } catch {
    return { ok: false, why: 'unwritable' };
  }
  return { ok: true, undo: { file, wrote, before: servers?.['chord'] } };
}

/** Undo: Chord's entry out (or the one before back), only while it's still the one Chord wrote. */
export function undoAntigravity(undo: AntigravityUndo): { ok: true } | { ok: false; why: AntigravityProblem } {
  const now = load(undo.file);
  if (typeof now === 'string') return { ok: false, why: now };
  const servers = now.config['mcpServers'] as Json | undefined;
  if (!same(servers?.['chord'], undo.wrote)) return { ok: false, why: 'changed' };
  try {
    writeAtomic(undo.file, edited(now.text, undo.before), now.mode);
  } catch {
    return { ok: false, why: 'unwritable' };
  }
  return { ok: true };
}
