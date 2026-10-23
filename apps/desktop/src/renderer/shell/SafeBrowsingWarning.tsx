/**
 * Safe Browsing's warning (ARCHITECTURE.md §14.1, DESIGN.md §9): in the
 * content frame, like a load error, instead of a page (or a page with a
 * frame) on one of Google's lists. Its wording never says the site is
 * certainly unsafe. The way out is the main button; "Visit anyway" waits
 * behind Details. Google's page about the threat and its advisory are a
 * click away, as Google's terms ask.
 */
import { describeThreat, SAFE_BROWSING_ADVISORY, THREAT_LEARN_MORE, type PageThreat } from '@chord/core';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { useId } from 'react';
import { displayHost } from '../shared/site';
import { api } from './api';
import styles from './SafeBrowsingWarning.module.css';

export function SafeBrowsingWarning({ threat, nodeId, windowId }: { threat: PageThreat; nodeId: string; windowId: string }) {
  const host = displayHost(threat.url);
  const frameHost = threat.frameUrl ? displayHost(threat.frameUrl) : null;
  const copy = describeThreat(threat, host, frameHost);
  const learn = THREAT_LEARN_MORE[threat.kind];
  const titleId = useId();
  const bodyId = useId();
  // Google's pages open as a tab beside this one; the warning stays.
  const open = (url: string) => void api.state.dispatch({ t: 'tab.open', windowId, url });
  return (
    <div className={styles.warning} role="alert" aria-labelledby={titleId} aria-describedby={bodyId} data-kind={threat.kind} data-page-state data-safe-browsing>
      <span className={styles.icon} aria-hidden>
        <ShieldAlert size={24} strokeWidth={1.75} />
      </span>
      <p id={titleId} className={styles.title}>
        {copy.title}
      </p>
      <p id={bodyId} className={styles.body}>
        {copy.body}
      </p>
      <button type="button" className={styles.learn} onClick={() => open(learn.url)}>
        {learn.label}
      </button>
      <button type="button" className={styles.primary} onClick={() => void api.safeBrowsing.back(nodeId)}>
        Back to safety
      </button>
      <details className={styles.details}>
        <summary className={styles.summary}>
          <ChevronRight className={styles.chevron} size={14} strokeWidth={2} aria-hidden />
          Details
        </summary>
        <div className={styles.more}>
          <p className={styles.note}>
            {frameHost
              ? `If you trust this page, you can open it anyway. Chord won’t warn you about ${frameHost} again until you quit.`
              : `If you trust this site, you can visit it anyway. Chord won’t warn you about ${host || 'it'} again until you quit.`}
          </p>
          <button type="button" className={styles.secondary} onClick={() => void api.safeBrowsing.proceed(nodeId)}>
            Visit anyway
          </button>
        </div>
      </details>
      <button type="button" className={styles.advisory} onClick={() => open(SAFE_BROWSING_ADVISORY.url)}>
        {SAFE_BROWSING_ADVISORY.label}
      </button>
    </div>
  );
}
