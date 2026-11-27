/**
 * The assistant acting in a tab of yours (S18 M2e-2a; the decision record's *The watch (your tab), a lease*). An outside
 * agent's tab has a debugger and a send hold for its whole life (agents/pickers.ts); a tab of yours gets them only
 * while the assistant acts there: from right before an action's input until a moment after the last one (TAIL_MS), or
 * until something it sent is answered. Then everything is let go of, and the tab is as it always was.
 *
 * - **One owner** (a chat's gate id): another chat acting in the tab meanwhile is refused (E8), and its own next action
 *   joins the lease (Neon's B3 on #147), checked again inside the debugger queue. A chat ending lets go of its own
 *   lease only (`endUserLease(contents, owner)`); your hands end anyone's (Claude's B1, round 2).
 * - **Never held across its steps:** the lease takes the debugger queue (debugger-queue.ts) only to turn things on and
 *   off, so the action's own checks (deep.ts), page_diagnostics and screenshots run as ever (Neon's B3 on the plan).
 *   Every command it sends is bounded (COMMAND_MS) and fails closed, so a page that stops answering (`window.print`)
 *   can't hold the queue.
 * - **Held from the first request:** the send hold is listening before Fetch is on (as agents/pickers.ts), and a
 *   lease whose debugger went, or that was ended, while it was being set up is never handed out (Neon's B1 and B2,
 *   round 2).
 * - **Lost, closed:** the debugger let go (DevTools, a detach) or the page's renderer gone: the lease is lost, what was
 *   held fails, and the action hears it (`userLeaseLost`: page.lost(), deep.held()); never rejoined (Neon's B1). A
 *   lease ended while an action is under way counts as lost for that action too.
 * - **What its click sets off** (M2e-2b, A6) is caught for AFTER_MS after the last action, the activation's life and a
 *   margin: file pickers intercepted, passkeys refused before any prompt (`WebAuthn.enable` with no authenticator: the
 *   M2e-2 spike), the site's service worker bypassed (its other tabs keep theirs: C3, always
 *   restored, whatever ends the lease), dialogs and unload noted, and (elsewhere, asking `userTabCatching`) popups,
 *   downloads and the clipboard. What the page *sends* is the assistant's only during an action and TAIL_MS after.
 * - **Let go of in order:** from the moment it ends, what the tab sends is yours (it goes), what was held for the
 *   assistant fails, and only then is the hold's listener taken off, once Fetch is off (Neon's B4).
 */
import { randomBytes } from 'node:crypto';
import { PRINT_HOLD_WORLD, printAsks, printBinding, printHold, printUntil } from '../agents/agent-scripts';
import type { WebContents } from 'electron';
import { withDebugger } from '../debugger-queue';
import { failHeld, holdSends, holding, sendHoldDeps, unholdSends, type SendHoldDeps } from './sends';

/** How long after the assistant's last action in the tab what the page sends is still asked about. */
export const TAIL_MS = 1500;
/** How long after its last action what its click set off is caught: Chromium's 5 s activation, and a margin (Neon's S3). */
export const AFTER_MS = 6000;
/** How long a lease waits on a card about what's held before it ends anyway (what's held then fails). */
const CARD_WAIT_MS = 45_000;
/** Each command's limit: a page that stops answering never holds the debugger queue. */
export const COMMAND_MS = 3000;
/** Requests only, never responses: a tab of yours keeps its pages' own headers (agents' tabs get AGENT_POLICY). */
const PATTERNS = [{ urlPattern: '*', requestStage: 'Request' }];
/** Auto-attach to frames in other processes (and theirs), held at their start until their requests are held too. */
/**
 * Auto-attach to frames in other processes (and theirs), held at their start until their requests are held too; and to
 * dedicated workers, which are paused at their start by the same setting and run at once (what they send is paused in
 * their page's own Fetch session, so it's held as the page's is: Electron 45.5, the final check of #150). Claude's B1,
 * round 2 of #150; agents/pickers.ts attaches them the same way.
 */
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [
    { type: 'iframe', exclude: false },
    { type: 'worker', exclude: false },
  ],
};

/** Network's buffers while the lease has it on (only for the service-worker bypass): small, no bodies kept. */
const NETWORK_BUFFERS = { maxTotalBufferSize: 64 * 1024, maxResourceBufferSize: 16 * 1024, maxPostDataSize: 0 };

/** What the lease caught, for the chat (a muted row each). */
export type UserTabNote = 'file' | 'dialog' | 'popup' | 'clipboard' | 'unload' | 'external' | 'print';

/** A download the assistant's click started: its name (made safe) and where it comes from (its redirects' end). */
export interface UserTabDownload {
  filename: string;
  url: string;
}

