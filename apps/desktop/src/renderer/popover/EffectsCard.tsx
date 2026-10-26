/**
 * The Effects card (DESIGN.md §7.15): a site's Effects in the popover, over
 * the page, which shows each change as it's made. Dry · Wet, the presets,
 * hiding an element, your CSS, Ask Duet, and removing it all; your CSS, each
 * hidden element and each of Duet's patches with its own switch, and the
 * latter two with an editor that opens in their row. Main keeps the site's
 * Effects and pushes them here (`effects:state`); every change goes back as an
 * action, checked again in main against the card's own site.
 */
import { EFFECT_PRESETS, EFFECTS_LIMITS, type EffectPresetId } from '@chord/core';
import type { EffectsAction, EffectsView } from '@chord/ipc';
import { Blend, Check, MousePointerClick, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { DuetIcon } from '../shared/icons';
import { api } from './api';
import styles from './EffectsCard.module.css';
import base from './Popover.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
/** What you type applies after this pause. */
const TYPING_MS = 300;

const act = (action: EffectsAction) => void api.effects.act(action);

type Hidden = EffectsView['hidden'][number];
type Patch = EffectsView['duet'][number];
/** Sends waiting out a pause in typing, by field. */
type Waiting = Map<string, () => void>;

/**
 * A field that applies after a pause in typing: `pause(send)` sends after it,
 * `pause(null)` drops what's waiting. What's still waiting goes at once when
 * another action comes first (the card's `run`), or when the field goes.
 */
function usePause(waiting: Waiting, key: string): (send: (() => void) | null) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      // Going: what's waiting is sent now. What was dropped (its item removed) isn't sent later either.
      const send = waiting.get(key);
      clearTimeout(timer.current);
      send?.();
    },
    [waiting, key],
  );
  return useCallback(
    (send) => {
      clearTimeout(timer.current);
      waiting.delete(key);
      if (!send) return;
      const now = () => {
        clearTimeout(timer.current);
        waiting.delete(key);
        send();
      };
      waiting.set(key, now);
      timer.current = setTimeout(now, TYPING_MS);
    },
    [waiting, key],
  );
}

/** An item's own switch, as Settings' (settings/controls.tsx). */
function Switch({ on, label, onChange }: { on: boolean; label: string; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={styles.switch} onClick={() => onChange(!on)}>
      <span className={styles.knob} />
    </button>
  );
}

/**
 * One row of a list: its switch, its name (cut short, in full on hover), Edit
 * and Remove; open, its editor under it. Done or Esc closes the editor and the
 * keyboard goes back to Edit.
 */
function Item(props: {
  name: string;
  /** The name as its buttons say it ("“Green headline”"). */
  spoken: string;
  /** The name's tooltip: the name in full, and more. */
  title: string;
  code?: boolean;
  icon?: ReactNode;
  on: boolean;
  switchLabel: string;
  onSwitch(on: boolean): void;
  editing: boolean;
  onEdit(open: boolean): void;
  onRemove(): void;
  editor(done: () => void): ReactNode;
}) {
  const edit = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  const done = () => {
    props.onEdit(false);
    edit.current?.focus();
  };
  return (
    <li className={styles.item} data-off={props.on ? undefined : ''}>
      <div className={styles.row}>
        <Switch on={props.on} label={props.switchLabel} onChange={props.onSwitch} />
        {props.icon}
        <span className={props.code ? styles.code : styles.patch} title={props.title}>
          {props.name}
        </span>
        <button
          ref={edit}
          type="button"
          className={base.iconButton}
          aria-label={`Edit ${props.spoken}`}
          aria-expanded={props.editing}
          aria-controls={props.editing ? editorId : undefined}
          title="Edit"
          onClick={() => props.onEdit(!props.editing)}
        >
          <Pencil size={14} strokeWidth={1.75} />
        </button>
        <button type="button" className={base.iconButton} aria-label={`Remove ${props.spoken}`} title="Remove" onClick={props.onRemove}>
          <X {...ICON} />
        </button>
      </div>
      {props.editing && (
        <div
          id={editorId}
          className={styles.editor}
          role="group"
          aria-label={`Editing ${props.spoken}`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Esc closes the editor first, and the card only after.
            event.preventDefault();
            event.stopPropagation();
            done();
          }}
        >
          {props.editor(done)}
        </div>
      )}
    </li>
  );
}

