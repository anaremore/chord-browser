/**
 * EasyList and EasyPrivacy, compiled both ways Chord uses them (ARCHITECTURE.md
 * §9; docs/decisions/S11-ad-blocking.md):
 *
 * - declarativeNetRequest rules (rules.ts), which Chromium matches by itself
 *   in every chord's session, through Chord's blocker extension;
 * - Ghostery's engine, serialized, which private windows match requests
 *   against and every page's element hiding comes from.
 *
 * Runs at build time (electron.vite.config.ts bundles the result) and in a
 * worker after each refresh: parsing takes about half a second, never on main.
 * Main never imports this file, so the engine's code stays out of its bundle.
 */
import { FiltersEngine } from '@ghostery/adblocker';
import { FILTER_LISTS, isList, listHeader, type CompiledInfo, type ListId } from './lists';
import { compileList, type Rule } from './rules';

export interface Compiled {
  engine: Uint8Array;
  rules: Record<ListId, Rule[]>;
  info: CompiledInfo;
}

/** The engine's settings: element hiding without procedural (`:has-text`) selectors or scripts, which would need code in pages. */
export const ENGINE_CONFIG = { loadCosmeticFilters: true, loadNetworkFilters: true, loadExtendedSelectors: false, enableCompression: true } as const;

/** Compile both lists. Throws if either text isn't the list it should be. */
export function compileLists(texts: Record<ListId, string>): Compiled {
  const info: CompiledInfo = { versions: {} as CompiledInfo['versions'], refreshMs: {} as CompiledInfo['refreshMs'], stats: {} as CompiledInfo['stats'] };
  const rules = {} as Record<ListId, Rule[]>;
  for (const list of FILTER_LISTS) {
    const text = texts[list.id];
    if (!isList(text, list.name)) throw new Error(`That isn’t ${list.name}`);
    const header = listHeader(text);
    info.versions[list.id] = header.version!;
    info.refreshMs[list.id] = header.refreshMs;
    const compiled = compileList(text);
    rules[list.id] = compiled.rules;
    info.stats[list.id] = compiled.stats;
  }
  const engine = FiltersEngine.parse(FILTER_LISTS.map((l) => texts[l.id]).join('\n'), ENGINE_CONFIG).serialize();
  return { engine, rules, info };
}
