/**
 * Settings → Privacy: what Chord sends and what it keeps.
 *
 * Safe Browsing (ARCHITECTURE.md §14.5): warnings before suspected phishing
 * and malware, from Google's lists. Its notice sits beside the switch, so
 * it's read before it's on, as Google's terms ask. Builds without Google's
 * API key can't turn it on, and Google-free mode keeps it off.
 *
 * Google-free mode (docs/decisions/S10-google-free.md).
 * With it on, Chord itself doesn't contact Google: searches and suggestions
 * go to the engine chosen here, spelling uses only dictionaries already
 * downloaded, Web Store extensions don't check for updates in the
 * background, and Safe Browsing is off. Pages you visit can still load from Google.
 *
 * Ad and tracker blocking (ARCHITECTURE.md §9): on by default, with what the
 * lists' host sees beside the switch, and the sites it's off for.
 */
import { AD_BLOCKING_NOTICE, blockingSite, DEFAULT_SETTINGS, SAFE_BROWSING_NOTICE, SEARCH_ENGINES } from '@chord/core';
import type { AdBlockingStatus, SafeBrowsingStatus, SettingsSnapshot } from '@chord/ipc';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api';
import { RadioGroup, Row, SectionHeader, Switch } from './controls';
import styles from './Settings.module.css';

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const count = new Intl.NumberFormat();

function updatedAgo(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return relativeTime.format(-minutes, 'minute');
  if (minutes < 48 * 60) return relativeTime.format(-Math.round(minutes / 60), 'hour');
  return relativeTime.format(-Math.round(minutes / 1440), 'day');
}

/** How the lists are doing, once it's on. */
function listsLine(status: SafeBrowsingStatus): string {
  if (status.failing) return 'Couldn’t update Google’s lists just now. Chord tries again later, and keeps checking with the lists it has.';
  if (status.updatedAt === null) return 'Getting Google’s lists…';
  return `${count.format(status.entries)} entries on this computer, updated ${updatedAgo(status.updatedAt)}. Chord updates them as often as Google asks.`;
}

/** A list's `! Version:` (202610241817) as a date people read. */
function listDate(version: string | null): string | null {
  const m = version ? /^(\d{4})(\d{2})(\d{2})/.exec(version) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;
}

/** Which lists, from when, and how their refresh is doing. */
function blockingListsLine(status: AdBlockingStatus): string {
  const lists = status.lists.map((l) => `${l.name}${listDate(l.version) ? ` from ${listDate(l.version)}` : ''}`).join(' and ');
  if (status.failing) return `${lists}. Couldn’t get newer ones just now; Chord tries again later and keeps blocking with these.`;
  const checked = status.lists.map((l) => l.checkedAt).filter((at): at is number => at !== null);
  return checked.length ? `${lists}, checked for updates ${updatedAgo(Math.min(...checked))}.` : `${lists}, as this copy of Chord came. Chord checks for newer ones every few days.`;
}

