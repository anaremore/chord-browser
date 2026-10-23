/**
 * Claude Code, headless (docs/decisions/S10-claude-headless.md; research
 * §1, §7.1). The user's unmodified `claude` binary, one process per active
 * thread, stream-json in and out. Browse mode removes every built-in tool,
 * the user's settings, CLAUDE.md, memory and slash commands, and runs in an
 * empty Chord-owned folder. Chord's tools are an in-process MCP server on the
 * control channel (`sdkMcpServers`), which the S10 spike showed works with
 * 2.1.309, survives 75 s waits for approvals, and needs nothing on argv.
 * Chord ships no Anthropic code.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DuetContextUsage, DuetToolSpec } from '@chord/core';
import { errorCopy, killTree, type DuetSession, type ProviderError, type SessionEvents, type SessionOptions, type ToolOutput } from './adapter';
import { cliPath, spawnSpec } from './launch';

const SERVER = 'chord';

export function claudeArgs(options: Pick<SessionOptions, 'model' | 'instructionsFile' | 'resumeId' | 'newSessionId'>): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(options.resumeId ? ['--resume', options.resumeId] : ['--session-id', options.newSessionId]),
    ...(options.model ? ['--model', options.model] : []),
    // Browse mode (research §1.4): no built-in tools, no user settings, plugins, skills or other MCP servers.
    '--restricted',
    '--tools', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--allowedTools', `mcp__${SERVER}__*`,
    '--permission-prompts', 'none',
    '--append-system-prompt-file', options.instructionsFile,
    '--system-prompt-snapshot', 'off',
  ];
}

/** api_retry error categories and result text → Duet's provider errors (research §1.2). */
export function claudeError(category: string, text: string): ProviderError {
  const kind =
    category === 'authentication_failed' || /not (logged|signed) in|\/login|auth login/i.test(text)
      ? 'signed-out'
      : category === 'billing_error' || /usage limit|limit reached/i.test(text)
        ? 'usage-limit'
        : category === 'rate_limit'
          ? 'rate-limit'
          : category === 'overloaded' || category === 'server_error'
            ? 'overloaded'
            : category === 'model_not_found'
              ? 'model'
              : 'other';
  return { kind, message: errorCopy('claude', kind, kind === 'other' ? text.slice(0, 300) : '') };
}

interface TokenUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}

const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
/** What one request put in the context: everything it read (cached or not) plus what it wrote. */
const inContext = (u: TokenUsage | null | undefined) => (u ? count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens) + count(u.output_tokens) : 0);

/**
 * How full the context is after a turn, from a stream-json `result` (checked
 * against 2.1.309): the window is `modelUsage[<model>].contextWindow`, the
 * tokens are the turn's last request (`usage.iterations`, else the last
 * message's usage). No window reported, no meter: sizes are never guessed.
 */
export function claudeContextUsage(result: Record<string, unknown>, model: string | null, lastMessage: TokenUsage | null = null): DuetContextUsage | null {
  const models = result['modelUsage'];
  if (!models || typeof models !== 'object') return null;
  const windows = Object.entries(models as Record<string, { contextWindow?: unknown } | null>).filter(([, m]) => count(m?.contextWindow) > 0);
  // The chat's own model; another one there (a background helper) never sets the window.
  const entry = (model ? windows.find(([id]) => id === model) : undefined) ?? (windows.length === 1 ? windows[0] : undefined);
  if (!entry) return null;
  const usage = result['usage'] as (TokenUsage & { iterations?: unknown }) | undefined;
  const iterations = Array.isArray(usage?.iterations) ? (usage.iterations as TokenUsage[]) : [];
  const used = inContext(iterations.at(-1) ?? lastMessage ?? usage);
  return used > 0 ? { used, window: count(entry[1]!.contextWindow) } : null;
}

/** The MCP side of Chord's tools, answered on the control channel. */
async function mcpReply(message: { id?: unknown; method?: string; params?: Record<string, unknown> }, tools: readonly DuetToolSpec[], call: (name: string, args: Record<string, unknown>) => Promise<ToolOutput>) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: (params?.['protocolVersion'] as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chord', version: '1' } } };
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true }})) },
    };
  }
  if (method === 'tools/call') {
    const name = String(params?.['name'] ?? '');
    const args = (params?.['arguments'] as Record<string, unknown>) ?? {};
    const out = await call(name, args);
    const content = out.image ? [{ type: 'image', data: out.image.data, mimeType: out.image.mimeType }] : [{ type: 'text', text: out.text ?? '' }];
    return { jsonrpc: '2.0', id, result: { content, isError: Boolean(out.isError) } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } };
}

export class ClaudeSession implements DuetSession {
  readonly provider = 'claude' as const;
  private readonly child: ChildProcess;
  private turnRunning = false;
  private initialized = false;
  private capabilities: string[] = [];
  private requestId = 0;
  private lastErrorCategory = '';
  private stderr = '';
  private ended = false;
  private interrupting = false;
  /** The chat's model (system/init, then each reply's), and its last request's usage: the context meter. */
  private model: string | null = null;
  private lastUsage: TokenUsage | null = null;

