/**
 * The first character a person would see: an emoji with its skin tone,
 * joiners or variation selector counts as one. Letters are capitalized, so a
 * chord icon typed as "w" shows as "W".
 */
export function firstGrapheme(text: string): string {
  const first = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())][0]?.segment ?? '';
  return /^\p{L}$/u.test(first) ? first.toLocaleUpperCase() : first;
}
