/**
 * The Settings window (⌘, / Ctrl+,). Every setting shows ↺ beside it when it
 * differs from the default (DESIGN.md §6.8). Changes apply at once,
 * everywhere: the window behind this one re-themes as you pick.
 */
import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  SEARCH_ENGINES,
  SHORTCUTS,
  formatKeys,
  keysFor,
  type MotionSettings,
  type Shortcut,
} from '@chord/core';
import type { AboutInfo, DefaultBrowserStatus, SettingsSnapshot, SystemInfo } from '@chord/ipc';
import { Check, Info, Keyboard, Palette, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useEffect, useState } from 'react';
import { applyMotion, reducedMotionMode, springsFor } from '../shared/motion';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import { AppearanceSection } from './Appearance';
import { ResetButton, Row, SectionHeader, Switch } from './controls';
import styles from './Settings.module.css';

const SECTIONS = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'motion', label: 'Motion', icon: Sparkles },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'about', label: 'About', icon: Info },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const isSection = (value: string): value is SectionId => SECTIONS.some((s) => s.id === value);
const initialSection = (): SectionId => {
  const hash = decodeURIComponent(location.hash.slice(1));
  return isSection(hash) ? hash : 'general';
};

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
            description="Links from other apps open here, in the window you used last."
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
        <ResetButton visible={settings.separateSignIns !== DEFAULT_SETTINGS.separateSignIns} onReset={() => void api.settings.set({ separateSignIns: DEFAULT_SETTINGS.separateSignIns })} />
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
  return (
    <>
      <SectionHeader title="General" description="How Chord searches, which chords share sign-ins, and whether it opens your links." />
      <h2 className={styles.groupTitle}>
        Search engine
        <ResetButton visible={engine !== DEFAULT_SETTINGS.searchEngine} onReset={() => void api.settings.set({ searchEngine: DEFAULT_SETTINGS.searchEngine })} />
      </h2>
      <div className={styles.group} role="radiogroup" aria-label="Search engine">
        {SEARCH_ENGINES.map((e) => (
          <button
            key={e.id}
            type="button"
            role="radio"
            aria-checked={e.id === engine}
            className={styles.choice}
            onClick={() => void api.settings.set({ searchEngine: e.id })}
          >
            <span className={styles.rowLabel}>{e.name}</span>
            <span className={styles.choiceHost}>{new URL(e.prefix).host}</span>
            {e.id === engine && <Check className={styles.check} size={16} strokeWidth={2.25} aria-hidden />}
          </button>
        ))}
      </div>
      <SignIns snapshot={snapshot} />
      <DefaultBrowser platform={info.platform} />
    </>
  );
}

