// The release workflow's fuse check (scripts/check-fuses.mjs): it fails a release whose installed copy's fuses
// don't read back as electron-builder.config.ts sets them.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, untyped
import { checkFuses, fuseName } from '../../scripts/check-fuses.mjs';
import config from '../../electron-builder.config';

const DISABLE = 48;
const ENABLE = 49;
const fuses = config.electronFuses as Record<string, boolean>;

/** The wire a correctly packaged Chord reads back: each configured fuse as set, WasmTrapHandlers (8) left on. */
function packaged(): Record<string, string | number> {
  const wire: Record<string, string | number> = { version: '1', 8: ENABLE };
  const options = ['runAsNode', 'enableCookieEncryption', 'enableNodeOptionsEnvironmentVariable', 'enableNodeCliInspectArguments', 'enableEmbeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar', 'loadBrowserProcessSpecificV8Snapshot', 'grantFileProtocolExtraPrivileges'];
  options.forEach((key, i) => (wire[i] = fuses[key] ? ENABLE : DISABLE));
  return wire;
}

describe('check-fuses', () => {
  it('reads the fuses the config sets, including the ones that matter most', () => {
    expect(fuses).toMatchObject({ runAsNode: false, onlyLoadAppFromAsar: true, enableCookieEncryption: true, enableEmbeddedAsarIntegrityValidation: true });
    expect(fuseName('runAsNode')).toBe('RunAsNode');
  });

  it('passes a copy whose fuses read back as set, and names every fuse', () => {
    const { lines, problems } = checkFuses(packaged(), fuses);
    expect(problems).toEqual([]);
    expect(lines).toContain('RunAsNode is Disabled');
    expect(lines).toContain('OnlyLoadAppFromAsar is Enabled');
    expect(lines).toContain('WasmTrapHandlers is Enabled');
  });

  it.each([
    [0, ENABLE, 'RunAsNode is Enabled; electron-builder.config.ts sets it Disabled'],
    [1, DISABLE, 'EnableCookieEncryption is Disabled; electron-builder.config.ts sets it Enabled'],
    [5, DISABLE, 'OnlyLoadAppFromAsar is Disabled; electron-builder.config.ts sets it Enabled'],
    [4, 114, 'EnableEmbeddedAsarIntegrityValidation is Removed; electron-builder.config.ts sets it Enabled'],
  ])('fails when fuse %i reads %i', (index, state, problem) => {
    const wire = { ...packaged(), [index]: state };
    expect(checkFuses(wire, fuses).problems).toEqual([problem]);
  });

  it('fails a fuse the binary lacks, one @electron/fuses doesn’t know, and another wire version', () => {
    const short = packaged();
    delete short[7];
    expect(checkFuses(short, fuses).problems).toEqual(['GrantFileProtocolExtraPrivileges is missing from the binary; electron-builder.config.ts sets it Disabled']);
    expect(checkFuses(packaged(), { ...fuses, someFutureFuse: true }).problems).toEqual(["SomeFutureFuse: @electron/fuses doesn't know this fuse"]);
    expect(checkFuses({ ...packaged(), version: '2' }, fuses).problems).toEqual(['fuse wire version 2; this check knows version 1']);
  });
});
