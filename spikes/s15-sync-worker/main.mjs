// Spike S15 §7: a worker thread inside an Electron utility process, as sync's
// folder work would run beside chord-data. The utility process stands in for
// chord-data: its own thread answers a small SQLite query every 2 ms while the
// worker opens the same database, runs scrypt at S15's parameters, seals and
// deflates megabytes, and watches a folder. The result says whether each of
// those works there, and how late chord-data's thread ever was.
//
// Run: electron spikes/s15-sync-worker/main.mjs   (SPIKE_OUT=<file> to keep the result)
// It opens no window.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, utilityProcess } from 'electron';

const fail = (what) => (error) => {
  console.error(`[S15] ${what}:`, error);
  process.exit(1);
};
process.on('uncaughtException', fail('uncaughtException'));
process.on('unhandledRejection', fail('unhandledRejection'));

const dir = mkdtempSync(join(tmpdir(), 'chord-s15-'));
app.setPath('userData', process.env['CHORD_USER_DATA'] ?? join(dir, 'user-data'));

void app.whenReady().then(() => {
  const child = utilityProcess.fork(join(import.meta.dirname, 'utility.mjs'), [dir], { serviceName: 'Chord S15 sync spike', stdio: 'pipe' });
  const output = [];
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  const steps = [];
  let finished = false;
  const done = (result) => {
    if (finished) return;
    finished = true;
    const text = JSON.stringify({ ...result, steps, output: output.join('') }, null, 2);
    console.log('[S15]', text);
    if (process.env['SPIKE_OUT']) writeFileSync(process.env['SPIKE_OUT'], text);
    rmSync(dir, { recursive: true, force: true });
    app.exit(result.ok ? 0 : 1);
  };
  child.on('message', (message) => {
    if (message.step) return void steps.push(message.step);
    child.kill();
    done(message);
  });
  // Output can trail the exit by a moment.
  child.on('exit', (code) => setTimeout(() => done({ ok: false, error: `utility process exited (${code}) before answering` }), 300));
});
