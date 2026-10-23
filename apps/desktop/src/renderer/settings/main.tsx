import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { live } from '../shared/live';
import { applySystem } from '../shared/system';
import { api } from './api';
import { Settings } from './Settings';

const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
const [snapshot, about] = await Promise.all([live(() => api.settings.snapshot(), (listener) => api.settings.onChange(listener)), api.settings.about()]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings info={info} snapshot={snapshot} about={about} />
  </StrictMode>,
);
