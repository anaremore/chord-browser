/**
 * page_diagnostics (ROADMAP.md, "The assistant reads a page's problems";
 * ARCHITECTURE.md §11.3): the tab on screen's console errors and warnings,
 * uncaught exceptions and failed requests, from what Chromium kept of the page
 * (main/assistant/diagnostics.ts asks its debugger once). This file turns the
 * protocol's events into what the model gets: bounded, and with every address
 * cut to its origin and path. Requests' headers, cookies and bodies are never
 * asked for (no Network domain), so they can't be here.
 */
import { cleanPageText, isNeverReadable } from './assistant';
import { hostOf, siteOf } from './links';

/** Core runs without DOM types. */
declare const URL: new (url: string) => { protocol: string; origin: string; host: string; pathname: string };

/** The newest entries kept, and the most characters of any entry's text. */
export const DIAGNOSTICS_MAX_ENTRIES = 200;
export const DIAGNOSTICS_MAX_TEXT = 500;
/** Stack frames kept per entry, and the most characters of a frame's file. */
export const DIAGNOSTICS_MAX_FRAMES = 10;
const MAX_FILE = 200;

/* ---------- The protocol's shapes (only the fields read) ---------- */

export interface CdpCallFrame {
  functionName?: string;
  url?: string;
  /** 0-based, as the protocol counts. */
  lineNumber?: number;
}
export interface CdpStackTrace {
  callFrames?: CdpCallFrame[];
}
export interface CdpRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  className?: string;
  preview?: { properties?: { name: string; value?: string; type?: string }[]; overflow?: boolean; subtype?: string };
}
/** Log.entryAdded's `entry`. */
export interface CdpLogEntry {
  source?: string;
  level?: string;
  text?: string;
  url?: string;
  lineNumber?: number;
  timestamp?: number;
  stackTrace?: CdpStackTrace;
  networkRequestId?: string;
}
/** Runtime.consoleAPICalled's params. */
export interface CdpConsoleCall {
  type?: string;
  args?: CdpRemoteObject[];
  timestamp?: number;
  stackTrace?: CdpStackTrace;
  /** The frame's script context it was called in (Runtime.executionContextCreated said whose). */
  executionContextId?: number;
}
/** Runtime.exceptionThrown's params. */
export interface CdpException {
  timestamp?: number;
  exceptionDetails?: { text?: string; url?: string; lineNumber?: number; stackTrace?: CdpStackTrace; exception?: CdpRemoteObject; executionContextId?: number };
}

export type DiagnosticsEvent = { kind: 'log'; entry: CdpLogEntry } | { kind: 'console'; call: CdpConsoleCall } | { kind: 'exception'; thrown: CdpException };

/**
 * How much of an event main keeps while it waits for the rest: a page can log
 * 5,000,000 characters at a time. Twice the text the model gets (redaction
 * can shorten it), addresses whole up to 2,048 (a request's type is found by
 * its full address), and the frames that are kept.
 */
export const DIAGNOSTICS_RAW_TEXT = 2 * DIAGNOSTICS_MAX_TEXT;
const RAW_URL = 2048;
const RAW_ARGS = 20;
const RAW_PROPS = 20;
const rawCut = (s: unknown, max = DIAGNOSTICS_RAW_TEXT) => (typeof s === 'string' ? s.slice(0, max) : undefined);
const shrinkTrace = (t: CdpStackTrace | undefined): CdpStackTrace | undefined =>
  t?.callFrames ? { callFrames: t.callFrames.slice(0, DIAGNOSTICS_MAX_FRAMES).map((f) => ({ functionName: rawCut(f.functionName, 200), url: rawCut(f.url, RAW_URL), lineNumber: f.lineNumber })) } : undefined;
