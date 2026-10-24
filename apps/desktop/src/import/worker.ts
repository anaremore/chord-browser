/**
 * The import utility process (ARCHITECTURE.md §9, Import): finds other
 * browsers' profiles and reads them, so no file is parsed on main. Main starts
 * one for each step (finding, reading, history) and ends it afterwards,
 * removing its temp folder of copies. History goes back a batch at a time,
 * each one only when main asks for `more`, so chord-data sets the pace.
 */
import type { ImportedPage, ImportPreview } from '@chord/core';
import { detectProfiles, type FoundProfile, type ImportEnv } from './detect';
import { problemOf, type ImportProblemKind } from './files';
import { openHistory, readProfile } from './read';

export type ImportRequest =
  | { type: 'scan'; env: ImportEnv }
  | { type: 'read'; profile: FoundProfile; temp: string }
  | { type: 'history'; profile: FoundProfile; temp: string }
  | { type: 'more' };

export type ImportReply =
  | { type: 'profiles'; profiles: FoundProfile[] }
  | { type: 'preview'; preview: ImportPreview }
  | { type: 'pages'; pages: ImportedPage[] }
  | { type: 'done' }
  | { type: 'error'; problem: ImportProblemKind };

const reply = (message: ImportReply) => process.parentPort.postMessage(message);
const failed = (error: unknown) => reply({ type: 'error', problem: problemOf(error) });
process.on('uncaughtException', (error) => {
  failed(error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  failed(error);
  process.exit(1);
});

let history: { batches: Iterator<ImportedPage[]>; close(): void } | null = null;

/** The next batch of history, or done. */
function nextBatch(): void {
  if (!history) return reply({ type: 'done' });
  try {
    const next = history.batches.next();
    if (!next.done) return reply({ type: 'pages', pages: next.value });
    history.close();
    history = null;
    reply({ type: 'done' });
  } catch (error) {
    failed(error);
  }
}

process.parentPort.on('message', (event) => {
  const request = event.data as ImportRequest;
  switch (request.type) {
    case 'scan':
      detectProfiles(request.env).then((profiles) => reply({ type: 'profiles', profiles }), failed);
      return;
    case 'read':
      readProfile(request.profile, request.temp).then((preview) => reply({ type: 'preview', preview }), failed);
      return;
    case 'history':
      openHistory(request.profile, request.temp).then((opened) => {
        history = opened;
        nextBatch();
      }, failed);
      return;
    case 'more':
      nextBatch();
      return;
  }
});
