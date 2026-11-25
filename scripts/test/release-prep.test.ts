import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addMetainfoRelease, addNotesEntry, check, compareVersions, main, METAINFO, NOTES, NOTES_TODO, PACKAGE, packageVersion, setPackageVersion } from '../release-prep.mjs';

const repo = resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the three files the release commit changes, as they are in the repo now. */
function copy(): string {
  const root = mkdtempSync(join(tmpdir(), 'chord-release-prep-'));
  dirs.push(root);
  for (const path of [PACKAGE, METAINFO, NOTES]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  }
  return root;
}

/**
 * A version above every one the files name (the app's, each metainfo <release>, each notes heading), its patch one
 * more: never one a release already used, whatever state the repo's own files are in (a patch's notes ported to main
 * before the app's version moves, as #138 did for 0.14.1).
 */
function unusedVersion({ pkg, xml, md }: { pkg: string; xml: string; md: string }): string {
  const named = [packageVersion(pkg), ...[...xml.matchAll(/<release version="(\d+\.\d+\.\d+)"/g)].map((m) => m[1]!), ...[...md.matchAll(/^## (\d+\.\d+\.\d+) /gm)].map((m) => m[1]!)];
  const top = named.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const [major, minor, patch] = top.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

const files = (root: string) => ({ pkg: readFileSync(join(root, PACKAGE), 'utf8'), xml: readFileSync(join(root, METAINFO), 'utf8'), md: readFileSync(join(root, NOTES), 'utf8') });

describe('the release commit’s edits', () => {
  it.each([
    ['0.14.1', '0.14.0', 1],
    ['0.14.0', '0.14.0', 0],
    ['0.9.9', '0.10.0', -1],
    ['1.0.0', '0.99.99', 1],
  ])('%s against %s: %i', (a, b, n) => expect(compareVersions(a, b)).toBe(n));

  it('sets package.json’s version and nothing else', () => {
    const text = '{\n  "name": "@chord/desktop",\n  "version": "0.14.0",\n  "devDependencies": { "x": "1.0.0" }\n}\n';
    expect(setPackageVersion(text, '0.14.1')).toBe(text.replace('"0.14.0"', '"0.14.1"'));
  });

  it('puts the <release> first, indented as the others', () => {
    const xml = '<component>\n  <releases>\n    <release version="0.14.0" date="2026-11-22" type="development">\n      <url type="details">u</url>\n    </release>\n  </releases>\n</component>\n';
    const next = addMetainfoRelease(xml, '0.14.1', '2026-11-24');
    expect(next).toBe(
      '<component>\n  <releases>\n' +
        '    <release version="0.14.1" date="2026-11-24" type="development">\n      <url type="details">https://github.com/anaremore/chord-browser/blob/main/RELEASE_NOTES.md</url>\n    </release>\n' +
        '    <release version="0.14.0" date="2026-11-22" type="development">\n      <url type="details">u</url>\n    </release>\n  </releases>\n</component>\n',
    );
    expect(() => addMetainfoRelease(next, '0.14.1', '2026-11-24')).toThrow(/already has 0.14.1/);
  });

  it('puts the notes entry first, under the introduction, with the placeholder', () => {
    const md = '# Release notes\n\nNewest first.\n\n## 0.14.0 · preview · 2026-11-22\n\n- Agents.\n';
    expect(addNotesEntry(md, '0.14.1', 'security', '2026-11-24')).toBe(`# Release notes\n\nNewest first.\n\n## 0.14.1 · security · 2026-11-24\n\n${NOTES_TODO}\n\n## 0.14.0 · preview · 2026-11-22\n\n- Agents.\n`);
    expect(() => addNotesEntry(md, '0.14.0', 'preview', '2026-11-24')).toThrow(/already has 0.14.0/);
  });

  it('on the repo’s own files: writes all three, the check wants the notes written, then passes', () => {
    const root = copy();
    const current = packageVersion(files(root).pkg);
    const next = unusedVersion(files(root));
    const logged: string[] = [];
    expect(main([next, '--kind', 'security', '--date', '2026-12-01'], root, (l: string) => logged.push(l))).toBe(0);
    const made = files(root);
    expect(packageVersion(made.pkg)).toBe(next);
    expect(made.xml).toContain(`<release version="${next}" date="2026-12-01" type="development">`);
    expect(made.md).toContain(`## ${next} · security · 2026-12-01\n\n${NOTES_TODO}`);
    expect(check(made, next)).toEqual([`${NOTES} still has the placeholder line: write what the release brings`]);
    expect(main(['--check', next], root, (l: string) => logged.push(l))).toBe(1);
    const written = made.md.replace(NOTES_TODO, '- **Security.** Updates Electron.');
    expect(check({ ...made, md: written }, next)).toEqual([]);
    // The repo's own release commit as it stands is complete for its version.
    expect(check(files(repo), current)).toEqual([]);
  });

  it('picks a version for itself that the files don’t name yet, even with a later patch’s notes already in', () => {
    const pkg = '{ "version": "0.14.0" }';
    const xml = '<releases>\n  <release version="0.14.1" date="d"/>\n  <release version="0.14.0" date="d"/>\n</releases>';
    const md = '## 0.14.1 · security · 2026-11-24\n\n## 0.14.0 · preview · 2026-11-22\n';
    expect(unusedVersion({ pkg, xml, md })).toBe('0.14.2');
    expect(unusedVersion({ pkg: '{ "version": "0.15.0" }', xml, md })).toBe('0.15.1');
  });

  it('refuses a version a release already used, though it’s newer than the app’s (a patch from a release branch)', () => {
    const root = copy();
    const before = files(root);
    // The repo's own files as main has them after a patch's notes were ported (#138): 0.14.1 in the notes and the
    // metainfo, the app still 0.14.0. release:prep 0.14.1 there must refuse, and write nothing.
    const pkg = setPackageVersion(before.pkg, '0.14.0');
    const xml = before.xml.includes('<release version="0.14.1"') ? before.xml : addMetainfoRelease(before.xml, '0.14.1', '2026-11-24');
    writeFileSync(join(root, PACKAGE), pkg);
    writeFileSync(join(root, METAINFO), xml);
    expect(() => main(['0.14.1'], root, () => {})).toThrow(/already has 0\.14\.1/);
    expect(files(root)).toEqual({ ...before, pkg, xml });
  });

  it('refuses a version that isn’t newer, and changes nothing when it does', () => {
    const root = copy();
    const before = files(root);
    const current = packageVersion(before.pkg);
    expect(() => main([current], root, () => {})).toThrow(/isn't newer/);
    expect(() => main(['0.0.1'], root, () => {})).toThrow(/isn't newer/);
    expect(() => main(['9.9.9', '--kind', 'major'], root, () => {})).toThrow(/--kind/);
    expect(files(root)).toEqual(before);
  });
});
