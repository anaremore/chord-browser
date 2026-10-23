import { createContext } from 'react';

/** Tabs Duet has read in the open thread: the sidebar badges them (ARCHITECTURE.md §11.4, Visibility). */
export const DuetReadTabs = createContext<ReadonlySet<string>>(new Set());
