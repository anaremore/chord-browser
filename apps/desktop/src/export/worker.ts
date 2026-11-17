/**
 * The export utility process, *Chord Export* (docs/decisions/S15-your-data.md
 * §7). Main starts one for each export with where to read and where to write,
 * and it does the rest itself, so main never holds the data and chord-data's
 * thread does nothing for it: it opens chord.db read-only, in one read
 * transaction (WAL gives it one moment's data while chord-data goes on
 * writing), turns rows into records (@chord/data/export), and writes them
 * through core's file writer to `<name>.part`, renamed once it's whole. It
 * says how far it's got at most ten times a second; main ends it after.
 *
 * **Passwords** (docs/decisions/S17-passwords.md decision 6) only into an
 * encrypted file: this process can't open the vault, so chord-data sends the
 * `login` records a page at a time over a port main made after checking the
 * vault's passphrase. They go into the encrypted frames and nowhere else; if
 * the vault locks part way, the file isn't kept.
 */
import type { MessagePortMain } from 'electron';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataHeader, encryptedWriter, plainWriter, type DataFileWriter, type DataPart, type DataRecord, type AssistantImage, type Platform } from '@chord/core';
import type { PasswordExportAsk, PasswordExportPage } from '@chord/data';
import { nodeCrypto, sha256Hex } from '@chord/data/crypto';
import { exportCounts, exportRecords, type ExportPhase } from '@chord/data/export';

export interface ExportJob {
  /** chord.db, opened read-only. */
  database: string;
  /** `<userData>/assistant/images`, for the images in the assistant's chats. */
  images: string;
  /** Where the file goes: written beside it as `.part` first. */
  target: string;
  device: string;
  /** The Chord writing it, for the header. */
  app: string;
  platform: Platform;
  history: boolean;
  assistant: boolean;
  /** Passwords too: with an encrypted file only, read over the port that comes with the job. */
  passwords: boolean;
  /** Passwords alone, no setup (Settings → Passwords → Export…). */
  passwordsOnly?: boolean;
  /** Null for a plain file. Kept only until the key is made. */
  passphrase: string | null;
}

export type ExportMessage = { type: 'run'; job: ExportJob };

export type ExportReply =
  /** `key`: the passphrase becoming the file's key (scrypt, about half a second). */
  | { type: 'progress'; phase: 'key' | ExportPhase; done: number; total: number; share: number }
  /** The file being written until it's whole: `<name>.part`, or the file itself (openPart). Main removes it if the process goes. */
  | { type: 'writing'; path: string }
  /** `skipped`: records longer than a reader takes, left out (a line is at most 32 MB). `passwords`: how many went in. */
  | { type: 'done'; bytes: number; skipped: number; passwords?: number }
  /** `write`: the file couldn't be written there; `read`: Chord's data couldn't be read; `locked`: the vault locked while its passwords were read. */
  | { type: 'error'; problem: 'write' | 'read' | 'locked' };

const reply = (message: ExportReply) => process.parentPort.postMessage(message);
const PROGRESS_MS = 100;
/** Bytes gathered before each write to the file. */
const CHUNK = 1024 * 1024;

const EXTENSIONS: Record<AssistantImage['mime'], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const readOrNull = (path: string): Uint8Array | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

/** SQLite's errors are Chord's data not reading; anything else (the folder, the disk) is the file not writing. */
const problemOf = (error: unknown): 'write' | 'read' | 'locked' =>
  error instanceof LockedError ? 'locked' : (error as { code?: unknown })?.code === 'ERR_SQLITE_ERROR' ? 'read' : 'write';

/** The vault locked (or chord-data went) while its passwords were read: a file with some of them isn't kept. */
class LockedError extends Error {}

/** Sign-ins per page asked of chord-data. */
const LOGIN_PAGE = 100;

/** chord-data's pages of `login` records, over the port main made: each asked for once the last is in. */
async function* loginRecords(port: MessagePortMain): AsyncGenerator<DataRecord> {
  const answers: ((page: PasswordExportPage) => void)[] = [];
  port.on('message', ({ data }) => answers.shift()?.(data as PasswordExportPage));
  port.on('close', () => {
    for (const answer of answers.splice(0)) answer({ ok: false, error: 'locked' });
  });
  port.start();
  const ask = (request: PasswordExportAsk) =>
    new Promise<PasswordExportPage>((resolve) => {
      answers.push(resolve);
      port.postMessage(request);
    });
  for (let after = ''; ; ) {
    const page = await ask({ after, limit: LOGIN_PAGE });
    if (!page.ok) throw new LockedError('locked');
    yield* page.records;
    if (page.last === null) return;
    after = page.last;
  }
}

/**
 * Where the file is written until it's whole: `<name>.part` beside it, renamed
 * at the end. A sandbox's document portal (the Flatpak, saving outside
 * Downloads) lets Chord write the file it was given and nothing beside it:
 * then it's written in place.
 */
