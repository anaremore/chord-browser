/**
 * The main-process side of the IPC contract (ARCHITECTURE.md §8): every
 * request is checked against the caller's registered role and origin, size-
 * limited, and parsed with the channel's schema before any handler runs.
 */
import {
  MAX_PAYLOAD_BYTES,
  invokeChannels,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type Role,
} from '@chord/ipc';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { originOf } from './urls';

interface Caller {
  role: Role;
  origins: readonly string[];
}

const callers = new Map<number, Caller>();

/** Grant a Chord UI view its role. Web content is never registered. */
export function registerCaller(contents: WebContents, role: Role, origins: readonly string[]): void {
  callers.set(contents.id, { role, origins });
  contents.once('destroyed', () => callers.delete(contents.id));
}

export class IpcDenied extends Error {}

function authorize(channel: InvokeChannel, event: IpcMainInvokeEvent): void {
  const caller = callers.get(event.sender.id);
  const frame = event.senderFrame;
  const roles: readonly Role[] = invokeChannels[channel].roles;
  if (!caller || !roles.includes(caller.role)) throw new IpcDenied(`${channel}: caller not allowed`);
  if (!frame || frame !== event.sender.mainFrame) throw new IpcDenied(`${channel}: subframes may not call IPC`);
  const origin = originOf(frame.url);
  if (!origin || !caller.origins.includes(origin)) throw new IpcDenied(`${channel}: unexpected origin ${origin}`);
}

export function handle<C extends InvokeChannel>(
  channel: C,
  handler: (request: InvokeRequest<C>, sender: WebContents) => InvokeResponse<C> | Promise<InvokeResponse<C>>,
): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    authorize(channel, event);
    if (payload !== undefined && JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
      throw new IpcDenied(`${channel}: payload too large`);
    }
    const request = invokeChannels[channel].request.parse(payload) as InvokeRequest<C>;
    return handler(request, event.sender);
  });
}

export function send<C extends EventChannel>(contents: WebContents, channel: C, payload: EventPayload<C>): void {
  if (!contents.isDestroyed()) contents.send(channel, payload);
}
