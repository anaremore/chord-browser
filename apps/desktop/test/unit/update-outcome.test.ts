import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_FAILED_FILE, takeUpdateFailure } from '../../src/main/update-outcome';

const folders: string[] = [];
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});
function profile(): string {
  const f = mkdtempSync(join(tmpdir(), 'chord-update-outcome-'));
  folders.push(f);
  return f;
}

describe('a Windows update that setup couldn’t install (#142): what Chord says after setup reopens it', () => {
  it.each([
    ['agent\r\n', 'Chord couldn’t update: an agent connected to Chord was still using its files. Close the agent, then restart Chord to update.'],
    ['agent', 'Chord couldn’t update: an agent connected to Chord was still using its files. Close the agent, then restart Chord to update.'],
    ['other\r\n', 'Chord couldn’t update: another program was still using its files. Restart your computer, then open Chord to update.'],
    ['something else', 'Chord couldn’t update: another program was still using its files. Restart your computer, then open Chord to update.'],
  ])('setup wrote %j: says it, once', (written, message) => {
    const ud = profile();
    writeFileSync(join(ud, UPDATE_FAILED_FILE), written);
    expect(takeUpdateFailure(ud)).toBe(message);
    expect(existsSync(join(ud, UPDATE_FAILED_FILE))).toBe(false);
    expect(takeUpdateFailure(ud)).toBeNull();
  });

  it('no file (every other launch): nothing to say', () => {
    expect(takeUpdateFailure(profile())).toBeNull();
    expect(takeUpdateFailure(join(profile(), 'missing'))).toBeNull();
  });
});