function openPart(target: string): { fd: number; path: string } {
  try {
    return { fd: openSync(`${target}.part`, 'w'), path: `${target}.part` };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
    return { fd: openSync(target, 'w'), path: target };
  }
}

async function run(job: ExportJob, port: MessagePortMain | null): Promise<void> {
  // Passwords never go into a plain file, whatever asked.
  const passwords = job.passwords && job.passphrase !== null ? port : null;
  if (!passwords) port?.close();
  let part: string | null = null;
  let fd: number | null = null;
  const db = new DatabaseSync(job.database, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN');
    const sql = (text: string) => db.prepare(text);
    const counts = exportCounts(sql);
    const messages = job.assistant ? Number((db.prepare('SELECT COUNT(*) AS n FROM assistant_message').get() as { n: number }).n) : 0;
    // The bar: records written of about how many there'll be. Setup is small beside history.
    const estimate =
      1 + counts.chords + counts.pinnedTabs + counts.folders + counts.todayTabs + counts.favorites + counts.themes + counts.routes + counts.effects + (job.history ? counts.pages : 0) + (job.assistant ? counts.chats + messages + counts.images : 0);
    const only = job.passwordsOnly === true && passwords !== null;
    const includes: DataPart[] = [
      ...(only ? [] : (['setup', 'today'] as const)),
      ...(job.history ? (['history'] as const) : []),
      ...(job.assistant ? (['assistant'] as const) : []),
      ...(passwords ? (['passwords'] as const) : []),
    ];
    const header = dataHeader({ app: job.app, device: job.device, created: Date.now(), includes });
    let writer: DataFileWriter;
    if (job.passphrase === null) writer = plainWriter(header);
    else {
      reply({ type: 'progress', phase: 'key', done: 0, total: 0, share: 0 });
      writer = await encryptedWriter(header, job.passphrase, nodeCrypto);
      job.passphrase = null;
    }

    ({ fd, path: part } = openPart(job.target));
    reply({ type: 'writing', path: part });
    const file = fd;
    let pending: Uint8Array[] = [];
    let size = 0;
    const flush = () => {
      writeSync(file, Buffer.concat(pending));
      pending = [];
      size = 0;
    };
    const append = (chunks: Uint8Array[]) => {
      for (const bytes of chunks) {
        pending.push(bytes);
        size += bytes.length;
      }
    };
    append([writer.head]);

    let written = 0;
    let phase: 'key' | ExportPhase = 'setup';
    let done = 0;
    let lastReport = 0;
    const report = (now: number) => {
      lastReport = now;
      const total = phase === 'history' ? counts.pages : phase === 'assistant' ? counts.chats : 0;
      reply({ type: 'progress', phase, done, total, share: Math.min(0.99, written / estimate) });
    };
    report(performance.now());
    const records = exportRecords(sql, {
      device: job.device,
      platform: job.platform,
      history: job.history,
      assistant: job.assistant,
      sha256: sha256Hex,
      image: (image) => {
        const data = readOrNull(join(job.images, `${image.id}.${EXTENSIONS[image.mime] ?? 'jpg'}`));
        return data ? { data, thumb: readOrNull(join(job.images, `${image.id}.thumb.jpg`)) } : null;
      },
    });
    for (const item of only ? [] : records) {
      append(writer.add(item.record));
      written++;
      if (item.phase !== phase) {
        phase = item.phase;
        done = 0;
      }
      if ((phase === 'history' && item.record.type === 'page') || (phase === 'assistant' && item.record.type === 'thread')) done++;
      if (size >= CHUNK) {
        flush();
        // Let the progress out, and anything main sends, between chunks.
        await new Promise((resolve) => setImmediate(resolve));
      }
      const now = performance.now();
      if (now - lastReport >= PROGRESS_MS) report(now);
    }
    // Passwords last, inside the encrypted frames only.
    let logins = 0;
    if (passwords) {
      for await (const record of loginRecords(passwords)) {
        append(writer.add(record));
        logins++;
        if (size >= CHUNK) flush();
      }
      passwords.close();
    }
    append(writer.end());
    flush();
    fsyncSync(file);
    closeSync(file);
    fd = null;
    db.exec('COMMIT');
    if (part !== job.target) renameSync(part, job.target);
    if (writer.skipped > 0) console.error(`Export: left out ${writer.skipped} records longer than a file's lines may be`);
    reply({ type: 'done', bytes: statSync(job.target).size, skipped: writer.skipped, ...(passwords ? { passwords: logins } : {}) });
  } catch (error) {
    console.error('Export failed:', error);
    if (fd !== null) closeSync(fd);
    if (part) rmSync(part, { force: true });
    reply({ type: 'error', problem: problemOf(error) });
  } finally {
    passwords?.close();
    db.close();
  }
}

process.parentPort.on('message', (event) => {
  const message = event.data as ExportMessage;
  if (message.type === 'run') {
    run(message.job, event.ports[0] ?? null).catch((error: unknown) => {
      console.error('Export failed:', error);
      reply({ type: 'error', problem: problemOf(error) });
    });
  }
});
