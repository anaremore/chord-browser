import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DuetMessage, DuetThread } from '@chord/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChordDatabase } from '../src/db';
import { MIGRATIONS } from '../src/migrations';

let dir: string;
let db: ChordDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-duet-data-'));
  db = new ChordDatabase(join(dir, 'chord.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const thread = (id: string, lastUsedAt: number, chordId = 'c1'): DuetThread => ({
  id,
  chordId,
  title: `Thread ${id}`,
  provider: 'claude',
  model: null,
  providerSessionId: `session-${id}-0000`,
  scope: 'ask',
  createdAt: lastUsedAt,
  updatedAt: lastUsedAt,
  lastUsedAt,
});
const message = (id: string, threadId: string, text: string, role: 'user' | 'assistant' = 'user'): DuetMessage => ({
  id,
  threadId,
  createdAt: Date.now(),
  body: role === 'user' ? { role, text, attachments: [] } : { role, text, citations: [], status: 'done' },
});

describe('Duet store (migration 9)', () => {
  it('keeps threads per chord, newest first, with their messages and scope', () => {
    db.duet({ op: 'saveThread', thread: thread('a', 1) });
    db.duet({ op: 'saveThread', thread: { ...thread('b', 2), scope: 'chord' } });
    db.duet({ op: 'saveThread', thread: thread('x', 3, 'other') });
    db.duet({ op: 'saveMessage', message: message('m1', 'b', 'Hello there') });
    db.duet({ op: 'saveMessage', message: message('m2', 'b', 'General Kenobi', 'assistant') });
    expect(db.duet({ op: 'threads', chordId: 'c1', limit: 10 }).threads?.map((t) => t.id)).toEqual(['b', 'a']);
    const loaded = db.duet({ op: 'thread', threadId: 'b' });
    expect(loaded.thread?.scope).toBe('chord');
    expect(loaded.messages?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('finds messages by their words for @duet, and forgets them when the thread goes', () => {
    db.duet({ op: 'saveThread', thread: thread('a', 1) });
    db.duet({ op: 'saveMessage', message: message('m1', 'a', 'Compare these laptops') });
    expect(db.duet({ op: 'search', query: 'lapt', limit: 10 }).hits).toMatchObject([{ threadId: 'a', messageId: 'm1', threadTitle: 'Thread a' }]);
    const removed = db.duet({ op: 'deleteThread', threadId: 'a' }).removed;
    // The caller gets the thread back to delete the provider's copy by its session id.
    expect(removed?.map((t) => t.providerSessionId)).toEqual(['session-a-0000']);
    expect(db.duet({ op: 'search', query: 'laptops', limit: 10 }).hits).toEqual([]);
    expect(db.duet({ op: 'thread', threadId: 'a' }).messages).toEqual([]);
  });

  it('prunes threads past the keep-by date, returning them and their images', () => {
    db.duet({ op: 'saveThread', thread: thread('old', 10) });
    db.duet({ op: 'saveThread', thread: thread('new', 1000) });
    const picture = { id: 'a'.repeat(24), mime: 'image/jpeg' as const, width: 800, height: 600 };
    db.duet({ op: 'saveMessage', message: { ...message('m1', 'old', 'What is this?'), body: { role: 'user', text: 'What is this?', attachments: [], images: [picture] } } });
    db.duet({ op: 'saveMessage', message: { ...message('m2', 'new', 'And this?'), body: { role: 'user', text: 'And this?', attachments: [], images: [{ ...picture, id: 'b'.repeat(24) }] } } });
    // One Codex made, in a reply.
    const made = { ...picture, id: 'c'.repeat(24), mime: 'image/png' as const, prompt: 'A cartoon', codexCopy: '/home/me/.codex/generated_images/t/ig.png' };
    db.duet({ op: 'saveMessage', message: { ...message('m3', 'old', 'Here it is.', 'assistant'), body: { role: 'assistant', text: 'Here it is.', citations: [], status: 'done', images: [made] } } });
    const pruned = db.duet({ op: 'prune', before: 500 });
    expect(pruned.removed?.map((t) => t.id)).toEqual(['old']);
    // Main deletes their files: only the pruned thread's, Codex's copy of the one it made too.
    expect(pruned.images).toEqual([picture, made]);
    expect(db.duet({ op: 'deleteThread', threadId: 'new' }).images?.map((i) => i.id)).toEqual(['b'.repeat(24)]);
    db.duet({ op: 'saveThread', thread: thread('new', 1000) });
    expect(db.duet({ op: 'threads', chordId: 'c1', limit: 10 }).threads?.map((t) => t.id)).toEqual(['new']);
    expect(db.duet({ op: 'deleteAll' }).removed?.map((t) => t.id)).toEqual(['new']);
  });

  it('upgrades a version-8 profile (site zoom, no Duet yet), keeping its zoom', () => {
    db.close();
    const file = join(dir, 'v8.db');
    const v8 = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 8)) v8.exec(migration);
    v8.exec('PRAGMA user_version = 8');
    v8.prepare('INSERT INTO site_zoom (profile_id, host, factor, updated_at) VALUES (?, ?, ?, ?)').run('default', 'news.test', 1.25, 1);
    v8.close();

    db = new ChordDatabase(file);
    // Upgraded through Duet's migration to the latest (later features add their own).
    expect(db.version).toBe(MIGRATIONS.length);
    db.duet({ op: 'saveThread', thread: thread('a', 1) });
    db.duet({ op: 'saveMessage', message: message('m1', 'a', 'Hello after the upgrade') });
    expect(db.duet({ op: 'search', query: 'upgrade', limit: 10 }).hits?.map((h) => h.messageId)).toEqual(['m1']);
    db.close();
    const check = new DatabaseSync(file);
    expect(check.prepare('SELECT host, factor FROM site_zoom').all()).toEqual([{ host: 'news.test', factor: 1.25 }]);
    check.close();
    db = new ChordDatabase(join(dir, 'chord.db'));
  });

  it('treats FTS syntax in a search as plain words', () => {
    db.duet({ op: 'saveThread', thread: thread('a', 1) });
    db.duet({ op: 'saveMessage', message: message('m1', 'a', 'quote "this" (please)') });
    expect(db.duet({ op: 'search', query: '"this" (please*', limit: 10 }).hits?.length).toBe(1);
  });
});
