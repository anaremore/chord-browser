import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { createMirror } from '../shared/mirror';
import { applySystem } from '../shared/system';
import { api } from './api';
import { CommandBar } from './CommandBar';

const info = await api.system.info();
applySystem(info);
api.system.onChange(applySystem);
const mirror = await createMirror(api.state);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <CommandBar initialInfo={info} mirror={mirror} />
    </MotionConfig>
  </StrictMode>,
);
