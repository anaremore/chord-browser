/**
 * The assistant's store (migration 9; ARCHITECTURE.md §11): threads and their
 * messages, retention, and the command bar's @chats search. Chord's transcript
 * is the source of truth; `provider_session_id` only caches the provider's
 * side, so losing it costs a summary, never the conversation.
 */
import { assistantMessageText, isAssistantScope, type AssistantHit, type AssistantImage, type AssistantMessage, type AssistantMessageBody, type AssistantProvider, type AssistantThread } from '@chord/core';
import type { StatementSync } from 'node:sqlite';

export type AssistantOp =
  /** A chord's threads, most recently used first. */
  | { op: 'threads'; chordId: string; limit: number }
  /** One thread and every message in it, oldest first. */
  | { op: 'thread'; threadId: string }
  | { op: 'saveThread'; thread: AssistantThread }
  /** Insert or replace (a streamed reply is saved as it finishes; approvals change when answered). */
  | { op: 'saveMessage'; message: AssistantMessage }
  | { op: 'deleteThread'; threadId: string }
  /** Every thread (Settings → Assistant → Clear all chats). */
  | { op: 'deleteAll' }
  /** Threads unused since `before` (Keep chats). */
  | { op: 'prune'; before: number }
  | { op: 'search'; query: string; limit: number };

/** Deleted threads come back so main can delete the provider's copy too, and their images. */
export interface AssistantResult {
  threads?: AssistantThread[];
  thread?: AssistantThread | null;
  messages?: AssistantMessage[];
  removed?: AssistantThread[];
  images?: AssistantImage[];
  hits?: AssistantHit[];
}

type Row = Record<string, unknown>;
type Sql = (text: string) => StatementSync;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

export const threadOf = (r: Row): AssistantThread => ({
  id: str(r['id']),
  chordId: str(r['chord_id']),
  title: str(r['title']),
  provider: str(r['provider']) as AssistantProvider,
  model: typeof r['model'] === 'string' ? r['model'] : null,
  providerSessionId: typeof r['provider_session_id'] === 'string' ? r['provider_session_id'] : null,
  scope: isAssistantScope(r['scope']) ? r['scope'] : 'ask',
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
  lastUsedAt: num(r['last_used_at']),
  ...(r['imported_at'] === null || r['imported_at'] === undefined ? {} : { importedAt: num(r['imported_at']) }),
});

/** The images in the messages of the threads `where` picks (a condition on `t`), read before they're deleted. */
export function imagesIn(sql: Sql, where: string, ...params: (string | number)[]): AssistantImage[] {
  const rows = sql(`SELECT m.body FROM assistant_message m JOIN assistant_thread t ON t.id = m.thread_id WHERE ${where} AND m.body LIKE '%"images":%'`).all(...params) as Row[];
  return rows.flatMap((r) => {
    try {
      const body = JSON.parse(str(r['body'])) as AssistantMessageBody;
      return body.role === 'user' || body.role === 'assistant' ? (body.images ?? []) : [];
    } catch {
      return [];
    }
  });
}

function messageOf(r: Row): AssistantMessage | null {
  try {
    const body = JSON.parse(str(r['body'])) as AssistantMessageBody;
    return { id: str(r['id']), threadId: str(r['thread_id']), createdAt: num(r['created_at']), body };
  } catch {
    return null;
  }
}

/** Every word as a prefix, quoted so FTS syntax in what was typed stays text. */
const ftsQuery = (query: string) =>
  query
    .split(/\s+/)
    .map((w) => w.replace(/["*^():]/g, ''))
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"*`)
    .join(' ');

export function runAssistant(sql: Sql, op: AssistantOp): AssistantResult {
  switch (op.op) {
    case 'threads':
      return { threads: (sql('SELECT * FROM assistant_thread WHERE chord_id = ? ORDER BY last_used_at DESC LIMIT ?').all(op.chordId, op.limit) as Row[]).map(threadOf) };
    case 'thread': {
      const row = sql('SELECT * FROM assistant_thread WHERE id = ?').get(op.threadId) as Row | undefined;
      if (!row) return { thread: null, messages: [] };
      const rows = sql('SELECT * FROM assistant_message WHERE thread_id = ? ORDER BY created_at, rid').all(op.threadId) as Row[];
      return { thread: threadOf(row), messages: rows.map(messageOf).filter((m): m is AssistantMessage => m !== null) };
    }
    case 'saveThread': {
      const t = op.thread;
      // Whether it came from a file is set once, by the import (db.ts, importAssistant), and stays.
      sql(
        `INSERT INTO assistant_thread (id, chord_id, title, provider, model, provider_session_id, scope, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET chord_id = excluded.chord_id, title = excluded.title, provider = excluded.provider,
           model = excluded.model, provider_session_id = excluded.provider_session_id, scope = excluded.scope,
           updated_at = excluded.updated_at, last_used_at = excluded.last_used_at`,
      ).run(t.id, t.chordId, t.title, t.provider, t.model, t.providerSessionId, t.scope, t.createdAt, t.updatedAt, t.lastUsedAt);
      return {};
    }
    case 'saveMessage': {
      const m = op.message;
      sql(
        `INSERT INTO assistant_message (id, thread_id, role, text, body, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, body = excluded.body`,
      ).run(m.id, m.threadId, m.body.role, assistantMessageText(m.body), JSON.stringify(m.body), m.createdAt);
      return {};
    }
    case 'deleteThread': {
      const row = sql('SELECT * FROM assistant_thread WHERE id = ?').get(op.threadId) as Row | undefined;
      const images = imagesIn(sql, 't.id = ?', op.threadId);
      sql('DELETE FROM assistant_thread WHERE id = ?').run(op.threadId);
      return { removed: row ? [threadOf(row)] : [], images };
    }
    case 'deleteAll': {
      const removed = (sql('SELECT * FROM assistant_thread').all() as Row[]).map(threadOf);
      sql('DELETE FROM assistant_thread').run();
      return { removed };
    }
    case 'prune': {
      const removed = (sql('SELECT * FROM assistant_thread WHERE last_used_at < ?').all(op.before) as Row[]).map(threadOf);
      const images = imagesIn(sql, 't.last_used_at < ?', op.before);
      sql('DELETE FROM assistant_thread WHERE last_used_at < ?').run(op.before);
      return { removed, images };
    }
    case 'search': {
      const match = ftsQuery(op.query);
      if (!match) return { hits: [] };
      const rows = sql(
        `SELECT m.id AS message_id, m.thread_id, m.created_at, t.chord_id, t.title,
                snippet(assistant_fts, 0, '', '', '…', 12) AS snippet
           FROM assistant_fts JOIN assistant_message m ON m.rid = assistant_fts.rowid JOIN assistant_thread t ON t.id = m.thread_id
          WHERE assistant_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`,
      ).all(match, op.limit) as Row[];
      return {
        hits: rows.map((r) => ({
          threadId: str(r['thread_id']),
          chordId: str(r['chord_id']),
          threadTitle: str(r['title']),
          messageId: str(r['message_id']),
          snippet: str(r['snippet']),
          createdAt: num(r['created_at']),
        })),
      };
    }
  }
}
