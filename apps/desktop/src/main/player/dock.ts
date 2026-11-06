/**
 * Chord Player in the tab (Windows; ARCHITECTURE.md §9, DESIGN.md §7.14;
 * spike S14 §2 (b)). The player's page sits in a borderless window of the
 * player's, glued over the tab's content area: placed on every move, resize
 * and layout, hidden whenever the tab isn't shown (another tab, another
 * chord, a minimized window), and swapped for a still picture of it whenever
 * Chord draws over the page (the command bar, Peek, a hover preview, an
 * extension's popup, the sidebar sliding over, a frame changing size).
 *
 * The window-owner helper (build/win/window-owner.cs) makes the player's
 * window an owned window of Chord's: only then does it stay above Chord's
 * window when you click Chord, minimize with it, and keep out of Alt+Tab and
 * the taskbar. A player from before docking answers `dock` with `unknown`,
 * and keeps the window of its own, as do macOS (its window server makes a
 * glued window trail) and Linux (Wayland has no window positions).
 */
import { parseHandle, type Rect } from '@chord/player-protocol';
import { execFile, execFileSync } from 'node:child_process';

/** Where one Chord window would put the player, as dockPlacement sees it. */
export interface DockWindow {
  id: string;
  /** Its HWND, as a decimal string. */
  handle: string;
  focused: boolean;
  /** Shown, and not minimized. */
  visible: boolean;
  /** The tab's content area on screen (DIPs), while the window shows the tab in place; null otherwise. */
  rect: Rect | null;
  /** Something of Chord's is drawn over the page: the player hides for it, leaving a still picture. */
  covered: boolean;
  /** The frame's corner radius, in DIPs: the player's window rounds its corners to match. */
  radius: number;
}

/** Where the player goes: over a window's tab (`bounds`), or hidden in it (`bounds` null). */
export interface Placement {
  windowId: string;
  owner: string;
  bounds: Rect | null;
  /** Hidden because something of Chord's covers the tab, not because the tab went away: a still picture stands in. */
  still: boolean;
  radius: number;
}

/**
 * Which window the player goes in, and where. The windows that show the tab
 * (`rect`), the focused one first; with none, it hides in the window it was
 * in (it stays owned there). Null: nowhere to be, not even hidden.
 */
export function dockPlacement(windows: readonly DockWindow[], previous: string | null): Placement | null {
  const showing = windows.filter((w) => w.rect && w.visible);
  const w = showing.find((x) => x.focused) ?? showing.find((x) => x.id === previous) ?? showing[0];
  if (w) return { windowId: w.id, owner: w.handle, bounds: w.covered ? null : w.rect, still: w.covered, radius: w.radius };
  const stay = windows.find((x) => x.id === previous) ?? windows[0];
  return stay ? { windowId: stay.id, owner: stay.handle, bounds: null, still: false, radius: stay.radius } : null;
}

export const samePlacement = (a: Placement | null, b: Placement | null): boolean =>
  a === b ||
  Boolean(
    a &&
      b &&
      a.windowId === b.windowId &&
      a.owner === b.owner &&
      a.still === b.still &&
      a.radius === b.radius &&
      (a.bounds === b.bounds || (a.bounds && b.bounds && a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height)),
  );

export interface DockDeps {
  /** The window-owner helper, or null where there's none (not Windows, or a development build without it). */
  helper: string | null;
  /** The player's process id, from its hello; 0 when it's not running. */
  playerPid(): number;
  /** Chord's own process id. */
  chordPid: number;
  /** Where each window would put the player, for its tab; empty when no tab plays in the player. */
  windows(): DockWindow[];
  request<T>(t: string, body: Record<string, unknown>): Promise<T | null>;
  /** Whether it docks changed (the frames show the tab as docked, or as playing in a window of its own). */
  changed(): void;
  /** Tests: the helper's runs. */
  setOwner?(helper: string, args: string[]): Promise<number>;
}

/** Runs the window-owner helper; its exit code (-1 if it didn't run). */
function runHelper(helper: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(helper, args, { windowsHide: true, timeout: 10_000 }, (error) => {
      if (!error) return resolve(0);
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve(typeof code === 'number' ? code : -1);
    });
  });
}

