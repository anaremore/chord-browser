import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    const [major, minor, patch] = current.split('.').map(Number);
    const next = `${major}.${minor}.${patch! + 1}`;
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
