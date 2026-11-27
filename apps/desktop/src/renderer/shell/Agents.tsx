/**
 * Outside agents in the shell (S18 M1c; mocks/agents-s18-m1.html §2): each
 * agent's tabs in a section of its own below your chord's, and the bar over
 * an agent's tab while it works there or is held. The section is never in a
 * private window. What the buttons do happens in main (main/agents).
 */
import { agentChords, nodesOfChord, type AgentLive, type State, type TabNode } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import type { Appearance } from '@chord/tokens';
import { X } from 'lucide-react';
import type { MouseEvent } from 'react';
import { Favicon } from '../shared/Favicon';
import { api } from './api';
import rows from './App.module.css';
import styles from './Agents.module.css';
import { useKeys } from './keys';
import { menuPoint } from './Tabs';

/**
 * Each agent's tabs, oldest first, below your chord's (none in a private window). An agent with no tabs has no section
 * (the owner, 2026-11-24): Settings → Agents still says it's connected, and its section comes back with its next tab.
 */
export function AgentSections({ state, windowId, appearance, info }: { state: State; windowId: string; appearance: Appearance; info: SystemInfo }) {
  const { withKeys } = useKeys(info);
  const win = state.windows[windowId];
  const tabsOf = (chordId: string) => nodesOfChord(state, chordId).filter((n): n is TabNode => n.kind === 'tab').sort((a, b) => a.createdAt - b.createdAt);
  const chords = agentChords(state)
    .map((chord) => ({ chord, own: tabsOf(chord.id) }))
    .filter(({ own }) => own.length > 0);
  if (!win || win.private || chords.length === 0) return null;
  // Your own rows' close button, its tooltip with the key (S18 M2e-1: you can always close an agent's tab).
  const closeTitle = withKeys('Close tab', 'tab.close');
  return (
    <div className={styles.sections}>
      {chords.map(({ chord, own }) => {
        return (
          <section key={chord.id} className={styles.section} aria-label={`${chord.name}’s tabs`}>
            <h2 className={styles.header}>
              <span aria-hidden>✳</span> {chord.name}
            </h2>
            <ul className={styles.list}>
              {own.map((tab) => {
                const live = state.live[tab.id];
                const working = live?.agent?.state === 'working';
                const shown = win.agentTab === tab.id;
                // Closing tells the agent the tab is gone, and its cards for the tab come down (main/agents).
                const close = () => void api.state.dispatch({ t: 'tab.close', windowId, nodeId: tab.id });
                return (
                  <li
                    key={tab.id}
                    className={`${rows.item} ${styles.item}`}
                    data-agent-tab={tab.id}
                    onMouseDown={(e: MouseEvent) => {
                      if (e.button === 1) e.preventDefault(); // no autoscroll
                    }}
                    onAuxClick={(e: MouseEvent) => {
                      if (e.button === 1) close();
                    }}
                    onContextMenu={(e: MouseEvent) => {
                      e.preventDefault();
                      void api.menu.tab(tab.id, menuPoint(e));
                    }}
                  >
                    <button
                      type="button"
                      className={styles.row}
                      data-shown={shown || undefined}
                      aria-current={shown ? 'page' : undefined}
                      title={tab.url}
                      onClick={() => void api.state.dispatch({ t: 'tab.activate', windowId, nodeId: tab.id })}
                    >
                      <Favicon url={tab.url} title={tab.title} favicon={tab.favicon} loading={Boolean(live?.loading) && (!tab.favicon || Boolean(live?.waitingForSession))} appearance={appearance} />
                      <span className={styles.title}>{tab.title || tab.url}</span>
                      {working && <span className={styles.dot} role="img" aria-label={`${chord.name} is using this tab`} />}
                    </button>
                    <button type="button" tabIndex={-1} aria-hidden className={rows.close} aria-label={`Close ${tab.title || 'tab'}`} title={closeTitle} onClick={close}>
                      <X size={14} strokeWidth={2} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The bar over an agent's tab: blue while the agent reads it, with Stop (every agent at once, as Ctrl+. / ⌘.); the paused bar's grey while you use the
 * tab, or once you've stopped the agent, with "Let … continue". Main keeps the page below it (AGENT_BAR_HEIGHT).
 */
export function AgentBar({ agent, nodeId }: { agent: AgentLive; nodeId: string }) {
  const working = agent.state === 'working';
  // A tab of yours you shared (M1e; the mock's §3): blue, with Stop sharing.
  if (agent.state === 'shared') {
    return (
      <div className={styles.bar} data-working role="status">
        <span aria-hidden>✳</span>
        <span className={styles.barText}>Shared with {agent.name}: it can read this tab</span>
        <button type="button" className={styles.resume} onClick={() => void api.state.dispatch({ t: 'agents.unshare', nodeId })}>
          Stop sharing
        </button>
      </div>
    );
  }
  // Working: what it's doing (M2c: `is clicking “Start a return”`), waiting on a card of yours, or reading.
  const doing = agent.waiting ? 'is waiting for you' : (agent.doing ?? 'is reading this tab');
  const text = working ? `${agent.name} ${doing}` : agent.state === 'paused' ? 'Paused while you use this tab' : `${agent.name} is stopped`;
  return (
    <div className={styles.bar} data-working={working || undefined} role="status">
      {working && <span aria-hidden>✳</span>}
      <span className={styles.barText}>{text}</span>
      {working ? (
        <button type="button" className={styles.stop} onClick={() => void api.state.dispatch({ t: 'agents.stopAll' })}>
          Stop
        </button>
      ) : (
        <button type="button" className={styles.resume} onClick={() => void api.state.dispatch({ t: 'agents.continue', chordId: agent.chordId })}>
          Let {agent.name} continue
        </button>
      )}
    </div>
  );
}
