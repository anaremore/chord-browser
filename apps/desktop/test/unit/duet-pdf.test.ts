/**
 * Reading PDFs for Duet: pdf.js extraction on a fixture PDF (what the PDF
 * reader utility process runs), the size cap on the download, and the
 * "is this a PDF" check. The utility process and the tab's session are
 * covered end to end in duet.spec.ts.
 */
import { DUET_PDF_MAX_BYTES, pdfPageOf, pdfText, pageResult } from '@chord/core';
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { fetchPdf, looksLikePdf, PdfError, pdfProblemCopy, readCapped } from '../../src/main/duet/pdf';
import { extractPdfText, PdfReadError } from '../../src/pdf/extract';
import { buildPdf, SAMPLE_PDF_PAGES } from '../fixtures/pdf';

describe('PDF text extraction (pdf.js)', () => {
  it('reads each page’s text in order', async () => {
    const { pages, totalPages } = await extractPdfText(buildPdf(SAMPLE_PDF_PAGES), 200);
    expect(totalPages).toBe(3);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain('A chord is three or more notes played together.');
    expect(pages[1]).toContain('A major triad sounds bright and stable.');
    expect(pages[2]).toContain('An inversion puts another note at the bottom.');
    // Lines stay lines.
    expect(pages[1]!.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['Page two talks about triads.', 'A major triad sounds bright and stable.']);
  });

  it('stops at the page cap and still says how many pages there are', async () => {
    const many = Array.from({ length: 7 }, (_, i) => [`This is page ${i + 1}.`]);
    const { pages, totalPages } = await extractPdfText(buildPdf(many), 5);
    expect(totalPages).toBe(7);
    expect(pages).toHaveLength(5);
    expect(pages[4]).toContain('This is page 5.');
  });

  it('turns the pages into text with page markers, and finds the page a quote is on', async () => {
    const { pages } = await extractPdfText(buildPdf(SAMPLE_PDF_PAGES), 200);
    const text = pdfText(pages);
    expect(text).toMatch(/^\[Page 1\]\nField guide to chords/);
    expect(text).toContain('[Page 3]\nThe last page is about inversions.');
    expect(pdfPageOf(pages, 'A major triad sounds bright')).toBe(2);
    expect(pdfPageOf(pages, 'puts another note at the bottom')).toBe(3);
    const result = JSON.parse(pageResult({ ref: 't1', url: 'https://example.com/guide.pdf', text, retrievedAt: 0, pdf: { pages: 3, read: 3 } }));
    expect(result).toMatchObject({ source: 'pdf', trust: 'untrusted', pages: { total: 3, read: 3 } });
    expect(result.content).toContain('[Page 2]');
  });

  it('rejects what isn’t a PDF', async () => {
    await expect(extractPdfText(new TextEncoder().encode('<html>not a pdf</html>'), 10)).rejects.toBeInstanceOf(PdfReadError);
  });
});

describe('PDF download', () => {
  it('knows a PDF by its header, even after a little junk', () => {
    expect(looksLikePdf(buildPdf(SAMPLE_PDF_PAGES))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('\n\n%PDF-1.7\n'))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('<!doctype html><title>Sign in</title>'))).toBe(false);
  });

  it('reads a body up to the cap and gives up past it', async () => {
    const small = new Uint8Array(1000).fill(7);
    expect(await readCapped(new Response(small), 2000)).toEqual(small);
    // Past the cap while streaming (no length given).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(1000));
        controller.close();
      },
    });
    expect(await readCapped(new Response(stream), 2500)).toBeNull();
    // A declared length over the cap isn't downloaded at all.
    expect(await readCapped(new Response(small, { headers: { 'content-length': String(DUET_PDF_MAX_BYTES + 1) } }), DUET_PDF_MAX_BYTES)).toBeNull();
  });

  it('fetches through the tab’s own session, and refuses where a redirect lands if Duet never reads it', async () => {
    const pdf = buildPdf(SAMPLE_PDF_PAGES);
    const asked: { url: string; init?: RequestInit }[] = [];
    /** A tab whose session answers with `respond()`, as if it ended at `landed`. */
    const tab = (landed: string, respond: () => Response) =>
      ({
        session: {
          fetch: async (url: string, init?: RequestInit) => {
            asked.push({ url, ...(init ? { init } : {}) });
            const response = respond();
            Object.defineProperty(response, 'url', { value: landed });
            return response;
          },
        },
      }) as unknown as WebContents;
    const url = 'https://docs.example/guide.pdf';
    const readable = (address: string) => !address.startsWith('https://private.example/');
    expect(await fetchPdf(tab(url, () => new Response(pdf)), url, readable)).toEqual(pdf);
    // The user's cookies apply: it's the tab's session, with credentials.
    expect(asked[0]).toMatchObject({ url, init: { credentials: 'include' } });
    await expect(fetchPdf(tab('https://private.example/guide.pdf', () => new Response(pdf)), url, readable)).rejects.toMatchObject({ problem: 'never' });
    await expect(fetchPdf(tab(url, () => new Response('sign in first', { status: 403 })), url, readable)).rejects.toMatchObject({ problem: 'unreachable', detail: 'the site answered 403' });
    await expect(fetchPdf(tab(url, () => new Response('<!doctype html><title>Sign in</title>')), url, readable)).rejects.toMatchObject({ problem: 'not-pdf' });
    await expect(fetchPdf(tab(url, () => new Response(pdf)), url, readable, 100)).rejects.toBeInstanceOf(PdfError);
    await expect(fetchPdf(tab(url, () => new Response(pdf)), url, readable, 100)).rejects.toMatchObject({ problem: 'too-big' });
  });

  it('says plainly why a PDF couldn’t be read', () => {
    expect(pdfProblemCopy('too-big')).toBe('it’s larger than 25 MB, the most Duet reads');
    expect(pdfProblemCopy('password')).toContain('password-protected');
    expect(pdfProblemCopy('unreachable', 'the site answered 403')).toContain('403');
  });
});
