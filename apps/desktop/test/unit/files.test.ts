import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeFilename, uniquePath } from '../../src/main/files';

describe('safeFilename', () => {
  it('keeps the name but never a folder or a reserved character', () => {
    expect(safeFilename('report.pdf')).toBe('report.pdf');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(safeFilename('a:b?c*.txt')).toBe('a_b_c_.txt');
    expect(safeFilename('  ..  ')).toBe('download');
  });
});

describe('uniquePath', () => {
  it('numbers the name until it is free, keeping the extension', () => {
    const taken = new Set([join('D', 'report.pdf'), join('D', 'report (1).pdf')]);
    expect(uniquePath('D', 'report.pdf', (p) => taken.has(p))).toBe(join('D', 'report (2).pdf'));
    expect(uniquePath('D', 'notes', () => false)).toBe(join('D', 'notes'));
  });
});
