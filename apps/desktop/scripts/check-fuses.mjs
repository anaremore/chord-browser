// Reads an installed Chord's Electron fuses back and fails unless each one that
// electron-builder.config.ts sets (electronFuses, ARCHITECTURE.md §14.1) reads
// as set. The release workflow runs it on each installed copy:
//
//   pnpm --filter @chord/desktop exec node scripts/check-fuses.mjs <app>
//
// <app> is Chord.exe, Chord.app or /opt/Chord/chord. @electron/fuses comes from
// the lockfile (the version electron-builder flips the fuses with), never npx.
import { pathToFileURL } from 'node:url';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const STATE = { 48: 'Disabled', 49: 'Enabled', 114: 'Removed' };
/** Fuses newer than this @electron/fuses, by index, so the log names them. */
const NEWER = { 8: 'WasmTrapHandlers' };

/** electronFuses' key, as @electron/fuses names the fuse: runAsNode → RunAsNode. */
export const fuseName = (key) => key[0].toUpperCase() + key.slice(1);

/**
 * Each fuse in `wire` (getCurrentFuseWire's result: index → state byte) as a line,
 * and a problem for each fuse `expected` (electronFuses) that doesn't read as set.
 */
export function checkFuses(wire, expected, options = FuseV1Options) {
  const lines = [];
  const problems = [];
  if (wire.version !== '1') problems.push(`fuse wire version ${wire.version}; this check knows version 1`);
  for (const index of Object.keys(wire).filter((key) => /^\d+$/.test(key))) {
    lines.push(`${options[index] ?? NEWER[index] ?? `Fuse ${index}`} is ${STATE[wire[index]] ?? `unknown (${wire[index]})`}`);
  }
  for (const [key, on] of Object.entries(expected)) {
    const name = fuseName(key);
    const index = options[name];
    if (typeof index !== 'number') {
      problems.push(`${name}: @electron/fuses doesn't know this fuse`);
      continue;
    }
    const want = on ? 'Enabled' : 'Disabled';
    const got = index in wire ? (STATE[wire[index]] ?? `unknown (${wire[index]})`) : 'missing from the binary';
    if (got !== want) problems.push(`${name} is ${got}; electron-builder.config.ts sets it ${want}`);
  }
  return { lines, problems };
}

async function main() {
  const app = process.argv[2];
  if (!app) {
    console.error('usage: node scripts/check-fuses.mjs <Chord.exe | Chord.app | chord>');
    process.exit(2);
  }
  // Only electronFuses is read. The config also works out how to sign from CHORD_SIGNING and
  // would ask for the signing credentials, which this step doesn't have (or need).
  process.env['CHORD_SIGNING'] = 'none';
  const { default: config } = await import(new URL('../electron-builder.config.ts', import.meta.url).href);
  const expected = config.electronFuses;
  if (!expected || Object.keys(expected).length === 0) {
    console.error('electron-builder.config.ts sets no electronFuses');
    process.exit(1);
  }
  const { lines, problems } = checkFuses(await getCurrentFuseWire(app), expected);
  console.log(`Fuses of ${app}:`);
  for (const line of lines) console.log(`  ${line}`);
  for (const problem of problems) console.log(`::error title=Electron fuses::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`All ${Object.keys(expected).length} fuses that electron-builder.config.ts sets read back as set.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
