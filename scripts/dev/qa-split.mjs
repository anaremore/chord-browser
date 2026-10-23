// Design QA for split view on Windows: builds splits out of Chord's own pages
// (the archive, and a pane showing Chord's "can't reach" state) and captures
// the real, composited window at each step. Captures render the window
// itself (PrintWindow); the screen is never copied.
// Usage (from apps/desktop, after a build):
//   node ../../scripts/dev/qa-split.mjs <out-dir> [light|dark]
/* global document, window -- used inside Playwright page callbacks */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const outDir = resolve(process.argv[2] ?? 'qa');
const appearance = process.argv[3] ?? 'dark';
mkdirSync(outDir, { recursive: true });
const appDir = process.cwd();
const captureScript = resolve(import.meta.dirname, 'capture-window.ps1');
// Nothing listens on the discard port: the pane shows Chord's own "can't connect" state.
const UNREACHABLE = 'http://127.0.0.1:9/';

const env = {
  ...process.env,
  CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-qa-')),
  CHORD_APPEARANCE: appearance,
  CHORD_HOME_URL: 'chord://archive/',
};
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capture = (name) => {
  const file = join(outDir, `${appearance}-${name}.png`);
  execFileSync('pwsh', ['-NoProfile', '-File', captureScript, '-Title', 'Chord', '-Out', file], { stdio: 'inherit' });
  console.log(file);
};

const app = await electron.launch({ args: [appDir, '--no-first-run'], env, cwd: appDir });
try {
  let shell;
  for (let i = 0; i < 100 && !shell; i++) {
    shell = app.windows().find((p) => p.url().includes('shell'));
    if (!shell) await sleep(100);
  }
  if (!shell) throw new Error('no shell');
  await shell.evaluate(() => document.fonts.ready);
  await sleep(1500);
  const state = () => shell.evaluate(() => window.chord.state.snapshot());
  const active = async () => {
    const { windowId, state: s } = await state();
    return { windowId, activeId: s.windows[windowId].activeTab[s.windows[windowId].activeChordId] };
  };
  const dispatch = (command) => shell.evaluate((c) => window.chord.state.dispatch(c), command);

  // Two panes: the archive, and a page Chord explains it can't reach.
  let { windowId, activeId } = await active();
  await dispatch({ t: 'split.add', windowId, withId: activeId, url: UNREACHABLE });
  await sleep(2000);
  capture('split-1-two-panes');

  // A third pane (the archive again), focused in the middle, with the split's tabs listed in the sidebar.
  ({ windowId, activeId } = await active());
  await dispatch({ t: 'split.add', windowId, withId: activeId, url: 'chord://archive/', index: 1 });
  await sleep(1200);
  await shell.getByRole('button', { name: /^Split: / }).hover();
  await shell.locator('[data-split-toggle]').click();
  await shell.mouse.move(5, 300);
  await sleep(600);
  capture('split-2-three-panes-open-row');

  // Hovering a divider shows its pill.
  const divider = shell.locator('[data-divider="0"]');
  const box = await divider.boundingBox();
  await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);
  capture('split-3-divider-hover');

  // Separate (the Undo toast shows), then drag a tab over the page: the drop zone where it would go.
  await shell.evaluate(() => window.chord.action.run('split.separate'));
  await sleep(800);
  capture('split-4-separated-undo');
  const row = shell.getByRole('list', { name: 'Today' }).getByRole('listitem').last();
  const r = await row.boundingBox();
  const frame = await app.evaluate(({ BaseWindow }) => {
    const views = BaseWindow.getAllWindows()[0].contentView.children;
    return views[1].getBounds();
  });
  await shell.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + 6, { steps: 4 });
  await shell.mouse.move(frame.x + frame.width - 80, frame.y + frame.height / 2, { steps: 16 });
  await sleep(700);
  capture('split-5-drop-zone');
  await shell.keyboard.press('Escape');
  await shell.mouse.up();
} finally {
  await app.close();
}
console.log('captures in', outDir);
