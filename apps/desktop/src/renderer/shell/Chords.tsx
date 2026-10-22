/**
 * Chords in the sidebar (DESIGN.md §3.2, §8.2): the header with inline
 * rename and the icon picker, the switcher in the footer, and the color
 * crossfade behind it all.
 */
import { firstGrapheme, formatKeys, shortcutById, sortedChords, type ActionId, type Chord, type ChordThemeSpec, type State } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { createChordTheme, presetStops, type PresetId } from '@chord/tokens';
import { Plus } from 'lucide-react';
import { motion, useIsPresent, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react';
import { api } from './api';
import styles from './App.module.css';

/** New chords take the first icon and gradient nobody uses yet. */
const ICONS = ['✦', '♪', '♫', '♩', '♬', '◆', '●', '▲', '★'];
const PRESET_ORDER: PresetId[] = ['dusk', 'seaGlass', 'citrus', 'aurora', 'ember', 'fog'];

const sameStops = (a: ChordThemeSpec['stops'], b: ChordThemeSpec['stops']) =>
  a.length === b.length && a.every((s, i) => s.l === b[i]!.l && s.c === b[i]!.c && s.h === b[i]!.h);

export function newChordLook(chords: Chord[]): { icon: string; theme: ChordThemeSpec } {
  const icon = ICONS.find((i) => !chords.some((c) => c.icon === i)) ?? ICONS[chords.length % ICONS.length]!;
  const preset =
    PRESET_ORDER.find((p) => !chords.some((c) => sameStops(c.theme.stops, presetStops(p)))) ?? PRESET_ORDER[chords.length % PRESET_ORDER.length]!;
  return { icon, theme: { stops: presetStops(preset), grain: 0.2, appearance: 'auto' } };
}

function gotoKeys(index: number, info: SystemInfo): string {
  if (index > 8) return '';
  const shortcut = shortcutById(`chord.goto${Math.min(index + 1, 9)}` as ActionId);
  const keys = shortcut ? (info.platform === 'darwin' ? shortcut.mac : shortcut.other)[0] : undefined;
  return keys ? formatKeys(keys, info.platform) : '';
}

/**
 * The tint, crossfaded between chords: the new color fades in over the old
 * one, which stays opaque underneath, so the window never thins out mid-fade.
 */
export function Tint({ value, transition }: { value: string; transition: Transition }) {
  const [under, setUnder] = useState(value);
  return (
    <>
      <div className={styles.tint} style={{ background: under }} />
      {under !== value && (
        <motion.div
          key={value}
          className={styles.tint}
          style={{ background: value }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transition}
          onAnimationComplete={() => setUnder(value)}
        />
      )}
    </>
  );
}

const PANE_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 24 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -24 }),
};

/**
 * One chord's part of the sidebar, sliding in from the side of the switcher
 * it sits on. While a pane slides out it's inert and hidden from assistive
 * tech, so only the chord you switched to can be reached.
 */
export function ChordPane({ ref, slide, transition, children }: { ref?: Ref<HTMLDivElement>; slide: number; transition: Transition; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      className={styles.chordPane}
      custom={slide}
      variants={PANE_VARIANTS}
      initial="enter"
      animate="center"
      exit="exit"
      transition={transition}
      inert={!present}
      aria-hidden={present ? undefined : true}
    >
      {children}
    </motion.div>
  );
}

/** Symbols that read well at 16 px in every OS's fonts, then emoji for the rest of life. */
const PICKER_SYMBOLS = ['✦', '♪', '♫', '♩', '♬', '◆', '●', '▲', '★', '♥', '☀', '☾', '✿', '❖', '⚑', '⌂', '✎', '✈', '⚡', '☂', '♞', '⚙', '✉', '☕'];
const PICKER_EMOJI = ['💼', '🏠', '🎵', '🎨', '📚', '💡', '🚀', '🌱', '🎮', '🍳', '🧪', '💰', '🛒', '🏋️', '🐶', '❤️', '⭐', '🔥', '🌊', '🎓', '🏖️', '🎬', '📷', '🧘'];

const EMOJI_PANEL: Partial<Record<SystemInfo['platform'], string>> = { win32: 'Win + .', darwin: '⌃⌘Space' };

