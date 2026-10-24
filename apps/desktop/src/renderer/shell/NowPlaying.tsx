/**
 * Now playing (DESIGN.md §7.10): a card at the bottom of the sidebar for media
 * playing in a tab you aren't looking at, in any of the window's chords. It
 * shows the tab (its icon and title, which go to it), what it plays when the
 * page's Media Session says (track, artist, artwork), and Play or Pause, Mute,
 * and picture-in-picture for a video. It offers what you left playing (or
 * played from it), not a background tab's own autoplay (main decides). Several
 * at once: the newest in full, up to two more as one-line rows, then "and N
 * more", which shows the rest.
 *
 * Main says what plays (main/media.ts); the card leaves out the tabs this
 * window shows, whose own controls are on screen. It sits outside the
 * sidebar's trees, so its buttons are ordinary Tab stops, each named for what
 * it does.
 */
import { cardMedia, type State, type TabNode } from '@chord/core';
import type { NowPlaying } from '@chord/ipc';
import { durations, space, type Appearance } from '@chord/tokens';
import { Pause, PictureInPicture, PictureInPicture2, Play, Volume2, VolumeX } from 'lucide-react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Favicon } from '../shared/Favicon';
import { inNextFrame } from '../shared/frames';
import { INSTANT } from '../shared/motion';
import { displayHost, pageTitle } from '../shared/site';
import { api } from './api';
import styles from './App.module.css';
import { keepFocusFrom } from './Toasts';

const ICON = { size: 14, strokeWidth: 2 } as const;

/** The media main says plays in this window's chords, newest first, kept up to date. */
function useNowPlaying(): NowPlaying[] {
  const [playing, setPlaying] = useState<NowPlaying[]>([]);
  useEffect(() => {
    // A push can arrive before the answer and be the newer of the two (live.ts says why): it wins.
    // It renders in the frame with the state patches (shared/frames.ts).
    let pushed = false;
    const show = inNextFrame(setPlaying);
    const unsubscribe = api.media.onState((list) => {
      pushed = true;
      show(list);
    });
    void api.media.view().then((list) => {
      if (!pushed) setPlaying(list);
    });
    return unsubscribe;
  }, []);
  return playing;
}

interface LineProps {
  media: NowPlaying;
  tab: TabNode;
  windowId: string;
  appearance: Appearance;
  muteTitle: { mute: string; unmute: string };
  onLeave(): void;
}

/** One more tab playing, as a row under the newest: its icon and title (which go to it), Mute, and Play or Pause. */
function Line({ media, tab, windowId, appearance, muteTitle, onLeave }: LineProps) {
  const muted = Boolean(tab.muted);
  const tabTitle = pageTitle(tab) || displayHost(tab.url) || 'New tab';
  const title = media.title || tabTitle;
  return (
    <div className={styles.nowPlayingLine}>
      <button
        type="button"
        className={styles.nowPlayingTab}
        title={`Go to ${tabTitle}`}
        onClick={() => {
          void api.state.dispatch({ t: 'tab.activate', windowId, nodeId: tab.id });
          onLeave();
        }}
      >
        <Favicon url={tab.url} title={tab.title} favicon={tab.favicon} appearance={appearance} />
        <span className="sr-only">Go to tab: </span>
        <span className={styles.ellipsis}>{title}</span>
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`${muted ? 'Unmute' : 'Mute'}: ${title}`}
        title={muted ? muteTitle.unmute : muteTitle.mute}
        onClick={() => void api.state.dispatch({ t: 'tab.mute', nodeId: tab.id, muted: !muted })}
      >
        {muted ? <VolumeX {...ICON} /> : <Volume2 {...ICON} />}
      </button>
      {media.pausable && (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`${media.playing ? 'Pause' : 'Play'}: ${title}`}
          title={media.playing ? 'Pause' : 'Play'}
          onClick={() => void api.media.act(tab.id, media.playing ? 'pause' : 'play')}
        >
          {media.playing ? <Pause {...ICON} fill="currentColor" /> : <Play {...ICON} fill="currentColor" />}
        </button>
      )}
    </div>
  );
}

/** Rows shown under the newest before "and N more". */
const LINES = 2;

interface CardProps {
  media: NowPlaying;
  tab: TabNode;
  /** Its video plays in Chord's picture-in-picture window. */
  popped: boolean;
  /** The other tabs playing, newest first, with their tabs. */
  others: { media: NowPlaying; tab: TabNode }[];
  windowId: string;
  appearance: Appearance;
  muteTitle: { mute: string; unmute: string };
  enter: Transition;
}

