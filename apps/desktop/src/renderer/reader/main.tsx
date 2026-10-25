import type { ReaderArticleView } from '@chord/ipc';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../shared/global.css';
import { live } from '../shared/live';
import { applySystem } from '../shared/system';
import { api } from './api';
import { ReaderView } from './Reader';
import styles from './Reader.module.css';

const info = await live(() => api.system.info(), (listener) => api.system.onChange(listener));
applySystem(info.get());
info.subscribe(() => applySystem(info.get()));
const look = await live(() => api.reader.look(), (listener) => api.reader.onLook(listener));
const page = await api.reader.page();
const article = JSON.parse(page.article) as ReaderArticleView;

// The article scrolls as the whole document, so Space, Page Down and the arrows scroll it wherever focus is.
document.documentElement.classList.add(styles.document!);
document.body.classList.add(styles.flow!);
const root = document.getElementById('root')!;
root.classList.add(styles.flow!);
document.title = article.title;

createRoot(root).render(
  <StrictMode>
    <ReaderView info={info} look={look} article={article} imageBase={page.imageBase} />
  </StrictMode>,
);
