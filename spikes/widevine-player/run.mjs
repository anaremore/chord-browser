#!/usr/bin/env node
// Runs spike S14 on this machine: the Widevine probe on ECS (fresh profile,
// then with the component updater off), the host scenarios (stock Electron
// host, ECS player), and optionally the host census. Never run it on a desktop
// someone is using: it opens windows and, on Windows, moves the mouse. Use the
// Linux container (run-linux.mjs) or the CI workflow.
//
//   node run.mjs --runtime <folder from tools/fetch.mjs> --out <results> --work <empty temp folder>
//     [--steps probe,nocu,host,census] [--scenarios channel,navlock,glue,frameless,child]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const runtime = resolve(opt('runtime'));
const out = resolve(opt('out'));
const work = resolve(opt('work'));
const steps = opt('steps', 'probe,nocu,host').split(',');
const scenarios = opt('scenarios', 'channel,navlock,glue,frameless,child');
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

const exe = (dir) => (process.platform === 'win32' ? join(dir, 'electron.exe') : process.platform === 'darwin' ? join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron') : join(dir, 'electron'));
const ECS = exe(join(runtime, 'ecs'));
const ELECTRON = exe(join(runtime, 'electron'));
const KOFFI = existsSync(join(runtime, 'koffi', 'node_modules', 'koffi')) ? join(runtime, 'koffi', 'node_modules', 'koffi') : null;
const summary = { platform: process.platform, arch: process.arch, envKeys: Object.keys(process.env).sort(), steps: {} };

function run(label, command, argv, { timeout = 600_000 } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const logFile = join(out, `${label}.log`);
    let text = '';
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
    child.stdout.on('data', (d) => ((text += d), process.stdout.write(d)));
    child.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(logFile, text);
      summary.steps[label] = { code, signal, seconds: Math.round((Date.now() - started) / 1000) };
      console.log(`[run] ${label}: exit ${code ?? signal} in ${summary.steps[label].seconds} s`);
      done(code);
    });
  });
}

/** Hosts a Chromium net log shows contacted (URL requests started, names looked up). */
function contactedHosts(file) {
  if (!existsSync(file)) return null;
  let text = readFileSync(file, 'utf8');
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    text = text.slice(0, text.lastIndexOf('},') + 1);
    log = JSON.parse(`${text}]}`);
  }
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const hosts = {};
  const add = (value, how) => {
    if (typeof value !== 'string') return;
    let host;
    try {
      host = new URL(value.includes('://') ? value : `https://${value}`).hostname;
    } catch {
      return;
    }
    if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return;
    (hosts[host] ??= new Set()).add(how);
  };
  for (const e of log.events) {
    const name = names.get(e.type);
    const p = e.params ?? {};
    if (name === 'URL_REQUEST_START_JOB') add(p.url, `${p.method ?? 'GET'} ${String(p.url).replace(/\?.*/, '?…').slice(0, 120)}`);
    else if (name?.startsWith('HOST_RESOLVER_')) add(p.host ?? p.host_resolver_key?.host, 'DNS');
  }
  return Object.fromEntries(Object.entries(hosts).map(([h, s]) => [h, [...s].slice(0, 6)]));
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : e.isFile() ? statSync(p).size : 0;
  }
  return total;
}

const player = join(here, 'player');
const p1 = join(work, 'profile-1');
const p2 = join(work, 'profile-2');

if (steps.includes('probe')) {
  const dir = join(out, 'probe');
  await run('probe', ECS, [player, '--mode', 'probe', '--profile', p1, '--out', dir, `--log-net-log=${join(dir, 'netlog.json')}`], { timeout: 480_000 });
  summary.netlogProbe = contactedHosts(join(dir, 'netlog.json'));
  summary.profileAfterProbeBytes = dirSize(p1);
}
if (steps.includes('nocu')) {
  // The component updater off (what Google-free mode would need): with the CDM already installed, and on a fresh profile.
  const a = join(out, 'nocu-installed');
  await run('nocu-installed', ECS, [player, '--mode', 'probe', '--quick', '--profile', p1, '--out', a, '--disable-component-update', '--cdm-timeout', '30000', `--log-net-log=${join(a, 'netlog.json')}`], { timeout: 240_000 });
  summary.netlogNocuInstalled = contactedHosts(join(a, 'netlog.json'));
  const b = join(out, 'nocu-fresh');
  await run('nocu-fresh', ECS, [player, '--mode', 'probe', '--quick', '--profile', p2, '--out', b, '--disable-component-update', '--cdm-timeout', '30000', `--log-net-log=${join(b, 'netlog.json')}`], { timeout: 240_000 });
  summary.netlogNocuFresh = contactedHosts(join(b, 'netlog.json'));
  // And a second normal launch with the CDM installed: does it still call Google?
  const c = join(out, 'second-launch');
  await run('second-launch', ECS, [player, '--mode', 'probe', '--quick', '--profile', p1, '--out', c, `--log-net-log=${join(c, 'netlog.json')}`], { timeout: 240_000 });
  summary.netlogSecondLaunch = contactedHosts(join(c, 'netlog.json'));
}
if (steps.includes('idle')) {
  // A long idle launch with the CDM installed: the component updater's own background check.
  const d = join(out, 'idle');
  await run('idle', ECS, [player, '--mode', 'probe', '--quick', '--linger', opt('linger', '480'), '--timeout', '900000', '--profile', p1, '--out', d, `--log-net-log=${join(d, 'netlog.json')}`], { timeout: 900_000 });
  summary.netlogIdle = contactedHosts(join(d, 'netlog.json'));
}
if (steps.includes('host')) {
  const argv = [join(here, 'host'), '--scenarios', scenarios, '--player-exe', ECS, '--player-app', player, '--player-profile', p1, '--out', join(out, 'host'), '--node', process.execPath];
  if (KOFFI) argv.push('--koffi', KOFFI);
  await run('host', ELECTRON, argv, { timeout: 900_000 });
}
if (steps.includes('census')) {
  await run('census', ELECTRON, [join(here, 'census'), '--out', join(out, 'census')], { timeout: 1_200_000 });
}
summary.fetch = existsSync(join(runtime, 'fetch.json')) ? JSON.parse(readFileSync(join(runtime, 'fetch.json'), 'utf8')) : null;
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
rmSync(work, { recursive: true, force: true });
console.log(`[run] done: ${out}`);
