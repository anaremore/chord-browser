import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { createMirror } from '../shared/mirror';
import { afterNextPaint } from '../shared/perf';
import { applySystem } from '../shared/system';
import { api } from './api';
import { App } from './App';

const info = await api.system.info();
applySystem(info);
api.system.onChange(applySystem);
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
      <App initialInfo={info} mirror={mirror} />
    </ReportFirstPaint>
  </StrictMode>,
);
