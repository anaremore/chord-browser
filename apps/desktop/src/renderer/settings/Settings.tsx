/**
 * The Settings window (⌘, / Ctrl+,). Every setting shows ↺ beside it when it
 * differs from the default (DESIGN.md §6.8). Changes apply at once,
 * everywhere: the window behind this one re-themes as you pick.
 */
import {
  DEFAULT_SETTINGS,
  SEARCH_ENGINES,
  SHORTCUTS,
  formatKeys,
  keysFor,
  type ChordThemeSpec,
  type MotionSettings,
  type Shortcut,
} from '@chord/core';
import type { AboutInfo, ChordThemePatch, SettingsSnapshot, SystemInfo } from '@chord/ipc';
import { PRESETS, SWATCHES, cssOklch, presetStops, type PresetId, type SwatchId } from '@chord/tokens';
import { Check, Info, Keyboard, Palette, RotateCcw, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { applyMotion, reducedMotionMode, springsFor } from '../shared/motion';
import { chordStyle } from '../shared/theme';
import { api } from './api';
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

/* ---------- Controls ---------- */

function ResetButton({ visible, onReset }: { visible: boolean; onReset(): void }) {
  return (
    <button
      type="button"
      className={styles.reset}
      aria-label="Reset to default"
      title="Reset to default"
      data-visible={visible || undefined}
      tabIndex={visible ? 0 : -1}
      onClick={onReset}
    >
      <RotateCcw size={13} strokeWidth={2} />
    </button>
  );
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={styles.switch} onClick={() => onChange(!checked)}>
      <span className={styles.knob} />
    </button>
  );
}

function Segmented<T extends string>({ value, options, label, onChange }: { value: T; options: { value: T; label: string }[]; label: string; onChange(value: T): void }) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={styles.segment} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, description, control, changed, onReset }: { label: string; description?: string; control: ReactNode; changed?: boolean; onReset?(): void }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {description && <span className={styles.rowDescription}>{description}</span>}
      </div>
      {onReset && <ResetButton visible={Boolean(changed)} onReset={onReset} />}
      {control}
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className={styles.sectionHeader}>
      <h1 className={styles.sectionTitle}>{title}</h1>
      <p className={styles.sectionDescription}>{description}</p>
    </header>
  );
}

/* ---------- Sections ---------- */

function General({ snapshot }: { snapshot: SettingsSnapshot }) {
  const engine = snapshot.settings.searchEngine;
  return (
    <>
      <SectionHeader title="General" description="How Chord searches when what you type isn't an address." />
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
    </>
  );
}

const sameStops = (a: readonly { l: number; c: number; h: number }[], b: readonly { l: number; c: number; h: number }[]) =>
  a.length === b.length && a.every((s, i) => s.l === b[i]!.l && s.c === b[i]!.c && s.h === b[i]!.h);

const titleCase = (id: string) => id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

function Appearance({ snapshot }: { snapshot: SettingsSnapshot }) {
  const chord = snapshot.chord;
  if (!chord) return <SectionHeader title="Appearance" description="Open a window to edit its chord's colors." />;
  const theme = chord.theme;
  const setTheme = (patch: ChordThemePatch) => void api.settings.theme(chord.id, patch);
  const gradient = (ids: readonly SwatchId[]) => `linear-gradient(160deg, ${ids.map((id) => cssOklch(SWATCHES[id])).join(', ')})`;
  return (
    <>
      <SectionHeader
        title="Appearance"
        description={`Colors for the ${chord.name} chord. Every chord has its own, so you always know where you are.`}
      />
      <h2 className={styles.groupTitle}>Gradients</h2>
      <div className={styles.presets}>
        {(Object.keys(PRESETS) as PresetId[]).map((id) => {
          const selected = sameStops(theme.stops, presetStops(id));
          return (
            <button key={id} type="button" className={styles.preset} aria-pressed={selected} onClick={() => setTheme({ stops: presetStops(id) })}>
              <span className={styles.presetChip} style={{ backgroundImage: gradient(PRESETS[id]) }} />
              <span className={styles.presetName}>{titleCase(id)}</span>
            </button>
          );
        })}
      </div>
      <h2 className={styles.groupTitle}>Colors</h2>
      <div className={styles.swatches}>
        {(Object.keys(SWATCHES) as SwatchId[]).map((id) => {
          const swatch = SWATCHES[id];
          const selected = sameStops(theme.stops, [swatch]);
          return (
            <button
              key={id}
              type="button"
              className={styles.swatch}
              aria-pressed={selected}
              aria-label={titleCase(id)}
              title={titleCase(id)}
              style={{ backgroundColor: cssOklch(swatch) }}
              onClick={() => setTheme({ stops: [{ ...swatch }] })}
            />
          );
        })}
      </div>
      <div className={styles.group}>
        <Row
          label="Light or dark"
          description="System follows your computer's setting."
          changed={theme.appearance !== 'auto'}
          onReset={() => setTheme({ appearance: 'auto' })}
          control={
            <Segmented<ChordThemeSpec['appearance']>
              label="Light or dark"
              value={theme.appearance}
              options={[
                { value: 'auto', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onChange={(appearance) => setTheme({ appearance })}
            />
          }
        />
        <Row
          label="Grain"
          description="A soft paper texture over the color."
          changed={theme.grain !== 0.2}
          onReset={() => setTheme({ grain: 0.2 })}
          control={
            <span className={styles.slider}>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                aria-label="Grain"
                value={Math.round(theme.grain * 100)}
                onChange={(e) => setTheme({ grain: Number(e.target.value) / 100 })}
              />
              <output className={styles.sliderValue}>{Math.round(theme.grain * 100)}%</output>
            </span>
          }
        />
      </div>
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
        <Row label="License" description="Free and open source. No accounts, no telemetry." control={<span className={styles.value}>MPL-2.0</span>} />
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

  const { style } = chordStyle(snapshot.chord, info);
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
              {section === 'general' && <General snapshot={snapshot} />}
              {section === 'appearance' && <Appearance snapshot={snapshot} />}
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
