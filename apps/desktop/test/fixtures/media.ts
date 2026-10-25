/**
 * Pages that play sound, for the media tests (media.spec.ts, a11y.spec.ts):
 * no media files and no network. The sound is a sine tone written as a WAV in
 * the page and looped in an `<audio>`; a video, when asked for, is a canvas
 * streamed into a `<video>` (as launch.spec.ts's). Chromium reports the tab as
 * audible even with no sound device (Linux CI, the E2E container).
 */

export interface MediaPageOptions {
  /** The page's title (its tab's name). */
  title: string;
  /** What `navigator.mediaSession.metadata` says; none when absent. */
  track?: { title: string; artist: string; album: string; artwork?: string };
  /** Also play a 640 × 360 video. */
  video?: boolean;
  /** Start playing on load (the default). */
  autoplay?: boolean;
  /** How long the looped tone is. Chromium counts a player under 5 seconds as a short sound, not something you'd control. */
  seconds?: number;
}

export function mediaPage({ title, track, video = false, autoplay = true, seconds = 2 }: MediaPageOptions): string {
  const metadata = track
    ? `navigator.mediaSession.metadata = new MediaMetadata(${JSON.stringify({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.artwork ? [{ src: track.artwork, sizes: '128x128', type: 'image/png' }] : [],
      })});`
    : '';
  const canvas = video
    ? `<canvas id="c" width="640" height="360" hidden></canvas><video id="v" width="640" height="360"></video>` +
      `<script>{ const c = document.getElementById('c'), g = c.getContext('2d'); let n = 0;` +
      `setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 7) % 360 + ' 70% 50%)'; g.fillRect(0, 0, 640, 360); }, 40);` +
      `const v = document.getElementById('v'); v.srcObject = c.captureStream(25); v.play(); }</script>`
    : '';
  return (
    // Each script in a block of its own: the page's scripts share one global scope.
    `<title>${title}</title>${canvas}<audio id="a" loop></audio><script>{` +
    // A quiet 440 Hz tone, 16-bit mono at 8 kHz.
    `const rate = 8000, n = rate * ${seconds}, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);` +
    `const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };` +
    `w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);` +
    `d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);` +
    `w(36, 'data'); d.setUint32(40, n * 2, true);` +
    `for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 440 * i) / rate) * 4000, true);` +
    `const a = document.getElementById('a'); a.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));` +
    `${metadata}${autoplay ? 'a.play();' : ''}}</script>`
  );
}

/**
 * A video whose sound is its own (one element, as on most sites): a looping
 * tone in a 640 × 360 player. `muted`: the page mutes it itself, as a player
 * you muted does (Twitch remembers it), so the tab makes no sound.
 */
export function talkPage({ title = 'Talk', muted = false } = {}): string {
  return (
    `<title>${title}</title><video id="v" width="640" height="360" loop${muted ? ' muted' : ''}></video><script>{` +
    `const rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);` +
    `const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };` +
    `w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);` +
    `d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);` +
    `w(36, 'data'); d.setUint32(40, n * 2, true);` +
    `for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 330 * i) / rate) * 4000, true);` +
    `const v = document.getElementById('v'); v.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })); v.play();}</script>`
  );
}

/**
 * A player like Twitch's: its button (with Twitch's own data attributes) is the
 * player's state, and a play from outside (the video element played directly)
 * is undone at once, as a paused live stream doesn't resume that way.
 */
export function twitchPage(): string {
  return (
    `<title>Twitch</title><video id="v" width="640" height="360" loop></video>` +
    `<button data-a-target="player-play-pause-button" data-a-player-state="paused">Play</button><script>{` +
    `const rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);` +
    `const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };` +
    `w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);` +
    `d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);` +
    `w(36, 'data'); d.setUint32(40, n * 2, true);` +
    `for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 262 * i) / rate) * 4000, true);` +
    `const v = document.getElementById('v'), b = document.querySelector('button'); v.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));` +
    `let on = false; const set = (play) => { on = play; b.setAttribute('data-a-player-state', play ? 'playing' : 'paused'); if (play) v.play(); else v.pause(); };` +
    `v.addEventListener('play', () => { if (!on) v.pause(); }); b.addEventListener('click', () => set(!on)); set(true);}</script>`
  );
}

/** A 1 × 1 PNG, for artwork. */
export const ARTWORK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
