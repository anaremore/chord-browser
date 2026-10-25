/**
 * The bar's page, served from the app's own files over `chord-player://bar/`
 * on the bar's session only. The fuses take file:// pages' extra privileges
 * away (GrantFileProtocolExtraPrivileges off, as Chord's), so the bar can't
 * load from file://; a scheme of its own, as Chord's chord://, gives it
 * exactly its files and a strict Content Security Policy.
 */
import { net, protocol, type Session } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BAR_SCHEME = 'chord-player';
export const BAR_URL = `${BAR_SCHEME}://bar/bar/index.html`;

const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Must run before `ready`. */
export function registerBarScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: BAR_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves `root` (the built renderer folder) at chord-player://bar/ on `ses`. */
export function serveBar(ses: Session, root: string): void {
  ses.protocol.handle(BAR_SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (url.host !== 'bar' || !file.startsWith(root + sep)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (!response?.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: 200, headers });
  });
}
