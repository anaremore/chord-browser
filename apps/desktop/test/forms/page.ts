/**
 * The corpus suite's script in each page (corpus.spec.ts bundles it as the agent is built,
 * src/passwords/build.ts): the agent's own scan and classifier, run in Chromium on a corpus
 * file or one of Chord's fixtures, with each field's label from the file.
 */
import { classifyPasswordForm, type PasswordFieldRole, type PasswordFormKind, type PasswordFormRecord } from '@chord/core';
import { scanDocument, submittedBy } from '../../src/passwords/agent/scan';

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

/** What the click listener would take as a submit signal on a page, against DuckDuckGo's `data-manual-submit` labels. */
export interface SubmitSignals {
  /** Elements a person could click: buttons, links, and short-worded elements with no field inside. */
  readonly candidates: number;
  /** Labelled submit buttons. */
  readonly labelled: number;
  /** Labelled submit buttons a click on (or inside) counts as a credential form's submit. */
  readonly found: number;
  /** Clicks counted as a submit on an element neither labelled nor around or inside a labelled one. */
  readonly falseSignals: number;
  /** The false ones, for tuning: `tag "words"`. */
  readonly examples: string[];
}

const CLICKABLE = 'button, input[type=submit], input[type=button], input[type=image], [role=button], a';

function submitSignals(): SubmitSignals {
  const forms = scanDocument(document).map((scanned) => ({ scanned, classified: classifyPasswordForm(scanned.record, 'filling') }));
  const credential = forms.filter((f) => f.classified);
  const anchorOf = (f: (typeof forms)[number]) => {
    const password = f.scanned.elements.find((e) => e instanceof HTMLInputElement && e.type === 'password') ?? null;
    if (password || f.classified?.kind !== 'username-only' || !f.classified.username) return password;
    const i = f.scanned.record.fields.findIndex((x) => x.key === f.classified!.username!.key);
    return f.scanned.elements[i] ?? null;
  };
  const labelled = [...document.querySelectorAll('[data-manual-submit]')];
  const found = new Set<Element>();
  let candidates = 0;
  let falseSignals = 0;
  const examples: string[] = [];
  if (!credential.length) return { candidates: 0, labelled: labelled.length, found: 0, falseSignals: 0, examples };
  for (const el of document.body.querySelectorAll('*')) {
    if (el.matches('input:not([type=submit]):not([type=button]):not([type=image]), select, textarea, script, style, option')) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const clickable = el.matches(CLICKABLE) || (el.childElementCount <= 2 && text.length > 0 && text.length <= 40 && !el.querySelector('input, select, textarea'));
    if (!clickable) continue;
    candidates++;
    const k = submittedBy(el, forms, anchorOf);
    if (!k || !k.classified) continue;
    const label = el.closest('[data-manual-submit]') ?? el.querySelector('[data-manual-submit]');
    if (label) found.add(label);
    else {
      falseSignals++;
      examples.push(`${el.tagName.toLowerCase()} "${text.slice(0, 40)}"`);
    }
  }
  return { candidates, labelled: labelled.length, found: found.size, falseSignals, examples };
}

(globalThis as unknown as { chordSubmitSignals: typeof submitSignals }).chordSubmitSignals = submitSignals;
