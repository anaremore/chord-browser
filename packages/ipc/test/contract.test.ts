import { describe, expect, it } from 'vitest';
import { RendererCommand, SystemInfo, invokeChannels } from '../src';

describe('IPC contract', () => {
  it('rejects unknown nav actions', () => {
    const schema = invokeChannels['nav:command'].request;
    expect(schema.safeParse({ action: 'back' }).success).toBe(true);
    expect(schema.safeParse({ action: 'rm -rf' }).success).toBe(false);
  });

  it('accepts renderer commands and refuses engine-only ones', () => {
    expect(RendererCommand.safeParse({ t: 'tab.open', windowId: 'w', url: 'https://example.com' }).success).toBe(true);
    expect(RendererCommand.safeParse({ t: 'tab.activate', windowId: 'w', nodeId: 'n', touch: false }).success).toBe(true);
    // Only the engine reports titles, favicons and loading state.
    expect(RendererCommand.safeParse({ t: 'tab.updated', nodeId: 'n', title: 'spoofed' }).success).toBe(false);
    expect(RendererCommand.safeParse({ t: 'tab.live', nodeId: 'n', live: { loading: true } }).success).toBe(false);
    expect(RendererCommand.safeParse({ t: 'tab.open', windowId: 'w', url: '' }).success).toBe(false);
  });

  it('runs only actions that exist in the shortcut registry', () => {
    const schema = invokeChannels['action:run'].request;
    expect(schema.safeParse({ action: 'view.toggleSidebar' }).success).toBe(true);
    expect(schema.safeParse({ action: 'app.format' }).success).toBe(false);
    expect(schema.safeParse({ action: 42 }).success).toBe(false);
  });

  it('accepts only known settings, engines and in-range themes', () => {
    const set = invokeChannels['settings:set'].request;
    expect(set.safeParse({ searchEngine: 'kagi', motion: { sidebar: false } }).success).toBe(true);
    expect(set.safeParse({ searchEngine: 'evil.example' }).success).toBe(false);
    expect(set.safeParse({ motion: { warp: true } }).success).toBe(false);
    expect(set.safeParse({ telemetry: true }).success).toBe(false);
    const theme = invokeChannels['settings:theme'].request;
    expect(theme.safeParse({ chordId: 'c', theme: { grain: 0.4, appearance: 'dark' } }).success).toBe(true);
    expect(theme.safeParse({ chordId: 'c', theme: { grain: 7 } }).success).toBe(false);
    expect(theme.safeParse({ chordId: 'c', theme: { stops: [] } }).success).toBe(false);
  });

  it('lets Settings open only https links', () => {
    const open = invokeChannels['settings:openUrl'].request;
    expect(open.safeParse({ url: 'https://github.com/anaremore/chord-browser' }).success).toBe(true);
    expect(open.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(open.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(invokeChannels['settings:set'].roles).toEqual(['internal']);
  });

  it('accepts chord commands with sane names, icons and themes, but never deletion', () => {
    const theme = { stops: [{ l: 0.72, c: 0.1, h: 165 }], grain: 0.2, appearance: 'auto' };
    expect(RendererCommand.safeParse({ t: 'chord.create', windowId: 'w', name: 'Work', icon: '♪', theme }).success).toBe(true);
    expect(RendererCommand.safeParse({ t: 'chord.create', windowId: 'w', name: 'x'.repeat(65), icon: '♪', theme }).success).toBe(false);
    expect(RendererCommand.safeParse({ t: 'chord.create', windowId: 'w', name: 'W', icon: '', theme }).success).toBe(false);
    expect(RendererCommand.safeParse({ t: 'chord.goto', windowId: 'w', index: 9 }).success).toBe(false);
    expect(RendererCommand.safeParse({ t: 'chord.delete', chordId: 'c' }).success).toBe(false);
  });

  it('keeps privileged channels away from the wrong roles', () => {
    expect(invokeChannels['nav:command'].roles).not.toContain('popover');
    expect(invokeChannels['overlay:open'].roles).toEqual(['shell']);
    expect(invokeChannels['overlay:close'].roles).toEqual(['overlay']);
    expect(invokeChannels['cmd:dispatch'].roles).not.toContain('internal');
  });

  it("gives reader views their own channels, and only the reader's controls to change", () => {
    for (const channel of ['reader:page', 'reader:look', 'reader:ready', 'reader:set', 'reader:close'] as const) expect(invokeChannels[channel].roles).toEqual(['reader']);
    // A reader view can't reach the store, other tabs or settings.
    for (const channel of ['cmd:dispatch', 'state:snapshot', 'settings:set', 'nav:command', 'action:run'] as const) expect(invokeChannels[channel].roles).not.toContain('reader');
    const set = invokeChannels['reader:set'].request;
    expect(set.safeParse({ size: 3, theme: 'sepia' }).success).toBe(true);
    expect(set.safeParse({ size: 6 }).success).toBe(false);
    expect(set.safeParse({ size: 1.5 }).success).toBe(false);
    expect(set.safeParse({ theme: 'neon' }).success).toBe(false);
    expect(set.safeParse({ searchEngine: 'kagi' }).success).toBe(false);
  });

  it("gives developer tools' controls to the shell and their window's bar only, with sane sizes", () => {
    expect(invokeChannels['devtools:do'].roles).toEqual(['shell', 'devtools']);
    expect(invokeChannels['devtools:bar'].roles).toEqual(['devtools']);
    // Their window's bar can't reach the store, tabs, settings or other actions.
    for (const channel of ['cmd:dispatch', 'state:snapshot', 'settings:set', 'nav:command', 'action:run', 'focus:move'] as const) expect(invokeChannels[channel].roles).not.toContain('devtools');
    const act = invokeChannels['devtools:do'].request;
    expect(act.safeParse({ do: 'close', nodeId: 'n' }).success).toBe(true);
    expect(act.safeParse({ do: 'side', side: 'bottom' }).success).toBe(true);
    expect(act.safeParse({ do: 'resize', size: 480, done: false }).success).toBe(true);
    expect(act.safeParse({ do: 'side', side: 'left' }).success).toBe(false);
    expect(act.safeParse({ do: 'resize', size: -1, done: true }).success).toBe(false);
    expect(act.safeParse({ do: 'resize', size: 480 }).success).toBe(false);
    expect(act.safeParse({ do: 'open', nodeId: 'n' }).success).toBe(false);
  });

  it('validates system info', () => {
    const ok = SystemInfo.safeParse({
      platform: 'win32',
      appearance: 'dark',
      accentColor: '#0078d4',
      prefersReducedMotion: false,
      prefersReducedTransparency: false,
      forcedColors: false,
      material: 'translucent',
      windowChrome: { kind: 'overlay', height: 40, reservedWidth: 138, side: 'right' },
    });
    expect(ok.success).toBe(true);
  });
});
