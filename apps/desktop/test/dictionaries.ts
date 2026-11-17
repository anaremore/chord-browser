/**
 * Playwright's global setup: spelling dictionaries from this computer, never Google's CDN.
 *
 * On Windows and Linux every Chord a test launches has a new profile, so Chromium downloads
 * the Hunspell dictionary for each session's language, at once and from Google
 * (src/main/spellcheck.ts). The spelling test then depended on that download (issue #42), and
 * tests that record traffic saw it: a session made just for the test downloads its own,
 * through whatever proxy it has.
 *
 * So the en-US dictionary is fetched once, pinned by its SHA-256 and cached outside the repository
 * (CHORD_DICTIONARY_CACHE, or test/.cache/dictionaries; CI keeps that folder between runs), and
 * served from 127.0.0.1, which Chromium never sends through a proxy. CHORD_E2E_SPELLCHECK_DICTIONARIES
 * tells every Chord launched in this run to download from it. Any other dictionary is a 404, so
 * a download fails at once and nothing leaves the computer. Google-free mode is unaffected: it
 * points dictionaries at a port nothing answers on, whatever this says.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * Chromium's file name for en-US, as Electron 45's asks for it: lower case, Hunspell dictionary format 10-2.
 * An Electron that asks for another is named in the run's output (below): pin that one instead.
 */
export const DICTIONARY = 'en-us-10-2.bdic';
export const DICTIONARY_URL = `https://redirector.gvt1.com/edgedl/chrome/dict/${DICTIONARY}`;
/** Fetched 2026-11-17, 451,982 bytes. */
export const DICTIONARY_SHA256 = 'b0d80e6b6c5491879365e176ecbd98074602a663429bcfcfb0a5a8375c051f13';

const cacheDir = resolve(process.env['CHORD_DICTIONARY_CACHE'] ?? join(import.meta.dirname, '.cache', 'dictionaries'));
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** The pinned dictionary: from the cache, or fetched (five tries: Google's CDN fails now and then) and checked. */
export async function ensureDictionary(): Promise<Buffer> {
  const file = join(cacheDir, DICTIONARY);
  if (existsSync(file)) {
    const cached = readFileSync(file);
    if (sha256(cached) === DICTIONARY_SHA256) return cached;
  }
  let failure: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(DICTIONARY_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const hash = sha256(body);
      if (hash !== DICTIONARY_SHA256) throw new Error(`SHA-256 ${hash}, expected ${DICTIONARY_SHA256}`);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(`${file}.partial`, body);
      renameSync(`${file}.partial`, file);
      return body;
    } catch (error) {
      failure = error;
      await new Promise((done) => setTimeout(done, attempt * 3000));
    }
  }
  throw new Error(`The spelling dictionary for E2E (${DICTIONARY_URL}) couldn't be fetched: ${String(failure)}${failure instanceof Error && failure.cause ? ` (${String(failure.cause)})` : ''}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const dictionary = await ensureDictionary();
  const server = createServer((req, res) => {
    const name = (req.url ?? '').split('?')[0]!.split('/').pop()!.toLowerCase();
    if (name !== DICTIONARY) {
      if (name.startsWith('en-us-')) console.error(`test/dictionaries.ts: Chromium asked for ${name}, not the pinned ${DICTIONARY}: spelling tests will fail until it's pinned.`);
      return void res.writeHead(404).end();
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': dictionary.length });
    res.end(dictionary);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  // The workers and the Chords they launch inherit it.
  process.env['CHORD_E2E_SPELLCHECK_DICTIONARIES'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
}
