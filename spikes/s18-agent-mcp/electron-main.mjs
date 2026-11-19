// Spike S18 M0: one Electron executable, two roles, as chord.exe would have them.
//   electron electron-main.mjs mcp --spike-user-data=<dir>   → `chord mcp`: the stdio bridge.
//     The branch is the first thing main runs: no single-instance lock, no window, no `ready`.
//   electron electron-main.mjs --spike-user-data=<dir>       → a windowless "Chord" serving the endpoint,
//     whose open_tab loads real pages in hidden (show: false) windows on a throwaway partition.
// The packaged app keeps the RunAsNode fuse off (electron-builder.config.ts), so ELECTRON_RUN_AS_NODE
// is not an option: the branch has to live in Chord's own main.
import { app } from 'electron';

const userData = process.argv.find((a) => a.startsWith('--spike-user-data='))?.slice(18);
// Packaged: argv is [chord.exe, 'mcp', …]; here: [electron.exe, main.mjs, 'mcp', …].
const isMcp = process.argv.slice(app.isPackaged ? 1 : 2).includes('mcp');

if (isMcp) {
  // Nothing of the browser: no GPU process, no lock, nothing in a profile folder of its own.
  app.disableHardwareAcceleration();
  // S18_SWITCHES="a b=c": Chromium switches to try against the GPU and network-service children.
  // The default makes it one process (no GPU or network-service child): measured in the decision doc.
  for (const s of (process.env.S18_SWITCHES ?? 'disable-gpu disable-software-rasterizer in-process-gpu enable-features=NetworkServiceInProcess2').split(' ').filter(Boolean)) {
    const [k, v] = s.split('=');
    app.commandLine.appendSwitch(k, v);
  }
  app.setPath('userData', `${userData}-mcp-scratch`);
  const { runBridge } = await import('./bridge.mjs');
  const { ancestry } = await import('./parent.mjs');
  // Electron's main has no working process.stdin (on Windows it's a stub that ends at once),
  // but fd 0 is the client's pipe: read it directly. stdout is a SyncWriteStream and works.
  const { Socket } = await import('node:net');
  const { createReadStream } = await import('node:fs');
  let input;
  try {
    input = new Socket({ fd: 0, readable: true, writable: false });
  } catch {
    input = createReadStream(null, { fd: 0 });
  }
  // --spike-log=<file>: what the client sent and which environment it gave the bridge (names only).
  const logFile = process.argv.find((a) => a.startsWith('--spike-log='))?.slice(12);
  const { appendFileSync } = await import('node:fs');
  const log = logFile ? (...a) => appendFileSync(logFile, `${a.join(' ')}\n`) : () => {};
  log('bridge start', JSON.stringify({ cwd: process.cwd(), ppid: process.ppid, envNames: Object.keys(process.env).sort() }));
  if (logFile) ancestry().then((a) => log('parent chain', JSON.stringify(a.map(({ name, path }) => ({ name, path })))));
  runBridge({ userData, input, parent: () => ancestry(), log });
} else {
  app.setPath('userData', userData);
  if (!app.requestSingleInstanceLock()) app.quit();
  app.on('window-all-closed', () => {}); // windowless on purpose
  app.on('second-instance', (_e, argv) => console.log('second-instance (!)', JSON.stringify(argv)));
  // Never await ready at the top level of an ESM main: Electron emits ready only after the entry module has evaluated.
  app.whenReady().then(host);
}

async function host() {
  const { startEndpoint } = await import('./endpoint.mjs');
  const { chordSide, pageResult } = await import('./tools.mjs');
  const { BrowserWindow } = await import('electron');
  const tabs = new Map();
  let n = 0;
  const call = async (name, args) => {
    if (name === 'list_tabs') return { text: JSON.stringify([...tabs].map(([id, w]) => ({ tab_id: id, title: w.webContents.getTitle(), site: new URL(w.webContents.getURL()).host, shared: false, loading: w.webContents.isLoading() }))) };
    if (name === 'open_tab') {
      if (!/^https?:\/\//.test(args.url)) return { text: 'Only http and https addresses.', isError: true };
      const w = new BrowserWindow({ show: false, webPreferences: { partition: 'spike-agent', sandbox: true, contextIsolation: true } });
      const id = `a${++n}`;
      tabs.set(id, w);
      await Promise.race([w.loadURL(args.url).catch(() => {}), new Promise((r) => setTimeout(r, 30000))]);
      return { text: JSON.stringify({ tab_id: id, url: w.webContents.getURL(), title: w.webContents.getTitle() }) };
    }
    const w = tabs.get(args.tab_id);
    if (!w) return { text: `No tab ${args.tab_id}. Call list_tabs.`, isError: true };
    if (name === 'read_tab') {
      const text = await w.webContents.executeJavaScript('document.body.innerText');
      return { text: pageResult({ ref: args.tab_id, url: w.webContents.getURL(), text, start: args.start, length: args.length }) };
    }
    if (name === 'tab_screenshot') {
      const img = await w.webContents.capturePage();
      return { image: { data: img.toJPEG(70).toString('base64'), mimeType: 'image/jpeg' } };
    }
    if (name === 'close_tab') return w.destroy(), tabs.delete(args.tab_id), { text: 'Closed.' };
    return { text: `${name} isn't in this spike.`, isError: true };
  };
  const approve = process.env.S18_APPROVE || 'once';
  const decide = () => (approve.startsWith('delay:') ? new Promise((r) => setTimeout(r, Number(approve.slice(6)), 'once')) : approve);
  const e = await startEndpoint({
    userData,
    log: console.log,
    onConnection(hello, send) {
      console.log('hello', JSON.stringify({ clientInfo: hello.initialize?.clientInfo, cwd: hello.cwd, parent: hello.parent?.map(({ name, path, cwd }) => ({ name, path, cwd })) }));
      const side = chordSide({ send, approve: decide, waitMs: Number(process.env.S18_WAIT_MS || 45000), call, clientInfo: hello.initialize?.clientInfo, log: console.log });
      return (m) => void side.onMessage(m);
    },
  });
  console.log('listening', e.path);
  app.on('before-quit', () => e.close());
}
