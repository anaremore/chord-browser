// Electron alone, opening one window with one small page, the way Chord opens its
// shell: perf.spec.ts launches it beside Chord, and how long it takes says how fast
// the machine is, so Chord's launch can be judged against it.
import { app, BaseWindow, WebContentsView } from 'electron';

const now = () => performance.timeOrigin + performance.now();
const marks = { processStart: performance.timeOrigin, mainEntry: now() };
globalThis.bareLaunch = () => marks;

// A profile of its own, never Electron's default folder.
if (process.env['CHORD_USER_DATA']) app.setPath('userData', process.env['CHORD_USER_DATA']);
app.enableSandbox();

// Not a top-level await: Electron waits for the main module before it's ready.
void app.whenReady().then(() => {
  marks.ready = now();
  const window = new BaseWindow({ width: 1280, height: 800, show: false });
  const view = new WebContentsView();
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  view.webContents.once('did-finish-load', () => {
    marks.loaded = now();
    window.show();
  });
  void view.webContents.loadURL('data:text/html,<title>Bare</title><p>A page.</p>');
});