const shrinkObject = (o: CdpRemoteObject): CdpRemoteObject => ({
  type: o.type,
  subtype: o.subtype,
  value: typeof o.value === 'string' ? o.value.slice(0, DIAGNOSTICS_RAW_TEXT) : typeof o.value === 'number' || typeof o.value === 'boolean' ? o.value : undefined,
  unserializableValue: rawCut(o.unserializableValue, 100),
  description: rawCut(o.description),
  className: rawCut(o.className, 100),
  ...(o.preview?.properties
    ? { preview: { overflow: o.preview.overflow || o.preview.properties.length > RAW_PROPS, properties: o.preview.properties.slice(0, RAW_PROPS).map((p) => ({ name: String(p.name).slice(0, 100), value: rawCut(p.value, 100), type: p.type })) } }
    : {}),
});

/** An event cut to what diagnosticsEntries can use, as it arrives: the rest is dropped at once. */
export function shrinkEvent(e: DiagnosticsEvent): DiagnosticsEvent {
  if (e.kind === 'log') {
    const { entry } = e;
    return { kind: 'log', entry: { source: entry.source, level: entry.level, text: rawCut(entry.text), url: rawCut(entry.url, RAW_URL), lineNumber: entry.lineNumber, timestamp: entry.timestamp, stackTrace: shrinkTrace(entry.stackTrace) } };
  }
  if (e.kind === 'console') {
    const { call } = e;
    return { kind: 'console', call: { type: call.type, timestamp: call.timestamp, args: (call.args ?? []).slice(0, RAW_ARGS).map(shrinkObject), stackTrace: shrinkTrace(call.stackTrace), executionContextId: call.executionContextId } };
  }
  const d = e.thrown.exceptionDetails;
  return {
    kind: 'exception',
    thrown: {
      timestamp: e.thrown.timestamp,
      ...(d ? { exceptionDetails: { text: rawCut(d.text), url: rawCut(d.url, RAW_URL), lineNumber: d.lineNumber, stackTrace: shrinkTrace(d.stackTrace), executionContextId: d.executionContextId, ...(d.exception ? { exception: shrinkObject(d.exception) } : {}) } } : {}),
    },
  };
}

/* ---------- What the model gets ---------- */

export interface DiagnosticsFrame {
  file: string;
  line: number;
  function: string;
}
export type DiagnosticsEntry =
  | { kind: 'console'; level: 'error' | 'warning'; source: string; time: string; text: string; stack?: DiagnosticsFrame[] }
  | { kind: 'exception'; time: string; text: string; stack?: DiagnosticsFrame[] }
  | { kind: 'request'; time: string; url: string; status?: number; error?: string; type: string };

/**
 * An address without what often carries tokens: its query, its fragment and
 * any user name or password. `data:` keeps only its type. A line and column
 * after the query (a stack's `a.js?v=1:3:5`) stay.
 */
