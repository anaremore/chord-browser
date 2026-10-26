/**
 * Hostile Chord files (S15 §5, §9): everything from a file is untrusted. Each
 * file here is read as the import process reads it (`openDataFile`, a stream
 * of pieces, the records' codecs, the merge planner), and what would reach the
 * store, Effects' sanitizer, chord-data or Duet's images folder is checked.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DATA_HEAD,
  dataHeader,
  effectsParts,
  encryptedWriter,
  imageFromRecord,
  IMPORT_LIMITS,
  MAX_LINE,
  messageFromRecord,
  openDataFile,
  planMerge,
  plainWriter,
  setupRecord,
  type DataRecord,
  type DataFileProblem,
} from '@chord/core';
import { nodeCrypto } from '@chord/data/crypto';
import { IMAGE_FILE, writeImage } from '../../src/import-file/images';
import { compileEffects } from '../../src/main/effects/sanitize';
import { fetches, HOSTILE } from './fixtures/hostile-css';

const THERE = '00000000000000bb';
const at = [1_760_000_000_000, 0, THERE] as const;
const header = dataHeader({ app: '0.5.0', device: THERE, created: Date.UTC(2026, 10, 30), includes: ['setup', 'today', 'history', 'duet'] });

/** A plain file of these lines (records, or anything at all). */
function file(lines: readonly (DataRecord | string)[], end = true): Uint8Array {
  const writer = plainWriter(header);
  const body = lines.map((l) => (typeof l === 'string' ? `${l}\n` : `${JSON.stringify(l)}\n`)).join('');
  return Buffer.concat([writer.head, Buffer.from(body), end ? Buffer.from(`{"end":${lines.length}}\n`) : Buffer.alloc(0)]);
}

/** As the import process reads it: the head, then a megabyte at a time. */
async function read(bytes: Uint8Array): Promise<{ problem: DataFileProblem | null; records: DataRecord[] }> {
  const opened = await openDataFile(bytes.subarray(0, DATA_HEAD), bytes.length, null, nodeCrypto);
  const stream = opened.records();
  if (!stream) return { problem: opened.problem, records: [] };
  const records: DataRecord[] = [];
  for (let start = opened.start; start < bytes.length; start += 1024 * 1024) records.push(...stream.push(bytes.subarray(start, start + 1024 * 1024)));
  records.push(...stream.end());
  return { problem: stream.problem, records };
}

const plan = (records: DataRecord[]) => planMerge({ local: [], file: records, choices: { effects: true, settings: true }, platform: 'linux', now: 1_800_000_000_000, newId: () => 'id' });
const chord: DataRecord = { type: 'chord', id: 'c1', at: [...at], set: { name: 'Work', icon: 'W', theme: { stops: [{ l: 0.7, c: 0.1, h: 200 }], grain: 0.2, appearance: 'auto' }, rank: 'a0', profile: 'default' } };

