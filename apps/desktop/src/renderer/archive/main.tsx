import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { applySystem } from '../shared/system';
import { api } from './api';
import { ArchivePage } from './Archive';

const info = await api.system.info();
applySystem(info);
api.system.onChange(applySystem);
const snapshot = await api.archive.snapshot();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ArchivePage initialInfo={info} initialSnapshot={snapshot} />
  </StrictMode>,
);