const MOTION_ROWS: { key: keyof MotionSettings; label: string; description: string }[] = [
  { key: 'followSystem', label: 'Follow system motion settings', description: "When your computer asks for less motion, Chord's animations become instant." },
  { key: 'commandBar', label: 'Animate into the command bar', description: 'The address growing into the command bar, and the new-tab panel appearing.' },
  { key: 'sidebar', label: 'Animate the sidebar', description: 'Hiding and showing the sidebar.' },
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

const SHORTCUT_GROUPS: { title: string; prefixes: string[] }[] = [
  { title: 'Address and search', prefixes: ['address.'] },
  { title: 'Tabs', prefixes: ['tab.'] },
  { title: 'Navigate', prefixes: ['nav.'] },
  { title: 'Chords', prefixes: ['chord.'] },
  { title: 'Window and view', prefixes: ['window.', 'view.'] },
  { title: 'Page', prefixes: ['page.'] },
  { title: 'Chord', prefixes: ['app.'] },
];

/** ⌘1 … ⌘9 read better as one row. */
function shortcutRows(platform: SystemInfo['platform']): { group: string; label: string; keys: string[] }[] {
  const rows: { group: string; label: string; keys: string[] }[] = [];
  for (const g of SHORTCUT_GROUPS) {
    const inGroup = SHORTCUTS.filter((s: Shortcut) => g.prefixes.some((p) => s.id.startsWith(p)) && keysFor(s, platform).length > 0);
    for (const s of inGroup) {
      if (/^chord\.goto[2-9]$/.test(s.id)) continue;
      const keys = keysFor(s, platform).map((k) => formatKeys(k, platform));
      if (s.id === 'chord.goto1') rows.push({ group: g.title, label: 'Go to chord 1–9', keys: [`${keys[0]!.slice(0, -1)}1…9`] });
      else rows.push({ group: g.title, label: s.label, keys });
    }
  }
  return rows;
}

function Shortcuts({ info }: { info: SystemInfo }) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const rows = shortcutRows(info.platform).filter(
    (r) => !needle || r.label.toLowerCase().includes(needle) || r.keys.some((k) => k.toLowerCase().includes(needle)),
  );
  const groups = SHORTCUT_GROUPS.map((g) => ({ title: g.title, rows: rows.filter((r) => r.group === g.title) })).filter((g) => g.rows.length > 0);
  return (
    <>
      <SectionHeader title="Keyboard shortcuts" description="Everything Chord does has a key. Shortcuts marked in menus work the same way." />
      <label className={styles.filter}>
        <Search size={14} strokeWidth={2} aria-hidden />
        <input
          type="search"
          placeholder="Find a shortcut"
          aria-label="Find a shortcut"
          spellCheck={false}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      {groups.map((g) => (
        <section key={g.title}>
          <h2 className={styles.groupTitle}>{g.title}</h2>
          <div className={styles.group}>
            {g.rows.map((r) => (
              <div key={r.label} className={styles.shortcut}>
                <span className={styles.rowLabel}>{r.label}</span>
                <span className={styles.keys}>
                  {r.keys.map((k, i) => (
                    <span key={k} className={styles.keyAlt}>
                      {i > 0 && <span className={styles.or}>or</span>}
                      <kbd className={styles.keycap}>{k}</kbd>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && <p className={styles.sectionDescription}>No shortcut matches “{filter}”.</p>}
    </>
  );
}

function About({ about }: { about: AboutInfo }) {
  return (
    <>
      <div className={styles.aboutHero}>
        <span className={styles.aboutMark} aria-hidden>
          ✦
        </span>
        <h1 className={styles.aboutName}>Chord</h1>
        <p className={styles.sectionDescription}>Version {about.version}</p>
      </div>
      <div className={styles.group}>
        <Row label="Engine" control={<span className={styles.value}>Chromium {about.chromium}</span>} />
        <Row label="Electron" control={<span className={styles.value}>{about.electron}</span>} />
        <Row label="Platform" control={<span className={styles.value}>{`${about.platform} · ${about.arch}`}</span>} />
        <Row label="License" description="Free and open source. No accounts, no telemetry." control={<span className={styles.value}>MIT</span>} />
      </div>
      <div className={styles.links}>
        <button type="button" className={styles.linkButton} onClick={() => void api.settings.openUrl(REPO_URL)}>
          Source on GitHub
        </button>
        <button type="button" className={styles.linkButton} onClick={() => void api.settings.openUrl(`${REPO_URL}/issues/new`)}>
          Report an issue
        </button>
      </div>
    </>
  );
}

/* ---------- Window ---------- */

export function Settings({ initialInfo, initialSnapshot, about }: { initialInfo: SystemInfo; initialSnapshot: SettingsSnapshot; about: AboutInfo }) {
  const [info, setInfo] = useState(initialInfo);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [section, setSection] = useState<SectionId>(initialSection);
  useEffect(() => api.system.onChange(setInfo), []);
  useEffect(() => api.settings.onChange(setSnapshot), []);
  useEffect(() => api.settings.onSection((s) => isSection(s) && setSection(s)), []);
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
              {section === 'appearance' && <AppearanceSection snapshot={snapshot} info={info} />}
              {section === 'motion' && <Motion snapshot={snapshot} />}
              {section === 'shortcuts' && <Shortcuts info={info} />}
              {section === 'about' && <About about={about} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </MotionConfig>
  );
}
