/**
 * Duet in main (ARCHITECTURE.md §11): threads per chord, provider sessions,
 * Chord's tools with their tiers, scope and approvals, and what each window's
 * panel shows. Chord's transcript (chord-data, migration 9) is the source of
 * truth; a provider's session is a cache that's resumed when it still works
 * and replaced, primed with a summary, when it doesn't.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  children,
  DUET_MAX_PROCESSES,
  DUET_PDF_MAX_PAGES,
  DUET_PROCESS_IDLE_MS,
  DUET_PROVIDERS,
  DUET_TOOLS,
  duetInstructions,
  duetPruneBefore,
  duetTool,
  isNeverReadable,
  pageResult,
  pdfPageOf,
  pdfPageUrl,
  pdfText,
  readNeedsApproval,
  splitCitations,
  stripCitations,
  textFragmentUrl,
  threadTitle,
  threadToShow,
  toolResult,
  transcriptSummary,
  userTurnText,
  uuidv7,
  type DuetAttachment,
  type DuetCitation,
  type DuetContextUsage,
  type DuetMessage,
  type DuetMessageBody,
  type DuetProvider,
  type DuetScope,
  type DuetThread,
  type DuetToolName,
  type NodeId,
  type TabNode,
  type WindowId,
} from '@chord/core';
import type { DuetAction, DuetView } from '@chord/ipc';
import { app, type WebContents } from 'electron';
import type { Browser } from '../browser';
import { send } from '../ipc';
import type { Persistence } from '../persistence';
import type { DuetSession, ProviderError, ToolOutput } from './adapter';
import { ClaudeSession } from './claude';
import { CodexSession } from './codex';
import { claudeConfigDir, claudeProjectFolder, detect, detectInWsl, mayBeInWsl, notInstalled, openSignIn, rememberedInWsl, type Detected, type Launch, type ProviderStatus } from './detect';
import { readPage, screenshot, type PageRead } from './extract';
import { asWslTarget, defaultWslDistro, removeInWsl, wslClaudeSessionPaths, type WslTarget } from './launch';
import { extractPdf, fetchPdf, PdfError, pdfProblemCopy } from './pdf';

type Decision = 'once' | 'thread' | 'denied';

interface ThreadState {
  chordId: string;
  /** Null until the first message is sent: a fresh thread isn't saved before then. */
  thread: DuetThread | null;
  messages: DuetMessage[];
  /** Opaque tab handles ("t3") ↔ node ids, so the model never sees titles or URLs it didn't ask for. */
  refs: Map<string, NodeId>;
  /** Tabs attached to any message in the thread: readable without asking. */
  attached: Set<NodeId>;
  /** "Allow for this chat": tool names the user said yes to for the rest of the thread. */
  grants: Set<string>;
  /** Tabs Duet read in this thread: a badge in the sidebar while it's open. */
  read: Set<NodeId>;
  queue: string[];
  streaming: DuetMessage | null;
  startedAt: number | null;
  windowId: WindowId | null;
  pending: Map<string, (decision: Decision) => void>;
  /** Shown between messages after a resume fell back to a summary, or the provider changed. */
  pendingDivider: string | null;
  lastError: ProviderError | null;
  /** How full the provider's context is, as its CLI last reported (the panel's meter). */
  context: DuetContextUsage | null;
  /** PDFs read in this chat, per tab: later ranges reuse them, and citations find their page in them. */
  pdfs: Map<NodeId, PdfRead>;
}

interface PdfRead {
  url: string;
  pages: string[];
  totalPages: number;
  text: string;
}

/** WSL installs as panel.json keeps them, so a WSL-only setup is ready at launch without starting WSL. */
type SavedWsl = Partial<Record<DuetProvider, { status: ProviderStatus; target: WslTarget }>>;

interface Panel {
  open: boolean;
  /** The current tab chip was removed for this tab. */
  removedCurrent: NodeId | null;
  extra: NodeId[];
}

interface Live {
  session: DuetSession;
  lastUsed: number;
  idle: ReturnType<typeof setTimeout> | undefined;
}

const THREADS_IN_MENU = 12;
/** PDFs kept per chat for later ranges and citations; the oldest goes first. */
const PDFS_KEPT = 3;
/** Development and tests: a shorter idle window, so "start fresh, offer Continue" can be seen. */
const IDLE_MS = (!app.isPackaged && Number(process.env['CHORD_DUET_IDLE_MS'])) || undefined;
const PUSH_MS = 33;

export class DuetService {
  private statuses: Partial<Record<DuetProvider, ProviderStatus>> = {};
  /** How to start each provider: never sent to a page (a launch holds the environment). */
  private launches: Partial<Record<DuetProvider, Launch>> = {};
  /** Installs found inside WSL at the last look, used while Windows itself has none. */
  private inWsl: Partial<Record<DuetProvider, Detected>> = {};
  private wslLookup: Promise<void> | null = null;
  private lookingInWsl = false;
  private readonly threads = new Map<string, ThreadState>();
  /** Which thread each chord's panel shows: a thread id, or a chord-keyed fresh one. */
  private readonly showing = new Map<string, string>();
  private readonly continueFrom = new Map<string, { id: string; title: string } | null>();
  private readonly panels = new Map<WindowId, Panel>();
  private readonly live = new Map<string, Live>();
  private drafts: Record<string, string> = {};
  private recent = new Map<string, { id: string; title: string; lastUsedAt: number }[]>();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private firstUseSeen = false;
  private readonly root: string;

  constructor(
    private readonly browser: Browser,
    private readonly persistence: Persistence,
    userData: string,
  ) {
    this.root = join(userData, 'duet');
    browser.store.subscribe((change) => {
      if (change.patches.some((p) => p.path[0] === 'windows' || p.path[0] === 'settings' || p.path[0] === 'nodes' || p.path[0] === 'chords')) this.schedulePush();
    });
    void this.init();
  }

  private get settings() {
    return this.browser.store.state.settings.duet;
  }

