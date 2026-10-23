import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { live } from '../shared/live';
import { applySystem } from '../shared/system';
import { api } from './api';
import { MiniBar } from './MiniBar';

const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
const state = await live(() => api.mini.state(), (listener) => api.mini.onState(listener));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MiniBar info={info} state={state} />
  </StrictMode>,
);
