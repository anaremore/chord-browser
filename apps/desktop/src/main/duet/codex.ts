/**
 * Codex through `codex app-server` (docs/decisions/S5-codex-restriction.md;
 * research §3, §7.2). The user's own `codex`, one app-server per active
 * thread. Browse threads run read-only in an empty Chord-owned folder, with
 * every model-callable feature Codex can switch off switched off, the user's
 * own MCP servers disabled by name, and Chord's tools as dynamic tools in the
 * `chord` namespace. Command and file-change approvals are declined without
 * asking; any item outside the allowed set trips the wire and stops the turn.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DuetContextUsage } from '@chord/core';
import { errorCopy, killTree, type DuetSession, type ProviderError, type SessionEvents, type SessionImage, type SessionOptions } from './adapter';
import { cliPath, spawnSpec } from './launch';

/** Default-on features that add tools (research §3.3). Unknown names are ignored by older versions. */
export const CODEX_FEATURES_OFF = [
  'shell_tool',
  'unified_exec',
  'view_image',
  'image_generation',
  'multi_agent',
  'apps',
  'plugins',
  'tool_suggest',
  'goals',
  'browser_use',
  'computer_use',
  'skill_search',
  'sleep_tool',
] as const;

/** What a browse thread may produce; anything else is the tripwire. */
const ALLOWED_ITEMS = new Set(['agentMessage', 'reasoning', 'userMessage', 'dynamicToolCall', 'contextCompaction']);

export function codexArgs(): string[] {
  return ['app-server', ...CODEX_FEATURES_OFF.flatMap((f) => ['--disable', f]), '-c', 'web_search="disabled"'];
}

/** `error` notifications → Duet's provider errors (S5 saw usageLimitExceeded and an unsupported default model). */
export function codexError(info: string, message: string): ProviderError {
  const kind =
    info === 'usageLimitExceeded'
      ? 'usage-limit'
      : info === 'unauthorized' || /log ?in|unauthori[sz]ed|sign(ed)? in/i.test(message)
        ? 'signed-out'
        : /model .* not supported|model_not_found/i.test(message)
          ? 'model'
          : /rate.?limit/i.test(message)
            ? 'rate-limit'
            : 'other';
  const retry = /try again at ([^.]+)/i.exec(message)?.[1];
  return { kind, message: errorCopy('codex', kind, kind === 'usage-limit' && retry ? `It resets ${retry}.` : kind === 'other' ? message.slice(0, 300) : '') };
}

/**
 * How full the context is, from `thread/tokenUsage/updated` (codex-cli
 * 0.160.1's generated schema: `tokenUsage: {total, last, modelContextWindow:
 * number | null}`): the last request's tokens against the window Codex
 * reports. A null window hides the meter; sizes are never guessed.
 */
export function codexContextUsage(params: Record<string, unknown>): DuetContextUsage | null {
  const info = params['tokenUsage'] as { last?: { totalTokens?: unknown }; modelContextWindow?: unknown } | undefined;
  const window = info?.modelContextWindow;
  const used = info?.last?.totalTokens;
  if (typeof window !== 'number' || !(window > 0) || typeof used !== 'number' || !(used > 0)) return null;
  return { used, window };
}

export class CodexSession implements DuetSession {
  readonly provider = 'codex' as const;
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, (result: { result?: Record<string, unknown>; error?: { message?: string } }) => void>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private turnRunning = false;
  private interrupting = false;
  private ready: Promise<boolean>;
  private ended = false;
  private turnError: ProviderError | null = null;

