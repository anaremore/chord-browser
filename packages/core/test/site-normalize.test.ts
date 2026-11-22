import { describe, expect, it } from 'vitest';
import { loginSite } from '../src/password-sites';

// Neon's review of #110: a site is one site however its host is written (a trailing dot, capitals, an IDN).
describe('loginSite: one site, however the host is written', () => {
  it.each([
    ['https://bank.example./x', 'bank.example'],
    ['https://login.bank.example./', 'bank.example'],
    ['https://BANK.example/', 'bank.example'],
    ['https://bücher.example/', 'xn--bcher-kva.example'],
    ['http://localhost.:8080/', 'localhost:8080'],
  ])('%s → %s', (url, site) => expect(loginSite(url)).toBe(site));
});
