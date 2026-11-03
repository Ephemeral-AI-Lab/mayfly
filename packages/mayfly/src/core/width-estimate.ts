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

/**
 * The regex's answer for each Basic Multilingual Plane code point already seen, plus one (zero means not yet asked):
 * a memo of a pure function, so Latin, Greek, or Cyrillic prose costs a table read per character, not a regex test.
 */
const BMP_WIDTHS = new Uint8Array(0x10000)

function printingWidth(point: number): number {
  if (point > 0xffff) return NON_PRINTING.test(String.fromCodePoint(point)) ? 0 : 1
  const known = BMP_WIDTHS[point]!
  if (known !== 0) return known - 1
  const width = NON_PRINTING.test(String.fromCodePoint(point)) ? 0 : 1
  BMP_WIDTHS[point] = width + 1
  return width
}

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
  return printingWidth(point)
}

/** Pictographs an emoji sequence joins: the emoji blocks, the symbol and dingbat blocks, and a few lone marks. */
function isPictograph(point: number): boolean {
  return point >= 0x1f000 && point <= 0x1faff || point >= 0x2190 && point <= 0x2bff || point === 0xa9 || point === 0xae || point === 0x203c || point === 0x2049 || point === 0x2122 || point === 0x2139
}

/**
 * What the walk over a line remembers about the cluster in progress. The measure counts an emoji sequence once, not by
 * member: a ZWJ sequence, a flag, a toned person, and a pictograph with a presentation selector are two columns each.
 * The estimate follows those few rules and no others; every other cluster stays priced by its code points.
 */
export interface ColumnWalk {
  /** The previous printing code point was a pictograph, so a joiner, tone, or selector after it belongs to its cluster. */
  emoji: boolean
  /** A joiner followed that pictograph: the next pictograph is a member of the sequence. */
  joined: boolean
  /** The previous code point was the first of a regional-indicator pair, so the next one completes the flag. */
  flag: boolean
  /** The cells the previous printing code point took (a keycap's enclosing mark widens a one-cell base). */
  last: number
}

/** A walk at the start of a line. */
export function startColumnWalk(): ColumnWalk {
  return { emoji: false, joined: false, flag: false, last: 0 }
}

/** The cells one code point adds after the code points the walk has seen, which it advances. */
function advance(walk: ColumnWalk, point: number): number {
  if (point === 0x200d) { walk.joined = walk.emoji; return 0 }
  const joined = walk.joined
  walk.joined = false
  if (point >= 0x1f1e6 && point <= 0x1f1ff) {
    const completes = walk.flag
    walk.flag = !completes
    walk.emoji = true
    walk.last = 2
    return completes ? 0 : 2
  }
  walk.flag = false
  // A presentation selector widens a narrow pictograph (a heart, a sun) to the emoji cell pair.
  if (point === 0xfe0f) {
    if (!walk.emoji || walk.last !== 1) return 0
    walk.last = 2
    return 1
  }
  // A keycap sequence (a digit, the selector, the enclosing keycap) is one emoji cell pair.
  if (point === 0x20e3) {
    if (walk.last !== 1) return 0
    walk.last = 2
    return 1
  }
  // A skin tone belongs to the pictograph before it, and gives a narrow one (a victory hand) its emoji cell pair.
  if (point >= 0x1f3fb && point <= 0x1f3ff && walk.emoji) {
    const widens = walk.last === 1
    walk.last = 2
    return widens ? 1 : 0
  }
  const cells = pointWidth(point)
  if (cells === 0) return 0
  const pictograph = isPictograph(point)
  if (joined && pictograph) return 0
  walk.emoji = pictograph
  walk.last = cells
  return cells
}

/** The cells a range adds to the walk, which it advances: the ranges of one line summed in order price it as a whole. */
export function walkColumns(walk: ColumnWalk, text: string, start: number, end: number): number {
  let width = 0
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) { width += advance(walk, ((code - 0xd800) << 10) + low - 0xdc00 + 0x10000); index += 1; continue }
    }
    width += advance(walk, code)
  }
  return width
}

/**
 * Estimated columns of `text[start, end)`. Surrogate pairs count as their code point, and an emoji sequence counts as
 * one cluster (see {@link ColumnWalk}); the ranges `0 <= start <= end` of a line never cross a `\n`. This is an
 * estimate, not the measure: ANSI escapes the painter later strips count as ordinary characters (a small
 * over-estimate), and clusters other than emoji sequences may be off by a cell.
 */
export function estimateColumns(text: string, start: number, end: number): number {
  let ascii = true
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x80 || code === 0x09 || code < 0x20 || code === 0x7f) { ascii = false; break }
  }
  if (ascii) return end - start
  return walkColumns(startColumnWalk(), text, start, end)
}
