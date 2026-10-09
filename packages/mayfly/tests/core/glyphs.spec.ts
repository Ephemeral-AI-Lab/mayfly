/** The glyph vocabulary's ASCII fallback: one cell per glyph, painted rows, and the locale default. */
import { describe, expect, it } from 'vitest'
import { ASCII_GLYPHS, ASCII_SPINNER_FRAMES, asciiText, glyphRows, localeGlyphMode } from '../../src/core/glyphs.ts'
import { visibleWidth } from '../../src/core/width.ts'

describe('ASCII glyph fallback', () => {
  it('replaces every table glyph with exactly one printable ASCII cell', () => {
    for (const [glyph, ascii] of Object.entries(ASCII_GLYPHS)) {
      expect(visibleWidth(glyph), glyph).toBe(1)
      expect(ascii).toMatch(/^[\x21-\x7e]$/u)
    }
    expect(ASCII_SPINNER_FRAMES).toEqual(['-', '\\', '|', '/'])
  })

  it('converts the roadmap table and keeps the width of painted rows', () => {
    expect(asciiText('→ ▸ ▾ ● ○ ◐ ‹ › ✓ ✗ ⊘ ░▒▓█ ■ ? ⚠ ℹ ⎿ │ ━ ─ ▰ ▱ ╭╮╰╯')).toBe('> + - * o ~ < > v x / .:*# # ? ! i L : = - # . ++++')
    const painted = '\x1b[38;2;1;2;3m╭ Title ─╮\x1b[39m'
    expect(asciiText(painted)).toBe('\x1b[38;2;1;2;3m+ Title -+\x1b[39m')
    expect(visibleWidth(asciiText(painted))).toBe(visibleWidth(painted))
    expect(asciiText('中文 text …')).toBe('中文 text …')
  })

  it('leaves rows alone in Unicode mode', () => {
    const rows = ['● a', '→ b']
    expect(glyphRows(rows, 'unicode')).toBe(rows)
    expect(glyphRows(rows, undefined)).toBe(rows)
    expect(glyphRows(rows, 'ascii')).toEqual(['* a', '> b'])
  })

  it('defaults from the locale charset', () => {
    expect(localeGlyphMode({})).toBe('unicode')
    expect(localeGlyphMode({ LANG: 'en_US.UTF-8' })).toBe('unicode')
    expect(localeGlyphMode({ LANG: 'C.utf8' })).toBe('unicode')
    expect(localeGlyphMode({ LANG: 'C' })).toBe('ascii')
    expect(localeGlyphMode({ LC_ALL: '', LC_CTYPE: 'POSIX', LANG: 'en_US.UTF-8' })).toBe('ascii')
    expect(localeGlyphMode({ LC_ALL: 'de_DE.ISO-8859-1', LANG: 'en_US.UTF-8' })).toBe('ascii')
  })
})
