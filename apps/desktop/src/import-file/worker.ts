/**
 * The process that imports a Chord file, *Chord Import*
 * (docs/decisions/S15-your-data.md §5, §7), so nothing of a file from
 * elsewhere is parsed on main, and a big one never sits anywhere whole. Main
 * starts one for each file you choose, with its path and where Chord keeps
 * its data. It reads the file a megabyte at a time through core's reader
 * (`openDataFile`): plain, or opened with your passphrase, whose key it keeps
 * only while it lives. Everything in the file is untrusted, and checked here
 * first, record by record, by the codecs restore uses.
 *
 * - **Open:** one pass counts it. Setup, Today tabs and icons are kept (they're
 *   small); history and chats are only counted, against what's here, over a
 *   read-only connection to chord.db of its own, as the export process reads.
 * - **Plan:** on *Import*, this computer's setup is read again (main has
 *   written what was pending) and weighed against the file's (core's
 *   planMerge); main asks for the plan a part at a time and applies each.
 * - **The rest:** a second pass sends history and chats straight to
 *   chord-data, a batch at a time over a port, each once the last is written,
 *   and writes the chats' images, each checked to be the picture it says.
 *
 * Main ends the process after, or when you let the file go.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  DATA_HEAD,
  DUET_SCOPES,
  imageFromRecord,
  mergeParts,
  messageFromRecord,
  openDataFile,
  pageFromRecord,
  planMerge,
  threadFromRecord,
  uuidv7,
  type DataFileOpen,
  type DataFileProblem,
  type DataRecord,
  type DuetImage,
  type DuetMessage,
  type DuetScope,
  type DuetThread,
  type ImportedPage,
  type MergePart,
  type Platform,
  type SiteEffects,
} from '@chord/core';
import type { ImportBatch, ImportBatchReply } from '@chord/data';
import { nodeCrypto, sha256Hex } from '@chord/data/crypto';
import { chatsHere, localRecords, pagesHere } from '@chord/data/import-file';
import type { FileImportChoices, FileImportCounts, FileImportPreview, FileImportProblem } from '@chord/ipc';
import type { MessagePortMain } from 'electron';
import { writeImage } from './images';

export interface FileJob {
  /** The file you chose. */
  path: string;
  /** chord.db, opened read-only. */
  database: string;
  /** `<userData>/duet/images`, where a chat's images go. */
  images: string;
  /** This computer's id: a file it wrote says so. */
  device: string;
  platform: Platform;
}

export type FileRequest =
  /** Open the file (with its passphrase, if it's encrypted) and count what it would bring. */
  | { type: 'open'; job: FileJob; passphrase: string | null }
  /** Plan the import against what's here now; `chordId` is the chord you're in, for chats whose chord isn't here; `scope`, what a new chat may read. */
  | { type: 'plan'; choices: FileImportChoices; chordId: string; scope: DuetScope }
  /** The plan's next part. */
  | { type: 'more' }
  /** History and chats to chord-data, over the port that comes with this request. */
  | { type: 'rest' };

export type FileReply =
  /** Still reading a long file: main waits on. */
  | { type: 'reading' }
  | { type: 'opened'; preview: Omit<FileImportPreview, 'fileId' | 'name'> }
  | { type: 'problem'; problem: FileImportProblem }
  /** How many parts follow, and what the import brings, for the toast. */
  | { type: 'plan'; parts: number; counts: FileImportCounts; history: number }
  | { type: 'part'; part: MergePart }
  /** Effects go to main's Effects service, which sanitizes each site's stylesheet again. */
  | { type: 'effects'; sites: SiteEffects[] }
  | { type: 'planned' }
  /** A batch of history is written: `added` pages gained visits, `done` of the file's pages are through. */
  | { type: 'pages'; added: number; done: number }
  /** Chats chord-data added, and images written, for Undo. */
  | { type: 'chats'; threads: string[]; images: DuetImage[] }
  | { type: 'done' }
  | { type: 'error' };

/** Bytes read at a time. */
const CHUNK = 1024 * 1024;
/**
 * History per batch, whichever fills first: each is one transaction on
 * chord-data's thread, which answers the command bar's searches between them,
 * so a batch stays well within a keystroke's 16 ms. 50 pages of a 50,000-visit
 * profile took 1–2 ms each (S15 §12); what can take longer is SQLite's
 * checkpoint, kept small while an import writes (ChordDatabase.importing).
 */