export function redactAddress(address: string): string {
  const raw = address.trim();
  if (!raw) return '';
  if (/^data:/i.test(raw)) return `data:${/^data:([^,;]*)/i.exec(raw)?.[1] ?? ''},…`;
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(raw);
  } catch {
    // Not parseable (a bad port, a bad escape): still without its query, fragment, user name or password.
    return raw.split(/[?#]/)[0]!.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1').slice(0, MAX_FILE);
  }
  const tail = raw.search(/[?#]/);
  const position = tail >= 0 ? (/:\d+:\d+$/.exec(raw.slice(tail))?.[0] ?? '') : '';
  // As written: an origin alone stays without a slash, and file: keeps its three.
  const path = u.pathname === '/' && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i.test(raw) ? '' : u.pathname;
  const where =
    u.protocol === 'file:'
      ? `file://${u.pathname}`
      : u.protocol === 'blob:'
        ? `${u.protocol}${u.pathname}`
        : u.origin === 'null'
          ? // A scheme the URL standard doesn't know (chrome-extension:, an app's own) keeps its host, never its user.
            `${u.protocol}${u.host ? `//${u.host}` : ''}${u.pathname}`
          : `${u.origin}${path}`;
  return `${where.slice(0, MAX_FILE)}${position}`;
}

/**
 * Where an address starts inside a message (an error's text or stack), up to its query or fragment:
 * - any scheme (`https:`, `ftp:`, `blob:https:`, …) and `data:`, wherever a word could start (not inside a word,
 *   so `x;https://…` and `<td>https://…` are found whole);
 * - protocol-relative (`//cdn.example/a.js`) and relative (`/api`, `./a`, `../a`) after a space, a quote or a
 *   mark that opens or separates, so prose like `and/or?` stays;
 * - a bare host with a path: `cdn.example.com/a.js`, `localhost:3000/api`, `10.0.0.2/api`, with any user name.
 * A path may hold brackets; the query is found by `queryEnd`, since queries often hold brackets, braces and
 * quotes (`?ids[]=1`, `?q={"t":"…"}`).
 */
const ADDRESS_START = new RegExp(
  [
    String.raw`(?<![\w@%.+-])(?:blob:)?[a-z][a-z0-9+.-]*:\/\/[^\s'"<>\x60?#]*`,
    String.raw`(?<![\w@%.+-])data:[^\s'"<>\x60]*`,
    String.raw`(?<=^|[\s'"(=:,\x60<>[{;|“‘])(?:\/{1,2}|\.{1,2}\/)[^\s'"<>\x60?#]*`,
    String.raw`(?<![\w@%.+-])(?:[^\s\/?#@'"<>\x60]+@)?(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[\w-]+\.)+[a-z]{2,})(?::\d+)?\/[^\s'"<>\x60?#]*`,
  ].join('|'),
  'gi',
);
const FULL_ADDRESS = /^(?:blob:)?[a-z][a-z0-9+.-]*:\/\/|^data:/i;
const CLOSES: Record<string, string> = { "'": "'", '"': '"', '`': '`', '“': '”', '‘': '’', '(': ')', '[': ']', '{': '}', '<': '>' };
const QUOTES = new Set(["'", '"', '`', '”', '’']);
/** What may follow a closing mark for it to end the address, rather than sit inside its query (`O'Brien`). */
const ENDS_AFTER = /[\s,.;:!?)\]}>"'`”’]/;

/**
 * Where a query or fragment that starts at `from` ends. Inside quotes: at the closing quote, or a line's end
 * (a query may hold a space there). Otherwise: at whitespace. Either way, at the mark that closes what the address
 * followed only when it's at depth 0 and what comes after it ends a word; brackets, braces and parentheses nest,
 * and an escaped mark (`\"`) never ends it. When unsure it reads on, which can only remove more.
 */
function queryEnd(text: string, from: number, opener: string | undefined): number {
  const close = opener ? CLOSES[opener] : undefined;
  const quoted = close !== undefined && QUOTES.has(close);
  let depth = 0;
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n' || c === '\r' || (!quoted && /\s/.test(c))) break;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === close && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || ENDS_AFTER.test(next)) break;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth++;
    else if ((c === ']' || c === '}' || c === ')') && depth > 0) depth--;
  }
  return i;
}

