/**
 * A Windows package never ships without window-owner.exe (#87): electron-builder's extraResources copy skips a missing
 * file without a word, so packaging stops before it starts (electron-builder.config.ts' beforePack). Never for macOS or
 * Linux, which carry no helper.
 */
import { describe, expect, it } from 'vitest';
import config, { packageBlocker, WINDOW_OWNER } from '../../electron-builder.config';

describe('packaging needs window-owner.exe on Windows', () => {
  it.each([
    ['win32', false, true],
    ['win32', true, false],
    ['darwin', false, false],
    ['linux', false, false],
  ] as const)('%s, the helper built: %s → stopped: %s', (platform, built, stopped) => {
    const blocker = packageBlocker(platform, (path) => path === WINDOW_OWNER && built);
    expect(blocker !== null).toBe(stopped);
    if (blocker) expect(blocker).toContain('window-owner.exe is missing');
  });

  it('the config stops a Windows package without it, before anything is packed', () => {
    const beforePack = config.beforePack as (context: { electronPlatformName: string }) => unknown;
    expect(typeof beforePack).toBe('function');
    // Linux never needs it, whatever's built.
    expect(() => beforePack({ electronPlatformName: 'linux' })).not.toThrow();
  });
});
