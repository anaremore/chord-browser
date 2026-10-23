import { describe, expect, it } from 'vitest';
import { POPUP_MAX, popupPosition, popupSize } from '../../src/main/extensions/geometry';
import { isNewerVersion, parseUpdateResponse, updateCheckUrl, WebStore, type Fetch } from '../../src/main/extensions/webstore';
import { sha256Hex } from '../fixtures/crx';

const ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh';

describe('the update service', () => {
  it('asks about every extension in one request, at the versions we have', () => {
    const url = new URL(updateCheckUrl('https://clients2.google.com/service/update2/crx', '156.0.8078.48', [{ id: ID, version: '1.2' }, { id: 'a'.repeat(32) }]));
    expect(url.searchParams.get('prodversion')).toBe('156.0.8078.48');
    expect(url.searchParams.get('acceptformat')).toBe('crx3');
    const xs = url.searchParams.getAll('x').map((x) => Object.fromEntries(new URLSearchParams(x)));
    expect(xs).toEqual([
      { id: ID, v: '1.2', installsource: 'ondemand', uc: '' },
      { id: 'a'.repeat(32), v: '0.0.0.0', installsource: 'ondemand', uc: '' },
    ]);
  });

  it('reads gupdate responses, entities and all', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod">
  <daystart elapsed_days="7000" elapsed_seconds="100"/>
  <app appid="${ID}" cohort="1::" status="ok">
    <updatecheck codebase="https://clients2.googleusercontent.com/crx/blobs/x/A.crx?a=1&amp;b=2" fp="1.abc" hash_sha256="ABCDEF" protected="0" size="10" status="ok" version="2026.1021.1354"/>
  </app>
  <app appid="${'b'.repeat(32)}" status="ok"><updatecheck status="noupdate"/></app>
</gupdate>`;
    expect(parseUpdateResponse(xml)).toEqual([
      { id: ID, status: 'ok', version: '2026.1021.1354', codebase: 'https://clients2.googleusercontent.com/crx/blobs/x/A.crx?a=1&b=2', sha256: 'ABCDEF' },
      { id: 'b'.repeat(32), status: 'noupdate', version: null, codebase: null, sha256: null },
    ]);
  });

  it('downloads over HTTPS only, and only what matches the announced hash', async () => {
    const body = Buffer.from('the package');
    const fetch: Fetch = async () => ({ ok: true, status: 200, text: async () => '', arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });
    const store = new WebStore({ fetch, prodversion: '156' });
    const info = { id: ID, status: 'ok', version: '1', codebase: 'https://example.com/a.crx', sha256: sha256Hex(body).toUpperCase() };
    expect((await store.download(info)).equals(body)).toBe(true);
    await expect(store.download({ ...info, sha256: sha256Hex('something else') })).rejects.toThrow(/doesn’t match/);
    await expect(store.download({ ...info, codebase: 'http://example.com/a.crx' })).rejects.toThrow(/HTTPS/);
    await expect(store.download({ ...info, codebase: 'http://127.0.0.1:4000/a.crx' })).resolves.toBeInstanceOf(Buffer);
    await expect(new WebStore({ fetch, prodversion: '156', maxBytes: 3 }).download(info)).rejects.toThrow(/too big/);
  });

  it('compares versions number by number', () => {
    expect(isNewerVersion('2026.1021.1354', '2026.1013.1')).toBe(true);
    expect(isNewerVersion('1.10', '1.9')).toBe(true);
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.2', '1.2.0.1')).toBe(false);
  });
});

describe('popup geometry', () => {
  const window = { width: 1280, height: 820, frameTop: 40 };

  it('fits Chrome’s limits and the window', () => {
    expect(popupSize({ width: 273.4, height: 223 }, window)).toEqual({ width: 274, height: 223 });
    expect(popupSize({ width: 2, height: 2 }, window)).toEqual({ width: 25, height: 25 });
    expect(popupSize({ width: 5000, height: 5000 }, window)).toEqual(POPUP_MAX);
    expect(popupSize({ width: 800, height: 600 }, { width: 500, height: 400 })).toEqual({ width: 484, height: 384 });
  });

  it('opens by its button: under it in the bar (right-aligned), above it in the shelf (left-aligned), inside the window', () => {
    const popup = { width: 300, height: 200 };
    expect(popupPosition(popup, { x: 1100, y: 8, width: 28, height: 28 }, window)).toEqual({ x: 828, y: 40 });
    expect(popupPosition(popup, { x: 40, y: 50, width: 28, height: 28 }, window)).toEqual({ x: 40, y: 82 });
    expect(popupPosition(popup, { x: 1260, y: 8, width: 28, height: 28 }, window).x).toBe(1280 - 300 - 4);
    expect(popupPosition(popup, null, window)).toEqual({ x: 976, y: 48 });
    expect(popupPosition(popup, { x: 12, y: 740, width: 28, height: 28 }, window)).toEqual({ x: 12, y: 536 });
    expect(popupPosition({ width: 300, height: 760 }, { x: 12, y: 740, width: 28, height: 28 }, window).y).toBe(4);
  });
});
