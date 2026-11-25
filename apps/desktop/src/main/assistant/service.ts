/**
 * The assistant in main (ARCHITECTURE.md §11): threads per chord, provider sessions,
 * Chord's tools with their tiers, scope and approvals, and what each window's
 * panel shows. Chord's transcript (chord-data, migration 9) is the source of
 * truth; a provider's session is a cache that's resumed when it still works
 * and replaced when it doesn't, the new one given the chat's newest turns as
 * untrusted data with the next message.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentChords,
  barAddress,
  wholeAddress,
  barDoing,
  CONTROL_WAIT_MS,
  sendTitle,
  splitOf,
  shownTabs,
  stepDanger,
  stepTitle,
  type AssistantActCard,
  children,
  nodesOfChord,
  ASSISTANT_MAX_IMAGES,
  ASSISTANT_MAX_PROCESSES,
  ASSISTANT_PROCESS_IDLE_MS,
  ASSISTANT_PROVIDERS,
  agentActions,
  assistantTools,
  assistantInstructions,
  assistantPruneBefore,
  fieldCount,
  fillChangedNote,
  fillWrites,
  isNeverReadable,
  samePage,
  nameTabs,
  pdfPageOf,
  pdfPageUrl,
  screenshotFilename,
  TabRefs,
  attachesTabOnScreen,
  earlierTurns,
  splitCitations,
  stripCitations,
  textFragmentUrl,
  threadTitle,
  threadToShow,
  toolResult,
  userTurnText,
  uuidv7,
  nodeOf,
  nextReplyText,
  nodeList,
  type AssistantAttachment,
  type AssistantCitation,
  type AssistantImage,
  type AssistantImageMaking,
  type AssistantTabName,
  type AssistantContextUsage,
  type AssistantFillCard,
  type AssistantMessage,
  type AssistantMessageBody,
  type AssistantProvider,
  type AssistantScope,
  type AssistantThread,
  type AssistantToolSpec,
  type NodeId,
  type TabNode,
  type WindowId,
  assistantGoOutline,
} from '@chord/core';
import type { AssistantAction, AssistantView, Toast } from '@chord/ipc';
import { durations, easing } from '@chord/tokens';
import { app, clipboard, ClipboardItem, nativeImage, net, type WebContents } from 'electron';
import { pathToFileURL } from 'node:url';
import type { Browser } from '../browser';
import { send } from '../ipc';
import type { Persistence } from '../persistence';
import { pageOf } from '../view-page';
import type { AssistantSession, MadeImage, ProviderError, SessionImage, ToolOutput } from './adapter';
import { ClaudeSession } from './claude';
import { CodexSession } from './codex';
import { claudeConfigDir, claudeProjectFolder, detect, detectInWsl, mayBeInWsl, notInstalled, openSignIn, rememberedInWsl, type Detected, type Launch, type ProviderStatus } from './detect';
import { ControlAgent, type ControlCard } from '../control/gate';
import { controlPage } from '../control/page';
import type { FillOutcome } from '../control/forms';
import type { ControlScope } from '../control/scope';
import { runControlTool } from '../control/tools';
import { AssistantImages, imageInfo, newImageId } from './images';
import { asWslTarget, defaultWslDistro, removeInWsl, wslClaudeSessionPaths, type WslTarget } from './launch';
import { duetScope, USER_TAB_REFUSALS, type DuetChat, type DuetHost } from './scope';
import { siteOfUrl } from '../agents/shares';
import { shownOrigin, type SendHoldDeps } from '../control/sends';
import { buildActs } from './preview';
import { dropAgentGuard } from '../control/page';
import { beginUserAction, endUserLease, onUserLeaseEnd, userLeaseOwner, userTabActing, userTabGoing, type UserTabNote } from '../control/user-watch';

type Decision = 'once' | 'thread' | 'always' | 'denied';

/** An image for the assistant, as a pasted image or a screenshot brings it: the picture for the model, and a thumbnail. */
export interface ImageInput {
  mime: AssistantImage['mime'];
  width: number;
  height: number;
  bytes: Uint8Array;
  thumb: Uint8Array;
}

/** One waiting in the composer: kept in memory until its message is sent. */
interface PendingImage {
  image: AssistantImage;
  bytes: Buffer;
  thumb: Buffer;
}

/**
 * A chat. As the control layer's agent (DuetChat), it has its refs, attached
 * tabs, gate (grants, cards, Stop) and what its tools remember (PDFs read, the
 * last form, tabs read: a badge in the sidebar while it's open).
 */
interface ThreadState extends DuetChat {
  messages: AssistantMessage[];
  queue: string[];
  /** Each queued message's attachments, taken when it was sent (S18 M2e-1: never what's on screen when it goes). */
  queuedWith: AssistantAttachment[][];
  /** Each queued message's tab on screen as it was sent (S18 M2e-2a): the one it may act in. */
  queuedTab: DuetChat['actTab'][];
  streaming: AssistantMessage | null;
  /** Show me on an acting card, by its message id: outlines the element in its page. */
  shows: Map<string, () => void>;
  /** Tabs this chat holds (or held, until their tail ends) a lease on: Stop and your input let them all go. */
  leased: Set<NodeId>;
  /** Each user message's tab on screen as it was sent: Retry and Make with Codex act there, never where you are now. */
  sentTabs: Map<string, DuetChat['actTab']>;
  /** *Allow for this chat* on a send card, per tab: origins its sends go to without a card until the chat ends (sends.ts' kept). */
  sendGrants: Map<NodeId, Set<string>>;
  /** Your key or click ended this message's acting before it acted: said at its first refused step (sayStopped). */
  stopUnsaid: boolean;
  /** What of yours stopped its acting (a key and its code, a click, Back…), said with *Stopped: you used the tab*. */
  stoppedBy: string | null;
  /** What the lease caught in each tab since its last result there (said in the next one). */
  caught: Map<NodeId, string[]>;
  /** Each action under way in a tab, its own end (user-watch's UserAction), oldest first. */
  actionEnds: Map<NodeId, (() => void)[]>;
  startedAt: number | null;
  /** Approval cards in the chat, by message id: the gate's card, answered from the panel. */
  pending: Map<string, (decision: Decision) => void>;
  /** Shown between messages after a resume fell back to a summary, or the provider changed. */
  pendingDivider: string | null;
  lastError: ProviderError | null;
  /** How full the provider's context is, as its CLI last reported (the panel's meter). */
  context: AssistantContextUsage | null;
  /** Images Codex made that are still being written: the reply is kept only once they're on disk. */
  saving: Set<Promise<void>>;
  /** Fill cards waiting for you, by message id: the read they're for (the card in the panel holds the values). */
  fills: Map<string, NonNullable<DuetChat['form']>>;
  /** The reply that showed a fill card: one card for each message you send. */
  fillTurn: string | null;
  /** Its scope in the control layer, made once. */
  scope: ControlScope | null;
}

/** A fill's Undo, by its toast's token. */
interface FillUndo {
  state: ThreadState;
  messageId: string;
  windowId: WindowId;
  nodeId: NodeId;
  url: string;
}

/** Undo tokens kept for fill toasts. */
const FILL_UNDOS = 30;

/** Why Fill wrote nothing (the page adapter's fillForm answers), as the card says it. */
const FILL_PROBLEMS: Record<Exclude<FillOutcome, { ok: true }>['why'], string> = {
  navigated: 'The page moved on since the form was read, so nothing was filled. Ask again.',
  gone: 'The form isn’t on the page any more, so nothing was filled.',
  changed: 'The form changed since it was read, so nothing was filled. Ask again.',
  'no-answer': 'The page didn’t answer in time, so Chord can’t say what went in. Check the form.',
};

/** A message as chord-data keeps it: a fill card's values stay in memory (D16). */
function saved(message: AssistantMessage): AssistantMessage {
  if (message.body.role !== 'tool' || !message.body.fill) return message;
  const { fill: _fill, ...body } = message.body;
  return { ...message, body };
}

/** Where the assistant's images go when you save one: Downloads, listed as a finished download. */
export interface AssistantFiles {
  save(filename: string, bytes: Uint8Array, mime: string): Promise<void>;
}

/** WSL installs as panel.json keeps them, so a WSL-only setup is ready at launch without starting WSL. */
type SavedWsl = Partial<Record<AssistantProvider, { status: ProviderStatus; target: WslTarget }>>;

interface Panel {
  open: boolean;
  /** The current tab chip was removed for this tab. */
  removedCurrent: NodeId | null;
  extra: NodeId[];
}

interface Live {
  session: AssistantSession;
  lastUsed: number;
  idle: ReturnType<typeof setTimeout> | undefined;
}

const THREADS_IN_MENU = 12;
/** What a chat's links may open: web pages, nothing else. */
const WEB_PAGE = /^https?:\/\/[^\s/]/i;
/** Development and tests: a shorter idle window, so "start fresh, offer Continue" can be seen. */
const IDLE_MS = (!app.isPackaged && Number(process.env['CHORD_ASSISTANT_IDLE_MS'])) || undefined;
const PUSH_MS = 33;

/** navigate's snapshot: true for this build (S18 M2g-2 slice 3a): its tools, its instructions and its scope, alike. */
const goOutline = (): boolean => assistantGoOutline({ packaged: app.isPackaged });

export class AssistantService {
  private statuses: Partial<Record<AssistantProvider, ProviderStatus>> = {};
  /** How to start each provider: never sent to a page (a launch holds the environment). */
  private launches: Partial<Record<AssistantProvider, Launch>> = {};
  /** Installs found inside WSL at the last look, used while Windows itself has none. */
  private inWsl: Partial<Record<AssistantProvider, Detected>> = {};
  private wslLookup: Promise<void> | null = null;
  /** Providers Setup is still looking for inside WSL. */
  private lookingInWsl: AssistantProvider[] = [];
  private readonly threads = new Map<string, ThreadState>();
  /** Which thread each chord's panel shows: a thread id, or a chord-keyed fresh one. */
  private readonly showing = new Map<string, string>();
  private readonly continueFrom = new Map<string, { id: string; title: string } | null>();
  private readonly panels = new Map<WindowId, Panel>();
  private readonly live = new Map<string, Live>();
  private drafts: Record<string, string> = {};
  private recent = new Map<string, { id: string; title: string; lastUsedAt: number }[]>();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Windows whose panel was just opened or closed: their next push slides it, and the page's frame glides. */
  private readonly toggled = new Set<WindowId>();
  private firstUseSeen = false;
  private readonly root: string;
  /** Images you've given the assistant, kept with their chats (images.ts). */
  private readonly images: AssistantImages;
  /** Images waiting in each window's composer for the next message. */
  private readonly pending = new Map<WindowId, PendingImage[]>();
  /** Which thumbnails each window's panel has been sent, so a streaming reply doesn't resend them. */
  private readonly thumbsSent = new Map<WindowId, Set<string>>();
  /** Thumbnails as data URLs, by image id (a chat's few, kept once read). */
  private readonly thumbs = new Map<string, string>();
  /** Drafts, the first-use note and WSL installs found earlier, read from panel.json. */
  private readonly opened: Promise<void>;
  /** Fills that can be undone, by their toast's token. */
  private readonly fillUndos = new Map<string, FillUndo>();
  /** Cards whose Fill is under way: a second press waits for nothing and writes nothing. */
  private readonly filling = new Set<string>();

