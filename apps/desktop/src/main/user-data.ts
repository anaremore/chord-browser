/**
 * Which profile directory a run uses, when it isn't the default. Chrome's
 * `--user-data-dir=<path>` works in every build, so a packaged Chord can be
 * smoke-tested without touching a real profile. Development builds also read
 * CHORD_USER_DATA (tests and spikes). Chromium parses the switch (only the
 * `=` form; an empty value means unset) and resolves a relative path against
 * the working directory; this matches it.
 */
import { resolve } from 'node:path';

export function userDataOverride(switchValue: string, devOverride: string | undefined, cwd: string): string | null {
  const dir = switchValue || devOverride;
  return dir ? resolve(cwd, dir) : null;
}
