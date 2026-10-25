#!/usr/bin/env node
/**
 * How far castLabs ECS (Electron with Widevine) trails Electron on security
 * fixes: for each Electron release whose notes name a CVE, the first ECS
 * build at or past it in the same major, and the wait. Spike S12
 * (docs/decisions/S12-widevine.md); run it again before revisiting D4.
 *
 *   node scripts/dev/ecs-lag.mjs [months=6]
 *
 * Uses GitHub's public API (GITHUB_TOKEN raises its rate limit). Its list of
 * ECS's stable `+wvcus` builds (`ecsStable`) is also what Chord Player's ECS
 * bump reads (apps/player/scripts/ecs-bump.mjs).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const headers = () => ({ accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });

export async function releases(repo, pages) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers: headers() });
    if (!res.ok) throw new Error(`${repo}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** `v44.9.3+wvcus` → [44, 9, 3]. */
export const version = (tag) => tag.replace(/^v/, '').split('+')[0].split('.').map(Number);
const atLeast = (a, b) => a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]));

/** Whether a castLabs tag is a stable Widevine build: `+wvcus`, no pre-release part, not marked a pre-release, not a draft. */
export const isStableEcs = (release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+\+wvcus$/.test(release.tag_name);

/** ECS's stable `+wvcus` builds, newest first: tag, version numbers, published date, and the release as GitHub gave it. */
export async function ecsStable(pages = 3) {
  return (await releases('castlabs/electron-releases', pages))
    .filter(isStableEcs)
    .map((r) => ({ tag: r.tag_name, v: version(r.tag_name), at: new Date(r.published_at), release: r }))
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
}

async function main() {
  const months = Number(process.argv[2] ?? 6);
  const since = new Date(Date.now() - months * 30.4 * 24 * 3600 * 1000);
  const ecs = await ecsStable();
  const fixes = (await releases('electron/electron', 4))
    .filter((r) => !r.prerelease && new Date(r.published_at) >= since)
    .map((r) => ({ tag: r.tag_name, v: version(r.tag_name), at: new Date(r.published_at), cves: [...new Set((r.body ?? '').match(/CVE-\d{4}-\d+/g) ?? [])] }))
    .filter((r) => r.cves.length > 0)
    .sort((a, b) => a.at - b.at);

  console.log(`Electron releases naming CVEs since ${since.toISOString().slice(0, 10)}, and the first ECS build at or past each:\n`);
  for (const fix of fixes) {
    const first = ecs.filter((e) => atLeast(e.v, fix.v) && e.at >= fix.at).sort((a, b) => a.at - b.at)[0];
    const wait = first ? `${Math.round((first.at - fix.at) / 3600000)} h` : 'none yet';
    console.log(`${fix.tag.padEnd(10)} ${String(fix.cves.length).padStart(2)} CVEs  ${fix.at.toISOString().slice(0, 10)}  ${(first?.tag ?? '').padEnd(22)} ${wait}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