  private async init(): Promise<void> {
    await mkdir(join(this.root, 'empty'), { recursive: true });
    await mkdir(join(this.root, 'instructions'), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'panel.json'), 'utf8')) as { drafts?: Record<string, string>; firstUseSeen?: boolean; wsl?: SavedWsl };
      this.drafts = saved.drafts ?? {};
      this.firstUseSeen = Boolean(saved.firstUseSeen);
      for (const provider of DUET_PROVIDERS) {
        const entry = saved.wsl?.[provider];
        const target = asWslTarget(entry?.target);
        if (entry?.status && target) this.inWsl[provider] = rememberedInWsl({ ...notInstalled(provider), ...entry.status, provider }, target);
      }
    } catch {
      // First run.
    }
    // Keep Duet chats: threads past their date go, the provider's copy with them.
    const before = duetPruneBefore(this.settings.keep, Date.now());
    if (before !== null) {
      const removed = (await this.persistence.duet({ op: 'prune', before }).catch(() => ({ removed: [] }))).removed ?? [];
      for (const thread of removed) void this.deleteProviderCopy(thread);
    }
    // Launching never starts WSL: a WSL install found earlier stands until Setup or the panel looks again.
    void this.refreshProviders('never');
  }

  /* ---------- Views ---------- */

  private panel(windowId: WindowId): Panel {
    let p = this.panels.get(windowId);
    if (!p) {
      p = { open: false, removedCurrent: null, extra: [] };
      this.panels.set(windowId, p);
    }
    return p;
  }

  forgetWindow(windowId: WindowId): void {
    this.panels.delete(windowId);
  }

  private chordOf(windowId: WindowId): string | null {
    return this.browser.store.state.windows[windowId]?.activeChordId ?? null;
  }

  private isPrivateChord(chordId: string): boolean {
    return Boolean(this.browser.store.state.chords[chordId]?.private);
  }

  /** The thread a chord's panel shows, loading it (or the choice of a fresh one) the first time. */
  private async stateFor(chordId: string): Promise<ThreadState> {
    const key = this.showing.get(chordId);
    if (key && this.threads.has(key)) return this.threads.get(key)!;
    const result = await this.persistence.duet({ op: 'threads', chordId, limit: THREADS_IN_MENU }).catch(() => ({ threads: [] as DuetThread[] }));
    const threads = result.threads ?? [];
    this.recent.set(chordId, threads.map((t) => ({ id: t.id, title: t.title, lastUsedAt: t.lastUsedAt })));
    const { current, continueFrom } = threadToShow(threads, Date.now(), IDLE_MS);
    this.continueFrom.set(chordId, continueFrom ? { id: continueFrom.id, title: continueFrom.title } : null);
    return current ? this.load(current.id, chordId) : this.fresh(chordId);
  }

  private fresh(chordId: string): ThreadState {
    const key = `fresh:${chordId}`;
    const state = this.blank(chordId, null);
    this.threads.set(key, state);
    this.showing.set(chordId, key);
    return state;
  }

  private blank(chordId: string, thread: DuetThread | null): ThreadState {
    return {
      chordId,
      thread,
      messages: [],
      refs: new Map(),
      attached: new Set(),
      grants: new Set(),
      read: new Set(),
      queue: [],
      streaming: null,
      startedAt: null,
      windowId: null,
      pending: new Map(),
      pendingDivider: null,
      lastError: null,
      context: null,
      pdfs: new Map(),
    };
  }

  private async load(threadId: string, chordId: string): Promise<ThreadState> {
    const existing = this.threads.get(threadId);
    if (existing) {
      this.showing.set(chordId, threadId);
      return existing;
    }
    const result = await this.persistence.duet({ op: 'thread', threadId });
    const state = this.blank(chordId, result.thread ?? null);
    state.messages = result.messages ?? [];
    // Handles and attachments carry over, so earlier tabs stay readable and citations resolve.
    for (const m of state.messages) {
      if (m.body.role === 'user') {
        for (const a of m.body.attachments) {
          const node = this.nodeByUrl(chordId, a.url);
          if (node) {
            state.refs.set(a.ref, node);
            state.attached.add(node);
          }
        }
      }
      // A reply cut off by quitting stays as it was, marked interrupted (with Retry).
      if (m.body.role === 'assistant' && m.body.status === 'streaming') m.body = { ...m.body, status: 'interrupted' };
    }
    this.threads.set(threadId, state);
    this.showing.set(chordId, threadId);
    return state;
  }

  private nodeByUrl(chordId: string, url: string): NodeId | null {
    for (const node of Object.values(this.browser.store.state.nodes)) if (node.kind === 'tab' && node.chordId === chordId && node.url === url) return node.id;
    return null;
  }

  private activeTab(windowId: WindowId): TabNode | null {
    const model = this.browser.store.state.windows[windowId];
    const id = model ? model.activeTab[model.activeChordId] : null;
    const node = id ? this.browser.store.state.nodes[id] : undefined;
    return node?.kind === 'tab' ? node : null;
  }

  private readable(node: TabNode): boolean {
    return !this.isPrivateChord(node.chordId) && !this.settings.offChords.includes(node.chordId) && !isNeverReadable(node.url, this.settings.neverSites);
  }

  /** The chips above the composer: the current tab (unless removed), then anything added. */
  private attachments(windowId: WindowId): TabNode[] {
    const panel = this.panel(windowId);
    const out: TabNode[] = [];
    const current = this.activeTab(windowId);
    if (current && panel.removedCurrent !== current.id && this.readable(current)) out.push(current);
    for (const id of panel.extra) {
      const node = this.browser.store.state.nodes[id];
      if (node?.kind === 'tab' && !out.includes(node) && this.readable(node)) out.push(node);
    }
    return out;
  }

  async view(windowId: WindowId): Promise<DuetView> {
    const chordId = this.chordOf(windowId);
    const settings = this.settings;
    const privateWindow = chordId ? this.isPrivateChord(chordId) : false;
    const base = {
      enabled: settings.enabled && !privateWindow,
      open: this.panel(windowId).open,
      provider: settings.provider,
      providers: DUET_PROVIDERS.map((p) => this.statuses[p] ?? notInstalled(p)),
      chordOff: chordId ? settings.offChords.includes(chordId) : false,
      firstUse: !this.firstUseSeen,
      lookingInWsl: this.lookingInWsl,
    };
    if (!chordId || privateWindow) return { ...base, thread: null, continueFrom: null, threads: [], messages: [], busy: false, startedAt: null, queue: [], attachments: [], attachable: [], readTabIds: [], error: null, draft: '', context: null };
    const state = await this.stateFor(chordId);
    const nodes = this.browser.store.state.nodes;
    const attachable = children(this.browser.store.state, chordId, 'pinned', null)
      .concat(children(this.browser.store.state, chordId, 'today', null))
      .filter((n): n is TabNode => n.kind === 'tab' && this.readable(n))
      .map((n) => ({ nodeId: n.id, title: n.title || n.url, url: n.url }));
    const current = this.activeTab(windowId);
    return {
      ...base,
      thread: state.thread
        ? { id: state.thread.id, title: state.thread.title, scope: state.thread.scope, provider: state.thread.provider, model: state.thread.model }
        : { id: null, title: '', scope: settings.scope, provider: settings.provider ?? 'claude', model: settings.model },
      continueFrom: state.thread ? null : (this.continueFrom.get(chordId) ?? null),
      threads: this.recent.get(chordId) ?? [],
      messages: state.streaming ? [...state.messages.filter((m) => m.id !== state.streaming!.id), state.streaming] : state.messages,
      busy: Boolean(state.streaming),
      startedAt: state.startedAt,
      queue: state.queue,
      attachments: this.attachments(windowId).map((n) => ({ nodeId: n.id, title: n.title || n.url, url: n.url, current: n.id === current?.id })),
      attachable,
      readTabIds: [...state.read].filter((id) => nodes[id]),
      error: state.lastError,
      draft: this.drafts[state.thread?.id ?? `fresh:${chordId}`] ?? '',
      context: state.context,
    };
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.pushAll();
    }, PUSH_MS);
  }

  private async pushAll(): Promise<void> {
    for (const w of this.browser.allWindows) {
      if (w.window.isDestroyed()) continue;
      const view = await this.view(w.id);
      // The window may have closed while its view was built.
      if (w.window.isDestroyed()) continue;
      w.setDuetWidth(view.enabled && view.open ? this.browser.duetWidth : 0);
      send(w.shell.webContents, 'duet:state', view);
    }
  }

  /* ---------- Actions from the panel ---------- */

  async act(windowId: WindowId, action: DuetAction): Promise<void> {
    const chordId = this.chordOf(windowId);
    switch (action.do) {
      case 'toggle': {
        const panel = this.panel(windowId);
        panel.open = action.open ?? !panel.open;
        if (panel.open) void this.refreshProviders('if-needed');
        break;
      }
      case 'dismissFirstUse':
        this.firstUseSeen = true;
        void this.savePanel();
        break;
      case 'setup':
        this.browser.store.dispatch({ t: 'settings.set', settings: { duet: { provider: action.provider } } });
        break;
      case 'chordOff':
        if (chordId) {
          const off = new Set(this.settings.offChords);
          if (action.off) off.add(chordId);
          else off.delete(chordId);
          this.browser.store.dispatch({ t: 'settings.set', settings: { duet: { offChords: [...off] } } });
        }
        break;
      case 'signIn':
        await this.signIn(action.provider);
        break;
      case 'refresh':
        await this.refreshProviders('always');
        break;
      default:
        if (!chordId || this.isPrivateChord(chordId)) return;
        await this.threadAction(windowId, chordId, action);
    }
    this.schedulePush();
  }

  private async threadAction(windowId: WindowId, chordId: string, action: DuetAction): Promise<void> {
    const state = await this.stateFor(chordId);
    const panel = this.panel(windowId);
    switch (action.do) {
      case 'send':
        return this.send(windowId, state, action.text);
      case 'stop':
        state.queue = [];
        if (state.thread) this.live.get(state.thread.id)?.session.stop();
        return;
      case 'retry': {
        const lastUser = [...state.messages].reverse().find((m) => m.body.role === 'user');
        if (lastUser?.body.role === 'user') return this.send(windowId, state, lastUser.body.text, lastUser.body.attachments);
        return;
      }
      case 'unqueue':
        state.queue.splice(action.index, 1);
        return;
      case 'approve': {
        const resolve = state.pending.get(action.messageId);
        state.pending.delete(action.messageId);
        resolve?.(action.decision);
        return;
      }
      case 'new':
        this.close(state);
        this.continueFrom.set(chordId, state.thread ? { id: state.thread.id, title: state.thread.title } : (this.continueFrom.get(chordId) ?? null));
        this.fresh(chordId);
        return;
      case 'open':
        await this.load(action.threadId, chordId);
        return;
      case 'continue': {
        const from = this.continueFrom.get(chordId);
        if (from) await this.load(from.id, chordId);
        return;
      }
      case 'delete':
        return this.deleteThread(chordId, action.threadId);
      case 'rename':
        if (state.thread && state.thread.id === action.threadId) {
          state.thread.title = action.title.trim().slice(0, 80) || state.thread.title;
          await this.saveThread(state.thread);
          await this.refreshRecent(chordId);
        }
        return;
      case 'scope':
        if (state.thread) {
          state.thread.scope = action.scope;
          await this.saveThread(state.thread);
        } else {
          this.browser.store.dispatch({ t: 'settings.set', settings: { duet: { scope: action.scope } } });
        }
        return;
      case 'model':
        return this.setModel(state, action.provider, action.model);
      case 'attach':
        if (!panel.extra.includes(action.nodeId)) panel.extra.push(action.nodeId);
        if (panel.removedCurrent === action.nodeId) panel.removedCurrent = null;
        return;
      case 'detach': {
        panel.extra = panel.extra.filter((id) => id !== action.nodeId);
        if (this.activeTab(windowId)?.id === action.nodeId) panel.removedCurrent = action.nodeId;
        return;
      }
      case 'draft':
        this.drafts[state.thread?.id ?? `fresh:${chordId}`] = action.text.slice(0, 20_000);
        void this.savePanel();
        return;
      case 'citation':
        return this.openCitation(windowId, state, action.messageId, action.n);
      case 'export':
        return this.exportThread(state);
    }
  }

  private async setModel(state: ThreadState, provider: DuetProvider, model: string | null): Promise<void> {
    if (!state.thread) {
      this.browser.store.dispatch({ t: 'settings.set', settings: { duet: { provider, model } } });
      return;
    }
    const switched = state.thread.provider !== provider;
    state.thread.provider = provider;
    state.thread.model = model;
    state.context = null;
    if (switched) {
      // A different provider can't resume the other's session: it starts primed with a summary.
      this.close(state);
      state.thread.providerSessionId = null;
      state.pendingDivider = `Switched to ${provider === 'claude' ? 'Claude Code' : 'Codex'}`;
    } else {
      this.close(state);
    }
    await this.saveThread(state.thread);
  }

  /* ---------- Sending and sessions ---------- */

  private async send(windowId: WindowId, state: ThreadState, text: string, reuse?: DuetAttachment[]): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.settings.offChords.includes(state.chordId)) return;
    if (state.streaming) {
      // Follow-ups wait their turn instead of being refused (they show as queued).
      state.queue.push(trimmed);
      return;
    }
    const provider = state.thread?.provider ?? this.settings.provider;
    if (!provider) return;
    const now = Date.now();
    if (!state.thread) {
      const thread: DuetThread = {
        id: uuidv7(),
        chordId: state.chordId,
        title: threadTitle(trimmed),
        provider,
        model: this.settings.model,
        providerSessionId: null,
        scope: this.settings.scope,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      };
      state.thread = thread;
      this.threads.delete(`fresh:${state.chordId}`);
      this.threads.set(thread.id, state);
      this.showing.set(state.chordId, thread.id);
      const draftKey = `fresh:${state.chordId}`;
      delete this.drafts[draftKey];
      this.continueFrom.set(state.chordId, null);
      await this.saveThread(thread);
    }
    const thread = state.thread;
    state.windowId = windowId;
    state.lastError = null;

    const attachments: DuetAttachment[] = reuse ?? this.attachments(windowId).map((node) => ({ ref: this.refFor(state, node.id), url: node.url, title: node.title || node.url }));
    for (const a of attachments) {
      const node = state.refs.get(a.ref);
      if (node) state.attached.add(node);
    }

    if (state.pendingDivider) {
      await this.addMessage(state, { role: 'divider', text: state.pendingDivider });
      state.pendingDivider = null;
    }
    await this.addMessage(state, { role: 'user', text: trimmed, attachments });
    delete this.drafts[thread.id];
    thread.lastUsedAt = now;
    thread.updatedAt = now;
    await this.saveThread(thread);
    void this.refreshRecent(state.chordId);

    state.streaming = { id: uuidv7(), threadId: thread.id, createdAt: Date.now(), body: { role: 'assistant', text: '', citations: [], status: 'streaming' } };
    state.startedAt = Date.now();
    this.schedulePush();
    const session = await this.sessionFor(state);
    if (!session) {
      await this.finishTurn(state, { status: 'error', error: state.lastError ?? { kind: 'other', message: "Duet couldn't start. Check Settings → Duet." } });
      return;
    }
    session.send(userTurnText(trimmed, attachments));
  }

  private refFor(state: ThreadState, nodeId: NodeId): string {
    for (const [ref, id] of state.refs) if (id === nodeId) return ref;
    const ref = `t${state.refs.size + 1}`;
    state.refs.set(ref, nodeId);
    return ref;
  }

  private async sessionFor(state: ThreadState, summary?: string): Promise<DuetSession | null> {
    const thread = state.thread!;
    const existing = this.live.get(thread.id);
    if (existing?.session.alive) {
      this.touch(thread.id, existing);
      return existing.session;
    }
    if (!this.statuses[thread.provider]) await this.refreshProviders('never');
    // Still looking inside WSL (Setup just opened): that answer decides.
    if (!this.statuses[thread.provider]?.installed && this.wslLookup) await this.wslLookup;
    const status = this.statuses[thread.provider];
    const launch = this.launches[thread.provider];
    if (!status?.installed || !launch) {
      state.lastError = { kind: 'other', message: `${thread.provider === 'claude' ? 'Claude Code' : 'Codex'} isn't installed. Settings → Duet shows how to set it up.` };
      return null;
    }
    // At most a few CLI processes: the least recently used idle one makes room.
    if (this.live.size >= DUET_MAX_PROCESSES) {
      const idle = [...this.live.entries()].filter(([, l]) => !l.session.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (idle) this.drop(idle[0]);
    }
    const instructions = duetInstructions(summary);
    const instructionsFile = join(this.root, 'instructions', `${thread.id}.md`);
    await writeFile(instructionsFile, instructions, { encoding: 'utf8', mode: 0o600 });
    const resumeId = summary ? null : thread.providerSessionId;
    const options = {
      launch,
      cwd: join(this.root, 'empty'),
      model: thread.model,
      instructions,
      instructionsFile,
      resumeId,
      newSessionId: randomUUID(),
      tools: DUET_TOOLS,
    };
    let resumeFailed = false;
    const events = {
      onSessionId: (id: string) => {
        if (thread.providerSessionId !== id) {
          thread.providerSessionId = id;
          void this.saveThread(thread);
        }
      },
      onText: (delta: string) => {
        if (!state.streaming || state.streaming.body.role !== 'assistant') return;
        state.streaming.body = { ...state.streaming.body, text: state.streaming.body.text + delta };
        this.schedulePush();
      },
      onTool: (name: string, args: Record<string, unknown>) => this.runTool(state, name, args),
      onUsage: (usage: DuetContextUsage) => {
        state.context = usage;
        this.schedulePush();
      },
      onTurnEnd: (outcome: { status: 'done' | 'interrupted' | 'error'; error?: ProviderError }) => void this.finishTurn(state, outcome),
      onExit: (error: ProviderError | null) => {
        this.live.delete(thread.id);
        if (error?.kind === 'resume-failed') {
          resumeFailed = true;
          void this.fallBack(state);
          return;
        }
        if (error && state.streaming) void this.finishTurn(state, { status: 'error', error });
      },
    };
    const session = thread.provider === 'claude' ? new ClaudeSession(options, events) : new CodexSession(options, events);
    if (resumeFailed) return null;
    const live: Live = { session, lastUsed: Date.now(), idle: undefined };
    this.live.set(thread.id, live);
    this.touch(thread.id, live);
    return session;
  }

  /** The stored session is gone (deleted, CLI upgraded, other provider): start again from a summary. */
  private async fallBack(state: ThreadState): Promise<void> {
    const thread = state.thread!;
    thread.providerSessionId = null;
    state.context = null;
    await this.saveThread(thread);
    const lastUser = [...state.messages].reverse().find((m) => m.body.role === 'user');
    const earlier = state.messages.filter((m) => m !== lastUser);
    // The divider goes before the message that's being answered again.
    if (lastUser) {
      const index = state.messages.indexOf(lastUser);
      const divider: DuetMessage = { id: uuidv7(), threadId: thread.id, createdAt: lastUser.createdAt - 1, body: { role: 'divider', text: 'Continued with a summary' } };
      state.messages.splice(index, 0, divider);
      await this.persistence.duet({ op: 'saveMessage', message: divider }).catch(() => undefined);
    }
    const session = await this.sessionFor(state, transcriptSummary(earlier) || undefined);
    if (session && lastUser?.body.role === 'user') session.send(userTurnText(lastUser.body.text, lastUser.body.attachments));
    else if (!session) await this.finishTurn(state, { status: 'error', error: state.lastError ?? { kind: 'other', message: "Duet couldn't start." } });
  }

  private touch(threadId: string, live: Live): void {
    live.lastUsed = Date.now();
    clearTimeout(live.idle);
    live.idle = setTimeout(() => {
      if (!live.session.busy) this.drop(threadId);
    }, DUET_PROCESS_IDLE_MS);
    live.idle.unref?.();
  }

  private drop(threadId: string): void {
    const live = this.live.get(threadId);
    if (!live) return;
    clearTimeout(live.idle);
    this.live.delete(threadId);
    live.session.close();
  }

  private close(state: ThreadState): void {
    if (state.thread) this.drop(state.thread.id);
  }

  private async finishTurn(state: ThreadState, outcome: { status: 'done' | 'interrupted' | 'error'; error?: ProviderError }): Promise<void> {
    const streaming = state.streaming;
    if (!streaming || streaming.body.role !== 'assistant') return;
    state.streaming = null;
    state.startedAt = null;
    for (const resolve of state.pending.values()) resolve('denied');
    state.pending.clear();
    const text = streaming.body.text;
    const citations: DuetCitation[] = [];
    for (const seg of splitCitations(text)) {
      if (seg.kind !== 'citation' || citations.some((c) => c.n === seg.n)) continue;
      const nodeId = state.refs.get(seg.ref) ?? null;
      const node = nodeId ? this.browser.store.state.nodes[nodeId] : undefined;
      // A PDF's page comes from the text Duet read, not from the model.
      const pdf = nodeId ? state.pdfs.get(nodeId) : undefined;
      const page = pdf ? pdfPageOf(pdf.pages, seg.quote) : null;
      citations.push({
        n: seg.n,
        ref: seg.ref,
        quote: seg.quote,
        url: pdf?.url ?? (node?.kind === 'tab' ? node.url : ''),
        title: node?.kind === 'tab' ? node.title : '',
        tabId: node ? nodeId : null,
        ...(page ? { page } : {}),
      });
    }
    const body: DuetMessageBody = { role: 'assistant', text, citations, status: outcome.status, ...(outcome.error ? { error: outcome.error.message } : {}) };
    if (outcome.status === 'error') state.lastError = outcome.error ?? null;
    if (text.trim() || outcome.status !== 'done') {
      const message = { ...streaming, body };
      state.messages.push(message);
      await this.persistence.duet({ op: 'saveMessage', message }).catch(() => undefined);
    }
    if (state.thread) {
      state.thread.updatedAt = Date.now();
      state.thread.lastUsedAt = Date.now();
      await this.saveThread(state.thread);
      const live = this.live.get(state.thread.id);
      if (live) this.touch(state.thread.id, live);
    }
    this.schedulePush();
    const next = state.queue.shift();
    if (next && state.windowId && outcome.status !== 'error') void this.send(state.windowId, state, next);
  }

  private async addMessage(state: ThreadState, body: DuetMessageBody): Promise<DuetMessage> {
    const message: DuetMessage = { id: uuidv7(), threadId: state.thread!.id, createdAt: Date.now(), body };
    state.messages.push(message);
    await this.persistence.duet({ op: 'saveMessage', message }).catch(() => undefined);
    this.schedulePush();
    return message;
  }

  private async updateMessage(message: DuetMessage, body: DuetMessageBody): Promise<void> {
    message.body = body;
    await this.persistence.duet({ op: 'saveMessage', message }).catch(() => undefined);
    this.schedulePush();
  }

  private async saveThread(thread: DuetThread): Promise<void> {
    await this.persistence.duet({ op: 'saveThread', thread }).catch(() => undefined);
  }

  private async refreshRecent(chordId: string): Promise<void> {
    const result = await this.persistence.duet({ op: 'threads', chordId, limit: THREADS_IN_MENU }).catch(() => ({ threads: [] as DuetThread[] }));
    this.recent.set(chordId, (result.threads ?? []).map((t) => ({ id: t.id, title: t.title, lastUsedAt: t.lastUsedAt })));
    this.schedulePush();
  }

  /* ---------- Tools ---------- */

  /** Ask in the thread (an approval card), and keep the answer as a record. */
  private async ask(state: ThreadState, tool: string, description: string, target: string[]): Promise<{ decision: Decision; message: DuetMessage }> {
    const message = await this.addMessage(state, { role: 'approval', tool, description, target, decision: 'pending' });
    const decision = await new Promise<Decision>((resolve) => state.pending.set(message.id, resolve));
    if (decision === 'thread') state.grants.add(tool);
    if (message.body.role === 'approval') await this.updateMessage(message, { ...message.body, decision });
    return { decision, message };
  }

  private async activity(state: ThreadState, tool: string, summary: string, detail = '', ok = true): Promise<void> {
    await this.addMessage(state, { role: 'tool', tool, summary, detail, ok });
  }

  private resolveTab(state: ThreadState, ref: unknown): TabNode | null {
    const id = typeof ref === 'string' ? state.refs.get(ref) : undefined;
    const node = id ? this.browser.store.state.nodes[id] : undefined;
    return node?.kind === 'tab' ? node : null;
  }

  private tabsInScope(state: ThreadState): TabNode[] {
    const scope: DuetScope = state.thread?.scope ?? 'ask';
    const nodes = Object.values(this.browser.store.state.nodes).filter((n): n is TabNode => n.kind === 'tab' && this.readable(n));
    return scope === 'all' ? nodes : nodes.filter((n) => n.chordId === state.chordId);
  }

  private async runTool(state: ThreadState, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    const spec = duetTool(name);
    if (!spec || !state.thread) return { text: toolResult({ error: `Unknown tool ${name}` }, false), isError: true };
    try {
      return await this.readTool(state, spec.name, args);
    } catch (error) {
      return { text: toolResult({ error: error instanceof Error ? error.message : String(error) }, false), isError: true };
    }
  }

  private async readTool(state: ThreadState, tool: DuetToolName, args: Record<string, unknown>): Promise<ToolOutput> {
    const thread = state.thread!;
    const refuse = (why: string) => ({ text: toolResult({ refused: why }, false), isError: true });
    if (tool === 'list_tabs' || tool === 'search_history' || tool === 'search_archive') {
      if (readNeedsApproval({ scope: thread.scope, attached: false, sameChord: true, tool, granted: state.grants.has(tool) })) {
        const what = tool === 'list_tabs' ? 'See the list of your tabs' : tool === 'search_history' ? `Search your history for “${String(args['query'] ?? '')}”` : `Search your archive for “${String(args['query'] ?? '')}”`;
        const { decision } = await this.ask(state, tool, what, []);
        if (decision === 'denied') return refuse('The user said no to this. Carry on without it, or ask them.');
      }
      if (tool === 'list_tabs') {
        const tabs = this.tabsInScope(state).map((n) => ({ tab_id: this.refFor(state, n.id), title: n.title, site: safeHost(n.url), attached: state.attached.has(n.id) }));
        await this.activity(state, tool, `Listed ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`);
        return { text: toolResult({ tabs }) };
      }
      const query = String(args['query'] ?? '').slice(0, 200);
      // Sites on the Never list stay out of search results too, as do chords where Duet is off.
      const allowed = (url: string, chordId?: string) =>
        !isNeverReadable(url, this.settings.neverSites) && !(chordId && (this.settings.offChords.includes(chordId) || this.isPrivateChord(chordId)));
      if (tool === 'search_history') {
        const result = await this.persistence.search(query, state.chordId);
        const hits = result.history
          .filter((h) => allowed(h.url))
          .slice(0, 20)
          .map((h) => ({ title: h.title, url: h.url, last_visit: new Date(h.lastVisitAt).toISOString() }));
        await this.activity(state, tool, `Searched history for “${query}”`, `${hits.length} found`);
        return { text: toolResult({ results: hits }) };
      }
      const page = await this.persistence.archiveList(query, 40);
      const hits = page.items
        .filter((a) => allowed(a.url, a.chordId))
        .slice(0, 20)
        .map((a) => ({ title: a.title, url: a.url, archived: new Date(a.archivedAt).toISOString() }));
      await this.activity(state, tool, `Searched the archive for “${query}”`, `${hits.length} found`);
      return { text: toolResult({ results: hits }) };
    }

    // read_tab, read_selection, tab_screenshot
    const node = tool === 'read_selection' && args['tab_id'] === undefined ? this.firstAttached(state) : this.resolveTab(state, args['tab_id']);
    if (!node) return refuse('No such tab. Use list_tabs or an attached tab id.');
    if (!this.readable(node)) return refuse('Duet can never read this page (a private window, a Chord page, or a site the user keeps private).');
    const needs = readNeedsApproval({ scope: thread.scope, attached: state.attached.has(node.id), sameChord: node.chordId === state.chordId, tool, granted: state.grants.has(`read:${node.id}`) || state.grants.has(tool) });
    if (needs) {
      const verb = tool === 'tab_screenshot' ? 'Take a picture of' : 'Read';
      const { decision } = await this.ask(state, tool, `${verb} “${node.title || safeHost(node.url)}”`, [node.url]);
      if (decision === 'denied') return refuse('The user said no to reading that tab. Carry on without it, or ask them.');
      if (decision === 'thread') state.grants.add(tool);
    }
    const contents = await this.loadedContents(node.id);
    if (!contents) return refuse('That tab could not be loaded.');
    state.read.add(node.id);
    const ref = this.refFor(state, node.id);
    if (tool === 'tab_screenshot') {
      const shot = await screenshot(contents);
      await this.activity(state, tool, `Looked at “${node.title || safeHost(node.url)}”`, node.url, Boolean(shot));
      return shot ? { image: shot } : refuse('Could not take the picture.');
    }
    const page = await readPage(contents);
    if (isPdf(page, contents.getURL())) {
      if (tool === 'read_selection') return refuse('Duet can’t see what’s selected inside a PDF. Read the PDF with read_tab instead.');
      return this.readPdf(state, node, contents, ref, args);
    }
    if (!page) return refuse('That page could not be read.');
    if (tool === 'read_selection') {
      await this.activity(state, tool, `Read your selection in “${node.title || safeHost(node.url)}”`, node.url);
      return { text: pageResult({ ref, url: page.url, text: page.selection, retrievedAt: Date.now() }) };
    }
    const start = typeof args['start'] === 'number' ? args['start'] : 0;
    const length = typeof args['length'] === 'number' ? args['length'] : undefined;
    const text = pageResult({ ref, url: page.url, text: page.text, start, ...(length ? { length } : {}), retrievedAt: Date.now() });
    await this.activity(state, tool, `Read “${node.title || safeHost(node.url)}”`, node.url);
    return { text };
  }

  /**
   * A PDF in Chromium's viewer: its bytes through the tab's own session, its
   * text from pdf.js in a utility process, with [Page n] markers. Reading on
   * from `start` reuses the same read; a new read fetches it again.
   */
  private async readPdf(state: ThreadState, node: TabNode, contents: WebContents, ref: string, args: Record<string, unknown>): Promise<ToolOutput> {
    const title = node.title || safeHost(node.url);
    const url = contents.getURL();
    const start = typeof args['start'] === 'number' ? args['start'] : 0;
    const length = typeof args['length'] === 'number' ? args['length'] : undefined;
    let pdf = state.pdfs.get(node.id);
    if (!pdf || pdf.url !== url || start === 0) {
      try {
        const bytes = await fetchPdf(contents, url, (finalUrl) => !isNeverReadable(finalUrl, this.settings.neverSites));
        const { pages, totalPages } = await extractPdf(bytes, DUET_PDF_MAX_PAGES);
        pdf = { url, pages, totalPages, text: pdfText(pages) };
      } catch (error) {
        const why = error instanceof PdfError ? pdfProblemCopy(error.problem, error.detail) : pdfProblemCopy('crashed');
        await this.activity(state, 'read_tab', `Couldn’t read “${title}”`, why, false);
        return { text: toolResult({ refused: `Duet couldn’t read this PDF: ${why}.` }, false), isError: true };
      }
      state.pdfs.delete(node.id);
      state.pdfs.set(node.id, pdf);
      if (state.pdfs.size > PDFS_KEPT) state.pdfs.delete(state.pdfs.keys().next().value!);
    }
    const read = pdf.pages.length;
    const notes = [
      pdf.totalPages > read ? `This PDF has ${pdf.totalPages} pages; Duet read pages 1–${read}, the most it reads.` : '',
      pdf.pages.every((p) => !p.trim()) ? 'This PDF has no text to read (it may be scanned pages); tab_screenshot shows the page on screen.' : '',
    ].filter(Boolean);
    const text = pageResult({ ref, url, text: pdf.text, start, ...(length ? { length } : {}), retrievedAt: Date.now(), pdf: { pages: pdf.totalPages, read }, ...(notes.length ? { note: notes.join(' ') } : {}) });
    await this.activity(state, 'read_tab', `Read “${title}”`, pdf.totalPages > read ? `PDF, pages 1–${read} of ${pdf.totalPages}` : `PDF, ${pdf.totalPages} page${pdf.totalPages === 1 ? '' : 's'}`);
    return { text };
  }

  private firstAttached(state: ThreadState): TabNode | null {
    for (const id of state.attached) {
      const node = this.browser.store.state.nodes[id];
      if (node?.kind === 'tab') return node;
    }
    return null;
  }

  /** The tab's page, loading it if it's asleep or wasn't opened since launch. */
  private async loadedContents(nodeId: NodeId) {
    const view = this.browser.tabs.ensure(nodeId);
    const contents = view?.webContents;
    if (!contents) return null;
    if (contents.isLoading()) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 15_000);
        contents.once('did-stop-loading', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    return contents.isDestroyed() ? null : contents;
  }

  /* ---------- Citations, export ---------- */

  private async openCitation(windowId: WindowId, state: ThreadState, messageId: string, n: number): Promise<void> {
    const message = state.messages.find((m) => m.id === messageId);
    if (message?.body.role !== 'assistant') return;
    const citation = message.body.citations.find((c) => c.n === n);
    if (!citation) return;
    const node = citation.tabId ? this.browser.store.state.nodes[citation.tabId] : undefined;
    if (node?.kind === 'tab') {
      this.browser.store.dispatch({ t: 'tab.activate', windowId, nodeId: node.id });
      const contents = await this.loadedContents(node.id);
      if (!contents) return;
      // Scroll to the quote and mark it, as find in page does (Chromium's PDF viewer included).
      const matches = await findMatches(contents, citation.quote);
      // A PDF quote the viewer can't find as written (a word split across lines): open its page instead.
      // The viewer reads #page= only when it loads, so it reloads there.
      if (!matches && citation.page && !contents.isDestroyed()) {
        await contents.loadURL(pdfPageUrl(contents.getURL(), citation.page)).catch(() => undefined);
        if (!contents.isDestroyed()) contents.reload();
      }
      return;
    }
    if (citation.url) this.browser.store.dispatch({ t: 'tab.open', windowId, url: citation.page ? pdfPageUrl(citation.url, citation.page) : textFragmentUrl(citation.url, citation.quote) });
  }

  private async exportThread(state: ThreadState): Promise<void> {
    if (!state.thread) return;
    const lines = [`# ${state.thread.title}`, ''];
    for (const m of state.messages) {
      if (m.body.role === 'user') lines.push(`**You:** ${m.body.text}`, '');
      else if (m.body.role === 'assistant') {
        lines.push(`**Duet:** ${stripCitations(m.body.text)}`, '');
        for (const c of m.body.citations) lines.push(`[${c.n}] ${c.title} — ${c.url} — “${c.quote}”`);
        if (m.body.citations.length) lines.push('');
      } else if (m.body.role === 'approval') lines.push(`*${m.body.description}: ${m.body.decision}*`, '');
    }
    const { downloadsDir } = await import('../downloads');
    const safe = state.thread.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Duet chat';
    const file = join(downloadsDir(), `${safe}.md`);
    await writeFile(file, lines.join('\n'), 'utf8');
    const shell = state.windowId ? this.browser.window(state.windowId)?.shell.webContents : undefined;
    if (shell) send(shell, 'toast:show', { id: `duet-export:${state.thread.id}`, message: `Saved “${safe}.md” to Downloads` });
  }

  /* ---------- Deleting ---------- */

  private async deleteThread(chordId: string, threadId: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (state) {
      this.close(state);
      this.threads.delete(threadId);
    }
    const removed = (await this.persistence.duet({ op: 'deleteThread', threadId }).catch(() => ({ removed: [] }))).removed ?? [];
    for (const thread of removed) await this.deleteProviderCopy(thread);
    delete this.drafts[threadId];
    if (this.showing.get(chordId) === threadId) this.fresh(chordId);
    await this.refreshRecent(chordId);
  }

  async clearAll(): Promise<void> {
    for (const id of [...this.live.keys()]) this.drop(id);
    this.threads.clear();
    this.showing.clear();
    const removed = (await this.persistence.duet({ op: 'deleteAll' }).catch(() => ({ removed: [] }))).removed ?? [];
    for (const thread of removed) await this.deleteProviderCopy(thread);
    this.recent.clear();
    this.drafts = {};
    void this.savePanel();
    this.schedulePush();
  }

  /**
   * "Delete really deletes": the provider's own copy of a thread, by its exact
   * session id. Claude keeps it under Chord's working-directory project folder;
   * Codex deletes its rollout through its own API. Nothing else is read.
   */
  async deleteProviderCopy(thread: DuetThread): Promise<void> {
    const id = thread.providerSessionId;
    if (!id || !/^[A-Za-z0-9-]{8,80}$/.test(id)) return;
    if (thread.provider === 'claude') {
      const folder = join(claudeConfigDir(), 'projects', claudeProjectFolder(join(this.root, 'empty')));
      await rm(join(folder, `${id}.jsonl`), { force: true }).catch(() => undefined);
      await rm(join(folder, id), { recursive: true, force: true }).catch(() => undefined);
      // Claude Code inside WSL keeps its sessions in the distro.
      const wsl = (this.launches.claude ?? this.inWsl.claude?.launch)?.wsl;
      if (wsl) await removeInWsl(wsl, wslClaudeSessionPaths(wsl, join(this.root, 'empty'), id));
      return;
    }
    if (!this.statuses.codex) await this.refreshProviders('never');
    const launch = this.launches.codex;
    if (!launch) return;
    await new Promise<void>((done) => {
      const session = new CodexSession(
        { launch, cwd: join(this.root, 'empty'), model: null, instructions: '', instructionsFile: '', resumeId: '__delete_only__', newSessionId: '', tools: [] },
        { onSessionId: () => undefined, onText: () => undefined, onTool: async () => ({}), onTurnEnd: () => undefined, onExit: () => done() },
      );
      const timer = setTimeout(() => session.close(), 10_000);
      void session.deleteThread(id).finally(() => {
        clearTimeout(timer);
        session.close();
      });
    });
  }

  /* ---------- Providers, settings ---------- */

  /**
   * What's installed and signed in. Windows, macOS and Linux installs are
   * checked every time. Inside WSL (Windows only, for a provider Windows
   * doesn't have) only when asked: `always` for Check again and Settings,
   * `if-needed` when the panel opens (while Setup shows, or the provider in
   * use lives in WSL), `never` at launch. The look runs in the background,
   * with a timeout, and Setup says it's looking meanwhile.
   */
  async refreshProviders(wsl: 'never' | 'if-needed' | 'always' = 'always'): Promise<ProviderStatus[]> {
    const native = await Promise.all(DUET_PROVIDERS.map((p) => detect(p)));
    for (const found of native) this.setDetected(found.status.installed ? found : (this.inWsl[found.status.provider] ?? found));
    this.schedulePush();
    const missing = native.filter((d) => !d.status.installed && mayBeInWsl(d.status.provider)).map((d) => d.status.provider);
    if (missing.length && this.wantsWsl(wsl)) await this.lookInWsl(missing);
    return this.providerStatuses;
  }

  private wantsWsl(wsl: 'never' | 'if-needed' | 'always'): boolean {
    if (wsl !== 'if-needed') return wsl === 'always';
    const chosen = this.settings.provider ? this.statuses[this.settings.provider] : undefined;
    return !chosen?.installed || !chosen.signedIn || chosen.wsl !== null;
  }

  private lookInWsl(providers: DuetProvider[]): Promise<void> {
    this.wslLookup ??= (async () => {
      // The registry says whether there's a distro at all: no WSL, nothing starts and nothing shows.
      const distro = await defaultWslDistro();
      if (!distro) {
        for (const p of providers) delete this.inWsl[p];
        return;
      }
      this.lookingInWsl = true;
      this.schedulePush();
      try {
        const found = await detectInWsl(providers, distro);
        // WSL didn't answer in time: keep what was known.
        if (!found) return;
        for (const provider of providers) {
          const detected = found.find((d) => d.status.provider === provider);
          if (detected) this.inWsl[provider] = detected;
          else delete this.inWsl[provider];
          if (!this.statuses[provider]?.installed || this.statuses[provider]?.wsl) this.setDetected(detected ?? { status: notInstalled(provider), launch: null });
        }
        void this.savePanel();
      } finally {
        this.lookingInWsl = false;
        this.schedulePush();
      }
    })().finally(() => (this.wslLookup = null));
    return this.wslLookup;
  }

  private setDetected({ status, launch }: Detected): void {
    this.statuses[status.provider] = status;
    if (launch) this.launches[status.provider] = launch;
    else delete this.launches[status.provider];
  }

  get providerStatuses(): ProviderStatus[] {
    return DUET_PROVIDERS.map((p) => this.statuses[p]).filter((s): s is ProviderStatus => Boolean(s));
  }

  /** Sign in: the provider's own login in a terminal (inside WSL for a WSL install). */
  async signIn(provider: DuetProvider): Promise<void> {
    if (!this.statuses[provider]) await this.refreshProviders('if-needed');
    const launch = this.launches[provider];
    if (launch) openSignIn(provider, launch);
  }

  private async savePanel(): Promise<void> {
    const wsl: SavedWsl = {};
    for (const [provider, found] of Object.entries(this.inWsl) as [DuetProvider, Detected][]) if (found.launch?.wsl) wsl[provider] = { status: found.status, target: found.launch.wsl };
    await writeFile(join(this.root, 'panel.json'), JSON.stringify({ drafts: this.drafts, firstUseSeen: this.firstUseSeen, wsl }), { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  }

  /** Quitting: replies in flight are kept as interrupted, and every provider process ends. */
  async quit(): Promise<void> {
    for (const state of this.threads.values()) {
      if (state.streaming && state.streaming.body.role === 'assistant' && state.thread) {
        const message = { ...state.streaming, body: { ...state.streaming.body, status: 'interrupted' as const } };
        await this.persistence.duet({ op: 'saveMessage', message }).catch(() => undefined);
      }
    }
    for (const id of [...this.live.keys()]) this.drop(id);
  }

  /** Command bar @duet. */
  async search(query: string) {
    const result = await this.persistence.duet({ op: 'search', query, limit: 20 }).catch(() => ({ hits: [] }));
    return result.hits ?? [];
  }

  /** Open a thread found by @duet in this window, on its chord. */
  async openHit(windowId: WindowId, chordId: string, threadId: string): Promise<void> {
    if (!this.browser.store.state.chords[chordId]) return;
    this.browser.store.dispatch({ t: 'chord.activate', windowId, chordId });
    await this.load(threadId, chordId);
    this.panel(windowId).open = true;
    this.schedulePush();
  }
}

/** Find in page from the start, and how many matches it found (0 if it doesn't answer within a moment). */
function findMatches(contents: WebContents, text: string): Promise<number> {
  return new Promise((done) => {
    let request = -1;
    const finish = (matches: number) => {
      clearTimeout(timer);
      contents.off('found-in-page', onFound);
      done(matches);
    };
    const onFound = (_event: unknown, result: Electron.Result) => {
      if (result.requestId === request && result.finalUpdate) finish(result.matches);
    };
    const timer = setTimeout(() => finish(0), 2000);
    contents.on('found-in-page', onFound);
    request = contents.findInPage(text, { findNext: false });
  });
}

/** Chromium's PDF viewer: the page's own document says application/pdf (and the extractor sees only the viewer). */
function isPdf(page: PageRead | null, url: string): boolean {
  if (page) return page.contentType === 'application/pdf';
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
