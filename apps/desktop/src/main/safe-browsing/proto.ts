/**
 * The few Safe Browsing v5 messages Chord reads, decoded by hand
 * (google/security/safebrowsing/v5/safebrowsing.proto in googleapis): the
 * service answers in protocol buffers ("All of the response bodies are
 * protocol-buffer formatted payload", developers.google.com/safe-browsing/reference).
 * JSON, the REST reference's other form, is read too. The writers are for
 * tests and the stand-in server.
 */
import type { Rice32 } from './rice';

/** One list in a hashLists.batchGet answer. Only 4-byte prefix lists are used. */
export interface HashListUpdate {
  name: string;
  version: Uint8Array;
  /** A diff against the version sent; false means the whole list (drop what's kept). */
  partialUpdate: boolean;
  additions: Rice32 | null;
  /** Additions of another prefix length: not a list Chord asked for. */
  otherAdditions: boolean;
  removals: Rice32 | null;
  /** The least time before asking for this list again; null (omitted) or 0 means "ask again now". */
  minimumWaitMs: number | null;
  /** SHA-256 of every prefix after the update, sorted and concatenated; null when nothing changed. */
  checksum: Uint8Array | null;
}

export interface FullHashDetail {
  /** ThreatType: 1 MALWARE, 2 SOCIAL_ENGINEERING, 3 UNWANTED_SOFTWARE, 4 POTENTIALLY_HARMFUL_APPLICATION; anything else is invalid. */
  threatType: number;
  /** ThreatAttribute: 1 CANARY, 2 FRAME_ONLY; anything else is invalid. */
  attributes: number[];
}

export interface FullHash {
  fullHash: Uint8Array;
  details: FullHashDetail[];
}

/** A hashes.search answer. */
export interface SearchAnswer {
  fullHashes: FullHash[];
  /** How long the answer holds, for every prefix asked about; null when the service didn't say. */
  cacheDurationMs: number | null;
}

export class ProtoError extends Error {}

const THREAT_TYPES: Record<string, number> = { THREAT_TYPE_UNSPECIFIED: 0, MALWARE: 1, SOCIAL_ENGINEERING: 2, UNWANTED_SOFTWARE: 3, POTENTIALLY_HARMFUL_APPLICATION: 4 };
const ATTRIBUTES: Record<string, number> = { THREAT_ATTRIBUTE_UNSPECIFIED: 0, CANARY: 1, FRAME_ONLY: 2 };

class Reader {
  pos: number;
  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    private readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      if (this.pos >= this.end || shift > 63) throw new ProtoError('bad varint');
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
    }
  }

  tag(): { field: number; wire: number } {
    const tag = this.varint();
    return { field: Math.floor(tag / 8), wire: tag % 8 };
  }

  bytes(): Uint8Array {
    const length = this.varint();
    if (this.pos + length > this.end) throw new ProtoError('truncated field');
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  message(): Reader {
    const body = this.bytes();
    return new Reader(body);
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new ProtoError(`unsupported wire type ${wire}`);
    if (this.pos > this.end) throw new ProtoError('truncated field');
  }
}

const utf8 = new TextDecoder();

function readRice(r: Reader): Rice32 {
  const rice: Rice32 = { firstValue: 0, riceParameter: 0, entriesCount: 0, encodedData: new Uint8Array(0) };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) rice.firstValue = r.varint();
    else if (field === 2 && wire === 0) rice.riceParameter = r.varint();
    else if (field === 3 && wire === 0) rice.entriesCount = r.varint();
    else if (field === 4 && wire === 2) rice.encodedData = r.bytes();
    else r.skip(wire);
  }
  return rice;
}

function readDuration(r: Reader): number {
  let seconds = 0;
  let nanos = 0;
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) seconds = r.varint();
    else if (field === 2 && wire === 0) nanos = r.varint();
    else r.skip(wire);
  }
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

function readHashList(r: Reader): HashListUpdate {
  const list: HashListUpdate = { name: '', version: new Uint8Array(0), partialUpdate: false, additions: null, otherAdditions: false, removals: null, minimumWaitMs: null, checksum: null };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) list.name = utf8.decode(r.bytes());
    else if (field === 2 && wire === 2) list.version = r.bytes().slice();
    else if (field === 3 && wire === 0) list.partialUpdate = r.varint() !== 0;
    else if (field === 4 && wire === 2) list.additions = readRice(r.message());
    else if (field === 5 && wire === 2) list.removals = readRice(r.message());
    else if (field === 6 && wire === 2) list.minimumWaitMs = readDuration(r.message());
    else if (field === 7 && wire === 2) list.checksum = r.bytes().slice();
    else if ((field === 9 || field === 10 || field === 11) && wire === 2) {
      list.otherAdditions = true;
      r.skip(wire);
    } else r.skip(wire);
  }
  if (list.checksum?.length === 0) list.checksum = null;
  return list;
}

function readDetail(r: Reader): FullHashDetail {
  const detail: FullHashDetail = { threatType: 0, attributes: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) detail.threatType = r.varint();
    else if (field === 2 && wire === 0) detail.attributes.push(r.varint());
    else if (field === 2 && wire === 2) {
      // Packed, as proto3 writes repeated enums.
      const packed = r.message();
      while (!packed.done) detail.attributes.push(packed.varint());
    } else r.skip(wire);
  }
  return detail;
}

function readFullHash(r: Reader): FullHash {
  const hash: FullHash = { fullHash: new Uint8Array(0), details: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) hash.fullHash = r.bytes().slice();
    else if (field === 2 && wire === 2) hash.details.push(readDetail(r.message()));
    else r.skip(wire);
  }
  return hash;
}

