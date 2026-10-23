/**
 * Settings → Appearance (DESIGN.md §5, §7.7): the color scheme, a library of
 * themes (built-in and your own) for the current chord, and how strongly the
 * interface shows them. Every preview comes from the same generator as the
 * window, so what you see here is what you get.
 */
import {
  DEFAULT_SETTINGS,
  UI_SCALES,
  isUiScale,
  parseThemeCode,
  themeCode,
  uuidv7,
  type ChordThemeSpec,
  type ColorScheme,
  type CustomTheme,
  type InterfaceSettings,
  type Oklch,
} from '@chord/core';
import type { SettingsSnapshot, SystemInfo } from '@chord/ipc';
import { PRESETS, SWATCHES, createChordTheme, cssOklch, presetStops, springs, type Appearance as Mode, type PresetId, type SwatchId } from '@chord/tokens';
import { BookmarkPlus, Check, ClipboardCopy, Copy, Dices, Download, Pencil, Plus, X } from 'lucide-react';
import { motion, type Transition } from 'motion/react';
import { useEffect, useState, type CSSProperties } from 'react';
import { INSTANT } from '../shared/motion';
import { api } from './api';
import styles from './Appearance.module.css';
import { ColorWheel } from './ColorWheel';
import { RadioGroup, ResetButton, Row, SectionHeader, Segmented } from './controls';
import settingsStyles from './Settings.module.css';
import { MAX_STOPS, addedStop, surpriseStops } from './wheel';

/** A theme in the library: a built-in preset or one of yours. */
interface LibraryTheme {
  id: string;
  name: string;
  stops: Oklch[];
  grain: number;
  custom: boolean;
  /** The chord's own colors when they match no theme (picked before themes existed, or a theme since deleted). */
  unsaved?: boolean;
}

/** What the editor is working on; `id` is null until a new theme is saved. */
interface Draft {
  id: string | null;
  name: string;
  stops: Oklch[];
  grain: number;
}

const PRESET_GRAIN = 0.2;
/** The last "Edit colors…" request opened, so coming back to Appearance doesn't reopen the editor. */
let handledEditColors = 0;

const titleCase = (id: string) => id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
const sameStops = (a: readonly Oklch[], b: readonly Oklch[]) => a.length === b.length && a.every((s, i) => near(s.l, b[i]!.l) && near(s.c, b[i]!.c) && near(s.h, b[i]!.h));
const copyOf = (t: { stops: readonly Oklch[] }) => t.stops.map((s) => ({ ...s }));

function library(custom: readonly CustomTheme[]): LibraryTheme[] {
  const presets = (Object.keys(PRESETS) as PresetId[]).map((id) => ({ id: `preset:${id}`, name: titleCase(id), stops: presetStops(id), grain: PRESET_GRAIN, custom: false }));
  return [...presets, ...custom.map((t) => ({ ...t, custom: true }))];
}

/** The theme as the window would draw it in one mode. */
function themeIn(stops: readonly Oklch[], grain: number, mode: Mode, info: SystemInfo, ui: InterfaceSettings) {
  return createChordTheme({ stops, grain, appearance: mode }, { systemAppearance: info.appearance, material: 'solid', ...ui });
}

interface Look {
  stops: readonly Oklch[];
  grain: number;
  info: SystemInfo;
  ui: InterfaceSettings;
}

/** A glossy sphere in the theme's colors, as one mode draws them. */
function Orb({ stops, grain, info, ui, mode }: Look & { mode: Mode }) {
  const colors = themeIn(stops, grain, mode, info, ui).stops.map((s) => cssOklch(s));
  const fill = colors.length === 1 ? `${colors[0]}, ${colors[0]}` : colors.join(', ');
  const light = mode === 'light';
  const style: CSSProperties = {
    backgroundImage: `radial-gradient(circle at 32% 26%, oklch(1 0 0 / ${light ? 0.9 : 0.35}), oklch(1 0 0 / 0) 42%), linear-gradient(in oklab 150deg, ${fill})`,
    // A faint rim keeps deep dark-mode colors from sinking into a dark card.
    boxShadow: `inset -4px -6px 12px oklch(0 0 0 / ${light ? 0.1 : 0.35}), inset 0 0 0 1px oklch(1 0 0 / ${light ? 0 : 0.12}), 0 1px 3px oklch(0 0 0 / 0.2)`,
  };
  return <span className={styles.orb} style={style} aria-hidden />;
}