  constructor(
    private readonly options: SessionOptions,
    private readonly events: SessionEvents,
  ) {
    // The same flags whether it runs here or inside WSL; there, the instructions file is the distro's path to it.
    const spec = spawnSpec(options.launch, claudeArgs({ ...options, instructionsFile: cliPath(options.launch, options.instructionsFile) }), {
      cwd: options.cwd,
      // The user's environment is left alone (an ANTHROPIC_API_KEY there is theirs: research §1.7).
      env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    });
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: spec.env });
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    this.child.on('error', () => this.exit({ kind: 'crashed', message: errorCopy('claude', 'crashed', "Chord couldn't start it.") }));
    this.child.on('exit', (code) => {
      // A resume that can't find its session fails before init, with the reason on stderr.
      if (!this.initialized && options.resumeId) return this.exit({ kind: 'resume-failed', message: 'The earlier session is gone.' });
      if (this.turnRunning) this.endTurn('error', { kind: 'crashed', message: errorCopy('claude', 'crashed', code ? `(exit ${code})` : '') });
      this.exit(code && !this.initialized ? claudeError('', this.stderr) : null);
    });
    createInterface({ input: this.child.stdout! }).on('line', (line) => void this.onLine(line));
    this.write({ type: 'control_request', request_id: `chord-${++this.requestId}`, request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [SERVER] } });
  }

  get busy(): boolean {
    return this.turnRunning;
  }

  get alive(): boolean {
    return !this.ended;
  }

  send(text: string): void {
    this.turnRunning = true;
    this.lastUsage = null;
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
  }

  stop(): void {
    if (!this.turnRunning) return;
    // A clean stop on every OS, Windows included (no SIGINT for children there): research §1.6.
    this.interrupting = true;
    if (this.capabilities.includes('interrupt_receipt_v1')) {
      this.write({ type: 'control_request', request_id: `chord-${++this.requestId}`, request: { subtype: 'interrupt' } });
    } else {
      // Older CLIs: end the process; the next message resumes the session.
      this.endTurn('interrupted');
      this.close();
    }
  }

  close(): void {
    if (this.ended) return;
    this.child.stdin?.end();
    const pid = this.child.pid;
    setTimeout(() => {
      if (!this.ended) killTree(pid);
    }, 2000).unref();
  }

  private write(obj: unknown): void {
    if (!this.ended && this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private exit(error: ProviderError | null): void {
    if (this.ended) return;
    this.ended = true;
    this.events.onExit(error);
  }

  private endTurn(status: 'done' | 'interrupted' | 'error', error?: ProviderError): void {
    if (!this.turnRunning) return;
    this.turnRunning = false;
    this.interrupting = false;
    this.events.onTurnEnd({ status, ...(error ? { error } : {}) });
  }

  private async onLine(line: string): Promise<void> {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m['type']) {
      case 'control_request': {
        const request = m['request'] as { subtype?: string; server_name?: string; message?: Record<string, unknown> };
        const respond = (response: unknown) => this.write({ type: 'control_response', response: { subtype: 'success', request_id: m['request_id'], response } });
        if (request.subtype === 'mcp_message' && request.server_name === SERVER && request.message) {
          if (request.message['id'] === undefined) return respond({ mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } });
          return respond({ mcp_response: await mcpReply(request.message, this.options.tools, (name, args) => this.events.onTool(name, args)) });
        }
        // Nothing else is Chord's to answer in browse mode (permission prompts are off).
        return this.write({ type: 'control_response', response: { subtype: 'error', request_id: m['request_id'], error: 'Not supported by Chord' } });
      }
      case 'system':
        if (m['subtype'] === 'init') {
          this.initialized = true;
          this.capabilities = Array.isArray(m['capabilities']) ? (m['capabilities'] as string[]) : [];
          if (typeof m['model'] === 'string') this.model = m['model'];
          if (typeof m['session_id'] === 'string') this.events.onSessionId(m['session_id']);
        } else if (m['subtype'] === 'api_retry') {
          const error = m['error'] as { category?: string } | string | undefined;
          this.lastErrorCategory = typeof error === 'string' ? error : (error?.category ?? '');
        }
        return;
      case 'stream_event': {
        const event = m['event'] as { type?: string; delta?: { type?: string; text?: string }; usage?: TokenUsage } | undefined;
        if (m['parent_tool_use_id'] == null && event?.type === 'message_delta' && event.usage) this.lastUsage = event.usage;
        const delta = event?.delta;
        if (delta?.type === 'text_delta' && delta.text) this.events.onText(delta.text);
        return;
      }
      case 'assistant': {
        const message = m['message'] as { model?: unknown } | undefined;
        if (m['parent_tool_use_id'] == null && typeof message?.model === 'string') this.model = message.model;
        return;
      }
      case 'result': {
        const usage = claudeContextUsage(m, this.model, this.lastUsage);
        if (usage) this.events.onUsage?.(usage);
        const subtype = String(m['subtype'] ?? '');
        if (subtype === 'success' && !m['is_error']) return this.endTurn('done');
        // An interrupt Chord asked for ends the turn as an error during execution.
        if (this.interrupting) return this.endTurn('interrupted');
        const error = claudeError(this.lastErrorCategory, String(m['result'] ?? subtype));
        this.lastErrorCategory = '';
        return this.endTurn('error', error);
      }
    }
  }
}
