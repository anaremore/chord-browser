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

  it('keeps privileged channels away from the wrong roles', () => {
    expect(invokeChannels['nav:command'].roles).not.toContain('popover');
    expect(invokeChannels['overlay:open'].roles).toEqual(['shell']);
    expect(invokeChannels['overlay:close'].roles).toEqual(['overlay']);
    expect(invokeChannels['cmd:dispatch'].roles).not.toContain('internal');
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
