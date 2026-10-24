// Spike S11 runner: compiles the lists both ways, measures the engine in Node,
// then runs main.mjs in the repo's Electron once per mode and round, and the
// lifecycle phases of the rules on one profile. Results land in
// spikes/s11-ad-blocking/results/ (gitignored), with summary.json.
//
// Electron opens windows (hidden ones, but still), so this runs only on a
// virtual display: in the Linux container (run-linux.mjs) or on CI, never on
// your desktop.
//
//   node spikes/s11-ad-blocking/run.mjs <lists folder> [--rounds 2] [--loads 15]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.on('unhandledRejection', (e) => {
  console.error(e);
  process.exit(1);
});

const here = import.meta.dirname;
const out = join(here, 'results');
mkdirSync(out, { recursive: true });
const argv = process.argv.slice(2);
const lists = resolve(argv[0] ?? '');
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const rounds = Number(option('--rounds', 2));
const loads = option('--loads', '15');

for (const step of ['build.mjs', 'engine.mjs']) {
  const r = spawnSync(process.execPath, [join(here, step), lists], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const electron = createRequire(join(here, '..', '..', 'apps', 'desktop', 'package.json'))('electron');
let port = 47411;

async function electronRun(label, args, userData) {
  const file = join(out, `${label}.json`);
  rmSync(file, { force: true });
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(here, 'main.mjs'), `--out=${file}`, `--user-data=${userData}`, `--port=${port++}`, `--loads=${loads}`, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const code = await new Promise((done) => child.on('exit', done));
  const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ok: false, error: `no results (exit ${code})` };
  result.exitCode = code;
  result.chromiumLog = [...new Set(log.split(/\r?\n/).filter((l) => /declarative|ruleset|extension|manifest/i.test(l)).map((l) => l.slice(0, 300)))].slice(0, 40);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`[S11] ${label}: exit ${code}, ok=${result.ok}${result.error ? `, ${result.error.split('\n')[0]}` : ''}`);
  return result;
}

// --lifecycle-only skips the page loads (rounds 0).
const modes = argv.includes('--lifecycle-only') ? [] : ['none', 'engine-main', 'engine-worker', 'dnr'];
const runs = {};
for (let r = 1; r <= rounds; r++) {
  for (const busy of [false, true]) {
    for (const mode of modes) {
      const label = `${mode}${busy ? '-busy' : ''}-r${r}`;
      const profile = mkdtempSync(join(tmpdir(), 'chord-s11-'));
      try {
        runs[label] = await electronRun(label, [`--mode=${mode}`, ...(busy ? ['--busy'] : [])], profile);
      } finally {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      }
    }
  }
}

// The rules' lifecycle, on one profile: first launch, relaunch, rules replaced in place, relaunch.
const profile = mkdtempSync(join(tmpdir(), 'chord-s11-life-'));
const lifecycle = {};
try {
  for (const phase of ['dnr-first', 'dnr-relaunch', 'dnr-replaced', 'dnr-relaunch', 'dnr-newfolder']) {
    const label = phase in lifecycle ? `${phase}-2` : phase;
    lifecycle[label] = (await electronRun(label, [`--mode=${phase}`], profile)).lifecycle ?? null;
  }
} finally {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

// The summary: each mode's median over its rounds.
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const summary = { build: JSON.parse(readFileSync(join(out, 'build', 'build.json'), 'utf8')), engine: JSON.parse(readFileSync(join(out, 'engine.json'), 'utf8')), modes: {}, lifecycle };
for (const busy of [false, true]) {
  for (const mode of modes) {
    const these = Object.entries(runs).filter(([label]) => label.startsWith(`${mode}${busy ? '-busy' : ''}-r`)).map(([, r]) => r).filter((r) => r.ok);
    if (!these.length) continue;
    const pick = (fn) => median(these.map(fn));
    summary.modes[`${mode}${busy ? ' (busy main)' : ''}`] = {
      loadMs: pick((r) => r.loads.loadMs.p50),
      settledMs: pick((r) => r.loads.settledMs.p50),
      requestsServed: pick((r) => r.loads.requestsServed.p50),
      mainCpuMs: pick((r) => r.loads.mainCpuMs.p50),
      elu: pick((r) => r.loads.elu.p50),
      delayP99Ms: pick((r) => r.loads.delayP99Ms.p50),
      delayMaxMs: pick((r) => r.loads.delayMaxMs.p50),
      callbacksPerPage: pick((r) => r.loads.callbacks.p50),
      callbackMsPerPage: pick((r) => r.loads.callbackTotalMs.p50),
      callbackP50Us: pick((r) => r.loads.callbackP50Us.p50),
      callbackP99Us: pick((r) => r.loads.callbackP99Us.p50),
      firstLoad: { mainCpuMs: pick((r) => r.firstLoad.mainCpuMs), callbackMs: pick((r) => r.firstLoad.callbackTotalMs), callbackP99Us: pick((r) => r.firstLoad.callbackP99Us), requestsServed: pick((r) => r.firstLoad.requestsServed) },
      memory: these.at(-1).memory,
      startup: these.at(-1).startup ?? null,
    };
  }
}
// Which hosts got through on the first load, by mode: the two ways of blocking should agree.
const served = (label) => runs[label]?.firstLoad?.hostsServed ?? {};
const a = served('engine-main-r1');
const b = served('dnr-r1');
summary.agreement = {
  onlyEngineLetThrough: Object.keys(a).filter((h) => !(h in b)),
  onlyRulesLetThrough: Object.keys(b).filter((h) => !(h in a)),
  differentCounts: Object.keys(a).filter((h) => h in b && a[h] !== b[h]).map((h) => `${h}: engine ${a[h]}, rules ${b[h]}`),
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ modes: summary.modes, agreement: summary.agreement, lifecycle }, null, 2));
