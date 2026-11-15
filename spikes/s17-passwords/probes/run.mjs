#!/usr/bin/env node
// Spike S17 M0: runs the Electron probes (main.mjs), one launch each, and writes
// results/probes/*.json and results/probes/summary.json. Electron opens windows, so this
// runs only on a virtual display: the Linux container (run-linux.mjs probes) or CI
// (s17-ci.yml), never on a desktop. Builds Chord first if its preloads aren't built,
// since questions 5 and 6 measure Chord's own preloads with the sentinel beside them.
//
//   node spikes/s17-passwords/probes/run.mjs [--only world,card,frames,preload] [--rounds 5] [--wayland]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startServer } from './server.mjs';

const here = import.meta.dirname;
const spike = join(here, '..');
const root = join(spike, '..', '..');
const outDir = join(spike, 'results', 'probes');
mkdirSync(outDir, { recursive: true });
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const only = new Set(option('--only', 'world,card,frames,preload').split(','));
const rounds = Number(option('--rounds', 5));
const wayland = argv.includes('--wayland');

if (!existsSync(join(root, 'apps', 'desktop', 'out', 'preload', 'page.cjs')) && !(only.size === 1 && only.has('card'))) {
  console.log('[S17] building Chord (its preloads are measured)');
  const r = spawnSync('pnpm', ['--filter', '@chord/desktop', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// The fallback of question 1: the agent compiled into the preload.
const fatPreload = join(mkdtempSync(join(tmpdir(), 'chord-s17-fat-')), 'preload-fat.cjs');
const scan = readFileSync(join(spike, 'agent', 'scan.js'), 'utf8');
const agent = readFileSync(join(spike, 'agent', 'agent.js'), 'utf8');
writeFileSync(fatPreload, `function __chordAgentMain(chordPasswords) {\n${scan}\n${agent}\n}\n${readFileSync(join(here, 'preload.cjs'), 'utf8')}`);

const server = await startServer();
const { port } = server.address();
const electron = createRequire(join(root, 'apps', 'desktop', 'package.json'))('electron');
const all = [];
async function launch(label, args) {
  const file = join(outDir, `${label}.json`);
  rmSync(file, { force: true });
  const userData = mkdtempSync(join(tmpdir(), 'chord-s17-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(electron, [join(here, 'main.mjs'), `--out=${file}`, `--port=${port}`, `--user-data=${userData}`, `--fat-preload=${fatPreload}`, ...(wayland ? ['--wayland', '--ozone-platform=wayland'] : []), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    const code = await new Promise((done) => child.on('exit', done));
    clearTimeout(timer);
    const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ok: false, error: `no results (exit ${code})` };
    result.label = label;
    result.log = log.split(/\r?\n/).filter((l) => !/^\[probe/.test(l) && l.trim()).slice(-30);
    writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`[S17] ${label}: exit ${code}, ok=${result.ok}${result.error ? `, ${result.error.split('\n')[0]}` : ''}`);
    all.push(result);
    return result;
  } finally {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

if (only.has('world')) {
  await launch('world', ['--probe=world']);
  await launch('world-with-chord-preloads', ['--probe=world', '--chord=1']);
}
if (only.has('card')) await launch('card', ['--probe=card']);
if (only.has('frames')) {
  // Which preloads ran where: once each, counting (the counting adds an IPC per frame, so it isn't timed).
  for (const s of ['0', '1']) await launch(`frames-count-sub${s}`, ['--probe=frames', `--subframes=${s}`, '--report=1', '--loads=1']);
  for (let r = 1; r <= rounds; r++) {
    for (const s of r % 2 ? ['0', '1'] : ['1', '0']) await launch(`frames-sub${s}-r${r}`, ['--probe=frames', `--subframes=${s}`]);
  }
}
if (only.has('preload')) {
  const modes = ['none', 'chord', 'chord+sentinel', 'chord+fat'];
  for (let r = 1; r <= rounds; r++) {
    for (const m of r % 2 ? modes : [...modes].reverse()) await launch(`preload-${m}-plain-r${r}`, ['--probe=preload', `--mode=${m}`, '--url=/plain']);
    for (const m of ['chord', 'chord+sentinel', 'chord+fat']) await launch(`preload-${m}-login-r${r}`, ['--probe=preload', `--mode=${m}`, '--url=/login', '--loads=5']);
  }
}
server.close();
rmSync(dirname(fatPreload), { recursive: true, force: true });

// ----- Summary -----
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, n = 1) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);
const summary = { platform: process.platform, arch: process.arch, cpus: (await import('node:os')).cpus().length, wayland, failed: all.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`) };
const pick = (prefix) => all.filter((r) => r.ok && r.label.startsWith(prefix));
const sumType = (mem, pred) => mem.filter(pred).reduce((a, m) => a + (m.privateKB ?? 0), 0) / 1024;
for (const s of ['0', '1']) {
  const runs = pick(`frames-sub${s}-`);
  if (!runs.length) continue;
  summary[`frames-sub${s}`] = {
    runs: runs.length,
    firstLoadMs: round(median(runs.map((r) => r.steps['5-load-ms'][0]))),
    reloadMs: round(median(runs.flatMap((r) => r.steps['5-load-ms'].slice(1)))),
    renderers: median(runs.map((r) => r.steps['5-memory'].filter((m) => m.type === 'Tab').length)),
    rendererMB: round(median(runs.map((r) => sumType(r.steps['5-memory'], (m) => m.type === 'Tab')))),
    allMB: round(median(runs.map((r) => sumType(r.steps['5-memory'], () => true)))),
    rendererCpuTicks: median(runs.map((r) => r.steps['5-memory'].filter((m) => m.type === 'Tab').reduce((a, m) => a + (m.cpuTicks ?? 0), 0))),
    frames: runs[0].steps['5-frames-in-tree'],
  };
  const count = all.find((r) => r.label === `frames-count-sub${s}`);
  if (count?.ok) summary[`frames-sub${s}`].preloadRuns = count.steps['5-preload-runs'];
}
for (const target of ['plain', 'login']) {
  for (const m of ['none', 'chord', 'chord+sentinel', 'chord+fat']) {
    const runs = pick(`preload-${m}-${target}-`);
    if (!runs.length) continue;
    summary[`preload-${m}-${target}`] = {
      runs: runs.length,
      loadMs: round(median(runs.flatMap((r) => r.steps['6-load-ms'].slice(1)))),
      preloadMs: round(median(runs.flatMap((r) => r.steps['6-preload-ms'])), 2),
      pageMB: round(median(runs.map((r) => r.steps['6-page-memory']?.privateKB / 1024)), 2),
      woke: target === 'login' ? runs.map((r) => r.steps['6-woke'][0] ?? null).map((w) => w && { why: w.why, invokeMs: round(w.invokeMs, 2), runMs: round(w.runMs, 2) }) : undefined,
    };
  }
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failed.length ? 1 : 0;
