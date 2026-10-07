/**
 * The design's glyph vocabulary (docs/design/component-library.md §2.2) and its ASCII fallback for terminals or fonts
 * that cannot draw it. Every replacement is exactly one cell, so a row painted in either mode has the same layout and
 * width; ASCII mode is applied to painted rows after layout. Loader spinners are the one exception: their frames are a
 * cycle, so the loader painter swaps the whole cycle for {@link ASCII_SPINNER_FRAMES}.
 *
 * @module @ephemeral-ai/mayfly/core/glyphs
 */

/** Which vocabulary the renderer paints with. */
export type MayflyGlyphMode = 'unicode' | 'ascii'

/**
 * The fallback table: the roadmap's slice 1.2 proposal (to be confirmed at checkpoint A), plus the arrows, rules, and
 * marks the painters also emit (`← ↑ ↓`, `−`, `⋯`, the square corners, `•`, `✕`, `✻`, `»`, `⏵`, `⇥`).
 */
export const ASCII_GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  '→': '>', '←': '<', '↑': '^', '↓': 'v',
  '▸': '+', '▾': '-',
  '●': '*', '○': 'o', '◐': '~',
  '‹': '<', '›': '>',
  '✓': 'v', '✗': 'x', '✕': 'x', '⊘': '/',
  '░': '.', '▒': ':', '▓': '*', '█': '#',
  '■': '#', '⚠': '!', 'ℹ': 'i',
  '⎿': 'L', '│': ':',
  '━': '=', '─': '-',
  '▰': '#', '▱': '.',
  '╭': '+', '╮': '+', '╰': '+', '╯': '+', '┌': '+', '┐': '+', '└': '+', '┘': '+', '├': '+', '┤': '+',
  '−': '-', '⋯': ':', '•': '*', '✻': '*', '»': '>', '⏵': '>', '⇥': '>',
})

/** The spinner every loader variant becomes in ASCII mode. */
export const ASCII_SPINNER_FRAMES: readonly string[] = Object.freeze(['-', '\\', '|', '/'])

const ASCII_PATTERN = new RegExp(`[${Object.keys(ASCII_GLYPHS).join('')}]`, 'gu')

/**
 * Replace every glyph of the table with its one-cell ASCII form. Escape sequences are ASCII already and pass through,
 * so painted rows can be converted after they are styled.
 * @param text - plain or painted text.
 * @returns the text with each table glyph replaced.
 */
export function asciiText(text: string): string {
  return text.replace(ASCII_PATTERN, glyph => ASCII_GLYPHS[glyph]!)
}

/**
 * Paint rows in a glyph mode: unchanged for `unicode`, converted for `ascii`.
 * @param rows - painted rows.
 * @param mode - the active mode.
 * @returns the rows to show.
 */
export function glyphRows(rows: string[], mode: MayflyGlyphMode | undefined): string[] {
  return mode === 'ascii' ? rows.map(asciiText) : rows
}

/**
 * The mode the locale's charset implies: ASCII when the first set of `LC_ALL`, `LC_CTYPE`, and `LANG` names a charset
 * other than UTF-8 (`C`, `POSIX`, `en_US.ISO-8859-1`), Unicode otherwise, including when no locale is set at all.
 * @param env - the process environment.
 * @returns the default glyph mode.
 */
export function localeGlyphMode(env: Readonly<Record<string, string | undefined>>): MayflyGlyphMode {
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(value => value !== undefined && value !== '')
  return locale === undefined || /utf-?8/iu.test(locale) ? 'unicode' : 'ascii'
}
