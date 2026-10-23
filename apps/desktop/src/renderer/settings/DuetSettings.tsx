/**
 * Settings → Duet (ARCHITECTURE.md §11, DESIGN.md §8.6): on or off, which of
 * your own CLIs it uses, what it may read without asking, sites it never
 * reads, and how long chats are kept.
 */
import { DEFAULT_SETTINGS, DUET_PROVIDER_NAMES, DUET_SCOPE_NAMES, type DuetKeep, type DuetScope } from '@chord/core';
import type { DuetProviderInfo, SettingsSnapshot } from '@chord/ipc';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api';
import { Row, SectionHeader, Segmented, Switch } from './controls';
import styles from './Settings.module.css';

export function DuetSettings({ snapshot }: { snapshot: SettingsSnapshot }) {
  const duet = snapshot.settings.duet;
  const [providers, setProviders] = useState<DuetProviderInfo[]>([]);
  const [site, setSite] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    void api.settings.duet({ do: 'detect' }).then(setProviders);
    const refresh = () => void api.settings.duet({ do: 'detect' }).then(setProviders);
    // After signing in in a terminal, coming back shows the new state.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmClear]);
  const set = (patch: Partial<typeof duet>) => void api.settings.set({ duet: patch });
  const addSite = () => {
    const value = site.trim().toLowerCase();
    if (!value) return;
    set({ neverSites: [...duet.neverSites, value] });
    setSite('');
  };

  return (
    <>
      <SectionHeader title="Duet" description="Chat about your pages and tabs with your own Claude Code or Codex. Chord never sees your sign-in." />
      <div className={styles.group}>
        <Row
          label="Show Duet"
          description="Off removes the panel, its button and shortcut. Nothing runs."
          control={<Switch label="Show Duet" checked={duet.enabled} onChange={(enabled) => set({ enabled })} />}
        />
      </div>

      <h2 className={styles.groupTitle}>On this computer</h2>
      <div className={styles.group}>
        {providers.map((p) => (
          <Row
            key={p.provider}
            label={p.wsl ? `${DUET_PROVIDER_NAMES[p.provider]} in WSL (${p.wsl})` : DUET_PROVIDER_NAMES[p.provider]}
            description={
              !p.installed
                ? 'Not installed.'
                : `Installed ${p.version ?? ''}${p.signedIn ? ' · Signed in' : ' · Not signed in'}${p.billing === 'api-key' ? ' · Using your API key, billed to it' : ''}${p.tooOld ? ' · Needs an update' : ''}${p.path ? ` · ${p.path}` : ''}`
            }
            control={
              p.installed && !p.signedIn ? (
                <button type="button" className={styles.linkButton} onClick={() => void api.settings.duet({ do: 'signIn', provider: p.provider }).then(setProviders)}>
                  Sign in
                </button>
              ) : p.installed ? (
                <Switch label={`Use ${DUET_PROVIDER_NAMES[p.provider]}`} checked={duet.provider === p.provider} onChange={(on) => set({ provider: on ? p.provider : null })} />
              ) : null
            }
          />
        ))}
      </div>

      <h2 className={styles.groupTitle}>Reading</h2>
      <div className={styles.group}>
        <Row
          label="Duet can read without asking"
          description="What you attach is always readable. Beyond it, Duet asks first, or reads what you allow here. Each chat can change this."
          changed={duet.scope !== DEFAULT_SETTINGS.duet.scope}
          onReset={() => set({ scope: DEFAULT_SETTINGS.duet.scope })}
          control={
            <Segmented<DuetScope>
              label="Duet can read without asking"
              value={duet.scope}
              options={(['ask', 'chord', 'all'] as const).map((s) => ({ value: s, label: DUET_SCOPE_NAMES[s] }))}
              onChange={(scope) => set({ scope })}
            />
          }
        />
        <Row
          label="Never read"
          description="Sites Duet can't read or have attached, whatever a chat allows. Private windows, Chord's pages and form fields are never read."
          control={
            <span className={styles.slider}>
              <input
                className={styles.siteInput}
                value={site}
                placeholder="bank.example"
                aria-label="Add a site Duet never reads"
                onChange={(e) => setSite(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addSite()}
              />
            </span>
          }
        />
        {duet.neverSites.map((s) => (
          <Row
            key={s}
            label={s}
            control={
              <button type="button" className={styles.reset} data-visible aria-label={`Allow Duet to read ${s} again`} onClick={() => set({ neverSites: duet.neverSites.filter((x) => x !== s) })}>
                <X size={13} strokeWidth={2} />
              </button>
            }
          />
        ))}
      </div>

      <h2 className={styles.groupTitle}>Chats</h2>
      <div className={styles.group}>
        <Row
          label="Keep Duet chats"
          description="Older chats are deleted, with the provider's local copy."
          changed={duet.keep !== DEFAULT_SETTINGS.duet.keep}
          onReset={() => set({ keep: DEFAULT_SETTINGS.duet.keep })}
          control={
            <Segmented<DuetKeep>
              label="Keep Duet chats"
              value={duet.keep}
              options={[
                { value: 'forever', label: 'Forever' },
                { value: '90d', label: '90 days' },
                { value: '30d', label: '30 days' },
              ]}
              onChange={(keep) => set({ keep })}
            />
          }
        />
        <Row
          label="Clear all Duet chats"
          description="Claude Code and Codex keep their own local copy of each chat while it exists; deleting a chat deletes theirs too."
          control={
            <button type="button" className={styles.linkButton} onClick={() => (confirmClear ? (setConfirmClear(false), void api.settings.duet({ do: 'clearAll' })) : setConfirmClear(true))}>
              {confirmClear ? 'Clear them all?' : 'Clear all'}
            </button>
          }
        />
      </div>
    </>
  );
}