const PAGES_PER_BATCH = 50;
const VISITS_PER_BATCH = 1000;
/** Reports of how far history has got, at most this often. */
const PROGRESS_MS = 100;
/** Threads and messages per batch of chats. */
const CHATS_PER_BATCH = 200;
/** Effects' sites per part: each up to 64 KB of CSS. */
const SITES_PER_PART = 25;
/** The most setup a file may bring (records): far past any profile, and what keeps a hostile one from filling memory. */
const MAX_SETUP = 100_000;
const SETUP: ReadonlySet<string> = new Set(['chord', 'folder', 'tab', 'split', 'favorite', 'theme', 'settings', 'route', 'effects', 'icon', 'zoom', 'permission']);
/** Types a file has that an import passes over without counting them as a newer Chord's: sync's. */
const QUIET: ReadonlySet<string> = new Set(['page', 'thread', 'message', 'image', 'device']);

const reply = (message: FileReply) => process.parentPort.postMessage(message);
// Background work: what you're doing meanwhile (typing, chord-data answering it) comes first for the CPUs.
try {
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Not allowed here: it runs at the usual priority.
}
process.on('uncaughtException', (error) => {
  console.error('Import failed:', error);
  reply({ type: 'error' });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('Import failed:', error);
  reply({ type: 'error' });
  process.exit(1);
});

/** The file opened, and what of it is kept: its setup, and the choices the plan was made with. */
let opened: { job: FileJob; file: DataFileOpen; setup: DataRecord[]; pages: number } | null = null;
let planned: { parts: FileReply[]; at: number; chordIds: Set<string>; chordId: string; choices: FileImportChoices; scope: DuetScope } | null = null;

const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

/** Every record from the file's `start` on, a chunk at a time; `each` may wait (chord-data's answer), so records never pile up. */
async function readRecords(file: DataFileOpen, path: string, each: (records: DataRecord[]) => void | Promise<void>): Promise<DataFileProblem | null> {
  const stream = file.records();
  if (!stream) return file.problem;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    let beat = performance.now();
    for (let position = file.start; ; ) {
      const n = readSync(fd, buffer, 0, CHUNK, position);
      if (n === 0) break;
      position += n;
      const records = stream.push(buffer.subarray(0, n));
      if (records.length > 0) await each(records);
      // A long file: main hears that it's still being read, and anything main sends gets in.
      if (performance.now() - beat > 1000) {
        reply({ type: 'reading' });
        beat = performance.now();
        await yieldNow();
      }
    }
    const rest = stream.end();
    if (rest.length > 0) await each(rest);
    return stream.problem;
  } finally {
    closeSync(fd);
  }
}

/** chord.db as it is now, read-only, in one read transaction, for `work`, then closed: chord-data goes on writing meanwhile, and never waits for it. */
async function withDatabase<T>(path: string, work: (sql: (text: string) => ReturnType<DatabaseSync['prepare']>) => T | Promise<T>): Promise<T> {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN');
    const result = await work((text) => db.prepare(text));
    db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}

const PROBLEMS: Record<DataFileProblem, FileImportProblem> = {
  'not-chord': 'not-chord',
  newer: 'newer',
  'needs-passphrase': 'needs-passphrase',
  'wrong-passphrase': 'wrong-passphrase',
  // Its header (or envelope) is: nothing after it can be told apart.
  damaged: 'unreadable',
  'cut-short': 'unreadable',
};