export interface UserTabDeps extends Omit<SendHoldDeps, 'whose'> {
  /** Something the assistant's action set off was caught (said in the chat). */
  note(what: UserTabNote, detail: string): void;
  /** A download its click started: the chat's card (*Save invoice.pdf from shop.example?*). */
  askDownload(download: UserTabDownload, signal: AbortSignal): Promise<boolean>;
  /** The site an address is on (registrable domain, as the site card's), for what leaves it (M2e-2c). */
  siteOfPage(url: string): string | null;
  /**
   * The clipboard (Electron's), to put back what the page copied in the window: a snapshot of everything on it (text,
   * HTML, RTF, an image), whether it's still as a snapshot was, and putting one back (false: it held what can't be put
   * back, files; it's left as it is then).
   */
  clipboard?: { snapshot(): Promise<unknown>; same(snapshot: unknown): Promise<boolean>; restore(snapshot: unknown): Promise<boolean> };
}

/** Whether a lease could be had: on (or joined), another chat's (E8), or not (the debugger can't be had, Fetch failed). */
type UserLeaseBegin = 'on' | 'busy' | 'no';

/**
 * One action's hold on the lease: `end` once it's done (its tail starts after the last one). It belongs to the lease it
 * began on: once that lease is gone, or ended once already, it does nothing (Neon's B3, round 3 of #147).
 */
export interface UserAction {
  begun: UserLeaseBegin;
  end(): void;
}

const NOT_ON = (begun: Exclude<UserLeaseBegin, 'on'>): UserAction => ({ begun, end: () => undefined });

interface Lease {
  /** Whose: the chat's gate id. */
  owner: string;
  deps: UserTabDeps;
  /** Until when what the page sends is the assistant's (held): its last action's end and TAIL_MS. */
  sendsUntil: number;
  /** The clipboard as the lease began (a snapshot, being taken), and what the page copied onto it since, if it did. */
  clipboard: Promise<unknown>;
  pageCopy: unknown;
  /** The page's copy being taken now (putBackClipboard waits for it). */
  copying?: Promise<void>;
  /** A change the page's top frame didn't make was said (once a lease). */
  changeSaid?: boolean;
  /** Its downloads' cards, to take down when it ends. */
  cancel: AbortController;
  /** Download cards up now: the lease waits for them (up to CARD_WAIT_MS) before it ends by time. */
  asking: number;
  /**
   * Where navigate or back is going (M2e-2c): its site, and whether over https. The tab's own page going on to another
   * site, or to plain http from https, asks, through the action and its tail (a meta refresh or a timer right after the
   * load: Neon's SF3 and SF5 on #151). Each action starts with none.
   */
  going: { site: string | null; https: boolean } | null;
  /** Chord attached the debugger for this lease (else someone else's attachment, used as it is: never detached). */
  mine: boolean;
  actions: number;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Frames in other processes, auto-attached while the lease is on: their sessions, to turn Fetch off in. */
  sessions: Set<string>;
  /** Frames attaching now: their requests held before the action's input goes (Claude's S3 on #147). */
  pending: Set<Promise<void>>;
  /** A frame that was there as the lease began couldn't be held: the lease isn't handed out (fail closed). */
  frameFailed: boolean;
  /** #338: the print scripts added in each session (the page's: undefined), by identifier, to take out at the end. */
  printScripts: Map<string | undefined, string[]>;
  /** #338: each session's latest deadline script (replaced as the hold is renewed). */
  printUntilScripts: Map<string | undefined, string>;
  /** #338: until when prints are held in the tab's frames (renewed as actions go on; 0 once the lease is over). */
  printHoldUntil: number;
  /** #338: a print the page tried was said for this action (once an action: Fable's SF1). */
  printSaid: boolean;
  /**
   * #338: the lease's own session on the page, for the binding the page's frames say a held print through (Runtime on
   * there, never in the page's own session, which the click (deep.ts) and page_diagnostics turn on and off). Its target.
   */
  printSession: string | null;
  selfTarget: string | null;
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void;
  onDetach: () => void;
  onGone: () => void;
}

const leases = new WeakMap<WebContents, Lease>();
/** Frame sessions an earlier lease left attached on someone else's debugger (its auto-attach couldn't be turned off). */
const leftovers = new WeakMap<WebContents, Set<string>>();
/** Tabs whose lease was lost (the debugger let go, the renderer gone): an action there checks this before any input. */
const lost = new WeakSet<WebContents>();
/** Begins under way (queued, or setting up), per tab: an end meanwhile cancels its owner's (or, from your hands, all). */
const starting = new WeakMap<WebContents, Set<{ owner: string; cancelled: boolean }>>();

/** Whether the assistant is acting in this tab of yours now (the vault keeps its menu shut meanwhile). */
export function userTabActing(contents: object): boolean {
  const lease = leases.get(contents as WebContents);
  return Boolean(lease && !lease.ended && (lease.actions > 0 || Date.now() < lease.sendsUntil));
}

/** Whether what this tab's page does now was set off by the assistant: an action, or its AFTER_MS after (A6). */
export function userTabCatching(contents: object): boolean {
  const lease = leases.get(contents as WebContents);
  return Boolean(lease && !lease.ended);
}

