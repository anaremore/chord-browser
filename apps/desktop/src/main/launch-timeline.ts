/**
 * Where launch spends its time, for development and test builds only (never a
 * packaged one). Chord marks its steps; if the first web page hasn't loaded
 * 5 s after main started, the marks so far go to stderr as one block, which
 * the E2E harness prints beside a failure (test/e2e/main-errors.ts). On CI's
 * slower Windows machines a first page has sometimes taken over 10 s, which
 * the container never shows; this says where the time went.
 *
 * And at quit, the same block again if the first page never loaded or never
 * had a title (#189: on Windows, a first tab has stayed at its host for a whole
 * test, its title never shown). Its marks then say which it was: the page
 * never committed, never loaded, or loaded with no title event, or (all there)
 * the title was lost on its way to the sidebar.
 *
 * And (#259) when the first page's navigation hasn't committed or failed STALLED_MS after it started, the block with
 * that request's events from Chromium's net log (launch-netlog.ts, CI's test builds only): how far it got.
 */
import { app, type WebContents } from 'electron';
import { recordNetLog, requestEvents, stopNetLog } from './launch-netlog';

const started = Date.now();
const marks: string[] = [];
let firstLoaded = false;
let titled = false;
let enabled = false;

/** Marks stop once the first page has loaded and had a title: what comes after is no longer launch. */
const done = () => firstLoaded && titled;

export function mark(what: string): void {
  if (enabled && !done()) marks.push(`+${Date.now() - started} ms  ${what}`);
}

const block = (why: string, more: string[] = []) => `[chord] slow launch: ${why}\n${[...marks, ...more].join('\n')}\n[chord] end of slow launch`;

/** How long the first page's navigation may go without committing or failing before its request is looked at. */
const STALLED_MS = 10_000;

/** Start watching (call once, early). The first http(s) page's navigation, commit, load and title are marked. */
export function watchLaunch(slowAfterMs = 5000): void {
  if (app.isPackaged) return;
  enabled = true;
  mark('main started');
  recordNetLog();
  let first: string | null = null;
  let settled = false;
  const watch = (contents: WebContents) => {
    const web = () => /^https?:/.test(contents.getURL());
    const path = (url: string) => new URL(url).pathname;
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !/^https?:/.test(details.url)) return;
      mark(`navigation started ${path(details.url)}`);
      if (first) return;
      first = details.url;
      setTimeout(() => {
        if (settled || !first) return;
        void requestEvents(first).then((events) => console.error(block(`the first page's navigation hasn't committed or failed ${STALLED_MS / 1000} s after it started`, events)));
      }, STALLED_MS).unref();
    });
    contents.on('did-navigate', (_event, url, code) => {
      if (!/^https?:/.test(url)) return;
      mark(`committed ${path(url)} (${code})`);
      settled = true;
      stopNetLog();
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || !/^https?:/.test(url)) return;
      mark(`failed ${path(url)}: ${code} ${description}`);
      settled = true;
      stopNetLog();
    });
    contents.on('did-finish-load', () => {
      if (firstLoaded || !web()) return;
      mark('first page loaded');
      firstLoaded = true;
    });
    contents.on('page-title-updated', () => {
      if (!web()) return;
      mark(`title "${contents.getTitle().slice(0, 40)}"`);
      titled = true;
    });
  };
  // Called before `ready`: no page exists yet, so every one is seen as it's made.
  app.on('web-contents-created', (_event, contents) => watch(contents));
  setTimeout(() => {
    if (!firstLoaded) console.error(block(`no page loaded ${slowAfterMs} ms after main started`));
  }, slowAfterMs).unref();
  app.on('will-quit', () => {
    if (marks.some((m) => / {2}(committed|navigation started) /.test(m)) && !done()) {
      console.error(block(`at quit, the first page ${firstLoaded ? 'had no title event' : 'never loaded'}`));
    }
  });
}
