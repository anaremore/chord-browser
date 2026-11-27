/**
 * #331 (the owner's yes to Carbon's SF4, 2026-11-26): while a chord's proxy is failing (its own, or the one for every
 * chord), the proxy icon in its header is a warning button, named for what it says and what it does, opening the
 * proxy that's failing as the toast's Settings does. Gone once it works.
 */
import { describe, expect, it } from 'vitest';
import { proxySign } from '../../src/renderer/shell/proxy-sign';

const work = { id: 'c1', name: 'Work' };

describe('the header’s proxy sign (#331)', () => {
  it('nothing failing for this chord: no sign', () => {
    expect(proxySign([], work)).toBeNull();
    expect(proxySign([{ chordId: 'c2', own: true }], work)).toBeNull();
  });

  it('its own proxy failing: named for it, opening its own proxy', () => {
    expect(proxySign([{ chordId: 'c1', own: true }], work)).toEqual({ label: 'Work’s proxy isn’t working, Proxy settings', target: 'c1' });
  });

  it('the proxy for every chord failing: the same words, opening the proxy for every chord', () => {
    expect(proxySign([{ chordId: 'c1', own: false }], work)).toEqual({ label: 'Work’s proxy isn’t working, Proxy settings', target: null });
  });
});
