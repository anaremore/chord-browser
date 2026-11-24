/**
 * Settings → Agents (S18 M1d; mocks/agents-s18-m1.html §4): the switch for
 * the whole feature (off by default), the lines that connect Claude Code and
 * Codex, agents you've stopped, and agents you've let in for good.
 */
import type { AgentsView, AntigravityAnswer, SettingsSnapshot } from '@chord/ipc';
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

/** What *Add to Antigravity* says when it can't (the owner's mock B, 2026-11-21). */
const ANTIGRAVITY_PROBLEMS: Record<Exclude<AntigravityAnswer, { ok: true }>['why'], string> = {
  invalid: 'Antigravity’s MCP config isn’t valid JSON, so Chord left it as it is.',
  link: 'Antigravity’s MCP config is a link to another file, so Chord left it as it is.',
  unwritable: 'Chord couldn’t change Antigravity’s MCP config.',
  changed: 'Chord’s entry in Antigravity’s MCP config has changed since, so Chord left it as it is.',
  gone: 'There’s nothing to undo.',
};

/**
 * Antigravity: no command of its own to paste, so Chord adds itself to its MCP config, with Undo. The result shows
 * under the row, as the mock draws it.
 */
function AntigravityRow() {
  const [said, setSaid] = useState<{ text: string; undo: string | null } | null>(null);
  // An Undo that couldn't read or write the file keeps its button, to try again.
  const run = (request: Parameters<typeof api.settings.antigravity>[0], done: string) =>
    void api.settings.antigravity(request).then((answer) =>
      setSaid(answer.ok ? { text: done, undo: answer.token } : { text: ANTIGRAVITY_PROBLEMS[answer.why], undo: request.do === 'undo' && answer.why !== 'changed' && answer.why !== 'gone' ? request.token : null }),
    );
  return (
    <>
      <div className={local.addRow}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>Antigravity</span>
          <span className={styles.rowDescription}>Adds Chord to Antigravity’s MCP servers</span>
        </div>
        <button type="button" className={local.add} onClick={() => run({ do: 'add' }, 'Added Chord to Antigravity. Refresh or restart its MCP servers to see it.')}>
          Add to Antigravity
        </button>
      </div>
      <div className={local.said} role="status">
        {said && (
          <>
            <span>{said.text}</span>
            {said.undo && (
              <button type="button" className={local.copy} onClick={() => run({ do: 'undo', token: said.undo! }, 'Antigravity’s MCP servers are as they were.')}>
                Undo
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function AgentsSettings({ snapshot }: { snapshot: SettingsSnapshot }) {
  const [view, setView] = useState<AgentsView | null>(null);
  // The sites each agent may act on (M2c): only in a build where agents act on pages.
  const sitesShown = Boolean(view?.acting);
  const enabled = snapshot.settings.agentsEnabled;
  useEffect(() => {
    const refresh = () => void api.settings.agents({ do: 'view' }).then(setView);
    refresh();
    return api.settings.onAgentsChange(refresh);
  }, [snapshot]);

  return (
    <>
      <SectionHeader title="Agents" description="Let AI agents you run, like Claude Code, Codex and Antigravity, use Chord. They work in their own tabs and never see your passwords." />
      <div className={styles.group}>
        <Row
          label="Let agents connect"
          description="Chord asks you each time a new one tries."
          control={<Switch label="Let agents connect" checked={enabled} onChange={(agentsEnabled) => void api.settings.set({ agentsEnabled })} />}
        />
      </div>
      {/* A stated limit (the owner, 2026-11-23): extensions' content scripts run in agents' tabs too. */}
      <p className={styles.groupNote}>Your extensions still run in agents’ tabs, so a password manager’s extension could fill in a page an agent is working on.</p>

      {view && (
        <>
          <h2 className={styles.groupTitle}>Set up</h2>
          <SetupLine text={view.setup.claude} label="the line for Claude Code" />
          <SetupLine text={view.setup.codex} label="the line for Codex" />
          <AntigravityRow />

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
                <div key={`${a.name}\u0000${a.parent}`}>
                  <div className={local.agent}>
                    <Tile name={a.name} />
                    <div className={styles.rowText}>
                      <span className={styles.rowLabel}>{a.name}</span>
                      <span className={styles.rowDescription}>{allowedLine(a)}</span>
                    </div>
                    <button type="button" className={styles.linkButton} aria-label={`Remove ${a.name}`} onClick={() => void api.settings.agents({ do: 'remove', name: a.name, parent: a.parent }).then(setView)}>
                      Remove
                    </button>
                  </div>
                  {/* The sites it may act on without asking (M2c, the site card's Always on this site), each with Remove. */}
                  {sitesShown && (
                    <div className={local.sites} role="group" aria-label={`Sites ${a.name} can click and type on`}>
                      {a.sites.length > 0 && <p className={local.sitesCaption}>Can click and type on</p>}
                      {a.sites.map((site) => (
                        <div key={site} className={local.site}>
                          <span className={local.siteName}>{site}</span>
                          <button type="button" className={styles.linkButton} aria-label={`Remove ${site} for ${a.name}`} onClick={() => void api.settings.agents({ do: 'removeSite', name: a.name, parent: a.parent, site }).then(setView)}>
                            Remove
                          </button>
                        </div>
                      ))}
                      <p className={local.sitesCaption}>{a.sites.length > 0 ? 'It asks before acting on any other site.' : 'Asks before acting on any site.'}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
