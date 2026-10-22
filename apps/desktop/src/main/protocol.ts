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

/** Must run before `ready`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: CHORD_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

export function handleChordProtocol(ses: Session): void {
  ses.protocol.handle(CHORD_SCHEME, async (request) => {
    const file = resolveChordUrl(request.url, rendererRoot);
    if (!file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!response.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: 200, headers });
  });
}
