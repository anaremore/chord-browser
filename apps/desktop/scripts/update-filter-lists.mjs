// Refreshes the copies of EasyList and EasyPrivacy that every build of Chord
// bundles (build/ad-blocking/, ARCHITECTURE.md §9). Run before a release:
//
//   pnpm --filter @chord/desktop lists
//
// Installed copies refresh themselves from the lists' own host; this only keeps
// a fresh install from starting with old ones. Each download must be the list it
// claims to be (its title, a version, a plausible size) before it replaces the
// copy in the repository, and it's only ever read as text.
import { writeFile, rename } from 'node:fs/promises';
import { get } from 'node:https';
import { join } from 'node:path';
import { FILTER_LISTS, isList, listHeader } from '../src/main/ad-blocking/lists.ts';

process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exit(1);
});

/** node:https rather than fetch: Node 24's fetch trips an assertion on the host's `Connection: close` answers. */
function download(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { accept: 'text/plain' }, timeout: 60_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url}: HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`${url}: timed out`)));
    request.on('error', reject);
  });
}

const dir = join(import.meta.dirname, '..', 'build', 'ad-blocking');
for (const list of FILTER_LISTS) {
  const text = await download(list.url);
  if (!isList(text, list.name)) throw new Error(`${list.url} didn't return ${list.name}`);
  const file = join(dir, `${list.id}.txt`);
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
  console.log(`${list.name} ${listHeader(text).version}: ${(text.length / 1e6).toFixed(1)} MB`);
}
