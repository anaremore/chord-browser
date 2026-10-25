/**
 * Chords in the sidebar (DESIGN.md §3.2, §8.2): the header with inline
 * rename and the icon picker, the switcher in the footer, and the color
 * crossfade behind it all.
 */
import { DEFAULT_PROFILE, chordsFor, chordsWithCounts, firstGrapheme, keycapFor, type ActionId, type Chord, type ChordThemeSpec, type ShortcutOverrides, type State } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { createChordTheme, presetStops, type PresetId } from '@chord/tokens';
import { useDroppable } from '@dnd-kit/react';
import { EyeOff, KeyRound, Plus } from 'lucide-react';
import { motion, useIsPresent, type MotionValue, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react';
import { useRestoreFocus, useRoving } from '../shared/a11y';
import { api } from './api';
import styles from './App.module.css';
import { CHORD_DROP } from './tree';
import type { PaneMotion } from './useChordSwipe';

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

/** The key for the nth chord (with your shortcut changes), for its tooltip. */
function gotoKeys(index: number, info: SystemInfo, overrides: ShortcutOverrides): string {
  if (index > 8) return '';
  return keycapFor(`chord.goto${index + 1}` as ActionId, info.platform, overrides);
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

/**
 * How a pane comes and goes (useChordSwipe.ts). A click or key slides it in
 * 24 px from the switcher's side. A swipe's commit continues from where the
 * fingers left it: the swipe moves the new pane, and the old one leaves with
 * the same spring. With reduced motion, a commit crossfades.
 */
const PANE_VARIANTS = {
  enter: (m: PaneMotion) => (m.kind === 'swipe' ? { opacity: 1 } : m.kind === 'fade' ? { opacity: 0 } : { opacity: 0, x: m.dir * 24 }),
  center: (m: PaneMotion) => (m.kind === 'swipe' ? { opacity: 1 } : m.kind === 'fade' ? { opacity: 1, transition: m.transition } : { opacity: 1, x: 0 }),
  exit: (m: PaneMotion) =>
    m.kind === 'swipe' ? { x: m.exitTo, transition: m.transition } : m.kind === 'fade' ? { opacity: 0, transition: m.transition } : { opacity: 0, x: m.dir * -24 },
};

/**
 * One chord's part of the sidebar, sliding in from the side of the switcher
 * it sits on. While a pane slides out it's inert and hidden from assistive
 * tech, so only the chord you switched to can be reached.
 */
export function ChordPane({
  ref,
  motion: paneMotion,
  x,
  transition,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  motion: PaneMotion;
  /** Where a swipe has the pane (useChordSwipe.ts). */
  x: MotionValue<number>;
  transition: Transition;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      className={styles.chordPane}
      style={{ x }}
      custom={paneMotion}
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

/** A neighbor chord's pane beside the current one while a swipe moves them; never interactive. */
export function GhostPane({ x, children }: { x: MotionValue<number>; children: ReactNode }) {
  return (
    <motion.div className={`${styles.chordPane} ${styles.ghostPane}`} style={{ x }} inert aria-hidden>
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
  // Picked or dismissed, the keyboard goes back to the icon button.
  useRestoreFocus(true, root);
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
  // Named (or not), the keyboard goes back where it was: the New chord button, the chord's menu.
  const nameField = useRef<HTMLInputElement | null>(null);
  useRestoreFocus(Boolean(isEditing), nameField);
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
  // A private window's chord: nothing to rename or recolor, and it says what it is.
  if (chord?.private) {
    return (
      <div className={styles.chordHeader}>
        <span className={styles.privateGlyph} aria-hidden>
          <EyeOff size={14} strokeWidth={2} />
        </span>
        <span className={styles.ellipsis}>{chord.name}</span>
      </div>
    );
  }
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
            nameField.current = el;
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
      {chord && chord.profileId !== DEFAULT_PROFILE && (
        <span className={styles.signIns} role="img" aria-label="Keeps its own sign-ins" title="Keeps its own sign-ins">
          <KeyRound size={12} strokeWidth={2} aria-hidden />
        </span>
      )}
    </div>
  );
}

/** A chord in the switcher. Dropping a tab on another chord moves the tab there. */
function ChordButton({ chord, selected, unread, keys, info, pill, windowId }: { chord: Chord; selected: boolean; unread: boolean; keys: string; info: SystemInfo; pill: Transition; windowId: string }) {
  // Tabs never cross into or out of a private window's chord.
  const { ref, isDropTarget } = useDroppable({ id: CHORD_DROP + chord.id, type: 'chord', accept: 'tab', disabled: selected || Boolean(chord.private) });
  // Each chord's icon wears its own accent, so the switcher previews every chord's color.
  const accent = createChordTheme(chord.theme, { systemAppearance: info.appearance, material: info.material }).vars['--color-accent'];
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={unread && !selected ? `${chord.name}, unread` : chord.name}
      title={keys ? `${chord.name}  ${keys}` : chord.name}
      className={styles.chordButton}
      data-drop-target={isDropTarget || undefined}
      style={{ color: accent }}
      onClick={() => void api.state.dispatch({ t: 'chord.activate', windowId, chordId: chord.id })}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        void api.menu.chord(chord.id, { x: e.clientX, y: e.clientY });
      }}
    >
      {selected && <motion.span layoutId="chord-pill" className={styles.chordPill} transition={pill} />}
      {chord.private ? <EyeOff className={styles.chordGlyph} size={14} strokeWidth={2} aria-hidden /> : <span className={styles.chordGlyph} aria-hidden>{chord.icon}</span>}
      {/* A tab in another chord shows a count (unread messages): a dot in that chord's own color. */}
      {unread && !selected && <span className={styles.chordUnread} data-count aria-hidden />}
    </button>
  );
}

export function ChordSwitcher({
  state,
  windowId,
  info,
  pill,
  leading,
  onCreate,
}: {
  state: State;
  windowId: string;
  info: SystemInfo;
  pill: Transition;
  /** The footer's left slot (the Downloads button), opposite New chord so the switcher stays centered. */
  leading: ReactNode;
  /** Null in a private window, which can't make chords. */
  onCreate: (() => void) | null;
}) {
  // A private window shows only its own chord; no other window ever shows that one.
  const chords = chordsFor(state, windowId);
  const current = state.windows[windowId]?.activeChordId;
  const unread = chordsWithCounts(state);
  const strip = useRef<HTMLDivElement>(null);
  // More chords than fit: the strip scrolls sideways (no scrollbar), fading at whichever edge hides some.
  const [fade, setFade] = useState<'none' | 'start' | 'end' | 'both'>('none');
  /** Whether some chord was out of sight at the last measurement (a scroll, a resize, a new chord). */
  const overflows = useRef(false);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const update = () => {
      const before = el.scrollLeft > 1;
      const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      overflows.current = before || after;
      setFade(before && after ? 'both' : before ? 'start' : after ? 'end' : 'none');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [chords.length]);
  // One Tab stop; ← → move between chords and switch to them (WAI-ARIA tabs, automatic activation). Placed on the
  // next frame, so a switch (which redraws the whole sidebar) isn't laid out twice to find which chords show.
  const roving = useRoving<HTMLDivElement>({ items: '[role="tab"]', current: '[aria-selected="true"]', orientation: 'horizontal', activate: true, deferred: true });
  // The chord you're in is always in view. Only scrolled to when some chord is out of sight:
  // scrolling into view lays out the whole window on the spot, which right after a switch (a chord's
  // sidebar just rendered) costs most of a frame (ARCHITECTURE.md §1).
  useEffect(() => {
    if (!overflows.current) return;
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [current, chords.length]);
  return (
    <footer className={styles.footer}>
      {leading}
      <div
        ref={(el) => {
          strip.current = el;
          return roving.ref(el);
        }}
        className={styles.switcher}
        role="tablist"
        aria-label="Chords"
        aria-orientation="horizontal"
        onKeyDown={roving.onKeyDown}
        data-fade={fade}
        // A mouse wheel scrolls up and down; turn that into sideways movement here.
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current?.scrollBy({ left: e.deltaY });
        }}
      >
        {chords.map((chord, index) => (
          <ChordButton key={chord.id} chord={chord} selected={chord.id === current} unread={unread.has(chord.id)} keys={gotoKeys(index, info, state.settings.shortcuts)} info={info} pill={pill} windowId={windowId} />
        ))}
      </div>
      {onCreate ? (
        <button type="button" className={styles.iconButton} aria-label="New chord" title="New chord" onClick={onCreate}>
          <Plus size={16} strokeWidth={1.75} />
        </button>
      ) : (
        <span className={styles.iconButton} aria-hidden />
      )}
    </footer>
  );
}
