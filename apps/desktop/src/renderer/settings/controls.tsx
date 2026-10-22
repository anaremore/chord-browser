/** The Settings window's controls: rows, switches, segmented choices and reset buttons. */
import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './Settings.module.css';

export function ResetButton({ visible, onReset }: { visible: boolean; onReset(): void }) {
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

export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={styles.switch} onClick={() => onChange(!checked)}>
      <span className={styles.knob} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, label, onChange }: { value: T; options: { value: T; label: string }[]; label: string; onChange(value: T): void }) {
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

export function Row({ label, description, control, changed, onReset }: { label: string; description?: string; control: ReactNode; changed?: boolean; onReset?(): void }) {
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

export function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className={styles.sectionHeader}>
      <h1 className={styles.sectionTitle}>{title}</h1>
      <p className={styles.sectionDescription}>{description}</p>
    </header>
  );
}
