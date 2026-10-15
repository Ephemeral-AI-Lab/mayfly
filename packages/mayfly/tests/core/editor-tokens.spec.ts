/**
 * Decisions of the editor's inline tokens: pasted blocks, pasted images, and mentions stay in the buffer and paint as
 * tokens; a token cut by the right edge keeps its identity across rows.
 * @module @ephemeral-ai/mayfly/tests/core/editor-tokens
 */
import { describe, expect, it } from 'vitest'
import { expandPastes, findTokenRanges, foldSegments, paintTokenRows } from '../../src/core/editor-tokens.ts'

const paints = {
  label: (text: string) => `<L>${text}</L>`,
  detail: (text: string) => `<D>${text}</D>`,
}
const CURSOR = '\x1b[7m \x1b[0m'
const IMAGE = { text: '[image #1 84 KB]', kind: 'image' as const }
const MENTION = { text: '@src/a.ts', kind: 'mention' as const }

describe('expandPastes', () => {
  it('expands the markers whose ids are in the table and keeps the rest as typed', () => {
    const pastes = new Map([[1, 'line one\nline two']])
    expect(expandPastes('see [paste #1 +2 lines] and [paste #2 +9 lines]', pastes)).toBe('see line one\nline two and [paste #2 +9 lines]')
  })
})

describe('foldSegments', () => {
  it('folds the first occurrence of each pasted content back into a marker, once', () => {
    expect(foldSegments('a X b X', ['X'])).toEqual([
      { paste: false, text: 'a ' },
      { paste: true, text: 'X' },
      { paste: false, text: ' b X' },
    ])
  })

  it('leaves a stretch that an earlier fold overlaps as plain text, and skips empty contents', () => {
    expect(foldSegments('abc', ['ab', 'bc', ''])).toEqual([
      { paste: true, text: 'ab' },
      { paste: false, text: 'c' },
    ])
  })

  it('returns the whole text as plain when no content appears in it', () => {
    expect(foldSegments('plain', ['zzz'])).toEqual([{ paste: false, text: 'plain' }])
  })
})

describe('findTokenRanges', () => {
  it('counts a paste marker only while its id is in the paste table', () => {
    const line = 'x [paste #1 +2 lines] y [paste #2 12 chars]'
    expect(findTokenRanges(line, new Set([1]))).toEqual([{ start: 2, end: 21, kind: 'paste' }])
    expect(findTokenRanges(line, new Set())).toEqual([])
  })

  it('takes the interaction spans as given, drops empty and overlapping ones', () => {
    const spans = [
      { start: 0, end: 3, kind: 'image' as const },
      { start: 2, end: 5, kind: 'mention' as const },
      { start: 6, end: 6, kind: 'mention' as const },
      { start: 6, end: 8, kind: 'mention' as const },
    ]
    expect(findTokenRanges('0123456789', new Set(), spans)).toEqual([
      { start: 0, end: 3, kind: 'image' },
      { start: 6, end: 8, kind: 'mention' },
    ])
  })
})

