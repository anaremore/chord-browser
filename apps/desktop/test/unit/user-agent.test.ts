import { describe, expect, it } from 'vitest';
import { chromiumUserAgent } from '../../src/main/user-agent';

describe('chromiumUserAgent', () => {
  it("removes Electron's and the app's tokens and reduces the version like Chrome", () => {
    const electron =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ChordDev/0.0.0 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36';
    expect(chromiumUserAgent(electron, 'Chord Dev')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    );
  });

  it('handles the packaged name and other platforms', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chord/0.1.0 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36';
    expect(chromiumUserAgent(mac, 'Chord')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    );
  });

  it('leaves an already-clean user agent unchanged', () => {
    const clean = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
    expect(chromiumUserAgent(clean, 'Chord')).toBe(clean);
  });
});