/** A BatchGetHashListsResponse, in protobuf. */
export function decodeBatchGet(body: Uint8Array): HashListUpdate[] {
  const r = new Reader(body);
  const lists: HashListUpdate[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) lists.push(readHashList(r.message()));
    else r.skip(wire);
  }
  return lists;
}

/** A SearchHashesResponse, in protobuf. */
export function decodeSearch(body: Uint8Array): SearchAnswer {
  const r = new Reader(body);
  const answer: SearchAnswer = { fullHashes: [], cacheDurationMs: null };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) answer.fullHashes.push(readFullHash(r.message()));
    else if (field === 2 && wire === 2) answer.cacheDurationMs = readDuration(r.message());
    else r.skip(wire);
  }
  return answer;
}

/* ---------- JSON, the REST reference's form ---------- */

const fromBase64 = (value: unknown): Uint8Array => (typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'base64')) : new Uint8Array(0));
const toNumber = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0);

/** "3.5s" → 3500. */
export function parseDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(value);
  return match ? Number(match[1]) * 1000 + Math.floor(Number(`0.${match[2] ?? '0'}`) * 1000) : null;
}

const enumValue = (table: Record<string, number>, value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' ? (table[value] ?? -1) : 0);

function riceFromJson(value: unknown): Rice32 | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return { firstValue: toNumber(v['firstValue']), riceParameter: toNumber(v['riceParameter']), entriesCount: toNumber(v['entriesCount']), encodedData: fromBase64(v['encodedData']) };
}

export function batchGetFromJson(json: unknown): HashListUpdate[] {
  const lists = (json as { hashLists?: unknown[] } | null)?.hashLists;
  if (!Array.isArray(lists)) return [];
  return lists.map((raw) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    const checksum = fromBase64(v['sha256Checksum']);
    return {
      name: typeof v['name'] === 'string' ? v['name'] : '',
      version: fromBase64(v['version']),
      partialUpdate: v['partialUpdate'] === true,
      additions: riceFromJson(v['additionsFourBytes']),
      otherAdditions: Boolean(v['additionsEightBytes'] ?? v['additionsSixteenBytes'] ?? v['additionsThirtyTwoBytes']),
      removals: riceFromJson(v['compressedRemovals']),
      minimumWaitMs: parseDuration(v['minimumWaitDuration']),
      checksum: checksum.length > 0 ? checksum : null,
    };
  });
}

export function searchFromJson(json: unknown): SearchAnswer {
  const v = (json ?? {}) as Record<string, unknown>;
  const hashes = Array.isArray(v['fullHashes']) ? v['fullHashes'] : [];
  return {
    cacheDurationMs: parseDuration(v['cacheDuration']),
    fullHashes: hashes.map((raw) => {
      const h = (raw ?? {}) as Record<string, unknown>;
      const details = Array.isArray(h['fullHashDetails']) ? h['fullHashDetails'] : [];
      return {
        fullHash: fromBase64(h['fullHash']),
        details: details.map((d) => {
          const detail = (d ?? {}) as Record<string, unknown>;
          return {
            threatType: enumValue(THREAT_TYPES, detail['threatType']),
            attributes: (Array.isArray(detail['attributes']) ? detail['attributes'] : []).map((a) => enumValue(ATTRIBUTES, a)),
          };
        }),
      };
    }),
  };
}

/* ---------- Writers (tests and the stand-in server) ---------- */

class Writer {
  private readonly out: number[] = [];

  varint(value: number): this {
    let n = value;
    while (n >= 0x80) {
      this.out.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.out.push(n);
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  uint(field: number, value: number): this {
    return value === 0 ? this : this.tag(field, 0).varint(value);
  }

  bytes(field: number, data: Uint8Array): this {
    this.tag(field, 2).varint(data.length);
    for (const b of data) this.out.push(b);
    return this;
  }

  message(field: number, inner: Writer): this {
    return this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

const riceWriter = (rice: Rice32) => new Writer().uint(1, rice.firstValue).uint(2, rice.riceParameter).uint(3, rice.entriesCount).bytes(4, rice.encodedData);
const durationWriter = (ms: number) => new Writer().uint(1, Math.floor(ms / 1000)).uint(2, (ms % 1000) * 1e6);

export function encodeBatchGet(lists: readonly HashListUpdate[]): Uint8Array {
  const w = new Writer();
  for (const list of lists) {
    const l = new Writer().bytes(1, new TextEncoder().encode(list.name)).bytes(2, list.version);
    if (list.partialUpdate) l.uint(3, 1);
    if (list.additions) l.message(4, riceWriter(list.additions));
    if (list.removals) l.message(5, riceWriter(list.removals));
    if (list.minimumWaitMs !== null) l.message(6, durationWriter(list.minimumWaitMs));
    if (list.checksum) l.bytes(7, list.checksum);
    w.message(1, l);
  }
  return w.finish();
}

export function encodeSearch(answer: SearchAnswer): Uint8Array {
  const w = new Writer();
  for (const hash of answer.fullHashes) {
    const h = new Writer().bytes(1, hash.fullHash);
    for (const detail of hash.details) {
      const d = new Writer().uint(1, detail.threatType);
      if (detail.attributes.length > 0) {
        const packed = new Writer();
        for (const a of detail.attributes) packed.varint(a);
        d.bytes(2, packed.finish());
      }
      h.message(2, d);
    }
    w.message(1, h);
  }
  if (answer.cacheDurationMs !== null) w.message(2, durationWriter(answer.cacheDurationMs));
  return w.finish();
}
