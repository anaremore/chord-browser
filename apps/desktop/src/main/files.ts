/** File naming for downloads (pure, so it's unit-testable). */
import { extname, join, posix } from 'node:path';

/** Characters no OS allows in a file name, plus control characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

/** A suggested name made safe to save: no folders, no reserved characters, not empty. */
export function safeFilename(suggested: string): string {
  // POSIX rules after normalizing slashes, so "a:b" isn't read as a Windows drive.
  const name = posix.basename(suggested.replace(/\\/g, '/')).replace(UNSAFE, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return name || 'download';
}

/** `report.pdf`, then `report (1).pdf`, `report (2).pdf`… whichever isn't taken yet. */
export function uniquePath(dir: string, filename: string, exists: (path: string) => boolean): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = join(dir, filename);
  for (let n = 1; exists(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}
