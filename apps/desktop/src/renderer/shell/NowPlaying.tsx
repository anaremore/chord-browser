/**
 * Now playing (DESIGN.md §7.10): a card at the bottom of the sidebar for media
 * playing in a tab you aren't looking at, in any of the window's chords. It
 * shows the tab (its icon and title, which go to it), what it plays when the
 * page's Media Session says (track, artist, artwork), and Play or Pause, Mute,
 * and picture-in-picture for a video. Several tabs playing: the newest, with
 * a button that steps through the others.
 *
 * Main says what plays (main/media.ts); the card leaves out the tabs this
 * window shows, whose own controls are on screen. It sits outside the
 * sidebar's trees, so its buttons are ordinary Tab stops, each named for what
 * it does.
 */
import { cardMedia, type State, type TabNode } from '@chord/core';
import type { NowPlaying } from '@chord/ipc';
import { durations, space, type Appearance } from '@chord/tokens';
import { ChevronRight, Pause, PictureInPicture2, Play, Volume2, VolumeX } from 'lucide-react';
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

interface CardProps {
  media: NowPlaying;
  tab: TabNode;
  /** Its video plays in Chord's picture-in-picture window. */
  popped: boolean;
  /** Where it is among the tabs playing (from 0), and how many there are. */
  at: number;
  count: number;
  windowId: string;
  appearance: Appearance;
  muteTitle: { mute: string; unmute: string };
  enter: Transition;
  onNext(): void;
}

function Card({ media, tab, popped, at, count, windowId, appearance, muteTitle, enter, onNext }: CardProps) {
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
        {count > 1 && (
          <button type="button" className={`${styles.iconButton} ${styles.nowPlayingNext}`} title="Next playing tab" onClick={onNext}>
            {/* Named by what it shows too: "Next playing tab, 1 of 2". */}
            <span className="sr-only">Next playing tab, </span>
            {at + 1} of {count}
            <ChevronRight {...ICON} aria-hidden />
          </button>
        )}
        {(media.video || popped) && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={popped ? 'Bring the video back' : 'Pop out the video'}
            title={popped ? 'Bring the video back' : 'Pop out the video'}
            onClick={() => void api.media.act(tab.id, 'pictureInPicture')}
          >
            <PictureInPicture2 {...ICON} />
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
  const offered = cardMedia(state, windowId, useNowPlaying());
  // The tab the card shows: the newest, until you step to another (and while that one's still there).
  const [chosen, setChosen] = useState<string | null>(null);
  const at = Math.max(0, offered.findIndex((p) => p.nodeId === chosen));
  const media = offered[at];
  const tab = media ? (state.nodes[media.nodeId] as TabNode) : undefined;
  return (
    <AnimatePresence initial={false}>
      {media && tab && (
        <Card
          key="now-playing"
          media={media}
          tab={tab}
          popped={Boolean(state.live[tab.id]?.pip)}
          at={at}
          count={offered.length}
          windowId={windowId}
          appearance={appearance}
          muteTitle={muteTitle}
          enter={enter}
          onNext={() => setChosen(offered[(at + 1) % offered.length]!.nodeId)}
        />
      )}
    </AnimatePresence>
  );
}
