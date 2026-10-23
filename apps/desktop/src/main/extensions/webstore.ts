/**
 * The Chrome Web Store's update service, spoken the way Chrome speaks it
 * (ARCHITECTURE.md §12): one request asks about any number of extensions and
 * answers with the latest version of each, where to download it, and the
 * download's SHA-256.
 */
import { createHash } from 'node:crypto';

/** Chrome's update endpoint. */
export const WEB_STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

export interface UpdateInfo {
  id: string;
  /** `ok`, or the service's reason there's nothing to download (`noupdate`, `error-unknownApplication`, …). */
  status: string;
  version: string | null;
  codebase: string | null;
  sha256: string | null;
}

/** The URL that asks about these extensions, at the versions we have (0.0.0.0 for a new install). */
export function updateCheckUrl(base: string, prodversion: string, have: readonly { id: string; version?: string }[]): string {
  const xs = have.map(({ id, version }) => `x=${encodeURIComponent(new URLSearchParams({ id, v: version ?? '0.0.0.0', installsource: 'ondemand', uc: '' }).toString())}`);
  // The same request spike S9 verified against the live service: it answers with gupdate XML.
  return `${base}?prodversion=${encodeURIComponent(prodversion)}&acceptformat=crx3&${xs.join('&')}`;
}

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]!);

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = decode(m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Read a gupdate response: one `<app appid=…>` per extension, each with an
 * `<updatecheck …>` carrying status, version, codebase and hash_sha256.
 */
export function parseUpdateResponse(xml: string): UpdateInfo[] {
  const out: UpdateInfo[] = [];
  for (const app of xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    const id = attributes(app[1]!)['appid'];
    if (!id) continue;
    const check = /<updatecheck\b([^>]*)\/?>/.exec(app[2]!);
    const a = check ? attributes(check[1]!) : {};
    out.push({ id, status: a['status'] ?? 'error', version: a['version'] ?? null, codebase: a['codebase'] ?? null, sha256: a['hash_sha256'] ?? null });
  }
  return out;
}

/** The parts of the network this needs, so tests can stand in for it. */
export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface WebStoreOptions {
  fetch: Fetch;
  /** The Chromium version Chord runs; the store serves the build that supports it. */
  prodversion: string;
  updateUrl?: string;
  /** Largest package accepted. */
  maxBytes?: number;
}

const MAX_CRX_BYTES = 256 * 1024 * 1024;

export class WebStore {
  constructor(private readonly options: WebStoreOptions) {}

  async check(have: readonly { id: string; version?: string }[]): Promise<UpdateInfo[]> {
    if (have.length === 0) return [];
    const url = updateCheckUrl(this.options.updateUrl ?? WEB_STORE_UPDATE_URL, this.options.prodversion, have);
    const response = await this.options.fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The Chrome Web Store didn’t answer (${response.status})`);
    return parseUpdateResponse(await response.text());
  }

  /** Download a package and check it against the hash the update service gave. */
  async download(info: UpdateInfo): Promise<Buffer> {
    if (!info.codebase) throw new Error(`No download for ${info.id} (${info.status})`);
    const codebase = new URL(info.codebase);
    // Packages come over HTTPS from Google; plain HTTP only for a local test server.
    const local = codebase.hostname === '127.0.0.1' || codebase.hostname === 'localhost';
    if (codebase.protocol !== 'https:' && !(local && codebase.protocol === 'http:')) throw new Error('Refusing a download that isn’t HTTPS');
    const response = await this.options.fetch(codebase.href, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const crx = Buffer.from(await response.arrayBuffer());
    if (crx.length > (this.options.maxBytes ?? MAX_CRX_BYTES)) throw new Error('The package is too big');
    if (info.sha256 && createHash('sha256').update(crx).digest('hex') !== info.sha256.toLowerCase()) {
      throw new Error('The download doesn’t match what the Chrome Web Store described');
    }
    return crx;
  }
}

/** Is `a` a newer version than `b`? Chrome versions are up to four dot-separated integers. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