/** The first field of an editor that just opened takes the keyboard. */
function useFirstFocus(field: RefObject<HTMLInputElement | null>): void {
  useEffect(() => field.current?.focus(), [field]);
}

/** A hidden element's selector and name. The selector can't be another element's, or empty. */
function HiddenEditor({ item, taken, waiting, onSent, done }: { item: Hidden; taken(selector: string, own: string): boolean; waiting: Waiting; onSent(from: string, to: string): void; done(): void }) {
  const selectorId = useId();
  const labelId = useId();
  const first = useRef<HTMLInputElement>(null);
  const [selector, setSelector] = useState(item.selector);
  const [label, setLabel] = useState(item.label);
  // The selector main has, or will have once what was sent arrives: edits name the element by it.
  const sentAs = useRef(item.selector);
  const pause = usePause(waiting, 'hidden');
  useFirstFocus(first);

  const trimmed = selector.trim();
  const clash = trimmed.length > 0 && taken(trimmed, sentAs.current);
  const change = (nextSelector: string, nextLabel: string) => {
    const next = nextSelector.trim();
    if (!next || taken(next, sentAs.current)) return pause(null);
    pause(() => {
      act({ do: 'editHidden', selector: sentAs.current, next: { selector: next, label: nextLabel } });
      onSent(sentAs.current, next);
      sentAs.current = next;
    });
  };
  const finish = () => {
    waiting.get('hidden')?.();
    done();
  };
  return (
    <>
      <label htmlFor={selectorId} className={styles.label}>
        Selector
      </label>
      <input
        ref={first}
        id={selectorId}
        className={`${styles.field} ${styles.mono}`}
        value={selector}
        maxLength={EFFECTS_LIMITS.selector}
        spellCheck={false}
        onChange={(e) => {
          setSelector(e.target.value);
          change(e.target.value, label);
        }}
      />
      <label htmlFor={labelId} className={styles.label}>
        Name
      </label>
      <input
        id={labelId}
        className={styles.field}
        value={label}
        maxLength={EFFECTS_LIMITS.label}
        placeholder={trimmed || item.selector}
        onChange={(e) => {
          setLabel(e.target.value);
          change(selector, e.target.value);
        }}
      />
      {clash ? (
        <p className={styles.note}>Another hidden element has this selector.</p>
      ) : (
        trimmed === item.selector && !item.usable && <p className={styles.note}>Chord can’t use this selector, so it hides nothing.</p>
      )}
      {!item.on && <p className={styles.note}>It’s off, so it hides nothing.</p>}
      <button type="button" className={`${base.secondary} ${styles.done}`} onClick={finish}>
        Done
      </button>
    </>
  );
}

