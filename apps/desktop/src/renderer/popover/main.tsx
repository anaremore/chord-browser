import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { live } from '../shared/live';
import { applySystem } from '../shared/system';
import { api } from './api';
import { Popover } from './Popover';

const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
const state = await live(() => api.popover.state(), (listener) => api.popover.onState(listener));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popover info={info} state={state} />
  </StrictMode>,
);
