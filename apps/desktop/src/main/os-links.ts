/**
 * How links reach Chord from the OS once it's the default browser
 * (ARCHITECTURE.md §15): the command lines other apps launch it with, and
 * Windows' record of which browser opens web links. Pure, so it's unit-tested.
 *
 * Windows passes a link after `--single-argument`, as Chrome's registration
 * does, so a crafted link can't add command-line switches. Linux passes them
 * as plain arguments (`%U`); a file the OS opens with Chord arrives as a path.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One click shouldn't open a flood of tabs, whatever the command line says. */
const MAX_URLS = 20;

/** A link or file Chord can open as a tab, as a URL; null for anything else. */
export function openable(text: string): string | null {
  const value = text.trim().replace(/^"(.*)"$/s, '$1');
  if (/^(https?|file):\/\//i.test(value)) {
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  }
  if (isAbsolute(value) && /\.(html?|xhtml)$/i.test(value)) return pathToFileURL(value).href;
  return null;
}

/** The URLs on a command line, in order, without duplicates. Switches and Chord's own paths are skipped. */
export function urlsFromArgv(argv: readonly string[]): string[] {
  const single = argv.indexOf('--single-argument');
  const candidates = single >= 0 ? argv.slice(single + 1, single + 2) : argv.filter((arg) => !arg.startsWith('-'));
  const urls: string[] = [];
  for (const candidate of candidates) {
    const url = openable(candidate);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length === MAX_URLS) break;
  }
  return urls;
}

/** The ProgId value in `reg query … /v ProgId` output, if there is one. */
export function progIdIn(regOutput: string): string | null {
  return /^\s*ProgId\s+REG_SZ\s+(\S+)\s*$/im.exec(regOutput)?.[1] ?? null;
}
