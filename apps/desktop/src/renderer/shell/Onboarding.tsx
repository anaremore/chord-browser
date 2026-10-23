/**
 * First run (DESIGN.md §8.1): your first chord in under a minute. The cards
 * sit in the content frame, and every choice lands in the real sidebar as you
 * make it. That is the tour.
 */
import { SAFE_BROWSING_NOTICE, type Chord, type ChordThemeSpec } from '@chord/core';
import type { DefaultBrowserStatus, SystemInfo } from '@chord/ipc';
import { PRESETS, SWATCHES, cssOklch, presetStops, type PresetId, type SwatchId } from '@chord/tokens';
import { Check, Dices, ShieldCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRoving } from '../shared/a11y';
import type { SpringFor } from '../shared/motion';
import { announce } from './announce';
import { api } from './api';
import { useKeys } from './keys';
import styles from './Onboarding.module.css';
import { asUrl, suggestSites } from './popular-sites';

type Step = 'welcome' | 'name' | 'theme' | 'pins' | 'default' | 'safety' | 'tips';
const STEPS: { step: Step; optional: boolean }[] = [
  { step: 'welcome', optional: false },
  { step: 'name', optional: false },
  { step: 'theme', optional: false },
  { step: 'pins', optional: true },
  { step: 'default', optional: true },
  // Safe Browsing's notice, which Google's terms want seen before it's on. Not skippable with Esc: it's a choice.
  { step: 'safety', optional: false },
  { step: 'tips', optional: false },
];

/** Picking one fills the name and suggests an icon. */
const NAME_CHIPS = [
  { name: 'Personal', icon: '✨' },
  { name: 'Work', icon: '💼' },
  { name: 'School', icon: '📚' },
  { name: 'Side project', icon: '🚀' },
  { name: 'Home', icon: '🏡' },
] as const;

/** The app icon's three notes (build/icon.svg): the only place the mark animates (DESIGN.md §2). */
const NOTES = [
  { x: 14, y: 8, width: 12, color: '#a585f4' },
  { x: 10, y: 14, width: 14, color: '#f06aae' },
  { x: 6, y: 20, width: 14, color: '#ff7d55' },
] as const;

const titleCase = (id: string) => id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const RADIOS = { items: '[role="radio"]', current: '[aria-checked="true"]', activate: true } as const;
const PRESET_GRAIN = 0.2;

function Mark({ spring }: { spring: SpringFor }) {
  return (
    <svg className={styles.mark} viewBox="4 6 24 20" aria-hidden>
      {/* Its own presence boundary: the card's skips its first animation, and would skip the notes' too. */}
      <AnimatePresence>
        {NOTES.map((note, i) => (
          <motion.rect
            key={note.color}
            y={note.y}
            width={note.width}
            height={4}
            rx={2}
            fill={note.color}
            // Each note overlaps the one above through a cutout in the card's color.
            className={styles.note}
            initial={{ x: note.x - 6, opacity: 0 }}
            animate={{ x: note.x, opacity: 1 }}
            transition={{ ...spring('bouncy', 'commandBar'), delay: i * 0.06 }}
          />
        ))}
      </AnimatePresence>
    </svg>
  );
}

function Primary({ children, onClick, disabled }: { children: ReactNode; onClick(): void; disabled?: boolean }) {
  return (
    <button type="button" className={styles.primary} data-primary disabled={disabled} onClick={onClick}>
      {children}
      <kbd className={styles.enter} aria-hidden>
        ↵
      </kbd>
    </button>
  );
}

