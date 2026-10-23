/**
 * The .rpm (electron-builder.config.ts, rpm). Its post-install script is
 * electron-builder's with Chord's names written in and one change, so when a
 * new electron-builder changes its script, this fails until ours catches up.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../electron-builder.config';

const require = createRequire(import.meta.url);
const ours = readFileSync(resolve(import.meta.dirname, '../../build/linux/rpm-after-install.sh'), 'utf8');
const theirs = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/linux/after-install.tpl'), 'utf8');

const productName = config.productName!;
const executable = config.linux!.executableName!;
const rpm = config.rpm!;
const fpm = rpm.fpm ?? [];
/** The value after an fpm flag. */
const fpmValue = (flag: string) => fpm[fpm.indexOf(flag) + 1];
/** A script without its opening comment block. */
const body = (script: string) => script.slice(script.indexOf('\n\n') + 2);

describe('the .rpm', () => {
  it('is built for Linux, under the same package name as the .deb', () => {
    expect(config.linux?.target).toContain('rpm');
    expect(rpm.packageName).toBe('chord');
    expect(config.deb?.packageName).toBe(rpm.packageName);
  });

  it('installs chrome-sandbox setuid root, and owns its folder, at the path electron-builder installs to', () => {
    expect(fpmValue('--rpm-attr')).toBe(`4755,root,root:/opt/${productName}/chrome-sandbox`);
    expect(fpmValue('--directories')).toBe(`/opt/${productName}`);
  });

  it('runs its install script on upgrades too, so the old package’s remove script runs only on uninstall', () => {
    expect(rpm.afterInstall).toBeTruthy();
    expect(fpmValue('--after-upgrade')).toBe(rpm.afterInstall);
  });

  it('runs electron-builder’s post-install script, apart from the chrome-sandbox mode', () => {
    const sandbox = /\n# Check if user namespaces are supported[^\n]*\n[\s\S]*?chmod 0755 [^\n]*\nfi\n/;
    expect(theirs, 'electron-builder’s script no longer sets the chrome-sandbox mode the way rpm-after-install.sh assumes').toMatch(sandbox);
    const expected = theirs.replace(sandbox, '').replaceAll('${executable}', executable).replaceAll('${sanitizedProductName}', productName);
    expect(body(ours)).toBe(body(expected));
    expect(body(ours)).not.toContain('chrome-sandbox');
    // fpm uses the file as is for upgrades, so nothing in it may be left for electron-builder to fill in.
    expect(ours).not.toMatch(/\$\{[a-zA-Z]+\}/);
  });
});
