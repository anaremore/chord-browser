import { createContext } from 'react';

/** Tabs the assistant has read in the open thread: the sidebar badges them (ARCHITECTURE.md §11.4, Visibility). */
export const AssistantReadTabs = createContext<ReadonlySet<string>>(new Set());
