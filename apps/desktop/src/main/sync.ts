/**
 * Sync, main's side (docs/decisions/S15-your-data.md §3, §6–§8, §13), which
 * only routes (performance rules 1 and 4): chord-data's thread owns sync's
 * tables and its worker thread the folder. Main:
 *
 * - keeps the root key with safeStorage's async API (the Keychain, DPAPI, the
 *   secret service), reads it once after launch and hands it to chord-data.
 *   Linux with no secret store (`basic_text`) keeps none: sync asks for the
 *   passphrase after each launch, in Settings and in a quiet toast;
 * - shows the system's folder picker, and keeps the folder (a renderer names
 *   it by an id, never a path);
 * - applies what other computers changed (`sync.apply`, a part at a time,
 *   Effects through their service and its sanitizer), putting off anything
 *   with a change of yours still waiting to be written, and asking for it
 *   again once it's written;
 * - puts a quiet toast in a window when a chord another computer deleted was
 *   on screen there or had tabs only this computer has (they move to another
 *   chord), with Undo, and a toast once for a problem that needs you;
 * - holds *Turn off* and *Remove* for their toast's Undo (6 s), so Undo has
 *   nothing to write.
 */
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
  emptyApply,
  sortedChords,
  syncParts,
  syncWaiting,
  uuidv7,
  type FolderInspection,
  type SiteEffects,
  type State,
  type SyncApply,
  type SyncStatus,
  type WindowId,
  type Command,
} from '@chord/core';
import type { DataPush, SyncInfo, SyncReply, SyncRequest } from '@chord/data';
import { ImportedSettings, type SyncFolderResult, type SyncStepResult, type SyncView, type Toast } from '@chord/ipc';
import { dialog, safeStorage, type BaseWindow, type OpenDialogOptions } from 'electron';

/** Turning off and removing wait for their Undo this long: a toast's time (ARCHITECTURE.md §6.3). */
const UNDO_MS = 6000;
/** Chord coming to the front looks at the folder, at most this often. */
const FOCUS_MS = 30_000;
/** Between two parts of what another computer changed: two frames at 60 Hz, so main and the renderers each take one part at a time with room to spare. */
const PART_GAP_MS = 33;
/** After an apply that failed, chord-data is asked for what isn't applied again after this long, doubling up to RECONCILE_MAX. */
const RECONCILE_MS = 5000;
const RECONCILE_MAX = 5 * 60_000;

export interface SyncServiceOptions {
  data: {
    sync(request: SyncRequest): Promise<SyncReply>;
    flush(): Promise<void>;
    /** Writes chord-data refused, or never answered (it exited mid-write), so far: what was applied is confirmed only with none more. */
    failures(): number;
    /** Whether a change of yours to this entity (`node:<id>`) is waiting to be written, or being written. */
    waiting(key: string): boolean;
    onPush(listener: (push: DataPush) => void): void;
  };
  state(): State;
  dispatch(command: Command): void;
  effects: { syncSites(sites: SiteEffects[], gone: string[]): Promise<void> };
  toast(windowId: WindowId, toast: Toast): void;
  /** The window a toast goes to: the last normal one. */
  lastWindow(): WindowId | null;
  /** Settings hears where sync stands. */
  notify(view: SyncView): void;
  info(): SyncInfo;
  platform: NodeJS.Platform;
  /** Where the folder picker starts. */
  folder(): string;
  /** Tests only (never when packaged): safeStorage taken as having no keyring behind it, as Linux's `basic_text`, on any system. */
  noKeyring?: boolean;
}

/** What an apply did: what it put off for a change of yours, what waits on something not here yet, and whether chords or folders came. */
interface Applied {
  later: Set<string>;
  waiting: string[];
  grew: boolean;
}

