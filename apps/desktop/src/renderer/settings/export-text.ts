/**
 * What Your data's Export card says while Chord writes, and after (Settings → Your data, YourData.tsx). Plain
 * TypeScript, apart from the card, so it's tested without a renderer.
 */
import type { ExportProgress } from '@chord/ipc';

const numbers = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${numbers.format(n)} ${n === 1 ? one : many}`;

/** "3.8 MB", "640 KB". */
function fileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return plural(bytes, 'byte');
}

/** What the line under the bar says while Chord writes; once saved, with the passwords in it or how many were left out. */
export function exportText(p: ExportProgress): string {
  switch (p.phase) {
    case 'key':
      return 'Locking the file with your passphrase…';
    case 'setup':
      return 'Writing your setup…';
    case 'today':
      return 'Writing unpinned tabs…';
    case 'history':
      return `Writing history: ${numbers.format(p.done)} of ${plural(p.total, 'page')}`;
    case 'assistant':
      return `Writing assistant chats: ${numbers.format(p.done)} of ${plural(p.total, 'chat')}`;
    case 'done':
      return `Saved ${p.name}, ${fileSize(p.bytes ?? 0)}${p.passwords !== undefined ? `, with ${plural(p.passwords, 'password')}` : ''}${p.passwordsLeftOut ? `. Your ${plural(p.passwordsLeftOut, 'password')} ${p.passwordsLeftOut === 1 ? 'was' : 'were'} left out` : ''}${p.skipped ? `. ${plural(p.skipped, 'thing')} too big for the file (over 32 MB) stayed out.` : ''}`;
    case 'failed':
      if (p.problem === 'locked') return 'Your passwords locked while the file was written, so it wasn’t kept. Unlock them and save again.';
      return p.problem === 'read' ? 'Chord couldn’t read your data to write the file. Choose where to save to try again.' : 'Chord couldn’t save there. Choose another place.';
  }
}
