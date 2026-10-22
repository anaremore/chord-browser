import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userDataOverride } from '../../src/main/user-data';

const cwd = resolve('/work');

describe('userDataOverride', () => {
  it('uses the --user-data-dir value, resolved like Chromium does', () => {
    expect(userDataOverride(resolve('/tmp/chord-smoke'), undefined, cwd)).toBe(resolve('/tmp/chord-smoke'));
    expect(userDataOverride('profiles/a', undefined, cwd)).toBe(resolve(cwd, 'profiles/a'));
    expect(userDataOverride('profile with spaces', undefined, cwd)).toBe(resolve(cwd, 'profile with spaces'));
  });

  it('prefers the switch over the development variable', () => {
    expect(userDataOverride('from-switch', 'from-env', cwd)).toBe(resolve(cwd, 'from-switch'));
    expect(userDataOverride('', 'from-env', cwd)).toBe(resolve(cwd, 'from-env'));
  });

  it('means the default profile when neither is set, or the switch is empty', () => {
    expect(userDataOverride('', undefined, cwd)).toBeNull();
    expect(userDataOverride('', '', cwd)).toBeNull();
  });
});
