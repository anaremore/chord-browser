/**
 * Settings → General → Chord Player (ARCHITECTURE.md §9; DESIGN.md §7.13):
 * whether it's installed, which version and ECS build, an update waiting to
 * start, and Remove (it and its sign-ins), which asks once more inline.
 * Nothing shows where it can't run and isn't installed.
 */
import type { PlayerStatus } from '@chord/ipc';
import { useEffect, useState } from 'react';
import { api } from './api';
import { Row } from './controls';
import styles from './Settings.module.css';

export function PlayerSettings() {
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    const refresh = () => void api.settings.player().then(setStatus);
    refresh();
    // It installs and updates in the background: keep the row current while Settings is open.
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);
  // "Remove it and its sign-ins?" waits five seconds for the second click.
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(timer);
  }, [confirm]);
  if (!status || (!status.available && !status.installed)) return null;
  const { installed } = status;
  const remove = () => {
    if (!confirm) return setConfirm(true);
    setConfirm(false);
    setRemoving(true);
    void api.settings
      .removePlayer()
      .then(setStatus)
      .finally(() => setRemoving(false));
  };
  return (
    <>
      <h2 className={styles.groupTitle}>Chord Player</h2>
      <div className={styles.group}>
        {status.googleFree ? (
          <Row label="Chord Player" description="Off in Google-free mode, because Widevine, which it plays with, comes from Google." control={<span className={styles.value}>Off</span>} />
        ) : installed ? (
          <Row
            label={`Chord Player ${installed.version}`}
            description={`Plays Netflix, Spotify and the other services that need Widevine, in a window of its own, on castLabs ECS ${installed.ecs.replace('+wvcus', '')}.${status.pending ? ` Version ${status.pending} starts the next time it opens.` : ''} Removing it signs you out of them there.`}
            control={
              <button type="button" className={styles.linkButton} disabled={removing} onClick={remove}>
                {removing ? 'Removing…' : confirm ? 'Remove it and its sign-ins?' : 'Remove'}
              </button>
            }
          />
        ) : (
          <Row label="Chord Player" description="Plays Netflix, Spotify and the other services that need Widevine, in a window of its own. It installs from the notice on their pages." control={null} />
        )}
      </div>
    </>
  );
}
