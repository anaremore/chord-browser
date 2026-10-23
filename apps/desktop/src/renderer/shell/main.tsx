import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { createMirror } from '../shared/mirror';
import { live } from '../shared/live';
import { applySystem } from '../shared/system';
import { api } from './api';
import { App } from './App';
import { createToastStore } from './toast-store';

// First, before anything awaits: a toast main sends while the shell is starting still lands.
const toasts = createToastStore((listener) => api.toasts.onShow(listener));
const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
const mirror = await createMirror(api.state);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App info={info} mirror={mirror} toasts={toasts} />
  </StrictMode>,
);
