// Spike S9 runner: fetches the extensions if needed, then runs main.mjs in the
// repo's Electron once per mode, capturing Chromium's log for extension load
// warnings. Results land in spikes/s9-extensions/results/ (gitignored).
//
// Run: node spikes/s9-extensions/run.mjs [builtin] [lib] [lib-relaunch] [fork] [fork-relaunch]
//   builtin: Electron's own extension support only.
//   lib:     electron-chrome-extensions 4.9.0 (npm), installed into .cache/lib.
//   fork:    @iamevan/electron-chrome-extensions 4.9.5 (the iamEvanYT fork), in .cache/lib-fork.
//   *-relaunch reuses that run's profile, to see what extensions do on a second launch.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const repo = resolve(here, '..', '..');
const out = join(here, 'results');
mkdirSync(out, { recursive: true });

if (!existsSync(join(out, 'fetch.json'))) {
  await new Promise((done) => spawn(process.execPath, [join(here, 'fetch.mjs')], { stdio: 'inherit' }).on('exit', done));
}
const runs = process.argv.slice(2).length ? process.argv.slice(2) : ['builtin', 'lib', 'lib-relaunch', 'fork', 'fork-relaunch'];
if (runs.some((r) => r.startsWith('lib')) && !existsSync(join(here, '.cache', 'lib', 'node_modules', 'electron-chrome-extensions'))) {
  console.error('Library mode needs: npm install --prefix spikes/s9-extensions/.cache/lib electron-chrome-extensions@4.9.0');
  process.exit(1);
}
if (runs.some((r) => r.startsWith('fork')) && !existsSync(join(here, '.cache', 'lib-fork', 'node_modules', '@iamevan', 'electron-chrome-extensions'))) {
  console.error('Fork mode needs: npm install --prefix spikes/s9-extensions/.cache/lib-fork @iamevan/electron-chrome-extensions@4.9.5');
  process.exit(1);
}

const electron = createRequire(join(repo, 'apps', 'desktop', 'package.json'))('electron');
const profiles = {};
let port = 47391;

for (const label of runs) {
  const mode = label.startsWith('lib') ? 'lib' : label.startsWith('fork') ? 'fork' : 'builtin';
  // "<mode>-relaunch" reuses that mode's profile from earlier in the same invocation.
  const relaunchOf = label.endsWith('-relaunch') ? label.slice(0, -'-relaunch'.length) : null;
  const profile = relaunchOf ? profiles[relaunchOf] : (profiles[label] = mkdtempSync(join(tmpdir(), `chord-s9-${label}-`)));
  if (!profile) throw new Error(`${label} needs ${relaunchOf} to run first in the same invocation`);
  const file = join(out, `${label}.json`);
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`[S9] ${label}: Electron ${electron}`);
  const child = spawn(electron, [join(here, 'main.mjs'), mode, profile, file, String(port++)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const code = await new Promise((done) => child.on('exit', done));
  const warnings = [
    ...new Set(
      log
        .split(/\r?\n/)
        .filter((l) => /extension|manifest|permission|unrecognized|not (yet )?supported|unknown/i.test(l))
        .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').slice(0, 300)),
    ),
  ];
  const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ok: false, error: `no results (exit ${code})` };
  result.exitCode = code;
  result.chromiumLogExtensionLines = warnings.slice(0, 80);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`[S9] ${label}: exit ${code}, ok=${result.ok}, wrote ${file}`);
}

for (const dir of Object.values(profiles)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
