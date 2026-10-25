/**
 * Settings → Effects (DESIGN.md §7.15; ARCHITECTURE.md §9): Dry or Wet for
 * every site, and the sites you restyled, each with its own switch and
 * Remove, which asks once more in place. A private window's Effects never
 * show here: they go with the window.
 */
import type { SettingsSnapshot } from '@chord/ipc';
import { useEffect, useState } from 'react';
import { api } from './api';
import { Row, SectionHeader, Segmented, Switch } from './controls';
import styles from './Settings.module.css';
import local from './Sites.module.css';

type Mix = 'wet' | 'dry';
const MIXES: { value: Mix; label: string }[] = [
  { value: 'wet', label: 'Wet' },
  { value: 'dry', label: 'Dry' },
];

export function EffectsSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const wet = snapshot.settings.effects.wet;
  const sites = snapshot.effects;
  // "Remove?" waits five seconds for the second click.
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(null), 5000);
    return () => clearTimeout(timer);
  }, [confirm]);
  const remove = (host: string) => {
    if (confirm !== host) return setConfirm(host);
    setConfirm(null);
    void api.settings.effects({ do: 'remove', host });
  };
  return (
    <>
      <SectionHeader title="Effects" description="Your own styles for sites: your CSS, elements you hid, presets, and patches Duet wrote. They stay on this computer." />
      <h2 className={styles.groupTitle}>Every site</h2>
      <div className={styles.group}>
        <Row
          label="Effects"
          description="Dry shows every site as it comes, and keeps your Effects."
          changed={!wet}
          onReset={() => void api.settings.set({ effects: { wet: true } })}
          control={<Segmented<Mix> label="Effects on every site" value={wet ? 'wet' : 'dry'} options={MIXES} onChange={(mix) => void api.settings.set({ effects: { wet: mix === 'wet' } })} />}
        />
      </div>
      <h2 className={styles.groupTitle}>Sites</h2>
      {sites.length === 0 ? (
        <p className={local.empty}>Sites you restyle show up here. Open a site’s Effects from the page’s right-click menu or the command bar.</p>
      ) : (
        <div className={styles.group}>
          {sites.map((site) => (
            <Row
              key={site.host}
              label={site.host}
              description={site.summary}
              control={
                <span className={styles.inlineControls}>
                  <button type="button" className={styles.linkButton} onClick={() => remove(site.host)}>
                    {confirm === site.host ? 'Remove?' : 'Remove'}
                  </button>
                  <Switch label={`Wet on ${site.host}`} checked={site.wet} onChange={(on) => void api.settings.effects({ do: 'wet', host: site.host, wet: on })} />
                </span>
              }
            />
          ))}
        </div>
      )}
    </>
  );
}