function Orbs(look: Look) {
  return (
    <span className={styles.orbs}>
      <Orb {...look} mode="light" />
      <Orb {...look} mode="dark" />
    </span>
  );
}

/* ---------- Color scheme ---------- */

/** A miniature Chord window in one mode: the tinted side column with tabs, and the page frame. */
function MiniWindow({ mode, split, ...look }: Look & { mode: Mode; split?: boolean }) {
  const theme = themeIn(look.stops, look.grain, mode, look.info, look.ui);
  return (
    <span className={styles.mini} data-split={split || undefined} style={theme.vars as CSSProperties} aria-hidden>
      <span className={styles.miniSide}>
        <span className={styles.miniPill} />
        <span className={styles.miniTab} data-active />
        <span className={styles.miniTab} />
        <span className={styles.miniTab} />
      </span>
      <span className={styles.miniFrame}>
        <span className={styles.miniLine} />
        <span className={styles.miniLine} data-short />
        <span className={styles.miniAccent} />
      </span>
    </span>
  );
}

const SCHEMES: { value: ColorScheme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function ColorSchemes({ scheme, ...look }: Look & { scheme: ColorScheme }) {
  return (
    <RadioGroup className={styles.schemes} label="Color scheme">
      {SCHEMES.map(({ value, label }) => (
        <button key={value} type="button" role="radio" aria-checked={scheme === value} className={styles.scheme} onClick={() => void api.settings.set({ colorScheme: value })}>
          <span className={styles.schemePreview}>
            {value === 'system' ? (
              <>
                <MiniWindow {...look} mode="light" />
                {/* System is both: light, with dark across the diagonal. */}
                <MiniWindow {...look} mode="dark" split />
              </>
            ) : (
              <MiniWindow {...look} mode={value} />
            )}
          </span>
          <span className={styles.schemeLabel}>
            {label}
            {scheme === value && <Check size={14} strokeWidth={2.5} className={styles.check} aria-hidden />}
          </span>
        </button>
      ))}
    </RadioGroup>
  );
}

/* ---------- Theme editor ---------- */

/** "Surprise me": colors that sit well together, with a dice that spins (the `playful` spring). */
function SurpriseButton({ spin, className, onClick }: { spin: Transition; className: string | undefined; onClick(): void }) {
  const [turns, setTurns] = useState(0);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        setTurns((t) => t + 1);
        onClick();
      }}
    >
      <motion.span className={styles.dice} animate={{ rotate: turns * 360 }} transition={spin} aria-hidden>
        <Dices size={14} strokeWidth={2} />
      </motion.span>
      Surprise me
    </button>
  );
}

