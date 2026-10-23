/**
 * Settings → Site permissions (ARCHITECTURE.md §9): what you allowed or
 * blocked, site by site. Change an answer, set it back to "Ask", or forget a
 * site so it asks again for everything. Private windows' answers never show
 * here: they're gone when the window closes.
 */
import { DEFAULT_SETTINGS, type SitePermission } from '@chord/core';
import type { SettingsSnapshot, SystemInfo } from '@chord/ipc';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from './api';
import { ResetButton, Row, SectionHeader, Segmented, Switch } from './controls';
import styles from './Settings.module.css';
import local from './Sites.module.css';

const LABELS: Record<SitePermission, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'See what you’ve copied',
};

/** In this order, as in the permission prompt. */
const PERMISSIONS = Object.keys(LABELS) as SitePermission[];

type Answer = 'allow' | 'block' | 'ask';
const ANSWERS: { value: Answer; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'block', label: 'Block' },
  { value: 'ask', label: 'Ask' },
];

/** An origin as people read it: no "https://". */
const shownOrigin = (origin: string) => (origin.startsWith('https://') ? origin.slice('https://'.length) : origin);

/** Show the filter once there are more sites than fit at a glance. */
const FILTER_FROM = 6;

export function SitesSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const [filter, setFilter] = useState('');
  const sites = useMemo(
    () =>
      Object.entries(snapshot.sitePermissions)
        .map(([origin, decisions]) => ({ origin, name: shownOrigin(origin), decisions }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [snapshot.sitePermissions],
  );
  const query = filter.trim().toLowerCase();
  const shown = query ? sites.filter((s) => s.name.toLowerCase().includes(query)) : sites;
  return (
    <>
      <SectionHeader title="Site permissions" description="What you’ve allowed or blocked. A site you forget asks again the next time it needs something." />
      {sites.length === 0 ? (
        <p className={local.empty}>Sites you allow or block show up here.</p>
      ) : (
        <>
          {sites.length >= FILTER_FROM && (
            <label className={styles.filter}>
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <input value={filter} placeholder="Find a site" aria-label="Find a site" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
            </label>
          )}
          {shown.map((site) => (
            <section key={site.origin} aria-label={site.name}>
              <h2 className={`${styles.groupTitle} ${local.siteTitle}`}>
                <span className={local.siteName}>{site.name}</span>
                <button type="button" className={local.forget} onClick={() => void api.settings.forgetSite(site.origin)}>
                  Forget
                </button>
              </h2>
              <div className={styles.group}>
                {PERMISSIONS.filter((p) => site.decisions[p]).map((permission) => (
                  <Row
                    key={permission}
                    label={LABELS[permission]}
                    control={
                      <Segmented<Answer>
                        label={`${LABELS[permission]} for ${site.name}`}
                        value={site.decisions[permission]!}
                        options={ANSWERS}
                        onChange={(answer) => void api.settings.sitePermission(site.origin, permission, answer === 'ask' ? null : answer)}
                      />
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}

/** Settings → General → Spelling. */
export function Spelling({ snapshot, info }: { snapshot: SettingsSnapshot; info: SystemInfo }) {
  const { spellcheck } = snapshot.settings;
  const languages = snapshot.spellcheckLanguages;
  const names = useMemo(() => new Intl.DisplayNames([navigator.language], { type: 'language' }), []);
  const nameOf = (code: string) => {
    try {
      return names.of(code) ?? code;
    } catch {
      return code;
    }
  };
  const changed = spellcheck.enabled !== DEFAULT_SETTINGS.spellcheck.enabled || spellcheck.language !== DEFAULT_SETTINGS.spellcheck.language;
  return (
    <>
      <h2 className={styles.groupTitle}>
        Spelling
        <ResetButton visible={changed} onReset={() => void api.settings.set({ spellcheck: { ...DEFAULT_SETTINGS.spellcheck } })} />
      </h2>
      <div className={styles.group}>
        <Row
          label="Check spelling as you type"
          description="Suggestions and Add to dictionary are at the top of the right-click menu."
          control={
            <Switch label="Check spelling as you type" checked={spellcheck.enabled} onChange={(enabled) => void api.settings.set({ spellcheck: { enabled } })} />
          }
        />
        {info.platform === 'darwin' ? (
          <Row label="Languages" description="macOS checks spelling in the languages you use, as in its other apps." control={null} />
        ) : (
          languages.length > 0 && (
            <Row
              label="Language"
              description="The first time you use a language, Chord downloads its dictionary."
              control={
                <select
                  className={local.select}
                  aria-label="Spelling language"
                  value={spellcheck.language ?? ''}
                  disabled={!spellcheck.enabled}
                  onChange={(e) => void api.settings.set({ spellcheck: { language: e.target.value || null } })}
                >
                  <option value="">Same as your computer</option>
                  {languages.map((code) => (
                    <option key={code} value={code}>
                      {nameOf(code)}
                    </option>
                  ))}
                </select>
              }
            />
          )
        )}
      </div>
    </>
  );
}
