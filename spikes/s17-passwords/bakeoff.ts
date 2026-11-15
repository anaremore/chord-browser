// Spike S17 M0, question 4: the bake-off. Scores, field by field over DuckDuckGo's labelled
// corpus, (a) the Chromium port alone, (b) the port with S17 §4's additions (chord-detector.ts)
// and (c) DuckDuckGo's own classifier as its own harness ran it (ddg-run.mjs). Pure Node, over
// the records corpus-extract.mjs took from Chromium; prints tables and writes results/bakeoff.json.
//
//   node spikes/s17-passwords/bakeoff.ts [--examples 4]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, type Role } from './chord-detector.ts';
import type { FieldRecord } from './chromium/form-parser.ts';

const here = import.meta.dirname;
const records = JSON.parse(readFileSync(join(here, 'results', 'corpus', 'corpus-records.json'), 'utf8'));
const ddg = new Map<string, { scores: DdgScore[]; unlabelled: DdgScore[] }>(JSON.parse(readFileSync(join(here, 'results', 'ddg', 'ddg-scores.json'), 'utf8')).map((f: { html: string }) => [f.html, f]));
const EXAMPLES = Number(process.argv.includes('--examples') ? process.argv[process.argv.indexOf('--examples') + 1] : 4);

interface DdgScore {
  manualType?: string;
  manualVariant?: string | null;
  inferredType: string | null;
  inferredVariant: string | null;
  id: string;
  name: string;
}
interface Rec extends FieldRecord {
  manual: string | null;
  manualIndex: number;
}
type Truth = 'username' | 'current' | 'new' | 'password' | 'email' | 'none';
type Pred = Role;

const truthOf = (manual: string): Truth => {
  if (manual === 'username' || manual === 'username OR emailAddress') return 'username';
  if (manual === 'password.current') return 'current';
  if (manual === 'password.new') return 'new';
  if (manual === 'password') return 'password';
  if (manual === 'emailAddress') return 'email';
  return 'none';
};
const formType = (html: string) =>
  /change-password|password-reset|_password\b|new-password|reset/.test(html) ? 'change/reset' : /login|signin|sign-in/.test(html) ? 'login' : /signup|register|sign-up|join/.test(html) ? 'signup' : /checkout|payment|card|payout|refund|billing/.test(html) ? 'payment' : 'other';
// A plain "password" label has no variant; the file's form type implies one.
const implied = (t: Truth, type: string): Truth => (t !== 'password' ? t : type === 'login' ? 'current' : type === 'signup' || type === 'change/reset' ? 'new' : 'password');
const ddgPred = (s: DdgScore): Pred => (s.inferredType === 'username' ? 'username' : s.inferredType === 'password' ? (s.inferredVariant === 'new' ? 'new' : 'current') : null);

interface Row {
  file: string;
  type: string;
  truth: Truth;
  label: string;
  field: string;
  pred: Record<'chromium' | 'chord' | 'ddg', Pred>;
  rec: Rec | null;
  formHasPassword: boolean;
}
const rows: Row[] = [];
const unlabelled: Record<string, number> = { chromium: 0, chord: 0, ddg: 0 };
const unlabelledExamples: Record<string, string[]> = { chromium: [], chord: [], ddg: [] };
const kinds: Record<string, Record<string, number>> = {};
let missingDdg = 0;
for (const file of records.files) {
  const type = formType(file.html);
  const d = ddg.get(file.html);
  const preds = { chromium: new Map<Rec, Pred>(), chord: new Map<Rec, Pred>() };
  const formOf = new Map<Rec, Rec[]>();
  for (const form of file.forms) {
    for (const system of ['chromium', 'chord'] as const) {
      const { roles, kind } = classify(form.fields, form.words, system === 'chord');
      for (const [f, r] of roles) preds[system].set(f as Rec, r);
      if (system === 'chord' && form.fields.some((f: Rec) => f.type === 'password')) ((kinds[type] ??= {})[kind] = (kinds[type][kind] ?? 0) + 1);
    }
    for (const f of form.fields) formOf.set(f, form.fields);
  }
  const all: Rec[] = file.forms.flatMap((g: { fields: Rec[] }) => g.fields);
  const byIndex = new Map(all.filter((f) => f.manualIndex >= 0).map((f) => [f.manualIndex, f]));
  const labelled = d?.scores ?? [];
  if (!d) missingDdg++;
  labelled.forEach((s, i) => {
    const rec = byIndex.get(i) ?? null;
    const label = s.manualType + (s.manualVariant ? `.${s.manualVariant}` : '');
    rows.push({
      file: file.html,
      type,
      truth: truthOf(label),
      label,
      field: rec ? `${rec.type}#${rec.id || '-'}[${rec.name || '-'}]` : `#${s.id || '-'}[${s.name || '-'}]`,
      pred: { chromium: rec ? (preds.chromium.get(rec) ?? null) : null, chord: rec ? (preds.chord.get(rec) ?? null) : null, ddg: ddgPred(s) },
      rec,
      formHasPassword: rec ? (formOf.get(rec) ?? []).some((f) => f.type === 'password') : false,
    });
  });
  // Fields without a label that a system gave a credential role: likely false positives (DuckDuckGo leaves out
  // fields that "should be unknown"), counted apart.
  for (const system of ['chromium', 'chord'] as const) {
    for (const [f, r] of preds[system]) {
      if (r && f.manualIndex < 0) {
        unlabelled[system]++;
        if (unlabelledExamples[system].length < EXAMPLES) unlabelledExamples[system].push(`${file.html} ${f.type}#${f.id}[${f.name}] as ${r}`);
      }
    }
  }
  for (const s of d?.unlabelled ?? []) {
    const r = ddgPred(s);
    if (r) {
      unlabelled.ddg++;
      if (unlabelledExamples.ddg.length < EXAMPLES) unlabelledExamples.ddg.push(`${file.html} #${s.id}[${s.name}] as ${r}`);
    }
  }
}

