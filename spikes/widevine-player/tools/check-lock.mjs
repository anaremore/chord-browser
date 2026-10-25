// Checks the navigation lock (shared/allowlist.mjs) against what the census saw:
// for each service, the pages and frames its home and sign-in pages used that
// the lock would hand to Chord or block. Plain Node.
//   node tools/check-lock.mjs <census.json>
import { readFileSync } from 'node:fs';
import { makeLock } from '../shared/allowlist.mjs';

const census = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const lock = makeLock();
const report = {};
for (const service of census.services) {
  const pages = new Set();
  const frames = new Set();
  for (const step of service.steps) {
    for (const url of step.mainFrameRequests ?? []) pages.add(url);
    for (const url of step.popupWindowUrls ?? []) pages.add(url);
    for (const url of Object.values(step.subFrameRequests ?? {})) frames.add(url);
  }
  const host = (u) => {
    try {
      return new URL(u.replace('?…', '')).hostname;
    } catch {
      return u;
    }
  };
  report[service.name] = {
    pagesSeen: [...new Set([...pages].map(host))],
    pagesHandedToChord: [...new Set([...pages].filter((u) => !lock.page(u.replace('?…', ''))).map(host))],
    framesSeen: [...new Set([...frames].map(host))],
    framesBlocked: [...new Set([...frames].filter((u) => !lock.frame(u.replace('?…', ''))).map((u) => u.replace(/^https:\/\//, '').slice(0, 70)))],
  };
}
// And some addresses the lock must refuse.
const refused = ['https://www.google.com/search?q=x', 'https://en.wikipedia.org/', 'http://www.netflix.com/', 'https://netflix.com.evil.example/', 'https://www.amazon.com/dp/B000', 'https://open.spotify.com.example.org/'];
report.mustRefuse = Object.fromEntries(refused.map((u) => [u, lock.page(u) ? 'ALLOWED (bad)' : 'refused']));
const allowed = ['https://www.netflix.com/browse', 'https://www.amazon.de/gp/video/detail/x', 'https://www.amazon.com/ap/signin?x', 'https://accounts.spotify.com/en/login', 'https://accounts.google.com/o/oauth2/auth'];
report.mustAllow = Object.fromEntries(allowed.map((u) => [u, lock.page(u) ? 'allowed' : 'REFUSED (bad)']));
console.log(JSON.stringify(report, null, 2));
