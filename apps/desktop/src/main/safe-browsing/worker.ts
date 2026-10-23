/**
 * Safe Browsing's worker thread (ARCHITECTURE.md §14.1): it holds Google's
 * lists, decodes and checks their updates, saves them, and hashes the
 * addresses Chord checks, so none of that runs on main. It never touches the
 * network (main fetches, with the API key) and never writes what you browse:
 * only the lists, which are hashes of unsafe sites.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { SafeBrowsingDatabase, type Verdict } from './database';
import { batchGetFromJson, decodeBatchGet, decodeSearch, searchFromJson } from './proto';
import type { CheckResult, DueResult, OpenResult, UpdateResult, WorkerMessage, WorkerReply, WorkerRequest } from './protocol';

let db = new SafeBrowsingDatabase();
let file: string | null = null;
let savedAt: number | null = null;
/** Saves run one at a time, in order. */
let saving: Promise<void> = Promise.resolve();

const SAFE: Verdict = { verdict: 'safe' };

/** Saving finished (tests wait for it). */
export const saved = (): Promise<void> => saving;

function save(now: number): void {
  const path = file;
  if (!path) return;
  const bytes = db.serialize(now);
  // Written beside the old file, then swapped in, so a crash mid-write leaves the old lists whole.
  saving = saving
    .then(() => mkdir(dirname(path), { recursive: true }))
    .then(() => writeFile(`${path}.tmp`, bytes))
    .then(() => rename(`${path}.tmp`, path))
    .then(() => {
      savedAt = now;
    })
    .catch(() => {
      // Not saved: the next launch updates in full. Nothing else depends on it.
    });
}

/** One request, answered (exported for unit tests, which run it without a thread). */
export async function handle(message: WorkerRequest): Promise<unknown> {
  switch (message.type) {
    case 'open': {
      file = message.file;
      try {
        db = SafeBrowsingDatabase.parse(await readFile(message.file));
        savedAt = db.savedAt;
      } catch {
        db = new SafeBrowsingDatabase();
      }
      return { entries: db.entries, nextUpdateAt: db.nextUpdateAt(), savedAt } satisfies OpenResult;
    }
    case 'due':
      return {
        lists: db.due(message.now).map((l) => ({ name: l.name, version: l.version ? Buffer.from(l.version).toString('base64url') : null })),
        nextUpdateAt: db.nextUpdateAt(),
      } satisfies DueResult;
    case 'update': {
      const updates = message.json ? batchGetFromJson(JSON.parse(new TextDecoder().decode(message.body))) : decodeBatchGet(message.body);
      const failed = db.apply(updates, message.now);
      save(message.now);
      return { failed, entries: db.entries, nextUpdateAt: db.nextUpdateAt() } satisfies UpdateResult;
    }
    case 'defer':
      db.deferAll(message.at);
      save(Date.now());
      return null;
    case 'check': {
      const started = performance.now();
      const step = db.check(message.urls, message.purpose, message.now);
      return { ...step, took: performance.now() - started } satisfies CheckResult;
    }
    case 'searched': {
      // "If an error occurred (including network errors, HTTP errors, etc), return SAFE."
      if (!message.body) return SAFE;
      let answer;
      try {
        answer = message.json ? searchFromJson(JSON.parse(new TextDecoder().decode(message.body))) : decodeSearch(message.body);
      } catch {
        return SAFE;
      }
      if (!db.remember(message.prefixes, answer, message.now)) return SAFE;
      const step = db.check(message.urls, message.purpose, message.now);
      return step.verdict === 'unsafe' ? step : SAFE;
    }
    case 'forget':
      db.clearCache();
      return null;
  }
}

// One message at a time, in order: a check sent after `open` waits for the lists.
let queue: Promise<void> = Promise.resolve();
parentPort?.on('message', (message: WorkerMessage) => {
  queue = queue.then(async () => {
    let reply: WorkerReply;
    try {
      reply = { id: message.id, ok: true, result: await handle(message) };
    } catch (error) {
      reply = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    parentPort?.postMessage(reply);
  });
});
