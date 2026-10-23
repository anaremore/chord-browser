/**
 * Duet's panel (DESIGN.md §7.8, §8.6): a calm second frame on the right for
 * chatting about the page and your tabs. Main owns everything (threads,
 * sessions, what may be read); this renders the view it pushes and sends
 * actions back. Patterns taken from T3 Code's conversation UI (see
 * docs/research/duet.md §4.1): grouped tool activity per turn, follow-to-
 * bottom with a "Jump to latest" pill, queued follow-ups, ↑ to recall the
 * last message, copy, elapsed time while working.
 *
 * Nothing here loads anything remote: no images, no link previews, and links
 * show their full address and open only when clicked (research §6, rule 5).
 */
import { contextLabel, contextPercent, DUET_PROVIDER_NAMES, DUET_SCOPE_NAMES, splitCitations, type DuetContextUsage, type DuetMessage, type DuetProvider, type DuetScope } from '@chord/core';
import type { DuetAction, DuetView, SystemInfo } from '@chord/ipc';
import { ArrowDown, ArrowUp, AtSign, Check, ChevronDown, Copy, Ellipsis, Pencil, RotateCcw, Square, X } from 'lucide-react';
import { motion, useIsPresent, type Transition } from 'motion/react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useMenu, useRoving } from '../shared/a11y';
import { announce } from './announce';
import { api } from './api';
import styles from './Duet.module.css';

/** The scope switch's own labels: short enough for three to sit side by side in the panel. */
const DUET_SCOPE_SHORT: Record<DuetScope, string> = { ask: 'Ask first', chord: 'This chord', all: 'All tabs' };

const act = (action: DuetAction) => void api.duet.act(action);
const ICON = { size: 15, strokeWidth: 1.75 } as const;
/** Follow new output unless you've scrolled further up than this (T3 Code's re-arm distance). */
const FOLLOW_PX = 40;

