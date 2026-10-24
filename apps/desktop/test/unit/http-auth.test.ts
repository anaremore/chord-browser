import type { AuthInfo, AuthenticationResponseDetails, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { AuthBroker } from '../../src/main/http-auth';

/** Just enough of a page: its address, and the tab it belongs to. */
const page = (url: string, nodeId: string | null = 'tab-1') => ({ url, nodeId: nodeId ?? undefined, getURL: () => url, isDestroyed: () => false }) as unknown as WebContents & { nodeId?: string };

function setUp() {
  const broker = new AuthBroker();
  const onChange = vi.fn();
  broker.connect({ nodeFor: (contents) => (contents as unknown as { nodeId?: string }).nodeId as never, onChange });
  return { broker, onChange };
}

const details = (url: string, more: Partial<AuthenticationResponseDetails> = {}) =>
  ({ url, pid: 1, isRequestForNavigation: true, firstAuthAttempt: true, responseHeaders: {}, ...more }) as AuthenticationResponseDetails;
const info = (more: Partial<AuthInfo> = {}): AuthInfo => ({ isProxy: false, scheme: 'basic', host: 'router.local', port: 80, realm: 'Admin', ...more });

describe('AuthBroker', () => {
  it("asks over the tab, signs in with what was typed, and keeps nothing", () => {
    const { broker, onChange } = setUp();
    const answer = vi.fn();
    expect(broker.login(page('https://example.com/'), details('http://router.local/'), info(), answer)).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    const prompt = broker.promptFor('tab-1' as never)!;
    expect(prompt).toEqual({ id: prompt.id, origin: 'http://router.local', realm: 'Admin', proxy: false, insecure: true, retry: false });
    expect(broker.promptFor('tab-2' as never)).toBeNull();

    broker.respond(prompt.id, { username: 'me', password: 'secret' });
    expect(answer).toHaveBeenCalledWith('me', 'secret');
    expect(broker.promptFor('tab-1' as never)).toBeNull();
  });

  it('cancels a box when asked to, and when its tab navigates away or closes', () => {
    const { broker } = setUp();
    const first = vi.fn();
    broker.login(page('https://a.test/'), details('https://a.test/'), info(), first);
    broker.respond(broker.promptFor('tab-1' as never)!.id, null);
    expect(first).toHaveBeenCalledWith();

    const second = vi.fn();
    broker.login(page('https://a.test/'), details('https://a.test/'), info(), second);
    broker.forgetTab('tab-1' as never);
    expect(second).toHaveBeenCalledWith();
    expect(broker.promptFor('tab-1' as never)).toBeNull();
  });

  it('leaves to Electron (which cancels) whatever no tab asked for, and other sites’ images and scripts', () => {
    const { broker, onChange } = setUp();
    expect(broker.login(null, details('https://a.test/'), info(), vi.fn())).toBe(false);
    expect(broker.login(page('chord://shell/', null), details('https://a.test/'), info(), vi.fn())).toBe(false);
    expect(broker.login(page('https://news.test/'), details('https://tracker.test/pixel.gif', { isRequestForNavigation: false }), info(), vi.fn())).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // The page's own site may ask for its subresources.
    expect(broker.login(page('https://intranet.test/'), details('https://intranet.test/api', { isRequestForNavigation: false }), info(), vi.fn())).toBe(true);
  });

  it('answers every request waiting on the same box at once, and says when the last answer failed', () => {
    const { broker } = setUp();
    const a = vi.fn();
    const b = vi.fn();
    broker.login(page('https://a.test/'), details('https://a.test/'), info(), a);
    broker.login(page('https://a.test/'), details('https://a.test/', { firstAuthAttempt: false }), info(), b);
    const prompt = broker.promptFor('tab-1' as never)!;
    expect(prompt.retry).toBe(true);
    broker.respond(prompt.id, { username: 'u', password: 'p' });
    expect(a).toHaveBeenCalledWith('u', 'p');
    expect(b).toHaveBeenCalledWith('u', 'p');
  });

  it('names a proxy by host and port, trims the realm to one short line, and trusts HTTPS and this computer', () => {
    const { broker } = setUp();
    broker.login(page('https://a.test/'), details('https://a.test/'), info({ isProxy: true, host: 'proxy.corp', port: 3128, realm: `  Corp\n\n${'x'.repeat(300)}` }), vi.fn());
    const proxy = broker.promptFor('tab-1' as never)!;
    expect(proxy).toMatchObject({ origin: 'proxy.corp:3128', proxy: true, insecure: false });
    expect(proxy.realm.startsWith('Corp x')).toBe(true);
    expect(proxy.realm).toHaveLength(120);
    broker.respond(proxy.id, null);

    broker.login(page('http://localhost:8080/'), details('http://localhost:8080/'), info(), vi.fn());
    expect(broker.promptFor('tab-1' as never)!.insecure).toBe(false);
  });
});
