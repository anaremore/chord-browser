import { describe, expect, it } from 'vitest';
import { dockPlacement, PlayerDock, samePlacement, type DockWindow } from '../../src/main/player/dock';

const rect = { x: 100, y: 80, width: 1200, height: 700 };
const win = (w: Partial<DockWindow> & { id: string }): DockWindow => ({ handle: `${w.id.length}0`, focused: false, visible: true, rect, covered: false, radius: 8, ...w });

describe('where the docked player goes', () => {
  it('goes over the tab in the window that shows it', () => {
    expect(dockPlacement([win({ id: 'a', rect: null }), win({ id: 'b', handle: '77' })], null)).toEqual({ windowId: 'b', owner: '77', bounds: rect, still: false, radius: 8 });
  });

  it('prefers the focused window, then the one it was in', () => {
    const other = { ...rect, x: 2000 };
    const windows = [win({ id: 'a' }), win({ id: 'b', rect: other })];
    expect(dockPlacement(windows, 'b')?.windowId).toBe('b');
    expect(dockPlacement([win({ id: 'a' }), win({ id: 'b', rect: other, focused: true })], 'a')?.windowId).toBe('b');
  });

  it('hides, with a still picture, while something of Chord’s covers the tab', () => {
    expect(dockPlacement([win({ id: 'a', covered: true })], 'a')).toMatchObject({ windowId: 'a', bounds: null, still: true });
  });

  it('hides without one when the tab isn’t shown, staying in its window', () => {
    expect(dockPlacement([win({ id: 'a', rect: null }), win({ id: 'b', rect: null })], 'b')).toMatchObject({ windowId: 'b', bounds: null, still: false });
    // A minimized window shows nothing.
    expect(dockPlacement([win({ id: 'a', visible: false })], 'a')).toMatchObject({ bounds: null, still: false });
    expect(dockPlacement([], 'a')).toBeNull();
  });

  it('compares placements by value', () => {
    const a = dockPlacement([win({ id: 'a' })], null);
    expect(samePlacement(a, dockPlacement([win({ id: 'a', rect: { ...rect } })], null))).toBe(true);
    expect(samePlacement(a, dockPlacement([win({ id: 'a', rect: { ...rect, width: 1201 } })], null))).toBe(false);
    expect(samePlacement(a, null)).toBe(false);
  });
});

/** A dock over fake windows and a fake player that answers `dock` with its window's handle (or doesn't know it). */
function setup({ answers = true, helper = 'window-owner.exe' as string | null } = {}) {
  let windows: DockWindow[] = [win({ id: 'a', handle: '500' })];
  const requests: { t: string; body: Record<string, unknown> }[] = [];
  const owners: string[][] = [];
  let changes = 0;
  const dock = new PlayerDock({
    helper,
    chordPid: 10,
    playerPid: () => 20,
    windows: () => windows,
    request: async <T>(t: string, body: Record<string, unknown>) => {
      requests.push({ t, body });
      return (answers && t === 'dock' ? { handle: '900' } : null) as T | null;
    },
    changed: () => changes++,
    setOwner: async (_helper, args) => {
      owners.push(args);
      return 0;
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { dock, requests, owners, settle, changes: () => changes, setWindows: (next: DockWindow[]) => (windows = next) };
}

describe('the docked player', () => {
  it('docks once enabled, and makes its window Chord’s owned window', async () => {
    const { dock, requests, owners, settle } = setup();
    dock.sync();
    expect(requests).toEqual([]);
    dock.setEnabled(true);
    await settle();
    expect(requests).toEqual([{ t: 'dock', body: { bounds: rect, still: false, radius: 8 } }]);
    expect(owners).toEqual([['set', '900', '20', '500', '10']]);
    expect(dock.docked).toBe(true);
  });

  it('sends only changes, and sets the owner again only for another window', async () => {
    const { dock, requests, owners, settle, setWindows } = setup();
    dock.setEnabled(true);
    await settle();
    dock.sync();
    dock.sync();
    expect(requests).toHaveLength(1);
    setWindows([win({ id: 'a', handle: '500', rect: { ...rect, x: 140 } })]);
    dock.sync();
    await settle();
    expect(requests).toHaveLength(2);
    expect(owners).toHaveLength(1);
    // The tab moved to another window: that one owns the player now.
    setWindows([win({ id: 'a', handle: '500', rect: null }), win({ id: 'b', handle: '600' })]);
    dock.sync();
    await settle();
    expect(owners.at(-1)).toEqual(['set', '900', '20', '600', '10']);
  });

  it('asks for a still picture when covered, not when the tab goes away', async () => {
    const { dock, requests, settle, setWindows } = setup();
    dock.setEnabled(true);
    await settle();
    setWindows([win({ id: 'a', handle: '500', covered: true })]);
    dock.sync();
    expect(requests.at(-1)?.body).toMatchObject({ bounds: null, still: true });
    setWindows([win({ id: 'a', handle: '500', rect: null })]);
    dock.sync();
    expect(requests.at(-1)?.body).toMatchObject({ bounds: null, still: false });
  });

  it('leaves a player from before docking in its own window', async () => {
    const { dock, requests, owners, settle, changes } = setup({ answers: false });
    dock.setEnabled(true);
    await settle();
    expect(dock.available).toBe(false);
    expect(dock.docked).toBe(false);
    expect(owners).toEqual([]);
    expect(changes()).toBeGreaterThan(0);
    dock.sync();
    expect(requests).toHaveLength(1);
  });

  it('never docks without the helper (macOS, Linux, a build without it)', () => {
    const { dock, requests } = setup({ helper: null });
    dock.setEnabled(true);
    expect(requests).toEqual([]);
    expect(dock.docked).toBe(false);
  });

  it('undocks when it stops playing in the tab, and starts over for the next player', async () => {
    const { dock, requests, settle } = setup();
    dock.setEnabled(true);
    await settle();
    dock.setEnabled(false);
    expect(requests.at(-1)?.t).toBe('undock');
    expect(dock.docked).toBe(false);
    dock.reset();
    expect(dock.inspect()).toMatchObject({ supported: null, sent: null, owned: null });
  });
});

describe('the docked player when windows close', () => {
  it('lets go of a closing window that owns it, and goes to a window of its own when none is left', async () => {
    const { dock, requests, owners, settle, setWindows } = setup();
    dock.setEnabled(true);
    await settle();
    dock.ownerClosing('999');
    expect(owners).toHaveLength(1);
    dock.ownerClosing('500');
    expect(owners.at(-1)).toEqual(['set', '900', '20', '0', '0']);
    setWindows([]);
    dock.sync();
    expect(requests.at(-1)?.t).toBe('undock');
    // A window again: docked there, and owned by it.
    setWindows([win({ id: 'c', handle: '700' })]);
    dock.sync();
    await settle();
    expect(requests.at(-1)?.t).toBe('dock');
    expect(owners.at(-1)).toEqual(['set', '900', '20', '700', '10']);
  });
});
