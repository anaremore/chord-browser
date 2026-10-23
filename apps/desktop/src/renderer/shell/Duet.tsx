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
import { DUET_PROVIDER_NAMES, DUET_SCOPE_NAMES, splitCitations, type DuetMessage, type DuetProvider, type DuetScope } from '@chord/core';
import type { DuetAction, DuetView, SystemInfo } from '@chord/ipc';
import { ArrowDown, ArrowUp, AtSign, Check, ChevronDown, Copy, Ellipsis, Pencil, RotateCcw, Square, X } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from './api';
import styles from './Duet.module.css';

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

function Inline({ text, onLink }: { text: string; onLink(url: string): void }) {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|!?\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const key = `${m.index}`;
    if (m[1]) parts.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={key}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={key}>{m[3].slice(1, -1)}</em>);
    else {
      const url = m[5] ?? m[6]!;
      const label = m[4];
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

function Markdown({ text, onLink }: { text: string; onLink(url: string): void }) {
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
          <Inline text={heading[2]!} onLink={onLink} />
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
              <Inline text={item} onLink={onLink} />
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
        <Inline text={para.join('\n')} onLink={onLink} />
      </p>,
    );
  }
  return <>{blocks}</>;
}

/** A reply: Markdown with numbered citation pills where Duet quoted a tab. */
function Reply({ message, onLink }: { message: DuetMessage; onLink(url: string): void }) {
  if (message.body.role !== 'assistant') return null;
  const body = message.body;
  const segments = splitCitations(body.text);
  return (
    <div className={styles.reply}>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <Markdown key={i} text={seg.text} onLink={onLink} />
        ) : (
          <button
            key={i}
            type="button"
            className={styles.cite}
            title={`“${seg.quote}”`}
            aria-label={`Source ${seg.n}: “${seg.quote}”`}
            onClick={() => act({ do: 'citation', messageId: message.id, n: seg.n })}
          >
            {seg.n}
          </button>
        ),
      )}
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
    <div className={styles.approval} data-pending={pending || undefined} role={pending ? 'group' : undefined} aria-label={pending ? 'Duet is asking' : undefined} onKeyDown={onKey} tabIndex={pending ? 0 : -1}>
      <p className={styles.approvalTitle}>{body.description}</p>
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
    <p className={styles.working} aria-live="polite">
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
      <div ref={scroller} className={styles.timeline} onScroll={onScroll} role="log" aria-live="polite" aria-label="Duet conversation">
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
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
        <button type="button" className={styles.addChip} aria-label="Attach a tab" aria-expanded={picking} title="Attach a tab" onClick={() => setPicking(!picking)}>
          <AtSign size={13} strokeWidth={2} />
        </button>
      </div>
      {picking && (
        <ul className={styles.picker} role="listbox" aria-label="Attach a tab">
          {view.attachable.filter((t) => !view.attachments.some((a) => a.nodeId === t.nodeId)).length === 0 && <li className={styles.muted}>Every tab here is attached.</li>}
          {view.attachable
            .filter((t) => !view.attachments.some((a) => a.nodeId === t.nodeId))
            .map((t) => (
              <li key={t.nodeId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
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

/* ---------- Setup ---------- */

function Setup({ view, windowId }: { view: DuetView; windowId: string }) {
  return (
    <div className={styles.setup}>
      <p className={styles.setupTitle}>Set up Duet</p>
      <p className={styles.muted}>Duet uses your own Claude Code or Codex app. Pick one; you can switch any time.</p>
      <ul className={styles.providers}>
        {view.providers.map((p) => {
          const name = DUET_PROVIDER_NAMES[p.provider];
          const ready = p.installed && p.signedIn;
          return (
            <li key={p.provider} className={styles.provider}>
              <div className={styles.providerText}>
                <span className={styles.providerName}>{name}</span>
                <span className={styles.muted}>
                  {!p.installed
                    ? 'Not installed'
                    : `Installed ${p.version ?? ''}${p.signedIn ? ' · Signed in' : ''}${p.billing === 'api-key' ? ' · Using your API key' : ''}${p.tooOld ? ' · Needs an update' : ''}`}
                </span>
              </div>
              {!p.installed ? (
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={() => void api.state.dispatch({ t: 'tab.open', windowId, url: p.provider === 'claude' ? 'https://code.claude.com/docs/en/setup' : 'https://developers.openai.com/codex' })}
                >
                  How to install
                </button>
              ) : !p.signedIn ? (
                <button type="button" className={styles.secondary} onClick={() => act({ do: 'signIn', provider: p.provider })}>
                  Sign in
                </button>
              ) : (
                <button type="button" className={ready && view.provider === p.provider ? styles.secondary : styles.primary} onClick={() => act({ do: 'setup', provider: p.provider })}>
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

export function DuetPanel({ view, windowId }: { view: DuetView; windowId: string; info: SystemInfo }) {
  const [menu, setMenu] = useState<'thread' | 'model' | 'scope' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [seed, setSeed] = useState({ text: '', n: 0 });
  const provider = view.thread?.provider ?? view.provider ?? 'claude';
  const providerName = DUET_PROVIDER_NAMES[provider];
  const ready = view.provider !== null && view.providers.some((p) => p.provider === (view.thread?.provider ?? view.provider) && p.installed && p.signedIn);
  const openLink = (url: string) => void api.state.dispatch({ t: 'tab.open', windowId, url });
  const modelLabel = MODELS[provider].find((m) => m.value === (view.thread?.model ?? null))?.label ?? view.thread?.model ?? 'Default';
  const empty = view.messages.length === 0;
  const thread = view.thread;

  return (
    <aside className={styles.panel} aria-label="Duet">
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
        {ready && (
          <button type="button" className={styles.chip} aria-haspopup="menu" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>
            {providerName} · {modelLabel}
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
          </button>
        )}
        <button type="button" className={styles.iconButton} aria-label="Chats" aria-haspopup="menu" aria-expanded={menu === 'thread'} onClick={() => setMenu(menu === 'thread' ? null : 'thread')}>
          <Ellipsis {...ICON} />
        </button>
        <button type="button" className={styles.iconButton} aria-label="Close Duet" onClick={() => act({ do: 'toggle', open: false })}>
          <X {...ICON} />
        </button>
      </header>

      {menu === 'model' && (
        <ul className={styles.menu} role="menu" aria-label="Model">
          {(['claude', 'codex'] as const)
            .filter((p) => view.providers.some((s) => s.provider === p && s.installed && s.signedIn))
            .map((p) => (
              <Fragment key={p}>
                <li className={styles.menuLabel}>{DUET_PROVIDER_NAMES[p]}</li>
                {MODELS[p].map((m) => (
                  <li key={`${p}:${m.label}`}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={provider === p && (thread?.model ?? null) === m.value}
                      className={styles.menuItem}
                      onClick={() => {
                        act({ do: 'model', provider: p, model: m.value });
                        setMenu(null);
                      }}
                    >
                      {m.label}
                    </button>
                  </li>
                ))}
              </Fragment>
            ))}
        </ul>
      )}
      {menu === 'thread' && (
        <ul className={styles.menu} role="menu" aria-label="Chats">
          <li>
            <button type="button" role="menuitem" className={styles.menuItem} onClick={() => {
                    act({ do: 'new' });
                    setMenu(null);
                  }}>
              New chat
            </button>
          </li>
          {thread?.id && (
            <>
              <li>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => {
                    setRenaming(true);
                    setMenu(null);
                  }}>
                  Rename
                </button>
              </li>
              <li>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => {
                    act({ do: 'export' });
                    setMenu(null);
                  }}>
                  Export as Markdown
                </button>
              </li>
              <li>
                <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.danger}`} onClick={() => {
                    act({ do: 'delete', threadId: thread.id! });
                    setMenu(null);
                  }}>
                  Delete this chat
                </button>
              </li>
            </>
          )}
          {view.threads.filter((t) => t.id !== thread?.id).length > 0 && <li className={styles.menuLabel}>Recent chats</li>}
          {view.threads
            .filter((t) => t.id !== thread?.id)
            .map((t) => (
              <li key={t.id}>
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => {
                    act({ do: 'open', threadId: t.id });
                    setMenu(null);
                  }}>
                  <span className={styles.ellipsis}>{t.title}</span>
                </button>
              </li>
            ))}
        </ul>
      )}

      {view.chordOff ? (
        <p className={styles.centerNote}>Duet is off in this chord. Turn it back on in Settings → Duet.</p>
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
                What you attach goes to {providerName} through your own account. Duet reads only what’s attached to your message, unless you let it see more. It always asks before it changes your tabs.
              </p>
              <button type="button" className={styles.secondary} onClick={() => act({ do: 'dismissFirstUse' })}>
                Got it
              </button>
            </div>
          )}
          <div className={styles.scopeRow}>
            <span className={styles.muted}>Duet can read:</span>
            <select
              className={styles.scope}
              aria-label="What Duet can read"
              value={thread?.scope ?? 'ask'}
              onChange={(e) => act({ do: 'scope', scope: e.target.value as DuetScope })}
            >
              {(['ask', 'chord', 'all'] as const).map((s) => (
                <option key={s} value={s}>
                  {s === 'ask' ? 'What you attach (asks for more)' : DUET_SCOPE_NAMES[s]}
                </option>
              ))}
            </select>
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
    </aside>
  );
}
