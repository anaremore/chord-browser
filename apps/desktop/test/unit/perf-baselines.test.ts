import { describe, expect, it } from 'vitest';
import { grew, launchLimit, memoryLimit, runnerKey, withMeasured, type Baselines } from '../e2e/baselines';

describe('performance baselines', () => {
  it('lets memory grow by 15% or 5 MB, whichever is more, and launch by 25%', () => {
    for (const [base, limit] of [
      [10, 15],
      [33.3, 38.3],
      [40, 46],
      [104, 119.6],
    ]) {
      expect(memoryLimit(base!)).toBe(limit);
    }
    expect(launchLimit(4)).toBe(5);
    expect(launchLimit(4.42)).toBe(5.53);
  });

  it('keys a CI baseline by OS and architecture, and on Linux by display server', () => {
    const ci = { CI: 'true' };
    expect(runnerKey('linux', 'x64', ci, 4)).toBe('linux-x64-x11');
    expect(runnerKey('linux', 'x64', { ...ci, WAYLAND_DISPLAY: 'wayland-chord' }, 4)).toBe('linux-x64-wayland');
    expect(runnerKey('linux', 'arm64', { ...ci, DISPLAY: ':99' }, 4)).toBe('linux-arm64-x11');
    expect(runnerKey('win32', 'arm64', { ...ci, WAYLAND_DISPLAY: 'x' }, 4)).toBe('win32-arm64');
  });

  it('keys the Linux container by its CPUs, and holds nothing elsewhere or on macOS', () => {
    expect(runnerKey('linux', 'x64', { CHORD_E2E_DISPLAY: 'x11' }, 4)).toBe('linux-x64-x11, container, 4 CPUs');
    expect(runnerKey('linux', 'x64', { CHORD_E2E_DISPLAY: 'wayland', WAYLAND_DISPLAY: 'wayland-chord' }, 24)).toBe('linux-x64-wayland, container, 24 CPUs');
    expect(runnerKey('win32', 'x64', {}, 24)).toBeNull();
    expect(runnerKey('linux', 'x64', { DISPLAY: ':0' }, 16)).toBeNull();
    expect(runnerKey('darwin', 'arm64', { CI: 'true' }, 3)).toBeNull();
  });

  it('says what grew, by how much, and how to take a new baseline', () => {
    const message = grew('The shell', 57.6, 27.2, 32.2, 'MB');
    expect(message).toContain('The shell grew from 27.2 to 57.6 MB (+30.4 MB, +112%)');
    expect(message).toContain('past its limit of 32.2 MB');
    expect(message).toContain('pnpm --filter @chord/desktop perf:baseline');
  });

  it("takes a run's numbers into its runner's entry, and leaves the others alone", () => {
    const before: Baselines = {
      'win32-x64': { from: 'CI run 1', date: '2026-10-01', launch: 3.9 },
      'linux-x64-x11': { from: 'CI run 1', date: '2026-10-01', launch: 4.4, memoryMb: { main: 104 } },
    };
    // Memory only (the launch test failed for another reason): the old launch stays.
    const after = withMeasured(before, { runner: 'linux-x64-x11', memoryMb: { main: 110 } }, 'Linux container', '2026-10-25');
    expect(after['linux-x64-x11']).toEqual({ from: 'Linux container', date: '2026-10-25', launch: 4.4, memoryMb: { main: 110 } });
    expect(after['win32-x64']).toBe(before['win32-x64']);
    expect(Object.keys(after)).toEqual(['linux-x64-x11', 'win32-x64']);
    // A runner seen for the first time.
    expect(withMeasured(before, { runner: 'darwin-arm64', launch: 5.1 }, 'CI run 2', '2026-10-25')['darwin-arm64']).toEqual({ from: 'CI run 2', date: '2026-10-25', launch: 5.1 });
    expect(before['linux-x64-x11']!.memoryMb).toEqual({ main: 104 });
  });
});