function Card({ media, tab, popped, others, windowId, appearance, muteTitle, enter }: CardProps) {
  // "And N more" shows the rest.
  const [all, setAll] = useState(false);
  const shownOthers = all ? others : others.slice(0, LINES);
  const hidden = others.length - shownOthers.length;
  const card = useRef<HTMLDivElement>(null);
  // Leaving with the keyboard inside, the card hands it to the sidebar's tabs rather than to nowhere.
  useLayoutEffect(() => {
    const el = card.current;
    return () => keepFocusFrom(el);
  }, []);
  const muted = Boolean(tab.muted);
  const tabTitle = pageTitle(tab) || displayHost(tab.url) || 'New tab';
  const byline = [media.artist, media.album].filter(Boolean).join(' · ');
  const exit = enter === INSTANT ? INSTANT : { duration: durations.fadeFast / 1000 };
  return (
    <motion.div
      ref={card}
      role="group"
      aria-label="Now playing"
      className={styles.nowPlaying}
      data-playing={media.playing || undefined}
      initial={{ opacity: 0, y: space[2] }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: space[1], transition: exit }}
      transition={enter}
    >
      {/* What it plays, when the page says (its Media Session); otherwise the tab's own line says it all. */}
      {media.title && (
        <div className={styles.nowPlayingTrack}>
          {media.artwork && <img className={styles.nowPlayingArt} src={media.artwork} alt="" />}
          <div className={styles.nowPlayingText}>
            <span className={`${styles.nowPlayingTitle} ${styles.ellipsis}`}>{media.title}</span>
            {byline && <span className={`${styles.nowPlayingByline} ${styles.ellipsis}`}>{byline}</span>}
          </div>
        </div>
      )}
      <div className={styles.nowPlayingBar}>
        <button
          type="button"
          className={styles.nowPlayingTab}
          title={`Go to ${tabTitle}`}
          onClick={() => {
            void api.state.dispatch({ t: 'tab.activate', windowId, nodeId: tab.id });
            keepFocusFrom(card.current);
          }}
        >
          <Favicon url={tab.url} title={tab.title} favicon={tab.favicon} appearance={appearance} />
          <span className="sr-only">Go to tab: </span>
          <span className={styles.ellipsis}>{tabTitle}</span>
        </button>
        {(media.video || popped) && (
          <button
            type="button"
            className={styles.iconButton}
            // Popped out (by Chord or by the site): back into its tab, which comes on screen, as the
            // picture-in-picture window's own "back to tab" does.
            aria-label={popped ? 'Back to the tab' : 'Pop out the video'}
            aria-pressed={popped}
            title={popped ? 'Back to the tab' : 'Pop out the video'}
            onClick={() => void api.media.act(tab.id, 'pictureInPicture')}
          >
            {popped ? <PictureInPicture {...ICON} /> : <PictureInPicture2 {...ICON} />}
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={muted ? 'Unmute tab' : 'Mute tab'}
          title={muted ? muteTitle.unmute : muteTitle.mute}
          onClick={() => void api.state.dispatch({ t: 'tab.mute', nodeId: tab.id, muted: !muted })}
        >
          {muted ? <VolumeX {...ICON} /> : <Volume2 {...ICON} />}
        </button>
        {media.pausable && (
          <button
            type="button"
            className={styles.nowPlayingPlay}
            aria-label={media.playing ? 'Pause' : 'Play'}
            title={media.playing ? 'Pause' : 'Play'}
            onClick={() => void api.media.act(tab.id, media.playing ? 'pause' : 'play')}
          >
            {/* Filled, the one glyph on the accent (DESIGN.md §4.6). */}
            {media.playing ? <Pause {...ICON} fill="currentColor" /> : <Play {...ICON} fill="currentColor" />}
          </button>
        )}
      </div>
      {shownOthers.length > 0 && (
        <div className={styles.nowPlayingOthers}>
          {shownOthers.map((o) => (
            <Line key={o.tab.id} media={o.media} tab={o.tab} windowId={windowId} appearance={appearance} muteTitle={muteTitle} onLeave={() => keepFocusFrom(card.current)} />
          ))}
          {hidden > 0 && (
            <button type="button" className={styles.nowPlayingMore} onClick={() => setAll(true)}>
              and {hidden} more
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

/**
 * The card, while something plays (or paused a minute ago) in a tab the
 * window isn't showing. `enter`: its spring, from "Animate the sidebar"
 * (instant when that's off; opacity only with reduced motion).
 */
export function NowPlayingCard({
  state,
  windowId,
  appearance,
  muteTitle,
  enter,
}: {
  state: State;
  windowId: string;
  appearance: Appearance;
  muteTitle: { mute: string; unmute: string };
  enter: Transition;
}) {
  // Newest first: the newest in full, the rest as rows.
  const offered = cardMedia(state, windowId, useNowPlaying()).flatMap((media) => {
    const tab = state.nodes[media.nodeId];
    return tab?.kind === 'tab' ? [{ media, tab }] : [];
  });
  const [first, ...others] = offered;
  return (
    <AnimatePresence initial={false}>
      {first && (
        <Card
          key="now-playing"
          media={first.media}
          tab={first.tab}
          popped={Boolean(state.live[first.tab.id]?.pip) || first.media.pip}
          others={others}
          windowId={windowId}
          appearance={appearance}
          muteTitle={muteTitle}
          enter={enter}
        />
      )}
    </AnimatePresence>
  );
}