export function redactText(text: string): string {
  let out = '';
  let last = 0;
  ADDRESS_START.lastIndex = 0;
  for (let m = ADDRESS_START.exec(text); m; m = ADDRESS_START.exec(text)) {
    const start = m.index;
    const head = m[0];
    let end = start + head.length;
    let position = '';
    // `?` or `#` with nothing after it ends a sentence (`Did you mean /docs?`), it doesn't start a query.
    const mark = text[end];
    if ((mark === '?' || mark === '#') && end + 1 < text.length && !/\s/.test(text[end + 1]!)) {
      const stop = queryEnd(text, end, text[start - 1]);
      position = /:\d+:\d+$/.exec(text.slice(end, stop))?.[0] ?? '';
      end = stop;
    }
    const kept = FULL_ADDRESS.test(head) ? redactAddress(head) : head.replace(/^(\/\/)?[^/?#\s]*@/, '$1').slice(0, MAX_FILE);
    out += text.slice(last, start) + kept + position;
    last = end;
    // Go on from where this address ended, not where its start matched: an address inside its query is its own.
    ADDRESS_START.lastIndex = Math.max(end, start + 1);
  }
  return out + text.slice(last);
}

/** At most `max` characters, and a mark where it was cut. Only what's kept is looked at, however long the text. */
export function cut(text: string, max = DIAGNOSTICS_MAX_TEXT): string {
  if (text.length <= max) return text;
  // Astral characters are two code units: `max * 2` units always hold `max` characters.
  const chars = [...text.slice(0, max * 2)];
  if (chars.length <= max && text.length <= max * 2) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

// Cleaned first, so a character the cleaning removes can't hide a query from the redaction.
const entryText = (text: string) => cut(redactText(cleanPageText(text)));

/** A stack as file, line and function only: no columns, no arguments, no scopes. */
export function stackFrames(trace: CdpStackTrace | undefined): DiagnosticsFrame[] | undefined {
  const frames = (trace?.callFrames ?? []).slice(0, DIAGNOSTICS_MAX_FRAMES).map((f) => ({
    file: redactAddress(f.url ?? ''),
    line: Math.max(0, Math.floor(f.lineNumber ?? 0)) + 1,
    function: cut(f.functionName || '(anonymous)', 100),
  }));
  return frames.length ? frames : undefined;
}

/** One console argument as text: strings as they are, objects by their description or a short preview. */
function argText(o: CdpRemoteObject): string {
  if (o.type === 'string') return String(o.value ?? '');
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === 'undefined') return 'undefined';
  if (o.subtype === 'null') return 'null';
  if (o.type === 'number' || o.type === 'boolean' || o.type === 'bigint') return String(o.value ?? o.description ?? '');
  if (o.subtype === 'error' || o.type === 'function') return o.description ?? '';
  const props = o.preview?.properties;
  if (props && o.subtype !== 'array') return `{${props.map((p) => `${p.name}: ${p.type === 'string' ? JSON.stringify(p.value ?? '') : (p.value ?? '')}`).join(', ')}${o.preview?.overflow ? ', …' : ''}}`;
  if (props) return `[${props.map((p) => (p.type === 'string' ? JSON.stringify(p.value ?? '') : (p.value ?? ''))).join(', ')}${o.preview?.overflow ? ', …' : ''}]`;
  return o.description ?? o.className ?? o.type ?? '';
}

const iso = (ms: number | undefined) => new Date(Number.isFinite(ms) ? ms! : 0).toISOString();

/** A resource's kind from its address, when the page's own timing didn't say. */
function typeFromAddress(url: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(url.split(/[?#]/)[0]!)?.[1]?.toLowerCase() ?? '';
  if (/^m?js$/.test(ext)) return 'script';
  if (ext === 'css') return 'stylesheet';
  if (/^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(ext)) return 'image';
  if (/^(woff2?|ttf|otf|eot)$/.test(ext)) return 'font';
  if (/^(mp4|webm|mp3|ogg|wav|m4a|m3u8|mpd)$/.test(ext)) return 'media';
  if (/^(html?|php|aspx?)$/.test(ext)) return 'document';
  if (ext === 'json') return 'fetch';
  return 'other';
}

/** The Resource Timing API's `initiatorType`, in the names DevTools' Network panel uses. */
const INITIATOR_TYPES: Record<string, string> = {
  img: 'image',
  image: 'image',
  script: 'script',
  fetch: 'fetch',
  xmlhttprequest: 'xhr',
  beacon: 'ping',
  iframe: 'document',
  frame: 'document',
  video: 'media',
  audio: 'media',
  track: 'media',
  embed: 'other',
  object: 'other',
};

/**
 * The entries for the model, oldest first: the newest
 * DIAGNOSTICS_MAX_ENTRIES of the errors and warnings (info and debug messages
 * are left out), each bounded. `types` maps a request's full address to the
 * page's own `initiatorType`, when its timing has one.
 */
export function diagnosticsEntries(
  events: readonly DiagnosticsEvent[],
  types: Readonly<Record<string, string>> = {},
  never: NeverFrames = { sites: [], contexts: {}, page: '' },
): { entries: DiagnosticsEntry[]; total: number } {
  const all: { at: number; entry: DiagnosticsEntry }[] = [];
  const fromNever = neverJudge(never);
  for (const e of events) {
    if (fromNever(e)) continue;
    if (e.kind === 'log') {
      const { entry } = e;
      if (entry.level !== 'error' && entry.level !== 'warning') continue;
      const text = entry.text ?? '';
      const status = /status of (\d{3})\b/.exec(text)?.[1];
      const error = /\b(net::ERR_[A-Z0-9_]+)/.exec(text)?.[1];
      if (entry.source === 'network' && entry.url && (status || error)) {
        const initiator = types[entry.url];
        const type = (initiator && INITIATOR_TYPES[initiator]) || typeFromAddress(entry.url);
        all.push({ at: entry.timestamp ?? 0, entry: { kind: 'request', time: iso(entry.timestamp), url: redactAddress(entry.url), ...(status ? { status: Number(status) } : {}), ...(error ? { error } : {}), type } });
        continue;
      }
      const stack = stackFrames(entry.stackTrace) ?? (entry.url ? [{ file: redactAddress(entry.url), line: Math.max(0, entry.lineNumber ?? 0) + 1, function: '(top)' }] : undefined);
      all.push({ at: entry.timestamp ?? 0, entry: { kind: 'console', level: entry.level, source: entry.source ?? 'other', time: iso(entry.timestamp), text: entryText(text), ...(stack ? { stack } : {}) } });
    } else if (e.kind === 'console') {
      const { call } = e;
      const level = call.type === 'error' || call.type === 'assert' ? 'error' : call.type === 'warning' ? 'warning' : null;
      if (!level) continue;
      const text = (call.args ?? []).map(argText).join(' ');
      const stack = stackFrames(call.stackTrace);
      all.push({ at: call.timestamp ?? 0, entry: { kind: 'console', level, source: 'console', time: iso(call.timestamp), text: entryText(call.type === 'assert' && !text ? 'Assertion failed' : text), ...(stack ? { stack } : {}) } });
    } else {
      const details = e.thrown.exceptionDetails ?? {};
      // "Uncaught" alone says little: the exception's own description has its name and message.
      const described = details.exception?.description?.split('\n')[0];
      const text = described && details.text && !details.text.includes(described) ? `${details.text} ${described}` : (details.text ?? described ?? '');
      const stack = stackFrames(details.stackTrace) ?? (details.url ? [{ file: redactAddress(details.url), line: Math.max(0, details.lineNumber ?? 0) + 1, function: '(top)' }] : undefined);
      all.push({ at: e.thrown.timestamp ?? 0, entry: { kind: 'exception', time: iso(e.thrown.timestamp), text: entryText(text), ...(stack ? { stack } : {}) } });
    }
  }
  // Stable: entries with the same time keep the order Chromium sent them in.
  const sorted = all.map((x, i) => ({ ...x, i })).sort((a, b) => a.at - b.at || a.i - b.i);
  return { entries: sorted.slice(-DIAGNOSTICS_MAX_ENTRIES).map((x) => x.entry), total: sorted.length };
}

/** A script context the read was told about (Runtime.executionContextCreated): whose it is, and in which frame. */
export interface DiagnosticsContext {
  origin: string;
  frameId?: string;
}

/**
 * The *Never read* sites (ARCHITECTURE.md §11.3), and the script contexts the read was told about, by id. A
 * readable page can hold a same-site frame of a site that isn't (`mail.example.com` inside `www.example.com`),
 * and with any *Never read* sites set, the rule fails closed:
 * - an event at such an address, or with any frame of its stack there, is left out;
 * - a console call or exception is kept only from a context Chord was told about, with a web or extension
 *   origin, in a frame that isn't such a site's: an unknown context (0, or a frame since removed or reloaded)
 *   could be anyone's, an opaque one (a `data:` or sandboxed `srcdoc` frame) could sit inside such a frame,
 *   and every context in a *Never read* frame (an extension's content script there too) is that frame's;
 * - when such a site is the page's own site (`mail.example.com` and `www.example.com`), the only case in which
 *   its frame shares the page's process, no `Log` entry is kept: none says which frame it came from, and a frame
 *   removed before the read still has its failed requests replayed. Also when such a frame is in the page anyway.
 */
export interface NeverFrames {
  sites: readonly string[];
  contexts: Readonly<Record<number, DiagnosticsContext>>;
  /** The page's own address (its main frame's). */
  page: string;
}

/** A *Never read* entry's host, as `isNeverReadable` matches it (`https://www.mail.example.com/x` → `mail.example.com`). */
const neverHost = (site: string) =>
  site
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/:].*$/, '');

/** Origins a frame of the web, or an extension, has; not an opaque one (`null`, or none). */
const SITE_ORIGIN = /^(https?|file|chrome-extension):\/\//i;

/** Whether an address is a *Never read* site's. Addresses that aren't a site's (eval'd code, `about:`, an extension's) aren't. */
function onNeverSite(address: string | undefined, sites: readonly string[]): boolean {
  if (!address || !sites.length) return false;
  // A blob's address carries the origin that made it.
  const url = address.trim().replace(/^blob:/i, '');
  return /^(https?|file):/i.test(url) && isNeverReadable(url, sites);
}

/** Which events NeverFrames leaves out. */
function neverJudge({ sites: all, contexts, page }: NeverFrames): (e: DiagnosticsEvent) => boolean {
  // A blank entry names no site.
  const sites = all.filter((s) => neverHost(s));
  if (!sites.length) return () => false;
  const pageHost = hostOf(page);
  const pageSite = pageHost ? siteOf(pageHost) : null;
  const known = Object.values(contexts);
  const neverFrames = new Set(known.filter((c) => c.frameId !== undefined && onNeverSite(c.origin, sites)).map((c) => c.frameId));
  const logsMixed = (pageSite !== null && sites.some((s) => siteOf(neverHost(s)) === pageSite)) || known.some((c) => onNeverSite(c.origin, sites));
  const allowedContext = (id: number | undefined) => {
    const c = id ? contexts[id] : undefined;
    return Boolean(c && SITE_ORIGIN.test(c.origin) && !onNeverSite(c.origin, sites) && !(c.frameId !== undefined && neverFrames.has(c.frameId)));
  };
  return (e) => {
    const trace = e.kind === 'log' ? e.entry.stackTrace : e.kind === 'console' ? e.call.stackTrace : e.thrown.exceptionDetails?.stackTrace;
    const url = e.kind === 'log' ? e.entry.url : e.kind === 'exception' ? e.thrown.exceptionDetails?.url : undefined;
    if ([url, ...(trace?.callFrames ?? []).map((f) => f.url)].some((a) => onNeverSite(a, sites))) return true;
    if (e.kind === 'log') return logsMixed;
    return !allowedContext(e.kind === 'console' ? e.call.executionContextId : e.thrown.exceptionDetails?.executionContextId);
  };
}

/** The activity line's detail: "2 errors · 1 warning · 2 failed requests", or "No problems". */
export function diagnosticsSummary(entries: readonly DiagnosticsEntry[]): string {
  const n = (count: number, one: string, many: string) => (count ? `${count} ${count === 1 ? one : many}` : '');
  const errors = entries.filter((e) => e.kind === 'exception' || (e.kind === 'console' && e.level === 'error')).length;
  const warnings = entries.filter((e) => e.kind === 'console' && e.level === 'warning').length;
  const requests = entries.filter((e) => e.kind === 'request').length;
  return [n(errors, 'error', 'errors'), n(warnings, 'warning', 'warnings'), n(requests, 'failed request', 'failed requests')].filter(Boolean).join(' · ') || 'No problems';
}

/** The tool's result: untrusted page data with its provenance, as read_tab's is. */
export function diagnosticsResult(page: { ref: string; url: string; retrievedAt: number; entries: readonly DiagnosticsEntry[]; total: number; note?: string }): string {
  let origin: string;
  try {
    origin = new URL(page.url).origin;
  } catch {
    origin = '';
  }
  return JSON.stringify({
    source: 'page_diagnostics',
    tab_id: page.ref,
    origin,
    url: redactAddress(page.url),
    retrieved_at: new Date(page.retrievedAt).toISOString(),
    trust: 'untrusted',
    shown: page.entries.length,
    total: page.total,
    ...(page.note ? { note: page.note } : {}),
    entries: page.entries,
  });
}
