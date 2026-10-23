/**
 * Safe Browsing's copy keeps to Google's terms for warnings
 * (developers.google.com/safe-browsing/v4/usage-limits): never certain,
 * always crediting Google's lists, a learn-more page per threat, and a
 * notice that says protection isn't perfect both ways.
 */
import { describe, expect, it } from 'vitest';
import { describeHeldDownload, describeThreat, SAFE_BROWSING_ADVISORY, SAFE_BROWSING_NOTICE, THREAT_LEARN_MORE, type ThreatKind } from '../src';

const KINDS: ThreatKind[] = ['phishing', 'malware', 'unwanted'];
const HEDGED = /\b(may|suspected|likely)\b/i;
const CERTAIN = /\b(is (dangerous|malicious|unsafe|a phishing site)|will harm|contains malware)\b/i;

describe('Safe Browsing copy', () => {
  it.each(KINDS)('a %s warning is hedged and names Google’s list', (kind) => {
    for (const frameUrl of [null, 'https://ads.example/frame']) {
      const copy = describeThreat({ kind, frameUrl }, 'evil.example', 'ads.example');
      expect(copy.title).toMatch(HEDGED);
      expect(`${copy.title} ${copy.body}`).not.toMatch(CERTAIN);
      expect(copy.body).toMatch(/Google’s list of (suspected|sites suspected)/);
      expect(copy.body).toContain(frameUrl ? 'ads.example' : 'evil.example');
    }
    expect(describeHeldDownload(kind)).toMatch(HEDGED);
    expect(THREAT_LEARN_MORE[kind].url).toMatch(/^https:\/\/(developers|www)\.google\.com\//);
  });

  it('credits Google with a link to its advisory', () => {
    expect(SAFE_BROWSING_ADVISORY).toEqual({ label: 'Advisory provided by Google', url: 'https://developers.google.com/safe-browsing/v4/advisory' });
  });

  it('says before it’s on that it can miss a site and flag one by mistake', () => {
    expect(SAFE_BROWSING_NOTICE).toMatch(/isn’t perfect/);
    expect(SAFE_BROWSING_NOTICE).toMatch(/missed/);
    expect(SAFE_BROWSING_NOTICE).toMatch(/flagged by mistake/);
    expect(SAFE_BROWSING_NOTICE).toMatch(/never the address itself/);
    expect(SAFE_BROWSING_NOTICE).toMatch(/IP address/);
  });
});