describe('a hostile Chord file', () => {
  it.each(HOSTILE)('Effects: %s comes in only as the sanitizer leaves it, as your CSS or as a patch', async (_what, css) => {
    const { records } = await read(file([{ type: 'effects', id: 'news.test', at: [...at], set: { css, duet: [{ ask: 'x', summary: 'y', css, on: true }] } }]));
    const [site] = plan(records).effects;
    expect(site).toBeDefined();
    // What main's Effects service does with each site before any of it is used.
    expect(fetches(compileEffects(effectsParts(site!)).css)).toEqual([]);
  });

  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['chrome:', 'chrome://settings'],
  ])('Duet: a %s link in a citation or an attachment is dropped; the message stays', (_scheme, url) => {
    const message = messageFromRecord({
      type: 'message',
      id: 'm1',
      set: {
        thread: 't1',
        created: 1,
        body: {
          role: 'assistant',
          text: 'Look [1] and [2]',
          citations: [
            { n: 1, ref: 't1', url, title: 'Evil', quote: 'q', tabId: null },
            { n: 2, ref: 't2', url: 'https://ok.test/', title: 'Fine', quote: 'q', tabId: 'node-7' },
          ],
          status: 'done',
        },
      },
    });
    expect(message?.body).toMatchObject({ role: 'assistant', citations: [{ n: 2, url: 'https://ok.test/', tabId: null }] });
    const user = messageFromRecord({ type: 'message', id: 'm2', set: { thread: 't1', created: 1, body: { role: 'user', text: 'Hi', attachments: [{ ref: 't1', url, title: 'x' }] } } });
    expect(user?.body).toMatchObject({ role: 'user', attachments: [] });
  });

  it('Duet: a citation that isn’t one (no handle, a huge quote, a page that isn’t a number) is dropped', () => {
    const message = messageFromRecord({
      type: 'message',
      id: 'm1',
      set: {
        thread: 't1',
        created: 1,
        body: {
          role: 'assistant',
          text: 'x',
          citations: [
            { n: 1, ref: '"><img src=x>', url: 'https://a.test/', title: 'a', quote: 'q' },
            { n: 2, ref: 't2', url: 'https://a.test/', title: 'a', quote: 'q'.repeat(5000) },
            { n: 3, ref: 't3', url: 'https://a.test/', title: 'a', quote: 'q', page: 'one' },
          ],
          status: 'done',
        },
      },
    });
    expect(message?.body.role === 'assistant' && message.body.citations).toEqual([{ n: 3, ref: 't3', url: 'https://a.test/', title: 'a', quote: 'q', tabId: null }]);
  });

  describe('an image record', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0, 1, 0, 1, 0x03, 0x01, 0x22, 0x00]);
    const record = (mime: string, data: Uint8Array, thumb: Uint8Array | null = null, id = 'abcdefabcdefabcdefabcdef'): DataRecord => ({
      type: 'image',
      id,
      set: { mime, width: 1, height: 1, data: Buffer.from(data).toString('base64'), thumb: thumb ? Buffer.from(thumb).toString('base64') : null, prompt: null },
    });
    const dirs: string[] = [];
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });
    const folder = () => {
      const dir = mkdtempSync(join(tmpdir(), 'chord-images-'));
      dirs.push(dir);
      return dir;
    };
    /** As the import process writes it, with main's side of it: every file named before it's written, and what wasn't after all. */
    const write = async (r: DataRecord, dir = folder(), before: (files: string[]) => void = () => undefined) => {
      const named: string[] = [];
      const unwritten: string[] = [];
      const image = imageFromRecord(r);
      const written = image
        ? await writeImage(image, dir, {
            writing: async (files) => {
              named.push(...files);
              before(files);
            },
            unwritten: (files) => unwritten.push(...files),
          })
        : [];
      return { dir, written, named, unwritten };
    };

    it.each<[string, DataRecord]>([
      ['text that says it’s a PNG', record('image/png', Buffer.from('#!/bin/sh\nrm -rf ~\n'))],
      ['an HTML page that says it’s a JPEG', record('image/jpeg', Buffer.from('<html><script>alert(1)</script></html>'))],
      ['a PNG that says it’s a JPEG', record('image/jpeg', PNG)],
      ['an SVG', record('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'))],
      ['a name that isn’t an image id', record('image/png', PNG, null, '../../settings')],
    ])('isn’t written: %s', async (_what, r) => {
      const { dir, written, named } = await write(r);
      expect(written).toEqual([]);
      expect(named).toEqual([]);
      expect(existsSync(join(dir, 'abcdefabcdefabcdefabcdef.png'))).toBe(false);
      expect(existsSync(join(dir, 'abcdefabcdefabcdefabcdef.jpg'))).toBe(false);
    });

    it('is written when it’s really the picture it says, with a thumbnail only if that’s really a JPEG; each file named first', async () => {
      const { dir, written, named } = await write(record('image/png', PNG, Buffer.from('not a jpeg')));
      expect(written).toEqual(['abcdefabcdefabcdefabcdef.png']);
      expect(named).toEqual(written);
      expect(readFileSync(join(dir, 'abcdefabcdefabcdefabcdef.png'))).toEqual(PNG);
      expect(existsSync(join(dir, 'abcdefabcdefabcdefabcdef.thumb.jpg'))).toBe(false);
      const second = await write(record('image/png', PNG, JPEG, 'bbbbbbbbbbbbbbbbbbbbbbbb'), dir);
      // The picture and its thumbnail apart: Undo deletes exactly these.
      expect(second.written).toEqual(['bbbbbbbbbbbbbbbbbbbbbbbb.png', 'bbbbbbbbbbbbbbbbbbbbbbbb.thumb.jpg']);
      expect(readFileSync(join(dir, 'bbbbbbbbbbbbbbbbbbbbbbbb.thumb.jpg'))).toEqual(JPEG);
    });

    it.each([
      ['its picture, of the same type', 'abcdefabcdefabcdefabcdef.png'],
      ['its picture, of another type', 'abcdefabcdefabcdefabcdef.jpg'],
      ['its thumbnail', 'abcdefabcdefabcdefabcdef.thumb.jpg'],
    ])('isn’t written, nor anything of it, when an image here already has its id: %s', async (_what, mine) => {
      const dir = folder();
      writeFileSync(join(dir, mine), 'mine');
      const { written, named } = await write(record('image/png', PNG, JPEG), dir);
      expect(written).toEqual([]);
      expect(named).toEqual([]);
      expect(readFileSync(join(dir, mine), 'utf8')).toBe('mine');
      expect(readdirSync(dir)).toEqual([mine]);
    });

    it('a file that appears between being named and written is someone else’s: not written over, and said to be unwritten', async () => {
      const dir = folder();
      const { written, named, unwritten } = await write(record('image/png', PNG, JPEG), dir, () => writeFileSync(join(dir, 'abcdefabcdefabcdefabcdef.png'), 'theirs'));
      expect(named).toEqual(['abcdefabcdefabcdefabcdef.png', 'abcdefabcdefabcdefabcdef.thumb.jpg']);
      expect(written).toEqual([]);
      expect(unwritten).toEqual(named);
      expect(readFileSync(join(dir, 'abcdefabcdefabcdefabcdef.png'), 'utf8')).toBe('theirs');
    });

    it('main deletes only image files it was told of: a name, never a path', () => {
      for (const ok of ['abcdefabcdefabcdefabcdef.png', 'abcdefabcdefabcdefabcdef.jpg', 'abcdefabcdefabcdefabcdef.webp', 'abcdefabcdefabcdefabcdef.thumb.jpg']) expect(IMAGE_FILE.test(ok)).toBe(true);
      for (const bad of ['../chord.db', 'abcdefabcdefabcdefabcdef.png/../../x', 'ABCDEFABCDEFABCDEFABCDEF.png', 'abcdef.png', 'abcdefabcdefabcdefabcdef.thumb.png', 'abcdefabcdefabcdefabcdef.svg', 'abcdefabcdefabcdefabcdef.png\n'])
        expect(IMAGE_FILE.test(bad)).toBe(false);
    });
  });

  it('a line past 32 MB is refused, and the rest of the file still reads', async () => {
    const huge = `{"type":"image","id":"abcdefabcdefabcdefabcdef","set":{"data":"${'A'.repeat(MAX_LINE)}"}}`;
    const { problem, records } = await read(file([chord, huge, { ...chord, id: 'c2', set: { ...chord.set, name: 'Home', rank: 'b0' } }]));
    expect(problem).toBe('damaged');
    expect(records.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(plan(records).chords.map((c) => c.name)).toEqual(['Work', 'Home']);
  });

  it('a newer Chord’s types are passed over and counted; the rest comes in', async () => {
    const { problem, records } = await read(file([chord, { type: 'reading-list', id: 'r1', set: { url: 'javascript:alert(1)' } }, { type: 'vault', id: 'v', at: [...at], set: { secret: 1 } }]));
    expect(problem).toBeNull();
    const p = plan(records);
    expect(p.skipped).toBe(2);
    expect(p.chords).toHaveLength(1);
  });

  it('lines that aren’t records, or that lie about their types, are left out', async () => {
    const { problem, records } = await read(
      file([
        chord,
        'not json',
        '{"type":"TAB","id":"x","set":{}}',
        { type: 'tab', id: 'evil', at: [...at], set: { pos: { chord: 'c1', section: 'pinned', parent: null, rank: 'a0' }, url: 'javascript:alert(1)', title: 'x' } },
        { type: 'tab', id: 'local', at: [...at], set: { pos: { chord: 'c1', section: 'today', parent: null, rank: 'a0' }, url: 'file:///etc/passwd', title: 'x' } },
        { type: 'favorite', id: 'f', at: [...at], set: { url: 'javascript:alert(1)', title: 'x', rank: 'a0' } },
        { type: 'route', id: 'not a route', at: [...at], set: { chord: 'c1' } },
        { type: 'permission', id: 'https://meet.test', at: [...at], set: { camera: 'allow', microphone: 'allow' } },
        { type: 'chord', id: 'spy', at: [...at], set: { ...chord.set, profile: 'private-w1', rank: 'z0' } },
      ]),
    );
    expect(problem).toBe('damaged');
    const p = plan(records);
    expect(p.chords.map((c) => c.id)).toEqual(['c1']);
    expect(p.nodes).toEqual([]);
    expect(p.favorites).toEqual([]);
    expect(p.routes).toEqual([]);
    // Allows only: nothing to block.
    expect(p.blocks).toEqual({});
  });

  it('a damaged frame in an encrypted file is passed over: what the other frames hold still comes in', async () => {
    // Enough chords for several frames (about 256 KB of lines each).
    const chords = Array.from({ length: 900 }, (_, i): DataRecord => ({ ...chord, id: `c${i}`, set: { ...chord.set, name: `Chord ${i}`, rank: `a${String(i).padStart(4, '0')}`, notes: 'x'.repeat(400) } }));
    const writer = await encryptedWriter(header, 'harbor tulip velvet orbit', nodeCrypto, { N: 2 ** 10, r: 8, p: 1 });
    const bytes = Buffer.concat([writer.head, ...chords.flatMap((r) => writer.add(r)), ...writer.end()]);
    const start = bytes.indexOf(0x0a, bytes.indexOf(0x0a) + 1) + 1;
    const second = start + 4 + bytes.readUInt32BE(start);
    bytes[second + 40]! ^= 1;
    const opened = await openDataFile(bytes.subarray(0, DATA_HEAD), bytes.length, 'harbor tulip velvet orbit', nodeCrypto);
    const stream = opened.records()!;
    const records = [...stream.push(bytes.subarray(opened.start)), ...stream.end()];
    expect(stream.problem).toBe('damaged');
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(chords.length);
    expect(records.map((r) => r.id)).toContain('c899');
    // Planned like any file's, within what one import brings.
    const p = plan(records);
    expect(p.chords).toHaveLength(Math.min(records.length, IMPORT_LIMITS.chords));
    expect(p.capped.chords).toBe(records.length - p.chords.length);
  });

  it('a record’s fields Chord doesn’t read are dropped as it’s read, so a file can’t fill memory with them until the plan', async () => {
    const padded: DataRecord = { ...chord, set: { ...chord.set, padding: 'x'.repeat(1_000_000), nested: { more: 'y'.repeat(1_000_000) } } };
    const { records } = await read(file([padded]));
    const kept = setupRecord(records[0]!, 'linux')!;
    expect(JSON.stringify(kept).length).toBeLessThan(1000);
    expect(plan([kept]).chords.map((c) => c.name)).toEqual(['Work']);
  });

  it('cut short, it reads what’s there and says so', async () => {
    const { problem, records } = await read(file([chord], false));
    expect(problem).toBe('cut-short');
    expect(records).toHaveLength(1);
  });
});
