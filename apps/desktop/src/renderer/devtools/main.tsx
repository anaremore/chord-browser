import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { live } from '../shared/live';
import { applySystem } from '../shared/system';
import { api } from './api';
import { DevtoolsBar } from './DevtoolsBar';

const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
const bar = await live(() => api.devtools.bar(), (listener) => api.devtools.onBar(listener));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DevtoolsBar info={info} bar={bar} />
  </StrictMode>,
);
