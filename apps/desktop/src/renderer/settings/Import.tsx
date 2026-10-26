/**
 * Settings → Your data → From another browser (DESIGN.md §8.7): bookmarks,
 * history and open tabs from another browser on this computer, each top-level
 * folder mapped to a chord. It lands in the window behind Settings, which
 * offers Undo in a toast; Undo is here too, since Settings may be covering
 * that window.
 */
import type { SettingsSnapshot, SystemInfo } from '@chord/ipc';
import { ImportDetails, ImportSources, NEVER_COPIED, useImport } from '../shared/ImportPanel';
import { api } from './api';
import local from './Import.module.css';
import styles from './Settings.module.css';

export function FromAnotherBrowser({ snapshot, info }: { snapshot: SettingsSnapshot; info: SystemInfo }) {
  const flow = useImport(api.imports);
  const looks = info.platform === 'darwin' ? 'Chrome, Edge, Brave, Firefox and Safari' : 'Chrome, Edge, Brave and Firefox';
  const phase = flow.progress?.phase;
  const finished = phase === 'done' || phase === 'failed' || phase === 'undone';
  return (
    <>
      <h2 className={styles.groupTitle}>From another browser</h2>
      {flow.sources?.length === 0 ? (
        <div className={styles.group}>
          <p className={local.empty}>{`No other browsers found. Chord looks for ${looks}.`}</p>
        </div>
      ) : (
        <ImportSources flow={flow} />
      )}
      {flow.source && (
        <>
          <h2 className={styles.groupTitle}>What comes across</h2>
          <ImportDetails flow={flow} chords={snapshot.chords} onOpenAccess={() => void api.imports.openAccess()} />
          {!flow.problem && !flow.reading && flow.summary && (
            <div className={local.actions}>
              {!flow.progress && (
                <button type="button" className={styles.linkButton} disabled={!flow.ready} onClick={() => void flow.start()}>
                  Import
                </button>
              )}
              {flow.progress && phase !== 'undone' && (
                <button type="button" className={styles.linkButton} onClick={flow.undo}>
                  Undo
                </button>
              )}
              {finished && (
                <button type="button" className={styles.linkButton} onClick={flow.reset}>
                  Import more
                </button>
              )}
            </div>
          )}
        </>
      )}
      <p className={styles.groupNote}>{NEVER_COPIED}</p>
    </>
  );
}