async function open(job: FileJob, passphrase: string | null): Promise<FileReply> {
  opened?.file.close();
  opened = null;
  planned = null;
  let head: Buffer;
  let size: number;
  try {
    const fd = openSync(job.path, 'r');
    try {
      size = fstatSync(fd).size;
      head = Buffer.alloc(Math.min(size, DATA_HEAD));
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { type: 'problem', problem: 'unreadable' };
  }
  const file = await openDataFile(head, size, passphrase, nodeCrypto);
  if (file.problem || !file.header) return { type: 'problem', problem: PROBLEMS[file.problem ?? 'not-chord'] };

  // One pass: setup kept, history and chats counted against what's here.
  const setup: DataRecord[] = [];
  const history = { pages: 0, newPages: 0 };
  const duet = { chats: 0, newChats: 0, images: 0 };
  let unknown = 0;
  let tooMuch = false;
  const problem = await withDatabase(job.database, (sql) => {
    const pageHere = pagesHere(sql);
    const chats = chatsHere(sql);
    return readRecords(file, job.path, (records) => {
      for (const r of records) {
        if (r.type === 'page') {
          const page = pageFromRecord(r);
          if (!page) continue;
          history.pages++;
          if (!pageHere(page.url)) history.newPages++;
        } else if (r.type === 'thread') {
          const thread = threadFromRecord(r);
          if (!thread) continue;
          duet.chats++;
          if (!chats.has(thread.id)) duet.newChats++;
        } else if (r.type === 'image') duet.images++;
        else if (SETUP.has(r.type)) {
          if (setup.length < MAX_SETUP) setup.push(r);
          else tooMuch = true;
        } else if (!QUIET.has(r.type)) unknown++;
      }
    });
  });
  const damaged = problem !== null || tooMuch;
  const plan = await withDatabase(job.database, (sql) =>
    planMerge({
      local: localRecords(sql, { device: job.device, platform: job.platform, sha256: sha256Hex }),
      file: setup,
      choices: { effects: true, settings: true },
      platform: job.platform,
      now: Date.now(),
      newId: uuidv7,
    }),
  );
  opened = { job, file, setup, pages: history.pages };
  const created = Number.isNaN(Date.parse(file.header.created)) ? '' : file.header.created;
  return {
    type: 'opened',
    preview: {
      encrypted: file.encrypted,
      thisComputer: file.header.device === job.device,
      created,
      app: file.header.app,
      newProfile: plan.newProfile,
      counts: plan.counts,
      history,
      duet,
      effects: plan.effectsSites,
      settings: plan.changes,
      skipped: unknown + plan.skipped,
      damaged,
    },
  };
}

/** The plan against what's here now, as parts for main to apply: setup, then Effects' sites. */
async function plan(request: Extract<FileRequest, { type: 'plan' }>): Promise<FileReply> {
  if (!opened) return { type: 'error' };
  const { job, setup } = opened;
  const result = await withDatabase(job.database, (sql) =>
    planMerge({
      local: localRecords(sql, { device: job.device, platform: job.platform, sha256: sha256Hex }),
      file: setup,
      choices: { effects: request.choices.effects, settings: request.choices.settings },
      platform: job.platform,
      now: Date.now(),
      newId: uuidv7,
    }),
  );
  const parts: FileReply[] = mergeParts(result).map((part) => ({ type: 'part', part }));
  for (let at = 0; at < result.effects.length; at += SITES_PER_PART) parts.push({ type: 'effects', sites: result.effects.slice(at, at + SITES_PER_PART) });
  const chordIds = new Set(result.chordIds);
  planned = { parts, at: 0, chordIds, chordId: chordIds.has(request.chordId) ? request.chordId : (result.chordIds[0] ?? request.chordId), choices: request.choices, scope: request.scope };
  const both = (key: 'chords' | 'favorites' | 'pinnedTabs' | 'todayTabs' | 'folders' | 'themes' | 'routes' | 'zoom' | 'blocks') => result.counts.new[key] + result.counts.newer[key];
  return {
    type: 'plan',
    parts: parts.length,
    counts: {
      chords: both('chords'),
      tabs: both('pinnedTabs') + both('todayTabs'),
      favorites: both('favorites'),
      other: both('folders') + both('themes') + both('routes') + both('zoom') + both('blocks'),
      effects: result.effects.length,
      settings: result.settings ? result.changes.length : 0,
      pages: 0,
      chats: 0,
    },
    history: request.choices.history ? opened.pages : 0,
  };
}

/** What a chat imported from a file may read: the narrower of what it could and what a new chat may (Settings → Duet), never more. */
const narrower = (a: DuetScope, b: DuetScope): DuetScope => (DUET_SCOPES.indexOf(a) <= DUET_SCOPES.indexOf(b) ? a : b);

/** The images a message names. */
const imagesOf = (message: DuetMessage): DuetImage[] => (message.body.role === 'user' || message.body.role === 'assistant' ? (message.body.images ?? []) : []);

/** History and chats, the file's second pass, straight to chord-data a batch at a time: the next once it has written the last. */
async function rest(port: MessagePortMain): Promise<void> {
  if (!opened || !planned) throw new Error('nothing planned');
  const { job, file } = opened;
  const { choices, chordIds, chordId, scope } = planned;
  const answers: ((answer: ImportBatchReply) => void)[] = [];
  port.on('message', ({ data }) => answers.shift()?.(data as ImportBatchReply));
  // chord-data went away (it's restarted on a crash): what's waiting fails.
  port.on('close', () => {
    for (const answer of answers.splice(0)) answer({ ok: false, error: 'chord-data closed' });
  });
  port.start();
  const send = (batch: ImportBatch) =>
    new Promise<ImportBatchReply>((resolve) => {
      answers.push(resolve);
      port.postMessage(batch);
    });

  let pages: ImportedPage[] = [];
  let visits = 0;
  let done = 0;
  // How far it's got, at most ten times a second: main passes each report on to Settings.
  let added = 0;
  let reported = 0;
  const report = (now = false) => {
    if (!now && performance.now() - reported < PROGRESS_MS) return;
    reported = performance.now();
    reply({ type: 'pages', added, done });
    added = 0;
  };
  const flushPages = async () => {
    if (pages.length === 0) return;
    const answer = await send({ pages });
    if (!answer.ok) throw new Error(answer.error);
    done += pages.length;
    added += answer.added;
    report();
    pages = [];
    visits = 0;
  };
  let threads: DuetThread[] = [];
  let messages: DuetMessage[] = [];
  const wanted = new Set<string>();
  const flushChats = async () => {
    if (threads.length === 0 && messages.length === 0) return;
    const answer = await send({ duet: { threads, messages } });
    if (!answer.ok) throw new Error(answer.error);
    reply({ type: 'chats', threads: answer.threads ?? [], images: [] });
    threads = [];
    messages = [];
  };
  const now = Date.now();
  try {
    await readRecords(file, job.path, async (records) => {
      for (const r of records) {
        if (r.type === 'page' && choices.history) {
          const page = pageFromRecord(r);
          if (!page) continue;
          pages.push({ url: page.url, title: page.title, visits: page.visits, typed: [], typedCount: page.typed });
          visits += page.visits.length;
          if (pages.length >= PAGES_PER_BATCH || visits >= VISITS_PER_BATCH) await flushPages();
        } else if (r.type === 'thread' && choices.duet) {
          await flushPages();
          const thread = threadFromRecord(r);
          if (!thread) continue;
          // Into a chord that's here once it's in, else the one you're in; reading no more than a new chat would; marked, so its turns stay data.
          threads.push({ ...thread, chordId: chordIds.has(thread.chordId) ? thread.chordId : chordId, scope: narrower(thread.scope, scope), providerSessionId: null, importedAt: now });
          if (threads.length + messages.length >= CHATS_PER_BATCH) await flushChats();
        } else if (r.type === 'message' && choices.duet) {
          const message = messageFromRecord(r);
          if (!message) continue;
          messages.push(message);
          for (const image of imagesOf(message)) wanted.add(image.id);
          if (threads.length + messages.length >= CHATS_PER_BATCH) await flushChats();
        } else if (r.type === 'image' && choices.duet) {
          const image = imageFromRecord(r);
          if (!image || !wanted.has(image.image.id)) continue;
          const written = writeImage(image, job.images);
          if (written) reply({ type: 'chats', threads: [], images: [written] });
        }
      }
    });
    await flushPages();
    if (choices.history) report(true);
    await flushChats();
    reply({ type: 'done' });
  } finally {
    port.close();
  }
}

process.parentPort.on('message', (event) => {
  const request = event.data as FileRequest;
  switch (request.type) {
    case 'open':
      open(request.job, request.passphrase).then(reply, (error: unknown) => {
        console.error('Import failed:', error);
        reply({ type: 'problem', problem: 'unreadable' });
      });
      return;
    case 'plan':
      plan(request).then(reply, (error: unknown) => {
        console.error('Import failed:', error);
        reply({ type: 'error' });
      });
      return;
    case 'more': {
      if (!planned || planned.at >= planned.parts.length) return reply({ type: 'planned' });
      reply(planned.parts[planned.at++]!);
      return;
    }
    case 'rest': {
      const port = event.ports[0];
      if (!port) return reply({ type: 'error' });
      rest(port).catch((error: unknown) => {
        console.error('Import failed:', error);
        reply({ type: 'error' });
      });
      return;
    }
  }
});
