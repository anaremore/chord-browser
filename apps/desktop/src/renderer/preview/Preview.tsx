/**
 * A hover preview (DESIGN.md §7.6): a pinned tab's last picture with its
 * title, site and when it was opened, or a folder's first tabs. Main sends the
 * card and places this view beside the sidebar; the view is sized to the card.
 */
import type { PreviewCard, SystemInfo } from '@chord/ipc';
import type { Appearance } from '@chord/tokens';
import { Folder } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Favicon } from '../shared/Favicon';
import { displayHost } from '../shared/site';
import { chordStyle } from '../shared/theme';
import { api } from './api';
import styles from './Preview.module.css';

type TabCard = Extract<PreviewCard, { kind: 'tab' }>;
type FolderCard = Extract<PreviewCard, { kind: 'folder' }>;

function TabPreview({ card, appearance }: { card: TabCard; appearance: Appearance }) {
  const host = displayHost(card.url);
  return (
    <>
      <div className={styles.thumb}>
        {card.thumbnail ? (
          <img className={styles.picture} src={card.thumbnail} alt="" draggable={false} />
        ) : (
          // Never pictured yet: its icon on the chord's tint.
          <div className={styles.fallback} data-fallback>
            <span className={styles.bigIcon}>
              <Favicon url={card.url} title={card.title} favicon={card.favicon} appearance={appearance} />
            </span>
          </div>
        )}
      </div>
      <div className={styles.text}>
        <p className={styles.title}>{card.title || host || 'New tab'}</p>
        {host && <p className={styles.host}>{host}</p>}
        <p className={styles.opened}>{card.opened}</p>
      </div>
    </>
  );
}

function FolderPreview({ card, appearance }: { card: FolderCard; appearance: Appearance }) {
  return (
    <div className={styles.folder}>
      <p className={styles.folderTitle}>
        <Folder size={14} strokeWidth={1.75} aria-hidden />
        <span className={styles.ellipsis}>{card.title}</span>
      </p>
      {card.rows.length === 0 ? (
        <p className={styles.more}>Nothing in it yet.</p>
      ) : (
        <ul className={styles.rows}>
          {card.rows.map((row, i) => (
            <li key={`${i}:${row.url}`} className={styles.row}>
              <Favicon url={row.url} title={row.title} favicon={row.favicon} appearance={appearance} />
              <span className={styles.ellipsis}>{row.title || displayHost(row.url) || 'New tab'}</span>
            </li>
          ))}
        </ul>
      )}
      {card.more > 0 && <p className={styles.more}>and {card.more} more</p>}
    </div>
  );
}

export function Preview({ initialInfo }: { initialInfo: SystemInfo }) {
  const [info, setInfo] = useState(initialInfo);
  const [card, setCard] = useState<PreviewCard | null>(null);
  useEffect(() => api.system.onChange(setInfo), []);
  useEffect(() => api.preview.onCard(setCard), []);
  const root = useRef<HTMLDivElement>(null);

  // Main sizes the view to the card; with no card, it hides.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void api.preview.size(card ? r.width : 0, card ? r.height : 0);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [card]);

  const { style, appearance } = chordStyle(card ? { theme: card.theme } : null, info, card?.interface);
  return (
    <div ref={root} className={styles.root} style={style} data-still={(card && !card.animate) || undefined}>
      {card && (
        <div className={styles.card} role="tooltip" aria-label={card.kind === 'tab' ? `Preview of ${card.title || displayHost(card.url)}` : `Folder ${card.title}`}>
          {/* Keyed by row: moving to another one swaps the content with a quick crossfade (DESIGN.md §7.6). */}
          <div key={card.id} className={styles.content} data-kind={card.kind}>
            {card.kind === 'tab' ? <TabPreview card={card} appearance={appearance} /> : <FolderPreview card={card} appearance={appearance} />}
          </div>
        </div>
      )}
    </div>
  );
}
