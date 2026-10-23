/**
 * Settings → Extensions (ARCHITECTURE.md §12): add an extension from the
 * Chrome Web Store, see what's installed, open an extension's options, and
 * remove one. Removing asks a second time in place, never in a dialog.
 */
import { DEFAULT_SETTINGS, type ExtensionButtons } from '@chord/core';
import type { ExtensionInfo, SettingsSnapshot } from '@chord/ipc';
import { Puzzle, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { Row, SectionHeader, Segmented } from './controls';
import styles from './Extensions.module.css';
import settingsStyles from './Settings.module.css';

const WEB_STORE_URL = 'https://chromewebstore.google.com/category/extensions';

type Status = { kind: 'idle' } | { kind: 'busy'; text: string } | { kind: 'done'; text: string } | { kind: 'error'; text: string };

function AddExtension() {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || status.kind === 'busy') return;
    setStatus({ kind: 'busy', text: 'Adding…' });
    const result = await api.extensions.install(text);
    if (result.ok) {
      setInput('');
      setStatus({ kind: 'done', text: `Added ${result.name}.` });
    } else {
      setStatus({ kind: 'error', text: result.error });
    }
  };
  return (
    <form className={styles.add} onSubmit={(e) => void submit(e)}>
      <input
        className={styles.input}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          if (status.kind !== 'busy') setStatus({ kind: 'idle' });
        }}
        placeholder="Paste a Chrome Web Store link or an extension ID"
        aria-label="Chrome Web Store link or extension ID"
        aria-describedby="extension-add-status"
        spellCheck={false}
      />
      <button type="submit" className={styles.primary} disabled={!input.trim() || status.kind === 'busy'}>
        {status.kind === 'busy' ? 'Adding…' : 'Add'}
      </button>
      <p id="extension-add-status" className={styles.status} data-kind={status.kind} role="status">
        {status.kind === 'idle' ? '' : status.text}
      </p>
    </form>
  );
}

function ExtensionRow({ extension }: { extension: ExtensionInfo }) {
  const [confirming, setConfirming] = useState(false);
  // "Remove" asks once more in place; the question goes away if it isn't answered.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);
  return (
    <div className={settingsStyles.row} role="listitem" aria-label={extension.name}>
      {extension.icon ? <img className={styles.icon} src={extension.icon} alt="" draggable={false} /> : <Puzzle className={styles.iconFallback} size={20} strokeWidth={1.75} aria-hidden />}
      <div className={settingsStyles.rowText}>
        <span className={settingsStyles.rowLabel}>
          {extension.name}
          <span className={styles.version}>{extension.version}</span>
          {extension.source === 'unpacked' && <span className={styles.tag}>Unpacked</span>}
          {!extension.loaded && <span className={styles.tag}>Didn’t load</span>}
        </span>
        {extension.description && <span className={`${settingsStyles.rowDescription} ${styles.description}`}>{extension.description}</span>}
      </div>
      {extension.hasOptions && extension.loaded && (
        <button type="button" className={styles.quiet} onClick={() => void api.extensions.options(extension.profileId, extension.id)}>
          Options
        </button>
      )}
      <button
        type="button"
        className={styles.quiet}
        data-danger={confirming || undefined}
        aria-label={confirming ? `Remove ${extension.name} for good` : `Remove ${extension.name}`}
        onClick={() => {
          if (!confirming) return setConfirming(true);
          void api.extensions.remove(extension.profileId, extension.id);
        }}
      >
        {confirming ? 'Remove for good?' : 'Remove'}
      </button>
    </div>
  );
}

function CheckForUpdates() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  return (
    <span className={styles.updates}>
      <span className={styles.status} data-kind={status.kind} role="status">
        {status.kind === 'idle' ? '' : status.text}
      </span>
      <button
        type="button"
        className={styles.quiet}
        disabled={status.kind === 'busy'}
        onClick={() => {
          setStatus({ kind: 'busy', text: 'Checking…' });
          void api.extensions.update().then((n) => setStatus({ kind: 'done', text: n === 0 ? 'Everything is up to date.' : `Updated ${n}.` }));
        }}
      >
        <RefreshCw size={14} strokeWidth={2} aria-hidden /> Check for updates
      </button>
    </span>
  );
}

export function ExtensionsSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { extensions, settings } = snapshot;
  return (
    <>
      <SectionHeader
        title="Extensions"
        description="Chrome extensions from the Chrome Web Store: password managers, blockers, and more. Each one is checked against the store’s signature before it’s installed."
      />
      <div className={settingsStyles.group}>
        <Row
          label="Show extension buttons"
          description="Pinned extensions get a button. The puzzle piece lists them all."
          changed={settings.extensionButtons !== DEFAULT_SETTINGS.extensionButtons}
          onReset={() => void api.settings.set({ extensionButtons: DEFAULT_SETTINGS.extensionButtons })}
          control={
            <Segmented<ExtensionButtons>
              label="Show extension buttons"
              value={settings.extensionButtons}
              options={[
                { value: 'sidebar', label: 'In the sidebar' },
                { value: 'titleBar', label: 'In the title bar' },
              ]}
              onChange={(extensionButtons) => void api.settings.set({ extensionButtons })}
            />
          }
        />
      </div>

      <h2 className={settingsStyles.groupTitle}>Add an extension</h2>
      <AddExtension />
      <p className={styles.hint}>
        Find one in the{' '}
        <button type="button" className={styles.link} onClick={() => void api.settings.openUrl(WEB_STORE_URL)}>
          Chrome Web Store
        </button>
        . On an extension’s page there, “Add to Chord” appears with your extension buttons; or paste its link here.
      </p>

      <div className={styles.listHead}>
        <h2 className={settingsStyles.groupTitle}>Installed</h2>
        {extensions.some((e) => e.source === 'store') && <CheckForUpdates />}
      </div>
      {extensions.length === 0 ? (
        <p className={styles.empty}>No extensions yet.</p>
      ) : (
        <div className={settingsStyles.group} role="list" aria-label="Installed extensions">
          {extensions.map((e) => (
            <ExtensionRow key={`${e.profileId}:${e.id}`} extension={e} />
          ))}
        </div>
      )}
    </>
  );
}