const MODELS: Record<DuetProvider, { value: string | null; label: string }[]> = {
  claude: [
    { value: null, label: 'Default' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
  ],
  codex: [{ value: null, label: 'Default' }],
};

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/* ---------- Text: a small, safe Markdown subset, no HTML, no images ---------- */

/** Renders a citation marker as a pill, in place (see Reply). */
type Cite = (ref: string, quote: string) => ReactNode;

function Inline({ text, onLink, cite }: { text: string; onLink(url: string): void; cite: Cite }) {
  const parts: ReactNode[] = [];
  const pattern = /\[\[(t\d{1,4}):"([^"\]\n]{1,300})"\]\]|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|!?\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const key = `${m.index}`;
    if (m[1]) parts.push(<Fragment key={key}>{cite(m[1], m[2]!)}</Fragment>);
    else if (m[3]) parts.push(<code key={key}>{m[3].slice(1, -1)}</code>);
    else if (m[4]) parts.push(<strong key={key}>{m[4].slice(2, -2)}</strong>);
    else if (m[5]) parts.push(<em key={key}>{m[5].slice(1, -1)}</em>);
    else {
      const url = m[7] ?? m[8]!;
      const label = m[6];
      // The full address always shows; nothing loads until it's clicked.
      parts.push(
        <button key={key} type="button" className={styles.link} title={url} onClick={() => onLink(url)}>
          {label ? `${label} (${url})` : url}
        </button>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function Markdown({ text, onLink, cite }: { text: string; onLink(url: string): void; cite: Cite }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={i}>{code.join('\n')}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={i} className={styles.heading}>
          <Inline text={heading[2]!} onLink={onLink} cite={cite} />
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={i}>
          {items.map((item, n) => (
            <li key={n}>
              <Inline text={item} onLink={onLink} cite={cite} />
            </li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith('```') && !/^(#{1,4})\s/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(
      <p key={i}>
        <Inline text={para.join('\n')} onLink={onLink} cite={cite} />
      </p>,
    );
  }
  return <>{blocks}</>;
}

/** A reply: Markdown with numbered citation pills, in the sentence where Duet quoted a tab. */
function Reply({ message, onLink }: { message: DuetMessage; onLink(url: string): void }) {
  if (message.body.role !== 'assistant') return null;
  const numbers = new Map<string, number>();
  for (const seg of splitCitations(message.body.text)) if (seg.kind === 'citation') numbers.set(`${seg.ref}:${seg.quote}`, seg.n);
  const citations = message.body.citations;
  const cite: Cite = (ref, quote) => {
    const n = numbers.get(`${ref}:${quote}`);
    if (n === undefined) return null;
    // A PDF's citation names its page (found in the text Duet read).
    const page = citations.find((c) => c.n === n)?.page;
    return (
      <button
        type="button"
        className={styles.cite}
        title={`${page ? `p. ${page} · ` : ''}“${quote}”`}
        aria-label={`Source ${n}${page ? `, page ${page}` : ''}: “${quote}”`}
        onClick={() => act({ do: 'citation', messageId: message.id, n })}
      >
        {page ? `${n} · p. ${page}` : n}
      </button>
    );
  };
  return (
    <div className={styles.reply}>
      <Markdown text={message.body.text} onLink={onLink} cite={cite} />
    </div>
  );
}

/* ---------- Timeline ---------- */

type Row = { kind: 'message'; message: DuetMessage } | { kind: 'tools'; messages: DuetMessage[] };

/** Consecutive tool activity in a turn folds into one quiet row. */
function rows(messages: readonly DuetMessage[]): Row[] {
  const out: Row[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (message.body.role === 'tool') {
      if (last?.kind === 'tools') last.messages.push(message);
      else out.push({ kind: 'tools', messages: [message] });
    } else out.push({ kind: 'message', message });
  }
  return out;
}

function ToolRow({ messages }: { messages: DuetMessage[] }) {
  const [open, setOpen] = useState(false);
  const summaries = messages.map((m) => (m.body.role === 'tool' ? m.body.summary : ''));
  const reads = messages.filter((m) => m.body.role === 'tool' && (m.body.tool === 'read_tab' || m.body.tool === 'tab_screenshot')).length;
  const label = reads > 1 ? `Read ${reads} tabs${summaries.length > reads ? ` · ${summaries.length - reads} more` : ''}` : summaries.join(' · ');
  return (
    <div className={styles.toolRow}>
      <button type="button" className={styles.toolSummary} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={styles.ellipsis}>{label}</span>
        <ChevronDown size={13} strokeWidth={2} className={styles.chevron} aria-hidden />
      </button>
      {open && (
        <ul className={styles.toolDetails}>
          {messages.map((m) =>
            m.body.role === 'tool' ? (
              <li key={m.id}>
                {m.body.summary}
                {m.body.detail && <span className={styles.muted}> · {m.body.detail}</span>}
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

function Approval({ message }: { message: DuetMessage }) {
  if (message.body.role !== 'approval') return null;
  const body = message.body;
  const pending = body.decision === 'pending';
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pending) return;
    if (e.key === 'Escape') act({ do: 'approve', messageId: message.id, decision: 'denied' });
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) act({ do: 'approve', messageId: message.id, decision: 'once' });
  };
  const outcome = { once: 'Allowed', thread: 'Allowed for this chat', denied: 'Not allowed', expired: 'Not answered', pending: '' }[body.decision];
  return (
    <div className={styles.approval} data-pending={pending || undefined} role={pending ? 'group' : undefined} aria-label={pending ? 'Duet is asking' : undefined} aria-describedby={pending ? `ask-${message.id}` : undefined} onKeyDown={onKey} tabIndex={pending ? 0 : -1}>
      <p id={`ask-${message.id}`} className={styles.approvalTitle}>
        {body.description}
      </p>
      {body.target.length > 0 && (
        <ul className={styles.targets}>
          {body.target.slice(0, 8).map((t, i) => (
            <li key={i} className={styles.ellipsis} title={t}>
              {t}
            </li>
          ))}
          {body.target.length > 8 && <li className={styles.muted}>and {body.target.length - 8} more</li>}
        </ul>
      )}
      {pending ? (
        <div className={styles.approvalActions}>
          <button type="button" className={styles.primary} onClick={() => act({ do: 'approve', messageId: message.id, decision: 'once' })}>
            Allow once
          </button>
          <button type="button" className={styles.secondary} onClick={() => act({ do: 'approve', messageId: message.id, decision: 'thread' })}>
            Allow for this chat
          </button>
          <span className={styles.flex} />
          <button type="button" className={styles.quiet} onClick={() => act({ do: 'approve', messageId: message.id, decision: 'denied' })}>
            No
          </button>
        </div>
      ) : (
        <div className={styles.approvalOutcome}>
          <span className={styles.muted}>{outcome}</span>
        </div>
      )}
    </div>
  );
}

function MessageView({ message, last, onLink, onEdit, view }: { message: DuetMessage; last: boolean; onLink(url: string): void; onEdit(text: string): void; view: DuetView }) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const body = message.body;
  if (body.role === 'divider') return <p className={styles.divider}>{body.text}</p>;
  if (body.role === 'approval') return <Approval message={message} />;
  if (body.role === 'user') {
    return (
      <div className={styles.userWrap}>
        <div className={styles.user}>{body.text}</div>
        {body.attachments.length > 0 && <p className={styles.attachedNote}>{body.attachments.map((a) => a.title || host(a.url)).join(' · ')}</p>}
        <div className={styles.messageActions}>
          <button type="button" className={styles.iconButton} aria-label="Copy" title={copied ? 'Copied' : 'Copy'} onClick={() => copy(body.text)}>
            {copied ? <Check {...ICON} /> : <Copy {...ICON} />}
          </button>
          {last && (
            <button type="button" className={styles.iconButton} aria-label="Edit and send again" title="Edit and send again" onClick={() => onEdit(body.text)}>
              <Pencil {...ICON} />
            </button>
          )}
        </div>
      </div>
    );
  }
  if (body.role !== 'assistant') return null;
  const working = body.status === 'streaming' && !body.text;
  return (
    <div className={styles.assistant}>
      {working ? <Working startedAt={view.startedAt} /> : <Reply message={message} onLink={onLink} />}
      {body.status === 'interrupted' && (
        <p className={styles.statusLine}>
          Interrupted.
          {last && (
            <button type="button" className={styles.quiet} onClick={() => act({ do: 'retry' })}>
              <RotateCcw size={13} strokeWidth={2} aria-hidden /> Retry
            </button>
          )}
        </p>
      )}
      {body.status === 'error' && (
        <p className={styles.errorLine} role="alert">
          {body.error ?? 'Duet couldn’t answer.'}
          {last && (
            <button type="button" className={styles.quiet} onClick={() => act({ do: 'retry' })}>
              <RotateCcw size={13} strokeWidth={2} aria-hidden /> Retry
            </button>
          )}
        </p>
      )}
      {body.status === 'done' && body.text && (
        <div className={styles.messageActions}>
          <button type="button" className={styles.iconButton} aria-label="Copy" title={copied ? 'Copied' : 'Copy'} onClick={() => copy(body.text)}>
            {copied ? <Check {...ICON} /> : <Copy {...ICON} />}
          </button>
        </div>
      )}
    </div>
  );
}

function Working({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  return (
    <p className={styles.working}>
      <span className={styles.pulse} aria-hidden />
      Working{seconds >= 2 ? ` · ${seconds}s` : '…'}
    </p>
  );
}

function Timeline({ view, onLink, onEdit }: { view: DuetView; onLink(url: string): void; onEdit(text: string): void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const lastUser = [...view.messages].reverse().find((m) => m.body.role === 'user');
  const lastAssistant = [...view.messages].reverse().find((m) => m.body.role === 'assistant');
  // Follow new output while you're at the bottom; scrolling up pauses it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = scroller.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX);
  };
  return (
    <div className={styles.timelineWrap}>
      <div
        ref={scroller}
        className={styles.timeline}
        onScroll={onScroll}
        role="log"
        // Replies stream in a few words at a time; reading each would talk over itself. The panel
        // announces "Duet finished answering" instead, and the log is there to read (DESIGN.md §10).
        aria-live="off"
        aria-busy={view.busy}
        aria-label="Duet conversation"
        tabIndex={0}
      >
        {rows(view.messages).map((row) =>
          row.kind === 'tools' ? (
            <ToolRow key={row.messages[0]!.id} messages={row.messages} />
          ) : (
            <MessageView key={row.message.id} message={row.message} view={view} last={row.message === lastUser || row.message === lastAssistant} onLink={onLink} onEdit={onEdit} />
          ),
        )}
      </div>
      {!following && (
        <button
          type="button"
          className={styles.jump}
          onClick={() => {
            setFollowing(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
          }}
        >
          <ArrowDown size={13} strokeWidth={2} aria-hidden /> Jump to latest
        </button>
      )}
    </div>
  );
}

/* ---------- Composer ---------- */

function Composer({ view, providerName, draftSeed }: { view: DuetView; providerName: string; draftSeed: { text: string; n: number } }) {
  const [text, setText] = useState(view.draft);
  const [picking, setPicking] = useState(false);
  const picker = useMenu(picking, () => setPicking(false));
  const input = useRef<HTMLTextAreaElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A different chat brings its own draft.
  const threadKey = view.thread?.id ?? 'fresh';
  const draft = view.draft;
  useEffect(() => setText(draft), [threadKey]);
  useEffect(() => {
    if (draftSeed.n === 0) return;
    setText(draftSeed.text);
    input.current?.focus();
  }, [draftSeed]);
  const update = (value: string) => {
    setText(value);
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => act({ do: 'draft', text: value }), 400);
  };
  const send = () => {
    if (!text.trim()) return;
    act({ do: 'send', text });
    setText('');
    clearTimeout(draftTimer.current);
  };
  const lastUser = [...view.messages].reverse().find((m) => m.body.role === 'user');
  // A card asking to read more answers to its keys from here too: ⌘↵ / Ctrl+↵ allows once, Esc says no (DESIGN.md §7.8).
  const asking = view.messages.find((m) => m.body.role === 'approval' && m.body.decision === 'pending');
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (asking && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      act({ do: 'approve', messageId: asking.id, decision: 'once' });
    } else if (asking && e.key === 'Escape') {
      e.preventDefault();
      act({ do: 'approve', messageId: asking.id, decision: 'denied' });
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && !text && lastUser?.body.role === 'user') {
      // ↑ in an empty composer brings back your last message to edit.
      e.preventDefault();
      update(lastUser.body.text);
    } else if (e.key === 'Escape' && view.busy) {
      act({ do: 'stop' });
    }
  };
  const chipNote = `Duet reads this tab only when you send, through your own ${providerName} account.`;
  return (
    <div className={styles.composer}>
      {view.queue.length > 0 && (
        <ul className={styles.queue} aria-label="Waiting to send">
          {view.queue.map((q, i) => (
            <li key={i} className={styles.queued}>
              <span className={styles.ellipsis}>{q}</span>
              <button type="button" className={styles.iconButton} aria-label="Don't send" onClick={() => act({ do: 'unqueue', index: i })}>
                <X size={12} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.chips}>
        {view.attachments.map((a) => (
          <span key={a.nodeId} className={styles.chip} title={chipNote}>
            <span className={styles.ellipsis}>{a.current ? `This tab · ${host(a.url)}` : a.title}</span>
            <button type="button" className={styles.chipX} aria-label={`Don't attach ${a.title}`} onClick={() => act({ do: 'detach', nodeId: a.nodeId })}>
              <X size={11} strokeWidth={2.25} />
            </button>
          </span>
        ))}
        <button
          type="button"
          className={styles.addChip}
          aria-label="Attach a tab"
          aria-haspopup="menu"
          aria-expanded={picking}
          aria-controls={picking ? 'duet-attach' : undefined}
          title="Attach a tab"
          onClick={() => setPicking(!picking)}
        >
          <AtSign size={13} strokeWidth={2} />
        </button>
      </div>
      {picking && (
        <ul ref={picker.ref} id="duet-attach" className={styles.picker} role="menu" aria-label="Attach a tab" onKeyDown={picker.onKeyDown}>
          {view.attachable.filter((t) => !view.attachments.some((a) => a.nodeId === t.nodeId)).length === 0 && (
            <li role="none">
              <span role="menuitem" aria-disabled="true" tabIndex={-1} className={styles.muted}>
                Every tab here is attached.
              </span>
            </li>
          )}
          {view.attachable
            .filter((t) => !view.attachments.some((a) => a.nodeId === t.nodeId))
            .map((t) => (
              <li key={t.nodeId} role="none">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={styles.pickerRow}
                  onClick={() => {
                    act({ do: 'attach', nodeId: t.nodeId });
                    setPicking(false);
                  }}
                >
                  <span className={styles.ellipsis}>{t.title}</span>
                  <span className={styles.muted}>{host(t.url)}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
      <div className={styles.inputRow}>
        <textarea
          ref={input}
          className={styles.input}
          value={text}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder={view.busy ? 'Add a follow-up…' : 'Ask Duet'}
          aria-label="Message Duet"
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKey}
        />
        {view.busy ? (
          <button type="button" className={styles.stop} aria-label="Stop" title="Stop (Esc)" onClick={() => act({ do: 'stop' })}>
            <Square size={13} strokeWidth={2.5} fill="currentColor" />
          </button>
        ) : (
          <button type="button" className={styles.send} aria-label="Send" title="Send (Enter)" disabled={!text.trim()} onClick={send}>
            <ArrowUp size={16} strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- Context meter ---------- */

/**
 * How much of the model's context the chat has used, as the CLI reports it: a
 * small pie (a ring would read as a spinner), the details on hover or focus.
 */
function ContextMeter({ usage, provider }: { usage: DuetContextUsage; provider: DuetProvider }) {
  const percent = contextPercent(usage);
  const label = contextLabel(provider, usage);
  return (
    <span
      className={styles.meter}
      role="meter"
      tabIndex={0}
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={label}
      title={label}
      data-full={percent >= 80 || undefined}
    >
      <svg viewBox="0 0 16 16" aria-hidden>
        <circle className={styles.meterTrack} cx="8" cy="8" r="6.5" strokeWidth="1.5" />
        {/* A stroke as wide as the circle is round draws a wedge: the used share, clockwise from the top. */}
        <circle className={styles.meterFill} cx="8" cy="8" r="2.75" strokeWidth="5.5" pathLength={100} strokeDasharray={`${percent} 100`} />
      </svg>
    </span>
  );
}

/* ---------- Setup ---------- */

function Setup({ view, windowId }: { view: DuetView; windowId: string }) {
  return (
    <div className={styles.setup}>
      <p className={styles.setupTitle}>Set up Duet</p>
      <p className={styles.muted}>Duet uses your own Claude Code or Codex app. Pick one; you can switch any time.</p>
      <ul className={styles.providers}>
        {view.providers.map((p) => {
          const name = p.wsl ? `${DUET_PROVIDER_NAMES[p.provider]} in WSL (${p.wsl})` : DUET_PROVIDER_NAMES[p.provider];
          const ready = p.installed && p.signedIn;
          return (
            <li key={p.provider} className={styles.provider}>
              <div className={styles.providerText}>
                <span className={styles.providerName}>{name}</span>
                <span className={styles.muted}>
                  {!p.installed
                    ? view.lookingInWsl.includes(p.provider)
                      ? 'Looking in WSL…'
                      : 'Not installed'
                    : `Installed ${p.version ?? ''}${p.signedIn ? ' · Signed in' : ''}${p.billing === 'api-key' ? ' · Using your API key' : ''}${p.tooOld ? ' · Needs an update' : ''}`}
                </span>
              </div>
              {/* Too old to say whether it's signed in: updating comes first. */}
              {!p.installed || p.signedIn === null ? (
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={() => void api.state.dispatch({ t: 'tab.open', windowId, url: p.provider === 'claude' ? 'https://code.claude.com/docs/en/setup' : 'https://developers.openai.com/codex' })}
                >
                  {p.installed ? 'How to update' : 'How to install'}
                </button>
              ) : !p.signedIn ? (
                <button type="button" className={styles.secondary} onClick={() => act({ do: 'signIn', provider: p.provider })}>
                  Sign in
                </button>
              ) : (
                <button
                  type="button"
                  className={ready && view.provider === p.provider ? styles.secondary : styles.primary}
                  data-autofocus={view.provider !== p.provider || undefined}
                  onClick={() => act({ do: 'setup', provider: p.provider })}
                >
                  {view.provider === p.provider ? 'Using this' : 'Use this'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className={styles.quiet} onClick={() => act({ do: 'refresh' })}>
        <RotateCcw size={13} strokeWidth={2} aria-hidden /> Check again
      </button>
    </div>
  );
}

/* ---------- The panel ---------- */

/**
 * What screen readers hear from Duet (DESIGN.md §10): that it finished
 * answering (not each word as it streams), and that it's asking to read more.
 */
function useDuetAnnouncements(view: DuetView): void {
  const wasBusy = useRef(view.busy);
  const asked = useRef(new Set(view.messages.filter((m) => m.body.role === 'approval').map((m) => m.id)));
  useEffect(() => {
    if (wasBusy.current && !view.busy) {
      const last = [...view.messages].reverse().find((m) => m.body.role === 'assistant');
      if (last?.body.role === 'assistant' && last.body.status === 'done') announce('Duet finished answering.');
      else if (last?.body.role === 'assistant' && last.body.status === 'interrupted') announce('Duet stopped.');
    }
    wasBusy.current = view.busy;
    for (const m of view.messages) {
      if (m.body.role !== 'approval' || asked.current.has(m.id)) continue;
      asked.current.add(m.id);
      if (m.body.decision === 'pending') announce(`Duet is asking: ${m.body.description}. Allow once, Allow for this chat, or No.`);
    }
  }, [view]);
}

/** Where the keyboard starts in the panel: the message field, else the step's main button. */
const panelStart = (panel: HTMLElement | null) =>
  panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>('textarea') ?? panel?.querySelector<HTMLElement>('button');

/**
 * Opened, the panel takes the keyboard (from the page too: ⌘E); closed, it
 * gives it back. In between, a step that replaces the focused button (Use
 * this → Got it → the message field) hands the keyboard to the next one.
 * A step's main button can also arrive after the step: opened while Duet is
 * still finding Claude Code and Codex, the keyboard starts on the panel's
 * first button, and moves to "Use this" when it appears, unless the user has
 * moved it since.
 */
function usePanelFocus(panel: RefObject<HTMLElement | null>, step: string, present: boolean): void {
  // Where the panel last put the keyboard.
  const placed = useRef<HTMLElement | null>(null);
  const focusStart = () => {
    placed.current = panelStart(panel.current) ?? null;
    placed.current?.focus();
  };
  useEffect(() => {
    // Only when the keyboard was left nowhere (its button went with the step): never taken from elsewhere.
    const now = document.activeElement;
    if (now && now !== document.body) return;
    focusStart();
  }, [step]);
  useEffect(() => {
    if (!present || !placed.current || document.activeElement !== placed.current) return;
    if (panelStart(panel.current) !== placed.current) focusStart();
  });
  useEffect(() => {
    if (!present) return;
    const before = document.hasFocus() && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    focusStart();
    void api.focus.move('shell');
    return () => {
      // Closing (sliding out, or gone): the keyboard leaves the panel now, not when the slide ends.
      if (document.activeElement instanceof HTMLElement && panel.current?.contains(document.activeElement)) document.activeElement.blur();
      setTimeout(() => {
        const now = document.activeElement;
        if (now && now !== document.body) return;
        if (before?.isConnected) before.focus();
        else void api.focus.move('page');
      }, 0);
    };
  }, [present]);
}

/** Off the window's right edge: where the panel slides in from and out to (DESIGN.md §6.5). */
const OFF_RIGHT = { x: '110%' };

export function DuetPanel({ view, windowId, slide }: { view: DuetView; windowId: string; info: SystemInfo; slide: { enter: Transition; exit: Transition } }) {
  // Closing, it slides out (AnimatePresence keeps it a moment): the keyboard goes back as it starts to.
  const present = useIsPresent();
  const [menu, setMenu] = useState<'thread' | 'model' | 'scope' | null>(null);
  const panel = useRef<HTMLElement>(null);
  const modelMenu = useMenu(menu === 'model', () => setMenu(null));
  const threadMenu = useMenu(menu === 'thread', () => setMenu(null));
  const scopeGroup = useRoving<HTMLDivElement>({ items: '[role="radio"]', current: '[aria-checked="true"]', orientation: 'horizontal', activate: true });
  useDuetAnnouncements(view);
  const thread = view.thread;
  const ready = view.provider !== null && view.providers.some((p) => p.provider === (view.thread?.provider ?? view.provider) && p.installed && p.signedIn);
  usePanelFocus(panel, view.chordOff ? 'off' : !view.provider ? 'intro' : !ready ? 'setup' : view.firstUse ? 'first-use' : 'ready', present);
  const [renaming, setRenaming] = useState(false);
  const [seed, setSeed] = useState({ text: '', n: 0 });
  const provider = view.thread?.provider ?? view.provider ?? 'claude';
  const providerName = DUET_PROVIDER_NAMES[provider];
  const openLink = (url: string) => void api.state.dispatch({ t: 'tab.open', windowId, url });
  const modelLabel = MODELS[provider].find((m) => m.value === (view.thread?.model ?? null))?.label ?? view.thread?.model ?? 'Default';
  const empty = view.messages.length === 0;

  return (
    <motion.aside
      ref={panel}
      className={styles.panel}
      aria-label="Duet"
      data-region="duet"
      inert={!present}
      initial={OFF_RIGHT}
      animate={{ x: 0, transition: slide.enter }}
      exit={{ ...OFF_RIGHT, transition: slide.exit }}
    >
      <header className={styles.header}>
        {renaming && thread?.id ? (
          <input
            className={styles.rename}
            defaultValue={thread.title}
            aria-label="Chat name"
            maxLength={80}
            autoFocus
            onBlur={(e) => {
              if (e.target.value.trim()) act({ do: 'rename', threadId: thread.id!, title: e.target.value });
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className={`${styles.title} ${styles.ellipsis}`}>{thread?.title || 'Duet'}</span>
        )}
        {ready && view.context && <ContextMeter usage={view.context} provider={provider} />}
        {ready && (
          <button
            type="button"
            className={styles.chip}
            aria-haspopup="menu"
            aria-expanded={menu === 'model'}
            aria-controls={menu === 'model' ? 'duet-model' : undefined}
            onClick={() => setMenu(menu === 'model' ? null : 'model')}
          >
            {providerName} · {modelLabel}
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Chats"
          title="Chats"
          aria-haspopup="menu"
          aria-expanded={menu === 'thread'}
          aria-controls={menu === 'thread' ? 'duet-chats' : undefined}
          onClick={() => setMenu(menu === 'thread' ? null : 'thread')}
        >
          <Ellipsis {...ICON} />
        </button>
        <button type="button" className={styles.iconButton} aria-label="Close Duet" title="Close Duet" onClick={() => act({ do: 'toggle', open: false })}>
          <X {...ICON} />
        </button>
      </header>

      {menu === 'model' && (
        <ul ref={modelMenu.ref} id="duet-model" className={styles.menu} role="menu" aria-label="Model" onKeyDown={modelMenu.onKeyDown}>
          {(['claude', 'codex'] as const)
            .filter((p) => view.providers.some((s) => s.provider === p && s.installed && s.signedIn))
            .map((p) => (
              <li key={p} role="group" aria-labelledby={`duet-model-${p}`} className={styles.menuGroup}>
                <span id={`duet-model-${p}`} className={styles.menuLabel}>
                  {DUET_PROVIDER_NAMES[p]}
                </span>
                {MODELS[p].map((m) => (
                  <span key={`${p}:${m.label}`} role="none">
                    <button
                      type="button"
                      role="menuitemradio"
                      tabIndex={-1}
                      aria-checked={provider === p && (thread?.model ?? null) === m.value}
                      className={styles.menuItem}
                      onClick={() => {
                        act({ do: 'model', provider: p, model: m.value });
                        setMenu(null);
                      }}
                    >
                      {m.label}
                    </button>
                  </span>
                ))}
              </li>
            ))}
        </ul>
      )}
      {menu === 'thread' && (
        <ul ref={threadMenu.ref} id="duet-chats" className={styles.menu} role="menu" aria-label="Chats" onKeyDown={threadMenu.onKeyDown}>
          <li role="none">
            <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} onClick={() => {
                    act({ do: 'new' });
                    setMenu(null);
                  }}>
              New chat
            </button>
          </li>
          {thread?.id && (
            <>
              <li role="none">
                <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} onClick={() => {
                    setRenaming(true);
                    setMenu(null);
                  }}>
                  Rename
                </button>
              </li>
              <li role="none">
                <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} onClick={() => {
                    act({ do: 'export' });
                    setMenu(null);
                  }}>
                  Export as Markdown
                </button>
              </li>
              <li role="none">
                <button type="button" role="menuitem" tabIndex={-1} className={`${styles.menuItem} ${styles.danger}`} onClick={() => {
                    act({ do: 'delete', threadId: thread.id! });
                    setMenu(null);
                  }}>
                  Delete this chat
                </button>
              </li>
            </>
          )}
          {view.threads.filter((t) => t.id !== thread?.id).length > 0 && (
            <li role="group" aria-labelledby="duet-recent" className={styles.menuGroup}>
              <span id="duet-recent" className={styles.menuLabel}>
                Recent chats
              </span>
              {view.threads
                .filter((t) => t.id !== thread?.id)
                .map((t) => (
                  <span key={t.id} role="none">
                    <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} onClick={() => {
                        act({ do: 'open', threadId: t.id });
                        setMenu(null);
                      }}>
                      <span className={styles.ellipsis}>{t.title}</span>
                    </button>
                  </span>
                ))}
            </li>
          )}
          {!view.chordOff && (
            <li role="none">
              <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} onClick={() => {
                  act({ do: 'chordOff', off: true });
                  setMenu(null);
                }}>
                Turn off in this chord
              </button>
            </li>
          )}
        </ul>
      )}

      {view.chordOff ? (
        <div className={styles.centerNote}>
          <p>Duet is off in this chord. It can’t read this chord’s tabs from other chords either.</p>
          <button type="button" className={styles.secondary} onClick={() => act({ do: 'chordOff', off: false })}>
            Turn on in this chord
          </button>
        </div>
      ) : !view.provider ? (
        <div className={styles.intro}>
          <p className={styles.introTitle}>Meet Duet.</p>
          <p className={styles.muted}>Chat about this page and your tabs, using your own Claude Code or Codex app. Chord never sees your sign-in, and nothing is sent until you press Send.</p>
          <Setup view={view} windowId={windowId} />
        </div>
      ) : !ready ? (
        <Setup view={view} windowId={windowId} />
      ) : (
        <>
          {view.firstUse && (
            <div className={styles.firstUse} role="note">
              <p>
                What you attach goes to {providerName} through your own account. Duet reads only what’s attached to your message, unless you let it see more. It never sees what you type into forms.
              </p>
              <button type="button" className={styles.secondary} data-autofocus onClick={() => act({ do: 'dismissFirstUse' })}>
                Got it
              </button>
            </div>
          )}
          <div className={styles.scopeRow}>
            <span className={styles.muted}>Reads</span>
            <div ref={scopeGroup.ref} className={styles.scope} role="radiogroup" aria-label="What Duet can read" onKeyDown={scopeGroup.onKeyDown}>
              {(['ask', 'chord', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={(thread?.scope ?? 'ask') === s}
                  className={styles.scopeOption}
                  title={s === 'ask' ? 'What you attach, and asks before reading more' : DUET_SCOPE_NAMES[s]}
                  onClick={() => act({ do: 'scope', scope: s satisfies DuetScope })}
                >
                  {DUET_SCOPE_SHORT[s]}
                </button>
              ))}
            </div>
          </div>
          {empty ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>Ask about this page, your tabs, or anything you’re working on.</p>
              <div className={styles.suggestions}>
                {['Summarize this page', 'What should I know before I decide?', 'Compare with my other tabs'].map((s) => (
                  <button key={s} type="button" className={styles.suggestion} onClick={() => act({ do: 'send', text: s })}>
                    {s}
                  </button>
                ))}
              </div>
              {view.continueFrom && (
                <button type="button" className={styles.quiet} onClick={() => act({ do: 'continue' })}>
                  Continue “{view.continueFrom.title}”
                </button>
              )}
            </div>
          ) : (
            <Timeline view={view} onLink={openLink} onEdit={(text) => setSeed({ text, n: seed.n + 1 })} />
          )}
          <Composer view={view} providerName={providerName} draftSeed={seed} />
        </>
      )}
    </motion.aside>
  );
}
