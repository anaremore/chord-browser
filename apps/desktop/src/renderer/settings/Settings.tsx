/**
 * The Settings window (⌘, / Ctrl+,). Every setting shows ↺ beside it when it
 * differs from the default (DESIGN.md §6.8). Changes apply at once,
 * everywhere: the window behind this one re-themes as you pick.
 */
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, SEARCH_ENGINES, searchEngine, type ArchiveAfter, type MotionSettings } from '@chord/core';
import type { AboutInfo, DefaultBrowserStatus, SettingsSnapshot, SystemInfo, UpdateStatus } from '@chord/ipc';
import { Check, EyeOff, FolderInput, Info, Keyboard, Palette, Puzzle, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import { DuetIcon } from '../shared/icons';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useEffect, useState } from 'react';
import { useLive, type Live } from '../shared/live';
import { applyMotion, reducedMotionMode, springsFor } from '../shared/motion';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import { DuetSettings } from './DuetSettings';
import { AppearanceSection } from './Appearance';
import { ShortcutsSection } from './Shortcuts';
import { RadioGroup, ResetButton, Row, SectionHeader, Segmented, Switch } from './controls';
import { ExtensionsSection } from './Extensions';
import { ImportSection } from './Import';
import { PrivacySection } from './Privacy';
import styles from './Settings.module.css';
import { Links } from './Links';
import { SitesSection, Spelling } from './Sites';

const SECTIONS = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'motion', label: 'Motion', icon: Sparkles },
  { id: 'privacy', label: 'Privacy', icon: EyeOff },
  { id: 'sites', label: 'Site permissions', icon: ShieldCheck },
  { id: 'extensions', label: 'Extensions', icon: Puzzle },
  { id: 'import', label: 'Import', icon: FolderInput },
  { id: 'duet', label: 'Duet', icon: DuetIcon },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'about', label: 'About', icon: Info },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const isSection = (value: string): value is SectionId => SECTIONS.some((s) => s.id === value);
/** A section, or `appearance/colors`: Appearance with the chord's colors open in the theme editor. */
const parseSection = (value: string): { section: SectionId; colors: boolean } | null => {
  const [id, sub] = value.split('/');
  return id && isSection(id) ? { section: id, colors: id === 'appearance' && sub === 'colors' } : null;
};
const initialHash = () => parseSection(decodeURIComponent(location.hash.slice(1)));
const initialSection = (): SectionId => initialHash()?.section ?? 'general';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const REPO_URL = 'https://github.com/anaremore/chord-browser';

/* ---------- Sections ---------- */

const MAKE_DEFAULT_HINT: Record<SystemInfo['platform'], string> = {
  win32: 'Opens Windows Settings, where you pick Chord for web links.',
  darwin: 'Your Mac asks you to confirm.',
  linux: 'Links from other apps will open in Chord.',
};

