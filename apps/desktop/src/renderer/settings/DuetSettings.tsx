/**
 * Settings → Duet (ARCHITECTURE.md §11, DESIGN.md §8.6): on or off, which of
 * your own CLIs it uses, what it may read without asking, sites it never
 * reads, and how long chats are kept.
 */
import { DEFAULT_SETTINGS, DUET_PROVIDER_NAMES, DUET_READS_NOTHING, DUET_SCOPE_HINTS, DUET_SCOPE_NAMES, DUET_SCOPES, type DuetKeep, type DuetScope } from '@chord/core';
import type { DuetProviderInfo, SettingsSnapshot } from '@chord/ipc';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api';
import { RadioGroup, ResetButton, Row, SectionHeader, Segmented, Switch } from './controls';
import styles from './Settings.module.css';

/** What Duet can read, least to most: Settings' "Nothing", then the scopes a chat can also choose. */
const READING: { key: 'nothing' | DuetScope; name: string; hint: string }[] = [
  { key: 'nothing', ...DUET_READS_NOTHING },
  ...DUET_SCOPES.map((s) => ({ key: s, name: DUET_SCOPE_NAMES[s], hint: DUET_SCOPE_HINTS[s] })),
];

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
                : `Installed ${p.version ?? ''}${p.signedIn ? ' · Signed in' : p.signedIn === false ? ' · Not signed in' : ''}${p.billing === 'api-key' ? ' · Using your API key, billed to it' : ''}${p.tooOld ? ' · Needs an update' : ''}${p.path ? ` · ${p.path}` : ''}`
            }
            control={
              // Too old to say whether it's signed in (signedIn null): the description says it needs an update.
              p.installed && p.signedIn === false ? (
                <button type="button" className={styles.linkButton} onClick={() => void api.settings.duet({ do: 'signIn', provider: p.provider }).then(setProviders)}>
                  Sign in
                </button>
              ) : p.installed && p.signedIn ? (
                <Switch label={`Use ${DUET_PROVIDER_NAMES[p.provider]}`} checked={duet.provider === p.provider} onChange={(on) => set({ provider: on ? p.provider : null })} />
              ) : null
            }
          />
        ))}
        <Row
          label="Codex can make images"
          description="When you ask, Codex makes them with its own image tool, within your plan's limits. They're kept with the chat, and deleted with it, Codex's own copy too."
          changed={duet.codexImages !== DEFAULT_SETTINGS.duet.codexImages}
          onReset={() => set({ codexImages: DEFAULT_SETTINGS.duet.codexImages })}
          control={<Switch label="Codex can make images" checked={duet.codexImages} onChange={(codexImages) => set({ codexImages })} />}
        />
      </div>

      <h2 className={styles.groupTitle}>
        What Duet can read
        <ResetButton
          label="Reset What Duet can read to default"
          visible={duet.readsNothing !== DEFAULT_SETTINGS.duet.readsNothing || duet.scope !== DEFAULT_SETTINGS.duet.scope}
          onReset={() => set({ readsNothing: DEFAULT_SETTINGS.duet.readsNothing, scope: DEFAULT_SETTINGS.duet.scope })}
        />
      </h2>
      <RadioGroup className={styles.group} label="What Duet can read">
        {READING.map((r) => {
          const chosen = r.key === 'nothing' ? duet.readsNothing : !duet.readsNothing && duet.scope === r.key;
          return (
            <button
              key={r.key}
              type="button"
              role="radio"
              aria-checked={chosen}
              className={styles.choice}
              onClick={() => set(r.key === 'nothing' ? { readsNothing: true } : { readsNothing: false, scope: r.key })}
            >
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>{r.name}</span>
                <span className={styles.rowDescription}>{r.hint}</span>
              </span>
              {chosen && <Check className={styles.check} size={16} strokeWidth={2.25} aria-hidden />}
            </button>
          );
        })}
      </RadioGroup>
      <p className={styles.groupNote}>
        Each chat can choose for itself from Duet’s panel, except Nothing, which only changes here. Whatever you choose, Duet only reads, and never sees private windows, form fields, or the sites below.
      </p>
      <div className={`${styles.group} ${styles.groupAfter}`}>
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
