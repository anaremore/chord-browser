/**
 * Reader view's cleaning, in a short-lived worker thread (built as
 * out/main/reader.js): core's `sanitizeArticle` walks every node of the
 * article the page sent, a few milliseconds for a long one and tens for a
 * huge one, so it stays off main (ARCHITECTURE.md §1, rule 1). The article
 * comes and goes as JSON text: main only ever passes strings along.
 */
import { sanitizeArticle } from '@chord/core';
import { parentPort } from 'node:worker_threads';

export interface CleanRequest {
  /** What the page's script returned: JSON, from the page, so possibly anything. */
  json: string;
  /** The page's address, which links and images resolve against. */
  url: string;
}

/** The article without its images' addresses, as JSON for the reader view; and those addresses, for main. */
export type CleanReply = { article: string; images: string[] } | null;

parentPort?.on('message', ({ json, url }: CleanRequest) => {
  let raw: unknown = null;
  try {
    raw = JSON.parse(json);
  } catch {
    // Not JSON: no article.
  }
  const article = sanitizeArticle(raw, url);
  if (!article) {
    parentPort!.postMessage(null satisfies CleanReply);
    return;
  }
  const { images, ...rest } = article;
  parentPort!.postMessage({ article: JSON.stringify(rest), images } satisfies CleanReply);
});
