/**
 * The sign-in sweep (scripts/dev/signin-sweep/README.md): not a test suite. Each "test" is one site
 * of `$CHORD_E2E_SHARE/sites.txt`; its result goes to `$CHORD_E2E_SHARE/results/<host>.json`, and a
 * site with a result already is skipped (delete results/ to start again).
 *
 * For each site, in a window of its own with an in-memory session, Chord's agent in isolated
 * world 4440 (probe.ts, with a fake bridge):
 * 1. the page, loaded with no credentials; on a home page with no sign-in field, its "Sign in"
 *    link followed once;
 * 2. the form waited for; the agent's scan and `classifyPasswordForm(…, 'filling')` recorded,
 *    beside the probe's own look at the fields a person can see;
 * 3. each such field focused, and what the agent's `focus` says;
 * 4. the agent's fill, as main sends it, with a fake account, and where the values went;
 * 5. on a first step (an email and Next), Next pressed once, unless the page reads as sending a
 *    code or a link, and 2 to 4 again on the step that follows. Nothing else is ever pressed,
 *    and nothing submitted.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';
import type { ProbeField, ProbeSnapshot } from './probe';

const SHARE = process.env['CHORD_E2E_SHARE'] ?? process.env['CHORD_SWEEP_DIR'] ?? '';
const sites = SHARE && existsSync(join(SHARE, 'sites.txt')) ? [...new Set(readFileSync(join(SHARE, 'sites.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)))] : [];
const RESULTS = join(SHARE, 'results');
const SHOTS = join(SHARE, 'shots');

export const FAKE = { username: 'sweep.nobody@example.com', password: 'Sweep-not-a-real-password-7' };
/** Main's own rule (assist.ts): the menu opens for these kinds and roles. */
const MENU_KINDS = new Set(['sign-in', 'username-only', 'unknown']);
const MENU_ROLES = new Set(['username', 'current-password']);
/** A page that would send a code or a link when Next is pressed: Next isn't pressed there. */
const SENDS_CODE =
  /\b(send|email|text|sms) (me )?(a |an |the )?(one-time |sign-in |login |log-in |verification |security |magic )?(code|link|otp)\b|magic link|sign-in link|login link|passwordless|we('ll| will) (send|email|text) (you )?(a |an )?(code|link)|code (by|via) (email|sms|text)/i;
const SIGN_IN_WORDS = /\b(sign ?in|log ?in|login|signin|log on|sign on)\b|anmelden|connexion|iniciar sesi|entrar|accedi|inloggen|zaloguj|войти|вход|ログイン|登录|로그인/i;
const SIGN_UP_WORDS = /\b(sign ?up|register|create (an |your )?account|join|get started)\b|registrieren|inscri|regist|зарегистр|注册|新規/i;
const BOT_WALL = /just a moment|attention required|access denied|verify (that )?you are (a )?human|are you a robot|unusual traffic|checking your browser|pardon our interruption|request unsuccessful|enable javascript and cookies|captcha|blocked|security check|forbidden/i;

type Message = [string, Record<string, unknown>];

interface FocusReport {
  field: string;
  looks: string;
  role: string | null;
  focus: { kind: string; role: string } | 'none' | 'blur' | 'not-focusable';
}
interface StepReport {
  url: string;
  title: string;
  forms: ProbeSnapshot['forms'];
  fields: Omit<ProbeField, 'label'>[];
  focus: FocusReport[];
  fill?: { formId: string; kind: string; withPassword: boolean; filled: Record<string, unknown> | null; usernameIn: string[]; passwordIn: string[] };
}
export interface SiteResult {
  url: string;
  host: string;
  at: string;
  outcome: 'ok' | 'problem' | 'unreachable';
  /** Problems found, each "pattern: detail". Later-phase ones start with "later:". */
  problems: string[];
  /** Why it couldn't be swept, for unreachable. */
  why?: string;
  notes: string[];
  status?: number;
  followed?: string;
  next?: 'pressed' | 'skipped (sends a code or link)' | 'no button';
  frames?: { src: string; passwords: number; usernames: number }[];
  steps: StepReport[];
  ms: number;
}

const test = base.extend<object, { app: ElectronApplication }>({
  app: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
    async ({}, use) => {
      const code = await bundleAgent({ entry: join(import.meta.dirname, 'probe.ts'), minify: false });
      // A profile of its own per worker (in the container's temp, gone with it): Chromium locks its profile.
      const profile = mkdtempSync(join(tmpdir(), 'chord-sweep-'));
      const env = { ...process.env } as Record<string, string>;
      delete env['ELECTRON_RUN_AS_NODE'];
      const app = await electron.launch({ args: [join(import.meta.dirname, 'main.mjs'), `--user-data-dir=${profile}`], env, chromiumSandbox: true, timeout: 60_000 });
      await app.evaluate((_e, c) => void ((globalThis as unknown as { sweepCode: string }).sweepCode = c), code);
      await use(app);
      await app.close().catch(() => {});
    },
    { scope: 'worker' },
  ],
});
test.describe.configure({ mode: 'parallel' });
if (SHARE) {
  mkdirSync(RESULTS, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
}

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');
const timeout = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);

