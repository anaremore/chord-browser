// A Widevine test page, for Chord Player's smoke test (smoke.mjs) and Chord's
// E2E test of it (apps/desktop/test/e2e/player.spec.ts): Shaka Player 5.3.2,
// pinned by its hash, plays Shaka's Angel One demo stream (Widevine, up to
// 768×576) with the no-auth test licence server, as spike S14 did. It needs
// the network: the stream, the licence and the CDM all come from it.
import { encodePng, RGBA } from '../../../scripts/png.mjs';

export const SHAKA = 'https://cdn.jsdelivr.net/npm/shaka-player@5.3.2/dist/shaka-player.compiled.js';
export const SHAKA_SRI = 'sha384-cNMtf7EC3JIqrwIpsr1hDQDbBR9rnVVLHCbjUgZPo9m72/iIz0wcktRKKc6OIsEE';
export const ANGEL_ONE = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd';
export const LICENCE = 'https://cwip-shaka-proxy.appspot.com/no_auth';

/** The page: the video fills it; its Media Session names the track; `links` are plain links for hand-off tests. */
export function watchPage({ links = [] } = {}) {
  const anchors = links.map(({ id, href, text }) => `<a id="${id}" href="${href}">${text}</a>`).join(' ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Angel One · Test service</title>
<script src="${SHAKA}" integrity="${SHAKA_SRI}" crossorigin="anonymous"></script>
<style>html,body{margin:0;height:100%;background:#000;color:#ccc;font:13px system-ui}video{display:block;width:100%;height:calc(100% - 24px)}a{color:#9cf;margin:4px}</style>
</head><body><video playsinline></video><nav>${anchors}</nav>
<script>
navigator.mediaSession.metadata = new MediaMetadata({ title: 'Angel One', artist: 'Shaka Player test streams', album: 'Widevine', artwork: [{ src: '/art.png', sizes: '128x128', type: 'image/png' }] });
window.playerError = null;
(async () => {
  try {
    shaka.polyfill.installAll();
    const video = document.querySelector('video');
    const player = new shaka.Player();
    await player.attach(video);
    player.configure({ drm: { servers: { 'com.widevine.alpha': ${JSON.stringify(LICENCE)} } } });
    player.addEventListener('error', (e) => { window.playerError = String(e.detail && e.detail.code); });
    await player.load(${JSON.stringify(ANGEL_ONE)});
    await video.play();
  } catch (e) {
    window.playerError = String((e && (e.code || e.message)) || e);
  }
})();
</script></body></html>`;
}

/** The track's artwork: a 128 px square in Chord's violet. */
export function artworkPng() {
  const side = 128;
  const row = Buffer.alloc(1 + side * 4);
  for (let x = 0; x < side; x++) row.set([124, 92, 255, 255], 1 + x * 4);
  return encodePng(side, side, RGBA, Buffer.concat(Array.from({ length: side }, () => row)));
}