describe('paintTokenRows', () => {
  it('paints an image label in the label tone and its brackets and size in the detail tone', () => {
    expect(paintTokenRows(['> see [image #1 84 KB] now'], [IMAGE], undefined, paints, CURSOR))
      .toEqual(['> see <D>[</D><L>image #1</L><D> 84 KB]</D> now'])
  })

  it('paints a mention wholly in the label tone', () => {
    expect(paintTokenRows(['> open @src/a.ts'], [MENTION], undefined, paints, CURSOR)).toEqual(['> open <L>@src/a.ts</L>'])
  })

  it('draws the selected token inverse, whatever its tone', () => {
    expect(paintTokenRows(['> see [image #1 84 KB]'], [IMAGE], 0, paints, CURSOR))
      .toEqual(['> see \x1b[7m[\x1b[27m\x1b[7mimage #1\x1b[27m\x1b[7m 84 KB]\x1b[27m'])
  })

  it('returns the rows unchanged when there are no tokens or no rows', () => {
    expect(paintTokenRows(['plain'], [], undefined, paints, CURSOR)).toEqual(['plain'])
    expect(paintTokenRows([], [IMAGE], undefined, paints, CURSOR)).toEqual([])
    expect(paintTokenRows(['> no token here'], [IMAGE], undefined, paints, CURSOR)).toEqual(['> no token here'])
  })

  it('keeps the escapes of the row in place, the cursor included', () => {
    const row = `> \x1b[31msee\x1b[39m ${CURSOR}[image #1 84 KB]`
    expect(paintTokenRows([row], [IMAGE], undefined, paints, CURSOR)[0]).toContain(`${CURSOR}<D>[</D><L>image #1</L><D> 84 KB]</D>`)
  })

  it('carries a token cut by the right edge onto the next row as one selected token', () => {
    const rows = ['> see [image #1 8', '4 KB] now']
    const painted = paintTokenRows(rows, [IMAGE], 0, paints, CURSOR)
    expect(painted[0]).toContain('\x1b[7m[\x1b[27m\x1b[7mimage #1\x1b[27m\x1b[7m 8\x1b[27m')
    expect(painted[1]).toContain('\x1b[7m4 KB]\x1b[27m')
  })

  it('selects the occurrence on the cursor row when a selected token occurs twice', () => {
    const rows = [`> [image #1 84 KB] and ${CURSOR}`, '> [image #1 84 KB]']
    const painted = paintTokenRows(rows, [IMAGE, IMAGE], 0, paints, CURSOR)
    expect(painted[0]).toContain('\x1b[7m[\x1b[27m\x1b[7mimage #1\x1b[27m\x1b[7m 84 KB]\x1b[27m')
    expect(painted[1]).not.toContain('\x1b[7m')
  })
})

describe('token edges', () => {
  it('folds a pasted block that ends the text without a plain stretch after it', () => {
    expect(foldSegments('a X', ['X'])).toEqual([{ paste: false, text: 'a ' }, { paste: true, text: 'X' }])
  })

  it('labels a token without brackets from its second character on', () => {
    expect(paintTokenRows(['> plain text'], [{ text: 'plain text', kind: 'image' }], undefined, paints, CURSOR))
      .toEqual(['> <D>p</D><L>lain text</L>'])
  })

  it('carries a token across three rows when the middle row is shorter than the rest of it', () => {
    const rows = ['> see [image #1 8', '4 K', 'B] now']
    const painted = paintTokenRows(rows, [IMAGE], 0, paints, CURSOR)
    expect(painted[0]).toContain('\x1b[7m[\x1b[27m')
    expect(painted[1]).toContain('\x1b[7m4 K\x1b[27m')
    expect(painted[2]).toContain('\x1b[7mB]\x1b[27m')
  })

  it('keeps an escape inside a token in place while painting its runs', () => {
    const painted = paintTokenRows(['> see [image #1 \x1b[2m84 KB]'], [IMAGE], undefined, paints, CURSOR)
    expect(painted[0]).toContain('\x1b[2m<D>84 KB]</D>')
    expect(painted[0]).toContain('<L>image #1</L>')
  })
})

describe('token rows that the token does not continue into', () => {
  it('paints nothing of a token cut at the edge when the next row does not continue it', () => {
    const painted = paintTokenRows(['> see [image #1 8', 'zz'], [IMAGE], 0, paints, CURSOR)
    expect(painted[0]).not.toContain('\x1b[7m')
    expect(painted[1]).toBe('zz')
  })

  it('leaves a row with no token on it as it is, between rows that carry one', () => {
    const painted = paintTokenRows(['> see [image #1 84 KB]', 'plain row', '> [image #2 1 KB]'], [IMAGE, { ...IMAGE, text: '[image #2 1 KB]' }], undefined, paints, CURSOR)
    expect(painted[1]).toBe('plain row')
    expect(painted[0]).toContain('<L>image #1</L>')
    expect(painted[2]).toContain('<L>image #2</L>')
  })
})
