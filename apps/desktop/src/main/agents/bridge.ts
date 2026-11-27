/**
 * `chord mcp` (docs/decisions/S18-agent-mcp.md §2): the stdio MCP server an agent
 * starts, a relay with no state of its own. It answers `initialize` and, until
 * Chord is connected, `tools/list` itself (the list ships with the build), so an
 * agent session that never uses Chord never reaches Chord. The first `tools/call`
 * connects to the running Chord and says hello: the token, the client's own
 * `initialize`, who started the bridge and the tool list it gave. From then on
 * calls, `tools/list` and cancellations go to Chord, and Chord's notifications
 * (`notifications/tools/list_changed`) come back. Chord is never started: while
 * it isn't open, calls say so, and the next one tries again.
 *
 * Plain Node, no Electron (mcp-main.ts runs it in Chord's executable).
 */
import type { Socket } from 'node:net';
import { AGENT_NOT_OPEN, agentInitializeResult, agentRefusal, agentToolList, agentToolsVersion } from '@chord/core/agent-tools';
import { ANSWER_MAX, connectEndpoint, lines, MESSAGE_MAX } from './endpoint';

export interface BridgeOptions {
  /** The profile folder whose Chord it talks to. */
  userData: string;
  input: NodeJS.ReadableStream;
  output: { write(text: string): unknown };
  /** Chord's version, for serverInfo. */
  version: string;
  /** The client went (stdin ended). */
  onEnd(): void;
  log?(...args: unknown[]): void;
  parentPid?: number;
  cwd?: string;
  /** This build has M2's tools (agentActions); absent, it does (development and tests). */
  actions?: boolean;
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> } & Record<string, unknown>;

export function runBridge(options: BridgeOptions): { close(): void } {
  const log = options.log ?? (() => undefined);
  const out = (message: unknown) => options.output.write(`${JSON.stringify(message)}\n`);
  const reply = (id: Message['id'], result: unknown) => out({ jsonrpc: '2.0', id, result });
  let initialize: Record<string, unknown> | null = null;
  let chord: Socket | null = null;
  let connecting: Promise<Socket | null> | null = null;
  /** Requests waiting on Chord, by id: if Chord goes, each says it isn't open. */
  const pending = new Set<Message['id']>();

  const connectToChord = (): Promise<Socket | null> => {
    if (chord) return Promise.resolve(chord);
    connecting ??= (async () => {
      const socket = await connectEndpoint(options.userData, {
        initialize,
        bridgePid: process.pid,
        parentPid: options.parentPid ?? process.ppid,
        cwd: options.cwd ?? process.cwd(),
        toolsVersion: agentToolsVersion(agentToolList(options.actions ?? true)),
      });
      if (!socket) return null;
      return new Promise<Socket | null>((resolve) => {
        let welcomed = false;
        const fromChord = (line: string) => {
          let m: Message;
          try {
            m = JSON.parse(line) as Message;
          } catch {
            return;
          }
          if (!welcomed) {
            welcomed = m['type'] === 'welcome';
            if (welcomed) {
              chord = socket;
              resolve(socket);
            }
            return;
          }
          if (m.id !== undefined && !m.method) {
            if (pending.delete(m.id)) out(m);
          } else if (m.method) out(m);
        };
        // An answer past ANSWER_MAX: Chord isn't speaking the protocol, so the relay lets it go.
        lines(socket, fromChord, () => ANSWER_MAX, () => socket.destroy());
        socket.on('close', () => {
          if (!welcomed) resolve(null);
          chord = null;
          for (const id of pending) reply(id, agentRefusal(AGENT_NOT_OPEN));
          pending.clear();
        });
      });
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const forward = async (m: Message, line: string, whenClosed: () => void) => {
    const socket = await connectToChord();
    if (!socket) return whenClosed();
    if (m.id !== undefined) pending.add(m.id);
    socket.write(`${line}\n`);
  };

  const fromClient = (line: string) => {
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    log('from client', m.method ?? 'response');
    switch (m.method) {
      case 'initialize':
        initialize = m.params ?? {};
        return reply(m.id, agentInitializeResult(initialize, options.version));
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        // Chord's own list once connected (it may differ, and says so with list_changed); this build's until then.
        if (chord) return void forward(m, line, () => reply(m.id, { tools: agentToolList(options.actions ?? true) }));
        return reply(m.id, { tools: agentToolList(options.actions ?? true) });
      case 'tools/call':
        return void forward(m, line, () => reply(m.id, agentRefusal(AGENT_NOT_OPEN)));
      case 'notifications/cancelled':
        chord?.write(`${line}\n`);
        return;
      default:
        if (m.id !== undefined && m.method) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
    }
  };
  // A client line past a few MB ends the relay, as the client going would.
  lines(options.input, fromClient, () => MESSAGE_MAX, () => {
    log('a line too long from the client');
    close();
    options.onEnd();
  });
  const close = () => {
    (chord as Socket | null)?.end();
    chord = null;
  };
  options.input.on('end', () => {
    log('stdin ended');
    close();
    options.onEnd();
  });
  return { close };
}