function ThemeEditor({
  draft,
  info,
  ui,
  spin,
  onDone,
  onDuplicate,
}: {
  draft: Draft;
  info: SystemInfo;
  ui: InterfaceSettings;
  spin: Transition;
  onDone(saved: CustomTheme | null): void;
  onDuplicate(draft: Draft): void;
}) {
  const [name, setName] = useState(draft.name);
  const [stops, setStops] = useState<Oklch[]>(draft.stops);
  const [grain, setGrain] = useState(draft.grain);
  const [slot, setSlot] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // "Delete" asks once more in place (no dialogs); the question fades if you don't answer.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  const active = stops[slot] ?? stops[0]!;
  const setActive = (color: Oklch) => setStops(stops.map((s, i) => (i === slot ? color : s)));
  const finalName = name.trim() || 'Untitled';
  const save = () => {
    const theme: CustomTheme = { id: draft.id ?? uuidv7(), name: finalName, stops, grain };
    void api.settings.saveTheme(theme);
    onDone(theme);
  };

  return (
    <section className={styles.editor} aria-label={draft.id ? `Edit ${draft.name}` : 'New theme'}>
      <div className={styles.editorHead}>
        <Orbs stops={stops} grain={grain} info={info} ui={ui} />
        <input className={styles.nameInput} value={name} maxLength={40} placeholder="Name your theme" aria-label="Theme name" autoFocus={!draft.id} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className={styles.picker}>
        <ColorWheel
          stops={stops}
          active={Math.min(slot, stops.length - 1)}
          onSelect={setSlot}
          onChange={(next, index) => {
            setStops(next);
            setSlot(index);
          }}
        />
        <div className={styles.pickerSide}>
          <RadioGroup className={styles.slots} label="Theme colors">
            {stops.map((s, i) => (
              <span key={i} className={styles.slotWrap}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={i === slot}
                  aria-label={`Color ${i + 1}`}
                  className={styles.slot}
                  style={{ backgroundColor: cssOklch(s) }}
                  onClick={() => setSlot(i)}
                />
                {stops.length > 1 && (
                  <button
                    type="button"
                    className={styles.slotRemove}
                    aria-label={`Remove color ${i + 1}`}
                    onClick={() => {
                      setStops(stops.filter((_, j) => j !== i));
                      setSlot(0);
                    }}
                  >
                    <X size={10} strokeWidth={3} />
                  </button>
                )}
              </span>
            ))}
            {stops.length < MAX_STOPS && (
              <button
                type="button"
                className={styles.slotAdd}
                aria-label="Add a color"
                onClick={() => {
                  // A new color starts a little way around the wheel from the last one.
                  setStops([...stops, addedStop(stops)]);
                  setSlot(stops.length);
                }}
              >
                <Plus size={14} strokeWidth={2} />
              </button>
            )}
            <span className={styles.slotHint}>{stops.length === 1 ? 'Add a second color for a gradient.' : 'The gradient runs from the first color to the last.'}</span>
          </RadioGroup>

          <RadioGroup className={styles.palette} label={`Swatches for color ${slot + 1}`}>
            {(Object.keys(SWATCHES) as SwatchId[]).map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={sameStops([active], [SWATCHES[id]])}
                aria-label={titleCase(id)}
                title={titleCase(id)}
                className={styles.swatch}
                style={{ backgroundColor: cssOklch(SWATCHES[id]) }}
                onClick={() => setActive({ ...SWATCHES[id] })}
              />
            ))}
          </RadioGroup>

          <label className={styles.slider}>
            <span>Grain</span>
            <input type="range" min={0} max={100} step={5} value={Math.round(grain * 100)} onChange={(e) => setGrain(Number(e.target.value) / 100)} />
          </label>
          <SurpriseButton
            spin={spin}
            className={styles.quiet}
            onClick={() => {
              setStops(surpriseStops(Math.random));
              setSlot(0);
            }}
          />
        </div>
      </div>

      <div className={styles.editorActions}>
        {draft.id && (
          <>
            <button type="button" className={styles.quiet} onClick={() => onDuplicate({ id: null, name: `${finalName} copy`, stops: copyOf({ stops }), grain })}>
              Duplicate
            </button>
            <button
              type="button"
              className={styles.quiet}
              data-danger={confirmDelete || undefined}
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                void api.settings.deleteTheme(draft.id!);
                onDone(null);
              }}
            >
              {confirmDelete ? 'Delete for good?' : 'Delete'}
            </button>
          </>
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.secondary} onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={save}>
          {draft.id ? 'Save' : 'Create theme'}
        </button>
      </div>
    </section>
  );
}

function ImportTheme({ onDone }: { onDone(theme: CustomTheme | null): void }) {
  const [text, setText] = useState('');
  const parsed = text.trim() ? parseThemeCode(text) : null;
  const invalid = text.trim() !== '' && !parsed;
  const add = () => {
    if (!parsed) return;
    const theme: CustomTheme = { id: uuidv7(), ...parsed };
    void api.settings.saveTheme(theme);
    onDone(theme);
  };
  return (
    <section className={styles.editor} aria-label="Import a theme">
      <p className={styles.importHelp}>Paste a theme code. Any theme’s clipboard button copies one.</p>
      <input
        className={styles.codeInput}
        value={text}
        placeholder='{"chordTheme":1, …}'
        aria-label="Theme code"
        aria-invalid={invalid}
        spellCheck={false}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      <div className={styles.editorActions}>
        {invalid && <span className={styles.error}>That isn’t a theme code.</span>}
        <span className={styles.spacer} />
        <button type="button" className={styles.secondary} onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="button" className={styles.primary} disabled={!parsed} onClick={add}>
          Add theme
        </button>
      </div>
    </section>
  );
}

/* ---------- Themes ---------- */

