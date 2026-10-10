/**
 * Estimated terminal columns for a range of text: the cheap pre-pass the content index runs once per line so a
 * document's row map exists before any row is painted. The truth stays `width.ts` (pi-tui's grapheme measure); this
 * module approximates it one code point at a time — ASCII and the common wide blocks are table lookups, everything
 * else falls back to the same character classes pi-tui tests. Errors are small and only ever move the row map, which
 * `prepare` corrects wherever a window lands: a segment's estimate is replaced by its painted count.
 *
 * @module @ephemeral-ai/mayfly/core/width-estimate
 */

/** Mirrors pi-tui's non-printing classes: controls, marks, formats, surrogates and default-ignorables take no cell. */
const NON_PRINTING = /^(?:\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate}|\p{Default_Ignorable_Code_Point})$/u

/** Estimated cell width of one code point. Tabs expand to three columns, matching the layout's expansion. */
function pointWidth(point: number): number {
  if (point < 0x80) return point === 0x09 ? 3 : point < 0x20 || point === 0x7f ? 0 : 1
  // The dominant wide blocks, checked before the regex fallback so CJK-heavy text stays on the fast path.
  if (
    point >= 0x1100 && point <= 0x115f // Hangul Jamo
    || point >= 0x2e80 && point <= 0x303e // CJK radicals, Kangxi, kana punctuation
    || point >= 0x3041 && point <= 0x33ff // Hiragana, Katakana, Bopomofo, CJK symbols
    || point >= 0x3400 && point <= 0x4dbf // CJK Extension A
    || point >= 0x4e00 && point <= 0x9fff // CJK Unified
    || point >= 0xa000 && point <= 0xa4cf // Yi
    || point >= 0xa960 && point <= 0xa97c // Hangul Jamo Extended-B
    || point >= 0xac00 && point <= 0xd7a3 // Hangul syllables
    || point >= 0xf900 && point <= 0xfaff // CJK compatibility ideographs
    || point >= 0xfe30 && point <= 0xfe6b // CJK compatibility forms
    || point >= 0xff00 && point <= 0xff60 // Fullwidth forms
    || point >= 0xffe0 && point <= 0xffe6 // Fullwidth signs
    || point >= 0x1f300 && point <= 0x1faff // emoji and pictographs
    || point >= 0x1f1e6 && point <= 0x1f1ff // regional indicators render two cells
    || point >= 0x20000 && point <= 0x3fffd // CJK Extension B and beyond
  ) return 2
  return NON_PRINTING.test(String.fromCodePoint(point)) ? 0 : 1
}

/**
 * Estimated columns of `text[start, end)`. Surrogate pairs count as their code point; the ranges `0 <= start <= end`
 * of a line never cross a `\n`. This is an estimate, not the measure: ANSI escapes the painter later strips count as
 * ordinary characters (a small over-estimate), and grapheme-cluster subtleties may be off by a cell.
 */
export function estimateColumns(text: string, start: number, end: number): number {
  let width = 0
  let ascii = true
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x80 || code === 0x09 || code < 0x20 || code === 0x7f) { ascii = false; break }
  }
  if (ascii) return end - start
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) { width += pointWidth(((code - 0xd800) << 10) + low - 0xdc00 + 0x10000); index += 1; continue }
    }
    width += pointWidth(code)
  }
  return width
}
