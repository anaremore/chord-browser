import { describe, expect, it } from 'vitest';
import { eventChannels, invokeChannels, SystemInfo } from '../src';

describe('IPC contract', () => {
  it('rejects unknown nav actions', () => {
    const schema = invokeChannels['nav:command'].request;
    expect(schema.safeParse({ action: 'back' }).success).toBe(true);
    expect(schema.safeParse({ action: 'rm -rf' }).success).toBe(false);
    expect(schema.safeParse({ action: 'back', extra: 1 }).success).toBe(true); // extra keys stripped, not trusted
  });

  it('never grants the shell-only nav channel to popovers', () => {
    expect(invokeChannels['nav:command'].roles).not.toContain('popover');
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
    expect(Object.keys(eventChannels)).toContain('tab:state');
  });
});
