/**
 * Builds small, valid PDFs for Duet's tests: one page per entry, each line
 * set in Helvetica (a standard font, so nothing is embedded), uncompressed,
 * with a correct cross-reference table. Text is plain ASCII.
 */

const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function buildPdf(pages: readonly (readonly string[])[], options: { title?: string } = {}): Uint8Array {
  const objects: string[] = [];
  /** Object numbers start at 1. */
  const add = (body: string) => objects.push(body);
  const pageIds: number[] = [];
  const catalog = add('');
  const tree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  for (const lines of pages) {
    const ops = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', ...lines.map((line) => `(${escape(line)}) Tj T*`), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const info = options.title ? add(`<< /Title (${escape(options.title)}) >>`) : 0;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** Three pages with known words on each, for citations that name their page. */
export const SAMPLE_PDF_PAGES = [
  ['Field guide to chords', 'A chord is three or more notes played together.'],
  ['Page two talks about triads.', 'A major triad sounds bright and stable.'],
  ['The last page is about inversions.', 'An inversion puts another note at the bottom.'],
] as const;
