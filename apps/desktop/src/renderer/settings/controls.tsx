/** The Settings window's controls: rows, switches, segmented choices, radio groups and reset buttons. */
import { RotateCcw } from 'lucide-react';
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { focusNextAfter, useRoving } from '../shared/a11y';
import styles from './Settings.module.css';

/** ↺: shown only while a setting differs from its default (DESIGN.md §6.8). */
export function ResetButton({ visible, onReset, label = 'Reset to default' }: { visible: boolean; onReset(): void; label?: string }) {
  return (
    <button
      type="button"
      className={styles.reset}
      aria-label={label}
      title="Reset to default"
      data-visible={visible || undefined}
      // Hidden, it isn't there for screen readers or the keyboard either.
      aria-hidden={!visible || undefined}
      tabIndex={visible ? 0 : -1}
      onClick={(e) => {
        // It hides once the setting is back to its default: the setting itself takes the keyboard.
        focusNextAfter(e.currentTarget);
        onReset();
      }}
    >
      <RotateCcw size={13} strokeWidth={2} />
    </button>
  );
}

/** `describedBy`: the row's description, read with the switch (Row passes it). */
export function Switch({ checked, label, onChange, describedBy }: { checked: boolean; label: string; onChange(value: boolean): void; describedBy?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} className={styles.switch} onClick={() => onChange(!checked)}>
      <span className={styles.knob} />
    </button>
  );
}

/**
 * A radio group (WAI-ARIA APG): one Tab stop, on the chosen option; arrow
 * keys, Home and End move between the options and choose as they go.
 */
export function RadioGroup({ label, className, children, describedBy }: { label: string; className: string | undefined; children: ReactNode; describedBy?: string }) {
  const roving = useRoving<HTMLDivElement>({ items: '[role="radio"]', current: '[aria-checked="true"]', activate: true });
  return (
    <div ref={roving.ref} className={className} role="radiogroup" aria-label={label} aria-describedby={describedBy} onKeyDown={roving.onKeyDown}>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  label,
  onChange,
  describedBy,
}: {
  value: T;
  options: { value: T; label: string }[];
  label: string;
  onChange(value: T): void;
  describedBy?: string;
}) {
  return (
    <RadioGroup className={styles.segmented} label={label} describedBy={describedBy}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={styles.segment} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </RadioGroup>
  );
}

/** A control gets its row's description read with it: a native element as aria-describedby, Chord's controls as `describedBy`. */
function describe(control: ReactNode, id: string | undefined): ReactNode {
  if (!id || !isValidElement(control)) return control;
  return typeof control.type === 'string'
    ? cloneElement(control as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': id })
    : cloneElement(control as ReactElement<{ describedBy?: string }>, { describedBy: id });
}

export function Row({ label, description, control, changed, onReset }: { label: string; description?: string; control: ReactNode; changed?: boolean; onReset?(): void }) {
  const descriptionId = useId();
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {description && (
          <span id={descriptionId} className={styles.rowDescription}>
            {description}
          </span>
        )}
      </div>
      {onReset && <ResetButton visible={Boolean(changed)} onReset={onReset} label={`Reset ${label} to default`} />}
      {describe(control, description ? descriptionId : undefined)}
    </div>
  );
}

export function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className={styles.sectionHeader}>
      <h1 className={styles.sectionTitle}>{title}</h1>
      <p className={styles.sectionDescription}>{description}</p>
    </header>
  );
}