/**
 * #338: a tab's print token (agent-scripts.ts' printAsks, printHold): random, the tab's for its life, so a document a
 * lease touched asks with the same name in any later lease, and a page can't know it (Opus's S2, Neon's SF2).
 */
const printTokens = new WeakMap<WebContents, string>();
export function printTokenOf(contents: WebContents): string {
  let token = printTokens.get(contents);
  if (!token) printTokens.set(contents, (token = randomBytes(16).toString('hex')));
  return token;
}
/** #338: how long a hold lasts unless renewed: a lease lost with no word (its debugger taken) holds prints no longer. */
export const PRINT_HOLD_MS = 10 * 60_000;

/** #338: a print the page tried, held: said in the chat in fixed words (none from the page), once an action. */
function notePrint(lease: Lease): void {
  if (lease.printSaid) return;
  lease.printSaid = true;
  lease.deps.note('print', '');
}

/** #338: an added script's identifier, from CDP's answer. */
const scriptId = (added: unknown): string | null => {
  const identifier = (added as { identifier?: unknown } | undefined)?.identifier;
  return typeof identifier === 'string' ? identifier : null;
};

/**
 * #338: the hold's deadline moved, in each frame of the tab (its documents now, and new ones): a script in the hold's
 * world that runs at once, replacing the session's last. Each command bounded; a failure leaves the last deadline.
 */
async function moveHold(debug: Electron.Debugger, lease: Lease, until: number, sessions: (string | undefined)[]): Promise<void> {
  lease.printHoldUntil = until;
  await Promise.all(
    sessions.map(async (sessionId) => {
      const added = await command(debug, 'Page.addScriptToEvaluateOnNewDocument', { source: printUntil(until), worldName: PRINT_HOLD_WORLD, runImmediately: true }, sessionId).catch(() => null);
      const id = scriptId(added);
      if (!id) return;
      const was = lease.printUntilScripts.get(sessionId);
      lease.printUntilScripts.set(sessionId, id);
      lease.printScripts.set(sessionId, [...(lease.printScripts.get(sessionId) ?? []), id]);
      if (was) {
        await command(debug, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: was }, sessionId).catch(() => undefined);
        lease.printScripts.set(sessionId, (lease.printScripts.get(sessionId) ?? []).filter((x) => x !== was));
      }
    }),
  );
}

/** #338: a lease's print scripts taken out of every session (someone else's attachment, or the lease superseded). */
async function removePrintScripts(debug: Electron.Debugger, lease: Lease): Promise<void> {
  for (const [sessionId, ids] of lease.printScripts) {
    for (const identifier of ids) await command(debug, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId).catch(() => undefined);
  }
  lease.printScripts.clear();
  lease.printUntilScripts.clear();
  await dropPrintSession(debug, lease);
}

/** #338: the lease's own session on the page let go (its binding with it). */
async function dropPrintSession(debug: Electron.Debugger, lease: Lease): Promise<void> {
  const sessionId = lease.printSession;
  if (!sessionId) return;
  lease.printSession = null;
  await command(debug, 'Target.detachFromTarget', { sessionId }).catch(() => undefined);
}

/** Something caught outside the lease (a popup, the clipboard: tabs.ts, permissions.ts), said in the chat. */
export function noteUserTab(contents: object, what: UserTabNote, detail: string): void {
  const lease = leases.get(contents as WebContents);
  if (lease && !lease.ended) lease.deps.note(what, detail);
}

/** A download the page started in the window: asked in the chat first (null when no lease: it isn't the assistant's). */
export function askUserTabDownload(contents: object, download: UserTabDownload): Promise<boolean> | null {
  const lease = leases.get(contents as WebContents);
  if (!lease || lease.ended) return null;
  // The lease stays on while you're asked (its card would die with it): up to CARD_WAIT_MS (Neon's S1 on #150).
  lease.asking++;
  return lease.deps
    .askDownload(download, lease.cancel.signal)
    .catch(() => false)
    .finally(() => void lease.asking--);
}

/** Whose lease is on in this tab now (a chat's gate id), or null. */
export function userLeaseOwner(contents: object): string | null {
  const lease = leases.get(contents as WebContents);
  return lease && !lease.ended ? lease.owner : null;
}

/** Whether the tab's lease was lost since it began (Neon's B1 on #147): nothing more is pressed or typed there. */
export function userLeaseLost(contents: object): boolean {
  return lost.has(contents as WebContents);
}

/** A lease beginning, for anything that must close itself for it (the vault's menu: Neon's B7 on #147). */
const beginning = new Set<(contents: WebContents) => void>();
export function onUserLease(listener: (contents: WebContents) => void): () => void {
  beginning.add(listener);
  return () => void beginning.delete(listener);
}

/** A lease ended, however (its tail, your hands, Stop, lost): its owner forgets the tab (Claude's B1, round 2). */
const ending = new Set<(contents: WebContents, owner: string) => void>();
export function onUserLeaseEnd(listener: (contents: WebContents, owner: string) => void): () => void {
  ending.add(listener);
  return () => void ending.delete(listener);
}