  constructor(
    private readonly options: SessionOptions,
    private readonly events: SessionEvents,
  ) {
    const spec = spawnSpec(options.launch, codexArgs(), { cwd: options.cwd });
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: spec.env, detached: process.platform !== 'win32' });
    this.child.on('error', () => this.exit({ kind: 'crashed', message: errorCopy('codex', 'crashed', "Chord couldn't start it.") }));
    this.child.on('exit', () => {
      if (this.turnRunning) this.endTurn('error', { kind: 'crashed', message: errorCopy('codex', 'crashed') });
      this.exit(null);
    });
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.onLine(line));
    this.ready = this.start();
  }

  get busy(): boolean {
    return this.turnRunning;
  }

  get alive(): boolean {
    return !this.ended;
  }

  send(text: string, images: readonly SessionImage[] = []): void {
    this.turnRunning = true;
    this.turnError = null;
    void this.ready.then((ok) => {
      if (!ok || !this.threadId) return this.endTurn('error', { kind: 'other', message: errorCopy('codex', 'other') });
      const pictures = images.map((image) => ({ type: 'image', url: `data:${image.mime};base64,${image.data}` }));
      void this.call('turn/start', { threadId: this.threadId, input: [...pictures, { type: 'text', text, text_elements: [] }] }).then((r) => {
        if (r.error) this.endTurn('error', codexError('', r.error.message ?? ''));
        else this.turnId = ((r.result?.['turn'] as { id?: string } | undefined)?.id ?? this.turnId) || null;
      });
    });
  }

  stop(): void {
    if (!this.turnRunning || !this.threadId || !this.turnId) return;
    this.interrupting = true;
    void this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  close(): void {
    if (this.ended) return;
    const pid = this.child.pid;
    if (!this.options.launch.wsl) return killTree(pid);
    // Inside WSL, the end of stdin is what reaches Codex; wsl.exe goes after a grace period.
    this.child.stdin?.end();
    setTimeout(() => {
      if (!this.ended) killTree(pid);
    }, 2000).unref();
  }

  /** Delete a thread's rollout through Codex itself (Duet's "delete really deletes"). */
  async deleteThread(threadId: string): Promise<boolean> {
    await this.ready;
    const r = await this.call('thread/delete', { threadId });
    return !r.error;
  }

  private async start(): Promise<boolean> {
    const init = await this.call('initialize', { clientInfo: { name: 'chord', title: 'Chord', version: '1' }, capabilities: { experimentalApi: true } });
    if (init.error) return false;
    this.write({ method: 'initialized' });
    if (this.options.resumeId === '__delete_only__') return true;
    // The user's own MCP servers would load into Duet's threads: switch each off by name (never config/read).
    const servers = await this.call('mcpServerStatus/list', {});
    const names = ((servers.result?.['data'] as { name?: string }[] | undefined) ?? []).map((s) => s.name).filter((n): n is string => Boolean(n));
    const config = Object.fromEntries([
      ...CODEX_FEATURES_OFF.map((f) => [`features.${f}`, false]),
      ['web_search', 'disabled'],
      ...names.map((n) => [`mcp_servers.${n}.enabled`, false]),
    ]);
    let model = this.options.model;
    if (!model) {
      // The user's configured default may not be on their plan (S5): take the account's own default.
      const models = await this.call('model/list', {});
      const list = ((models.result?.['data'] as { id: string; hidden?: boolean; isDefault?: boolean }[] | undefined) ?? []).filter((m) => !m.hidden);
      model = (list.find((m) => m.isDefault) ?? list[0])?.id ?? null;
    }
    if (this.options.resumeId) {
      const resumed = await this.call('thread/resume', { threadId: this.options.resumeId, config, developerInstructions: this.options.instructions });
      if (!resumed.error) {
        this.threadId = this.options.resumeId;
        this.events.onSessionId(this.threadId);
        return true;
      }
      this.exit({ kind: 'resume-failed', message: 'The earlier thread is gone.' });
      this.close();
      return false;
    }
    const started = await this.call('thread/start', {
      ...(model ? { model } : {}),
      // Inside WSL, the distro's path to the same empty folder.
      cwd: cliPath(this.options.launch, this.options.cwd),
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      developerInstructions: this.options.instructions,
      config,
      dynamicTools: [
        {
          type: 'namespace',
          name: 'chord',
          description: "The user's browser: their tabs, history and archive.",
          tools: this.options.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      ],
    });
    const id = (started.result?.['thread'] as { id?: string } | undefined)?.id;
    if (!id) return false;
    this.threadId = id;
    this.events.onSessionId(id);
    return true;
  }

  private call(method: string, params: unknown): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
    return new Promise((resolve) => {
      if (this.ended) return resolve({ error: { message: 'ended' } });
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.write({ id, method, params });
    });
  }

  private write(obj: unknown): void {
    if (!this.ended && this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private exit(error: ProviderError | null): void {
    if (this.ended) return;
    this.ended = true;
    for (const resolve of this.pending.values()) resolve({ error: { message: 'ended' } });
    this.pending.clear();
    this.events.onExit(error);
  }

  private endTurn(status: 'done' | 'interrupted' | 'error', error?: ProviderError): void {
    if (!this.turnRunning) return;
    this.turnRunning = false;
    this.interrupting = false;
    this.events.onTurnEnd({ status, ...(error ? { error } : {}) });
  }

  private tripwire(type: string): void {
    this.turnError = { kind: 'tripwire', message: errorCopy('codex', 'tripwire') };
    console.error(`[chord] Duet: Codex produced a ${type} item in a browse thread; stopping the turn.`);
    if (this.threadId && this.turnId) void this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  private onLine(line: string): void {
    let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const resolve = this.pending.get(m.id);
      this.pending.delete(m.id);
      resolve?.({ ...(m.result ? { result: m.result } : {}), ...(m.error ? { error: m.error } : {}) });
      return;
    }
    const p = m.params ?? {};
    if (m.id !== undefined && m.method) return void this.onRequest(m.id, m.method, p);
    switch (m.method) {
      case 'turn/started':
        this.turnId = (p['turn'] as { id?: string } | undefined)?.id ?? this.turnId;
        return;
      case 'item/agentMessage/delta':
        if (typeof p['delta'] === 'string') this.events.onText(p['delta']);
        return;
      case 'thread/tokenUsage/updated': {
        const usage = p['threadId'] === undefined || p['threadId'] === this.threadId ? codexContextUsage(p) : null;
        if (usage) this.events.onUsage?.(usage);
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const type = (p['item'] as { type?: string } | undefined)?.type ?? '';
        if (type && !ALLOWED_ITEMS.has(type)) this.tripwire(type);
        return;
      }
      case 'error': {
        const error = p['error'] as { message?: string; codexErrorInfo?: unknown } | undefined;
        if (p['willRetry']) return;
        this.turnError = codexError(typeof error?.codexErrorInfo === 'string' ? error.codexErrorInfo : '', error?.message ?? '');
        return;
      }
      case 'turn/completed': {
        const status = (p['turn'] as { status?: string } | undefined)?.status;
        if (this.turnError) return this.endTurn('error', this.turnError);
        if (status === 'interrupted' || this.interrupting) return this.endTurn('interrupted');
        if (status === 'failed') return this.endTurn('error', { kind: 'other', message: errorCopy('codex', 'other') });
        return this.endTurn('done');
      }
    }
  }

  private async onRequest(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'item/tool/call') {
      const out = await this.events.onTool(String(params['tool'] ?? ''), (params['arguments'] as Record<string, unknown>) ?? {});
      const contentItems = out.image ? [{ type: 'inputImage', imageUrl: `data:${out.image.mimeType};base64,${out.image.data}` }] : [{ type: 'inputText', text: out.text ?? '' }];
      return this.write({ id, result: { contentItems, success: !out.isError } });
    }
    // Browse threads never run commands or change files: decline without asking (research §3.3).
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return this.write({ id, result: { decision: 'decline' } });
    return this.write({ id, error: { code: -32601, message: 'Not supported by Chord' } });
  }
}
