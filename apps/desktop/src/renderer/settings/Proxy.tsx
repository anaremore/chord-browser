/**
 * Settings → Privacy → Proxy (DESIGN.md §9, *Proxies*; ARCHITECTURE.md §9):
 * the proxy for every chord, and each chord's own.
 *
 * Choosing is two steps, the choice and then its button, which says what
 * happens: a change closes every connection open the old way, and a chord's
 * own proxy can sign it out, so arrowing through the choices never does
 * either. Host, port, addresses and the file's address are checked as you
 * type, in core's words. A chord that shares sign-ins is told before the
 * button what a proxy of its own means: its own sign-ins, so it's signed out.
 */
import {
  DEFAULT_PROFILE,
  proxyBypassProblem,
  proxyHostProblem,
  proxyLabel,
  proxyPacProblem,
  proxyPortProblem,
  sameProxy,
  splitProxyAddress,
  bypassRule,
  proxyHost,
  proxyPac,
  proxyPort,
  splitBypass,
  type ProxyMode,
  type ProxyScheme,
  type ProxySettings,
} from '@chord/core';
import type { ProxyStatus, SettingsSnapshot } from '@chord/ipc';
import { Check } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from './api';
import { RadioGroup, ResetButton, Row, Segmented } from './controls';
import local from './Proxy.module.css';
import { proxyAnnouncement, proxyFailingRows, rowStillUsesProxy, type ProxyFailingRow, type RowSeen } from './proxy-row';
import styles from './Settings.module.css';

type Chord = SettingsSnapshot['chords'][number];
/** What the editor offers: a mode, or (a chord's) the proxy for every chord. */
type Choice = ProxyMode | 'all';

/** Settings opened at a chord's proxy (the chord menu's "Its own…", the command bar); `n` counts the requests. */
export interface ProxyFocus {
  n: number;
  chordId: string | null;
}

const CHOICES: { value: ProxyMode; name: string; hint: string }[] = [
  { value: 'system', name: 'Use the system’s proxy', hint: 'Your computer’s network settings decide, as they do for other apps.' },
  { value: 'none', name: 'No proxy', hint: 'Pages connect to sites directly.' },
  { value: 'server', name: 'A proxy server', hint: 'HTTP, HTTPS or SOCKS5, at an address you give.' },
  { value: 'pac', name: 'An automatic configuration file', hint: 'A PAC file that picks the proxy for each address.' },
];

const SCHEMES: { value: ProxyScheme; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
];

const PORT_PLACEHOLDER: Record<ProxyScheme, string> = { http: '8080', https: '443', socks5: '1080' };

const SCHEME_NOTE: Record<ProxyScheme, string> = {
  http: 'If the proxy asks for a password, Chord asks you over the page and forgets it when you quit.',
  https: 'Chord connects to the proxy over TLS. If it asks for a password, Chord asks you over the page and forgets it when you quit.',
  socks5: 'The proxy looks up sites’ names too, so they don’t go to your network’s DNS. Chord can’t sign in to a SOCKS5 proxy that needs a password.',
};

