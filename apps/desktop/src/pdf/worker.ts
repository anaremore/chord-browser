/**
 * The PDF reader utility process (ARCHITECTURE.md §11.4): Duet hands it one
 * PDF's bytes and gets back each page's text. A file from the web is parsed
 * here rather than in main, and the process is thrown away after each read,
 * so a hostile or enormous PDF costs this process at most (main also stops it
 * after a timeout).
 */
import { extractPdfText, PdfReadError } from './extract';

export type PdfReply = { ok: true; pages: string[]; totalPages: number } | { ok: false; error: 'password' | 'invalid' | 'crashed' };

const reply = (message: PdfReply) => process.parentPort.postMessage(message);
const crashed = () => {
  reply({ ok: false, error: 'crashed' });
  process.exit(1);
};
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);

process.parentPort.once('message', (event) => {
  const { data, maxPages } = event.data as { data: Uint8Array; maxPages: number };
  extractPdfText(data, maxPages).then(
    (result) => reply({ ok: true, ...result }),
    (error) => reply({ ok: false, error: error instanceof PdfReadError ? error.reason : 'crashed' }),
  );
});
