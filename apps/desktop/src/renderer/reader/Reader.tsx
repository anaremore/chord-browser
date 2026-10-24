/**
 * Reader view (DESIGN.md §7.11, ARCHITECTURE.md §9): a tab's article in
 * Chord's typography and its chord's colors, in place of the page. A quiet
 * bar on top says whose article it is and holds the text controls (size,
 * font, line width, colors; remembered for every page) and Close. Esc closes
 * the controls first, then reader view; the tab's page comes back as it was.
 */
import { READER_SIZES, readingMinutes, type ReaderFont, type ReaderSettings, type ReaderTheme, type ReaderWidth } from '@chord/core';
import type { ReaderArticleView, ReaderLook, SystemInfo } from '@chord/ipc';
import { createReaderTheme, hexToRgb, presetStops, readerType, readerTypeVars, rgbToOklch, tokenVars, type ThemeContext } from '@chord/tokens';
import { AArrowDown, AArrowUp, ALargeSmall, BookOpenText, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useRestoreFocus, useRoving } from '../shared/a11y';
import { useLive, type Live } from '../shared/live';
import { api } from './api';
import { ArticleContent } from './Article';
import styles from './Reader.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const THEMES: { value: ReaderTheme; label: string }[] = [
  { value: 'chord', label: 'Chord' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'sepia', label: 'Sepia' },
];
const FONTS: { value: ReaderFont; label: string }[] = [
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
];
const WIDTHS: { value: ReaderWidth; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'medium', label: 'Medium' },
  { value: 'wide', label: 'Wide' },
];

/** One of the controls' choices: a radio group (one Tab stop; arrows move and choose). */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  preview,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  preview?(value: T): CSSProperties;
}) {
  const roving = useRoving<HTMLDivElement>({ items: '[role="radio"]', current: '[aria-checked="true"]', orientation: 'horizontal', activate: true });
  return (
    <div className={styles.group}>
      <span className={styles.groupLabel} aria-hidden>
        {label}
      </span>
      <div ref={roving.ref} className={styles.choices} role="radiogroup" aria-label={label} onKeyDown={roving.onKeyDown}>
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className={styles.choice} onClick={() => onChange(option.value)}>
            {preview && <span className={styles.swatch} style={preview(option.value)} aria-hidden />}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The text controls: size, font, line width and colors. Each change applies at once, to every reader view. */
function TextControls({ settings, themeContext, chordTheme, onClose }: { settings: ReaderSettings; themeContext: ThemeContext; chordTheme: Parameters<typeof createReaderTheme>[1]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useRestoreFocus(true, ref);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    // A click anywhere else puts the controls away (their own button toggles them).
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !document.querySelector('[aria-controls="reader-controls"]')?.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, []);
  const set = (patch: Partial<ReaderSettings>) => void api.reader.set(patch);
  const size = readerType(settings.size).body.size;
  const swatch = (theme: ReaderTheme): CSSProperties => {
    const { vars } = createReaderTheme(theme, chordTheme, themeContext);
    return { '--swatch-surface': vars['--color-surface'], '--swatch-fg': vars['--color-fg'] } as CSSProperties;
  };
  return (
    <div ref={ref} id="reader-controls" className={styles.controls} role="group" aria-label="Text and colors">
      <div className={styles.group}>
        <span className={styles.groupLabel} aria-hidden>
          Text size
        </span>
        <div className={styles.sizes} role="group" aria-label="Text size">
          <button type="button" className={styles.iconButton} aria-label="Smaller text" title="Smaller text" disabled={settings.size <= 0} onClick={() => set({ size: settings.size - 1 })}>
            <AArrowDown {...ICON} />
          </button>
          <output className={styles.sizeValue} aria-live="polite">
            {size} px
          </output>
          <button type="button" className={styles.iconButton} aria-label="Larger text" title="Larger text" disabled={settings.size >= READER_SIZES - 1} onClick={() => set({ size: settings.size + 1 })}>
            <AArrowUp {...ICON} />
          </button>
        </div>
      </div>
      <Choice label="Font" value={settings.font} options={FONTS} onChange={(font) => set({ font })} />
      <Choice label="Line width" value={settings.width} options={WIDTHS} onChange={(width) => set({ width })} />
      <Choice label="Colors" value={settings.theme} options={THEMES} onChange={(theme) => set({ theme })} preview={swatch} />
    </div>
  );
}

export function ReaderView({ info: infoSource, look: lookSource, article, imageBase }: { info: Live<SystemInfo>; look: Live<ReaderLook>; article: ReaderArticleView; imageBase: string }) {
  const info = useLive(infoSource);
  const look = useLive(lookSource);
  const settings = look.reader;
  const [controls, setControls] = useState(false);

  // The reader's colors: its tab's chord theme (or Light, Dark, Sepia), solid, with focus rings in the OS accent.
  const accent = info.accentColor ? hexToRgb(info.accentColor) : null;
  const themeContext: ThemeContext = {
    systemAppearance: info.appearance,
    material: 'solid',
    contrast: look.interface.contrast,
    glass: look.interface.glass,
    focus: accent ? rgbToOklch(accent) : null,
  };
  const chordTheme = look.theme ?? { stops: presetStops('dusk'), grain: 0.2, appearance: 'auto' as const };
  const theme = createReaderTheme(settings.theme, chordTheme, themeContext);

  // On the document itself, so the page's background and scrollbars are the theme's too.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const vars: Record<string, string> = { ...tokenVars(info.platform, theme.appearance), ...theme.vars, ...readerTypeVars(settings.size, settings.font, settings.width) };
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.colorScheme = theme.appearance;
    root.dataset['appearance'] = theme.appearance;
    root.toggleAttribute('data-reduced-motion', look.reducedMotion);
  });

  // The article is on the page: main puts this view in front of the tab's page now.
  useEffect(() => {
    void api.reader.ready();
  }, []);

  // Esc puts the controls away, then closes reader view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      if (controls) setControls(false);
      else void api.reader.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controls]);

  const minutes = readingMinutes(article.words);
  const details = [article.byline, `${minutes} min read`].filter(Boolean).join(' · ');

  return (
    <>
      <header className={styles.bar}>
        <BookOpenText {...ICON} className={styles.barIcon} aria-hidden />
        <span className={styles.site}>{article.site}</span>
        <span className={styles.flex} />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Text and colors"
          title="Text and colors"
          aria-expanded={controls}
          aria-controls="reader-controls"
          onClick={() => setControls((open) => !open)}
        >
          <ALargeSmall {...ICON} />
        </button>
        <button type="button" className={styles.iconButton} aria-label="Close reader view" title={`Close reader view  Esc${look.toggleKeys ? ` · ${look.toggleKeys}` : ''}`} onClick={() => void api.reader.close()}>
          <X {...ICON} />
        </button>
        {controls && <TextControls settings={settings} themeContext={themeContext} chordTheme={chordTheme} onClose={() => setControls(false)} />}
      </header>
      <main className={styles.main}>
        <article className={styles.article} lang={article.lang ?? undefined} dir={article.dir ?? undefined}>
          <header className={styles.head}>
            <h1 className={styles.title}>{article.title}</h1>
            <p className={styles.details}>{details}</p>
          </header>
          <div className={styles.body}>
            <ArticleContent nodes={article.content} imageBase={imageBase} />
          </div>
        </article>
      </main>
    </>
  );
}
