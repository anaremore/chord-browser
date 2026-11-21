/**
 * IPC requests that can carry a password or a passphrase (`passwords:` and `auth:` channels, S17 §7, *Where the
 * key lives*): a bad one is refused without a word about what was in it, so no zod message, which can quote what it
 * read, reaches a log or a crash report.
 */
import { describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, run: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, run) } }));

const { handle, registerCaller } = await import('../../src/main/ipc');

/** The popover's page, registered as Chord's UI. */
const frame = { url: 'chord://popover/index.html' };
const popover = { id: 7, mainFrame: frame, once: () => undefined };
registerCaller(popover as never, 'popover', ['chord://popover']);
const call = (channel: string, payload: unknown) => handlers.get(channel)!({ sender: popover, senderFrame: frame }, payload);
/** Settings' page, registered as Chord's own (the `internal` role sync's channels take). */
const settingsFrame = { url: 'chord://settings/index.html' };
const settings = { id: 8, mainFrame: settingsFrame, once: () => undefined };
registerCaller(settings as never, 'internal', ['chord://settings']);
const callInternal = (channel: string, payload: unknown) => handlers.get(channel)!({ sender: settings, senderFrame: settingsFrame }, payload);

const PASSWORD = 'Zq9-never-in-an-error';

describe('a bad request on a channel that carries a password', () => {
  it.each([
    ['a password too long', { id: 1, credentials: { username: 'ada', password: `${PASSWORD}${'x'.repeat(1000)}` } }],
    ['an extra field beside it', { id: 1, credentials: { username: 'ada', password: PASSWORD, realm: PASSWORD } }],
    ['an index without its username', { id: 1, credentials: { account: 0, password: PASSWORD } }],
    ['a wrong type for remember', { id: 1, credentials: { username: 'ada', password: PASSWORD }, remember: PASSWORD }],
  ])('auth:respond with %s: refused, saying nothing of it', async (_name, payload) => {
    const respond = vi.fn();
    handle('auth:respond', respond as never);
    const error = await call('auth:respond', payload).then(
      () => null,
      (e: Error) => e,
    );
    expect(respond).not.toHaveBeenCalled();
    expect(error?.message).toBe('auth:respond: invalid request');
    expect(JSON.stringify({ message: error?.message, stack: error?.stack, cause: (error as { cause?: unknown }).cause })).not.toContain(PASSWORD);
  });

  it('a good one reaches the handler', async () => {
    const respond = vi.fn();
    handle('auth:respond', respond as never);
    await call('auth:respond', { id: 1, credentials: { account: 0, username: 'ada' }, remember: true });
    expect(respond).toHaveBeenCalledWith({ id: 1, credentials: { account: 0, username: 'ada' }, remember: true }, popover);
  });
});

describe('a bad request on a sync channel, which carries the sync passphrase (security review)', () => {
  it.each([
    ['sync:unlock', 'a passphrase too long', { passphrase: `${PASSWORD}${'x'.repeat(5000)}` }],
    ['sync:unlock', 'an extra field beside it', { passphrase: PASSWORD, hint: PASSWORD }],
    ['sync:setup', 'a folder id that isn’t text', { folderId: 7, passphrase: PASSWORD }],
    ['sync:join', 'a wrong type', { folderId: 1, passphrase: PASSWORD }],
    ['sync:startOver', 'a passphrase that isn’t text', { passphrase: [PASSWORD] }],
  ])('%s with %s: refused, saying nothing of it', async (channel, _name, payload) => {
    const run = vi.fn();
    handle(channel as never, run as never);
    const error = await callInternal(channel, payload).then(
      () => null,
      (e: Error) => e,
    );
    expect(run).not.toHaveBeenCalled();
    expect(error?.message).toBe(`${channel}: invalid request`);
    expect(JSON.stringify({ message: error?.message, stack: error?.stack, cause: (error as { cause?: unknown }).cause })).not.toContain(PASSWORD);
  });
});
