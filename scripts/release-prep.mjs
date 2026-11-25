// The release commit's edits in one step (docs/releasing/patch-runbook.md §5; the chord-release skill), and the check
// release.yml runs on a tag that they were all made.
//
//   pnpm release:prep 0.14.2 --kind security            # version, Flatpak metainfo, a RELEASE_NOTES entry to fill in
//   pnpm release:prep 0.15.0 --date 2026-12-01 --lists   # and refresh the bundled ad-blocking lists
//   node scripts/release-prep.mjs --check 0.14.2         # every file says 0.14.2, and the notes entry is written
//
// The notes entry starts as a placeholder line (NOTES_TODO): --check fails until it's replaced with the release's
// words. A version that isn't newer than the app's, or that's been used before, is refused: updaters, package
// repositories and Flathub key on it (runbook §5).
//
// Pure parts are unit-tested in scripts/test/release-prep.test.ts.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = 'apps/desktop/package.json';
export const METAINFO = 'flatpak/io.github.anaremore.chord-browser.metainfo.xml';
export const NOTES = 'RELEASE_NOTES.md';
export const NOTES_TODO = '- **TODO: what this release brings, in DESIGN.md’s voice.**';
export const KINDS = ['preview', 'security'];

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1, 0 or 1, as a is older than, the same as, or newer than b. */
export function compareVersions(a, b) {
  const [x, y] = [VERSION.exec(a), VERSION.exec(b)];
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  return 0;
}

/** The app's version in package.json's text. */
export const packageVersion = (text) => JSON.parse(text).version;

/** package.json with its version changed, and nothing else (its formatting kept). */
export function setPackageVersion(text, version) {
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (packageVersion(next) !== version) throw new Error(`couldn't set the version in ${PACKAGE}`);
  return next;
}

/** The metainfo with a <release> for the version first in <releases>, indented as the others are. */
export function addMetainfoRelease(xml, version, date) {
  if (xml.includes(`<release version="${version}"`)) throw new Error(`${METAINFO} already has ${version}`);
  const m = /^([ \t]*)<releases>\r?\n([ \t]*)</m.exec(xml);
  if (!m) throw new Error(`no <releases> in ${METAINFO}`);
  const [, , inner] = m;
  const step = inner.slice(m[1].length);
  const release =
    `${inner}<release version="${version}" date="${date}" type="development">\n` +
    `${inner}${step}<url type="details">https://github.com/anaremore/chord-browser/blob/main/RELEASE_NOTES.md</url>\n` +
    `${inner}</release>\n`;
  const at = m.index + m[0].length - 1 - inner.length;
  return xml.slice(0, at) + release + xml.slice(at);
}

/** RELEASE_NOTES.md with the version's entry first: a heading and the placeholder line, before the newest entry. */
export function addNotesEntry(md, version, kind, date) {
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')} `, 'm').test(md)) throw new Error(`${NOTES} already has ${version}`);
  const at = md.search(/^## /m);
  if (at < 0) throw new Error(`no entries in ${NOTES}`);
  return `${md.slice(0, at)}## ${version} · ${kind} · ${date}\n\n${NOTES_TODO}\n\n${md.slice(at)}`;
}

/** What's missing for the version, file by file (empty when the release commit is complete). */
export function check({ pkg, xml, md }, version) {
  const problems = [];
  if (packageVersion(pkg) !== version) problems.push(`${PACKAGE} says ${packageVersion(pkg)}, not ${version}`);
  if (!xml.includes(`<release version="${version}"`)) problems.push(`${METAINFO} has no <release version="${version}">`);
  const entry = new RegExp(`^## ${version.replaceAll('.', '\\.')} · (\\S+) · (\\d{4}-\\d{2}-\\d{2})$`, 'm').exec(md);
  if (!entry) problems.push(`${NOTES} has no "## ${version} · <kind> · <date>" entry`);
  else if (!KINDS.includes(entry[1])) problems.push(`${NOTES}: "${entry[1]}" isn't one of ${KINDS.join(', ')}`);
  if (md.includes(NOTES_TODO)) problems.push(`${NOTES} still has the placeholder line: write what the release brings`);
  return problems;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function main(argv, root = resolve(import.meta.dirname, '..'), log = console.log) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const args = [...argv];
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const checking = flag('--check');
  if (checking !== null) {
    const problems = check({ pkg: read(PACKAGE), xml: read(METAINFO), md: read(NOTES) }, checking);
    for (const p of problems) log(`::error::${p}`);
    if (problems.length === 0) log(`The release commit for ${checking} is complete.`);
    return problems.length === 0 ? 0 : 1;
  }
  const kind = flag('--kind') ?? 'preview';
  const date = flag('--date') ?? today();
  const lists = args.includes('--lists');
  const version = args.find((a) => !a.startsWith('--'));
  if (!version || !VERSION.test(version)) throw new Error('usage: pnpm release:prep A.B.C [--kind preview|security] [--date YYYY-MM-DD] [--lists]');
  if (!KINDS.includes(kind)) throw new Error(`--kind is one of ${KINDS.join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date is YYYY-MM-DD');
  const current = packageVersion(read(PACKAGE));
  if (compareVersions(version, current) <= 0) throw new Error(`${version} isn't newer than the app's ${current}: never reuse a version`);
  // All three are checked before any is written: a refusal leaves the tree as it was.
  const pkg = setPackageVersion(read(PACKAGE), version);
  const xml = addMetainfoRelease(read(METAINFO), version, date);
  const md = addNotesEntry(read(NOTES), version, kind, date);
  writeFileSync(join(root, PACKAGE), pkg);
  writeFileSync(join(root, METAINFO), xml);
  writeFileSync(join(root, NOTES), md);
  if (lists) execFileSync('pnpm', ['--filter', '@chord/desktop', 'lists'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  log(`${current} → ${version} (${kind}, ${date}): ${PACKAGE}, ${METAINFO}, ${NOTES}${lists ? ', the ad-blocking lists' : ''}.`);
  log(`Next: replace the placeholder in ${NOTES} with what the release brings, then commit "chore(release): v${version}".`);
  log(`Check it: node scripts/release-prep.mjs --check ${version}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