function DefaultBrowser({ platform }: { platform: SystemInfo['platform'] }) {
  const [status, setStatus] = useState<DefaultBrowserStatus | null>(null);
  useEffect(() => {
    const refresh = () => void api.settings.defaultBrowser().then(setStatus);
    refresh();
    // The choice is made in the OS's settings; Chord checks again when you come back.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  if (!status) return null;
  return (
    <>
      <h2 className={styles.groupTitle}>Default browser</h2>
      <div className={styles.group}>
        {status === 'default' && (
          <Row
            label="Chord is your default browser"
            description="Links from other apps open in Chord, the way you chose under Links."
            control={<Check className={styles.check} size={16} strokeWidth={2.25} aria-hidden />}
          />
        )}
        {status === 'not-default' && (
          <Row
            label="Make Chord your default browser"
            description={MAKE_DEFAULT_HINT[platform]}
            control={
              <button type="button" className={styles.linkButton} onClick={() => void api.settings.makeDefaultBrowser().then(setStatus)}>
                Make default
              </button>
            }
          />
        )}
        {status === 'system' && (
          <Row
            label="Make Chord your default browser"
            description="Choose Chord in your system’s default apps settings. A Flatpak can’t change that setting itself."
            control={null}
          />
        )}
        {status === 'unavailable' && (
          <Row label="Default browser" description="Installed copies of Chord can be your default browser. This is a development build." control={null} />
        )}
      </div>
    </>
  );
}

/** Which chords share sign-ins (DESIGN.md: "Keep sign-ins separate", never "profile"). */
function SignIns({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { settings, chords } = snapshot;
  return (
    <>
      <h2 className={styles.groupTitle}>
        Sign-ins
        <ResetButton label="Reset Sign-ins to default" visible={settings.separateSignIns !== DEFAULT_SETTINGS.separateSignIns} onReset={() => void api.settings.set({ separateSignIns: DEFAULT_SETTINGS.separateSignIns })} />
      </h2>
      <div className={styles.group}>
        <Row
          label="New chords keep their own sign-ins"
          description="Off: every chord shares your accounts (Google and the rest). On: each new chord starts signed out, with its own cookies."
          control={<Switch label="New chords keep their own sign-ins" checked={settings.separateSignIns} onChange={(separateSignIns) => void api.settings.set({ separateSignIns })} />}
        />
        {chords.map((chord) => {
          const separate = chord.profileId !== DEFAULT_PROFILE;
          return (
            <Row
              key={chord.id}
              label={`${chord.icon}  ${chord.name}`}
              description={separate ? 'Keeps its own sign-ins.' : 'Shares sign-ins with your other chords.'}
              control={<Switch label={`Keep sign-ins separate for ${chord.name}`} checked={separate} onChange={(value) => void api.settings.chordSignIns(chord.id, value)} />}
            />
          );
        })}
      </div>
      <p className={styles.groupNote}>Changing a chord reloads its tabs. A chord on its own starts signed out; Undo brings its old sign-ins back.</p>
    </>
  );
}

function General({ snapshot, info }: { snapshot: SettingsSnapshot; info: SystemInfo }) {
  const engine = snapshot.settings.searchEngine;
  const googleFree = snapshot.settings.googleFree;
  return (
    <>
      <SectionHeader title="General" description="How Chord searches, which chords share sign-ins, and whether it opens your links." />
      <h2 className={styles.groupTitle}>
        Search engine
        <ResetButton label="Reset Search engine to default" visible={engine !== DEFAULT_SETTINGS.searchEngine && !googleFree} onReset={() => void api.settings.set({ searchEngine: DEFAULT_SETTINGS.searchEngine })} />
      </h2>
      <RadioGroup className={styles.group} label="Search engine">
        {SEARCH_ENGINES.map((e) => (
          <button
            key={e.id}
            type="button"
            role="radio"
            aria-checked={e.id === engine}
            className={styles.choice}
            // Settings → Privacy → Google-free mode searches with anything but Google.
            disabled={googleFree && e.id === 'google'}
            onClick={() => void api.settings.set({ searchEngine: e.id })}
          >
            <span className={styles.rowLabel}>{e.name}</span>
            <span className={styles.choiceHost}>{googleFree && e.id === 'google' ? 'Off in Google-free mode' : new URL(e.prefix).host}</span>
            {e.id === engine && <Check className={styles.check} size={16} strokeWidth={2.25} aria-hidden />}
          </button>
        ))}
      </RadioGroup>
      <div className={`${styles.group} ${styles.groupAfter}`}>
        <Row
          label="Search suggestions"
          description={`As you type a search, ${searchEngine(engine).name} suggests ways to finish it. What you type is sent to ${searchEngine(engine).name}; addresses you type never are.`}
          changed={snapshot.settings.searchSuggestions !== DEFAULT_SETTINGS.searchSuggestions}
          onReset={() => void api.settings.set({ searchSuggestions: DEFAULT_SETTINGS.searchSuggestions })}
          control={
            <Switch
              label="Search suggestions"
              checked={snapshot.settings.searchSuggestions}
              onChange={(searchSuggestions) => void api.settings.set({ searchSuggestions })}
            />
          }
        />
      </div>

      <h2 className={styles.groupTitle}>Tabs</h2>
      <div className={styles.group}>
        <Row
          label="Archive Today tabs after"
          description="Tabs you haven't looked at in this long move to the archive. Pinned tabs, and tabs playing or sharing, stay."
          changed={snapshot.settings.archiveAfter !== DEFAULT_SETTINGS.archiveAfter}
          onReset={() => void api.settings.set({ archiveAfter: DEFAULT_SETTINGS.archiveAfter })}
          control={
            <Segmented<ArchiveAfter>
              label="Archive Today tabs after"
              value={snapshot.settings.archiveAfter}
              options={ARCHIVE_CHOICES}
              onChange={(archiveAfter) => void api.settings.set({ archiveAfter })}
            />
          }
        />
        <Row
          label="Sleep tabs you're not using"
          description="Tabs hidden for an hour free their memory, and pick up where you left off when you come back."
          changed={snapshot.settings.sleepTabs !== DEFAULT_SETTINGS.sleepTabs}
          onReset={() => void api.settings.set({ sleepTabs: DEFAULT_SETTINGS.sleepTabs })}
          control={
            <Switch label="Sleep tabs you're not using" checked={snapshot.settings.sleepTabs} onChange={(sleepTabs) => void api.settings.set({ sleepTabs })} />
          }
        />
        <Row
          label="Pop out playing videos when you switch away"
          description="A video you're watching keeps playing in a small window over everything. Come back to its tab and it slides home."
          changed={snapshot.settings.autoPip !== DEFAULT_SETTINGS.autoPip}
          onReset={() => void api.settings.set({ autoPip: DEFAULT_SETTINGS.autoPip })}
          control={
            <Switch label="Pop out playing videos when you switch away" checked={snapshot.settings.autoPip} onChange={(autoPip) => void api.settings.set({ autoPip })} />
          }
        />
      </div>

      <Links snapshot={snapshot} />
      <SignIns snapshot={snapshot} />
      <Spelling snapshot={snapshot} info={info} />
      <DefaultBrowser platform={info.platform} />
    </>
  );
}

const ARCHIVE_CHOICES: { value: ArchiveAfter; label: string }[] = [
  { value: '12h', label: '12 hours' },
  { value: '24h', label: 'A day' },
  { value: '7d', label: 'A week' },
  { value: '30d', label: 'A month' },
  { value: 'never', label: 'Never' },
];

const MOTION_ROWS: { key: keyof MotionSettings; label: string; description: string }[] = [
  { key: 'followSystem', label: 'Follow system motion settings', description: "When your computer asks for less motion, Chord's animations become instant." },
  { key: 'commandBar', label: 'Animate into the command bar', description: 'The address growing into the command bar, and the new-tab panel appearing.' },
  { key: 'sidebar', label: 'Animate the sidebar', description: 'Hiding and showing the sidebar, and opening and closing Duet.' },
  { key: 'tabMoves', label: 'Animate tab moves', description: 'Tabs opening, closing and reordering.' },
  { key: 'chordSlide', label: 'Slide between chords', description: 'Switching chords. A trackpad swipe still follows your fingers.' },
  { key: 'colorBlend', label: 'Blend chord colors', description: 'Fading from one chord’s colors to the next.' },
];

function Motion({ snapshot }: { snapshot: SettingsSnapshot }) {
  const motionSettings = snapshot.settings.motion;
  return (
    <>
      <SectionHeader title="Motion" description="Speed beats animation. Anything switched off here happens instantly, not just faster." />
      <div className={styles.group}>
        {MOTION_ROWS.map((r) => (
          <Row
            key={r.key}
            label={r.label}
            description={r.description}
            changed={motionSettings[r.key] !== DEFAULT_SETTINGS.motion[r.key]}
            onReset={() => void api.settings.set({ motion: { [r.key]: DEFAULT_SETTINGS.motion[r.key] } })}
            control={<Switch label={r.label} checked={motionSettings[r.key]} onChange={(value) => void api.settings.set({ motion: { [r.key]: value } })} />}
          />
        ))}
      </div>
    </>
  );
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function checkedAgo(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'Checked just now.';
  if (minutes < 60) return `Checked ${relativeTime.format(-minutes, 'minute')}.`;
  return `Checked ${relativeTime.format(-Math.round(minutes / 60), 'hour')}.`;
}

/** Settings → About: the update check's answer (and the download, where Chord installs updates itself), and its switch. */
function Updates({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => void api.settings.updateStatus().then(setStatus), []);
  // A download in progress: follow it until it's ready.
  const downloading = status?.state === 'downloading';
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void api.settings.updateStatus().then(setStatus), 1000);
    return () => clearInterval(timer);
  }, [downloading]);
  if (!status) return null;
  const checkNow = async () => {
    setStatus({ state: 'checking' });
    setStatus(await api.settings.checkForUpdates());
  };
  const checkButton = (
    <button type="button" className={styles.linkButton} disabled={status.state === 'checking'} onClick={() => void checkNow()}>
      Check now
    </button>
  );
  const row = (() => {
    switch (status.state) {
      case 'unavailable':
        return <Row label="Updates" description="Installed copies of Chord check for new versions. This is a development build." control={null} />;
      case 'managed':
        return <Row label="Updates" description="Your software center updates Chord, along with your other Flatpak apps." control={null} />;
      case 'idle':
        return <Row label="Check for updates" description="Not checked yet." control={checkButton} />;
      case 'checking':
        return <Row label="Checking for updates…" control={checkButton} />;
      case 'current':
        return <Row label="Chord is up to date" description={checkedAgo(status.checkedAt)} control={checkButton} />;
      case 'failed':
        return <Row label="Couldn’t check for updates" description="Chord will try again later." control={checkButton} />;
      case 'downloading':
        return <Row label={`Downloading Chord ${status.version}…`} description={`${status.percent}%. You can keep browsing.`} control={null} />;
      case 'ready':
        return (
          <Row
            label={`Chord ${status.version} is ready`}
            description="Restart to install it. Your tabs and windows come back as they are."
            control={
              <button type="button" className={styles.linkButton} onClick={() => void api.settings.restartToUpdate()}>
                Restart to update
              </button>
            }
          />
        );
      case 'available':
        return (
          <Row
            label={`Chord ${status.version} is out`}
            description="Download it from the release page; it installs over this version, keeping your tabs and settings."
            control={
              <button type="button" className={styles.linkButton} onClick={() => void api.settings.openUrl(status.url)}>
                See what’s new
              </button>
            }
          />
        );
    }
  })();
  return (
    <div className={`${styles.group} ${styles.groupBelow}`}>
      {row}
      {status.state !== 'managed' && (
        <Row
          label="Check for updates automatically"
          description="Once a day, Chord asks GitHub whether a newer version is out, and nothing about you is sent. On Windows and in the AppImage, a new version downloads in the background and installs when Chord restarts."
          changed={enabled !== DEFAULT_SETTINGS.checkForUpdates}
          onReset={() => void api.settings.set({ checkForUpdates: DEFAULT_SETTINGS.checkForUpdates })}
          control={<Switch label="Check for updates automatically" checked={enabled} onChange={(checkForUpdates) => void api.settings.set({ checkForUpdates })} />}
        />
      )}
    </div>
  );
}

function About({ about, snapshot }: { about: AboutInfo; snapshot: SettingsSnapshot }) {
  return (
    <>
      <div className={styles.aboutHero}>
        <span className={styles.aboutMark} aria-hidden>
          ✦
        </span>
        <h1 className={styles.aboutName}>Chord</h1>
        <p className={styles.sectionDescription}>Version {about.version}</p>
      </div>
      <Updates enabled={snapshot.settings.checkForUpdates} />
      <div className={styles.group}>
        <Row label="Engine" control={<span className={styles.value}>Chromium {about.chromium}</span>} />
        <Row label="Electron" control={<span className={styles.value}>{about.electron}</span>} />
        <Row label="Platform" control={<span className={styles.value}>{`${about.platform} · ${about.arch}`}</span>} />
        <Row label="License" description="Free and open source. No accounts, no telemetry." control={<span className={styles.value}>MIT</span>} />
        <Row
          label="This build"
          description="Includes electron-chrome-extensions, which is GPL-3.0, so Chord’s release builds are distributed under GPL-3.0. Chord’s own source stays MIT."
          control={<span className={styles.value}>GPL-3.0</span>}
        />
        <Row
          label="Safe Browsing"
          description="Warnings about suspected phishing and malware come from Safe Browsing by Google, for non-commercial use under Google’s terms."
          control={<span className={styles.value}>Google</span>}
        />
        <Row
          label="Ad and tracker blocking"
          description="EasyList and EasyPrivacy, by the EasyList authors, with Ghostery’s adblocker engine (MPL-2.0)."
          control={<span className={styles.value}>EasyList</span>}
        />
      </div>
      <div className={styles.links}>
        <button type="button" className={styles.linkButton} onClick={() => void api.settings.openUrl(REPO_URL)}>
          Source on GitHub
        </button>
        <button type="button" className={styles.linkButton} onClick={() => void api.settings.openUrl(`${REPO_URL}/blob/main/LICENSES/THIRD-PARTY-NOTICES.md`)}>
          Third-party notices
        </button>
        <button type="button" className={styles.linkButton} onClick={() => void api.settings.openUrl(`${REPO_URL}/issues/new`)}>
          Report an issue
        </button>
      </div>
    </>
  );
}

/* ---------- Window ---------- */

export function Settings({ info: infoSource, snapshot: snapshotSource, about }: { info: Live<SystemInfo>; snapshot: Live<SettingsSnapshot>; about: AboutInfo }) {
  const info = useLive(infoSource);
  const snapshot = useLive(snapshotSource);
  const [section, setSection] = useState<SectionId>(initialSection);
  // Each "Edit colors…" from a chord's menu is a new request to open the editor.
  const [editColors, setEditColors] = useState(() => (initialHash()?.colors ? 1 : 0));
  useEffect(
    () =>
      api.settings.onSection((value) => {
        const parsed = parseSection(value);
        if (!parsed) return;
        setSection(parsed.section);
        if (parsed.colors) setEditColors((n) => n + 1);
      }),
    [],
  );
  useEffect(() => applyMotion(snapshot.settings, info.prefersReducedMotion), [snapshot.settings, info.prefersReducedMotion]);

  const { style } = chordStyle(snapshot.chord, info, snapshot.settings.interface);
  const spring = springsFor(snapshot.settings, info.prefersReducedMotion);

  return (
    <MotionConfig reducedMotion={reducedMotionMode(snapshot.settings)}>
      <div className={styles.window} style={style}>
        <div className={styles.backdrop} aria-hidden>
          <div className={styles.tint} />
          <div className={styles.grain} />
        </div>
        <div className={styles.titleBar} />

        <nav className={styles.nav} aria-label="Settings sections">
          <p className={styles.navTitle}>Settings</p>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const current = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                className={styles.navItem}
                aria-current={current ? 'page' : undefined}
                onClick={() => {
                  setSection(s.id);
                  history.replaceState(null, '', `#${s.id}`);
                }}
              >
                {current && <motion.span layoutId="settings-nav-pill" className={styles.navPill} transition={spring('snappy', 'tabMoves')} />}
                <Icon {...ICON} aria-hidden />
                <span>{s.label}</span>
              </button>
            );
          })}
        </nav>

        <main className={styles.frame}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              className={styles.content}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={spring('snappy', 'commandBar')}
            >
              {section === 'general' && <General snapshot={snapshot} info={info} />}
              {section === 'appearance' && <AppearanceSection snapshot={snapshot} info={info} editColors={editColors} />}
              {section === 'motion' && <Motion snapshot={snapshot} />}
              {section === 'privacy' && <PrivacySection snapshot={snapshot} />}
              {section === 'sites' && <SitesSection snapshot={snapshot} />}
              {section === 'extensions' && <ExtensionsSection snapshot={snapshot} />}
              {section === 'import' && <ImportSection snapshot={snapshot} info={info} />}
              {section === 'duet' && <DuetSettings snapshot={snapshot} />}
              {section === 'shortcuts' && <ShortcutsSection snapshot={snapshot} info={info} />}
              {section === 'about' && <About about={about} snapshot={snapshot} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </MotionConfig>
  );
}
