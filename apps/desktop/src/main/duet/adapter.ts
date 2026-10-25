/**
 * The common shape of a provider session (ARCHITECTURE.md §11.2): one
 * long-lived CLI process per active thread. Chord's tools are served
 * in-process by the session (Claude: the stream-json control channel; Codex:
 * app-server dynamic tools), so there is no helper binary, no localhost
 * server and no token to leak; the process is the thread's scope.
 */
import { execFile } from 'node:child_process';
import type { DuetContextUsage, DuetProvider, DuetToolSpec } from '@chord/core';
import type { Launch } from './detect';

export interface ToolOutput {
  text?: string;
  /** Screenshots, for providers that take images through their CLI. */
  image?: { data: string; mimeType: string };
  isError?: boolean;
}

export type ProviderErrorKind = 'signed-out' | 'usage-limit' | 'rate-limit' | 'overloaded' | 'model' | 'resume-failed' | 'tripwire' | 'crashed' | 'other';

export interface ProviderError {
  kind: ProviderErrorKind;
  /** Plain cause plus fix, as DESIGN.md §7.8's Provider error state says it. */
  message: string;
}

export interface SessionEvents {
  /** The provider's session id: Claude's (Chord picks it) or Codex's thread id. Stored to resume. */
  onSessionId(id: string): void;
  onText(delta: string): void;
  /** A tool call. Resolves when Chord has an answer, which may wait on an approval card. */
  onTool(name: string, args: Record<string, unknown>): Promise<ToolOutput>;
  onTurnEnd(outcome: { status: 'done' | 'interrupted' | 'error'; error?: ProviderError }): void;
  /** How full the model's context is, when the CLI reports both the tokens and the window. */
  onUsage?(usage: DuetContextUsage): void;
  /** The process ended. `resume-failed` means the stored session is gone: start over with a summary. */
  onExit(error: ProviderError | null): void;
}

export interface SessionOptions {
  launch: Launch;
  /** An empty Chord-owned folder: no project instructions, hooks or MCP servers load from it. */
  cwd: string;
  model: string | null;
  /** Duet's instructions, already written to `instructionsFile` (0600) for Claude. */
  instructions: string;
  instructionsFile: string;
  /** A provider session to resume, or null to start one (Claude uses `newSessionId`). */
  resumeId: string | null;
  newSessionId: string;
  tools: readonly DuetToolSpec[];
}

/** An image with a message: its type and its bytes, base64-encoded. */
export interface SessionImage {
  mime: string;
  data: string;
}

export interface DuetSession {
  readonly provider: DuetProvider;
  /** A turn is running. */
  readonly busy: boolean;
  readonly alive: boolean;
  /** A message, with any images you gave it (sent before the text, as the model reads them best). */
  send(text: string, images?: readonly SessionImage[]): void;
  /** Stop the current turn; the session stays for the next message. */
  stop(): void;
  /** End the process (idle, quit, thread deleted). */
  close(): void;
}

/** DESIGN.md §7.8's error copy, per provider. */
export function errorCopy(provider: DuetProvider, kind: ProviderErrorKind, detail = ''): string {
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  const login = provider === 'claude' ? 'claude auth login' : 'codex login';
  switch (kind) {
    case 'signed-out':
      return `${name} isn't signed in. Run \`${login}\` in a terminal, then try again.`;
    case 'usage-limit':
      return `You've reached your ${name} usage limit.${detail ? ` ${detail}` : ''}`;
    case 'rate-limit':
      return `${name} is rate-limited right now. Try again in a minute.`;
    case 'overloaded':
      return `${name}'s service is busy. Try again in a moment.`;
    case 'model':
      return `That model isn't available on your ${name} account. Pick another in the model menu.`;
    case 'tripwire':
      return `${name} tried something Duet doesn't allow in browse mode, so Duet stopped the reply.`;
    case 'crashed':
      return `${name} stopped unexpectedly.${detail ? ` ${detail}` : ''} Your message is still here: try again.`;
    default:
      return detail || `${name} couldn't answer. Try again.`;
  }
}

/** Ends a provider and anything it started (Codex starts a code-mode host: research §3.4, §4.3). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
}
