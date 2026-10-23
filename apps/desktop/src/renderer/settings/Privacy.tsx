/**
 * Settings → Privacy: what Chord sends and what it keeps.
 *
 * Google-free mode (docs/decisions/S10-google-free.md).
 * With it on, Chord itself doesn't contact Google: searches and suggestions
 * go to the engine chosen here, spelling uses only dictionaries already
 * downloaded, and Web Store extensions don't check for updates in the
 * background. Pages you visit can still load from Google.
 */
import { DEFAULT_SETTINGS, SEARCH_ENGINES } from '@chord/core';
import type { SettingsSnapshot } from '@chord/ipc';
import { Check } from 'lucide-react';
import { api } from './api';
import { RadioGroup, Row, SectionHeader, Switch } from './controls';
import styles from './Settings.module.css';

export function PrivacySection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { googleFree, searchEngine } = snapshot.settings;
  return (
    <>
      <SectionHeader title="Privacy" description="What Chord itself sends and keeps, apart from the sites you visit." />
      <div className={styles.group}>
        <Row
          label="Google-free mode"
          description="Chord stops contacting Google on its own. Sites you visit can still load things from Google, and signing in to Google still works."
          changed={googleFree !== DEFAULT_SETTINGS.googleFree}
          onReset={() => void api.settings.set({ googleFree: DEFAULT_SETTINGS.googleFree })}
          control={<Switch label="Google-free mode" checked={googleFree} onChange={(on) => void api.settings.set({ googleFree: on })} />}
        />
      </div>
      {googleFree && (
        <>
          <h2 className={styles.groupTitle}>Search with</h2>
          <RadioGroup className={styles.group} label="Search with">
            {SEARCH_ENGINES.filter((e) => e.id !== 'google').map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={e.id === searchEngine}
                className={styles.choice}
                onClick={() => void api.settings.set({ searchEngine: e.id })}
              >
                <span className={styles.rowLabel}>{e.name}</span>
                <span className={styles.choiceHost}>{new URL(e.prefix).host}</span>
                {e.id === searchEngine && <Check className={styles.check} size={16} strokeWidth={2.25} aria-hidden />}
              </button>
            ))}
          </RadioGroup>
          <h2 className={styles.groupTitle}>Also changed</h2>
          <div className={styles.group}>
            <Row
              label="Search suggestions"
              description={
                snapshot.settings.searchSuggestions
                  ? 'Come from the engine above, never from Google.'
                  : 'Off. You can turn them on in General; they come from the engine above.'
              }
              control={null}
            />
            <Row
              label="Spelling"
              description="Uses only dictionaries already on this computer, and the system’s own spellchecker. New ones would download from Google."
              control={null}
            />
            <Row
              label="Chrome Web Store extensions"
              description="Don’t check for updates in the background, because the Web Store is Google’s. Settings → Extensions can still check when you ask."
              control={null}
            />
            <Row label="Chord updates" description="Still checked once a day, with GitHub, not Google." control={null} />
          </div>
        </>
      )}
      {/* What Chord keeps on this computer that you might not expect (DESIGN.md §7.6). */}
      <h2 className={styles.groupTitle}>On this computer</h2>
      <div className={styles.group}>
        <Row
          label="Show page previews"
          description="Hovering a pinned tab or folder shows a preview. Chord keeps a small picture of each pinned page on this computer for it; turning this off deletes them."
          changed={snapshot.settings.pagePreviews !== DEFAULT_SETTINGS.pagePreviews}
          onReset={() => void api.settings.set({ pagePreviews: DEFAULT_SETTINGS.pagePreviews })}
          control={<Switch label="Show page previews" checked={snapshot.settings.pagePreviews} onChange={(pagePreviews) => void api.settings.set({ pagePreviews })} />}
        />
      </div>
    </>
  );
}
