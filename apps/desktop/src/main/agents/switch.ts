/**
 * Agents on or off (S18 M1b), the only part of the feature main loads by
 * itself. Packaged builds: nothing at all, whatever the setting says (until
 * Settings → Agents, M1d). Development builds: off (the default), nothing but
 * a look at the store's changes for the setting; on (the setting, or
 * CHORD_AGENTS=1), the service starts, which serves one pipe and one token file.
 */
import { agentsAvailable, agentsServe, type State } from '@chord/core';
import type { Change } from '../store';
import type { AgentService } from './service';

export interface AgentSwitchDeps {
  packaged: boolean;
  store: { readonly state: State; subscribe(listener: (change: Change) => void): () => void };
  /** CHORD_AGENTS (development builds only). */
  devSwitch: string | undefined;
  /** Makes the service: called only when Agents is on. */
  make(): Promise<AgentService>;
}

export interface AgentSwitch {
  /** The service, once Agents has been on. */
  readonly service: AgentService | null;
  /** Whatever's under way to start or stop. */
  settled(): Promise<void>;
  quit(): Promise<void>;
}

export function watchAgents(deps: AgentSwitchDeps): AgentSwitch | null {
  if (!agentsAvailable({ packaged: deps.packaged })) return null;
  let service: AgentService | null = null;
  let queue = Promise.resolve();
  const apply = (on: boolean) => {
    queue = queue
      .then(async () => {
        if (on) {
          service ??= await deps.make();
          await service.start();
        } else await service?.stop();
      })
      .catch((error: unknown) => console.warn('[chord] agents:', error instanceof Error ? error.message : error));
  };
  const serving = () => agentsServe({ packaged: deps.packaged }, deps.store.state.settings.agentsEnabled, deps.devSwitch);
  let on = serving();
  if (on) apply(true);
  deps.store.subscribe((change) => {
    if (!change.patches.some((p) => p.path[0] === 'settings' && p.path[1] === 'agentsEnabled')) return;
    const now = serving();
    if (now !== on) apply((on = now));
  });
  return {
    get service() {
      return service;
    },
    settled: () => queue,
    quit: async () => {
      await queue;
      await service?.stop(true);
    },
  };
}
