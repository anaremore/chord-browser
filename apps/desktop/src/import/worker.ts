/**
 * The import utility process (ARCHITECTURE.md §9, Import), so no other
 * browser's file is parsed, and no import is planned, on main. Main starts
 * one to find browsers, and one for each profile you pick: it reads the
 * profile from copies of its files (in its temp folder), keeps what it read,
 * and when you import, plans where everything lands and hands main the
 * chords, folders and tabs a part at a time, as main asks. History goes
 * straight to chord-data over a port, a batch at a time, each once the last
 * is written; main only hears how far it's got. Main ends the process
 * afterwards and removes its temp folder.
 */
import { overviewOf, planImport, uuidv7, type Chord, type ChordThemeSpec, type Favorite, type ImportChoices, type ImportContext, type ImportOverview, type ImportPlan, type ImportPreview, type SidebarNode } from '@chord/core';
import type { ImportBatch, ImportBatchReply } from '@chord/data';
import type { MessagePortMain } from 'electron';
import { detectProfiles, type FoundProfile, type ImportEnv } from './detect';
import { ImportProblem, problemOf, type ImportProblemKind } from './files';
import { openHistory, readProfile } from './read';

export type ImportRequest =
  | { type: 'scan'; env: ImportEnv }
  /** Read a profile and keep it; `chordId` is where groups go to start with. */
  | { type: 'read'; profile: FoundProfile; temp: string; chordId: string }
  | { type: 'plan'; importId: string; choices: ImportChoices; context: ImportContext; themes: ChordThemeSpec[]; fallbackChordId: string }
  /** The plan's next part of folders and tabs. */
  | { type: 'more' }
  /** Send the history to chord-data, over the port that comes with this request. */
  | { type: 'history'; importId: string };

export type ImportReply =
  | { type: 'profiles'; profiles: FoundProfile[] }
  | { type: 'overview'; overview: ImportOverview }
  /** The new chords and favorites, what the plan brings, and how many folders and tabs will follow. */
  | { type: 'plan'; chords: Chord[]; favorites: Favorite[]; counts: ImportPlan['counts']; nodes: number }
  | { type: 'nodes'; nodes: SidebarNode[] }
  /** Every part has been sent. */
  | { type: 'planned' }
  /** A batch of history is written. */
  | { type: 'pages'; added: number }
  | { type: 'done' }
  | { type: 'error'; problem: ImportProblemKind };

/** Folders and tabs per part: each part is one store change on main, small enough to fit in a frame. */
const NODES_PER_PART = 200;

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

/** The profile read, kept for the import. */
let kept: { profile: FoundProfile; temp: string; preview: ImportPreview } | null = null;
/** The plan's folders and tabs not yet sent. */
let parts: { nodes: SidebarNode[]; at: number } | null = null;

/** History to chord-data, a batch at a time: the next once chord-data has written the last. */
async function sendHistory(port: MessagePortMain): Promise<void> {
  if (!kept) throw new ImportProblem('missing');
  const history = await openHistory(kept.profile, kept.temp);
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
  try {
    for (let next = history.batches.next(); !next.done; next = history.batches.next()) {
      const answer = await send({ pages: next.value });
      if (!answer.ok) throw new ImportProblem('unreadable');
      reply({ type: 'pages', added: answer.added });
    }
    reply({ type: 'done' });
  } finally {
    history.close();
    port.close();
  }
}

process.parentPort.on('message', (event) => {
  const request = event.data as ImportRequest;
  switch (request.type) {
    case 'scan':
      detectProfiles(request.env).then((profiles) => reply({ type: 'profiles', profiles }), failed);
      return;
    case 'read':
      readProfile(request.profile, request.temp).then((preview) => {
        kept = { profile: request.profile, temp: request.temp, preview };
        reply({ type: 'overview', overview: overviewOf(preview, request.chordId) });
      }, failed);
      return;
    case 'plan': {
      if (!kept) return failed(new ImportProblem('missing'));
      const plan = planImport(request.context, kept.preview, request.choices, {
        importId: request.importId,
        now: Date.now(),
        newId: () => uuidv7(),
        themes: request.themes,
        fallbackChordId: request.fallbackChordId,
      });
      parts = { nodes: plan.nodes, at: 0 };
      reply({ type: 'plan', chords: plan.chords, favorites: plan.favorites, counts: plan.counts, nodes: plan.nodes.length });
      return;
    }
    case 'more': {
      if (!parts || parts.at >= parts.nodes.length) return reply({ type: 'planned' });
      const nodes = parts.nodes.slice(parts.at, parts.at + NODES_PER_PART);
      parts.at += nodes.length;
      reply({ type: 'nodes', nodes });
      return;
    }
    case 'history': {
      const port = event.ports[0];
      if (!port) return failed(new ImportProblem('missing'));
      sendHistory(port).catch(failed);
      return;
    }
  }
});
