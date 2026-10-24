/**
 * Every browser's history comes out of its database as one row per visit,
 * a page's visits together: `id` (the page), `url`, `title`, `at` (Unix ms)
 * and `typed` (1 when the address was typed). This turns those rows into
 * pages, a batch at a time, for chord-data to write in batches.
 */
import type { ImportedPage } from '@chord/core';

/** Pages per batch, and visits per batch: whichever fills first. */
export const PAGES_PER_BATCH = 500;
const VISITS_PER_BATCH = 10_000;

export function* pagesOf(rows: Iterable<unknown>, size = PAGES_PER_BATCH): Generator<ImportedPage[]> {
  let batch: ImportedPage[] = [];
  let visits = 0;
  // Set inside the loop and read by close(), so it's typed wide rather than narrowed to its first value.
  let current = null as { id: number; page: ImportedPage } | null;
  // Called as a page ends; says whether the batch is full.
  const close = (): boolean => {
    if (!current || current.page.visits.length === 0) return false;
    batch.push(current.page);
    visits += current.page.visits.length;
    return batch.length >= size || visits >= VISITS_PER_BATCH;
  };
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const id = Number(row['id']);
    if (current?.id !== id) {
      if (close()) {
        yield batch;
        batch = [];
        visits = 0;
      }
      current = { id, page: { url: String(row['url'] ?? ''), title: '', visits: [], typed: [] } };
    }
    const at = Number(row['at']);
    if (Number.isFinite(at) && at > 0) {
      current.page.visits.push(at);
      if (Number(row['typed']) === 1) current.page.typed.push(at);
    }
    // The newest title wins (Safari keeps one per visit).
    if (typeof row['title'] === 'string' && row['title']) current.page.title = row['title'];
  }
  close();
  if (batch.length > 0) yield batch;
}