interface Pending {
  token: string;
  what: 'off' | 'remove';
  device?: string;
  until: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SyncService {
  private status: SyncStatus | null = null;
  private keyKept = false;
  /** Kept with no keyring behind it (`basic_text`), because you asked to remember it anyway. */
  private keyWeak = false;
  private anyway = false;
  /** Until the key kept here has been read after launch, sync isn't asking for the passphrase, and doesn't say it is. */
  private opening = true;
  /** The key kept here couldn't be read: this profile may be a copy of another computer's, so unlocking takes a new id. */
  private unbound = false;
  private chosen: { id: string; path: string } | null = null;
  private pending: Pending | null = null;
  private readonly toasted = new Set<string>();
  private lastFocus = 0;
  /** Whether a Chord window is in front, as chord-data last heard it. */
  private front = true;
  /** Pushes are applied one at a time, in order. */
  private applying: Promise<void> = Promise.resolve();
  private reconcileMs = 0;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SyncServiceOptions) {
    options.data.onPush((push) => {
      if (push.push === 'sync.status') this.setStatus(push.status);
      else
        this.applying = this.applying
          .then(async () => {
            const failures = this.options.data.failures();
            await this.confirm(push.versions, await this.apply(push.apply), failures);
          })
          .then(() => {
            this.reconcileMs = 0;
          })
          .catch((error: unknown) => {
            // Nothing's lost: what isn't applied stays different from what chord-data merged, and it's asked for again.
            console.error('Sync couldn’t apply a change:', error);
            this.reconcileLater();
          });
    });
  }

  /* ---------- the key ---------- */

