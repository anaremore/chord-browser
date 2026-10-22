import type { SystemInfo, TabState } from '@chord/ipc';
import { useEffect, useState } from 'react';

export function useSystemInfo(initial: SystemInfo): SystemInfo {
  const [info, setInfo] = useState(initial);
  useEffect(() => window.chord.system.onChange(setInfo), []);
  return info;
}

const EMPTY_TAB: TabState = { url: '', title: '', loading: true, canGoBack: false, canGoForward: false, faviconUrl: null };

export function useTabState(): TabState {
  const [state, setState] = useState(EMPTY_TAB);
  useEffect(() => {
    // Subscribe first, then fetch: a push that lands in between is newer and wins.
    let pushed = false;
    const unsubscribe = window.chord.tab.onState((next) => {
      pushed = true;
      setState(next);
    });
    void window.chord.tab.current().then((current) => {
      if (!pushed) setState(current);
    });
    return unsubscribe;
  }, []);
  return state;
}
