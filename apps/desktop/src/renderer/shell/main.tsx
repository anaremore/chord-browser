import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { createMirror } from '../shared/mirror';
import { live } from '../shared/live';
import { afterNextPaint } from '../shared/perf';
import { applySystem } from '../shared/system';
import { api } from './api';
import { App } from './App';
import { createToastStore } from './toast-store';

// First, before anything awaits: a toast main sends while the shell is starting still lands.
const toasts = createToastStore((listener) => api.toasts.onShow(listener));
const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
const mirror = await createMirror(api.state);

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
