// Spike S1: node:sqlite + FTS5 inside an Electron utilityProcess.
// Run: electron spikes/s1-sqlite/main.mjs   (with ELECTRON_RUN_AS_NODE unset)
import { app, utilityProcess } from 'electron';
import { join } from 'node:path';

app.whenReady().then(() => {
  const child = utilityProcess.fork(join(import.meta.dirname, 'worker.mjs'), [app.getPath('temp')], {
    serviceName: 'Chord S1 sqlite spike',
    stdio: 'inherit',
  });
  child.on('message', (msg) => {
    console.log('[S1]', JSON.stringify(msg, null, 2));
    child.kill();
    app.quit();
  });
  child.on('exit', (code) => {
    if (code !== 0) console.log('[S1] utility process exited with', code);
    app.quit();
  });
});