function NameStep({ chord, onNext }: { chord: Chord; onNext(): void }) {
  const [name, setName] = useState('');
  const rename = (value: string, icon?: string) => {
    setName(value);
    // The sidebar header types along; an empty field leaves the placeholder name in place.
    if (value.trim() || icon) void api.state.dispatch({ t: 'chord.update', chordId: chord.id, name: value.trim() || chord.name, ...(icon ? { icon } : {}) });
  };
  const finish = () => {
    if (!name.trim()) rename('Personal', NAME_CHIPS[0].icon);
    onNext();
  };
  return (
    <>
      <h1 className={styles.title}>What’s this chord for?</h1>
      <p className={styles.body}>Each chord is a set of tabs with its own color. You can make more any time.</p>
      <input
        className={styles.field}
        value={name}
        placeholder="Personal"
        aria-label="Chord name"
        maxLength={64}
        autoFocus
        spellCheck={false}
        onChange={(e) => rename(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && finish()}
      />
      <div className={styles.chips}>
        {NAME_CHIPS.map((chip) => (
          <button key={chip.name} type="button" className={styles.chip} aria-pressed={chord.name === chip.name} onClick={() => rename(chip.name, chip.icon)}>
            <span aria-hidden>{chip.icon}</span> {chip.name}
          </button>
        ))}
      </div>
      <div className={styles.actions}>
        <Primary onClick={finish}>Next</Primary>
      </div>
    </>
  );
}

function ThemeStep({ chord, onNext }: { chord: Chord; onNext(): void }) {
  const apply = (theme: Partial<ChordThemeSpec>) => void api.state.dispatch({ t: 'chord.theme', chordId: chord.id, theme });
  const usePreset = (id: PresetId) => apply({ stops: presetStops(id), grain: PRESET_GRAIN, themeId: `preset:${id}` });
  // Each group is one Tab stop; arrow keys pick within it (WAI-ARIA radio group).
  const presetsGroup = useRoving<HTMLDivElement>(RADIOS);
  const swatchesGroup = useRoving<HTMLDivElement>(RADIOS);
  const surprise = () => {
    const presets = Object.keys(PRESETS) as PresetId[];
    const others = presets.filter((id) => chord.theme.themeId !== `preset:${id}`);
    usePreset(others[Math.floor(Math.random() * others.length)]!);
  };
  return (
    <>
      <h1 className={styles.title}>Make it yours.</h1>
      <p className={styles.body}>Pick the colors for {chord.name}. Watch the sidebar.</p>
      <div ref={presetsGroup.ref} className={styles.presets} role="radiogroup" aria-label="Theme" onKeyDown={presetsGroup.onKeyDown}>
        {(Object.keys(PRESETS) as PresetId[]).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={chord.theme.themeId === `preset:${id}`}
            aria-label={titleCase(id)}
            title={titleCase(id)}
            className={styles.preset}
            style={{ backgroundImage: `linear-gradient(150deg, ${PRESETS[id].map((s) => cssOklch(SWATCHES[s])).join(', ')})` }}
            onClick={() => usePreset(id)}
          />
        ))}
      </div>
      <div ref={swatchesGroup.ref} className={styles.swatches} role="radiogroup" aria-label="One color" onKeyDown={swatchesGroup.onKeyDown}>
        {(Object.keys(SWATCHES) as SwatchId[]).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={!chord.theme.themeId && chord.theme.stops.length === 1 && chord.theme.stops[0]!.h === SWATCHES[id].h && chord.theme.stops[0]!.c === SWATCHES[id].c}
            aria-label={titleCase(id)}
            title={titleCase(id)}
            className={styles.swatch}
            style={{ backgroundColor: cssOklch(SWATCHES[id]) }}
            onClick={() => apply({ stops: [{ ...SWATCHES[id] }], grain: PRESET_GRAIN, themeId: null })}
          />
        ))}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={surprise}>
          <Dices size={16} strokeWidth={1.75} aria-hidden /> Surprise me
        </button>
        <span className={styles.spacer} />
        <Primary onClick={onNext}>Looks good</Primary>
      </div>
    </>
  );
}

