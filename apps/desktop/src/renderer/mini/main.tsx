import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { applySystem } from '../shared/system';
import { api } from './api';
import { MiniBar } from './MiniBar';

const info = await api.system.info();
applySystem(info);
api.system.onChange(applySystem);
const state = await api.mini.state();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MiniBar initialInfo={info} initialState={state} />
  </StrictMode>,
);
