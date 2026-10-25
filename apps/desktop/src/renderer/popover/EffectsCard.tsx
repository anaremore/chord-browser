/**
 * The Effects card (DESIGN.md §7.15): a site's Effects in the popover, over
 * the page, which shows each change as it's made. Dry · Wet, the presets,
 * hiding an element, your CSS, Ask Duet, and removing it all. Main keeps the
 * site's Effects and pushes them here (`effects:state`); every change goes back
 * as an action, checked again in main against the card's own site.
 */
import { EFFECT_PRESETS, type EffectPresetId } from '@chord/core';
import type { EffectsAction, EffectsView } from '@chord/ipc';
import { Blend, Check, Eye, MousePointerClick, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { DuetIcon } from '../shared/icons';
import { api } from './api';
import styles from './EffectsCard.module.css';
import base from './Popover.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
/** What you type applies after this pause. */
const TYPING_MS = 300;

const act = (action: EffectsAction) => void api.effects.act(action);

/** "Left out url() on line 3. Effects never load files." */
function removedLine(removed: EffectsView['removed']): string {
  if (removed.length === 0) return '';
  const fetching = removed.filter((r) => r.kind === 'fetch');
  const unknown = removed.filter((r) => r.kind === 'unknown');
  const list = (items: typeof removed) => items.map((r) => `${r.what} on line ${r.line}`).join(', ');
  return [fetching.length ? `Left out ${list(fetching)}. Effects never load files.` : '', unknown.length ? `Left out ${list(unknown)}, which Chord doesn’t know.` : ''].filter(Boolean).join(' ');
}

function Seconds({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>;
}

export function EffectsCard({ opened }: { opened: number }) {
  const titleId = useId();
  const cssId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EffectsView | null>(null);
  // Your CSS as typed here: main's copy catches up after each pause, and doesn't overwrite what you're typing.
  const [draft, setDraft] = useState('');
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sent = useRef<string | null>(null);
  const [ask, setAsk] = useState('');

  useEffect(() => {
    let alive = true;
    void api.effects.view().then((v) => alive && setView(v));
    const off = api.effects.onState(setView);
    return () => {
      alive = false;
      off();
    };
  }, [opened]);

  // Main's copy of your CSS, unless it's what you're still typing (or just sent).
  const css = view?.css;
  useEffect(() => {
    if (css === undefined || typing.current !== undefined) return;
    // Still waiting for what was just sent to come back: an older copy mustn't undo your typing.
    if (sent.current !== null && sent.current !== css) return;
    sent.current = null;
    setDraft(css);
  }, [css]);

  // A new opening takes the keyboard, once there's a card to take it.
  const shown = view !== null;
  useEffect(() => {
    if (shown) root.current?.focus();
  }, [opened, shown]);

  // A request that's done with clears the field; one that failed keeps your words.
  const busy = view?.ask.busy ?? false;
  const failed = Boolean(view?.ask.error);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && !failed) setAsk('');
    wasBusy.current = busy;
  }, [busy, failed]);

  if (!view) return null;

  const onCss = (text: string) => {
    setDraft(text);
    clearTimeout(typing.current);
    typing.current = setTimeout(() => {
      typing.current = undefined;
      sent.current = text;
      act({ do: 'css', css: text });
    }, TYPING_MS);
  };

  /** Every other action first sends what's still waiting out its pause, so closing the card right after typing keeps it. */
  const run = (action: EffectsAction) => {
    if (typing.current !== undefined) {
      clearTimeout(typing.current);
      typing.current = undefined;
      sent.current = draft;
      act({ do: 'css', css: draft });
    }
    act(action);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (busy) run({ do: 'stop' });
    else run({ do: 'close' });
  };

  const onAsk = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !ask.trim() || busy) return;
    event.preventDefault();
    run({ do: 'ask', text: ask.trim() });
  };

  const has = view.css.trim().length > 0 || view.hidden.length > 0 || view.presets.length > 0 || view.duet.length > 0;
  const togglePreset = (id: EffectPresetId, on: boolean) => run({ do: 'preset', id, on });
  return (
    <div ref={root} className={`${base.card} ${styles.card}`} role="dialog" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className={styles.head}>
        <Blend className={styles.glyph} {...ICON} aria-hidden />
        <p id={titleId} className={styles.title}>
          Effects on <span className={base.host}>{view.host}</span>
        </p>
        <div className={styles.mix} role="radiogroup" aria-label="Dry or wet">
          {(['dry', 'wet'] as const).map((mix) => (
            <button
              key={mix}
              type="button"
              role="radio"
              aria-checked={view.wet === (mix === 'wet')}
              className={styles.mixOption}
              title={mix === 'wet' ? 'Wet: the site with your Effects' : 'Dry: the site as it comes, your Effects kept'}
              onClick={() => run({ do: 'wet', wet: mix === 'wet' })}
            >
              {mix === 'wet' ? 'Wet' : 'Dry'}
            </button>
          ))}
        </div>
        <button type="button" className={base.iconButton} aria-label="Close Effects" title="Close (Esc)" onClick={() => run({ do: 'close' })}>
          <X {...ICON} />
        </button>
      </div>

      <div className={styles.body}>
        {!view.everywhere && (
          <p className={styles.note}>
            Every site is dry.{' '}
            <button type="button" className={styles.link} onClick={() => run({ do: 'everywhere', wet: true })}>
              Make every site wet
            </button>
          </p>
        )}
        {view.private && <p className={styles.note}>Changes here last until this window closes.</p>}

        <div className={styles.presets} role="group" aria-label="Presets">
          {EFFECT_PRESETS.map((preset) => {
            const on = view.presets.includes(preset.id);
            return (
              <button key={preset.id} type="button" className={styles.chip} aria-pressed={on} title={preset.description} onClick={() => togglePreset(preset.id, !on)}>
                {on && <Check size={14} strokeWidth={2} aria-hidden />}
                {preset.name}
              </button>
            );
          })}
        </div>

        <section className={styles.section} aria-label="Hidden elements">
          <button type="button" className={`${base.secondary} ${styles.pill}`} onClick={() => run({ do: 'pick' })}>
            <MousePointerClick {...ICON} aria-hidden />
            Hide an element…
          </button>
          {view.hidden.length > 0 && (
            <ul className={styles.list}>
              {view.hidden.map((h) => (
                <li key={h.selector} className={styles.row} title={h.selector}>
                  <span className={styles.code}>{h.label || h.selector}</span>
                  <button type="button" className={base.iconButton} aria-label={`Show ${h.label || h.selector} again`} title="Show it again" onClick={() => run({ do: 'unhide', selector: h.selector })}>
                    <Eye {...ICON} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <label htmlFor={cssId} className={styles.label}>
            Your CSS
          </label>
          <textarea
            id={cssId}
            className={styles.css}
            value={draft}
            rows={6}
            spellCheck={false}
            placeholder="body { font-size: 18px }"
            aria-describedby={view.removed.length ? `${cssId}-removed` : undefined}
            onChange={(e) => onCss(e.target.value)}
          />
          {view.removed.length > 0 && (
            <p id={`${cssId}-removed`} className={styles.note}>
              {removedLine(view.removed)}
            </p>
          )}
        </section>

        {view.ask.available && (
          <section className={styles.section} aria-label="Ask Duet">
            {busy ? (
              <div className={styles.working} role="status">
                <span>
                  {view.ask.provider ?? 'Duet'} is writing… {view.ask.startedAt !== null && <Seconds since={view.ask.startedAt} />}
                </span>
                <button type="button" className={base.secondary} onClick={() => run({ do: 'stop' })}>
                  Stop
                </button>
              </div>
            ) : (
              <label className={styles.ask}>
                <DuetIcon {...ICON} aria-hidden />
                <input value={ask} placeholder="Ask Duet to restyle this site" aria-label="Ask Duet to restyle this site" maxLength={500} onChange={(e) => setAsk(e.target.value)} onKeyDown={onAsk} />
              </label>
            )}
            {view.ask.error && (
              <p className={styles.problem} role="alert">
                {view.ask.error}
              </p>
            )}
            {view.ask.note && <p className={styles.note}>{view.ask.note}</p>}
          </section>
        )}
        {view.duet.length > 0 && (
          <ul className={styles.list} aria-label="From Duet">
            {view.duet.map((d) => (
              <li key={d.id} className={styles.row} title={d.ask}>
                <DuetIcon size={14} strokeWidth={1.75} aria-hidden className={styles.muted} />
                <span className={styles.patch}>{d.summary || d.ask}</span>
                <button type="button" className={base.iconButton} aria-label={`Remove “${d.summary || d.ask}”`} title="Remove" onClick={() => run({ do: 'removeDuet', id: d.id })}>
                  <X {...ICON} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {has && (
          <div className={styles.foot}>
            <button type="button" className={styles.link} onClick={() => run({ do: 'clear' })}>
              Remove all Effects on this site
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
