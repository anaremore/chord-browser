import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { applySystem } from '../shared/system';
import { api } from './api';
import { Settings } from './Settings';

const info = await api.system.info();
applySystem(info);
api.system.onChange(applySystem);
const [snapshot, about] = await Promise.all([api.settings.snapshot(), api.settings.about()]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings initialInfo={info} initialSnapshot={snapshot} about={about} />
  </StrictMode>,
);
