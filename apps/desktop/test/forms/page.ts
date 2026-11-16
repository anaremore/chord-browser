/**
 * The corpus suite's script in each page (corpus.spec.ts bundles it as the agent is built,
 * src/passwords/build.ts): the agent's own scan and classifier, run in Chromium on a corpus
 * file or one of Chord's fixtures, with each field's label from the file.
 */
import { classifyPasswordForm, type PasswordFieldRole, type PasswordFormKind, type PasswordFormRecord } from '@chord/core';
import { scanDocument } from '../../src/passwords/agent/scan';

/** One field as the suite scores it. */
export interface PageField {
  /** Its index among the page's `[data-manual-scoring]` fields, or -1. */
  readonly index: number;
  /** DuckDuckGo's `data-manual-scoring`, or null. */
  readonly label: string | null;
  /** Chord's fixtures' `data-chord-expect`: the role it must get (`none` for none), or null. */
  readonly expect: string | null;
  readonly field: string;
  readonly role: PasswordFieldRole | null;
}

export interface PageResult {
  readonly fields: PageField[];
  /** Labelled fields the scan didn't take. */
  readonly missing: { index: number; label: string }[];
  /** Each form's kind, where it has a credential. */
  readonly kinds: (PasswordFormKind | null)[];
  /** The scan's records, with each field's label: for tuning the classifier in Node. */
  readonly records: (PasswordFormRecord & { labels: (string | null)[] })[];
}

function scan(): PageResult {
  const labelled = [...document.querySelectorAll('[data-manual-scoring]')];
  const forms = scanDocument(document);
  const seen = new Set<Element>();
  const fields: PageField[] = [];
  const kinds: (PasswordFormKind | null)[] = [];
  const records: PageResult['records'] = [];
  for (const form of forms) {
    const classified = classifyPasswordForm(form.record, 'filling');
    kinds.push(classified?.kind ?? null);
    form.elements.forEach((el, i) => {
      const rec = form.record.fields[i]!;
      seen.add(el);
      fields.push({
        index: labelled.indexOf(el),
        label: el.getAttribute('data-manual-scoring'),
        expect: el.getAttribute('data-chord-expect'),
        field: `${rec.type}#${rec.id || '-'}[${rec.name || '-'}]`,
        role: classified?.roles.get(rec.key) ?? null,
      });
    });
    records.push({ ...form.record, labels: form.elements.map((el) => el.getAttribute('data-manual-scoring')) });
  }
  const missing = labelled.flatMap((el, index) => (seen.has(el) ? [] : [{ index, label: el.getAttribute('data-manual-scoring') ?? '' }]));
  return { fields, missing, kinds, records };
}

(globalThis as unknown as { chordFormsScan: typeof scan }).chordFormsScan = scan;
