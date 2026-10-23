/**
 * Reads a Chromium net log (`--log-net-log`) for the hosts a run actually
 * contacted: every URL request it started and every name it looked up. Hosts
 * that only appear inside headers or page text don't count. Used by the
 * Google-free test and spike S10 (docs/decisions/S10-google-free.md).
 */
import { readFileSync } from 'node:fs';

interface NetLog {
  constants: { logEventTypes: Record<string, number> };
  events: { type: number; params?: Record<string, unknown> }[];
}

/** Chromium finishes the file on a clean exit; after a crash it can stop mid-array. */
function parse(text: string): NetLog {
  try {
    return JSON.parse(text) as NetLog;
  } catch {
    const cut = text.lastIndexOf('},');
    return JSON.parse(`${text.slice(0, cut + 1)}]}`) as NetLog;
  }
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Each contacted host, with what was asked of it (`GET https://…/path`, or `DNS`). */
export function contactedHosts(file: string): Map<string, Set<string>> {
  const log = parse(readFileSync(file, 'utf8'));
  const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const hosts = new Map<string, Set<string>>();
  const add = (host: string | null, how: string) => {
    if (!host || LOCAL.has(host)) return;
    if (!hosts.has(host)) hosts.set(host, new Set());
    hosts.get(host)!.add(how);
  };
  for (const event of log.events) {
    const name = names.get(event.type);
    const params = event.params ?? {};
    if (name === 'URL_REQUEST_START_JOB') {
      const url = String(params['url'] ?? '');
      add(hostOf(url), `${String(params['method'] ?? 'GET')} ${url.replace(/\?.*/, '?…')}`);
    } else if (name === 'HOST_RESOLVER_MANAGER_REQUEST' || name === 'HOST_RESOLVER_DNS_TASK' || name === 'HOST_RESOLVER_MANAGER_JOB') {
      const host = params['host'] ?? (params['host_resolver_key'] as Record<string, unknown> | undefined)?.['host'];
      add(hostOf(host), 'DNS');
    }
  }
  return hosts;
}

/** Google's own domains, as the Google-free test means them. */
export const GOOGLE_HOST = /(^|\.)(google|gstatic|googleapis|gvt1|gvt2|googleusercontent|googlevideo|ggpht|withgoogle|doubleclick|googlesyndication|google-analytics|googletagmanager|youtube|ytimg)\.[a-z.]+$/;