/** What the button does, in words. */
function applyLabel(choice: Choice): string {
  if (choice === 'all') return 'Use the proxy for all chords';
  if (choice === 'system') return 'Use the system’s proxy';
  if (choice === 'none') return 'Connect directly';
  return 'Use this proxy';
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** One field: a label, its control, and what's wrong with what's in it, read with the control. */
function Field({ label, problem, problemId, note, children }: { label: string; problem: string | null; problemId: string; note?: string; children: ReactNode }) {
  return (
    <div className={local.field}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={local.controls}>{children}</div>
      {problem ? (
        <span id={problemId} className={local.problem} role="alert">
          {problem}
        </span>
      ) : (
        note && <span className={styles.rowDescription}>{note}</span>
      )}
    </div>
  );
}

/**
 * The choices and, for a server or a file, their fields; the button once
 * what's chosen differs from what's in use. `chord`: a chord's own, with the
 * proxy for every chord as its first choice.
 */
function ProxyEditor({ value, all, chord }: { value: ProxySettings | null; all: ProxySettings; chord?: Chord }) {
  const ids = useId();
  const current: Choice = value ? value.mode : 'all';
  const [choice, setChoice] = useState<Choice>(current);
  const [scheme, setScheme] = useState<ProxyScheme>(value?.server?.scheme ?? 'http');
  const [host, setHost] = useState(value?.server?.host ?? '');
  const [port, setPort] = useState(value?.server ? String(value.server.port) : '');
  const [bypass, setBypass] = useState(value?.server?.bypass.join(', ') ?? '');
  const [pac, setPac] = useState(value?.pac ?? '');
  // Problems show once there's something to say about it: an empty field only when its choice needs it.
  const hostProblem = host.trim() ? proxyHostProblem(host) : null;
  const portProblem = port.trim() ? proxyPortProblem(port) : null;
  const bypassProblem = proxyBypassProblem(bypass);
  const pacProblem = pac.trim() ? proxyPacProblem(pac) : null;
  const typedHost = proxyHost(host);
  const typedPort = proxyPort(port);
  const typedPac = proxyPac(pac);
  const server = typedHost && typedPort && !bypassProblem ? { scheme, host: typedHost, port: typedPort, bypass: splitBypass(bypass).map((r) => bypassRule(r)!) } : null;
  // What the other modes keep for next time: what's typed if it can be used, else what was kept.
  const kept = { server: server ?? value?.server ?? null, pac: typedPac ?? value?.pac ?? null };
  /** What the button puts in place: null for the proxy for every chord; undefined while what's typed can't be used. */
  const next: ProxySettings | null | undefined =
    choice === 'all'
      ? null
      : choice === 'server'
        ? server
          ? { mode: 'server', server, pac: kept.pac }
          : undefined
        : choice === 'pac'
          ? typedPac
            ? { mode: 'pac', server: kept.server, pac: typedPac }
            : undefined
          : { mode: choice, ...kept };
  const usable = next !== undefined;
  const changed = choice !== current || (usable && !sameProxy(next, value));
  // A chord sharing sign-ins gets its own with any proxy of its own.
  const separates = Boolean(chord && chord.profileId === DEFAULT_PROFILE && choice !== 'all');
  const apply = () => {
    if (!usable || !changed) return;
    if (chord) void api.settings.chordProxy(chord.id, next ?? null);
    else if (next) void api.settings.set({ proxy: next });
  };
  // A whole address pasted or typed into the host's box (socks5://10.0.0.2:1080) goes to the fields it belongs in.
  const spreadHost = () => {
    const split = splitProxyAddress(host);
    if (!split || (!split.scheme && !split.port)) return;
    setHost(split.host);
    if (split.port) setPort(String(split.port));
    if (split.scheme) setScheme(split.scheme);
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    spreadHost();
    apply();
  };
  const label = chord ? `Proxy for ${chord.name}` : 'Proxy for every chord';
  const options: { value: Choice; name: string; hint: string }[] = chord ? [{ value: 'all', name: 'Same as all chords', hint: proxyLabel(all) }, ...CHOICES] : CHOICES;

  return (
    <>
      <RadioGroup className={local.choices} label={label}>
        <div className={local.radios} data-proxy-radios={chord?.id ?? 'all'}>
          {options.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={o.value === choice} className={styles.choice} onClick={() => setChoice(o.value)}>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>{o.name}</span>
                <span className={styles.rowDescription}>{o.hint}</span>
              </span>
              {o.value === current && <Check className={styles.check} size={16} strokeWidth={2.25} aria-label="In use" />}
            </button>
          ))}
        </div>
      </RadioGroup>
      {choice === 'server' && (
        <div className={local.form}>
          <Field label="Type" problem={null} problemId={`${ids}-type`} note={SCHEME_NOTE[scheme]}>
            <Segmented<ProxyScheme> label={`${label}: type`} value={scheme} options={SCHEMES} onChange={setScheme} />
          </Field>
          <Field label="Server" problem={hostProblem ?? portProblem} problemId={`${ids}-server`}>
            <input
              className={local.host}
              value={host}
              placeholder="proxy.example"
              aria-label={`${label}: address`}
              aria-invalid={Boolean(hostProblem) || undefined}
              aria-describedby={hostProblem ? `${ids}-server` : undefined}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setHost(e.target.value)}
              onBlur={spreadHost}
              onKeyDown={onEnter}
            />
            <span className={local.colon} aria-hidden>
              :
            </span>
            <input
              className={local.port}
              value={port}
              inputMode="numeric"
              placeholder={PORT_PLACEHOLDER[scheme]}
              aria-label={`${label}: port`}
              aria-invalid={Boolean(portProblem) || undefined}
              aria-describedby={portProblem && !hostProblem ? `${ids}-server` : undefined}
              onChange={(e) => setPort(e.target.value)}
              onKeyDown={onEnter}
            />
          </Field>
          <Field label="Don’t use it for" problem={bypassProblem} problemId={`${ids}-bypass`} note="Separate addresses with commas. <local> covers names without a dot, like intranet.">
            <input
              className={local.wide}
              value={bypass}
              placeholder="localhost, *.intranet.example, 10.0.0.0/8"
              aria-label={`${label}: addresses that don’t use it`}
              aria-invalid={Boolean(bypassProblem) || undefined}
              aria-describedby={bypassProblem ? `${ids}-bypass` : undefined}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setBypass(e.target.value)}
              onKeyDown={onEnter}
            />
          </Field>
        </div>
      )}
      {choice === 'pac' && (
        <div className={local.form}>
          <Field label="File address" problem={pacProblem} problemId={`${ids}-pac`} note="If Chord can’t load the file, pages wait until it can. They never go out without it.">
            <input
              className={local.wide}
              value={pac}
              placeholder="http://wpad.example/proxy.pac"
              aria-label={`${label}: configuration file address`}
              aria-invalid={Boolean(pacProblem) || undefined}
              aria-describedby={pacProblem ? `${ids}-pac` : undefined}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setPac(e.target.value)}
              onKeyDown={onEnter}
            />
          </Field>
        </div>
      )}
      {changed && (
        <div className={local.actions}>
          {separates && chord && (
            <p className={local.notice}>
              {chord.name} shares sign-ins with your other chords. A proxy of its own needs sign-ins of its own: {chord.name} will be signed out of every site, and its tabs will reload.
              Your other chords stay signed in.
            </p>
          )}
          {chord && choice === 'all' && chord.profileId !== DEFAULT_PROFILE && <p className={local.notice}>{chord.name} keeps its own sign-ins.</p>}
          <button type="button" className={local.primary} disabled={!usable} onClick={apply}>
            {separates ? `Keep sign-ins separate and ${lowerFirst(applyLabel(choice))}` : applyLabel(choice)}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A proxy that can't be set (#325): the warning row, with Try again. aria-disabled while it tries, never the native
 * disabled, which would drop the focus (as #316's ad-blocking row). `whose`: "every chord", or the chord's name, for
 * the button's name (Carbon's N2). `onGone(hadFocus)`: it's going, and whether its button had the focus (B1).
 */
function FailingRow({ row, whose, trying, onTry, onGone }: { row: ProxyFailingRow; whose: string; trying: boolean; onTry: () => void; onGone: (hadFocus: boolean) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const gone = useRef(onGone);
  useLayoutEffect(() => {
    gone.current = onGone;
  });
  // A layout effect's cleanup runs before the row leaves the page, so the focus is still on it to see.
  useLayoutEffect(() => {
    const el = button.current;
    return () => gone.current(el !== null && el === document.activeElement);
  }, []);
  const action = trying ? 'Trying…' : 'Try again';
  return (
    <Row
      tone="warning"
      label={row.label}
      description={row.description}
      control={
        <button
          ref={button}
          type="button"
          className={trying ? `${styles.linkButton} ${styles.trying}` : styles.linkButton}
          aria-disabled={trying || undefined}
          aria-label={`${action}, proxy for ${whose}`}
          onClick={() => !trying && onTry()}
        >
          {action}
        </button>
      }
    />
  );
}

/**
 * The proxies that can't be set, from main: asked every second while one shows, else every few (#325); and `refresh`,
 * to ask now (a try's answer, before its Trying… goes: Carbon's N1).
 */
function useProxyStatus(): { status: ProxyStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const failing = Boolean(status?.failing.length);
  const refresh = useCallback(
    () => api.settings.proxyStatus().then((next) => setStatus((now) => (JSON.stringify(now) === JSON.stringify(next) ? now : next))),
    [],
  );
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    tick();
    const timer = setInterval(tick, failing ? 1000 : 5000);
    return () => clearInterval(timer);
  }, [failing, refresh]);
  return { status, refresh };
}



export function ProxySection({ snapshot, focus }: { snapshot: SettingsSnapshot; focus: ProxyFocus | null }) {
  const { settings, chords } = snapshot;
  const [open, setOpen] = useState<string | null>(focus?.chordId || null);
  const { status, refresh } = useProxyStatus();
  const failing = proxyFailingRows(status, chords);
  // Try again clicked: Trying… until main has tried and its answer is in, for each row on its own (Carbon's N1).
  const [trying, setTrying] = useState<ReadonlySet<string>>(new Set());
  const tryAgain = (row: ProxyFailingRow) => {
    const key = row.key;
    setTrying((now) => new Set(now).add(key));
    void api.settings
      .retryProxy(row.owner)
      .then(() => new Promise((r) => setTimeout(r, 600)))
      .then(refresh)
      .finally(() =>
        setTrying((now) => {
          const next = new Set(now);
          next.delete(key);
          return next;
        }),
      );
  };
  // What a screen reader hears, politely, by each row's key (Carbon's B2): see proxyAnnouncement.
  const [said, setSaid] = useState('');
  const rows = [...(failing.all ? [failing.all] : []), ...failing.own.values()];
  // As one string, so the effect runs when the rows change, not on every poll's new objects.
  const shown = JSON.stringify(rows.map((r) => [r.key, { label: r.label, trying: trying.has(r.key) }]));
  const seen = useRef<Map<string, RowSeen>>(new Map());
  const snap = useRef(snapshot);
  useLayoutEffect(() => {
    snap.current = snapshot;
  });
  useEffect(() => {
    const now = new Map(JSON.parse(shown) as [string, RowSeen][]);
    const names = Object.fromEntries(snap.current.chords.map((c) => [c.id, c.name]));
    const words = proxyAnnouncement(seen.current, now, (key) => rowStillUsesProxy(key, snap.current.settings, snap.current.chords), names);
    if (words !== null) setSaid(words);
    seen.current = now;
  }, [shown]);
  const section = useRef<HTMLDivElement>(null);
  // A row that goes while its Try again has the focus hands it on, never to the page (Carbon's B1): the proxy for every
  // chord's to the choice in use in its editor; a chord's to that chord's button.
  const focusAfter = (key: string) => (hadFocus: boolean) => {
    if (!hadFocus) return;
    queueMicrotask(() => {
      const target = key === 'all' ? section.current?.querySelector<HTMLElement>('[data-proxy-radios="all"] [aria-checked="true"]') : section.current?.querySelector<HTMLElement>(`[data-proxy-chord="${CSS.escape(key)}"]`);
      target?.focus();
    });
  };
  // Opened at the proxy (or a chord's), each time it's asked (Carbon's SF2): that chord's open and its choice in use
  // focused, or the proxy for every chord's, with any chord's closed.
  const [want, setWant] = useState<ProxyFocus | null>(focus);
  useEffect(() => {
    if (!focus) return;
    setOpen(focus.chordId);
    setWant(focus);
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!want || open !== want.chordId) return;
    const key = want.chordId ?? 'all';
    const block = want.chordId ? section.current?.querySelector<HTMLElement>(`[data-proxy-block="${CSS.escape(want.chordId)}"]`) : section.current;
    const radio = section.current?.querySelector<HTMLElement>(`[data-proxy-radios="${CSS.escape(key)}"] [aria-checked="true"]`);
    if (!block || !radio) return;
    block.scrollIntoView({ block: 'start' });
    radio.focus({ preventScroll: true });
    setWant(null);
  }, [want, open]);
  return (
    <div ref={section}>
      <h2 className={styles.groupTitle}>
        Proxy
        <ResetButton label="Reset Proxy to default" visible={settings.proxy.mode !== 'system'} onReset={() => void api.settings.set({ proxy: { ...settings.proxy, mode: 'system' } })} />
      </h2>
      <span role="status" className="sr-only" data-proxy-said>
        {said}
      </span>
      <div className={styles.group}>
        {failing.all && <FailingRow row={failing.all} whose="every chord" trying={trying.has('all')} onTry={() => tryAgain(failing.all!)} onGone={focusAfter('all')} />}
        {/* Keyed by what's in use, so a change (made here or elsewhere) shows as it is. */}
        <ProxyEditor key={JSON.stringify(settings.proxy)} value={settings.proxy} all={settings.proxy} />
      </div>
      <p className={styles.groupNote}>
        Every chord without a proxy of its own uses it, and so do private windows and Chord’s own requests: update checks, ad-blocking lists, Safe Browsing and search suggestions. A change applies at once, and connections open the old way are closed.
      </p>
      <h2 className={styles.groupTitle}>Each chord</h2>
      <div className={styles.group}>
        {chords.map((chord) => {
          const expanded = open === chord.id;
          const action = expanded ? 'Done' : chord.proxy ? 'Change…' : 'Its own…';
          return (
            <div key={chord.id} className={local.chord} data-proxy-block={chord.id}>
              <Row
                label={`${chord.icon}  ${chord.name}`}
                description={chord.proxy ? `Its own: ${proxyLabel(chord.proxy)}` : 'Same as all chords'}
                control={
                  // Its name starts with what it shows, then whose it is.
                  <button
                    type="button"
                    className={styles.linkButton}
                    data-proxy-chord={chord.id}
                    aria-expanded={expanded}
                    aria-label={`${action}, proxy for ${chord.name}`}
                    onClick={() => setOpen(expanded ? null : chord.id)}
                  >
                    {action}
                  </button>
                }
              />
              {failing.own.has(chord.id) && (
                <FailingRow row={failing.own.get(chord.id)!} whose={chord.name} trying={trying.has(chord.id)} onTry={() => tryAgain(failing.own.get(chord.id)!)} onGone={focusAfter(chord.id)} />
              )}
              {expanded && (
                <div className={local.chordEditor}>
                  <ProxyEditor key={JSON.stringify([chord.proxy, chord.profileId])} value={chord.proxy ?? null} all={settings.proxy} chord={chord} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className={styles.groupNote}>
        A chord’s own proxy comes with its own sign-ins: Chord sets proxies by sign-ins, and the same cookies through another proxy would tell sites it’s you anyway.
      </p>
    </div>
  );
}
