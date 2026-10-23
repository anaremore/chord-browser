import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { applySystem } from '../shared/system';
import { api } from './api';
import { Preview } from './Preview';

const info = await api.system.info();
applySystem(info);
api.system.onChange(applySystem);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview initialInfo={info} />
  </StrictMode>,
);
