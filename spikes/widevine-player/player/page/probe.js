// What the player's main process asks of the page: EME support, Widevine
// playback through Shaka Player, picture-in-picture and fullscreen.
const LICENCE = 'https://cwip-shaka-proxy.appspot.com/no_auth';
const video = document.querySelector('video');
const label = document.getElementById('label');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keysSeen = [];
document.addEventListener('keydown', (e) => keysSeen.push(`${e.ctrlKey ? 'Ctrl+' : ''}${e.metaKey ? 'Meta+' : ''}${e.key}`));

async function waitFor(test, ms) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (test()) return performance.now() - start;
    await sleep(50);
  }
  return null;
}

const VIDEO = {
  avc1: 'video/mp4; codecs="avc1.42E01E"',
  vp9: 'video/webm; codecs="vp9"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
};
const AUDIO = { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' };
const ROBUSTNESS = ['', 'SW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'HW_SECURE_DECODE', 'HW_SECURE_ALL'];

async function access(keySystem, config) {
  try {
    const a = await navigator.requestMediaKeySystemAccess(keySystem, [config]);
    const c = a.getConfiguration();
    return { ok: true, robustness: c.videoCapabilities?.[0]?.robustness ?? null, sessionTypes: c.sessionTypes, persistentState: c.persistentState, distinctiveIdentifier: c.distinctiveIdentifier, access: a };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}`.slice(0, 160) };
  }
}
const plain = ({ access: _a, ...rest }) => rest;

window.probe = {
  keysSeen,
  async eme() {
    const out = { robustness: {}, other: {} };
    for (const [codec, contentType] of Object.entries(VIDEO)) {
      out.robustness[codec] = {};
      for (const robustness of ROBUSTNESS) {
        const r = await access('com.widevine.alpha', { initDataTypes: ['cenc'], videoCapabilities: [{ contentType, robustness }], audioCapabilities: [AUDIO] });
        out.robustness[codec][robustness || '(none)'] = r.ok ? 'yes' : 'no';
      }
    }
    const base = { initDataTypes: ['cenc'], videoCapabilities: [{ contentType: VIDEO.avc1, robustness: 'SW_SECURE_CRYPTO' }], audioCapabilities: [AUDIO] };
    out.other.persistentLicense = plain(await access('com.widevine.alpha', { ...base, sessionTypes: ['persistent-license'], persistentState: 'required' }));
    out.other.persistentState = plain(await access('com.widevine.alpha', { ...base, persistentState: 'required' }));
    out.other.distinctiveIdentifier = plain(await access('com.widevine.alpha', { ...base, distinctiveIdentifier: 'required' }));
    out.other.cbcs = plain(await access('com.widevine.alpha', { ...base, videoCapabilities: [{ contentType: VIDEO.avc1, robustness: 'SW_SECURE_CRYPTO', encryptionScheme: 'cbcs' }] }));
    out.other.experimentKeySystem = plain(await access('com.widevine.alpha.experiment', base));
    out.other.playready = plain(await access('com.microsoft.playready.recommendation', base));
    out.other.clearkey = plain(await access('org.w3.clearkey', { initDataTypes: ['cenc'], videoCapabilities: [{ contentType: VIDEO.avc1 }] }));
    // HDCP: what the CDM reports for output protection (Chrome's getStatusForPolicy).
    const a = await access('com.widevine.alpha', base);
    out.hdcp = {};
    if (a.ok) {
      const keys = await a.access.createMediaKeys();
      for (const v of ['1.0', '1.4', '2.2', '2.3']) {
        try {
          out.hdcp[v] = await keys.getStatusForPolicy({ minHdcpVersion: v });
        } catch (e) {
          out.hdcp[v] = `${e.name}`;
        }
      }
    }
    return out;
  },

  async play(manifest, { seconds = 6, pick = null, title = 'Widevine test' } = {}) {
    shaka.polyfill.installAll();
    if (this.player) await this.player.destroy();
    const player = new shaka.Player();
    await player.attach(video);
    this.player = player;
    const errors = [];
    const licence = [];
    player.addEventListener('error', (e) => errors.push(`${e.detail?.code} ${e.detail?.message ?? ''}`.trim()));
    player.configure({ drm: { servers: { 'com.widevine.alpha': LICENCE } }, abr: { enabled: !pick }, streaming: { bufferingGoal: 12 } });
    // Shaka keeps one codec family per load; ask for the one being tested.
    if (pick?.codec) player.configure({ preferredVideoCodecs: [pick.codec], preferences: { videoCodecs: [pick.codec] } });
    const net = player.getNetworkingEngine();
    net.registerRequestFilter((type, request) => {
      if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) request.__t = performance.now();
    });
    net.registerResponseFilter((type, response, ctx) => {
      if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) licence.push({ status: response.status ?? null, bytes: response.data?.byteLength ?? null, uri: response.uri?.replace(/\?.*/, '') });
    });
    const t0 = performance.now();
    try {
      await player.load(manifest);
    } catch (e) {
      return { ok: false, error: `load: ${e.code ?? ''} ${e.message ?? e}`.trim(), errors, licence };
    }
    let chosen = null;
    if (pick) {
      const tracks = player
        .getVariantTracks()
        .filter((t) => (!pick.width || t.width === pick.width) && (!pick.height || t.height === pick.height) && (!pick.codec || (t.videoCodec || '').replace(/^vp09/, 'vp9').startsWith(pick.codec)))
        .sort((a, b) => b.bandwidth - a.bandwidth);
      chosen = tracks[0] ?? null;
      if (chosen) player.selectVariantTrack(chosen, true);
    }
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Shaka demo assets', album: manifest.split('/').slice(-2)[0] });
    label.textContent = `${title} · ${manifest.split('/').slice(-2)[0]}`;
    video.muted = true;
    try {
      await video.play();
    } catch (e) {
      errors.push(`play(): ${e.name}`);
    }
    const firstFrameMs = await waitFor(() => video.currentTime > 0.3, 25_000);
    const loadToFirstFrameMs = firstFrameMs === null ? null : Math.round(performance.now() - t0);
    const start = video.currentTime;
    await sleep(seconds * 1000);
    const q = video.getVideoPlaybackQuality();
    const active = player.getVariantTracks().find((t) => t.active);
    let keyStatuses = null;
    try {
      keyStatuses = player.getKeyStatuses();
    } catch {}
    const stats = player.getStats();
    return {
      ok: firstFrameMs !== null && video.currentTime - start > seconds * 0.5,
      loadToFirstFrameMs,
      advanced: +(video.currentTime - start).toFixed(2),
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      requested: chosen && { width: chosen.width, height: chosen.height, codec: chosen.videoCodec, bandwidth: chosen.bandwidth },
      tracks: player.getVariantTracks().map((t) => `${t.width}x${t.height} ${t.videoCodec}`).filter((v, i, a) => a.indexOf(v) === i),
      active: active && { width: active.width, height: active.height, codec: active.videoCodec },
      frames: { total: q.totalVideoFrames, dropped: q.droppedVideoFrames },
      keyStatuses,
      licenceTimeS: stats.licenseTime,
      drmTimeS: stats.drmTimeSeconds,
      keySystem: player.drmInfo()?.keySystem ?? null,
      robustness: player.drmInfo()?.videoRobustness ?? null,
      licence,
      errors,
    };
  },

  state() {
    return { paused: video.paused, muted: video.muted, currentTime: +video.currentTime.toFixed(2), title: navigator.mediaSession?.metadata?.title ?? document.title, keysSeen: [...keysSeen] };
  },

  async pip() {
    if (video.paused) await video.play().catch(() => {});
    try {
      const w = await video.requestPictureInPicture();
      const t = video.currentTime;
      await sleep(3000);
      const r = { ok: true, window: { width: w.width, height: w.height }, element: document.pictureInPictureElement === video, advancedInPip: +(video.currentTime - t).toFixed(2), paused: video.paused };
      await document.exitPictureInPicture();
      return r;
    } catch (e) {
      return { ok: false, error: `${e.name}: ${e.message}` };
    }
  },

  async fullscreen() {
    try {
      await video.requestFullscreen();
      return { ok: true, element: document.fullscreenElement === video };
    } catch (e) {
      return { ok: false, error: `${e.name}: ${e.message}` };
    }
  },
};

// ?play=<manifest>: start at once (the control-channel scenarios).
const params = new URLSearchParams(location.search);
if (params.get('play')) window.probe.play(params.get('play'), { seconds: 1, title: params.get('title') ?? 'Angel One' }).then((r) => (window.autoplay = r));