function PinsStep({ windowId, onNext }: { windowId: string; onNext(): void }) {
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);
  const suggestions = suggestSites(text).filter((site) => !pinned.includes(site));
  const pin = (value: string) => {
    const url = asUrl(value);
    if (!url) return;
    void api.state.dispatch({ t: 'tab.open', windowId, url, background: true, pinned: true });
    const { host, pathname } = new URL(url);
    setPinned([...pinned, host + pathname.replace(/\/$/, '')]);
    setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (text.trim()) pin(suggestions[0] ?? text);
    else onNext();
  };
  return (
    <>
      <p className={styles.eyebrow}>
        <Check size={14} strokeWidth={2.5} aria-hidden /> Chord created
      </p>
      <h1 className={styles.title}>What do you open every day?</h1>
      <p className={styles.body}>They’ll stay pinned at the top of this chord.</p>
      <input
        className={styles.field}
        value={text}
        placeholder="mail.google.com, github.com…"
        aria-label="A site you open every day"
        autoFocus
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 && (
        <div className={styles.chips}>
          {suggestions.map((site) => (
            <button key={site} type="button" className={styles.chip} onClick={() => pin(site)}>
              {site}
            </button>
          ))}
        </div>
      )}
      {pinned.length > 0 && (
        <ul className={styles.pinned} aria-label="Pinned so far">
          {pinned.map((site) => (
            <li key={site}>
              <Check size={12} strokeWidth={2.5} aria-hidden /> {site}
            </li>
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={onNext}>
          Skip for now <kbd className={styles.inlineKey}>Esc</kbd>
        </button>
        <span className={styles.spacer} />
        <Primary onClick={onNext}>Next</Primary>
      </div>
    </>
  );
}

const DEFAULT_OUTCOME: Record<SystemInfo['platform'], string> = {
  darwin: 'Your Mac will ask you to confirm.',
  win32: 'Windows will open Settings. Pick Chord under Web browser.',
  linux: 'Chord becomes your web browser right away.',
};

function DefaultStep({ info, onNext }: { info: SystemInfo; onNext(): void }) {
  const make = async () => {
    await api.defaultBrowser.make();
    onNext();
  };
  return (
    <>
      <h1 className={styles.title}>Open links in Chord?</h1>
      <p className={styles.body}>Links from Mail, Slack, and your other apps will open here. {DEFAULT_OUTCOME[info.platform]}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={onNext}>
          Not now <kbd className={styles.inlineKey}>Esc</kbd>
        </button>
        <span className={styles.spacer} />
        <Primary onClick={() => void make()}>Make Chord my default</Primary>
      </div>
    </>
  );
}

/** Safe Browsing (ARCHITECTURE.md §14.1): on unless you say not now, with the notice in full first. */
function SafetyStep({ onNext }: { onNext(): void }) {
  const choose = (on: boolean) => {
    void api.safeBrowsing.choose(on);
    onNext();
  };
  return (
    <>
      <p className={styles.eyebrow}>
        <ShieldCheck size={14} strokeWidth={2.5} aria-hidden /> Safe Browsing
      </p>
      <h1 className={styles.title}>Warn you before risky sites?</h1>
      <p className={styles.body}>{SAFE_BROWSING_NOTICE}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={() => choose(false)}>
          Not now
        </button>
        <span className={styles.spacer} />
        <Primary onClick={() => choose(true)}>Turn on warnings</Primary>
      </div>
    </>
  );
}

function TipsStep({ info, onDone }: { info: SystemInfo; onDone(): void }) {
  const { keycap } = useKeys(info);
  // "⌘1–9" while chords 1 and 9 still follow that pattern; otherwise chord 1's own key.
  const first = keycap('chord.goto1');
  const last = keycap('chord.goto9');
  const jump = first && last && first.slice(0, -1) === last.slice(0, -1) && first.endsWith('1') ? `${first}–9` : first;
  const tips = [
    { keys: keycap('tab.new'), glyph: '⌘', title: 'Search or open anything', body: 'Tabs, history, and actions, from one box.' },
    { keys: jump, glyph: '⇄', title: 'Jump between chords', body: 'Or swipe the sidebar sideways.' },
    { keys: '', glyph: '↑', title: 'Drag a tab up to pin it', body: 'Pinned tabs stay put for good.' },
  ];
  return (
    <>
      <h1 className={styles.title}>Three things to know</h1>
      <ul className={styles.tips}>
        {tips.map((tip) => (
          <li key={tip.title} className={styles.tip}>
            {tip.keys ? (
              <kbd className={styles.keycap}>{tip.keys}</kbd>
            ) : (
              <span className={styles.dragGlyph} aria-hidden>
                {tip.glyph}
              </span>
            )}
            <span className={styles.tipText}>
              <span className={styles.tipTitle}>{tip.title}</span>
              <span className={styles.tipBody}>{tip.body}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <span className={styles.spacer} />
        <Primary onClick={onDone}>Start browsing</Primary>
      </div>
    </>
  );
}

export function Onboarding({ chord, windowId, info, spring }: { chord: Chord; windowId: string; info: SystemInfo; spring: SpringFor }) {
  const [index, setIndex] = useState(0);
  const [defaultStatus, setDefaultStatus] = useState<DefaultBrowserStatus | null>(null);
  const [safeBrowsing, setSafeBrowsing] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => void api.defaultBrowser.status().then(setDefaultStatus), []);
  useEffect(() => void api.safeBrowsing.status().then((s) => setSafeBrowsing(s.available)), []);

  // Development builds can't be the default browser, and a default one needn't ask: skip that step.
  // A build without Safe Browsing (no API key) doesn't offer it.
  const steps = STEPS.filter((s) => (s.step !== 'default' || defaultStatus === 'not-default') && (s.step !== 'safety' || safeBrowsing));
  const current = steps[Math.min(index, steps.length - 1)]!;
  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1));
  const finish = () => {
    void api.state.dispatch({ t: 'settings.set', settings: { onboarded: true } });
    void api.overlay.open('new');
  };

  // Each step starts on its field, or its main button, and screen readers hear which step it is. The
  // card is keyed by step, so this runs as each new card arrives (after the old one has gone).
  const arrived = (el: HTMLDivElement | null) => {
    card.current = el;
    if (!el) return;
    el.querySelector<HTMLElement>('input, button[data-primary]')?.focus();
    const heading = el.querySelector('h1')?.textContent;
    if (index > 0 && heading) announce(`${heading} Step ${index + 1} of ${steps.length}.`);
  };
  // ↵ is always the main action (fields handle their own), and Esc skips an optional step.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && current.optional) {
      event.preventDefault();
      next();
    } else if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'INPUT') {
      event.preventDefault();
      card.current?.querySelector<HTMLButtonElement>('button[data-primary]')?.click();
    }
  };

  return (
    <div className={styles.stage} role="dialog" aria-modal="false" aria-label="Welcome to Chord" aria-describedby="onboarding-step" onKeyDown={onKeyDown} data-page-state>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={current.step}
          ref={arrived}
          className={styles.card}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={spring('overlay', 'commandBar')}
        >
          {current.step === 'welcome' && (
            <>
              <Mark spring={spring} />
              <h1 className={styles.hello}>Hi, I’m Chord.</h1>
              <p className={`${styles.body} ${styles.lead}`}>A calm, colorful home for everything you do on the web.</p>
              <div className={styles.actions} data-center>
                <Primary onClick={next}>Make your first chord</Primary>
              </div>
            </>
          )}
          {current.step === 'name' && <NameStep chord={chord} onNext={next} />}
          {current.step === 'theme' && <ThemeStep chord={chord} onNext={next} />}
          {current.step === 'pins' && <PinsStep windowId={windowId} onNext={next} />}
          {current.step === 'default' && <DefaultStep info={info} onNext={next} />}
          {current.step === 'safety' && <SafetyStep onNext={next} />}
          {current.step === 'tips' && <TipsStep info={info} onDone={finish} />}
        </motion.div>
      </AnimatePresence>
      <ol id="onboarding-step" className={styles.dots} aria-label={`Step ${index + 1} of ${steps.length}`}>
        {steps.map((s, i) => (
          <li key={s.step} className={styles.dot} data-optional={s.optional || undefined} data-current={i === index || undefined} data-done={i < index || undefined} />
        ))}
      </ol>
    </div>
  );
}
