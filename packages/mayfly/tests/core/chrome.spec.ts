/**
 * The chrome helper layer: the S13 gutter (`padColumns`) and the S14
 * completion polish (`highlightLeadingSlashToken` / `injectGhostHint`) over
 * their branch matrices: gutter indentation, token bounds, and ghost-room
 * accounting.
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { highlightLeadingSlashToken, injectGhostHint, padColumns } from '../../src/core/text/chrome.ts'
import { identity } from '../helpers.ts'

describe('padColumns', () => {
  it('prefixes every row with the gutter', () => {
    expect(padColumns(['a', 'bc'], 1)).toEqual([' a', ' bc'])
    expect(padColumns(['a'], 2)).toEqual(['  a'])
  })

  it('passes rows through unchanged at a zero gutter', () => {
    expect(padColumns(['a', ''], 0)).toEqual(['a', ''])
  })

  it('handles an empty input', () => {
    expect(padColumns([], 1)).toEqual([])
  })

  it('leaves styled rows intact', () => {
    expect(padColumns(['\x1b[1mab\x1b[22m'], 1)).toEqual([' \x1b[1mab\x1b[22m'])
  })
})

// oxlint-disable-next-line no-control-regex -- the inverse-video cursor is a raw SGR sequence
const CURSOR_BLOCK = '\x1b[7m \x1b[0m'

describe('highlightLeadingSlashToken', () => {
  it('paints the leading /command token and leaves the rest of the row alone', () => {
    expect(highlightLeadingSlashToken('    /btw rest', text => `[${text}]`)).toBe('    [/btw] rest')
  })

  it('paints a token that runs to the end of the row', () => {
    expect(highlightLeadingSlashToken('  /sessions', identity)).toBe('  /sessions')
  })

  it('wraps only the visible token when the row carries the cursor block', () => {
    // The inverse-video cursor parks after `/btw`; the paint wraps the four
    // token characters and the cursor's escape rides through untouched.
    expect(highlightLeadingSlashToken(`    /btw${CURSOR_BLOCK}`, text => `<${text}>`))
      .toBe(`    </btw>${CURSOR_BLOCK}`)
  })

  it('paints a token that straddles the inverse-video cursor mid-word', () => {
    // A focused editor replaces the grapheme under the caret with the
    // inverse-video grapheme; the visible-index walk crosses those SGR runs
    // and the paint wraps the raw slice around them.
    const row = '  /b\x1b[7mt\x1b[0mw end'
    expect(highlightLeadingSlashToken(row, text => `[${text}]`)).toBe('  [/b\x1b[7mt\x1b[0mw] end')
  })

  it('declines a mid-sentence slash (not the first non-whitespace character)', () => {
    expect(highlightLeadingSlashToken('  run /btw', identity)).toBeUndefined()
  })

  it('declines a token containing a second slash (a path)', () => {
    expect(highlightLeadingSlashToken('  /usr/bin', identity)).toBeUndefined()
  })

  it('declines rows without a slash', () => {
    expect(highlightLeadingSlashToken('  plain text', identity)).toBeUndefined()
  })
})

describe('injectGhostHint', () => {
  it('splices the ghost after the cursor block and preserves the row width', () => {
    // width 24, text `/btw` (4): contentWidth 16, room 11 — ` <question>`
    // fits exactly and the trailing padding shrinks to keep the row's
    // unpainted width (the bracket paint here adds 2 visible columns; a
    // zero-width SGR paint would keep 24).
    const row = `    /btw${CURSOR_BLOCK}${' '.repeat(15)}`
    const ghosted = injectGhostHint(row, ' <question>', '/btw', 24, text => `[${text}]`)
    expect(ghosted).toBe(`    /btw${CURSOR_BLOCK}[ <question>]${' '.repeat(4)}`)
    expect(visibleWidth(ghosted)).toBe(26)
  })

  it('ellipsizes the ghost when the room runs short', () => {
    // width 12, text 4: room 7 — the hint clips to ` <ques…`.
    const row = `    /btw${CURSOR_BLOCK}${' '.repeat(11)}`
    const ghosted = injectGhostHint(row, ' <question>', '/btw', 12, identity)
    expect(ghosted).toBe(`    /btw${CURSOR_BLOCK} <ques…${' '.repeat(4)}`)
    expect(visibleWidth(ghosted)).toBe(20)
  })

  it('reduces the ghost to a lone ellipsis when a single column remains', () => {
    // width 6, text 4, cursor 1: room 1 — the hint clips to bare `…`.
    const row = `    /btw${CURSOR_BLOCK}${' '.repeat(5)}`
    const ghosted = injectGhostHint(row, ' <q>', '/btw', 6, identity)
    expect(ghosted).toBe(`    /btw${CURSOR_BLOCK}…${' '.repeat(4)}`)
    expect(visibleWidth(ghosted)).toBe(14)
  })

  it('returns the row unchanged when there is no room at all', () => {
    const row = `    /btw${CURSOR_BLOCK}${' '.repeat(3)}`
    expect(injectGhostHint(row, ' <q>', '/btw', 4, identity)).toBe(row)
  })

  it('declines while the cursor sits mid-text', () => {
    // The cursor block before a real character means the caret is not at
    // the end of the input; the ghost belongs only after the text.
    const row = `    /bt${CURSOR_BLOCK}w${' '.repeat(14)}`
    expect(injectGhostHint(row, ' <q>', '/btw', 24, identity)).toBe(row)
  })

  it('falls back to the padding position when no cursor block renders', () => {
    // An unfocused editor renders no cursor; the ghost lands at the
    // content-end column instead. The bracket paint adds 2 columns and the
    // display-width clamp trims them from the trailing padding.
    const row = `/btw${' '.repeat(16)}`
    const ghosted = injectGhostHint(row, ' <q>', '/btw', 12, text => `[${text}]`)
    expect(ghosted).toBe(`/btw[ <q>]${' '.repeat(12)}`)
    // Unpainted width 20; the bracket paint again adds its 2 columns.
    expect(visibleWidth(ghosted)).toBe(22)
  })

  it('measures a wide-character hint in display columns', () => {
    // Text `路径` is 4 columns wide; width 20 leaves contentWidth 12 and
    // room 7, so ` 文件路径` (9 columns) clips to ` 文件…` (6 columns).
    const row = `    路径${CURSOR_BLOCK}${' '.repeat(11)}`
    const ghosted = injectGhostHint(row, ' 文件路径', '路径', 12, identity)
    expect(ghosted).toBe(`    路径${CURSOR_BLOCK} 文件…${' '.repeat(5)}`)
    expect(visibleWidth(ghosted)).toBe(20)
  })

  it('never splits an emoji grapheme while ellipsizing', () => {
    // Text `a` is 1 column; width 6 leaves contentWidth 6 and room 4, so
    // exactly one 2-column emoji fits beside the ellipsis.
    const row = `    a${CURSOR_BLOCK}${' '.repeat(8)}`
    const ghosted = injectGhostHint(row, ' 😀😀', 'a', 6, identity)
    expect(ghosted).toBe(`    a${CURSOR_BLOCK} 😀…${' '.repeat(4)}`)
    expect(visibleWidth(ghosted)).toBe(14)
  })
})
