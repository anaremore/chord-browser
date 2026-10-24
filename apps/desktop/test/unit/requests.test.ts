/**
 * One onBeforeRequest listener per session, shared (main/requests.ts):
 * handlers add up instead of replacing each other, the listener's filter is
 * every handler's patterns, and with no handler left there's no listener.
 */
import type { OnBeforeRequestListenerDetails, Session } from 'electron';
import { describe, expect, it } from 'vitest';
import { RequestDispatcher } from '../../src/main/requests';

type Listener = (details: OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean }) => void) => void;

function fakeSession() {
  const box: { filter: { urls: string[] } | null; listener: Listener | null; calls: number } = { filter: null, listener: null, calls: 0 };
  const session = {
    webRequest: {
      onBeforeRequest: (filter: { urls: string[] } | null, listener?: Listener) => {
        box.calls++;
        box.filter = listener ? filter : null;
        box.listener = listener ?? null;
      },
    },
  } as unknown as Session;
  const send = (url: string) =>
    new Promise<{ cancel?: boolean }>((resolve) => box.listener!({ url, resourceType: 'script' } as OnBeforeRequestListenerDetails, resolve));
  return { session, box, send };
}

describe('request dispatcher', () => {
  it('shares one listener between handlers, filtered to all their patterns', async () => {
    const { session, box, send } = fakeSession();
    const dispatcher = new RequestDispatcher(session);
    const removeA = dispatcher.add({ urls: ['https://*/*'], handle: (d) => (d.url.includes('ads') ? 'cancel' : undefined) });
    const removeB = dispatcher.add({ urls: ['https://*/*', 'wss://*/*'], handle: (d) => Promise.resolve(d.url.includes('track') ? 'cancel' : undefined) });
    expect(box.filter).toEqual({ urls: ['https://*/*', 'wss://*/*'] });
    expect(await send('https://ads.example/a.js')).toEqual({ cancel: true });
    expect(await send('https://track.example/p.gif')).toEqual({ cancel: true });
    expect(await send('https://cdn.example/lib.js')).toEqual({});
    removeA();
    expect(await send('https://ads.example/a.js')).toEqual({});
    removeB();
    expect(box.listener).toBeNull();
    expect(dispatcher.size).toBe(0);
  });

  it('a handler that throws or rejects lets the request through', async () => {
    const { session, send } = fakeSession();
    const dispatcher = new RequestDispatcher(session);
    dispatcher.add({
      urls: ['https://*/*'],
      handle: () => {
        throw new Error('broken');
      },
    });
    dispatcher.add({ urls: ['https://*/*'], handle: () => Promise.reject(new Error('gone')) });
    expect(await send('https://ads.example/a.js')).toEqual({});
  });
});