export class PlayerDock {
  /** Whether the running player docks: unknown until it answers its first `dock`. */
  private supported: boolean | null = null;
  private sent: Placement | null = null;
  /** The player window and the Chord window that owns it, as last set. */
  private owned: { handle: string; owner: string } | null = null;
  private enabled = false;

  constructor(private readonly deps: DockDeps) {}

  /** Windows with the helper, and a player that hasn't said it can't. */
  get available(): boolean {
    return Boolean(this.deps.helper) && this.supported !== false;
  }

  /** The player plays in its tab (or will, once it answers): the tab's frame shows it docked, not in a window of its own. */
  get docked(): boolean {
    return this.enabled && this.available;
  }

  /** Start docking (the player plays for a tab, and is ready), or stop (it's gone or released: undock it if it's still there). */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (this.available) this.deps.changed();
    if (on) return this.sync();
    const was = this.sent;
    this.sent = null;
    if (was && this.supported) void this.deps.request('undock', {});
  }

  /** A player started or stopped: what the next one can do is found out again. */
  reset(): void {
    const was = this.docked;
    this.supported = null;
    this.sent = null;
    this.owned = null;
    this.enabled = false;
    if (was) this.deps.changed();
  }

  /** Puts the player where the windows say, if that changed. Cheap: it runs on every move and layout. */
  sync(): void {
    if (!this.enabled || !this.available) return;
    const next = dockPlacement(this.deps.windows(), this.sent?.windowId ?? null);
    if (samePlacement(next, this.sent)) return;
    const was = this.sent;
    this.sent = next;
    if (next) void this.place(next);
    // No Chord window left to play in (it plays on, and Chord with it): back to a window of its own until there's one.
    else if (was && this.supported) {
      this.owned = null;
      void this.deps.request('undock', {});
    }
  }

  private async place(placement: Placement): Promise<void> {
    const answer = await this.deps.request<{ handle?: unknown }>('dock', { bounds: placement.bounds, still: placement.still, radius: placement.radius });
    const handle = parseHandle(answer?.handle);
    if (!handle) {
      // A player from before docking (or one that can't here): it keeps its window of its own.
      if (this.supported === null && answer !== undefined) {
        this.supported = false;
        this.sent = null;
        this.deps.changed();
      }
      return;
    }
    this.supported = true;
    if (this.owned?.handle === handle && this.owned.owner === placement.owner) return;
    const pid = this.deps.playerPid();
    if (!pid || !this.deps.helper) return;
    this.owned = { handle, owner: placement.owner };
    const run = this.deps.setOwner ?? runHelper;
    const code = await run(this.deps.helper, ['set', handle, String(pid), placement.owner, String(this.deps.chordPid)]);
    if (code !== 0) {
      console.warn(`[chord] Chord Player's window couldn't join Chord's (window-owner exited ${code})`);
      this.owned = null;
    }
  }

  /**
   * A Chord window is closing. Windows destroys a window's owned windows with it, so the player's
   * window must stop being this one's first: at once (the window is about to go), unowned, and the
   * next sync places it in another window, or hides it until there's one.
   */
  ownerClosing(owner: string): void {
    if (this.owned?.owner !== owner || !this.deps.helper) return;
    const { handle } = this.owned;
    this.owned = null;
    // Owned by none now: the next sync places it again (and owns it) wherever the tab is, even in this window if it stays.
    if (this.sent) this.sent = { ...this.sent, owner: '0' };
    const pid = this.deps.playerPid();
    if (!pid) return;
    try {
      if (this.deps.setOwner) void this.deps.setOwner(this.deps.helper, ['set', handle, String(pid), '0', '0']);
      else execFileSync(this.deps.helper, ['set', handle, String(pid), '0', '0'], { windowsHide: true, timeout: 5000 });
    } catch {
      // The player's window is gone already, or the helper failed: nothing more to do before the window closes.
    }
  }

  /** Tests: where things stand. */
  inspect(): Record<string, unknown> {
    return { supported: this.supported, enabled: this.enabled, sent: this.sent, owned: this.owned, helper: Boolean(this.deps.helper) };
  }
}
