/**
 * Reading a PDF for Duet (ARCHITECTURE.md §11.4). Chromium's viewer shows a
 * PDF inside the tab, where the page extractor sees only the viewer; so Duet
 * fetches the file again through the tab's own session (the user's cookies
 * apply, and a private window's session stays in memory) and pdf.js reads it
 * in a utility process of its own (src/pdf/worker.ts), off main.
 *
 * Every rule for reading a tab is checked before this runs (service.ts); this
 * adds the PDF's own: where the fetch ended up must still be readable, and
 * the size and page caps hold.
 */
import { join } from 'node:path';
import { DUET_PDF_MAX_BYTES } from '@chord/core';
import { utilityProcess, type WebContents } from 'electron';
import type { PdfReply } from '../../pdf/worker';

export type PdfProblem = 'too-big' | 'not-pdf' | 'unreachable' | 'never' | 'password' | 'invalid' | 'timeout' | 'crashed';

export class PdfError extends Error {
  constructor(
    readonly problem: PdfProblem,
    readonly detail = '',
  ) {
    super(detail || problem);
  }
}

/** Why a PDF couldn't be read, in plain words: shown in the panel's activity line and told to the model. */
export function pdfProblemCopy(problem: PdfProblem, detail = ''): string {
  switch (problem) {
    case 'too-big':
      return `it’s larger than ${Math.round(DUET_PDF_MAX_BYTES / (1024 * 1024))} MB, the most Duet reads`;
    case 'not-pdf':
      return 'the tab no longer shows a PDF';
    case 'never':
      return 'it comes from a site Duet never reads';
    case 'password':
      return 'it’s password-protected';
    case 'invalid':
      return 'the file is damaged';
    case 'timeout':
      return 'it took too long';
    case 'unreachable':
      return `it couldn’t be downloaded again${detail ? ` (${detail})` : ''}`;
    default:
      return 'something went wrong reading it';
  }
}

/** A response's body, read up to `max` bytes; null if it's larger (the rest is never downloaded). */
export async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A PDF starts with "%PDF-" (some files have a little junk before it, which readers allow). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

/**
 * The PDF a tab shows, fetched through that tab's session. `readable` is
 * asked about the address the fetch ended at, after any redirects.
 */
export async function fetchPdf(contents: WebContents, url: string, readable: (finalUrl: string) => boolean, maxBytes = DUET_PDF_MAX_BYTES): Promise<Uint8Array> {
  let response: Response;
  try {
    // The viewer just loaded it, so the HTTP cache usually has it; if not, it's downloaded with the tab's cookies.
    response = await contents.session.fetch(url, { credentials: 'include', cache: 'force-cache', signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new PdfError((error as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
  }
  if (response.url && !readable(response.url)) {
    await response.body?.cancel().catch(() => undefined);
    throw new PdfError('never');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PdfError('unreachable', `the site answered ${response.status}`);
  }
  const bytes = await readCapped(response, maxBytes).catch(() => {
    throw new PdfError('unreachable');
  });
  if (!bytes) throw new PdfError('too-big');
  if (!looksLikePdf(bytes)) throw new PdfError('not-pdf');
  return bytes;
}

/** Each page's text, read by pdf.js in a utility process that's thrown away afterwards. */
export function extractPdf(bytes: Uint8Array, maxPages: number, timeoutMs = 30_000): Promise<{ pages: string[]; totalPages: number }> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(import.meta.dirname, 'pdf.js'), [], { serviceName: 'Chord PDF reader', stdio: 'ignore' });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      outcome();
    };
    const timer = setTimeout(() => finish(() => reject(new PdfError('timeout'))), timeoutMs);
    child.once('message', (reply: PdfReply) => finish(() => (reply.ok ? resolve({ pages: reply.pages, totalPages: reply.totalPages }) : reject(new PdfError(reply.error)))));
    child.once('exit', () => finish(() => reject(new PdfError('crashed'))));
    child.postMessage({ data: bytes, maxPages });
  });
}
