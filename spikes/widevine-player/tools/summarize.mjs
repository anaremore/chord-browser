// Prints the numbers the decision record quotes, from one or more results
// folders (run.mjs --out, or a downloaded CI artifact).
//   node tools/summarize.mjs <results folder> [more folders…]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : null);
const play = (r) => r && { ok: r.ok, size: `${r.videoWidth}x${r.videoHeight}`, ttffMs: r.loadToFirstFrameMs, dropped: `${r.frames?.dropped}/${r.frames?.total}`, robustness: r.robustness, keys: r.keyStatuses && [...new Set(Object.values(r.keyStatuses))].join(','), error: r.error ?? (r.errors?.length ? r.errors.join('; ') : undefined), requested: r.requested && `${r.requested.width}x${r.requested.height} ${r.requested.codec}`, capturedLuma: r.capture?.middleMeanLuma };
const metrics = (m) => m && { cpu: m.totalCpu, wsMB: m.totalWsMB, privateMB: m.totalPrivateMB || undefined, pssMB: m.totalPssMB || undefined, byType: m.processes.map((p) => `${p.name ?? p.type}:${p.cpu}%/${p.privateMB ?? p.pssMB ?? p.wsMB}MB`).join(' ') };

for (const dir of process.argv.slice(2)) {
  const summary = read(join(dir, 'summary.json'));
  const probe = read(join(dir, 'probe', 'probe.json'));
  const host = read(join(dir, 'host', 'host.json'));
  const out = { dir, platform: summary?.platform ?? probe?.platform, arch: summary?.arch };
  if (summary?.fetch) out.download = { ecs: pick(summary.fetch.ecs, ['asset', 'zipBytes', 'unpackedBytes']), electron: pick(summary.fetch.electron, ['asset', 'zipBytes', 'unpackedBytes']) };
  if (probe) {
    out.versions = probe.versions;
    out.cdm = { ...probe.cdm, files: probe.cdmFiles };
    out.eme = { avc1: probe.eme?.robustness?.avc1, hevc: probe.eme?.robustness?.hevc?.['(none)'], av1: probe.eme?.robustness?.av1?.['(none)'], persistentLicense: probe.eme?.other?.persistentLicense?.ok, cbcs: probe.eme?.other?.cbcs?.ok, experiment: probe.eme?.other?.experimentKeySystem?.ok, playready: probe.eme?.other?.playready?.ok, hdcp: probe.eme?.hdcp };
    out.angel = play(probe.angel);
    out.sintel = probe.sintel && Object.fromEntries(Object.entries(probe.sintel).map(([k, v]) => [k, play(v)]));
    out.pip = probe.pip;
    out.fullscreen = pick(probe.fullscreen, ['ok', 'windowFullScreen', 'bounds', 'display']);
    out.metricsIdle = metrics(probe.metricsIdle);
    out.metricsPlaying1080 = metrics(probe.metricsPlaying1080);
    out.probeMs = probe.totalMs;
  }
  for (const step of ['nocu-installed', 'nocu-fresh', 'second-launch', 'idle']) {
    const p = read(join(dir, step, 'probe.json'));
    if (p) out[step] = { cdm: p.cdm?.outcome, widevine: p.eme?.robustness?.avc1?.SW_SECURE_CRYPTO, angel: p.angel?.ok, error: p.angel?.error };
  }
  out.netlog = summary && Object.fromEntries(Object.entries(summary).filter(([k]) => k.startsWith('netlog')).map(([k, v]) => [k, v && Object.keys(v)]));
  out.profileAfterProbeBytes = summary?.profileAfterProbeBytes;
  if (host) {
    out.display = host.display;
    out.scenarios = {};
    for (const [name, s] of Object.entries(host.scenarios)) {
      if (s.error) {
        out.scenarios[name] = { error: s.error.split('\n')[0] };
        continue;
      }
      if (name === 'navlock') out.scenarios[name] = { allPass: s.allPass, failed: Object.entries(s.tests).filter(([, t]) => !t.pass).map(([k, t]) => `${k}: ${t.url} ${t.handedToChord.join(',')}`) };
      else if (name.startsWith('glue') || name === 'child')
        out.scenarios[name] = {
          realDrag: s.realDrag,
          programmaticDrag: s.programmaticDrag,
          programmaticResize: s.programmaticResize,
          minimized: s.minimized,
          restored: s.restored,
          hidden: s.hidden,
          zorder: s.zorderAfterHostFocus,
          focus: s.focus,
          apps: s.appsWhilePlayerFocused,
          osFocus: s.osFocus ?? s.input,
          shortcut: s.shortcut,
          shortcutInjected: s.shortcutInjected,
          altTab: s.altTab ?? s.after?.altTab,
          taskbar: s.taskbar,
          macApps: s.apps,
          fullscreen: s.fullscreen && pick(s.fullscreen, ['entered', 'bounds', 'display', 'backInPlace', 'childRect', 'hostRect', 'playerThinks']),
          hang: s.hang,
          adopt: s.adopt,
          composite: s.composite,
          overlay: s.overlay,
          before: s.before,
          afterChildren: s.after?.hostChildren,
          wayland: s.wayland,
          samplerError: s.samplerError,
        };
      else out.scenarios[name] = s;
    }
  }
  console.log(JSON.stringify(out, null, 1));
}
