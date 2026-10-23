// Spike S7 runner: makes a 20-second test video with ffmpeg (a moving test
// pattern, so captures show whether it's still being drawn, plus a quiet
// tone, so the tab becomes audible), then runs main.mjs in the repo's
// Electron. Results land in spikes/s7-auto-pip/results/ (gitignored).
//
// Run: node spikes/s7-auto-pip/run.mjs [youtube]
//   youtube: also try a real YouTube page (needs the network).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const repo = resolve(here, '..', '..');
const out = join(here, 'results');
const captures = join(out, 'captures');
mkdirSync(captures, { recursive: true });

const video = join(out, 'test.webm');
if (!existsSync(video)) {
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '20', '-c:v', 'libvpx-vp9', '-b:v', '800k', '-c:a', 'libopus', '-af', 'volume=0.05',
    video,
  ]);
}

const electron = createRequire(join(repo, 'apps', 'desktop', 'package.json'))('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const file = join(out, 'results.json');
console.log(`[S7] Electron ${electron}`);
const child = spawn(electron, [join(here, 'main.mjs'), file, video, captures, ...process.argv.slice(2)], { env, stdio: 'inherit' });
const code = await new Promise((done) => child.on('exit', done));
console.log(`[S7] exit ${code}; results in ${file}`);
process.exit(code ?? 1);
