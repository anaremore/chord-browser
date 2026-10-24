/**
 * Ad and tracker blocking (ARCHITECTURE.md §9, decision D5): which sites it's
 * off for, and what its notice tells you about the lists' host.
 */
import { describe, expect, it } from 'vitest';
import { AD_BLOCKING_NOTICE, blockingSite, cleanOffSites, isBlockingOff, MAX_OFF_SITES } from '../src';

describe('ad blocking', () => {
  it('turns off for a site, its subdomains included', () => {
    expect(blockingSite('https://www.nytimes.com/2026/10/24/world.html')).toBe('nytimes.com');
    expect(blockingSite('cooking.nytimes.com')).toBe('nytimes.com');
    expect(blockingSite('https://news.bbc.co.uk/')).toBe('bbc.co.uk');
    expect(blockingSite('localhost')).toBe('localhost');
    expect(blockingSite('chord://settings')).toBeNull();
    expect(blockingSite('not a site')).toBeNull();
    const off = ['nytimes.com'];
    expect(isBlockingOff('https://www.nytimes.com/', off)).toBe(true);
    expect(isBlockingOff('https://nytimes.com/', off)).toBe(true);
    expect(isBlockingOff('https://notnytimes.com/', off)).toBe(false);
    expect(isBlockingOff('https://nytimes.com.evil.example/', off)).toBe(false);
    expect(isBlockingOff('chrome-extension://abc/page.html', off)).toBe(false);
  });

  it('keeps a saved list clean and bounded', () => {
    expect(cleanOffSites(['https://a.example.com/x', 'example.com', 'B.EXAMPLE.ORG', null, 7])).toEqual(['example.com', 'example.org']);
    const many = Array.from({ length: MAX_OFF_SITES + 50 }, (_, i) => `site${i}.example`);
    expect(cleanOffSites(many)).toHaveLength(MAX_OFF_SITES);
  });

  it('says what the lists’ host sees', () => {
    expect(AD_BLOCKING_NOTICE).toMatch(/easylist\.to/);
    expect(AD_BLOCKING_NOTICE).toMatch(/IP address/);
    expect(AD_BLOCKING_NOTICE).toMatch(/nothing about the pages you visit is sent/);
  });
});
