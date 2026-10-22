import type { SystemInfo } from '@chord/ipc';
import { useEffect, useState } from 'react';
import { api } from './api';

export function useSystemInfo(initial: SystemInfo): SystemInfo {
  const [info, setInfo] = useState(initial);
  useEffect(() => api.system.onChange(setInfo), []);
  return info;
}
