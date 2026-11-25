/**
 * Permissions while the assistant's click is setting things off in a tab of yours (S18 M2e-2b, A6; Neon's S4 on #150):
 * the clipboard refused (both the request and the check), and another program (`openExternal`: mailto:, an app's
 * link) never opened, each said in the chat. The same tab, with no lease, is as it always was.
 */
import { emptyState, type State } from '@chord/core';
import type { Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const lease = vi.hoisted(() => ({ on: false, notes: [] as string[] }));
vi.mock('../../src/main/control/user-watch', () => ({
  userTabCatching: () => lease.on,
  noteUserTab: (_c: unknown, what: string, detail: string) => void lease.notes.push(`${what}: ${detail}`),
}));
const { PermissionBroker } = await import('../../src/main/permissions');

type RequestHandler = (contents: WebContents, permission: string, callback: (granted: boolean) => void, details: Record<string, unknown>) => void;
type CheckHandler = (contents: WebContents | null, permission: string, origin: string, details: Record<string, unknown>) => boolean;

function setup() {
  const state: State = emptyState();
  // You allowed the site the clipboard.
  state.sitePermissions = { 'https://shop.example': { 'clipboard-read': 'allow' } };
  const broker = new PermissionBroker();
  let request!: RequestHandler;
  let check!: CheckHandler;
  broker.attach({ setPermissionRequestHandler: (h: RequestHandler) => (request = h), setPermissionCheckHandler: (h: CheckHandler) => (check = h) } as unknown as Session);
  broker.connect({ state: () => state, dispatch: vi.fn(), nodeFor: () => 'n1', isAgent: () => false, onChange: vi.fn() } as never);
  const page = {} as WebContents;
  const ask = (permission: string, details: Record<string, unknown> = {}) => {
    let granted: boolean | null = null;
    request(page, permission, (g) => (granted = g), { requestingUrl: 'https://shop.example/', ...details });
    return granted;
  };
  const has = (permission: string) => check(page, permission, 'https://shop.example', {});
  return { ask, has };
}

describe('Permissions while the assistant’s click sets things off (S18 M2e-2b)', () => {
  it('the clipboard and another program: refused and said during the lease; as ever without one', () => {
    lease.on = true;
    lease.notes.length = 0;
    const t = setup();
    expect(t.ask('clipboard-sanitized-write')).toBe(false);
    expect(t.ask('clipboard-read')).toBe(false);
    expect(t.has('clipboard-read')).toBe(false);
    expect(t.ask('openExternal', { externalURL: 'mailto:ada@example.com' })).toBe(false);
    expect(lease.notes).toEqual(['clipboard: clipboard-sanitized-write', 'clipboard: clipboard-read', 'external: mailto:ada@example.com']);
    lease.on = false;
    const u = setup();
    expect(u.ask('clipboard-sanitized-write')).toBe(true);
    expect(u.has('clipboard-read')).toBe(true);
  });
});
