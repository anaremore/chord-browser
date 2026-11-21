/**
 * Site permissions (permissions.ts) for an outside agent's tab (S18, security
 * review): only the harmless ones, with no prompt and none of the answers you
 * saved for the site; your own tab on the same site still gets them.
 */
import { emptyState, type State } from '@chord/core';
import type { Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { PermissionBroker } from '../../src/main/permissions';

type RequestHandler = (contents: WebContents, permission: string, callback: (granted: boolean) => void, details: Record<string, unknown>) => void;
type CheckHandler = (contents: WebContents | null, permission: string, origin: string, details: Record<string, unknown>) => boolean;

function setup() {
  const state: State = emptyState();
  // You allowed meet.test everything it asks for.
  state.sitePermissions = { 'https://meet.test': { camera: 'allow', microphone: 'allow', location: 'allow', notifications: 'allow', 'clipboard-read': 'allow' } };
  const broker = new PermissionBroker();
  const pages = { mine: { id: 'mine' }, agent: { id: 'agent' } };
  const onChange = vi.fn();
  broker.connect({ state: () => state, dispatch: vi.fn(), nodeFor: (c) => (c as unknown as { id: string }).id as never, onChange, agentTab: (nodeId) => nodeId === 'agent' });
  let request!: RequestHandler;
  let check!: CheckHandler;
  broker.attach({ setPermissionRequestHandler: (h: RequestHandler) => (request = h), setPermissionCheckHandler: (h: CheckHandler) => (check = h) } as unknown as Session);
  const ask = (page: keyof typeof pages, permission: string) => {
    let granted: boolean | 'unanswered' = 'unanswered';
    request(pages[page] as unknown as WebContents, permission, (g) => (granted = g), { requestingUrl: 'https://meet.test/room' });
    return granted;
  };
  const has = (page: keyof typeof pages, permission: string) => check(pages[page] as unknown as WebContents, permission, 'https://meet.test', {});
  return { broker, ask, has, onChange };
}

describe('an outside agent’s tab asks for a permission', () => {
  // [permission, what the agent's tab gets, what yours gets (by your saved answer)]
  const table: [string, boolean, boolean][] = [
    ['media', false, true],
    ['geolocation', false, true],
    ['notifications', false, true],
    ['clipboard-read', false, true],
    ['display-capture', false, true],
    ['midi', false, false],
    ['fullscreen', true, true],
    ['pointerLock', true, true],
  ];
  it.each(table)('%s: the agent’s tab %s, yours %s, and the agent’s never prompts', (permission, agent, mine) => {
    const t = setup();
    expect(t.ask('agent', permission)).toBe(agent);
    expect(t.has('agent', permission)).toBe(agent);
    expect(t.broker.promptFor('agent' as never)).toBeNull();
    expect(t.onChange).not.toHaveBeenCalled();
    expect(t.ask('mine', permission)).toBe(mine);
    expect(t.has('mine', permission)).toBe(mine);
  });
});
