/**
 * A PDF's text, page by page, with pdf.js (pdfjs-dist, Apache-2.0: see
 * LICENSES/Apache-2.0.txt). Duet runs this in its own utility process
 * (worker.ts), never on main: the bytes come from the web and are untrusted.
 *
 * pdf.js is set up for text only: its "worker" runs in this process's thread
 * (no Worker, no second file), nothing is fetched (no CMaps, fonts or wasm
 * from anywhere), no canvas, no font loading, no XFA forms, no scripting.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// pdf.js looks here before it would load its worker from a file.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

export interface PdfPages {
  /** The text of the pages read, first to last (at most `maxPages`). */
  pages: string[];
  /** How many pages the file has. */
  totalPages: number;
}

export type PdfFailure = 'password' | 'invalid' | 'crashed';

export class PdfReadError extends Error {
  constructor(readonly reason: PdfFailure) {
    super(reason);
  }
}

/** The text of one page: runs in reading order, with pdf.js's line ends. */
export function pageText(items: readonly (TextItem | { type: string })[]): string {
  let out = '';
  for (const item of items) {
    if (!('str' in item)) continue;
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out;
}

export async function extractPdfText(data: Uint8Array, maxPages: number): Promise<PdfPages> {
  const task = getDocument({
    data,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    // Errors only: a damaged file's warnings aren't Chord's to print.
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      pages.push(pageText((await page.getTextContent()).items));
      page.cleanup();
    }
    return { pages, totalPages: doc.numPages };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new PdfReadError(name === 'PasswordException' ? 'password' : 'invalid');
  } finally {
    await task.destroy();
  }
}
