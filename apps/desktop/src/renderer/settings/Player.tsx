/**
 * Settings → General → Chord Player (ARCHITECTURE.md §9; DESIGN.md §7.14):
 * whether it's installed, which version and ECS build, an update waiting to
 * start, and Remove (it and its sign-ins), which asks once more inline. Not
 * installed, it offers Install when there's a release to install (never in
 * Google-free mode), with the notice's progress and failures; installing here
 * opens nothing. Nothing shows where it can't run and isn't installed.
 */
import type { PlayerStatus } from '@chord/ipc';
import { useEffect, useState } from 'react';
import { installingLabel, megabytes, PLAYER_FAILURES } from '../shared/player';
import { api } from './api';
import { Row } from './controls';
import styles from './Settings.module.css';

/** Where it plays: in the tab on Windows, in a window of its own elsewhere (ARCHITECTURE.md §9). */
const where = (status: PlayerStatus | null) => (status?.inTab ? 'right in the tab' : 'in a window of its own');
const description = (status: PlayerStatus | null) => `Plays Netflix, Spotify and the other services that need Widevine, ${where(status)}.`;

export function PlayerSettings() {
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [installing, setInstalling] = useState(false);
  // Progress moves quickly; otherwise it installs and updates in the background, and the row keeps up every few seconds.
  const fast = installing || status?.install?.state === 'installing';
  useEffect(() => {
    const refresh = () => void api.settings.player().then(setStatus);
    refresh();
    const timer = setInterval(refresh, fast ? 500 : 5000);
    return () => clearInterval(timer);
  }, [fast]);
  // "Remove it and its sign-ins?" waits five seconds for the second click.
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(timer);
  }, [confirm]);
  if (!status || (!status.available && !status.installed)) return null;
  const { installed, install } = status;
  const remove = () => {
    if (!confirm) return setConfirm(true);
    setConfirm(false);
    setRemoving(true);
    void api.settings
      .removePlayer()
      .then(setStatus)
      .finally(() => setRemoving(false));
  };
  const startInstall = () => {
    setInstalling(true);
    void api.settings
      .installPlayer()
      .then(setStatus)
      .finally(() => setInstalling(false));
  };
  let row;
  if (status.googleFree) {
    row = <Row label="Chord Player" description="Off in Google-free mode, because Widevine, which it plays with, comes from Google." control={<span className={styles.value}>Off</span>} />;
  } else if (installed) {
    row = (
      <Row
        label={`Chord Player ${installed.version}`}
        description={`Plays Netflix, Spotify and the other services that need Widevine, ${where(status)}, on castLabs ECS ${installed.ecs.replace('+wvcus', '')}.${status.pending ? ` Version ${status.pending} starts the next time it opens.` : ''} Removing it signs you out of them there.`}
        control={
          <button type="button" className={styles.linkButton} disabled={removing} onClick={remove}>
            {removing ? 'Removing…' : confirm ? 'Remove it and its sign-ins?' : 'Remove'}
          </button>
        }
      />
    );
  } else if (install?.state === 'installing') {
    row = <Row label={installingLabel(install)} description="You can keep browsing." control={null} />;
  } else if (install?.state === 'install') {
    row = (
      <Row
        label="Chord Player"
        description={`${description(status)} The download is about ${megabytes(install.size)} MB.`}
        control={
          <button type="button" className={styles.linkButton} disabled={installing} onClick={startInstall}>
            {install.update ? 'Update' : 'Install'}
          </button>
        }
      />
    );
  } else if (install?.state === 'failed') {
    row = (
      <Row
        label="Chord Player"
        description={PLAYER_FAILURES[install.why]}
        control={
          <button type="button" className={styles.linkButton} disabled={installing} onClick={startInstall}>
            Try again
          </button>
        }
      />
    );
  } else {
    row = <Row label="Chord Player" description={`${description(status)} It installs from the notice on their pages.`} control={null} />;
  }
  return (
    <>
      <h2 className={styles.groupTitle}>Chord Player</h2>
      <div className={styles.group}>{row}</div>
    </>
  );
}
