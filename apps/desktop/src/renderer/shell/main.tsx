import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { createMirror } from '../shared/mirror';
import { applySystem } from '../shared/system';
import { api } from './api';
import { App } from './App';

const info = await api.system.info();
applySystem(info);
api.system.onChange(applySystem);
const mirror = await createMirror(api.state);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Motion's default ignores the OS; "user" honors reduced motion (DESIGN.md §6.6). */}
    <MotionConfig reducedMotion="user">
      <App initialInfo={info} mirror={mirror} />
    </MotionConfig>
  </StrictMode>,
);