function IconPicker({ chord, info, onPick, onClose }: { chord: Chord; info: SystemInfo; onPick(icon: string): void; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  // Close on a click anywhere else, or Escape.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const grid = (title: string, icons: string[]) => (
    <>
      <p className={styles.pickerTitle}>{title}</p>
      <div className={styles.iconGrid}>
        {icons.map((icon) => (
          <button
            key={icon}
            type="button"
            className={styles.iconCell}
            aria-label={icon}
            aria-pressed={icon === chord.icon}
            onClick={() => onPick(icon)}
          >
            {icon}
          </button>
        ))}
      </div>
    </>
  );
  const panelKeys = EMOJI_PANEL[info.platform];
  return (
    <div ref={root} className={styles.iconPicker} role="dialog" aria-label="Chord icon">
      <input
        className={styles.iconInput}
        aria-label="Type or paste an emoji or letter"
        placeholder={panelKeys ? `Type a letter, or ${panelKeys} for emoji` : 'Type or paste an emoji or letter'}
        spellCheck={false}
        autoFocus
        onChange={(e) => {
          const icon = firstGrapheme(e.currentTarget.value);
          if (icon) onPick(icon);
        }}
      />
      {grid('Symbols', PICKER_SYMBOLS)}
      {grid('Emoji', PICKER_EMOJI)}
    </div>
  );
}

export function ChordHeader({
  chord,
  info,
  edit,
  onDone,
}: {
  chord: Chord | undefined;
  info: SystemInfo;
  /** Started from outside (a new chord, the chord menu). */
  edit: 'name' | 'icon' | null;
  onDone(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const isEditing = (editing || edit === 'name') && chord;
  const isPicking = (picking || edit === 'icon') && chord;
  const commit = (name: string) => {
    if (chord && name.trim() && name.trim() !== chord.name) void api.state.dispatch({ t: 'chord.update', chordId: chord.id, name });
    setEditing(false);
    onDone();
  };
  const closePicker = () => {
    setPicking(false);
    onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit(event.currentTarget.value);
    else if (event.key === 'Escape') {
      setEditing(false);
      onDone();
    }
  };
  return (
    <div className={styles.chordHeader}>
      <button
        type="button"
        className={styles.chordIconButton}
        aria-label="Change icon"
        aria-expanded={Boolean(isPicking)}
        title="Change icon"
        onClick={() => setPicking(!isPicking)}
      >
        {chord?.icon ?? '✦'}
      </button>
      {isPicking && (
        <IconPicker
          chord={chord}
          info={info}
          onPick={(icon) => {
            void api.state.dispatch({ t: 'chord.update', chordId: chord.id, icon });
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
      {isEditing ? (
        <input
          key={chord.id}
          className={styles.renameInput}
          defaultValue={chord.name}
          aria-label="Chord name"
          maxLength={64}
          spellCheck={false}
          // Focus and select on mount, so typing replaces the name.
          ref={(el) => {
            if (el && document.activeElement !== el) {
              el.focus();
              el.select();
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      ) : (
        <span className={styles.ellipsis} title="Double-click to rename" onDoubleClick={() => setEditing(true)}>
          {chord?.name ?? ''}
        </span>
      )}
    </div>
  );
}

export function ChordSwitcher({
  state,
  windowId,
  info,
  pill,
  onCreate,
}: {
  state: State;
  windowId: string;
  info: SystemInfo;
  pill: Transition;
  onCreate(): void;
}) {
  const chords = sortedChords(state);
  const current = state.windows[windowId]?.activeChordId;
  return (
    <footer className={styles.footer}>
      <div className={styles.switcher} role="tablist" aria-label="Chords">
        {chords.map((chord, index) => {
          const selected = chord.id === current;
          // Each chord's icon wears its own accent, so the switcher previews every chord's color.
          const accent = createChordTheme(chord.theme, { systemAppearance: info.appearance, material: info.material }).vars['--color-accent'];
          const keys = gotoKeys(index, info);
          return (
            <button
              key={chord.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={chord.name}
              title={keys ? `${chord.name}  ${keys}` : chord.name}
              className={styles.chordButton}
              style={{ color: accent }}
              onClick={() => void api.state.dispatch({ t: 'chord.activate', windowId, chordId: chord.id })}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                void api.menu.chord(chord.id, { x: e.clientX, y: e.clientY });
              }}
            >
              {selected && <motion.span layoutId="chord-pill" className={styles.chordPill} transition={pill} />}
              <span className={styles.chordGlyph}>{chord.icon}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className={styles.iconButton} aria-label="New chord" title="New chord" onClick={onCreate}>
        <Plus size={16} strokeWidth={1.75} />
      </button>
    </footer>
  );
}