function ThemeCard({ theme, selected, look, onApply, onSecondary }: { theme: LibraryTheme; selected: boolean; look: Omit<Look, 'stops' | 'grain'>; onApply(): void; onSecondary(): void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const Secondary = theme.unsaved ? BookmarkPlus : theme.custom ? Pencil : Copy;
  const secondaryLabel = theme.unsaved ? 'Save as a theme' : theme.custom ? `Edit ${theme.name}` : `Duplicate ${theme.name}`;
  return (
    <div className={styles.card} data-selected={selected || undefined}>
      <button type="button" className={styles.cardMain} aria-pressed={selected} onClick={onApply}>
        <Orbs stops={theme.stops} grain={theme.grain} {...look} />
        <span className={styles.cardName}>
          <span className={styles.cardNameText}>{theme.name}</span>
          {selected && <Check size={14} strokeWidth={2.5} className={styles.check} aria-hidden />}
        </span>
      </button>
      <span className={styles.cardActions}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Copy ${theme.name}’s theme code`}
          title={copied ? 'Copied' : 'Copy theme code'}
          onClick={() => {
            void api.settings.copyText(themeCode(theme));
            setCopied(true);
          }}
        >
          {copied ? <Check size={14} strokeWidth={2.25} /> : <ClipboardCopy size={14} strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={secondaryLabel}
          title={theme.unsaved ? 'Save as a theme' : theme.custom ? 'Edit' : 'Duplicate'}
          onClick={onSecondary}
        >
          <Secondary size={14} strokeWidth={1.75} />
        </button>
      </span>
    </div>
  );
}

export function AppearanceSection({ snapshot, info, editColors }: { snapshot: SettingsSnapshot; info: SystemInfo; editColors: number }) {
  const { settings, chord } = snapshot;
  const ui = settings.interface;
  const [panel, setPanel] = useState<{ kind: 'edit'; draft: Draft; key: number } | { kind: 'import' } | null>(null);
  const themes = library(settings.themes);
  const current = chord?.theme;
  const stops = current?.stops ?? presetStops('dusk');
  const grain = current?.grain ?? PRESET_GRAIN;
  const look = { info, ui };
  // Decorative, so off whenever the OS asks for less motion (DESIGN.md §6.6).
  const spin: Transition = info.prefersReducedMotion && settings.motion.followSystem ? INSTANT : { type: 'spring', ...springs.playful };

  // A chord points at the theme it came from; older chords (and plain colors) match by their colors.
  const isSelected = (t: LibraryTheme) => (current ? (current.themeId ? current.themeId === t.id : sameStops(current.stops, t.stops)) : false);
  if (current && !themes.some(isSelected)) {
    themes.unshift({ id: 'current', name: 'Current colors', stops: copyOf(current), grain: current.grain, custom: false, unsaved: true });
  }
  const apply = (t: { id: string; stops: Oklch[]; grain: number }) => {
    if (chord) void api.settings.theme(chord.id, { stops: t.stops, grain: t.grain, themeId: t.id });
  };
  const edit = (draft: Draft) => setPanel({ kind: 'edit', draft, key: Date.now() });
  // The chord's ⋯ menu → "Edit colors…": its own theme if it came from one of yours, otherwise a new one from its colors.
  useEffect(() => {
    if (!editColors || editColors === handledEditColors) return;
    handledEditColors = editColors;
    const own = settings.themes.find((t) => t.id === current?.themeId);
    edit(own ? { id: own.id, name: own.name, stops: copyOf(own), grain: own.grain } : { id: null, name: '', stops: copyOf({ stops }), grain });
    // Only a new request opens it, not every change to the chord.
  }, [editColors]);

  return (
    <>
      <SectionHeader title="Appearance" description="Light or dark, the colors of each chord, and how strongly Chord shows them." />

      <h2 className={settingsStyles.groupTitle}>
        Color scheme
        <ResetButton label="Reset Color scheme to default" visible={settings.colorScheme !== DEFAULT_SETTINGS.colorScheme} onReset={() => void api.settings.set({ colorScheme: DEFAULT_SETTINGS.colorScheme })} />
      </h2>
      <ColorSchemes scheme={settings.colorScheme} stops={stops} grain={grain} {...look} />

      <div className={styles.themesHead}>
        <h2 className={settingsStyles.groupTitle}>{chord ? `Themes for ${chord.name}` : 'Themes'}</h2>
        <button type="button" className={styles.headButton} onClick={() => edit({ id: null, name: '', stops: copyOf({ stops }), grain })}>
          <Plus size={14} strokeWidth={2} aria-hidden /> Create theme
        </button>
        <button type="button" className={styles.headButton} onClick={() => setPanel({ kind: 'import' })}>
          <Download size={14} strokeWidth={2} aria-hidden /> Import
        </button>
        {chord && (
          <SurpriseButton
            spin={spin}
            className={styles.headButton}
            onClick={() => void api.settings.theme(chord.id, { stops: surpriseStops(Math.random), themeId: null })}
          />
        )}
      </div>
      {panel?.kind === 'import' && (
        <ImportTheme
          onDone={(theme) => {
            setPanel(null);
            if (theme) apply(theme);
          }}
        />
      )}
      {panel?.kind === 'edit' && (
        <ThemeEditor
          key={panel.key}
          draft={panel.draft}
          {...look}
          spin={spin}
          onDuplicate={edit}
          onDone={(saved) => {
            setPanel(null);
            // Making a theme is choosing it: a new one goes straight onto this chord.
            if (saved && !panel.draft.id) apply(saved);
          }}
        />
      )}
      <div className={styles.grid}>
        {themes.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            selected={t.unsaved || isSelected(t)}
            look={look}
            onApply={() => !t.unsaved && apply(t)}
            onSecondary={() =>
              edit({ id: t.custom ? t.id : null, name: t.unsaved ? '' : t.custom ? t.name : `${t.name} copy`, stops: copyOf(t), grain: t.grain })
            }
          />
        ))}
      </div>
      {chord && current && (
        <div className={`${settingsStyles.group} ${styles.chordGroup}`}>
          <Row
            label="Light or dark for this chord"
            description="Keep this chord light or dark whatever the color scheme."
            changed={current.appearance !== 'auto'}
            onReset={() => void api.settings.theme(chord.id, { appearance: 'auto' })}
            control={
              <Segmented<ChordThemeSpec['appearance']>
                label="Light or dark for this chord"
                value={current.appearance}
                options={[
                  { value: 'auto', label: 'Scheme' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                onChange={(appearance) => void api.settings.theme(chord.id, { appearance })}
              />
            }
          />
        </div>
      )}

      <h2 className={settingsStyles.groupTitle}>Interface</h2>
      <div className={settingsStyles.group}>
        <Row
          label="Interface size"
          description="Makes Chord’s sidebar, bars, menus and Settings larger or smaller. Pages keep their own zoom."
          changed={settings.uiScale !== DEFAULT_SETTINGS.uiScale}
          onReset={() => void api.settings.set({ uiScale: DEFAULT_SETTINGS.uiScale })}
          control={
            <Segmented<string>
              label="Interface size"
              value={String(settings.uiScale)}
              options={UI_SCALES.map((scale) => ({ value: String(scale), label: `${Math.round(scale * 100)}%` }))}
              onChange={(value) => {
                const uiScale = Number(value);
                if (isUiScale(uiScale)) void api.settings.set({ uiScale });
              }}
            />
          }
        />
        <Row
          label="Contrast"
          description="How strongly dividers, hover states and secondary text stand out. Text always stays readable."
          changed={ui.contrast !== DEFAULT_SETTINGS.interface.contrast}
          onReset={() => void api.settings.set({ interface: { contrast: DEFAULT_SETTINGS.interface.contrast } })}
          control={<Percent label="Contrast" value={ui.contrast} onChange={(contrast) => void api.settings.set({ interface: { contrast } })} />}
        />
        <Row
          label="Window tint"
          description="How much color covers the window. Less lets your desktop show through where your system allows it."
          changed={ui.glass !== DEFAULT_SETTINGS.interface.glass}
          onReset={() => void api.settings.set({ interface: { glass: DEFAULT_SETTINGS.interface.glass } })}
          control={<Percent label="Window tint" value={ui.glass} onChange={(glass) => void api.settings.set({ interface: { glass } })} />}
        />
      </div>
    </>
  );
}

function Percent({ label, value, onChange, describedBy }: { label: string; value: number; onChange(value: number): void; describedBy?: string }) {
  return (
    <span className={styles.percent}>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        aria-label={label}
        aria-valuetext={`${Math.round(value * 100)}%`}
        aria-describedby={describedBy}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <output className={styles.percentValue}>{Math.round(value * 100)}%</output>
    </span>
  );
}
