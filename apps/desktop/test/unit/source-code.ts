/**
 * For tests that scan main's source (invariants.test.ts, sessions-before-effects.test.ts): the code alone, so a rule
 * isn't met or broken by what a comment says.
 */

/** The text with comments blanked out (lengths and lines kept), and strings left as they are. */
export function code(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (; j < text.length && text[j] !== ch; j++) if (text[j] === '\\') j++;
      out += text.slice(i, j + 1);
      i = j;
    } else out += ch;
  }
  return out;
}
