import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { batchFrames, nextFrame } from '../shared/frames';
import { createMirror } from '../shared/mirror';
import { live } from '../shared/live';
import { afterNextPaint } from '../shared/perf';
import { applySystem } from '../shared/system';
import { api } from './api';
import { App } from './App';
import { markArchived } from './ArchiveArc';
import { createToastStore } from './toast-store';

// First, before anything awaits: a toast main sends while the shell is starting still lands.
const toasts = createToastStore((listener) => api.toasts.onShow(listener));
// Which rows leave for the archive (ArchiveArc.tsx): main says so just before the patch that removes them.
api.sidebar.onArchived(({ nodeIds }) => markArchived(nodeIds));
const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
// Patches render once a frame, however many arrive in it (a tab switch sends several): a frame's
// updates from main run together, in one React pass (shared/frames.ts).
batchFrames(flushSync);
const mirror = await createMirror(api.state, { notify: nextFrame });

let reported = false;
/**
 * Launch timing (ARCHITECTURE.md §1): the sidebar is ready once its first
 * commit is in the DOM with its handlers attached, and the window is usable at
 * the next painted frame. Main times the launch up to each report.
 */
function ReportFirstPaint({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    if (reported) return;
    reported = true;
    performance.mark('chord:shell-ready');
    void api.perf.shell('ready');
    afterNextPaint(() => {
      performance.mark('chord:shell-painted');
      void api.perf.shell('painted');
    });
  }, []);
  return children;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReportFirstPaint>
      <App info={info} mirror={mirror} toasts={toasts} />
    </ReportFirstPaint>
  </StrictMode>,
);
