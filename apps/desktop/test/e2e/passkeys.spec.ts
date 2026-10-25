/**
 * Passkeys (ARCHITECTURE.md §9), end to end with Chromium's virtual
 * authenticator (DevTools' WebAuthn domain), so no system dialog is involved:
 * a page makes a passkey and signs in with it; with two on the authenticator,
 * Chord's card chooses (Electron cancels the sign-in when nobody chooses, even
 * with one passkey); Cancel declines. The site is `localhost`: a passkey needs
 * a domain, never an IP address.
 */
import { expect, test, type ElectronApplication } from '@playwright/test';
import { audit, expectClean, isPopover, isShell, launch, pageWhere, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const PAGE =
  '<title>Passkeys</title><script>' +
  'const rand = (n) => crypto.getRandomValues(new Uint8Array(n));' +
  "window.register = (name) => navigator.credentials.create({ publicKey: { rp: { name: 'Test', id: 'localhost' }, user: { id: new TextEncoder().encode(name), name: name + '@example.com', displayName: name }," +
  " challenge: rand(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } }).then((c) => c.id);" +
  "window.signIn = () => navigator.credentials.get({ publicKey: { challenge: rand(32), rpId: 'localhost', userVerification: 'required' } })" +
  ".then((a) => 'signed in as ' + new TextDecoder().decode(a.response.userHandle), (e) => e.name);" +
  '</script>';

let site: Site;
test.beforeAll(async () => {
  site = await startSite({ '/passkey': PAGE });
});
test.afterAll(() => site.server.close());

/** A virtual authenticator on the page, like a security key that holds passkeys and checks who you are. */
const addAuthenticator = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ webContents }, u) => {
    const page = webContents.getAllWebContents().find((c) => c.getURL() === u)!;
    page.debugger.attach('1.3');
    await page.debugger.sendCommand('WebAuthn.enable', { enableUI: false });
    await page.debugger.sendCommand('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
  }, url);

test('passkeys: make one and sign in with it; with two, Chord’s card chooses; Cancel declines', async () => {
  const url = `${site.other}/passkey`;
  const app = await launch({ CHORD_HOME_URL: url });
  try {
    await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    const page = await pageWhere(app, (u) => u === url);
    await addAuthenticator(app, url);
    const register = (name: string) => page.evaluate((n) => (window as unknown as { register(n: string): Promise<string> }).register(n), name);
    const signIn = () => page.evaluate(() => (window as unknown as { signIn(): Promise<string> }).signIn());

    // One passkey: it signs in as it is (you chose a passkey and touched the key).
    await register('alice');
    expect(await signIn()).toBe('signed in as alice');

    // Two: the card offers both, by the site's names, and the one you choose signs in.
    await register('bob');
    let result = signIn();
    const card = popover.getByRole('alertdialog', { name: 'Sign in to localhost with a passkey' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: /^alice/ })).toContainText('alice@example.com');
    expectClean(await audit(popover, 'passkey choice', { appearance: 'light' }));
    await card.getByRole('button', { name: /^bob/ }).click();
    expect(await result).toBe('signed in as bob');
    await expect(card).toHaveCount(0);

    // Cancel: the site hears it was declined.
    result = signIn();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Cancel' }).last().click();
    expect(await result).toBe('NotAllowedError');
  } finally {
    await app.close();
  }
});
