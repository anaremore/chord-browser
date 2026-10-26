/**
 * Your data's import, chord-data's reading half (docs/decisions/S15-your-data.md
 * §5, §7): what's here already, read by the import process over a read-only
 * connection of its own, as the export process reads, so chord-data's thread
 * does nothing for a preview or a plan. This computer's setup comes as the
 * records an export would write (export.ts), stamps and all, for the merge
 * planner (core's merge.ts) to weigh against the file's.
 */
import type { StatementSync } from 'node:sqlite';
import { DEFAULT_PROFILE, placeKey, type DataRecord, type Platform } from '@chord/core';
import { exportRecords } from './export';

type Sql = (text: string) => StatementSync;

/** This computer's setup and Today tabs as records, with their icons: what an export without history or chats holds. */
export function localRecords(sql: Sql, options: { device: string; platform: Platform; sha256(bytes: Uint8Array): string }): DataRecord[] {
  const records: DataRecord[] = [];
  for (const item of exportRecords(sql, { ...options, history: false, duet: false, image: () => null })) records.push(item.record);
  return records;
}

/** Whether history has a page here already: its place, as chord-data keys pages (with and without `www.` are one). */
export function pagesHere(sql: Sql): (url: string) => boolean {
  const statement = sql('SELECT 1 FROM history_url WHERE profile_id = ? AND place = ?');
  return (url) => {
    const place = placeKey(url);
    return place !== null && statement.get(DEFAULT_PROFILE, place) !== undefined;
  };
}

/** The Duet chats here already, by id. */
export function chatsHere(sql: Sql): Set<string> {
  return new Set((sql('SELECT id FROM duet_thread').all() as { id: string }[]).map((r) => r.id));
}