  /** Whether this computer can keep the key: safeStorage with a real store behind it, not Linux's `basic_text`. */
  private async keyring(): Promise<boolean> {
    if (this.options.noKeyring) return false;
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      return this.options.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
    } catch {
      return false;
    }
  }

  /**
   * The root key, kept by safeStorage (never the passphrase). With no secret
   * store, nothing is kept, unless you asked to remember it anyway (S15
   * question 6): then safeStorage's `basic_text`, which any program you run
   * could read, and Settings says so.
   */
  private async keep(key: Uint8Array | undefined): Promise<void> {
    if (!key) return;
    let blob: string | null = null;
    const strong = await this.keyring();
    if (strong || this.anyway) {
      try {
        blob = (await safeStorage.encryptStringAsync(Buffer.from(key).toString('base64'))).toString('base64');
      } catch (error) {
        console.error('Sync couldn’t keep its key:', error);
      }
    }
    this.keyKept = blob !== null;
    this.keyWeak = blob !== null && !strong;
    await this.options.data.sync({ type: 'sync.keyBlob', blob });
  }

  /** *Remember the key on this computer anyway* (Linux without a keyring), or forget it again. */
  async rememberAnyway(on: boolean): Promise<SyncView> {
    if (await this.keyring()) return this.view();
    this.anyway = on;
    if (on) {
      const answer = await this.options.data.sync({ type: 'sync.key' });
      await this.keep(answer.key);
      answer.key?.fill(0);
    } else {
      await this.options.data.sync({ type: 'sync.keyBlob', blob: null });
      this.keyKept = false;
      this.keyWeak = false;
    }
    this.options.notify(this.view());
    return this.view();
  }

  /**
   * Applied, and written back: chord-data hears which versions, so it never
   * pushes them again, even what this computer will always keep otherwise
   * (tidied, refused, or put at the top for a cycle). Not what waits on
   * something not here yet (`waiting`: a tab whose chord or folder comes
   * later), nor what was put off for a change of yours (`later`): those come
   * again. Only once every write of the store's since the apply began is in,
   * acknowledged by chord-data: one it refused (a full disk), or one its crash
   * cut off, confirms nothing, and the apply is asked for again later. Then,
   * chords or folders having come, what waited on them is pushed again.
   */
  private async confirm(versions: Record<string, string> | undefined, outcome: Applied, failures: number): Promise<void> {
    const waiting = new Set(outcome.waiting);
    const confirmed = Object.fromEntries(Object.entries(versions ?? {}).filter(([key]) => !waiting.has(key)));
    if (Object.keys(confirmed).length > 0) {
      await this.options.data.flush();
      if (this.options.data.failures() !== failures) throw new Error('A write of what sync applied didn’t land');
      await this.options.data.sync({ type: 'sync.applied', versions: confirmed, later: [...outcome.later] });
    }
    if (outcome.grew) await this.options.data.sync({ type: 'sync.reconcile' });
  }

  /** chord-data pushes again what it merged but this computer hasn't applied: later and later after each failure. */
  private reconcileLater(): void {
    this.reconcileMs = Math.min(RECONCILE_MAX, Math.max(RECONCILE_MS, this.reconcileMs * 2));
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => void this.options.data.sync({ type: 'sync.reconcile' }).catch(() => this.reconcileLater()), this.reconcileMs);
  }

  /**
   * After launch (after the first page): where sync stands, and the key handed
   * to chord-data if this computer kept one. Without one, sync waits for the
   * passphrase, and says so once. Until then it says nothing of a passphrase:
   * with a key kept, it needs none.
   */
  async afterLaunch(): Promise<void> {
    this.opening = true;
    try {
      await this.openKept();
    } finally {
      this.opening = false;
      // Still locked (no key kept, or one that couldn't be read): now Settings asks, and the toast says so.
      if (this.status) this.setStatus(this.status);
    }
  }

  private async openKept(): Promise<void> {
    const answer = await this.options.data.sync({ type: 'sync.status' }).catch(() => ({}) as SyncReply);
    if (answer.status) this.setStatus(answer.status);
    // What was merged but never applied (a quit or a crash during a pass or an apply): pushed now, key or not.
    if (answer.status && answer.status.state !== 'off') void this.options.data.sync({ type: 'sync.reconcile' }).catch(() => this.reconcileLater());
    if (answer.status?.state !== 'locked' || !answer.keyBlob) return;
    try {
      const opened = await safeStorage.decryptStringAsync(Buffer.from(answer.keyBlob, 'base64'));
      const key = new Uint8Array(Buffer.from(opened.result, 'base64'));
      if (key.length !== 32) throw new Error('not a key');
      this.keyKept = true;
      // Kept with no keyring: you asked for it, and it goes on being kept so.
      this.keyWeak = this.anyway = !(await this.keyring());
      const started = await this.options.data.sync({ type: 'sync.start', key, info: this.options.info() });
      key.fill(0);
      if (started.status) this.setStatus(started.status);
      if (opened.shouldReEncrypt) await this.keep(new Uint8Array(Buffer.from(opened.result, 'base64')));
    } catch (error) {
      // DPAPI, the Keychain and a secret service keep a key for this computer only: one that can't be read here is
      // likely a profile copied from another computer, which must not go on writing as it.
      console.error('Sync couldn’t read its key:', error);
      this.keyKept = false;
      this.unbound = true;
    }
  }

  /** chord-data started again after a crash: it read nothing, and holds no key. */
  async restarted(): Promise<void> {
    await this.afterLaunch();
  }

  /* ---------- where it stands ---------- */

  view(): SyncView {
    const status = this.status ?? { state: 'off', problem: null, folder: null, computers: [], lastChange: null, pending: 0, ahead: [], changedBy: null, removedAt: null, capped: 0, refused: 0, tooMany: false, cluttered: false, stuck: [], blocked: [], choosing: null };
    return {
      ...status,
      folderName: status.folder ? basename(status.folder) : null,
      keyKept: this.keyKept,
      keyWeak: this.keyWeak,
      opening: this.opening && status.state === 'locked',
      pendingUndo: this.pending ? { what: this.pending.what, token: this.pending.token, until: this.pending.until, ...(this.pending.device ? { device: this.pending.device } : {}) } : null,
    };
  }

  async refresh(): Promise<SyncView> {
    const answer = await this.options.data.sync({ type: 'sync.status' }).catch(() => ({}) as SyncReply);
    if (answer.status) this.setStatus(answer.status);
    return this.view();
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.options.notify(this.view());
    // A problem that needs you gets a toast, once (S15 §8). Locked only once the key kept here, if any, has been tried.
    const kind = status.state === 'locked' ? (this.opening ? null : 'locked') : status.state === 'problem' ? status.problem : null;
    if (!kind || this.toasted.has(kind)) return;
    this.toasted.add(kind);
    const windowId = this.options.lastWindow();
    if (!windowId) return;
    const message = PROBLEM_TOASTS[kind];
    if (message) this.options.toast(windowId, { id: `sync:${kind}`, message, action: { label: 'Sync settings', command: { t: 'sync.open' } } });
  }

  /* ---------- Settings' steps ---------- */

  /** The system's folder picker; the folder is then this session's, named by an id. */
  async chooseFolder(parent: BaseWindow | null): Promise<SyncFolderResult> {
    if (this.status && this.status.state !== 'off' && this.status.problem !== 'removed') return { ok: false, problem: 'busy' };
    const options: OpenDialogOptions = { title: 'Choose a folder to sync through', defaultPath: this.options.folder(), properties: ['openDirectory', 'createDirectory'] };
    const chosen = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const path = chosen.filePaths[0];
    if (chosen.canceled || !path) return { ok: false, problem: 'cancelled' };
    this.chosen = { id: uuidv7(), path };
    const answer = await this.options.data.sync({ type: 'sync.inspect', folder: path });
    const inspection: FolderInspection = answer.inspection ?? { state: 'damaged' };
    return { ok: true, folderId: this.chosen.id, name: basename(path), inspection };
  }

  private folderOf(folderId: string): string | null {
    return this.chosen?.id === folderId ? this.chosen.path : null;
  }

  private stepResult(answer: SyncReply): SyncStepResult {
    if (answer.status) this.setStatus(answer.status);
    return answer.problem ? { ok: false, problem: answer.problem } : { ok: true, view: this.view() };
  }

  /** The first computer: a passphrase for the folder, and this computer's setup in it. */
  async setup(folderId: string, passphrase: string): Promise<SyncStepResult> {
    const folder = this.folderOf(folderId);
    if (!folder) return { ok: false, problem: 'missing' };
    await this.options.data.flush();
    const answer = await this.options.data.sync({ type: 'sync.setup', folder, passphrase, info: this.options.info() });
    await this.keep(answer.key);
    answer.key?.fill(0);
    return this.stepResult(answer);
  }

  /**
   * Another computer joins: the passphrase opens the folder, and its logs are
   * read. A clearly fresh Chord takes the synced setup without asking;
   * otherwise Settings asks (`choosing`).
   */
  async join(folderId: string, passphrase: string): Promise<SyncStepResult> {
    const folder = this.folderOf(folderId);
    if (!folder) return { ok: false, problem: 'missing' };
    await this.options.data.flush();
    const answer = await this.options.data.sync({ type: 'sync.join', folder, passphrase, info: this.options.info() });
    if (answer.problem) return this.stepResult(answer);
    await this.keep(answer.key);
    answer.key?.fill(0);
    if (answer.fresh) return this.choose('synced', true);
    return this.stepResult(answer);
  }

  /** Joining, decided: the synced setup replaces this computer's chords (with Undo), or both stay side by side. */
  async choose(mode: 'synced' | 'both', fresh = false): Promise<SyncStepResult> {
    await this.options.data.flush();
    const answer = await this.options.data.sync({ type: 'sync.choose', mode });
    if (answer.problem) return this.stepResult(answer);
    const apply = answer.apply;
    const failures = this.options.data.failures();
    const outcomes: Applied[] = [];
    if (answer.replace && apply) {
      // The synced chords first, so there's one to make way for; then every chord of this computer's that isn't the
      // synced setup's makes way, kept for Undo (one another computer deleted too, so the Undo covers everything);
      // then the rest of the synced setup.
      outcomes.push(await this.apply({ ...emptyApply(), chords: apply.chords }, true));
      const keep = new Set(answer.replace.keep);
      const state = this.options.state();
      const mine = sortedChords(state).filter((c) => !c.private && !keep.has(c.id));
      if (mine.length > 0 && state.chords[answer.replace.to]) {
        this.options.dispatch({ t: 'sync.replace', chordIds: mine.map((c) => c.id), to: answer.replace.to });
        const windowId = this.options.lastWindow();
        // A fresh Chord's first-run chord just makes way; a computer's own chords go with Undo.
        if (windowId && !fresh) {
          const n = mine.length;
          this.options.toast(windowId, {
            id: 'sync:replaced',
            message: n === 1 ? `“${mine[0]!.name}” made way for the synced setup` : `This computer’s ${n} chords made way for the synced setup`,
            action: { label: 'Undo', command: { t: 'sync.unreplace', windowId, chordIds: mine.map((c) => c.id) } },
          });
        }
      }
      outcomes.push(await this.apply({ ...apply, chords: [] }, true));
    } else if (apply) outcomes.push(await this.apply(apply, true));
    // Joining holds nothing back for a change of yours; what waits on something not here yet (a chord no computer has) comes again.
    const outcome: Applied = { later: new Set(outcomes.flatMap((o) => [...o.later])), waiting: outcomes.flatMap((o) => o.waiting), grew: outcomes.some((o) => o.grew) };
    if (apply) await this.confirm(answer.versions, outcome, failures).catch((error: unknown) => console.error('Sync couldn’t confirm what it applied:', error));
    return this.stepResult(answer);
  }

  /** The passphrase, once: after launch with no key kept, or after it changed on another computer. */
  async unlock(passphrase: string): Promise<SyncStepResult> {
    const answer = await this.options.data.sync({ type: 'sync.unlock', passphrase, info: this.options.info(), ...(this.unbound ? { rebind: true } : {}) });
    if (answer.key) this.unbound = false;
    await this.keep(answer.key);
    answer.key?.fill(0);
    return this.stepResult(answer);
  }

  /**
   * A lost passphrase (S15 §6, *Start over*): a new one, and this computer's
   * setup in the folder under it. The synced copy under the old one can't be
   * opened; what's on each computer stays, and the others pause until they
   * have the new one.
   */
  async startOver(passphrase: string): Promise<SyncStepResult> {
    const answer = await this.options.data.sync({ type: 'sync.startOver', passphrase, info: this.options.info() });
    await this.keep(answer.key);
    answer.key?.fill(0);
    return this.stepResult(answer);
  }

  /** The folder moved (*Chord can't find the sync folder*): the system's folder picker, and the folder it's in now, if it's this sync's. */
  async relocate(parent: BaseWindow | null): Promise<SyncStepResult> {
    const options: OpenDialogOptions = { title: 'Choose the sync folder', defaultPath: this.status?.folder ?? this.options.folder(), properties: ['openDirectory'] };
    const chosen = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const path = chosen.filePaths[0];
    if (chosen.canceled || !path) return { ok: true, view: this.view() };
    return this.stepResult(await this.options.data.sync({ type: 'sync.relocate', folder: path }));
  }

  /** A new passphrase: the next generation; the other computers pause until they have it. */
  async changePassphrase(passphrase: string): Promise<SyncStepResult> {
    const answer = await this.options.data.sync({ type: 'sync.passphrase', passphrase });
    await this.keep(answer.key);
    answer.key?.fill(0);
    return this.stepResult(answer);
  }

  async rename(name: string): Promise<SyncView> {
    const answer = await this.options.data.sync({ type: 'sync.rename', name });
    if (answer.status) this.setStatus(answer.status);
    return this.view();
  }

  async pause(paused: boolean): Promise<SyncView> {
    const answer = await this.options.data.sync({ type: 'sync.pause', paused });
    if (answer.status) this.setStatus(answer.status);
    return this.view();
  }

  /** *Turn off* or *Remove*: it happens when its Undo runs out, so Undo has nothing to write (S15 §8). */
  hold(what: 'off' | 'remove', device?: string): SyncView {
    this.cancelPending();
    const token = randomBytes(12).toString('hex');
    const timer = setTimeout(() => void this.carryOut(token), UNDO_MS);
    this.pending = { token, what, until: Date.now() + UNDO_MS, timer, ...(device ? { device } : {}) };
    const windowId = this.options.lastWindow();
    const name = device ? (this.status?.computers.find((c) => c.id === device)?.name ?? 'That computer') : '';
    if (windowId) {
      this.options.toast(windowId, { id: 'sync:pending', message: what === 'off' ? 'Sync turns off on this computer' : `${name} will be removed from sync`, action: { label: 'Undo', command: { t: 'sync.undo', token } } });
    }
    this.options.notify(this.view());
    return this.view();
  }

  undo(token: string): SyncView {
    if (this.pending?.token === token) this.cancelPending();
    this.options.notify(this.view());
    return this.view();
  }

  private cancelPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private async carryOut(token: string): Promise<void> {
    const pending = this.pending;
    if (pending?.token !== token) return;
    this.pending = null;
    const answer = pending.what === 'off' ? await this.options.data.sync({ type: 'sync.off' }) : await this.options.data.sync({ type: 'sync.remove', device: pending.device ?? '' });
    if (pending.what === 'off') {
      this.keyKept = this.keyWeak = this.anyway = false;
      this.toasted.clear();
    }
    if (answer.status) this.setStatus(answer.status);
    else this.options.notify(this.view());
  }

  /** Chord came to the front: look at the folder (at most every 30 s). */
  /** No Chord window is in front any more (one lost focus, and none took it). */
  blurred(): void {
    this.inFront(false);
  }

  /** chord-data hears when Chord comes to the front or goes behind, once each way: the folder's watch follows on Windows. */
  private inFront(front: boolean): void {
    if (this.front === front) return;
    this.front = front;
    if (this.status && this.status.state !== 'off') void this.options.data.sync({ type: 'sync.front', front }).catch(() => undefined);
  }

  focused(): void {
    this.inFront(true);
    if (this.status?.state !== 'on' || Date.now() - this.lastFocus < FOCUS_MS) return;
    this.lastFocus = Date.now();
    void this.options.data.sync({ type: 'sync.check' }).catch(() => undefined);
  }

  /** Quitting: what's waiting goes to the folder now (within the 2 s quitting allows); a step held for Undo is let go. */
  async quit(): Promise<void> {
    this.cancelPending();
    if (this.status?.state === 'on') await this.options.data.sync({ type: 'sync.flush' }).catch(() => undefined);
  }

  /* ---------- applying ---------- */

  /**
   * What another computer changed, applied a part at a time, each its own
   * store change, marked as sync's (persistence saves it without a stamp).
   * A thing with a change of yours still waiting to be written is put off: its
   * write gets its stamp first, then chord-data sends what's merged again.
   */
  private async apply(apply: SyncApply, joining = false): Promise<Applied> {
    const isWaiting = this.options.data.waiting;
    // A split goes with its panes: one of them put off puts off the lot, or the store would settle the split without it.
    const groups = new Map<string, string[]>();
    for (const node of apply.nodes) {
      const group = node.kind === 'split' ? node.id : node.kind === 'tab' && node.parentId && apply.nodes.some((n) => n.id === node.parentId && n.kind === 'split') ? node.parentId : null;
      if (group) groups.set(group, [...(groups.get(group) ?? []), node.id]);
    }
    const heldGroups = new Set([...groups].filter(([, ids]) => ids.some((id) => isWaiting(`node:${id}`))).flatMap(([, ids]) => ids.map((id) => `node:${id}`)));
    const waiting = (key: string) => heldGroups.has(key) || isWaiting(key);
    const later = new Set<string>();
    const hold = <T>(list: T[], key: (item: T) => string) =>
      list.filter((item) => {
        if (joining || !waiting(key(item))) return true;
        later.add(key(item));
        return false;
      });
    // A chord that went, put off: its nodes' tombstones wait with it, so it takes them with it (kept for Undo) when it goes.
    const state = this.options.state();
    const heldChords = new Set(apply.gone.chords.filter((id) => !joining && waiting(`chord:${id}`)));
    const withChord = (n: { id: string }) => heldChords.has(state.nodes[n.id]?.chordId ?? '');
    const filtered: SyncApply = {
      ...apply,
      chords: hold(apply.chords, (c) => `chord:${c.id}`),
      nodes: hold(apply.nodes, (n) => `node:${n.id}`),
      favorites: hold(apply.favorites, (f) => `favorite:${f.id}`),
      themes: apply.themes.length > 0 && !joining && waiting('setting:themes') ? (later.add('setting:themes'), []) : apply.themes,
      routes: hold(apply.routes, (r) => `linkRoute:${r.host}`),
      gone: {
        ...apply.gone,
        chords: hold(apply.gone.chords, (id) => `chord:${id}`),
        nodes: hold(apply.gone.nodes, (n) => `node:${n.id}`).filter((n) => !withChord(n) || (later.add(`node:${n.id}`), false)),
        favorites: hold(apply.gone.favorites, (id) => `favorite:${id}`),
        routes: hold(apply.gone.routes, (host) => `linkRoute:${host}`),
      },
      effects: hold(apply.effects, (s) => `effect:${s.host}`),
    };
    if (apply.settings && !joining && Object.keys(apply.settings).some((key) => waiting(`setting:${key}`))) {
      filtered.settings = null;
      for (const key of Object.keys(apply.settings)) later.add(`setting:${key}`);
    }
    // Settings pass the schema Settings' own changes pass (as an import's), then settings.set's checks.
    if (filtered.settings) {
      const checked = ImportedSettings.safeParse(filtered.settings);
      filtered.settings = checked.success ? checked.data : null;
    }
    // What each window shows, and what's only this computer's in each chord that may go (its Today tabs, and any open
    // tab), to say where it went.
    const before = this.options.state();
    const shown = Object.values(before.windows).map((w) => ({ windowId: w.id, chordId: w.activeChordId }));
    const going = filtered.gone.chords
      .filter((id) => before.chords[id])
      .map((id) => ({ id, name: before.chords[id]!.name, local: Object.values(before.nodes).filter((n) => n.chordId === id && n.kind === 'tab' && (n.section === 'today' || before.live[n.id])).map((n) => n.id) }));
    // Input and painting go first between parts, two frames apart, the first too (not in the task that brought the push). Nothing here is urgent.
    for (const part of syncParts(filtered)) {
      await new Promise((resolve) => setTimeout(resolve, PART_GAP_MS));
      this.options.dispatch({ t: 'sync.apply', ...part });
    }
    if (filtered.effects.length > 0 || filtered.gone.effects.length > 0) await this.options.effects.syncSites(filtered.effects, filtered.gone.effects);
    const after = this.options.state();
    // What couldn't apply as it came, for something not here yet (the reducer's own rule): not confirmed, so it comes again.
    const outstanding = syncWaiting(after, filtered);
    const grew = filtered.chords.some((c) => !before.chords[c.id] && after.chords[c.id]) || filtered.nodes.some((n) => n.kind !== 'tab' && !before.nodes[n.id] && after.nodes[n.id]);
    // Pinned tabs and folders another computer took away (their chord stays): a quiet toast, with Undo.
    const undoBefore = new Set(before.syncUndo.map((e) => e.id));
    const removed = after.syncUndo.filter((e) => e.nodesOnly && !undoBefore.has(e.id) && e.nodes.length > 0);
    const removedCount = removed.reduce((n, e) => n + e.nodes.length, 0);
    const toastTo = this.options.lastWindow();
    if (removedCount > 0 && toastTo) {
      const only = removedCount === 1 ? removed[0]!.nodes[0]! : null;
      const name = only ? (only.kind === 'tab' ? only.customTitle || only.title : only.kind === 'folder' ? only.title : '') : '';
      this.options.toast(toastTo, {
        id: `sync:removed:${removed[0]!.id}`,
        message: name ? `“${name}” was removed on another computer` : `${removedCount} pinned tabs and folders were removed on another computer`,
        action: { label: 'Undo', command: { t: 'sync.unreplace', windowId: toastTo, chordIds: [...new Set(removed.map((e) => e.chord.id))] } },
      });
    }
    // A chord another computer deleted: a quiet toast where it was on screen, or wherever its tabs went, with Undo.
    for (const gone of going) {
      if (after.chords[gone.id]) continue;
      const moved = gone.local.filter((id) => after.nodes[id]);
      const to = moved[0] ? after.chords[after.nodes[moved[0]]!.chordId]?.name : undefined;
      const windowId = shown.find((s) => s.chordId === gone.id && after.windows[s.windowId])?.windowId ?? (moved.length > 0 ? this.options.lastWindow() : null);
      if (!windowId) continue;
      const tabs = moved.length === 1 ? 'Its tab' : `Its ${moved.length} tabs`;
      this.options.toast(windowId, {
        id: `sync:gone:${gone.id}`,
        message: to ? `“${gone.name}” was deleted on another computer. ${tabs} moved to “${to}”.` : `“${gone.name}” was deleted on another computer`,
        action: { label: 'Undo', command: { t: 'sync.unreplace', windowId, chordIds: [gone.id] } },
      });
    }
    if (later.size > 0) {
      await this.options.data.flush();
      await this.options.data.sync({ type: 'sync.repush', keys: [...later] }).catch(() => undefined);
    }
    return { later, waiting: outstanding, grew };
  }
}

const PROBLEM_TOASTS: Record<string, string> = {
  locked: 'Sync is paused. Enter your passphrase to keep syncing.',
  changed: 'Sync has a new passphrase. Enter it to keep syncing.',
  missing: 'Chord can’t find the sync folder. Is your sync app running?',
  unwritable: 'Chord couldn’t write to the sync folder. Your changes wait here, and it tries again.',
  copies: 'Another computer keeps writing to the sync folder as this one. Sync stopped writing here.',
  unreadable: 'Chord couldn’t take in changes from the sync folder. It tries again in a few minutes.',
  stalled: 'The sync folder isn’t answering. Chord tries again in a few minutes.',
  newer: 'Another computer has a newer Chord. Update this one to keep syncing.',
  removed: 'This computer was removed from sync.',
  conflict: 'Sync was set up on two computers at once. Set it up on one, then join from the others.',
};