/** One of Duet's patches: its name and its CSS, which apply after a pause as your CSS does. */
function PatchEditor({ item, waiting, done }: { item: Patch; waiting: Waiting; done(): void }) {
  const nameId = useId();
  const cssId = useId();
  const first = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(item.summary);
  const [css, setCss] = useState(item.css);
  const pause = usePause(waiting, 'patch');
  useFirstFocus(first);

  const change = (nextName: string, nextCss: string) => pause(() => act({ do: 'editDuet', id: item.id, summary: nextName, css: nextCss }));
  const finish = () => {
    waiting.get('patch')?.();
    done();
  };
  return (
    <>
      <label htmlFor={nameId} className={styles.label}>
        Name
      </label>
      <input
        ref={first}
        id={nameId}
        className={styles.field}
        value={name}
        maxLength={EFFECTS_LIMITS.summary}
        placeholder={item.ask}
        onChange={(e) => {
          setName(e.target.value);
          change(e.target.value, css);
        }}
      />
      <label htmlFor={cssId} className={styles.label}>
        CSS
      </label>
      <textarea
        id={cssId}
        className={styles.css}
        value={css}
        rows={6}
        maxLength={EFFECTS_LIMITS.duetCss}
        spellCheck={false}
        aria-describedby={item.removed.length ? `${cssId}-removed` : undefined}
        onChange={(e) => {
          setCss(e.target.value);
          change(name, e.target.value);
        }}
      />
      {item.removed.length > 0 && (
        <p id={`${cssId}-removed`} className={styles.note}>
          {removedLine(item.removed)}
        </p>
      )}
      {!item.on && <p className={styles.note}>It’s off, so the page doesn’t show it.</p>}
      <button type="button" className={`${base.secondary} ${styles.done}`} onClick={finish}>
        Done
      </button>
    </>
  );
}

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
  // Fields that apply after a pause in typing: your CSS here, and an open editor's.
  const [waiting] = useState<Waiting>(() => new Map());
  const pauseCss = usePause(waiting, 'css');
  // Your CSS as typed here: main's copy catches up after each pause, and doesn't overwrite what you're typing.
  const [draft, setDraft] = useState('');
  const sent = useRef<string | null>(null);
  const [ask, setAsk] = useState('');
  // The one editor open: `hidden:<key>` or `duet:<id>`.
  const [editing, setEditing] = useState<string | null>(null);
  // Hidden elements are named by their selector, which an editor changes as you type: each row keeps a key of its own.
  const keys = useRef({ next: 0, of: new Map<string, string>() });

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
    if (css === undefined || waiting.has('css')) return;
    // Still waiting for what was just sent to come back: an older copy mustn't undo your typing.
    if (sent.current !== null && sent.current !== css) return;
    sent.current = null;
    setDraft(css);
  }, [css, waiting]);

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
    pauseCss(() => {
      sent.current = text;
      act({ do: 'css', css: text });
    });
  };

  /** Every other action first sends what's still waiting out its pause, so closing the card right after typing keeps it. */
  const run = (action: EffectsAction) => {
    for (const send of [...waiting.values()]) send();
    act(action);
  };

  const keyOf = (selector: string): string => {
    const { of } = keys.current;
    let key = of.get(selector);
    if (!key) of.set(selector, (key = `h${keys.current.next++}`));
    return key;
  };
  /** An editor sent a new selector: its row keeps its key, so the editor stays open as you type. */
  const rekey = (from: string, to: string) => {
    const { of } = keys.current;
    of.set(to, keyOf(from));
    of.delete(from);
  };
  const takenBy = (selector: string, own: string) => view.hidden.some((h) => h.selector === selector && h.selector !== own);
  const openEditor = (id: string, open: boolean) => {
    // The editor that was open sends what it has as it goes.
    setEditing(open ? id : null);
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
              {view.hidden.map((h) => {
                const key = keyOf(h.selector);
                const name = h.label || h.selector;
                return (
                  <Item
                    key={key}
                    name={name}
                    spoken={name}
                    title={h.label && h.label !== h.selector ? `${h.label}: ${h.selector}` : h.selector}
                    code
                    on={h.on}
                    switchLabel={`Hide ${name}`}
                    onSwitch={(on) => run({ do: 'hiddenOn', selector: h.selector, on })}
                    editing={editing === `hidden:${key}`}
                    onEdit={(open) => openEditor(`hidden:${key}`, open)}
                    onRemove={() => {
                      if (editing === `hidden:${key}`) {
                        // An edit still waiting out its pause goes with the element: sent first, it would change the
                        // selector this remove names.
                        waiting.delete('hidden');
                        setEditing(null);
                      }
                      run({ do: 'unhide', selector: h.selector });
                    }}
                    editor={(done) => <HiddenEditor item={h} taken={takenBy} waiting={waiting} onSent={rekey} done={done} />}
                  />
                );
              })}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.labelRow}>
            {/* Its switch once there's something to switch, or while it's off. */}
            {(draft.trim() || !view.cssOn) && <Switch on={view.cssOn} label="Use your CSS" onChange={(on) => run({ do: 'cssOn', on })} />}
            <label htmlFor={cssId} className={styles.label}>
              Your CSS
            </label>
          </div>
          <textarea
            id={cssId}
            className={styles.css}
            data-off={view.cssOn ? undefined : ''}
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
            {view.duet.map((d) => {
              const name = d.summary || d.ask;
              return (
                <Item
                  key={d.id}
                  name={name}
                  spoken={`“${name}”`}
                  title={d.summary && d.summary !== d.ask ? `${d.summary}\nYou asked: ${d.ask}` : name}
                  icon={<DuetIcon size={14} strokeWidth={1.75} aria-hidden className={styles.muted} />}
                  on={d.on}
                  switchLabel={`Use “${name}”`}
                  onSwitch={(on) => run({ do: 'duetOn', id: d.id, on })}
                  editing={editing === `duet:${d.id}`}
                  onEdit={(open) => openEditor(`duet:${d.id}`, open)}
                  onRemove={() => {
                    if (editing === `duet:${d.id}`) setEditing(null);
                    run({ do: 'removeDuet', id: d.id });
                  }}
                  editor={(done) => <PatchEditor item={d} waiting={waiting} done={done} />}
                />
              );
            })}
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
