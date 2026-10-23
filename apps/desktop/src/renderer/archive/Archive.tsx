/**
 * The archive page (chord://archive, DESIGN.md §7, ARCHITECTURE.md §7): Today
 * tabs you closed, cleared or stopped using, by day, newest first. Search
 * narrows by title or address; clicking one brings the tab back to its
 * chord's sidebar, with its back/forward history. Entries stay 30 days.
 */
import type { ArchivedTab } from '@chord/core';
import type { ArchiveList, ArchiveSnapshot, SystemInfo } from '@chord/ipc';
import { Archive, ArchiveRestore, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Favicon } from '../shared/Favicon';
import { displayHost, pageTitle } from '../shared/site';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './Archive.module.css';
import { groupByDay } from './days';

/** Entries shown at first, and how many more each "Show more" adds. */
const PAGE = 200;
/** Typing settles this long before the archive is searched. */
const SEARCH_DELAY_MS = 120;

const timeOf = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function ArchivePage({ initialInfo, initialSnapshot }: { initialInfo: SystemInfo; initialSnapshot: ArchiveSnapshot }) {
  const [info, setInfo] = useState(initialInfo);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  useEffect(() => api.system.onChange(setInfo), []);
  useEffect(() => api.archive.onSnapshot(setSnapshot), []);

  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [list, setList] = useState<ArchiveList | null>(null);
  // Brought back or removed just now: hidden at once, before the archive says so.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const load = () => {
      const mine = ++seq.current;
      void api.archive.list(query.trim(), limit).then((found) => {
        if (mine === seq.current) setList(found);
      });
    };
    const timer = setTimeout(load, query.trim() ? SEARCH_DELAY_MS : 0);
    const unsubscribe = api.archive.onChange(load);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [query, limit]);

  const { style, appearance } = chordStyle(snapshot.theme ? { theme: snapshot.theme } : null, info, snapshot.interface);
  const chords = new Map(snapshot.chords.map((c) => [c.id, c]));
  const items = (list?.items ?? []).filter((t) => !gone.has(t.id));
  // Which chord a tab was in only matters when the archive has more than one.
  const manyChords = new Set(items.map((t) => t.chordId)).size > 1;
  const groups = groupByDay(items, Date.now());

  const hide = (id: string) => setGone((previous) => new Set(previous).add(id));
  const bringBack = (tab: ArchivedTab) => {
    hide(tab.id);
    const chord = chords.get(tab.chordId);
    setNotice(`${titleOf(tab)} is back${chord ? ` in ${chord.icon} ${chord.name}` : ''}.`);
    void api.archive.restore(tab.id);
  };
  const remove = (tab: ArchivedTab) => {
    hide(tab.id);
    setNotice(`Removed ${titleOf(tab)} from the archive.`);
    void api.archive.remove(tab.id);
  };

  return (
    <div className={styles.page} style={style as CSSProperties}>
      <main className={styles.column}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            <Archive size={24} strokeWidth={1.75} aria-hidden />
            Archive
          </h1>
          <p className={styles.description}>Tabs you closed, and Today tabs you stopped using. Each one stays for 30 days.</p>
          <label className={styles.search}>
            <Search size={16} strokeWidth={1.75} aria-hidden />
            <input
              value={query}
              placeholder="Search the archive"
              aria-label="Search the archive"
              spellCheck={false}
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
              }}
            />
          </label>
          <p className={styles.notice} role="status">
            {notice}
          </p>
        </header>

        {list && items.length === 0 && (
          <div className={styles.empty}>
            {query.trim() ? (
              <p className={styles.emptyTitle}>Nothing in the archive matches “{query.trim()}”.</p>
            ) : (
              <>
                <p className={styles.emptyTitle}>Nothing archived yet.</p>
                <p className={styles.emptyBody}>Tabs you haven’t used in a while get tucked in here, so you can always find them again.</p>
              </>
            )}
          </div>
        )}

        {groups.map((group) => (
          <section key={group.key} className={styles.day} aria-labelledby={`day-${group.key}`}>
            <h2 id={`day-${group.key}`} className={styles.dayTitle}>
              {group.label}
            </h2>
            <ul className={styles.list} aria-label={group.label}>
              {group.items.map((tab) => {
                const title = titleOf(tab);
                const chord = manyChords ? chords.get(tab.chordId) : undefined;
                return (
                  <li key={tab.id} className={styles.row}>
                    <button type="button" className={styles.rowMain} aria-label={`Bring back ${title}`} title={tab.url} onClick={() => bringBack(tab)}>
                      <Favicon url={tab.url} title={tab.title} favicon={tab.favicon} appearance={appearance} />
                      <span className={styles.rowTitle}>{title}</span>
                      <span className={styles.rowHost}>{displayHost(tab.url)}</span>
                      {chord && (
                        <span className={styles.chip}>
                          {chord.icon} {chord.name}
                        </span>
                      )}
                      <time className={styles.time} dateTime={new Date(tab.archivedAt).toISOString()}>
                        {timeOf.format(tab.archivedAt)}
                      </time>
                      <span className={styles.bringBack} aria-hidden>
                        <ArchiveRestore size={14} strokeWidth={1.75} />
                        Bring back
                      </span>
                    </button>
                    <button type="button" className={styles.remove} aria-label={`Remove ${title} from the archive`} title="Remove from the archive" onClick={() => remove(tab)}>
                      <X size={14} strokeWidth={2} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {list?.more && (
          <button type="button" className={styles.more} onClick={() => setLimit(limit + PAGE)}>
            Show more
          </button>
        )}
      </main>
    </div>
  );
}

function titleOf(tab: ArchivedTab): string {
  return pageTitle({ url: tab.url, title: tab.title, customTitle: null }) || displayHost(tab.url) || tab.url;
}
