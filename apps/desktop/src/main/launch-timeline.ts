/**
 * Where launch spends its time, for development and test builds only (never a
 * packaged one). Chord marks its steps; if the first web page hasn't loaded
 * 5 s after main started, the marks so far go to stderr as one block, which
 * the E2E harness prints beside a failure (test/e2e/main-errors.ts). On CI's
 * slower Windows machines a first page has sometimes taken over 10 s, which
 * the container never shows; this says where the time went.
 */
import { app, type WebContents } from 'electron';

const started = Date.now();
const marks: string[] = [];
let firstLoaded = false;
let enabled = false;

export function mark(what: string): void {
  if (enabled && !firstLoaded) marks.push(`+${Date.now() - started} ms  ${what}`);
}

/** Start watching (call once, early). The first http(s) page's navigation, load and title are marked. */
export function watchLaunch(slowAfterMs = 5000): void {
  if (app.isPackaged) return;
  enabled = true;
  mark('main started');
  const watch = (contents: WebContents) => {
    const web = () => /^https?:/.test(contents.getURL());
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && /^https?:/.test(details.url)) mark(`navigation started ${new URL(details.url).pathname}`);
    });
    contents.on('did-finish-load', () => {
      if (firstLoaded || !web()) return;
      mark('first page loaded');
      firstLoaded = true;
    });
    contents.on('page-title-updated', () => {
      if (web()) mark(`title "${contents.getTitle().slice(0, 40)}"`);
    });
  };
  // Called before `ready`: no page exists yet, so every one is seen as it's made.
  app.on('web-contents-created', (_event, contents) => watch(contents));
  setTimeout(() => {
    if (!firstLoaded) console.error(`[chord] slow launch: no page loaded ${slowAfterMs} ms after main started\n${marks.join('\n')}\n[chord] end of slow launch`);
  }, slowAfterMs).unref();
}
