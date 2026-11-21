/**
 * Settings → Agents (S18 M1d; mocks/agents-s18-m1.html §4): the switch for
 * the whole feature (off by default), the lines that connect Claude Code and
 * Codex, agents you've stopped, and agents you've let in for good.
 */
import type { AgentsView, SettingsSnapshot } from '@chord/ipc';
import { useEffect, useState } from 'react';
import { api } from './api';
import local from './Agents.module.css';
import { Row, SectionHeader, Switch } from './controls';
import styles from './Settings.module.css';

/** "today", "yesterday", or the day ("Nov 18"). */
export function lastUsed(at: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return 'today';
  if (day(at) === day(now - 86_400_000)) return 'yesterday';
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const tabs = (n: number) => (n === 1 ? '1 tab' : `${n} tabs`);

/** An allowed agent's second line: "Always allowed · Work's sign-ins · connected now · 2 tabs" / "… · last used yesterday". */
function allowedLine(a: AgentsView['allowed'][number]): string {
  const parts = ['Always allowed'];
  if (a.signIns) parts.push(a.signIns);
  if (a.connected) parts.push('connected now', tabs(a.tabs));
  else parts.push(`last used ${lastUsed(a.lastUsedAt)}`);
  return parts.join(' · ');
}

/** The name's first letter on a neutral tile: the same for every agent, as Chord can't tell who they really are. */
function Tile({ name }: { name: string }) {
  return (
    <span className={local.tile} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function SetupLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={local.code}>
      <code className={local.codeText}>{text}</code>
      <button
        type="button"
        className={local.copy}
        aria-label={`Copy ${label}`}
        onClick={() => {
          void api.settings.copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function AgentsSettings({ snapshot }: { snapshot: SettingsSnapshot }) {
  const [view, setView] = useState<AgentsView | null>(null);
  const enabled = snapshot.settings.agentsEnabled;
  useEffect(() => {
    const refresh = () => void api.settings.agents({ do: 'view' }).then(setView);
    refresh();
    return api.settings.onAgentsChange(refresh);
  }, [snapshot]);

  return (
    <>
      <SectionHeader title="Agents" description="Let AI agents you run, like Claude Code and Codex, use Chord. They work in their own tabs and never see your passwords." />
      <div className={styles.group}>
        <Row
          label="Let agents connect"
          description="Chord asks you each time a new one tries."
          control={<Switch label="Let agents connect" checked={enabled} onChange={(agentsEnabled) => void api.settings.set({ agentsEnabled })} />}
        />
      </div>

      {view && (
        <>
          <h2 className={styles.groupTitle}>Set up</h2>
          <SetupLine text={view.setup.claude} label="the line for Claude Code" />
          <SetupLine text={view.setup.codex} label="the line for Codex" />

          {view.stopped.length > 0 && (
            <>
              <h2 className={styles.groupTitle}>Stopped</h2>
              <div className={styles.group}>
                {view.stopped.map((s) => (
                  <div key={s.id} className={local.agent}>
                    <Tile name={s.name} />
                    <div className={styles.rowText}>
                      <span className={styles.rowLabel}>{s.name}</span>
                      <span className={styles.rowDescription}>Stopped · {tabs(s.tabs)}</span>
                    </div>
                    <button type="button" className={styles.linkButton} onClick={() => void api.settings.agents({ do: 'continue', id: s.id }).then(setView)}>
                      Let {s.name} continue
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <h2 className={styles.groupTitle}>Allowed</h2>
          <p className={local.honest}>Chord goes by the name the agent gives. Remove any you don’t recognize.</p>
          {view.allowed.length === 0 ? (
            <p className={styles.groupNote}>No agents yet. Copy a line above into your terminal to connect one.</p>
          ) : (
            <div className={styles.group}>
              {view.allowed.map((a) => (
                <div key={`${a.name}\u0000${a.parent}`} className={local.agent}>
                  <Tile name={a.name} />
                  <div className={styles.rowText}>
                    <span className={styles.rowLabel}>{a.name}</span>
                    <span className={styles.rowDescription}>{allowedLine(a)}</span>
                  </div>
                  <button type="button" className={styles.linkButton} aria-label={`Remove ${a.name}`} onClick={() => void api.settings.agents({ do: 'remove', name: a.name, parent: a.parent }).then(setView)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