function AdBlocking({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { enabled, offSites } = snapshot.settings.adBlocking;
  const [status, setStatus] = useState<AdBlockingStatus | null>(null);
  const [site, setSite] = useState('');
  useEffect(() => {
    void api.settings.adBlocking().then(setStatus);
  }, [enabled]);
  const set = (patch: Partial<typeof snapshot.settings.adBlocking>) => void api.settings.set({ adBlocking: patch });
  const added = blockingSite(site.trim());
  const addSite = () => {
    if (!added) return;
    set({ offSites: [...offSites, added] });
    setSite('');
  };
  return (
    <>
      <h2 className={styles.groupTitle}>Ads and trackers</h2>
      <div className={styles.group}>
        <Row
          label="Block ads and trackers"
          description={AD_BLOCKING_NOTICE}
          changed={enabled !== DEFAULT_SETTINGS.adBlocking.enabled}
          onReset={() => set({ enabled: DEFAULT_SETTINGS.adBlocking.enabled })}
          control={<Switch label="Block ads and trackers" checked={enabled} onChange={(on) => set({ enabled: on })} />}
        />
        {enabled && status && <Row label="The lists" description={blockingListsLine(status)} control={null} />}
        {enabled && (
          <Row
            label="Don’t block on"
            description="Sites where nothing is blocked, their subdomains too. A page’s right-click menu turns it off or on for its site."
            control={
              <span className={styles.slider}>
                <input
                  className={styles.siteInput}
                  value={site}
                  placeholder="news.example"
                  aria-label="Add a site where ads aren’t blocked"
                  onChange={(e) => setSite(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addSite()}
                />
              </span>
            }
          />
        )}
        {enabled &&
          offSites.map((s) => (
            <Row
              key={s}
              label={s}
              control={
                <button type="button" className={styles.reset} data-visible aria-label={`Block ads on ${s} again`} onClick={() => set({ offSites: offSites.filter((x) => x !== s) })}>
                  <X size={13} strokeWidth={2} />
                </button>
              }
            />
          ))}
      </div>
      <p className={styles.groupNote}>EasyList and EasyPrivacy, by the EasyList authors. Pages are filtered in every window, private ones too, and a private window’s own exceptions are forgotten with it.</p>
    </>
  );
}

function SafeBrowsing({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { safeBrowsing, googleFree } = snapshot.settings;
  const [status, setStatus] = useState<SafeBrowsingStatus | null>(null);
  useEffect(() => {
    const refresh = () => void api.settings.safeBrowsing().then(setStatus);
    refresh();
    // The lists update in the background: keep their line current while this is open.
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [safeBrowsing, googleFree]);
  if (!status) return null;
  return (
    <>
      <h2 className={styles.groupTitle}>Safe Browsing</h2>
      <div className={styles.group}>
        {!status.available ? (
          <Row
            label="Safe Browsing"
            description="Not in this build. Warnings about suspected phishing and malware need Google’s API key, which Chord’s own releases include."
            control={null}
          />
        ) : googleFree ? (
          <Row label="Safe Browsing" description="Off in Google-free mode, because its lists come from Google. Turn Google-free mode off to use it." control={<span className={styles.value}>Off</span>} />
        ) : (
          <Row
            label="Warn before suspected phishing and malware"
            description={SAFE_BROWSING_NOTICE}
            control={<Switch label="Safe Browsing" checked={safeBrowsing} onChange={(on) => void api.settings.set({ safeBrowsing: on })} />}
          />
        )}
        {status.available && !googleFree && safeBrowsing && <Row label="Google’s lists" description={listsLine(status)} control={null} />}
      </div>
      {status.available && (
        <p className={styles.groupNote}>
          Safe Browsing by Google. Pages and downloads are checked in every window, private ones too; nothing about your browsing is saved for it.
        </p>
      )}
    </>
  );
}

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
            <Row label="Safe Browsing" description="Off: its lists come from Google. Chord doesn’t download them in this mode." control={null} />
            <Row label="Chord updates" description="Still checked once a day, with GitHub, not Google." control={null} />
          </div>
        </>
      )}
      <AdBlocking snapshot={snapshot} />
      <SafeBrowsing snapshot={snapshot} />
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
        <Row
          label="Keep recent screenshots"
          description="Your last screenshots are listed in Downloads, to copy or save again. They're kept on this computer (a private window's only until it closes); turning this off deletes them."
          changed={snapshot.settings.keepScreenshots !== DEFAULT_SETTINGS.keepScreenshots}
          onReset={() => void api.settings.set({ keepScreenshots: DEFAULT_SETTINGS.keepScreenshots })}
          control={<Switch label="Keep recent screenshots" checked={snapshot.settings.keepScreenshots} onChange={(keepScreenshots) => void api.settings.set({ keepScreenshots })} />}
        />
      </div>
    </>
  );
}
