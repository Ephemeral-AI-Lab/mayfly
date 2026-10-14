/**
 * The chrome helper layer: the S13 panel chrome (`topRule` / `padColumns`)
 * and the S14 completion polish (`highlightLeadingSlashToken` /
 * `injectGhostHint`) over their branch matrices: titles, hints, footers,
 * paints, gutter indentation, token bounds, and ghost-room accounting.
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  highlightLeadingSlashToken,
  injectGhostHint,
  padColumns,
  topRule,
} from '../../src/core/chrome.ts'
import { identity } from '../helpers.ts'

describe('topRule', () => {
  it('renders the kimi in-border title with a joiner and dash fill', () => {
    // `╭ BTW ─ Esc close · ↑↓ scroll ╮` — the title, the `─ ` joiner, and
    // the hint each paint separately, with the fill taking the remainder.
    expect(topRule(32, { title: ' BTW ', hint: 'Esc close · ↑↓ scroll ' })).toBe(
      '╭ BTW ─ Esc close · ↑↓ scroll ─╮',
    )
  })

  it('omits the joiner when only one of title and hint is present', () => {
    expect(topRule(10, { title: ' Todo ' })).toBe('╭ Todo ──╮')
    expect(topRule(10, { hint: 'ctrl+t ' })).toBe('╭ctrl+t ─╮')
  })

  it('renders a plain rule when neither title nor hint is present', () => {
    expect(topRule(6)).toBe('╭' + '────' + '╮')
  })

  it('paints the title, hint, and chrome separately', () => {
    const row = topRule(30, {
      title: ' BTW ',
      titlePaint: text => `<${text}>`,
      hint: 'Esc close ',
      hintPaint: text => `~${text}~`,
      paint: text => `%${text}%`,
    })
    expect(row).toBe('%╭%< BTW >%─ %~Esc close ~' + '%─────%' + '%╮%')
  })

  it('defaults the paints to identity', () => {
    // `' t ' + '─ ' + ' h '` joins with a double space in the middle — the
    // literal `╭ t ─  h ──╮` shape is the joiner plus the hint's lead space.
    expect(topRule(12, { title: ' t ', hint: ' h ' })).toBe('╭ t ─  h ──╮')
  })

  it('clips an over-long composite to the inner width, ANSI-safe', () => {
    const row = topRule(10, {
      title: 'ab'.repeat(8),
      titlePaint: text => `\x1b[1m${text}\x1b[22m`,
      hint: 'cd'.repeat(8),
    })
    // The composite is clipped with no ellipsis; the visible width never
    // exceeds the inner width, no SGR is cut mid-sequence, and the clip
    // appends a closing reset (pi-tui behavior) so the fill stays clean.
    expect(visibleWidth(row)).toBe(10)
    expect(row).toContain('\x1b[0m')
    expect(row).not.toContain('\x1b[22mcd')
  })

  it('truncates an overflowing composite with one ellipsis and no dash fill left', () => {
    // ' BTW ─ Esc close · ↑↓ scroll ' is 29 wide at inner width 28: the tail
    // makes room for the single `…` and the reset is appended.
    expect(topRule(30, { title: ' BTW ', hint: 'Esc close · ↑↓ scroll ' })).toBe(
      '╭ BTW ─ Esc close · ↑↓ scrol\u001b[0m…\u001b[0m╮',
    )
  })

  it('exactly fits a composite title with no dash fill', () => {
    expect(topRule(10, { title: ' t ', hint: ' h ' })).toBe('╭ t ─  h ╮')
  })

  it('keeps a degenerate width at one inner column', () => {
    // width 0-1: the inner width clamps to one; the corners still render.
    expect(visibleWidth(topRule(0, { title: 'x' }))).toBe(3)
    expect(visibleWidth(topRule(1))).toBe(3)
  })
})

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
    // width 20, text 4: room 7 — the hint clips to ` <ques…`.
    const row = `    /btw${CURSOR_BLOCK}${' '.repeat(11)}`
    const ghosted = injectGhostHint(row, ' <question>', '/btw', 20, identity)
    expect(ghosted).toBe(`    /btw${CURSOR_BLOCK} <ques…${' '.repeat(4)}`)
    expect(visibleWidth(ghosted)).toBe(20)
  })

  it('reduces the ghost to a lone ellipsis when a single column remains', () => {
    // width 14, text 4, cursor 1: room 1 — the hint clips to bare `…`.
    const row = `    /btw${CURSOR_BLOCK}${' '.repeat(5)}`
    const ghosted = injectGhostHint(row, ' <q>', '/btw', 14, identity)
    expect(ghosted).toBe(`    /btw${CURSOR_BLOCK}…${' '.repeat(4)}`)
    expect(visibleWidth(ghosted)).toBe(14)
  })

  it('returns the row unchanged when there is no room at all', () => {
    const row = `    /btw${CURSOR_BLOCK}${' '.repeat(3)}`
    expect(injectGhostHint(row, ' <q>', '/btw', 12, identity)).toBe(row)
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
    const row = `    /btw${' '.repeat(12)}`
    const ghosted = injectGhostHint(row, ' <q>', '/btw', 20, text => `[${text}]`)
    expect(ghosted).toBe(`    /btw[ <q>]${' '.repeat(8)}`)
    // Unpainted width 20; the bracket paint again adds its 2 columns.
    expect(visibleWidth(ghosted)).toBe(22)
  })

  it('measures a wide-character hint in display columns', () => {
    // Text `路径` is 4 columns wide; width 20 leaves contentWidth 12 and
    // room 7, so ` 文件路径` (9 columns) clips to ` 文件…` (6 columns).
    const row = `    路径${CURSOR_BLOCK}${' '.repeat(11)}`
    const ghosted = injectGhostHint(row, ' 文件路径', '路径', 20, identity)
    expect(ghosted).toBe(`    路径${CURSOR_BLOCK} 文件…${' '.repeat(5)}`)
    expect(visibleWidth(ghosted)).toBe(20)
  })

  it('never splits an emoji grapheme while ellipsizing', () => {
    // Text `a` is 1 column; width 14 leaves contentWidth 6 and room 4, so
    // exactly one 2-column emoji fits beside the ellipsis.
    const row = `    a${CURSOR_BLOCK}${' '.repeat(8)}`
    const ghosted = injectGhostHint(row, ' 😀😀', 'a', 14, identity)
    expect(ghosted).toBe(`    a${CURSOR_BLOCK} 😀…${' '.repeat(4)}`)
    expect(visibleWidth(ghosted)).toBe(14)
  })
})