/** An expression run in world 4440 of window `id`'s main frame. */
async function world<T>(app: ElectronApplication, id: number, expression: string): Promise<T | null> {
  const run = app
    .evaluate(
      async ({ BrowserWindow }, { id, expression }) => {
        const w = BrowserWindow.fromId(id);
        if (!w || w.isDestroyed()) return null;
        return w.webContents.executeJavaScriptInIsolatedWorld(4440, [{ code: expression }]);
      },
      { id, expression },
    )
    .catch(() => null) as Promise<T | null>;
  return timeout(run, 10_000, null);
}

/** The probe and the agent in the page's current document (a navigation leaves a new, empty world). */
async function ensureAgent(app: ElectronApplication, id: number): Promise<boolean> {
  if ((await world<string>(app, id, 'typeof chordSweep')) === 'object') return true;
  await app
    .evaluate(async ({ BrowserWindow }, id) => {
      const w = BrowserWindow.fromId(id);
      if (!w || w.isDestroyed()) return;
      await w.webContents.executeJavaScriptInIsolatedWorld(4440, [{ code: (globalThis as unknown as { sweepCode: string }).sweepCode }]);
    }, id)
    .catch(() => {});
  return (await world(app, id, 'chordSweep.start(), true')) === true;
}

async function settle(page: Page, ms = 1500) {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

const isSignInField = (f: ProbeField) => f.visible && (f.looks === 'password' || f.looks === 'username');
const signInFields = (s: ProbeSnapshot | null) => (s ? s.fields.filter((f) => isSignInField(f) && !f.inShadow) : []);

/** The page as the probe sees it, waiting up to `ms` for a sign-in field to show. */
async function look(app: ElectronApplication, id: number, ms: number): Promise<ProbeSnapshot | null> {
  const until = Date.now() + ms;
  for (;;) {
    await ensureAgent(app, id);
    const snap = await world<ProbeSnapshot>(app, id, 'chordSweep.snapshot()');
    if ((snap && signInFields(snap).length) || Date.now() > until) return snap;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const describeField = (f: ProbeField) => `${f.type}#${f.id || '-'}[${f.name || '-'}]${f.autocomplete ? `{${f.autocomplete}}` : ''}`;

/** Steps 2 to 4 on the page as it is: the snapshot, focus on each field a person would use, and the fill. */
async function sweepStep(app: ElectronApplication, id: number, page: Page, snap: ProbeSnapshot, problems: string[], prefix: string): Promise<StepReport> {
  const step: StepReport = { url: snap.url, title: snap.title, forms: snap.forms, fields: snap.fields.map(({ label: _l, ...f }) => f), focus: [] };
  const visible = signInFields(snap);
  const passwords = visible.filter((f) => f.looks === 'password');
  const usernames = visible.filter((f) => f.looks === 'username');
  const kindOf = (f: ProbeField) => (f.form >= 0 ? (snap.forms[f.form]?.kind ?? null) : null);

  // What the classifier made of the fields a person sees.
  for (const f of passwords) if (!f.role) problems.push(`${prefix}visible password field has no role: ${describeField(f)} (form ${kindOf(f) ?? 'not a credential form'})`);
  const visibleUsernameRole = visible.some((f) => f.role === 'username');
  if (passwords.length && passwords.some((f) => f.role) && !visibleUsernameRole && usernames.length) {
    const sameForm = usernames.filter((u) => passwords.some((p) => p.form === u.form && p.role));
    if (sameForm.length) problems.push(`${prefix}username not found beside the password: ${sameForm.map(describeField).join(', ')}`);
  }
  if (!passwords.length && usernames.length && !visibleUsernameRole) problems.push(`${prefix}first step not recognised: ${usernames.map(describeField).join(', ')} (form ${usernames.map(kindOf).join('/')})`);
  for (const f of snap.fields)
    if (f.role && !f.visible && !f.focusable && visible.some((v) => !v.role && (f.role === 'username' ? v.looks === 'username' : v.looks === 'password')))
      problems.push(`${prefix}hidden field took a role a visible one has not: ${f.role} on ${describeField(f)}`);
  // A form whose own words say sign in, and nothing of signing up, that the classifier put elsewhere (no menu). With a
  // fake email, a two-step sign-in's next step is often a sign-up, rightly classed so.
  const flagged = new Set<number>();
  for (const f of visible)
    if (f.role && f.form >= 0 && !flagged.has(f.form)) {
      const form = snap.forms[f.form]!;
      const words = [...form.words.submits, ...form.words.headings, form.words.title].join(' ');
      if (form.kind && !MENU_KINDS.has(form.kind) && SIGN_IN_WORDS.test(words) && !SIGN_UP_WORDS.test(words)) {
        flagged.add(f.form);
        problems.push(`${prefix}sign-in form classed ${form.kind}: ${visible.filter((v) => v.form === f.form && v.role).map((v) => `${describeField(v)} as ${v.role}`).join(', ')}`);
      }
    }

  // Focus on each, as a click would give it.
  let menu: { formId: string; kind: string; field: number } | null = null;
  for (const f of [...visible, ...snap.fields.filter((x) => x.role && !isSignInField(x) && x.visible)]) {
    // Blurred first: focus() on a field that has focus already (autofocus) fires nothing.
    await world(app, id, 'chordSweep.blur()');
    await page.waitForTimeout(150);
    await world(app, id, 'chordSweep.clear()');
    const focused = await world<boolean>(app, id, `chordSweep.focus(${f.i})`);
    await page.waitForTimeout(350);
    const msgs = (await world<Message[]>(app, id, 'chordSweep.messages()')) ?? [];
    const last = msgs.filter(([c]) => c === 'focus' || c === 'blur').at(-1);
    const report: FocusReport = {
      field: describeField(f),
      looks: f.looks,
      role: f.role,
      focus: !focused ? 'not-focusable' : !last ? 'none' : last[0] === 'blur' ? 'blur' : { kind: String(last[1]['kind']), role: String(last[1]['role']) },
    };
    step.focus.push(report);
    if (f.role && focused && typeof report.focus !== 'object') problems.push(`${prefix}focus reports nothing for a field with a role: ${describeField(f)} as ${f.role}`);
    if (typeof report.focus === 'object' && f.role && report.focus.role !== f.role) problems.push(`${prefix}focus reports ${report.focus.role}, the scan ${f.role}: ${describeField(f)}`);
    if (!menu && last?.[0] === 'focus' && MENU_KINDS.has(String(last[1]['kind'])) && MENU_ROLES.has(String(last[1]['role']))) menu = { formId: String(last[1]['formId']), kind: String(last[1]['kind']), field: f.i };
  }
  await world(app, id, 'chordSweep.blur()');
  if (!menu) {
    if (visible.some((f) => f.role === 'current-password')) problems.push(`${prefix}no field would open the menu`);
    return step;
  }

  // The fill, as main sends it (assist.ts): no password for a first step.
  const withPassword = menu.kind !== 'username-only';
  const payload = { formId: menu.formId, username: FAKE.username, ...(withPassword ? { password: FAKE.password } : {}), highlight: { color: 'Highlight', ms: 600, stagger: 60, easing: 'ease' } };
  // As in Chord: the fill comes from the menu under the field that has focus, so that field is on screen.
  await world(app, id, `chordSweep.focus(${menu.field})`);
  await page.waitForTimeout(250);
  await world(app, id, 'chordSweep.clear()');
  await world(app, id, `chordSweep.fill(${JSON.stringify(payload)})`);
  await page.waitForTimeout(400);
  const filled = ((await world<Message[]>(app, id, 'chordSweep.messages()')) ?? []).find(([c]) => c === 'filled')?.[1] ?? null;
  const holding = (await world<{ username: number[]; password: number[] }>(app, id, `chordSweep.holding(${JSON.stringify(FAKE.username)}, ${JSON.stringify(FAKE.password)})`)) ?? { username: [], password: [] };
  // The probe's fields are re-read on each snapshot; the indexes are the same document's, taken just before.
  const fieldAt = (i: number) => snap.fields[i];
  step.fill = {
    formId: menu.formId,
    kind: menu.kind,
    withPassword,
    filled,
    usernameIn: holding.username.map((i) => (fieldAt(i) ? `${describeField(fieldAt(i)!)}${fieldAt(i)!.visible ? '' : ' (hidden)'}` : `#${i}`)),
    passwordIn: holding.password.map((i) => (fieldAt(i) ? `${describeField(fieldAt(i)!)}${fieldAt(i)!.visible ? '' : ' (hidden)'}` : `#${i}`)),
  };
  if (!filled) problems.push(`${prefix}fill: no answer from the agent`);
  else if (filled['ok'] !== true) problems.push(`${prefix}fill refused (${String(filled['reason'] ?? '?')}) in a ${menu.kind} form`);
  else {
    const userField = visible.find((f) => f.role === 'username');
    const passField = visible.find((f) => f.role === 'current-password');
    if (holding.username.some((i) => fieldAt(i) && !fieldAt(i)!.visible)) problems.push(`${prefix}fill wrote the username into a hidden field`);
    if (userField && !holding.username.includes(userField.i)) problems.push(`${prefix}fill left the visible username field empty`);
    if (withPassword && passField && !holding.password.includes(passField.i)) problems.push(`${prefix}fill left the visible password field empty`);
    if (!withPassword && passwords.length) problems.push(`${prefix}fill sent no password to a form with a visible password field`);
  }
  return step;
}

async function sweepSite(app: ElectronApplication, url: string, index: number): Promise<SiteResult> {
  const started = Date.now();
  const r: SiteResult = { url, host: hostOf(url), at: new Date().toISOString(), outcome: 'ok', problems: [], notes: [], steps: [], ms: 0 };
  const unreachable = (why: string): SiteResult => {
    r.outcome = 'unreachable';
    r.why = why;
    return r;
  };
  const pageEvent = app.waitForEvent('window', { timeout: 30_000 });
  const id = await app.evaluate(({ BrowserWindow }, partition) => {
    const w = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { partition, sandbox: true, contextIsolation: true } });
    void w.loadURL('about:blank');
    return w.id;
  }, `sweep-${index}`);
  const page = await pageEvent;
  try {
    // 1. The page, and its sign-in.
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (response) r.status = response.status();
    } catch (e) {
      return unreachable(`load: ${String((e as Error).message).split('\n')[0]!.slice(0, 160)}`);
    }
    await settle(page);
    const home = await look(app, id, 6000);
    let snap = home;
    // A home page with no password field: its sign-in link, if it has one (an email box there is often a newsletter's or a sign-up's).
    if (!signInFields(home).some((f) => f.looks === 'password')) {
      const link = await world<{ href: string | null; x: number; y: number; text: string }>(app, id, 'chordSweep.signInLink()');
      // Where the page has fields already, only a link to another page: never a button beside them.
      if (link && (link.href || !signInFields(home).length)) {
        r.followed = `${link.text}${link.href ? ` → ${link.href.slice(0, 160)}` : ' (button)'}`;
        try {
          if (link.href) await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          else await page.mouse.click(link.x, link.y);
        } catch (e) {
          return unreachable(`load of the sign-in link: ${String((e as Error).message).split('\n')[0]!.slice(0, 160)}`);
        }
        await settle(page, 2500);
        snap = await look(app, id, 8000);
      }
    }
    if (!snap) return unreachable('the page never answered the probe');

    // Sign-in fields in frames: the agent reads the main frame only (phase 3 same-origin, phase 4 another site's).
    const main = new URL(snap.url).origin;
    r.frames = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const counts = await timeout(
        frame
          .evaluate(() => {
            const shown = (el: Element) => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) !== false && el.getBoundingClientRect().width >= 4;
            const inputs = [...document.querySelectorAll('input')].filter(shown);
            return {
              passwords: inputs.filter((i) => i.type === 'password').length,
              usernames: inputs.filter((i) => /email|tel/.test(i.type) || /user|email|login|phone/i.test(`${i.name} ${i.id} ${i.autocomplete}`)).length,
            };
          })
          .catch(() => null),
        5000,
        null,
      );
      if (counts && (counts.passwords || counts.usernames)) r.frames.push({ src: frame.url().slice(0, 160), ...counts });
    }
    const fields = signInFields(snap);
    const framed = r.frames.filter((f) => f.passwords || f.usernames);
    if (!fields.length) {
      if (framed.length) {
        const cross = framed.some((f) => {
          try {
            return new URL(f.src).origin !== main;
          } catch {
            return true;
          }
        });
        r.problems.push(cross ? 'later: sign-in in another site’s frame (phase 4)' : 'later: sign-in in a same-origin frame (phase 3)');
      } else if (snap.fields.some((f) => f.inShadow && f.visible && (f.looks === 'password' || f.looks === 'username'))) {
        r.problems.push('later: sign-in fields in an open shadow root (phase 3)');
      } else if (BOT_WALL.test(`${snap.title} ${snap.text.slice(0, 600)}`)) return unreachable(`bot wall or captcha (“${snap.title.slice(0, 60)}”)`);
      else if (r.status && r.status >= 400) return unreachable(`HTTP ${r.status}`);
      else if (/continue with (google|apple|facebook)|sign in with (google|apple|facebook)/i.test(snap.text)) return unreachable('no sign-in form: other sites’ sign-in buttons only');
      else return unreachable(r.followed ? 'no sign-in form after the sign-in link' : 'no sign-in link or form found');
      r.outcome = 'problem';
      return r;
    }
    if (snap.url.startsWith('http:')) r.problems.push('later: sign-in on plain http (phase 3)');

    // 2–4 on this page.
    const first = await sweepStep(app, id, page, snap, r.problems, '');
    r.steps.push(first);

    // 5. A first step: Next once, unless the page would send a code or a link.
    const firstStep = first.fill?.kind === 'username-only' && first.fill.filled?.['ok'] === true;
    if (firstStep) {
      const userField = snap.fields.find((f) => f.visible && f.role === 'username');
      const button = userField ? await world<{ x: number; y: number; text: string }>(app, id, `chordSweep.nextButton(${userField.i})`) : null;
      if (SENDS_CODE.test(snap.text)) r.next = 'skipped (sends a code or link)';
      else if (!button) r.next = 'no button';
      else {
        r.next = 'pressed';
        r.notes.push(`pressed “${button.text.slice(0, 30)}” once`);
        await page.mouse.click(button.x, button.y).catch(() => {});
        await settle(page, 3000);
        const second = await look(app, id, 6000);
        const pw = second ? signInFields(second).filter((f) => f.looks === 'password') : [];
        if (second && pw.length) r.steps.push(await sweepStep(app, id, page, second, r.problems, 'step 2: '));
        else if (second) r.notes.push(`after Next: no password field (${second.title.slice(0, 60)})`);
      }
    }
    await page.screenshot({ path: join(SHOTS, `${r.host}.jpg`), type: 'jpeg', quality: 45 }).catch(() => {});
    r.outcome = r.problems.length ? 'problem' : 'ok';
    return r;
  } catch (e) {
    r.notes.push(`error: ${String((e as Error).message).split('\n')[0]!.slice(0, 200)}`);
    if (!r.steps.length) return unreachable('the sweep failed on this page');
    r.outcome = r.problems.length ? 'problem' : 'ok';
    return r;
  } finally {
    r.ms = Date.now() - started;
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id).catch(() => {});
  }
}

test.setTimeout(180_000);
sites.forEach((url, index) => {
  test(url, async ({ app }) => {
    const file = join(RESULTS, `${hostOf(url)}.json`);
    if (existsSync(file)) return;
    const budget = new Promise<SiteResult>((done) =>
      setTimeout(() => done({ url, host: hostOf(url), at: new Date().toISOString(), outcome: 'unreachable', why: 'timed out (150 s)', problems: [], notes: [], steps: [], ms: 150_000 }), 150_000),
    );
    const result = await Promise.race([sweepSite(app, url, index), budget]);
    writeFileSync(file, JSON.stringify(result, null, 1));
  });
});