/** A command within COMMAND_MS, or a rejection (fail closed). */
function command(debug: Electron.Debugger, method: string, params: object = {}, sessionId?: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} took too long`)), COMMAND_MS);
    timer.unref?.();
  });
  return Promise.race([debug.sendCommand(method, params, sessionId), limit]).finally(() => clearTimeout(timer));
}

/**
 * The lease on, for one action of `owner`'s (or joined, if it's that owner's). `busy`: another chat's (E8). `no`: the
 * tab's debugger can't be had (someone's DevTools), Fetch can't be turned on, a frame can't be held, the debugger went
 * meanwhile, or the lease was ended meanwhile: nothing is pressed or typed then.
 */
export async function beginUserAction(contents: WebContents, owner: string, deps: UserTabDeps): Promise<UserAction> {
  if (contents.isDestroyed()) return NOT_ON('no');
  const join = (lease: Lease): UserAction => {
    if (lease.owner !== owner) return NOT_ON('busy');
    // A lease whose debugger or hold is gone isn't joined: it's lost (Neon's B1).
    if (!contents.debugger.isAttached()) {
      lose(contents, lease);
      return NOT_ON('no');
    }
    lease.actions++;
    lease.going = null;
    // #338: each action hears its own print (Fable's SF1); a long run of actions keeps prints held.
    lease.printSaid = false;
    if (lease.printHoldUntil - Date.now() < PRINT_HOLD_MS / 2) void moveHold(contents.debugger, lease, Date.now() + PRINT_HOLD_MS, [undefined, ...lease.sessions]);
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = null;
    // Each action tells what must close for it (the vault's menu), not only the lease's first (Neon's S2 on #150).
    for (const listener of beginning) listener(contents);
    return { begun: 'on', end: actionEnd(contents, lease) };
  };
  const was = leases.get(contents);
  if (was && !was.ended) return join(was);
  const me = { owner, cancelled: false };
  let mine = starting.get(contents);
  if (!mine) starting.set(contents, (mine = new Set()));
  mine.add(me);
  try {
    return await withDebugger(contents, () => setUp(contents, owner, deps, me, join));
  } finally {
    mine.delete(me);
  }
}

async function setUp(contents: WebContents, owner: string, deps: UserTabDeps, me: { cancelled: boolean }, join: (lease: Lease) => UserAction): Promise<UserAction> {
  if (contents.isDestroyed() || me.cancelled) return NOT_ON('no');
  // Asked again in the queue: another begin may have got there first (Neon's B3 on #147).
  const again = leases.get(contents);
  if (again && !again.ended) return join(again);
  const debug = contents.debugger;
  const mine = !debug.isAttached();
  try {
    if (mine) debug.attach('1.3');
  } catch {
    return NOT_ON('no');
  }
  const lease: Lease = {
    owner,
    deps,
    sendsUntil: 0,
    // Taken alongside the set-up, never on the first action's path (invariant 9: the final check of #150).
    clipboard: takeClipboard(deps),
    pageCopy: undefined,
    cancel: new AbortController(),
    asking: 0,
    going: null,
    mine,
    actions: 1,
    ended: false,
    timer: null,
    sessions: new Set(),
    pending: new Set(),
    frameFailed: false,
    printScripts: new Map(),
    printUntilScripts: new Map(),
    printHoldUntil: Date.now() + PRINT_HOLD_MS,
    printSaid: false,
    printSession: null,
    selfTarget: null,
    onMessage: () => undefined,
    onDetach: () => undefined,
    onGone: () => undefined,
  };
  let handedOut = false;
  /** What the action's click sets off, in the page or a frame: caught for the chat (each command bounded). */
  // Every catch on, or none: one that fails (or times out) fails the lease closed, as Fetch does (Neon's B3 on #150).
  // FedCM isn't one: Electron has no FedCM UI, so a page's sign-in request fails by itself (NetworkError), and with the
  // domain on it would wait instead, where dismissing it takes the app down (Electron 45.5, the build's E2E row).
  const token = printTokenOf(contents);
  /** One print script added in the session, kept; the lease ended meanwhile: taken out at once (Opus's S1b). */
  const addPrintScript = async (sessionId: string | undefined, params: object): Promise<string | null> => {
    if (lease.ended) throw new Error('the lease ended');
    const id = scriptId(await command(debug, 'Page.addScriptToEvaluateOnNewDocument', params, sessionId));
    if (!id) return null;
    if (lease.ended) {
      await command(debug, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, sessionId).catch(() => undefined);
      throw new Error('the lease ended');
    }
    lease.printScripts.set(sessionId, [...(lease.printScripts.get(sessionId) ?? []), id]);
    return id;
  };
  /**
   * The binding a frame's hold says a held print through, in the hold's worlds (by name, so in each new document too),
   * with Runtime on so its calls come (Runtime.bindingCalled; Runtime keeps no bodies). In a frame of another process:
   * its own session, the lease's. In the page: the lease's own session on it (printSession), never the page's own.
   */
  const sayPrints = async (sessionId: string) => {
    await command(debug, 'Runtime.enable', {}, sessionId);
    await command(debug, 'Runtime.addBinding', { name: printBinding(token), executionContextName: PRINT_HOLD_WORLD }, sessionId);
  };
  /** The lease's own session on the page, for its binding; none to be had: prints still held there, but not said. */
  const pageSession = async () => {
    const self = (await command(debug, 'Target.getTargetInfo', {}).catch(() => null)) as { targetInfo?: { targetId?: unknown } } | null;
    const targetId = self?.targetInfo?.targetId;
    if (typeof targetId !== 'string') return;
    lease.selfTarget = targetId;
    const attached = (await command(debug, 'Target.attachToTarget', { targetId, flatten: true }).catch(() => null)) as { sessionId?: unknown } | null;
    if (typeof attached?.sessionId !== 'string') return;
    lease.printSession = attached.sessionId;
    if (lease.ended) return dropPrintSession(debug, lease);
    await sayPrints(attached.sessionId).catch(() => undefined);
  };
  const holdPrints = async (sessionId?: string) => {
    if (sessionId) await sayPrints(sessionId);
    await addPrintScript(sessionId, { source: printHold(token), worldName: PRINT_HOLD_WORLD, runImmediately: true });
    const until = await addPrintScript(sessionId, { source: printUntil(lease.printHoldUntil), worldName: PRINT_HOLD_WORLD, runImmediately: true });
    if (until) lease.printUntilScripts.set(sessionId, until);
    await addPrintScript(sessionId, { source: printAsks(token), runImmediately: true });
  };
  const catching = async (sessionId?: string) => {
    const pageOn = command(debug, 'Page.enable', {}, sessionId);
    await Promise.all([
      pageOn,
      command(debug, 'Page.setInterceptFileChooserDialog', { enabled: true }, sessionId),
      command(debug, 'WebAuthn.enable', { enableUI: false }, sessionId),
      // Network is on only for the bypass: it keeps no bodies (small buffers).
      command(debug, 'Network.enable', NETWORK_BUFFERS, sessionId).then(() => command(debug, 'Network.setBypassServiceWorker', { bypass: true }, sessionId)),
      // #338: a print the page tries is held in this frame's own isolated world while the lease is on (its deadline), and
      // said through the tab's binding; in the documents there now and each new one. After Page.enable (as
      // agents/pickers.ts), each within COMMAND_MS, so a frozen renderer fails the lease closed (Argon's B3). The hold
      // before the page's stub, so no print asks before something answers. Identifiers kept, to take them out at the end.
      pageOn.then(() => holdPrints(sessionId)),
    ]);
  };
  lease.onMessage = (_event, method, params) => {
    const p = params as { sessionId?: string; waitingForDebugger?: boolean; message?: string; type?: string };
    if (!lease.ended && handedOut) {
      if (method === 'Page.fileChooserOpened') return deps.note('file', 'a file picker');
      // #338: a print the page tried, held in a frame (its binding, from its hold's world).
      if (method === 'Runtime.bindingCalled' && (params as { name?: unknown }).name === printBinding(token)) return notePrint(lease);
      if (method === 'Page.javascriptDialogOpening') return deps.note('dialog', `${p.type ?? 'alert'}: “${String(p.message ?? '').slice(0, 120)}”`);
    }
    if (method === 'Target.detachedFromTarget' && p.sessionId) {
      leftovers.get(contents)?.delete(p.sessionId);
      return void lease.sessions.delete(p.sessionId);
    }
    if (method !== 'Target.attachedToTarget' || !p.sessionId) return;
    // #338: the lease's own session on the page (printSession), not a frame.
    if ((params as { targetInfo?: { targetId?: string } }).targetInfo?.targetId === lease.selfTarget && lease.selfTarget) return;
    const frame = p.sessionId;
    // A dedicated worker: run at once, during the lease or as it lets go; never left waiting (it would stall the page's
    // feature until a reload: Claude's B1, round 2 of #150). What it sends is paused in its page's own Fetch session
    // (Electron 45.5: the final check of #150; a worker's session has no Fetch at all), so it's held as the page's is.
    if ((params as { targetInfo?: { type?: string } }).targetInfo?.type === 'worker') {
      if (p.waitingForDebugger) void command(debug, 'Runtime.runIfWaitingForDebugger', {}, frame).catch(() => undefined);
      return;
    }
    // Ended already (cancelled while it's set up): not held, but known, so its cleanup can hand it on if auto-attach
    // can't be turned off (leftovers).
    if (lease.ended) return void lease.sessions.add(frame);
    holdFrame(frame, Boolean(p.waitingForDebugger));
  };
  /**
   * A frame in another process: its requests held (and its own frames attached) before it runs; one that can't be held
   * stays paused at its start (a blank frame), never running unheld (fail closed: Claude's S3). One there as the lease
   * begins that can't be held: no lease (Neon's S3, round 2).
   */
  const holdFrame = (frame: string, waiting: boolean) => {
    lease.sessions.add(frame);
    const ready = (async () => {
      try {
        await command(debug, 'Fetch.enable', { patterns: PATTERNS }, frame);
        await command(debug, 'Target.setAutoAttach', AUTO_ATTACH, frame);
        // What the frame's page sets off, caught too, before it runs.
        await catching(frame);
      } catch {
        if (!handedOut) lease.frameFailed = true;
        return;
      }
      if (waiting && !lease.ended) await command(debug, 'Runtime.runIfWaitingForDebugger', {}, frame).catch(() => undefined);
    })();
    lease.pending.add(ready);
    void ready.finally(() => lease.pending.delete(ready));
  };
  // The debugger let go (DevTools took it, a detach) or the page's renderer went: lost, never failing open. While it's
  // still being set up, only ended: the set-up gives up and cleans up itself (Neon's B4, round 3 of #147).
  lease.onDetach = () => (handedOut ? lose(contents, lease) : void (lease.ended = true));
  lease.onGone = lease.onDetach;
  debug.on('detach', lease.onDetach);
  contents.on('render-process-gone', lease.onGone);
  // The hold listens before Fetch is on: nothing paused in between is left without an answer (Neon's B1, round 2).
  // Until it's handed out, what the page sends is its own (the action's input hasn't gone): it goes.
  holdSends(contents);
  // During an action and TAIL_MS after it, what the tab sends is the assistant's: held and asked about. Then, or once
  // the lease ends (your hands, Stop), yours.
  sendHoldDeps(contents, {
    ...deps,
    // A new request: the assistant's only in an action or its tail. No request (a card being settled, sends.ts): still
    // the assistant's while the lease lives, so an Allow after the tail sends what it held (Neon's B4 on #150).
    whose: (request) => (lease.ended || !handedOut ? 'user' : !request || lease.actions > 0 || Date.now() < lease.sendsUntil ? 'agent' : 'user'),
    leaving: (url) =>
      !lease.ended &&
      lease.going !== null &&
      (lease.actions > 0 || Date.now() < lease.sendsUntil) &&
      (deps.siteOfPage(url) !== lease.going.site || (lease.going.https && /^http:/i.test(url))),
  });
  debug.on('message', lease.onMessage);
  const giveUp = async (): Promise<UserAction> => {
    lease.ended = true;
    debugOff(contents, lease);
    // What's held fails before the detach (#322: Chromium resumes what a detaching client paused).
    failHeld(contents);
    await turnOff(contents, lease);
    unholdSends(contents);
    return NOT_ON('no');
  };
  try {
    await command(debug, 'Fetch.enable', { patterns: PATTERNS });
    await command(debug, 'Target.setAutoAttach', AUTO_ATTACH);
    // Frames an earlier lease left attached on someone else's debugger (its auto-attach couldn't be turned off): never
    // announced again, and running with Fetch off, so held again here, or no lease (the factory's sim, seed 87).
    for (const frame of leftovers.get(contents) ?? []) if (!lease.sessions.has(frame)) holdFrame(frame, false);
    leftovers.delete(contents);
    // Frames already there: attached as setAutoAttach answers (and theirs, as they come); held before any input.
    while (lease.pending.size) await Promise.all([...lease.pending]);
    await pageSession();
    await catching();
  } catch {
    return giveUp();
  }
  // Gone or ended while it was set up: never handed out with nothing on (Neon's B1 and B2, round 2).
  if (lease.ended || lease.frameFailed || me.cancelled || contents.isDestroyed() || !debug.isAttached()) return giveUp();
  handedOut = true;
  lost.delete(contents);
  leases.set(contents, lease);
  // A page with unsaved changes stays put: the action hears it (its move didn't happen).
  contents.on('will-prevent-unload', onUnload);
  for (const listener of beginning) listener(contents);
  return { begun: 'on', end: actionEnd(contents, lease) };
}

/** One action's end, for the lease it began on only, once (Neon's B3, round 3 of #147). */
function actionEnd(contents: WebContents, lease: Lease): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (leases.get(contents) !== lease || lease.ended) return;
    endAction(contents, lease);
  };
}

function onUnload(this: WebContents): void {
  noteUserTab(this, 'unload', 'the page has unsaved changes, so it stayed');
}

/**
 * The page copied (its copy or cut event, from the page preload: execCommand('copy') on the click's activation isn't a
 * permission): what it put there is taken a moment later, once it's written, to know it again (Claude's B2, round 2 of
 * #150). Your own copy never comes here: your key ends the lease first.
 */
export function userTabCopied(contents: object): void {
  const lease = leases.get(contents as WebContents);
  if (!lease || lease.ended) return;
  // Taken a moment later (once it's written); a put-back meanwhile waits for it.
  lease.copying = new Promise<void>((done) => {
    const timer = setTimeout(done, COPY_SETTLE_MS);
    timer.unref?.();
  }).then(async () => void (lease.pageCopy = await takeClipboard(lease.deps)));
}

/** How long after the page's copy event its copy is on the clipboard. */
const COPY_SETTLE_MS = 50;

async function takeClipboard(deps: UserTabDeps): Promise<unknown> {
  try {
    return await deps.clipboard?.snapshot();
  } catch {
    return undefined;
  }
}

/**
 * The page's copy, put back to what was there as the lease began: as each action ends, and as the lease ends unless by
 * your own input (Neon's B6 on #150). Only if the page copied, and only while what's there is still the page's copy:
 * anything you copied since (in the chat, another app) is yours (Claude's B2, round 2 of #150). What can't be put back
 * (files) is left as it is, and said.
 */
async function putBackClipboard(lease: Lease): Promise<void> {
  await lease.copying;
  const page = lease.pageCopy;
  const clipboard = lease.deps.clipboard;
  const start = await lease.clipboard;
  if (start === undefined || !clipboard) return;
  try {
    if (page === undefined) {
      // Changed with no copy the page's top frame saw (a frame's copy, or yours elsewhere): never put back, but said once,
      // to check before pasting (the final check of #150).
      if (!lease.changeSaid && !(await clipboard.same(start))) {
        lease.changeSaid = true;
        lease.deps.note('clipboard', 'changed');
      }
      return;
    }
    lease.pageCopy = undefined;
    if (!(await clipboard.same(page)) || (await clipboard.same(start))) return;
    lease.deps.note('clipboard', (await clipboard.restore(start)) ? 'put back' : 'not put back');
  } catch {
    // Unreadable now: left as it is.
  }
}

/** navigate or back is going to `url` (M2e-2c): until the action ends, the page going on to another site asks. */
export function userTabGoing(contents: WebContents, url: string): void {
  const lease = leases.get(contents);
  if (lease && !lease.ended) lease.going = { site: lease.deps.siteOfPage(url), https: /^https:/i.test(url) };
}

/** The action's done: the lease ends AFTER_MS after the last one, once nothing's held (or CARD_WAIT_MS on). */
function endAction(contents: WebContents, lease: Lease): void {
  lease.actions = Math.max(0, lease.actions - 1);
  void putBackClipboard(lease);
  if (lease.actions > 0) return;
  // Where it went stays held through the tail (Neon's SF3 on #151): leaving() checks the time.
  const started = Date.now();
  lease.sendsUntil = started + TAIL_MS;
  const later = () => {
    lease.timer = null;
    if (lease.ended || lease.actions > 0) return;
    if ((holding(contents) || lease.asking > 0) && Date.now() - started < CARD_WAIT_MS) {
      lease.timer = setTimeout(later, 250);
      lease.timer.unref?.();
      return;
    }
    void release(contents, lease, true);
  };
  lease.timer = setTimeout(later, AFTER_MS);
  lease.timer.unref?.();
}

/**
 * The lease ends now. With an `owner` (that chat's acting ended: Stop, a new chat, the chord off): only that chat's
 * lease, and its begins under way; another chat's is left alone. Without (your key, click or page move: F1): whoever's
 * it is. What's held for the assistant fails (its card comes down); nothing of yours is held from here.
 */
export function endUserLease(contents: WebContents, owner?: string): void {
  for (const begin of starting.get(contents) ?? []) if (owner === undefined || begin.owner === owner) begin.cancelled = true;
  const lease = leases.get(contents);
  if (!lease || lease.ended) return;
  if (owner !== undefined && lease.owner !== owner) return;
  // The clipboard is put back unless it's your own input ending it (no owner).
  void release(contents, lease, owner !== undefined);
}

/** Lost (the debugger let go, the renderer gone): what was held fails at once, and the action hears it. */
function lose(contents: WebContents, lease: Lease): void {
  if (lease.ended) return;
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  lease.cancel.abort();
  lost.add(contents);
  if (leases.get(contents) === lease) leases.delete(contents);
  failHeld(contents);
  ended(contents, lease);
  void putBackClipboard(lease);
  if (contents.isDestroyed()) return void debugOff(contents, lease);
  contents.off('will-prevent-unload', onUnload);
  // The renderer gone with the debugger still on: Fetch off (Chord's attachment let go of), or the reloaded tab's
  // requests would wait on a hold no one answers (Claude's S1, round 2). The listener stays until then.
  void withDebugger(contents, async () => {
    if (superseded(contents, lease)) {
      // #338: its print scripts out (the new lease adds its own, and sets the deadline): never left to run in new
      // documents after the new lease ends (Opus's S1a).
      if (!contents.isDestroyed()) await removePrintScripts(contents.debugger, lease);
      return debugOff(contents, lease);
    }
    try {
      if (!contents.isDestroyed()) contents.debugger.off('detach', lease.onDetach);
      await turnOff(contents, lease);
    } finally {
      debugOff(contents, lease);
      unholdSends(contents);
    }
  });
}

function debugOff(contents: WebContents, lease: Lease): void {
  contents.off('render-process-gone', lease.onGone);
  if (contents.isDestroyed()) return;
  contents.debugger.off('message', lease.onMessage);
  contents.debugger.off('detach', lease.onDetach);
}

function ended(contents: WebContents, lease: Lease): void {
  for (const listener of ending) listener(contents, lease.owner);
}

/**
 * A lease's cleanup that runs once the next lease is already on (it was set up in the queue first): the next one is
 * left alone, and takes over Chord's attachment, to let go of when it ends (Neon's B4, round 3 of #147).
 */
function superseded(contents: WebContents, lease: Lease): boolean {
  const now = leases.get(contents);
  if (!now || now === lease || now.ended) return false;
  now.mine ||= lease.mine;
  return true;
}

/** Everything the lease turned on, off: Chord's own attachment detached, someone else's left as it was. */
async function turnOff(contents: WebContents, lease: Lease): Promise<void> {
  if (contents.isDestroyed()) return;
  const debug = contents.debugger;
  if (!debug.isAttached()) return;
  const quiet = (method: string, params: object = {}, sessionId?: string) => command(debug, method, params, sessionId).catch(() => undefined);
  // The service worker always back first (C3), whatever ended the lease, before anything else goes.
  for (const sessionId of [undefined, ...lease.sessions]) await quiet('Network.setBypassServiceWorker', { bypass: false }, sessionId);
  // #338: prints let go in every frame's documents (the hold's deadline over), whoever's attachment: a frame of
  // another site prints again with no reload (Fable's B1).
  await moveHold(debug, lease, 0, [undefined, ...lease.sessions]);
  if (lease.mine) {
    leftovers.delete(contents);
    return void debug.detach();
  }
  // Auto-attach off detaches what it attached; if it can't be turned off, those frames stay attached (and, once Fetch is
  // off there, unheld): the next lease holds them again.
  const off = await command(debug, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).then(
    () => true,
    () => false,
  );
  if (off) leftovers.delete(contents);
  else leftovers.set(contents, new Set(lease.sessions));
  // #338: the lease's own session on the page, and its binding, gone.
  await dropPrintSession(debug, lease);
  for (const sessionId of [...lease.sessions, undefined]) {
    await quiet('Fetch.disable', {}, sessionId);
    await quiet('Network.disable', {}, sessionId);
    // #338: Page.disable leaves scripts to run in new documents: taken out (Argon's SF2), and the binding off. Documents
    // they ran in keep them, asking each time, and nothing holds their print outside a lease (its deadline is over).
    for (const identifier of lease.printScripts.get(sessionId) ?? []) await quiet('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId);
    if (sessionId) {
      await quiet('Runtime.removeBinding', { name: printBinding(printTokenOf(contents)) }, sessionId);
      await quiet('Runtime.disable', {}, sessionId);
    }
    await quiet('Page.disable', {}, sessionId);
    await quiet('WebAuthn.disable', {}, sessionId);
    await quiet('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);
  }
}

/** `putBack`: the clipboard too (every end but your own input's). */
async function release(contents: WebContents, lease: Lease, putBack: boolean): Promise<void> {
  if (lease.ended) return;
  // Ended first: from here what the tab sends is yours (whose() says 'user'), and what was held for the assistant
  // fails now. The hold keeps answering until Fetch is off, so nothing of yours waits (Neon's B4 on #147).
  lease.ended = true;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = null;
  // An action still under way there (your hands mid-action) hears it as lost: deep.held() goes false (Claude's B1).
  if (lease.actions > 0) lost.add(contents);
  lease.cancel.abort();
  if (leases.get(contents) === lease) leases.delete(contents);
  failHeld(contents);
  ended(contents, lease);
  // Off before the clipboard's await (Neon's N3): an unload after the end isn't the assistant's.
  if (!contents.isDestroyed()) contents.off('will-prevent-unload', onUnload);
  if (putBack) await putBackClipboard(lease);
  if (contents.isDestroyed()) return void debugOff(contents, lease);
  await withDebugger(contents, async () => {
    if (superseded(contents, lease)) {
      // #338: its print scripts out (the new lease adds its own, and sets the deadline): never left to run in new
      // documents after the new lease ends (Opus's S1a).
      if (!contents.isDestroyed()) await removePrintScripts(contents.debugger, lease);
      return debugOff(contents, lease);
    }
    try {
      // Taken off only now: a detach from here on is this release's own.
      if (!contents.isDestroyed()) contents.debugger.off('detach', lease.onDetach);
      contents.off('render-process-gone', lease.onGone);
      await turnOff(contents, lease);
    } finally {
      debugOff(contents, lease);
      unholdSends(contents);
    }
  });
}