// ----- Precision and recall -----
const SYSTEMS = ['chromium', 'chord', 'ddg'] as const;
type Sys = (typeof SYSTEMS)[number];
const isPw = (x: string | null) => x === 'current' || x === 'new' || x === 'password';
const pr = (subset: Row[], sys: Sys, role: 'username' | 'password' | 'current' | 'new', variant: 'explicit' | 'implied') => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of subset) {
    const t = variant === 'implied' ? implied(r.truth, r.type) : r.truth;
    const p = r.pred[sys];
    if (role === 'username') {
      if (t === 'email') continue; // an email field: a username where there's a password to save with it, else nothing; not scored
      if (p === 'username' && t === 'username') tp++;
      else if (p === 'username') fp++;
      else if (t === 'username') fn++;
    } else if (role === 'password') {
      if (isPw(p) && isPw(t)) tp++;
      else if (isPw(p)) fp++;
      else if (isPw(t)) fn++;
    } else {
      if (t === 'password') continue; // no variant known
      if (p === role && t === role) tp++;
      else if (p === role) fp++;
      else if (t === role) fn++;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return { tp, fp, fn, precision, recall, f1: precision && recall ? (2 * precision * recall) / (precision + recall) : null };
};
const pct = (x: number | null) => (x == null ? '   –  ' : `${(x * 100).toFixed(1).padStart(5)}%`);
const table: Record<string, unknown> = {};
const print = (title: string, subset: Row[], variant: 'explicit' | 'implied') => {
  console.log(`\n${title} (${subset.length} labelled fields)`);
  console.log(`${'role'.padEnd(10)}${SYSTEMS.map((s) => `${s.padStart(10)} P      R     `).join('')}`);
  const block: Record<string, unknown> = {};
  for (const role of ['username', 'password', 'current', 'new'] as const) {
    const cells = SYSTEMS.map((s) => pr(subset, s, role, variant));
    block[role] = Object.fromEntries(SYSTEMS.map((s, i) => [s, cells[i]]));
    console.log(`${role.padEnd(10)}${cells.map((c) => `   ${pct(c.precision)} ${pct(c.recall)} `).join('')}   (n=${cells[0].tp + cells[0].fn})`);
  }
  table[`${title} · ${variant}`] = block;
};
print('All forms, variants as labelled', rows, 'explicit');
print('All forms, plain "password" given the variant its file type implies', rows, 'implied');
for (const type of ['login', 'signup', 'change/reset', 'payment', 'other']) print(`Form type: ${type}`, rows.filter((r) => r.type === type), 'implied');

// ----- Forms entirely right: every credential field right (variant implied), and no credential role on another field -----
const formsRight: Record<string, Record<Sys, [number, number]>> = {};
const files = new Map<string, Row[]>();
for (const r of rows) files.set(r.file, [...(files.get(r.file) ?? []), r]);
for (const [, list] of files) {
  const type = list[0].type;
  if (!list.some((r) => r.truth !== 'none' && r.truth !== 'email')) continue;
  for (const s of SYSTEMS) {
    const ok = list.every((r) => {
      const t = implied(r.truth, r.type);
      const p = r.pred[s];
      if (t === 'email') return p !== 'current' && p !== 'new';
      if (t === 'none') return !p;
      if (t === 'password') return isPw(p);
      return p === t;
    });
    for (const k of [type, 'all']) {
      const cell = ((formsRight[k] ??= {} as Record<Sys, [number, number]>)[s] ??= [0, 0]);
      cell[0] += ok ? 1 : 0;
      cell[1]++;
    }
  }
}
console.log('\nFiles with credential fields where every labelled field is right (variant implied)');
for (const [k, v] of Object.entries(formsRight)) console.log(`${k.padEnd(14)}${SYSTEMS.map((s) => `${s} ${v[s][0]}/${v[s][1]} (${((v[s][0] / v[s][1]) * 100).toFixed(1)}%)`).join('   ')}`);

// ----- Failures, by category, with examples -----
const category = (r: Row, sys: Sys): string | null => {
  const t = implied(r.truth, r.type);
  const p = r.pred[sys];
  const rec = r.rec;
  if (t === 'username' && p !== 'username') {
    if (isPw(p)) return 'username taken as a password';
    if (!r.formHasPassword) return 'username missed: no password in its form (username-first step, or a sign-up step)';
    if (rec && !rec.focusable) return 'username missed: field not focusable';
    return 'username missed: another field chosen, or none';
  }
  if (isPw(t) && !isPw(p)) {
    if (rec && rec.type !== 'password') return `password missed: labelled field is type=${rec.type}`;
    if (p === 'username') return 'password taken as the username';
    return 'password missed: type=password field not chosen (read-only, filtered, or a 4th+)';
  }
  if ((t === 'current' || t === 'new') && isPw(p) && p !== t) return `password variant wrong: ${t} taken as ${p}`;
  if ((t === 'none' || t === 'email') && p) {
    if (t === 'email' && p === 'username') return null; // not scored
    return `${r.label} given ${p}`;
  }
  return null;
};
const failures: Record<string, Record<string, { count: number; examples: string[] }>> = {};
for (const s of SYSTEMS) {
  const cats: Record<string, { count: number; examples: string[] }> = {};
  for (const r of rows) {
    const c = category(r, s);
    if (!c) continue;
    const key = /given (username|current|new)$/.test(c) ? `non-credential field given a credential role (${c.split(' given ')[1]})` : c;
    const cell = (cats[key] ??= { count: 0, examples: [] });
    cell.count++;
    if (cell.examples.length < EXAMPLES) cell.examples.push(`${r.file} ${r.field} (${r.label})`);
  }
  failures[s] = Object.fromEntries(Object.entries(cats).sort((a, b) => b[1].count - a[1].count));
  console.log(`\nFailures, ${s}`);
  for (const [k, v] of Object.entries(failures[s]).slice(0, 10)) console.log(`  ${String(v.count).padStart(4)}  ${k}\n        e.g. ${v.examples.slice(0, 2).join('; ')}`);
}
const emailAsUsername = Object.fromEntries(SYSTEMS.map((s) => [s, { withPassword: rows.filter((r) => r.truth === 'email' && r.pred[s] === 'username' && r.formHasPassword).length, withoutPassword: rows.filter((r) => r.truth === 'email' && r.pred[s] === 'username' && !r.formHasPassword).length, of: rows.filter((r) => r.truth === 'email').length }]));
console.log('\nemailAddress fields taken as username (not scored):', JSON.stringify(emailAsUsername));
console.log('Unlabelled fields given a credential role:', JSON.stringify(unlabelled), unlabelledExamples);
console.log('Chord form kinds found, by file type (forms with a password field):', JSON.stringify(kinds));
const unmatched = rows.filter((r) => !r.rec).length;
console.log(`Labelled fields: ${rows.length}; not found by the scan (counted as no role for chromium/chord): ${unmatched}; files without DuckDuckGo scores: ${missingDdg}`);
writeFileSync(join(here, 'results', 'bakeoff.json'), JSON.stringify({ chromium: records.chromium, table, formsRight, failures, emailAsUsername, unlabelled, unlabelledExamples, kinds, unmatched }, null, 2));

// ----- The two halves of the corpus apart (alternate files of DuckDuckGo's index), since Chord's additions
// were written looking at failures from all of it. Far apart halves would mean they fit the examples read.
const order = new Map<string, number>(records.files.map((f: { html: string }, i: number) => [f.html, i]));
const halves: Record<string, unknown> = {};
for (const half of [0, 1]) {
  const subset = rows.filter((r) => (order.get(r.file) ?? 0) % 2 === half);
  console.log(`\nHalf ${half + 1} of the corpus (variant implied), F1`);
  const block: Record<string, Record<string, number | null>> = {};
  for (const role of ['username', 'password', 'current', 'new'] as const) {
    block[role] = Object.fromEntries(SYSTEMS.map((s) => [s, pr(subset, s, role, 'implied').f1]));
    console.log(`  ${role.padEnd(10)}${SYSTEMS.map((s) => `${s} ${pct(block[role][s])}`).join('   ')}`);
  }
  halves[`half${half + 1}`] = block;
}
writeFileSync(join(here, 'results', 'bakeoff-halves.json'), JSON.stringify(halves, null, 2));