  constructor(
    private readonly browser: Browser,
    private readonly persistence: Persistence,
    userData: string,
    private readonly files?: AssistantFiles,
  ) {
    this.root = join(userData, 'assistant');
    this.images = new AssistantImages(join(this.root, 'images'));
    browser.store.subscribe((change) => {
      if (change.patches.some((p) => p.path[0] === 'windows' || p.path[0] === 'settings' || p.path[0] === 'nodes' || p.path[0] === 'chords')) this.schedulePush();
      // Codex starts with its image tool on or off: idle Codex sessions start again with the new choice.
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'assistant' && p.path[2] === 'codexImages')) {
        for (const [threadId, live] of [...this.live]) if (live.session.provider === 'codex' && !live.session.busy) this.drop(threadId);
      }
      // "Nothing" turned on or off: every session starts again with its tools (or none) and instructions,
      // busy ones too, so a reply already under way can't read on with the tools it started with.
      // Click and type on pages (S18 M2e-2a): turned off, acting stops at once and the sessions start again without the
      // tools; a site taken off the list asks again, in every chat, mid-task too.
      const before = change.before.settings.assistant;
      const now = change.state.settings.assistant;
      // Show the assistant turned off: acting stops everywhere (E6; Neon's B4, round 2).
      if (before.enabled !== now.enabled && !now.enabled) for (const state of this.threads.values()) this.leaveChat(state);
      if (before.acting !== now.acting) {
        for (const threadId of [...this.live.keys()]) this.drop(threadId);
        if (!now.acting) for (const state of this.threads.values()) this.endActing(state, USER_TAB_REFUSALS.off);
      }
      if (before.readsNothing !== now.readsNothing || before.offChords !== now.offChords) {
        for (const state of this.threads.values()) if (now.readsNothing || now.offChords.includes(state.chordId)) this.endActing(state, USER_TAB_REFUSALS.off);
      }
      if (change.patches.some((p) => p.path[0] === 'windows' || p.path[0] === 'nodes')) this.screenChanged();
      if (before.actSites !== now.actSites) {
        const removed = before.actSites.filter((x) => !now.actSites.includes(x));
        for (const site of removed) for (const state of this.threads.values()) state.control.forget('site', site);
        // A site removed in Settings: every chat's *Allow for this chat* ends, whatever site it names (simpler; the worst
        // it does is ask again: the record's owner's answer 1).
        if (removed.length) for (const state of this.threads.values()) this.endGrants(state);
      }
      if (change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'assistant' && p.path[2] === 'readsNothing')) {
        for (const threadId of [...this.live.keys()]) this.drop(threadId);
        // A fill card waiting then fills nothing: what it read was read before.
        if (this.settings.readsNothing) {
          for (const state of this.threads.values()) {
            for (const m of state.messages) if (m.body.role === 'tool' && m.body.fill?.status === 'pending') void this.endFill(state, m, 'expired', 'What it can read is set to Nothing, so nothing was filled.');
          }
        }
      }
    });
    // A lease that ended (its tail, your hands, lost): its chat forgets the tab (Claude's B1, round 2).
    this.offLeaseEnd = onUserLeaseEnd((contents, owner) => {
      for (const state of this.threads.values()) {
        if (state.control.id !== owner) continue;
        for (const nodeId of [...state.leased]) if (this.browser.tabs.get(nodeId)?.webContents === contents) state.leased.delete(nodeId);
      }
    });
    this.opened = this.init();
  }

  private get settings() {
    return this.browser.store.state.settings.assistant;
  }

  private async init(): Promise<void> {
    await mkdir(join(this.root, 'empty'), { recursive: true });
    await mkdir(join(this.root, 'instructions'), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'panel.json'), 'utf8')) as { drafts?: Record<string, string>; firstUseSeen?: boolean; wsl?: SavedWsl };
      this.drafts = saved.drafts ?? {};
      this.firstUseSeen = Boolean(saved.firstUseSeen);
      for (const provider of ASSISTANT_PROVIDERS) {
        const entry = saved.wsl?.[provider];
        const target = asWslTarget(entry?.target);
        if (entry?.status && target) this.inWsl[provider] = rememberedInWsl({ ...notInstalled(provider), ...entry.status, provider }, target);
      }
    } catch {
      // First run.
    }
  }

  /**
   * Once launch is over (after-launch.ts): chats past their date go, and the assistant
   * looks for Claude Code and Codex, which runs each one twice. Opening the
   * panel or sending before then looks for them itself.
   */
  async afterLaunch(): Promise<void> {
    await this.opened;
    // Keep chats: threads past their date go, the provider's copy with them.
    const before = assistantPruneBefore(this.settings.keep, Date.now());
    if (before !== null) {
      const { removed = [], images = [] } = await this.persistence.assistant({ op: 'prune', before }).catch(() => ({ removed: [], images: [] }));
      for (const thread of removed) void this.deleteProviderCopy(thread);
      void this.images.remove(images, !this.launches.codex?.wsl);
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
    for (const state of this.threads.values()) if (state.actTab?.windowId === windowId) this.endActing(state, USER_TAB_REFUSALS.switched('its window closed'));
    this.panels.delete(windowId);
    this.toggled.delete(windowId);
    this.pending.delete(windowId);
    this.thumbsSent.delete(windowId);
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
    const result = await this.persistence.assistant({ op: 'threads', chordId, limit: THREADS_IN_MENU }).catch(() => ({ threads: [] as AssistantThread[] }));
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

  private blank(chordId: string, thread: AssistantThread | null): ThreadState {
    const state: ThreadState = {
      chordId,
      thread,
      messages: [],
      refs: new TabRefs<NodeId>('t'),
      attached: new Set(),
      pointed: new Set(),
      actTab: null,
      actEnded: null,
      elsewhere: false,
      readFrom: new Set(),
      listed: new Set(),
      shows: new Map(),
      leased: new Set(),
      sentTabs: new Map(),
      sendGrants: new Map(),
      actionEnds: new Map(),
      caught: new Map(),
      stopUnsaid: false,
      stoppedBy: null,
      queuedTab: [],
      // The chat is the agent; its cards are approval messages in the chat.
      control: new ControlAgent(`duet:${randomUUID()}`, (card, signal) => this.showCard(state, card, signal)),
      read: new Set(),
      queue: [],
      queuedWith: [],
      streaming: null,
      startedAt: null,
      windowId: null,
      pending: new Map(),
      pendingDivider: null,
      lastError: null,
      context: null,
      pdfs: new Map(),
      saving: new Set(),
      form: null,
      fills: new Map(),
      nextField: 1,
      fillTurn: null,
      scope: null,
    };
    return state;
  }

  private async load(threadId: string, chordId: string): Promise<ThreadState> {
    const existing = this.threads.get(threadId);
    if (existing) {
      this.showing.set(chordId, threadId);
      return existing;
    }
    const result = await this.persistence.assistant({ op: 'thread', threadId });
    const state = this.blank(chordId, result.thread ?? null);
    state.messages = result.messages ?? [];
    // Turns from before this session (resumed, continued, imported) may have read anything: what it types, and where it
    // goes, are shown first (failing closed: Neon's B3 on #151).
    state.elsewhere = state.messages.some((m) => m.body.role === 'user' || m.body.role === 'assistant');
    // Handles and attachments carry over, so earlier tabs stay readable and citations resolve.
    for (const m of state.messages) {
      if (m.body.role === 'user') {
        for (const a of m.body.attachments) {
          const node = this.nodeByUrl(chordId, a.url);
          // A tab that has closed since keeps its handle, which now reads as closed.
          state.refs.restore(a.ref, node);
          if (node) state.attached.add(node);
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
    for (const node of nodeList(this.browser.store.state)) if (node.kind === 'tab' && node.chordId === chordId && node.url === url) return node.id;
    return null;
  }

  /** Whether the assistant clicks and types (S18 M2e): a build with M2, Settings → Assistant's switch on, and not *Nothing*. */
  private acting(): boolean {
    return buildActs() && this.settings.enabled && this.settings.acting && !this.settings.readsNothing;
  }

  /** The tools a session is given when it reads pages: with acting as Settings has it, and this build's flags. */
  private tools(): readonly AssistantToolSpec[] {
    return assistantTools(agentActions({ packaged: app.isPackaged }), this.acting(), goOutline());
  }

  /** The tab on screen as a message is sent: the one it may act in (S18 M2e-2a, A1). */
  private tabOnScreen(windowId: WindowId): DuetChat['actTab'] {
    const node = this.activeTab(windowId);
    // An outside agent's tab on screen is never one to act in (Neon's N3b, round 3).
    return node && this.agentOf(node) === null ? { nodeId: node.id, windowId } : null;
  }

  /**
   * Acting ends for this message (S18 M2e-2a): you used the tab (F1), Stop, or the switch went off. Its cards come
   * down (each a no the action hears isn't yours: cancelCardsFor), what the lease held fails, the bar goes.
   */
  private endActing(state: ThreadState, why: string | null): void {
    const at = state.actTab;
    if (why && at) state.actEnded = why;
    // Every tab this chat holds a lease on (its own message's, and a tail still running after an earlier turn): let go,
    // what it held failing, its cards down (Claude's B2 on #147).
    for (const nodeId of new Set([...state.leased, ...(at ? [at.nodeId] : [])])) {
      state.control.cancelCardsFor(nodeId);
      const contents = this.browser.tabs.get(nodeId)?.webContents;
      const live = contents && !contents.isDestroyed() ? contents : null;
      const owner = live ? userLeaseOwner(live) : null;
      // Another chat's lease there now: its lease, its guard and its bar are left alone (Claude's B1, round 2).
      if (owner !== null && owner !== state.control.id) continue;
      if (live) {
        if (owner !== null) dropAgentGuard(live);
        // Its own begins under way there too.
        endUserLease(live, state.control.id);
      }
      this.barFor(nodeId, null, state.control.id);
    }
    state.leased.clear();
  }

  /**
   * You left this chat, or it ended (E6; Neon's B2 and S2, round 3 of #147): acting is over for its message, a message
   * queued behind it acts nowhere, and (`ends`: the chat itself ends, its model changes, Clear all, quit) its grants
   * end and its tool calls stop until the next message.
   */
  private leaveChat(state: ThreadState, ends = false): void {
    this.endActing(state, USER_TAB_REFUSALS.left);
    state.queuedTab = state.queuedTab.map(() => null);
    if (!ends) return;
    this.endGrants(state);
    state.control.stop();
  }

  /** The chat the panel shows for this chord (the one a message there goes to). */
  private shown(chordId: string): ThreadState | undefined {
    const key = this.showing.get(chordId);
    return key ? this.threads.get(key) : undefined;
  }

  /**
   * Your key or click in a tab (browser.ts, never input Chord sends: S18 M2e-2a, F1, F2): any lease of the assistant's
   * there ends at once, whatever the chat is doing, so nothing of yours is held or caught (Claude's and Neon's B2 on
   * #147). A chat acting there for this message stops, and says so once.
   */
  userUsedTab(nodeId: NodeId, why = 'your input'): void {
    const contents = this.browser.tabs.get(nodeId)?.webContents;
    const acting = Boolean(contents && !contents.isDestroyed() && userTabActing(contents));
    if (contents && !contents.isDestroyed()) {
      // The typing guard is the assistant's to drop only while it acts there: an outside agent's (G4) is left alone
      // (Neon's B3, round 2).
      if (acting) dropAgentGuard(contents);
      endUserLease(contents);
    }
    for (const state of this.threads.values()) {
      // Whether this turn was acting there as you took it: it had acted, held a lease, or had a call under way (a card).
      const busy = this.acted.has(state) || state.leased.has(nodeId) || state.control.state(nodeId).calls > 0;
      state.leased.delete(nodeId);
      // You took the tab from it mid-action (or in its moment after): *Allow for this chat* there ends (F1). A click
      // between turns is yours, and leaves it (the record's *Allow for this chat*).
      if (acting) state.sendGrants.get(nodeId)?.clear();
      if (!state.streaming || state.actTab?.nodeId !== nodeId || state.actEnded) continue;
      // Your key or click there ends this message's acting (the owner's answer 5). The chat says so: now, if it was acting
      // there; else at the first step it refuses because of it (Claude's S1, round 3): never silent, never for nothing.
      this.endActing(state, USER_TAB_REFUSALS.tookOver);
      // What of yours it was, said with it (the owner's test of 9d1ad40: so the next preview tells which).
      state.stoppedBy = why;
      if (busy) this.sayStopped(state);
      else state.stopUnsaid = true;
    }
  }

  /** Your reload, back, forward, Stop or address for a page (browser.ts' userNavigates): as your key or click there. */
  userMovedPage(contents: WebContents, why = 'a reload'): void {
    // As userUsedTab, with the tab's node: whether it was acting is asked there before anything ends (Neon's N2).
    const nodeId = contents.isDestroyed() ? undefined : this.browser.tabs.nodeFor(contents);
    if (nodeId) return this.userUsedTab(nodeId, why);
    // A page no tab knows (one being adopted): its lease, whoever's, ends.
    if (!contents.isDestroyed()) endUserLease(contents);
  }

  /**
   * What the page still sends a moment after the assistant's last action there (control/user-watch.ts): the chat's
   * card, as the action's own (the reviews of #147). Each origin as cards show it, where the page is going, and the
   * card down when nobody answers in time (what it held fails).
   */
  private tailCard(s: ThreadState, nodeId: NodeId, contents: WebContents): SendHoldDeps['ask'] {
    return async (sites, why, signal, going) => {
      if (contents.isDestroyed()) return 'deny';
      const takeDown = new AbortController();
      signal.addEventListener('abort', () => takeDown.abort(), { once: true });
      const page = contents.getURL();
      const site = shownOrigin(originOf(page), page);
      const hosts = sites.map((o) => shownOrigin(o, page));
      const answer = await s.control.ask(
        {
          kind: 'step',
          tool: 'act',
          description: 'After the assistant’s last step here',
          target: [page],
          tab: nodeId,
          subject: `${nodeId}|tail|${randomBytes(4).toString('hex')}`,
          // Leaving: the whole address (Neon's B1 on #151); another step's, the bar's short one.
          step: why ? { why, site: hosts[0] ?? site, fields: [], more: 0, idle: true, ...(going ? { going: why === 'leave' ? wholeAddress(going) : barAddress(going) } : {}) } : { why: 'send', site, fields: [], more: 0, sends: hosts, idle: true },
          takeDown: takeDown.signal,
        },
        signal,
        CONTROL_WAIT_MS,
      );
      if (answer === 'waiting') takeDown.abort();
      // A send card's `always` is *Allow for this chat*; a risky step's answers are never kept.
      return answer === 'always' && !why ? 'until' : answer === 'once' || answer === 'always' ? 'once' : 'deny';
    };
  }

  /** The chat's *Allow for this chat* for a tab (sends.ts' kept): made on first use, the same set after. */
  private sendGrantsFor(state: ThreadState, nodeId: NodeId): Set<string> {
    let kept = state.sendGrants.get(nodeId);
    if (!kept) state.sendGrants.set(nodeId, (kept = new Set()));
    return kept;
  }

  /** The chat ends (or Settings removed a site): every *Allow for this chat* it had ends, in place (a hold may share it). */
  private endGrants(state: ThreadState): void {
    for (const kept of state.sendGrants.values()) kept.clear();
  }

  /**
   * What's on screen changed (the store, Peek, a window minimized: browser.screenChanged): the message's tab off screen
   * (another tab, Peek over it, another window, minimized, closed) ends acting for the message, with no coming back to
   * it (A1; Neon's B6 on #147, S1 of round 2). A split isn't latched: mayAct refuses it (USER_TAB_REFUSALS.split) until
   * the tab is shown alone again.
   */
  screenChanged(): void {
    for (const state of this.threads.values()) {
      const at = state.actTab;
      if (!state.streaming || !at || state.actEnded || this.actShown(at)) continue;
      if (splitOf(this.browser.store.state, at.nodeId) && shownTabs(this.browser.store.state, at.windowId).includes(at.nodeId) && this.windowShown(at.windowId)) continue;
      this.endActing(state, USER_TAB_REFUSALS.switched(this.offScreen(at) ?? 'it is in a split'));
    }
  }

  /** The window is there, not minimized, with no Peek over its page. */
  private windowShown(windowId: WindowId): boolean {
    const w = this.browser.allWindows.find((x) => x.id === windowId);
    return Boolean(w && !w.window.isMinimized() && !this.browser.peeks.isOpen(w));
  }

  /** *Stopped: you used the tab*, once for the message. */
  private sayStopped(state: ThreadState): void {
    state.stopUnsaid = false;
    if (state.thread) void this.activity(state, 'act', `Stopped: you used the tab${state.stoppedBy ? ` (${state.stoppedBy})` : ''}`, '', false);
  }

  /** Stops hearing leases end (quit). */
  private offLeaseEnd: () => void = () => undefined;

  /** Chats that acted this turn: your using the tab says it stopped them. */
  private readonly acted = new WeakSet<ThreadState>();

  /** Tabs whose bar this service put up (the assistant's), and which chat put each up: only those are cleared, never an agent's (Claude's B1), and only by their chat (Neon's N4). */
  private readonly bars = new Map<NodeId, string>();

  /**
   * Whether the message's tab is still on screen where it was sent: shown alone (no split, no Peek over it) in a
   * window that isn't minimized (A1; Neon's B6 on #147).
   */
  private actShown(at: NonNullable<DuetChat['actTab']>): boolean {
    return this.offScreen(at) === null && !splitOf(this.browser.store.state, at.nodeId);
  }

  /** What's on screen instead of the message's tab, in a few words (the refusal says it), or null while it's there. */
  private offScreen(at: NonNullable<DuetChat['actTab']>): string | null {
    const w = this.browser.allWindows.find((x) => x.id === at.windowId);
    if (!w) return 'its window closed';
    if (nodeOf(this.browser.store.state, at.nodeId)?.kind !== 'tab') return 'it was closed';
    if (w.window.isMinimized()) return 'its window was minimized';
    if (this.browser.peeks.isOpen(w)) return 'Peek is open over it';
    const shown = this.activeTab(at.windowId);
    if (shown?.id !== at.nodeId) return shown ? 'another tab is on screen in its window' : 'no tab is on screen in its window';
    return null;
  }

  /** The bar over a tab of yours while the assistant acts there (M2c's words: *The assistant is clicking “Raise”*). */
  /** A bar between steps, by tab: taken down after BAR_IDLE_MS with no next step. */
  private readonly barIdle = new Map<NodeId, ReturnType<typeof setTimeout>>();

  private barFor(nodeId: NodeId, text: string | null, owner?: string): void {
    // Only its own bars are cleared (never an agent's); off the list first, so a closed tab's never keeps the bars in
    // step for nothing (Claude's S2, round 2).
    if (!text && !this.bars.has(nodeId)) return;
    // Another chat's bar there now is left up (Neon's N4, round 3): only the chat that put it up takes it down.
    if (!text && owner !== undefined && this.bars.get(nodeId) !== owner) return;
    if (!text) {
      this.bars.delete(nodeId);
      clearTimeout(this.barIdle.get(nodeId));
      this.barIdle.delete(nodeId);
    }
    const node = nodeOf(this.browser.store.state, nodeId);
    if (node?.kind === 'tab' && text) this.bars.set(nodeId, owner ?? '');
    this.browser.assistantBars = this.bars.size > 0;
    if (node?.kind !== 'tab') return;
    const agent = text ? { state: 'working' as const, name: 'The assistant', chordId: node.chordId, doing: text } : null;
    this.browser.store.dispatch({ t: 'tab.live', nodeId, live: { agent } });
  }

  /** The tab on screen: an agent's tab the window shows over its chord's (S18), else the chord's own. */
  private activeTab(windowId: WindowId): TabNode | null {
    const model = this.browser.store.state.windows[windowId];
    const id = model ? (model.agentTab ?? model.activeTab[model.activeChordId]) : null;
    const node = id ? nodeOf(this.browser.store.state, id) : undefined;
    return node?.kind === 'tab' ? node : null;
  }

  /** The outside agent whose tab this is, by name (an Agent chord's), or null for a tab of yours. */
  private agentOf(node: TabNode): string | null {
    return this.browser.store.state.chords[node.chordId]?.agent?.name ?? null;
  }

  private readable(node: TabNode): boolean {
    return !this.isPrivateChord(node.chordId) && !this.settings.offChords.includes(node.chordId) && !isNeverReadable(node.url, this.settings.neverSites);
  }

  /** What the window's panel shows: its chord's chat's scope, or a new chat's. */
  private scopeFor(windowId: WindowId): AssistantScope {
    const chordId = this.chordOf(windowId);
    const key = chordId ? this.showing.get(chordId) : undefined;
    return (key ? this.threads.get(key)?.thread?.scope : undefined) ?? this.settings.scope;
  }

  /**
   * The chips above the composer: the tab on screen (unless removed, or the
   * chat's scope attaches nothing for you), then anything added. None at all
   * when the assistant reads nothing.
   */
  private attachments(windowId: WindowId): TabNode[] {
    if (this.settings.readsNothing) return [];
    const panel = this.panel(windowId);
    const out: TabNode[] = [];
    const current = this.activeTab(windowId);
    if (current && attachesTabOnScreen(this.scopeFor(windowId)) && panel.removedCurrent !== current.id && this.readable(current)) out.push(current);
    for (const id of panel.extra) {
      const node = nodeOf(this.browser.store.state, id);
      if (node?.kind === 'tab' && !out.includes(node) && this.readable(node)) out.push(node);
    }
    return out;
  }

  async view(windowId: WindowId, full = false): Promise<AssistantView> {
    const chordId = this.chordOf(windowId);
    const settings = this.settings;
    const privateWindow = chordId ? this.isPrivateChord(chordId) : false;
    const base = {
      enabled: settings.enabled && !privateWindow,
      open: this.panel(windowId).open,
      provider: settings.provider,
      providers: ASSISTANT_PROVIDERS.map((p) => this.statuses[p] ?? notInstalled(p)),
      chordOff: chordId ? settings.offChords.includes(chordId) : false,
      readsNothing: settings.readsNothing,
      codexImages: this.codexMakesImages(),
      firstUse: !this.firstUseSeen,
      lookingInWsl: this.lookingInWsl,
      acting: this.acting(),
    };
    if (!chordId || privateWindow)
      return { ...base, thread: null, continueFrom: null, threads: [], messages: [], busy: false, startedAt: null, queue: [], attachments: [], attachable: [], readTabIds: [], error: null, draft: '', context: null, pendingImages: [], imageThumbs: {}, tabNames: {} };
    const state = await this.stateFor(chordId);
    const store = this.browser.store.state;
    const attachable = settings.readsNothing
      ? []
      : children(this.browser.store.state, chordId, 'pinned', null)
      .concat(children(this.browser.store.state, chordId, 'today', null))
      .filter((n): n is TabNode => n.kind === 'tab' && this.readable(n))
      .map((n) => ({ nodeId: n.id, title: n.title || n.url, url: n.url }))
      // Agents' tabs (S18 M2e-1): attaching one is how you point the assistant at it, named with its agent.
      .concat(
        agentChords(store).flatMap((c) =>
          nodesOfChord(store, c.id)
            .filter((n): n is TabNode => n.kind === 'tab' && this.readable(n))
            .map((n) => ({ nodeId: n.id, title: `${c.agent?.name ?? 'Agent'} · ${n.title || n.url}`, url: n.url })),
        ),
      );
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
      readTabIds: [...state.read].filter((id) => nodeOf(store, id)),
      error: state.lastError,
      draft: this.drafts[state.thread?.id ?? `fresh:${chordId}`] ?? '',
      context: state.context,
      pendingImages: (this.pending.get(windowId) ?? []).map((p) => ({ id: p.image.id })),
      imageThumbs: await this.thumbsFor(windowId, state, full),
      tabNames: this.tabNames(state),
    };
  }

  /** The chat's tabs by handle: open ones by their current title, closed ones as they were attached or cited. */
  private tabNames(state: ThreadState): Record<string, AssistantTabName> {
    const names: Record<string, AssistantTabName> = {};
    for (const m of state.messages) {
      if (m.body.role === 'user') for (const a of m.body.attachments) names[a.ref] = { title: a.title, url: a.url };
      else if (m.body.role === 'assistant') for (const c of m.body.citations) if (c.url) names[c.ref] = { title: c.title || c.url, url: c.url };
    }
    const current = this.browser.store.state;
    for (const [ref, id] of state.refs.entries()) {
      const node = nodeOf(current, id);
      if (node?.kind === 'tab') names[ref] = { title: node.title || node.url, url: node.url };
    }
    return names;
  }

  /** Thumbnails for the chat's images and the composer's that this window hasn't been sent (all of them for a full view). */
  private async thumbsFor(windowId: WindowId, state: ThreadState, full: boolean): Promise<Record<string, string>> {
    let sent = this.thumbsSent.get(windowId);
    if (!sent || full) this.thumbsSent.set(windowId, (sent = new Set()));
    const out: Record<string, string> = {};
    for (const p of this.pending.get(windowId) ?? []) {
      if (sent.has(p.image.id)) continue;
      out[p.image.id] = `data:image/jpeg;base64,${p.thumb.toString('base64')}`;
      sent.add(p.image.id);
    }
    for (const m of state.messages) {
      if (m.body.role !== 'user') continue;
      for (const image of m.body.images ?? []) {
        if (sent.has(image.id)) continue;
        let url = this.thumbs.get(image.id);
        if (!url) {
          const thumb = await this.images.thumb(image.id);
          if (!thumb) continue;
          url = `data:image/jpeg;base64,${thumb.toString('base64')}`;
          this.thumbs.set(image.id, url);
        }
        out[image.id] = url;
        sent.add(image.id);
      }
    }
    return out;
  }

  /* ---------- Images (a pasted image, a screenshot) ---------- */

  /**
   * An image Codex made: written to the chat's images, then shown with the reply. Codex's base64 is
   * decoded here (one string per image); its size comes from the file's header, never by decoding it.
   */
  private keepMadeImage(state: ThreadState, made: MadeImage | null): void {
    const streaming = state.streaming;
    if (streaming?.body.role !== 'assistant') return;
    streaming.body = { ...streaming.body, making: Math.max(0, (streaming.body.making ?? 1) - 1) };
    const bytes = made ? Buffer.from(made.data, 'base64') : null;
    const info = bytes ? imageInfo(bytes) : null;
    if (!made || !bytes || !info) return this.schedulePush();
    const image: AssistantImage = { id: newImageId(), ...info, ...(made.prompt ? { prompt: made.prompt.slice(0, 1000) } : {}), ...(made.savedPath ? { codexCopy: made.savedPath } : {}) };
    const saving = this.images.save(image, bytes).then(() => {
      if (streaming.body.role === 'assistant') streaming.body = { ...streaming.body, images: [...(streaming.body.images ?? []), image] };
      this.schedulePush();
    });
    state.saving.add(saving);
    void saving.catch(() => undefined).finally(() => state.saving.delete(saving));
  }

  /** `chord://shell/assistant-image/<id>.<ext>`: a chat's image, from disk, for the panel. */
  async serveImage(url: string): Promise<Response> {
    const file = this.images.file(url.slice(url.lastIndexOf('/') + 1));
    const response = file ? await net.fetch(pathToFileURL(file.path).toString()).catch(() => null) : null;
    if (!file || !response?.ok) return new Response('Not found', { status: 404 });
    return new Response(response.body, { headers: { 'content-type': file.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' } });
  }

  /** Copy an image in the chat, or save it to Downloads. */
  private async imageAction(windowId: WindowId, state: ThreadState, id: string, what: 'copy' | 'save'): Promise<void> {
    const image = state.messages.flatMap((m) => (m.body.role === 'user' || m.body.role === 'assistant' ? (m.body.images ?? []) : [])).find((i) => i.id === id);
    const bytes = image ? await this.images.read(image) : null;
    if (!image || !bytes) return;
    if (what === 'save') {
      await this.files?.save(screenshotFilename(new Date(), image.prompt ? 'Generated image' : 'Image', image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice(6)), bytes, image.mime);
      this.toast(windowId, { id: 'assistant-image', message: 'Image saved to Downloads' });
      return;
    }
    // The clipboard takes images as PNG: a JPEG or WebP is turned into one (on asking, not as it arrives).
    const png = image.mime === 'image/png' ? bytes : nativeImage.createFromBuffer(bytes).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    this.toast(windowId, { id: 'assistant-image', message: 'Image copied' });
  }

  private toast(windowId: WindowId, toast: Toast): void {
    const shell = this.browser.window(windowId)?.shell.webContents;
    if (shell) send(shell, 'toast:show', toast);
  }

  /** Codex can make images: allowed in Settings → Assistant, installed, signed in and new enough. */
  private codexMakesImages(): boolean {
    const codex = this.statuses.codex;
    return Boolean(this.settings.codexImages && codex?.installed && codex.signedIn && !codex.tooOld);
  }

  /** Whether a picture of this page may go to the assistant from this window: set up, on in its chord, and a page the assistant may read. */
  canAskAbout(windowId: WindowId, url: string): boolean {
    const chordId = this.chordOf(windowId);
    return Boolean(
      this.settings.enabled &&
        !this.settings.readsNothing &&
        this.settings.provider &&
        chordId &&
        !this.isPrivateChord(chordId) &&
        !this.settings.offChords.includes(chordId) &&
        !isNeverReadable(url, this.settings.neverSites),
    );
  }

  /**
   * Effects asking the assistant (main/effects): whether the assistant may read this page from this
   * window (canAskAbout's rules) with a provider that's installed, and its name.
   */
  effectsProvider(windowId: WindowId, url: string): { provider: string } | null {
    const provider = this.settings.provider;
    if (!provider || !this.canAskAbout(windowId, url)) return null;
    const status = this.statuses[provider];
    if (status && (!status.installed || status.signedIn === false)) return null;
    return { provider: provider === 'claude' ? 'Claude Code' : 'Codex' };
  }

  /**
   * One request with no chat (Effects' patches): the user's own CLI with
   * The assistant's browse-mode flags, Effects' instructions and one read-only tool, in
   * a session of its own that's closed when the answer is in. Nothing is kept:
   * not a thread, not the instructions file, and the provider's own copy of the
   * session is deleted after, as Delete does for a chat.
   */
  async oneShot(request: {
    instructions: string;
    text: string;
    tool: AssistantToolSpec;
    onTool(): Promise<string>;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const provider = this.settings.provider;
    if (!provider) return { ok: false, error: 'Choose an app first, in Settings → Assistant.' };
    if (this.settings.readsNothing) return { ok: false, error: 'The assistant is set to read nothing, in Settings → Assistant.' };
    const name = provider === 'claude' ? 'Claude Code' : 'Codex';
    if (!this.statuses[provider]) await this.refreshProviders('never');
    if (!this.statuses[provider]?.installed && this.wslLookup) await this.wslLookup;
    const launch = this.launches[provider];
    if (!this.statuses[provider]?.installed || !launch) return { ok: false, error: `${name} isn't installed. Settings → Assistant shows how to set it up.` };
    if (request.signal.aborted) return { ok: false, error: 'Stopped.' };
    const id = randomUUID();
    const instructionsFile = join(this.root, 'instructions', `effects-${id}.md`);
    await mkdir(join(this.root, 'instructions'), { recursive: true });
    await writeFile(instructionsFile, request.instructions, { encoding: 'utf8', mode: 0o600 });
    return new Promise((resolve) => {
      let text = '';
      let sessionId: string | null = null;
      let settled = false;
      let session: AssistantSession | null = null;
      const finish = (outcome: { ok: true; text: string } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', stop);
        session?.close();
        void rm(instructionsFile, { force: true }).catch(() => undefined);
        if (sessionId) void this.deleteProviderCopy({ provider, providerSessionId: sessionId } as AssistantThread).catch(() => undefined);
        resolve(outcome);
      };
      const stop = () => finish({ ok: false, error: 'Stopped.' });
      const timer = setTimeout(() => finish({ ok: false, error: `${name} took too long to answer. Try again.` }), request.timeoutMs);
      timer.unref?.();
      request.signal.addEventListener('abort', stop);
      const options = {
        launch,
        cwd: join(this.root, 'empty'),
        model: this.settings.model,
        instructions: request.instructions,
        instructionsFile,
        resumeId: null,
        newSessionId: id,
        tools: [request.tool],
        images: false,
      };
      const events = {
        onSessionId: (sid: string) => {
          sessionId = sid;
        },
        onText: (delta: string) => {
          text += delta;
          if (text.length > 100_000) finish({ ok: false, error: `${name}'s answer was too long.` });
        },
        onTool: async (tool: string): Promise<ToolOutput> =>
          tool === request.tool.name ? { text: await request.onTool() } : { text: toolResult({ error: `Unknown tool ${tool}` }, false), isError: true },
        onTurnEnd: (outcome: { status: 'done' | 'interrupted' | 'error'; error?: ProviderError }) =>
          finish(outcome.status === 'done' ? { ok: true, text } : { ok: false, error: outcome.error?.message ?? 'Stopped.' }),
        onExit: (error: ProviderError | null) => finish({ ok: false, error: error?.message ?? `${name} stopped before it answered.` }),
      };
      session = provider === 'claude' ? new ClaudeSession(options, events) : new CodexSession(options, events);
      session.send(request.text);
    });
  }

  /** Put an image in the window's composer, for the next message, and open the panel. */
  attachImage(windowId: WindowId, image: ImageInput): void {
    const w = this.browser.allWindows.find((x) => x.id === windowId);
    if (!w || w.isPrivate || this.settings.readsNothing) return;
    const list = this.pending.get(windowId) ?? [];
    if (list.length >= ASSISTANT_MAX_IMAGES) list.shift();
    list.push({ image: { id: newImageId(), mime: image.mime, width: image.width, height: image.height }, bytes: Buffer.from(image.bytes), thumb: Buffer.from(image.thumb) });
    this.pending.set(windowId, list);
    const panel = this.panel(windowId);
    if (!panel.open) this.toggled.add(windowId);
    panel.open = true;
    this.schedulePush();
  }

  /** "Ask about this image": the panel opens and the message goes, with the words you typed or a plain question. */
  async askAboutImage(windowId: WindowId, text: string, image: ImageInput): Promise<void> {
    this.attachImage(windowId, image);
    if (!this.pending.get(windowId)?.length) return;
    await this.act(windowId, { do: 'send', text: text.trim() || 'What is in this image?' });
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
      // Opening or closing the panel slides it while the page's frame narrows or widens by its snapshot
      // (DESIGN.md §6.5); a panel restored at launch, or the assistant turned off, just changes.
      const animate = this.toggled.delete(w.id) && this.browser.animates('sidebar');
      w.setAssistant(view.enabled && view.open ? this.browser.assistantWidth : 0, () => send(w.shell.webContents, 'assistant:state', view), animate);
    }
  }

  /* ---------- Actions from the panel ---------- */

  async act(windowId: WindowId, action: AssistantAction): Promise<void> {
    const chordId = this.chordOf(windowId);
    switch (action.do) {
      case 'toggle': {
        const panel = this.panel(windowId);
        const open = action.open ?? !panel.open;
        if (open !== panel.open) this.toggled.add(windowId);
        panel.open = open;
        // The panel closed: acting from its window stops, its cards with it (E6; Neon's B4, round 2).
        if (!open) for (const state of this.threads.values()) if (state.actTab?.windowId === windowId || state.windowId === windowId) this.leaveChat(state);
        if (panel.open) void this.refreshProviders('if-needed');
        break;
      }
      case 'unattachImage': {
        const list = this.pending.get(windowId) ?? [];
        this.pending.set(windowId, list.filter((p) => p.image.id !== action.id));
        break;
      }
      case 'dismissFirstUse':
        this.firstUseSeen = true;
        void this.savePanel();
        break;
      case 'setup':
        this.browser.store.dispatch({ t: 'settings.set', settings: { assistant: { provider: action.provider } } });
        break;
      case 'chordOff':
        if (chordId) {
          const off = new Set(this.settings.offChords);
          if (action.off) off.add(chordId);
          else off.delete(chordId);
          this.browser.store.dispatch({ t: 'settings.set', settings: { assistant: { offChords: [...off] } } });
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

  private async threadAction(windowId: WindowId, chordId: string, action: AssistantAction): Promise<void> {
    const state = await this.stateFor(chordId);
    const panel = this.panel(windowId);
    switch (action.do) {
      case 'send':
        return this.send(windowId, state, action.text);
      case 'stop':
        state.queue = [];
        state.queuedWith = [];
        state.queuedTab = [];
        this.endActing(state, null);
        // Through the gate: a tool call in flight answers at once, and its card goes. The next message lets it go on.
        state.control.stop();
        if (state.thread) this.live.get(state.thread.id)?.session.stop();
        return;
      case 'reuseImages': {
        const message = state.messages.find((m) => m.id === action.messageId);
        if (message?.body.role !== 'user' || !message.body.images?.length) return;
        // The same files: sending again writes the same bytes, and taking one out of the composer deletes nothing.
        const list: PendingImage[] = [];
        for (const image of message.body.images) {
          const [bytes, thumb] = await Promise.all([this.images.read(image), this.images.thumb(image.id)]);
          if (bytes && thumb) list.push({ image, bytes, thumb });
        }
        this.pending.set(windowId, list);
        return;
      }
      case 'retry': {
        const lastUser = [...state.messages].reverse().find((m) => m.body.role === 'user');
        // Its own tab, as it was sent (Claude's S8 on #147): never the one on screen now.
        if (lastUser?.body.role === 'user') return this.send(windowId, state, lastUser.body.text, lastUser.body.attachments, lastUser.body.images ?? [], state.sentTabs.get(lastUser.id) ?? null);
        return;
      }
      case 'unqueue':
        state.queue.splice(action.index, 1);
        state.queuedWith.splice(action.index, 1);
        state.queuedTab.splice(action.index, 1);
        return;
      case 'showStep':
        state.shows.get(action.messageId)?.();
        return;
      case 'approve': {
        const resolve = state.pending.get(action.messageId);
        state.pending.delete(action.messageId);
        resolve?.(action.decision);
        return;
      }
      case 'new':
        this.leaveChat(state, true);
        this.close(state);
        this.continueFrom.set(chordId, state.thread ? { id: state.thread.id, title: state.thread.title } : (this.continueFrom.get(chordId) ?? null));
        this.fresh(chordId);
        return;
      case 'open':
        this.leaveChat(state, true);
        await this.load(action.threadId, chordId);
        return;
      case 'continue': {
        this.leaveChat(state, true);
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
          this.browser.store.dispatch({ t: 'settings.set', settings: { assistant: { scope: action.scope } } });
        }
        return;
      case 'model':
        return this.setModel(state, action.provider, action.model);
      case 'attach':
        if (this.settings.readsNothing) return;
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
      case 'image':
        return this.imageAction(windowId, state, action.id, action.what);
      case 'makeWithCodex': {
        // Claude said it can't make the image: the chat goes on with Codex, which is asked again.
        const lastUser = [...state.messages].reverse().find((m) => m.body.role === 'user');
        if (lastUser?.body.role !== 'user' || !this.codexMakesImages() || state.streaming) return;
        await this.setModel(state, 'codex', null);
        return this.send(windowId, state, lastUser.body.text, lastUser.body.attachments, lastUser.body.images ?? [], state.sentTabs.get(lastUser.id) ?? null);
      }
      case 'showTab': {
        const node = nodeOf(this.browser.store.state, state.refs.get(action.ref) ?? '');
        if (node?.kind === 'tab') this.browser.store.dispatch({ t: 'tab.activate', windowId, nodeId: node.id });
        else {
          // Only a web page: a chat can come from a file, and a file can say anything.
          const url = this.tabNames(state)[action.ref]?.url;
          if (url && WEB_PAGE.test(url)) this.browser.store.dispatch({ t: 'tab.open', windowId, url });
        }
        return;
      }
      case 'export':
        return this.exportThread(state);
      case 'settings':
        return this.browser.openSettings('assistant');
      case 'fill':
        return this.fill(windowId, state, action.messageId, action.fields);
      case 'dismissFill': {
        const message = state.messages.find((m) => m.id === action.messageId);
        if (message?.body.role === 'tool' && message.body.fill?.status === 'pending') await this.endFill(state, message, 'dismissed');
        return;
      }
    }
  }

  private async setModel(state: ThreadState, provider: AssistantProvider, model: string | null): Promise<void> {
    this.leaveChat(state, true);
    if (!state.thread) {
      this.browser.store.dispatch({ t: 'settings.set', settings: { assistant: { provider, model } } });
      return;
    }
    const switched = state.thread.provider !== provider;
    state.thread.provider = provider;
    state.thread.model = model;
    state.context = null;
    if (switched) {
      // A different provider can't resume the other's session: its new one gets the chat's newest turns with the next message.
      this.close(state);
      state.thread.providerSessionId = null;
      state.pendingDivider = `Switched to ${provider === 'claude' ? 'Claude Code' : 'Codex'}`;
    } else {
      this.close(state);
    }
    await this.saveThread(state.thread);
  }

  /* ---------- Sending and sessions ---------- */

  private async send(windowId: WindowId, state: ThreadState, text: string, reuse?: AssistantAttachment[], reuseImages?: readonly AssistantImage[], tab?: DuetChat['actTab']): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.settings.offChords.includes(state.chordId)) return;
    if (state.streaming) {
      // Follow-ups wait their turn instead of being refused (they show as queued), with what was attached as they were
      // sent: a tab you look at while they wait (an agent's) is never theirs (S18 M2e-1).
      state.queue.push(trimmed);
      state.queuedWith.push(reuse ?? (this.settings.readsNothing ? [] : this.attachments(windowId).map((node) => ({ ref: state.refs.refFor(node.id), url: node.url, title: node.title || node.url }))));
      state.queuedTab.push(this.acting() ? (tab !== undefined ? tab : this.tabOnScreen(windowId)) : null);
      return;
    }
    // A new message lets the chat go on after Stop (the gate refused its tools until now).
    state.control.resume();
    const provider = state.thread?.provider ?? this.settings.provider;
    if (!provider) return;
    const now = Date.now();
    if (!state.thread) {
      const thread: AssistantThread = {
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
    // The message's tab (S18 M2e-2a, A1): the tab on screen as it was sent (a queued one's, when it was queued).
    // Only for the chat its window's panel shows, open (Neon's B2, round 3): a message that went on elsewhere acts nowhere.
    const here = this.panel(windowId).open && this.shown(state.chordId) === state;
    state.actTab = this.acting() && here ? (tab !== undefined ? tab : this.tabOnScreen(windowId)) : null;
    state.actEnded = null;
    state.stopUnsaid = false;
    this.acted.delete(state);

    const nothing = this.settings.readsNothing;
    const attachments: AssistantAttachment[] = nothing ? [] : (reuse ?? this.attachments(windowId).map((node) => ({ ref: state.refs.refFor(node.id), url: node.url, title: node.title || node.url })));
    // What this message points at: an agent's tab is read only while a message of yours points at it (S18 M2e-1).
    state.pointed = new Set();
    for (const a of attachments) {
      const node = state.refs.get(a.ref);
      if (node) {
        state.attached.add(node);
        state.pointed.add(node);
      }
    }

    if (state.pendingDivider) {
      await this.addMessage(state, { role: 'divider', text: state.pendingDivider });
      state.pendingDivider = null;
    }
    // The composer's images go with this message, kept with the chat; a retry sends its own again.
    const pending = reuseImages || nothing ? [] : (this.pending.get(windowId) ?? []);
    this.pending.delete(windowId);
    for (const p of pending) await this.images.save(p.image, p.bytes, p.thumb);
    const images = nothing ? [] : (reuseImages ?? pending.map((p) => p.image));
    // What's in an image came from elsewhere (Neon's B3 on #151).
    if (images.length > 0) state.elsewhere = true;
    const sent = await this.addMessage(state, images.length > 0 ? { role: 'user', text: trimmed, attachments, images: [...images] } : { role: 'user', text: trimmed, attachments });
    state.sentTabs.set(sent.id, state.actTab);
    delete this.drafts[thread.id];
    thread.lastUsedAt = now;
    thread.updatedAt = now;
    await this.saveThread(thread);
    void this.refreshRecent(state.chordId);

    state.streaming = { id: uuidv7(), threadId: thread.id, createdAt: Date.now(), body: { role: 'assistant', text: '', citations: [], status: 'streaming' } };
    state.startedAt = Date.now();
    this.schedulePush();
    // A session that hasn't seen this chat (the other provider's after a switch, or a chat from a file):
    // its earlier turns go first, as untrusted data, never in the instructions (S15 §5).
    const unseen = !thread.providerSessionId && !this.live.get(thread.id)?.session.alive;
    const session = await this.sessionFor(state);
    if (!session) {
      await this.finishTurn(state, { status: 'error', error: state.lastError ?? { kind: 'other', message: "Couldn't start. Check Settings → Assistant." } });
      return;
    }
    const earlier = unseen ? earlierTurns(state.messages.filter((m) => m !== sent)) : '';
    const toSend = await this.imagesToSend(images, pending);
    // Its tab may have left the screen while the message was saved and its session started (Neon's S4, round 2).
    this.screenChanged();
    session.send(earlier + userTurnText(trimmed, attachments), toSend);
  }

  /** The message's images for the model, base64-encoded: from the composer, or from disk for a retry. */
  private async imagesToSend(images: readonly AssistantImage[], pending: readonly PendingImage[]): Promise<SessionImage[]> {
    const out: SessionImage[] = [];
    for (const image of images) {
      const bytes = pending.find((p) => p.image.id === image.id)?.bytes ?? (await this.images.read(image));
      if (bytes) out.push({ mime: image.mime, data: bytes.toString('base64') });
    }
    return out;
  }

  private async sessionFor(state: ThreadState): Promise<AssistantSession | null> {
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
      state.lastError = { kind: 'other', message: `${thread.provider === 'claude' ? 'Claude Code' : 'Codex'} isn't installed. Settings → Assistant shows how to set it up.` };
      return null;
    }
    // At most a few CLI processes: the least recently used idle one makes room.
    if (this.live.size >= ASSISTANT_MAX_PROCESSES) {
      const idle = [...this.live.entries()].filter(([, l]) => !l.session.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (idle) this.drop(idle[0]);
    }
    const images = thread.provider === 'codex' && this.settings.codexImages;
    const making: AssistantImageMaking = thread.provider === 'codex' ? (images ? 'codex' : 'codex-off') : 'claude';
    // Settings' "Nothing": no tools at all, so the model has no way to ask for a page (ARCHITECTURE.md §11.3).
    const readsPages = !this.settings.readsNothing;
    const instructions = assistantInstructions(making, readsPages, this.acting(), goOutline());
    const instructionsFile = join(this.root, 'instructions', `${thread.id}.md`);
    await writeFile(instructionsFile, instructions, { encoding: 'utf8', mode: 0o600 });
    const resumeId = thread.providerSessionId;
    const options = {
      launch,
      cwd: join(this.root, 'empty'),
      model: thread.model,
      instructions,
      instructionsFile,
      resumeId,
      newSessionId: randomUUID(),
      tools: readsPages ? this.tools() : [],
      images,
    };
    let resumeFailed = false;
    /** A tool ran since the reply's last text: its next text is a new paragraph. */
    let afterTool = false;
    const events = {
      onSessionId: (id: string) => {
        if (thread.providerSessionId !== id) {
          thread.providerSessionId = id;
          void this.saveThread(thread);
        }
      },
      onText: (delta: string) => {
        if (!state.streaming || state.streaming.body.role !== 'assistant') return;
        // After a tool call, a new paragraph (the owner's card-game run: never "to act.Only Arthur called").
        const next = nextReplyText(state.streaming.body.text, delta, afterTool);
        afterTool = next.newBlock;
        state.streaming.body = { ...state.streaming.body, text: next.text };
        this.schedulePush();
      },
      onTool: (name: string, args: Record<string, unknown>) => {
        afterTool = true;
        return this.runTool(state, name, args);
      },
      onUsage: (usage: AssistantContextUsage) => {
        state.context = usage;
        this.schedulePush();
      },
      onImageStart: () => {
        if (state.streaming?.body.role !== 'assistant') return;
        state.streaming.body = { ...state.streaming.body, making: (state.streaming.body.making ?? 0) + 1 };
        this.schedulePush();
      },
      onImage: (_callId: string, made: MadeImage | null) => this.keepMadeImage(state, made),
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

  /** The stored session is gone (deleted, CLI upgraded, other provider): start again, with the chat's newest turns as data. */
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
      const divider: AssistantMessage = { id: uuidv7(), threadId: thread.id, createdAt: lastUser.createdAt - 1, body: { role: 'divider', text: 'Continued with a summary' } };
      state.messages.splice(index, 0, divider);
      await this.persistence.assistant({ op: 'saveMessage', message: divider }).catch(() => undefined);
    }
    // A chat's turns never go in the instructions: they go with the message, as untrusted data. A file can say anything,
    // and the assistant's own replies can carry what pages said (S15 §5).
    const session = await this.sessionFor(state);
    if (session && lastUser?.body.role === 'user') session.send(earlierTurns(earlier) + userTurnText(lastUser.body.text, lastUser.body.attachments), await this.imagesToSend(lastUser.body.images ?? [], []));
    else if (!session) await this.finishTurn(state, { status: 'error', error: state.lastError ?? { kind: 'other', message: "Couldn't start." } });
  }

  private touch(threadId: string, live: Live): void {
    live.lastUsed = Date.now();
    clearTimeout(live.idle);
    live.idle = setTimeout(() => {
      if (!live.session.busy) this.drop(threadId);
    }, ASSISTANT_PROCESS_IDLE_MS);
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
    this.leaveChat(state, true);
    if (state.thread) this.drop(state.thread.id);
  }

  private async finishTurn(state: ThreadState, outcome: { status: 'done' | 'interrupted' | 'error'; error?: ProviderError }): Promise<void> {
    // An image Codex made a moment ago is kept with the reply once it's written.
    if (state.saving.size) await Promise.all(state.saving);
    const streaming = state.streaming;
    if (!streaming || streaming.body.role !== 'assistant') return;
    state.streaming = null;
    // The turn's over: no acting until the next message (the lease's own tail still ends what the last action sent).
    state.actTab = null;
    // Its bars come down with it (they stayed on between its steps).
    for (const [nodeId, owner] of [...this.bars]) {
      if (owner !== state.control.id) continue;
      clearTimeout(this.barIdle.get(nodeId));
      this.barIdle.delete(nodeId);
      this.barFor(nodeId, null, owner);
    }
    state.startedAt = null;
    // Cards still waiting go with the turn, each answered no.
    // A tab of yours's lease asks on its own after the turn (what the page still sends, a download its click started:
    // M2e-2b): those cards stay until answered, or the lease ends.
    state.control.cancelCards(outlivesTurn);
    const text = streaming.body.text;
    const citations: AssistantCitation[] = [];
    for (const seg of splitCitations(text)) {
      if (seg.kind !== 'citation' || citations.some((c) => c.n === seg.n)) continue;
      const nodeId = state.refs.get(seg.ref) ?? null;
      const node = nodeId ? nodeOf(this.browser.store.state, nodeId) : undefined;
      // A PDF's page comes from the text the assistant read, not from the model.
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
    const images = streaming.body.images ?? [];
    const body: AssistantMessageBody = { role: 'assistant', text, citations, status: outcome.status, ...(outcome.error ? { error: outcome.error.message } : {}), ...(images.length ? { images } : {}) };
    if (outcome.status === 'error') state.lastError = outcome.error ?? null;
    if (text.trim() || images.length || outcome.status !== 'done') {
      const message = { ...streaming, body };
      state.messages.push(message);
      await this.persistence.assistant({ op: 'saveMessage', message }).catch(() => undefined);
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
    const with_ = state.queuedWith.shift();
    const tab = state.queuedTab.shift() ?? null;
    if (next && state.windowId && outcome.status !== 'error') void this.send(state.windowId, state, next, with_, undefined, tab);
  }

  private async addMessage(state: ThreadState, body: AssistantMessageBody): Promise<AssistantMessage> {
    const message: AssistantMessage = { id: uuidv7(), threadId: state.thread!.id, createdAt: Date.now(), body };
    state.messages.push(message);
    await this.persistence.assistant({ op: 'saveMessage', message: saved(message) }).catch(() => undefined);
    this.schedulePush();
    return message;
  }

  private async updateMessage(message: AssistantMessage, body: AssistantMessageBody): Promise<void> {
    message.body = body;
    await this.persistence.assistant({ op: 'saveMessage', message: saved(message) }).catch(() => undefined);
    this.schedulePush();
  }

  private async saveThread(thread: AssistantThread): Promise<void> {
    await this.persistence.assistant({ op: 'saveThread', thread }).catch(() => undefined);
  }

  private async refreshRecent(chordId: string): Promise<void> {
    const result = await this.persistence.assistant({ op: 'threads', chordId, limit: THREADS_IN_MENU }).catch(() => ({ threads: [] as AssistantThread[] }));
    this.recent.set(chordId, (result.threads ?? []).map((t) => ({ id: t.id, title: t.title, lastUsedAt: t.lastUsedAt })));
    this.schedulePush();
  }

  /* ---------- Tools: the shared control layer (main/control/), with this chat as its agent ---------- */

  /** The acting host for a chat (S18 M2e-2a): what assistant/scope.ts asks before and during each action. */
  private actingHost(s: ThreadState): ReturnType<NonNullable<DuetHost['acting']>> {
    return {
      on: () => this.acting(),
      offScreen: (node, windowId) => this.offScreen({ nodeId: node.id, windowId }),
      latched: (why) => {
        if (why === USER_TAB_REFUSALS.tookOver && s.stopUnsaid) this.sayStopped(s);
      },
      siteOf: siteOfUrl,
      siteAllowed: (site) => this.settings.actSites.includes(site),
      keepSite: (site) => this.browser.store.dispatch({ t: 'settings.set', settings: { assistant: { actSites: [...this.settings.actSites, site] } } }),
      // The bar stays on from the first step until the turn ends, Stop, your taking the tab or a long idle; between
      // steps it says it's working (the owner, 2026-11-24: never on and off with each step).
      doing: (nodeId, doing) => {
        clearTimeout(this.barIdle.get(nodeId));
        this.barIdle.delete(nodeId);
        if (doing) {
          this.acted.add(s);
          return this.barFor(nodeId, barDoing(doing), s.control.id);
        }
        // Acting over for the message (Stop, your hands, a switch, the panel closed: Neon's S3 on #150): no bar again.
        if (s.actEnded || !s.streaming || s.control.isStopped || s.actTab?.nodeId !== nodeId) return this.barFor(nodeId, null, s.control.id);
        this.barFor(nodeId, BAR_BETWEEN, s.control.id);
        const idle = setTimeout(() => {
          this.barIdle.delete(nodeId);
          this.barFor(nodeId, null, s.control.id);
        }, BAR_IDLE_MS);
        idle.unref?.();
        this.barIdle.set(nodeId, idle);
      },
      // What the lease caught there since the last result, for the next one (Claude's S1, round 2 of #150).
      caught: (node) => {
        const caught = s.caught.get(node.id) ?? [];
        s.caught.delete(node.id);
        return caught;
      },
      lease: {
        begin: async (node) => {
          const contents = this.browser.tabs.get(node.id)?.webContents;
          if (!contents || contents.isDestroyed()) return 'That tab could not be loaded.';
          const action = await beginUserAction(contents, s.control.id, {
            siteOf: originOf,
            ask: this.tailCard(s, node.id, contents),
            kept: this.sendGrantsFor(s, node.id),
            // What its click set off, caught in the moment after (M2e-2b, A6): a muted row each.
            note: (what, detail) => {
              const said = USER_TAB_NOTES[what](plainNote(detail));
              // In the chat, and in the next result there, so the model never says done when the page said no.
              const caught = s.caught.get(node.id) ?? [];
              if (caught.length < CAUGHT_MAX) s.caught.set(node.id, [...caught, said]);
              if (s.thread) void this.activity(s, 'act', said, contents.isDestroyed() ? '' : contents.getURL(), false);
            },
            askDownload: async (download, signal) => {
              if (contents.isDestroyed()) return false;
              const takeDown = new AbortController();
              signal.addEventListener('abort', () => takeDown.abort(), { once: true });
              const answer = await s.control.ask(
                {
                  kind: 'step',
                  tool: 'act',
                  description: 'start a download',
                  target: [contents.getURL()],
                  tab: node.id,
                  subject: `${node.id}|download|${randomBytes(4).toString('hex')}`,
                  // Its own site, where its redirects end, never the page's (Neon's B5 on #150); its name already made safe.
                  step: { why: 'confirm', ...downloadShown(download, contents.getURL()), fields: [], more: 0 },
                  takeDown: takeDown.signal,
                },
                signal,
                CONTROL_WAIT_MS,
              );
              if (answer === 'waiting') takeDown.abort();
              return answer === 'once';
            },
            clipboard: electronClipboard,
            siteOfPage: siteOfUrl,
          });
          const begun = action.begun;
          if (begun === 'busy') return 'Another chat is acting in this tab. Wait for it to finish, or ask the user.';
          // Acting ended, or Stop, while the lease was being had: let go of at once, never tracked (Neon's B2, round 2).
          if (begun === 'on' && (s.actEnded || s.control.isStopped)) {
            endUserLease(contents, s.control.id);
            return s.actEnded ?? 'The user stopped this. Stop, and tell them what you did and what’s left.';
          }
          if (begun === 'no') return s.actEnded ?? 'Chord can’t check this page now (its developer tools may have it). Ask the user to close them, then to ask again.';
          // (Its *Allow for this chat* stays with the chat through a begin that was cancelled: only taking the tab
          // mid-action ends it.)
          s.leased.add(node.id);
          s.actionEnds.set(node.id, [...(s.actionEnds.get(node.id) ?? []), action.end]);
          return null;
        },
        // This action's own end: it does nothing to a lease that came after it (Neon's B3, round 3 of #147).
        end: (node) => s.actionEnds.get(node.id)?.shift()?.(),
        // Where navigate or back goes (M2e-2c): a page there sending the tab on to another site asks.
        going: (node, url) => {
          const contents = this.browser.tabs.get(node.id)?.webContents;
          if (contents && !contents.isDestroyed()) userTabGoing(contents, url);
        },
      },
    };
  }

  /** A tool call from the chat's provider: the control layer answers it, within the chat's scope. */
  private async runTool(state: ThreadState, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    if (!state.thread) return { text: toolResult({ error: `Unknown tool ${name}` }, false), isError: true };
    return runControlTool(this.scopeOf(state), this.browser, name, args);
  }

  /** The chat's ControlScope (assistant/scope.ts), made the first time a tool is called. */
  private scopeOf(state: ThreadState): ControlScope {
    state.scope ??= duetScope(state, {
      browser: this.browser,
      settings: () => this.settings,
      readable: (node) => this.readable(node),
      agentOf: (node) => this.agentOf(node),
      activeTab: (windowId) => this.activeTab(windowId),
      activity: (chat, tool, summary, detail, ok) => this.activity(chat as ThreadState, tool, summary, detail, ok),
      ...(buildActs() ? { acting: (chat: DuetChat) => this.actingHost(chat as ThreadState) } : {}),
      search: (chat, tool, query) => this.searchFor(chat as ThreadState, tool, query),
      fills: (chat) => {
        const s = chat as ThreadState;
        return {
          refuse: () => (s.streaming && s.fillTurn === s.streaming.id ? 'You already showed the user values for this message. Wait for their answer.' : null),
          show: async (node, card, form) => {
            // A newer card takes the place of one still waiting.
            for (const m of s.messages) if (m.body.role === 'tool' && m.body.fill?.status === 'pending') await this.endFill(s, m, 'expired', 'Newer values are below.');
            s.fillTurn = s.streaming?.id ?? null;
            const message = await this.addMessage(s, { role: 'tool', tool: 'propose_fill', summary: `Suggested values for ${fieldCount(card.fields.length)} in “${card.title}”`, detail: card.site, ok: true, fill: card });
            s.fills.set(message.id, { nodeId: node.id, token: form.token, read: form.read });
          },
        };
      },
    }, agentActions({ packaged: app.isPackaged }), goOutline());
    return state.scope;
  }

  /**
   * The gate's card, as the chat shows it: an approval message, kept as a
   * record of the answer. Stop or the turn ending takes it down, as a no.
   */
  private async showCard(state: ThreadState, card: ControlCard, signal: AbortSignal): Promise<'once' | 'always' | 'deny'> {
    const act = actCard(card);
    const message = await this.addMessage(state, { role: 'approval', tool: card.tool, description: act ? act.title : card.description, target: act ? [] : card.target, decision: 'pending', ...(act ? { act } : {}) });
    // Show me (a risky step's): the element outlined in its page, the card still up.
    if (card.show) state.shows.set(message.id, card.show);
    const decision = await new Promise<Decision>((resolve) => {
      if (signal.aborted) return resolve('denied');
      state.pending.set(message.id, resolve);
      signal.addEventListener(
        'abort',
        () => {
          if (state.pending.get(message.id) !== resolve) return;
          state.pending.delete(message.id);
          resolve('denied');
        },
        { once: true },
      );
    });
    state.shows.delete(message.id);
    if (message.body.role === 'approval') await this.updateMessage(message, { ...message.body, decision });
    // An acting card's answers (S18 M2e-2a): a site card's *Allow for this chat* is the gate's once (kept for the chat),
    // its *Always on this site* the gate's always (kept in Settings); a send card's *Allow for this chat* is its
    // *Allow until done* (always: those origins, this tab, the chat's life). A read card's as before.
    if (act) {
      if (decision === 'denied') return 'deny';
      if (act.kind === 'site') return decision === 'always' ? 'always' : 'once';
      if (act.kind === 'send') return decision === 'thread' ? 'always' : 'once';
      return 'once';
    }
    return decision === 'thread' || decision === 'always' ? 'always' : decision === 'once' ? 'once' : 'deny';
  }

  private async activity(state: ThreadState, tool: string, summary: string, detail = '', ok = true): Promise<void> {
    await this.addMessage(state, { role: 'tool', tool, summary, detail, ok });
  }

  /** search_history and search_archive: sites on the Never list stay out of the results, as do chords where the assistant is off. */
  private async searchFor(state: ThreadState, tool: 'search_history' | 'search_archive', query: string): Promise<Record<string, string>[]> {
    const allowed = (url: string, chordId?: string) =>
      !isNeverReadable(url, this.settings.neverSites) && !(chordId && (this.settings.offChords.includes(chordId) || this.isPrivateChord(chordId)));
    if (tool === 'search_history') {
      const result = await this.persistence.search(query, state.chordId);
      return result.history
        .filter((h) => allowed(h.url))
        .slice(0, 20)
        .map((h) => ({ title: h.title, url: h.url, last_visit: new Date(h.lastVisitAt).toISOString() }));
    }
    const page = await this.persistence.archiveList(query, 40);
    return page.items
      .filter((a) => allowed(a.url, a.chordId))
      .slice(0, 20)
      .map((a) => ({ title: a.title, url: a.url, archived: new Date(a.archivedAt).toISOString() }));
  }

  /** The tab's page, loading it if it's asleep or wasn't opened since launch (a citation's tab). */
  private async loadedContents(nodeId: NodeId) {
    // A view whose page is gone (its renderer died) has none to wait on.
    const contents = pageOf(this.browser.tabs.ensure(nodeId));
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

  /* ---------- Filling forms (D16, ARCHITECTURE.md §11.6) ---------- */

  /**
   * A card's Fill: your values, checked again here against what Chord read,
   * into the page it read them from, if that's still the tab on screen in this
   * window at the same address. Then the toast's Undo.
   */
  private async fill(windowId: WindowId, state: ThreadState, messageId: string, edits: readonly { id: string; value: string | boolean }[]): Promise<void> {
    // Pressed twice: the second would find the fields already filled and keep them as what Undo goes back to.
    if (this.filling.has(messageId)) return;
    this.filling.add(messageId);
    try {
      await this.fillOnce(windowId, state, messageId, edits);
    } finally {
      this.filling.delete(messageId);
    }
  }

  private async fillOnce(windowId: WindowId, state: ThreadState, messageId: string, edits: readonly { id: string; value: string | boolean }[]): Promise<void> {
    const message = state.messages.find((m) => m.id === messageId);
    if (message?.body.role !== 'tool' || message.body.fill?.status !== 'pending') return;
    const card = message.body.fill;
    const meta = state.fills.get(messageId);
    if (!meta) return this.endFill(state, message, 'expired', 'This suggestion has ended, so nothing was filled.');
    if (this.settings.readsNothing) return this.endFill(state, message, 'expired', 'What it can read is set to Nothing, so nothing was filled.');
    const node = nodeOf(this.browser.store.state, meta.nodeId);
    if (node?.kind !== 'tab') return this.endFill(state, message, 'expired', 'The tab is closed, so nothing was filled.');
    if (!this.readable(node)) return this.endFill(state, message, 'expired', 'This site can’t be read any more, so nothing was filled.');
    // Another tab in front: the card waits, and says how to go on.
    if (this.activeTab(windowId)?.id !== node.id) return this.noteFill(message, `Go back to “${card.title}” to fill it.`);
    const contents = pageOf(this.browser.tabs.get(node.id));
    if (!contents || contents.isDestroyed() || !samePage(meta.read.url, contents.getURL())) return this.endFill(state, message, 'expired', FILL_PROBLEMS.navigated);
    const checked = fillWrites(meta.read, card.fields, edits);
    if (!checked.ok) return this.noteFill(message, checked.problems.join(' '));
    if (checked.writes.length === 0) return this.noteFill(message, 'Choose at least one field to fill.');
    const undo = randomBytes(12).toString('hex');
    const highlight = { color: this.browser.accentOf(node.id) ?? 'Highlight', ms: durations.fillHighlight, stagger: durations.stagger, easing: easing.standard };
    const outcome = await controlPage(contents).fillForm({ token: meta.token, writes: checked.writes, undo, highlight });
    if (!outcome.ok) return this.endFill(state, message, 'expired', FILL_PROBLEMS[outcome.why]);
    // Fields that changed as the others went in (a country's states) were left as they were: the card names them.
    const note = fillChangedNote(meta.read.fields.filter((f) => outcome.skipped.includes(f.key)).map((f) => f.label));
    await this.endFill(state, message, 'filled', note || undefined, outcome.filled);
    this.fillUndos.set(undo, { state, messageId, windowId, nodeId: node.id, url: contents.getURL() });
    while (this.fillUndos.size > FILL_UNDOS) this.fillUndos.delete(this.fillUndos.keys().next().value!);
    this.toast(windowId, { id: `assistant-fill:${messageId}`, message: `Filled ${fieldCount(outcome.filled)} on ${card.site}`, action: { label: 'Undo', command: { t: 'assistant.undoFill', token: undo } } });
  }

  /** A fill's Undo (its toast): the page puts back each field the fill changed, unless you've changed it since. */
  async undoFill(token: string): Promise<void> {
    const u = this.fillUndos.get(token);
    if (!u) return;
    this.fillUndos.delete(token);
    const contents = pageOf(this.browser.tabs.get(u.nodeId));
    const result = contents && !contents.isDestroyed() && samePage(u.url, contents.getURL()) ? await controlPage(contents).undoFill(token) : null;
    if (!result) return this.toast(u.windowId, { id: `assistant-fill:${u.messageId}`, message: 'Couldn’t undo: the page has moved on' });
    const message = u.state.messages.find((m) => m.id === u.messageId);
    if (message) await this.endFill(u.state, message, 'undone', result.kept ? `${fieldCount(result.kept)} you changed since stayed as you left ${result.kept === 1 ? 'it' : 'them'}.` : undefined);
  }

  /** A card that waits with a note: what to do before Fill can work. */
  private async noteFill(message: AssistantMessage, note: string): Promise<void> {
    if (message.body.role !== 'tool' || !message.body.fill) return;
    await this.updateMessage(message, { ...message.body, fill: { ...message.body.fill, note } });
  }

  /** A card ends: filled, undone, not now, or nothing filled and why. Its saved line says which (*Filled 4 fields in “Sign up”*). */
  private async endFill(state: ThreadState, message: AssistantMessage, status: Exclude<AssistantFillCard['status'], 'pending'>, note?: string, filled?: number): Promise<void> {
    if (message.body.role !== 'tool' || !message.body.fill) return;
    const { note: _waiting, ...card } = message.body.fill;
    const count = filled ?? card.filled ?? 0;
    const summary =
      status === 'filled' ? `Filled ${fieldCount(count)} in “${card.title}”` : status === 'undone' ? `Filled ${fieldCount(count)} in “${card.title}”, then undid it` : `Didn’t fill “${card.title}”`;
    state.fills.delete(message.id);
    await this.updateMessage(message, {
      ...message.body,
      summary,
      ok: status === 'filled' || status === 'undone',
      fill: { ...card, status, ...(note ? { note } : {}), ...(status === 'filled' ? { filled: count } : {}) },
    });
  }

  /* ---------- Citations, export ---------- */

  private async openCitation(windowId: WindowId, state: ThreadState, messageId: string, n: number): Promise<void> {
    const message = state.messages.find((m) => m.id === messageId);
    if (message?.body.role !== 'assistant') return;
    const citation = message.body.citations.find((c) => c.n === n);
    if (!citation) return;
    const node = citation.tabId ? nodeOf(this.browser.store.state, citation.tabId) : undefined;
    if (node?.kind === 'tab') {
      this.browser.store.dispatch({ t: 'tab.activate', windowId, nodeId: node.id });
      const contents = await this.loadedContents(node.id);
      if (!contents) return;
      // Scroll to the quote and mark it, as find in page does (Chromium's PDF viewer included), in reader view if it's open.
      const matches = await findMatches(pageOf(this.browser.readers.viewFor(node.id)) ?? contents, citation.quote);
      // A PDF quote the viewer can't find as written (a word split across lines): open its page instead.
      // The viewer reads #page= only when it loads, so it reloads there.
      // Never in an agent's tab (S18 M2e-1): the assistant doesn't move an agent's page.
      if (!matches && citation.page && !contents.isDestroyed() && this.agentOf(node) === null) {
        await contents.loadURL(pdfPageUrl(contents.getURL(), citation.page)).catch(() => undefined);
        if (!contents.isDestroyed()) contents.reload();
      }
      return;
    }
    // Only a web page: a chat can come from a file (S15 §5), and its links are checked again here, where they open.
    if (citation.url && WEB_PAGE.test(citation.url)) {
      this.browser.store.dispatch({ t: 'tab.open', windowId, url: citation.page ? pdfPageUrl(citation.url, citation.page) : textFragmentUrl(citation.url, citation.quote) });
    }
  }

  private async exportThread(state: ThreadState): Promise<void> {
    if (!state.thread) return;
    const lines = [`# ${state.thread.title}`, ''];
    const names = this.tabNames(state);
    for (const m of state.messages) {
      if (m.body.role === 'user') lines.push(`**You:** ${m.body.text}`, '');
      else if (m.body.role === 'assistant') {
        lines.push(`**Assistant:** ${nameTabs(stripCitations(m.body.text), names)}`, '');
        for (const c of m.body.citations) lines.push(`[${c.n}] ${c.title} — ${c.url} — “${c.quote}”`);
        if (m.body.citations.length) lines.push('');
      } else if (m.body.role === 'approval') lines.push(`*${m.body.description}: ${m.body.decision}*`, '');
    }
    const { downloadsDir } = await import('../downloads');
    const safe = state.thread.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Chat';
    const file = join(downloadsDir(), `${safe}.md`);
    await writeFile(file, lines.join('\n'), 'utf8');
    const shell = state.windowId ? this.browser.window(state.windowId)?.shell.webContents : undefined;
    if (shell) send(shell, 'toast:show', { id: `assistant-export:${state.thread.id}`, message: `Saved “${safe}.md” to Downloads` });
  }

  /* ---------- Deleting ---------- */

  private async deleteThread(chordId: string, threadId: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (state) {
      this.close(state);
      this.threads.delete(threadId);
    }
    const { removed = [], images = [] } = await this.persistence.assistant({ op: 'deleteThread', threadId }).catch(() => ({ removed: [], images: [] }));
    for (const thread of removed) await this.deleteProviderCopy(thread);
    await this.images.remove(images, !this.launches.codex?.wsl);
    delete this.drafts[threadId];
    if (this.showing.get(chordId) === threadId) this.fresh(chordId);
    await this.refreshRecent(chordId);
  }

  /**
   * Chats a Chord file brought in, or its Undo took away (S15 §5): each
   * panel's list of recent chats follows, and what's loaded is read again, so
   * messages that came or went show as they are. Ones taken away end their
   * sessions first, and the providers' copies go, as Delete does.
   */
  async importChanged(removed: readonly AssistantThread[] = []): Promise<void> {
    const gone = new Set(removed.map((t) => t.id));
    for (const [key, state] of [...this.threads]) {
      const removedHere = Boolean(state.thread && gone.has(state.thread.id));
      // A chat answering now stays as it is, unless it's one that went.
      if (state.streaming && !removedHere) continue;
      if (removedHere) this.close(state);
      this.threads.delete(key);
    }
    for (const thread of removed) {
      await this.deleteProviderCopy(thread);
      delete this.drafts[thread.id];
    }
    for (const [chordId, key] of [...this.showing]) if (gone.has(key) || !this.threads.has(key)) this.showing.delete(chordId);
    for (const chordId of [...this.recent.keys()]) await this.refreshRecent(chordId);
    this.schedulePush();
  }

  async clearAll(): Promise<void> {
    for (const state of this.threads.values()) {
      this.leaveChat(state, true);
    }
    for (const id of [...this.live.keys()]) this.drop(id);
    this.threads.clear();
    this.showing.clear();
    const removed = (await this.persistence.assistant({ op: 'deleteAll' }).catch(() => ({ removed: [] }))).removed ?? [];
    for (const thread of removed) await this.deleteProviderCopy(thread);
    await rm(join(this.root, 'images'), { recursive: true, force: true }).catch(() => {});
    this.pending.clear();
    this.thumbs.clear();
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
  async deleteProviderCopy(thread: AssistantThread): Promise<void> {
    const id = thread.providerSessionId;
    if (!id || !/^[A-Za-z0-9-]{8,80}$/.test(id)) return;
    if (thread.provider === 'claude') {
      // Claude names the folder after its working directory as the OS reports it: on macOS and Linux
      // with symlinks resolved (macOS's temp and other folders sit under /private); on Windows as
      // given (a short 8.3 name stays short). The session id is exact, so both places are safe to try.
      const cwd = join(this.root, 'empty');
      const resolved = await realpath(cwd).catch(() => cwd);
      for (const dir of new Set([cwd, resolved])) {
        const folder = join(claudeConfigDir(), 'projects', claudeProjectFolder(dir));
        await rm(join(folder, `${id}.jsonl`), { force: true }).catch(() => undefined);
        await rm(join(folder, id), { recursive: true, force: true }).catch(() => undefined);
      }
      // Claude Code inside WSL keeps its sessions in the distro, under the distro's path to the same folder.
      const wsl = (this.launches.claude ?? this.inWsl.claude?.launch)?.wsl;
      if (wsl) await removeInWsl(wsl, wslClaudeSessionPaths(wsl, cwd, id));
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
    const native = await Promise.all(ASSISTANT_PROVIDERS.map((p) => detect(p)));
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

  private lookInWsl(providers: AssistantProvider[]): Promise<void> {
    this.wslLookup ??= (async () => {
      // The registry says whether there's a distro at all: no WSL, nothing starts and nothing shows.
      const distro = await defaultWslDistro();
      if (!distro) {
        for (const p of providers) delete this.inWsl[p];
        return;
      }
      this.lookingInWsl = providers;
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
        this.lookingInWsl = [];
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
    return ASSISTANT_PROVIDERS.map((p) => this.statuses[p]).filter((s): s is ProviderStatus => Boolean(s));
  }

  /** Sign in: the provider's own login in a terminal (inside WSL for a WSL install). */
  async signIn(provider: AssistantProvider): Promise<void> {
    if (!this.statuses[provider]) await this.refreshProviders('if-needed');
    const launch = this.launches[provider];
    if (launch) openSignIn(provider, launch);
  }

  private async savePanel(): Promise<void> {
    const wsl: SavedWsl = {};
    for (const [provider, found] of Object.entries(this.inWsl) as [AssistantProvider, Detected][]) if (found.launch?.wsl) wsl[provider] = { status: found.status, target: found.launch.wsl };
    await writeFile(join(this.root, 'panel.json'), JSON.stringify({ drafts: this.drafts, firstUseSeen: this.firstUseSeen, wsl }), { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  }

  /** Ctrl+. / ⌘. (S18): every reply under way stops, as its panel's Stop would. */
  stopAll(): void {
    for (const state of this.threads.values()) {
      // A tail still running after an earlier turn too (Claude's B2 on #147).
      this.endActing(state, null);
      if (!state.streaming) continue;
      state.queue = [];
      state.queuedWith = [];
      state.queuedTab = [];
      state.control.stop();
      if (state.thread) this.live.get(state.thread.id)?.session.stop();
    }
    this.schedulePush();
  }

  /** Quitting: replies in flight are kept as interrupted, and every provider process ends. */
  async quit(): Promise<void> {
    for (const state of this.threads.values()) this.leaveChat(state, true);
    this.offLeaseEnd();
    for (const state of this.threads.values()) {
      if (state.streaming && state.streaming.body.role === 'assistant' && state.thread) {
        const message = { ...state.streaming, body: { ...state.streaming.body, status: 'interrupted' as const } };
        await this.persistence.assistant({ op: 'saveMessage', message }).catch(() => undefined);
      }
    }
    for (const id of [...this.live.keys()]) this.drop(id);
  }

  /** Command bar @chats. */
  async search(query: string) {
    const result = await this.persistence.assistant({ op: 'search', query, limit: 20 }).catch(() => ({ hits: [] }));
    return result.hits ?? [];
  }

  /** Open a thread found by @chats in this window, on its chord. */
  async openHit(windowId: WindowId, chordId: string, threadId: string): Promise<void> {
    if (!this.browser.store.state.chords[chordId]) return;
    // Another chat opened over the one shown: its acting ends, and its queue acts nowhere (E6; Neon's B2, round 3).
    const was = this.shown(chordId);
    if (was && was.thread?.id !== threadId) this.leaveChat(was, true);
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

/**
 * The gate's acting card as the chat shows it (S18 M2e-2a; mocks/agents-s18-m2.html §7): the site card, a risky step,
 * or what an action sends. Chord's words only (card.description is Chord's: *click “Raise”*), never the model's.
 */
/** How long a download's name can be on its card: cut in the middle beyond this, its extension kept. */
const DOWNLOAD_NAME_MAX = 60;

/**
 * A download's card: the site it comes from (a `blob:` address's inner origin; a `data:` one, or one that can't be read,
 * the page's), never a "?" or a throw; and its name on one line, cut in the middle so its extension always shows (a long
 * name padded before `.exe` would otherwise read as its `.pdf`: Neon's SF1 and Claude's S2, round 2 of #150).
 */
export function downloadShown(download: { filename: string; url: string }, pageUrl: string): { site: string; download: string } {
  const siteOf = (url: string): string | null => {
    try {
      const u = new URL(url);
      if (u.protocol === 'blob:') return siteOf(u.pathname);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return siteOfUrl(url) ?? u.host;
    } catch {
      return null;
    }
  };
  const site = siteOf(download.url) ?? siteOf(pageUrl) ?? 'this page';
  const name = download.filename.replace(/\s+/g, ' ').trim() || 'download';
  if (name.length <= DOWNLOAD_NAME_MAX) return { site, download: name };
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  const keep = DOWNLOAD_NAME_MAX - ext.length - 1;
  const head = Math.ceil(keep / 2);
  return { site, download: `${name.slice(0, head)}…${name.slice(name.length - ext.length - (keep - head), name.length - ext.length)}${ext}` };
}

/**
 * A card a lease asks on its own (what the page sends in its tail, a download): it outlives the turn. Its whole subject is
 * `<tab>|tail|<8 hex>` or `<tab>|download|<8 hex>`, never a match inside another card's address (Neon's S5 on #150).
 */
export function outlivesTurn(subject: string): boolean {
  return /^[^|]+\|(tail|download)\|[0-9a-f]{8}$/.test(subject);
}

/** What's on the clipboard: each item's kinds and their bytes; null when it can't be read (what it holds can't be put back). */
type ClipboardSnapshot = { type: string; bytes: Uint8Array }[][] | null;

async function readClipboardItems(): Promise<ClipboardSnapshot> {
  try {
    const items = await clipboard.read();
    return await Promise.all(
      items.map((item) =>
        Promise.all(
          item.types.map(async (type) => {
            const part = await item.getType(type);
            // A bookmark (or anything else that isn't bytes) can't be written back as it was.
            if (!(part instanceof Blob)) throw new Error(`can't keep ${type}`);
            return { type, bytes: new Uint8Array(await part.arrayBuffer()) };
          }),
        ),
      ),
    );
  } catch {
    return null;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The clipboard as the assistant's lease takes and puts it back (control/user-watch.ts): all of it, every item and
 * kind, never only its text, so what can't be read back (files) is left alone and said, never cleared (Claude's B2,
 * round 2 of #150). Electron's main-process clipboard is the web's async one.
 */
export const electronClipboard = {
  snapshot: (): Promise<ClipboardSnapshot> => readClipboardItems(),
  same: async (raw: unknown): Promise<boolean> => {
    const was = raw as ClipboardSnapshot;
    const now = await readClipboardItems();
    if (!was || !now || was.length !== now.length) return false;
    return was.every((item, i) => item.length === now[i]!.length && item.every((part, j) => part.type === now[i]![j]!.type && sameBytes(part.bytes, now[i]![j]!.bytes)));
  },
  restore: async (raw: unknown): Promise<boolean> => {
    const was = raw as ClipboardSnapshot;
    if (!was) return false;
    try {
      await clipboard.write(was.map((item) => new ClipboardItem(Object.fromEntries(item.map((part) => [part.type, new Blob([part.bytes], { type: part.type })])))));
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The page's own words in a note (a dialog's text, an address): one plain line, no control or bidi characters that could
 * make it read as something else, at most 120 characters (Neon's N1 on #150).
 */
export function plainNote(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
  return text.replace(/[\u0000-\u001f\u007f؜‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** What the chat says of something the assistant's click set off (M2e-2b, A6), Chord's words around the page's. */
export const USER_TAB_NOTES: Record<UserTabNote, (detail: string) => string> = {
  file: () => 'The page tried to open a file picker; it wasn’t shown',
  // An alert has no Cancel: it was closed (its OK); a confirm or a prompt was answered Cancel.
  dialog: (detail) => (detail.startsWith('alert') ? `The page showed an alert (${detail}); it was closed` : `The page showed a dialog (${detail}); it was answered Cancel`),
  popup: (detail) => `The page tried to open ${detail} in a new tab or window; it wasn’t opened`,
  // What happened to the clipboard (control/user-watch.ts), or a clipboard permission refused (permissions.ts).
  // Which case it was, so the model says what happened, never "probably" (the owner's card-game run on 982ce10): the page
  // copied and Chord put yours back; it couldn't; or it changed with no copy of the page's own (a frame's, or yours).
  clipboard: (detail) =>
    detail === 'put back'
      ? 'The page copied something to your clipboard while the assistant acted; Chord put back what you had'
      : detail === 'not put back'
        ? 'The page copied something to your clipboard while the assistant acted, and Chord couldn’t put back what you had; check it before you paste'
        : detail === 'changed'
          ? 'Your clipboard changed while the assistant acted, but not by the page itself: a frame inside the page copied something, or you copied something elsewhere. Chord left it as it is; check it before you paste'
          : 'The page asked to use your clipboard; Chord said no',
  unload: () => 'The page has unsaved changes, so it stayed',
  external: (detail) => `The page tried to open ${detail} in another program; it wasn’t opened`,
};

export function actCard(card: ControlCard): AssistantActCard | null {
  if (card.kind === 'site') {
    return {
      kind: 'site',
      title: `Let the assistant click and type on ${card.subject}?`,
      note: `It wants to ${card.description}.`,
      lines: ['It asks before anything it does sends data, and before it submits, pays, sends or deletes.'],
      danger: false,
      showable: false,
    };
  }
  const step = card.step;
  if (card.kind !== 'step' || !step) return null;
  const did = card.description.charAt(0).toLowerCase() + card.description.slice(1);
  if (step.sends) {
    const other = step.sends.some((s) => s !== step.site);
    const where = step.sends.length > 1 ? `${step.sends.length} sites` : other ? 'another site' : 'its site';
    return {
      kind: 'send',
      title: sendTitle(step.sends),
      note: step.idle ? `After the assistant’s last step, the page is sending something to ${where}.` : `The assistant ${did}, and the page is sending something to ${where}.`,
      lines: [`Goes to: ${step.sends.join(', ')}`],
      danger: other,
      showable: Boolean(card.show),
    };
  }
  // Leaving the site (M2e-2c, B3): the whole address, which can carry data out; a redirect says what sent the tab on
  // (Neon's N5 on #151).
  if (step.why === 'leave') {
    const note = step.idle ? 'After the assistant’s last step, the page is sending your tab to:' : step.from ? `${step.from} sends your tab to:` : 'The assistant wants to open this in your tab:';
    return { kind: 'step', title: stepTitle('leave', step.site), note, lines: [step.going ?? ''], danger: false, showable: false };
  }
  // What it types, in a chat that read anything but this tab (M2e-2c, B3): shown in full first.
  if (step.taint) {
    return {
      kind: 'step',
      title: `Type this ${card.description.replace(/^type /, '')}?`,
      note: 'It read another tab, history or the archive in this chat, so it shows what it types first.',
      // All of it, in a box that scrolls (Neon's B2 and SF1 on #151).
      lines: [],
      long: `“${step.typed ?? ''}”`,
      danger: false,
      showable: Boolean(card.show),
    };
  }
  // A download its click started (M2e-2b): saved only if you say so.
  if (step.download !== undefined) {
    return { kind: 'step', title: `Save ${step.download} from ${step.site}?`, note: 'The assistant’s click started a download.', lines: [], danger: false, showable: false };
  }
  const lines: string[] = [];
  if (step.to) lines.push(`It goes to ${step.to}.`);
  if (step.shows) lines.push(`It reads “${step.shows}”.`);
  if (step.typed !== undefined) lines.push(`It types: “${step.typed}”`);
  if (step.fields.length) lines.push(`Goes with it: ${step.fields.join(', ')}${step.more ? ` and ${step.more} more` : ''}`);
  return {
    kind: 'step',
    title: stepTitle(step.why, step.site),
    // A tail card (idle): the page's own doing after the last action, never the assistant's next step (round 2 of #147).
    note: step.idle
      ? step.going
        ? `After the assistant’s last step, the page is going to ${step.going}.`
        : 'After the assistant’s last step, the page is doing this on its own.'
      : step.going
        ? `The assistant ${did}, and the page is going to ${step.going}.`
        : `The assistant is about to ${card.description}.`,
    lines,
    danger: stepDanger(step.why) || Boolean(step.to),
    showable: Boolean(card.show),
  };
}

/** At most this many caught notes wait for a tab's next result. */
const CAUGHT_MAX = 10;

/** The bar between the assistant's steps in a tab (the owner, 2026-11-24: it stays on while it works). */
const BAR_BETWEEN = 'is working in this tab';
/** How long the bar stays up with no next step before it comes down (a model thinking long, a card unanswered). */
const BAR_IDLE_MS = 45_000;

/** An address's origin (scheme, host and port), or empty when it has none. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
