import { describe, expect, it } from 'vitest';
import { openable, progIdIn, urlsFromArgv } from '../../src/main/os-links';

describe('urlsFromArgv', () => {
  it('takes the one argument after --single-argument, whatever it contains', () => {
    // Chromium hands everything after the switch over as one argument: a crafted link can't add switches.
    expect(urlsFromArgv(['C:\\Chord\\Chord.exe', '--single-argument', 'https://example.com/a" --inspect=9229'])).toEqual([
      'https://example.com/a%22%20--inspect=9229',
    ]);
  });

  it('finds the link after --single-argument when a hand-off added switches in between', () => {
    expect(urlsFromArgv(['/opt/Chord/chord', '--single-argument', '--original-process-start-time=13', 'https://x.example/', 'https://y.example/'])).toEqual([
      'https://x.example/',
    ]);
    // Development: Electron's own app-folder argument can land after it too.
    expect(urlsFromArgv(['electron', '--single-argument', '/work/chord/apps/desktop', 'https://x.example/'])).toEqual(['https://x.example/']);
  });

  it('collects web links from a plain command line and skips switches and Chord itself', () => {
    expect(urlsFromArgv(['/opt/Chord/chord', '--no-sandbox', 'https://a.example/', 'http://b.example/x', 'https://a.example/'])).toEqual([
      'https://a.example/',
      'http://b.example/x',
    ]);
    expect(urlsFromArgv(['electron', 'Z:\\Projects\\chord-browser\\apps\\desktop', '--remote-debugging-port=0'])).toEqual([]);
  });

  it('ignores schemes Chord shouldn’t be launched with', () => {
    expect(urlsFromArgv(['chord', 'javascript:alert(1)', 'chrome://settings', 'mailto:a@b.c', 'ftp://x'])).toEqual([]);
  });

  it('caps a flood of links', () => {
    expect(urlsFromArgv(Array.from({ length: 50 }, (_, i) => `https://e.example/${i}`))).toHaveLength(20);
  });
});

describe('openable', () => {
  it('turns an absolute path to a web page into a file URL', () => {
    const url = openable('/tmp/page.html');
    expect(url).toMatch(/^file:\/\/\/.*\/tmp\/page\.html$/);
    expect(openable('"/tmp/page.htm"')).toMatch(/^file:\/\/\/.*page\.htm$/);
  });

  it('refuses other files and relative paths', () => {
    expect(openable('/tmp/run.exe')).toBeNull();
    expect(openable('page.html')).toBeNull();
  });
});

describe('progIdIn', () => {
  it('reads the ProgId from reg query output', () => {
    const output = '\r\nHKEY_CURRENT_USER\\Software\\...\\https\\UserChoice\r\n    ProgId    REG_SZ    ChordHTML\r\n\r\n';
    expect(progIdIn(output)).toBe('ChordHTML');
    expect(progIdIn('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});
