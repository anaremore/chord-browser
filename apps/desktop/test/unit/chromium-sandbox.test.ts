// Every Playwright launch of Electron in apps/*/test passes `chromiumSandbox: true`. On Linux, Playwright launches
// Electron with --no-sandbox unless told otherwise, and Chord never runs without its sandbox. (This was an ESLint
// no-restricted-syntax rule until the move to Oxlint, which has no selector rules.)
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const appsDir = join(repo, 'apps');
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const LAUNCH = /\belectron\s*\.\s*launch\s*\(/g;
const SANDBOX = /\bchromiumSandbox\s*:\s*true\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The text between the call's `(` at `open` and its matching `)`, skipping strings and comments. */
function callArguments(text: string, open: number): string {
  const end = (at: number) => (at === -1 ? text.length : at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') i = end(text.indexOf('\n', i));
    else if (ch === '/' && text[i + 1] === '*') i = end(text.indexOf('*/', i + 2)) + 1;
    else if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unbalanced call at offset ${open}`);
}

/** Each `electron.launch(...)` call in `text`, by line, and whether it passes `chromiumSandbox: true`. */
function launches(text: string): { line: number; sandboxed: boolean }[] {
  return [...text.matchAll(LAUNCH)].map((match) => {
    const open = match.index + match[0].length - 1;
    return { line: text.slice(0, match.index).split('\n').length, sandboxed: SANDBOX.test(callArguments(text, open)) };
  });
}

describe('chromiumSandbox on every Electron launch in tests', () => {
  it('reads a call across lines and past parentheses in strings', () => {
    const multiline = "await electron.launch({\n  args: [')', `(${x})`], // )\n  chromiumSandbox: true,\n})";
    expect(launches(multiline)).toEqual([{ line: 1, sandboxed: true }]);
    expect(launches("electron.launch({ args: [')'] }); x({ chromiumSandbox: true })")).toEqual([{ line: 1, sandboxed: false }]);
    expect(launches('electron.launch({ chromiumSandbox: false })')).toEqual([{ line: 1, sandboxed: false }]);
  });

  it('finds no launch in apps/*/test without it', () => {
    const self = resolve(import.meta.filename);
    const testDirs = readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(appsDir, d.name, 'test'));
    const files = testDirs.flatMap((dir) => {
      try {
        return sourceFiles(dir);
      } catch {
        return []; // an app without tests
      }
    });
    let seen = 0;
    const unsandboxed: string[] = [];
    for (const file of files) {
      if (resolve(file) === self) continue;
      for (const { line, sandboxed } of launches(readFileSync(file, 'utf8'))) {
        seen++;
        if (!sandboxed) unsandboxed.push(`${relative(repo, file).replaceAll('\\', '/')}:${line}`);
      }
    }
    expect(seen, 'the scan found no launches at all: has the test layout moved?').toBeGreaterThan(0);
    expect(unsandboxed, 'launch these with chromiumSandbox: true').toEqual([]);
  });
});
