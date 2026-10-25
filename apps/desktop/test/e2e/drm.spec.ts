/**
 * The DRM notice (ARCHITECTURE.md §16, D4): on a service that needs Widevine,
 * the popover says it won't play in Chord yet, with Open in… other browsers on
 * this computer. The services' addresses are this machine
 * (--host-resolver-rules). On Linux a stand-in google-chrome on the PATH
 * records what it's asked to open; elsewhere the computer's own browsers are
 * listed but never started.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { audit, capturesDir, dispatch, expectClean, isPopover, isShell, launch, pageWhere, startSite, where, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

let site: Site;
test.beforeAll(async () => {
  site = await startSite({
    '/': '<title>Home</title><p>Nothing to watch here.</p>',
    '/browse': '<title>Netflix</title><p>Browse.</p>',
    '/watch': '<title>Netflix</title><p>Watching.</p>',
    '/hulu': '<title>Hulu</title><p>Hulu.</p>',
  });
});
test.afterAll(() => site.server.close());

const port = () => new URL(site.origin).port;

test('on Netflix the popover says it won’t play here yet; Open in Chrome opens the page there, and Not now hides it for that service', async () => {
  const linux = process.platform === 'linux';
  // A stand-in Chrome: it writes down what it was asked to open.
  const bin = mkdtempSync(join(tmpdir(), 'chord-browsers-'));
  const opened = join(bin, 'opened.txt');
  if (linux) {
    writeFileSync(join(bin, 'google-chrome-stable'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${opened}'\n`);
    chmodSync(join(bin, 'google-chrome-stable'), 0o755);
  }
  const app = await launch(
    { CHORD_HOME_URL: `${site.origin}/`, ...(linux ? { PATH: `${bin}:${process.env['PATH'] ?? ''}` } : {}) },
    { args: ['--host-resolver-rules=MAP www.netflix.com 127.0.0.1, MAP www.hulu.com 127.0.0.1'] },
  );
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    const notice = popover.getByRole('dialog', { name: /won’t play in Chord yet/ });
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Home');
    await expect(notice).toHaveCount(0);

    const { windowId } = await where(shell);
    const watch = `http://www.netflix.com:${port()}/watch`;
    await dispatch(shell, { t: 'tab.open', windowId, url: watch });
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAccessibleName('Netflix won’t play in Chord yet');
    await expect(notice).toContainText('Widevine');
    expectClean(await audit(popover, 'DRM notice', { appearance: 'light' }));
    await notice.screenshot({ path: join(capturesDir, 'drm-notice.png') });

    if (linux) {
      await notice.getByRole('button', { name: 'Open in Chrome' }).click();
      await expect.poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8').trim() : null)).toBe(watch);
      await expect(notice).toHaveCount(0);
    } else {
      await notice.getByRole('button', { name: 'Not now' }).click();
      await expect(notice).toHaveCount(0);
    }
    // Netflix's other pages don't ask again until Chord quits.
    await dispatch(shell, { t: 'tab.open', windowId, url: `http://www.netflix.com:${port()}/browse` });
    await expect(shell.getByRole('tree', { name: 'Today' }).getByRole('treeitem', { name: 'Netflix' })).toHaveCount(2);
    await popover.waitForTimeout(500);
    await expect(notice).toHaveCount(0);

    // Another service still does; Not now hides it.
    await dispatch(shell, { t: 'tab.open', windowId, url: `http://www.hulu.com:${port()}/hulu` });
    const hulu = popover.getByRole('dialog', { name: 'Hulu won’t play in Chord yet' });
    await expect(hulu).toBeVisible();
    await hulu.getByRole('button', { name: 'Not now' }).click();
    await expect(hulu).toHaveCount(0);
  } finally {
    await app.close();
  }
});
