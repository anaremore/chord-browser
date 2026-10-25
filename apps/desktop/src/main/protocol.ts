/**
 * `chord://<surface>/` serves Chord's own UI from inside the app bundle. It is
 * registered only on the in-memory `chord-ui` session, so web pages (which
 * use profile sessions) can never load it (ARCHITECTURE.md §4).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol, type Session } from 'electron';
import { CHORD_SCHEME, resolveChordUrl } from './urls';

const rendererRoot = resolve(import.meta.dirname, '../renderer');

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Reader view shows a page's article (ARCHITECTURE.md §9): stricter still.
 * Its images come only from chord://reader/image/… (main fetches them
 * through the tab's session), it connects nowhere, and no string can become
 * markup or script (Trusted Types with no policy).
 */
const READER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

/** Duet's chat images, by main's DuetService (none until it exists). */
let duetImages: ((url: string) => Promise<Response>) | null = null;
export function serveDuetImages(serve: (url: string) => Promise<Response>): void {
  duetImages = serve;
}

/** Reader view's images, by main's Readers (set once it exists; until then there are none). */
let readerImages: ((url: string) => Promise<Response>) | null = null;
export function serveReaderImages(serve: (url: string) => Promise<Response>): void {
  readerImages = serve;
}

/** Must run before `ready`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: CHORD_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

export function handleChordProtocol(ses: Session): void {
  ses.protocol.handle(CHORD_SCHEME, async (request) => {
    const reader = request.url.startsWith(`${CHORD_SCHEME}://reader/`);
    if (reader && request.url.startsWith(`${CHORD_SCHEME}://reader/image/`)) return readerImages ? readerImages(request.url) : new Response('Not found', { status: 404 });
    if (request.url.startsWith(`${CHORD_SCHEME}://shell/duet-image/`)) return duetImages ? duetImages(request.url) : new Response('Not found', { status: 404 });
    const file = resolveChordUrl(request.url, rendererRoot);
    if (!file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!response.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', reader ? READER_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: 200, headers });
  });
}
