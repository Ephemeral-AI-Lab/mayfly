/**
 * The banner mark literal: the Mayfly s10 rows pinned exactly, so an
 * accidental edit of {@link MARK_ROWS} surfaces in review.
 */

import { describe, expect, it } from 'vitest'
import { markColumns } from '../../src/core/quad-mark.ts'
import { MARK_BEAT, MARK_ROWS } from '../../src/transcript/banner-art.ts'

describe('MARK_ROWS', () => {
  it('pins the Mayfly mark pixels', () => {
    expect(MARK_ROWS).toEqual([
      '........T........T........',
      '.......T..........T.......',
      '......BBBBBBBBBBBBBB......',
      'WWWWW.BBB.BBBBBB.BBB.WWWWW',
      '......BBB.BBBBBB.BBB......',
      '..WWW.BBBBBBBBBBBBBB.WWW..',
      '.......BBBBBBBBBBBB.......',
      '.........T......T.........',
    ])
  })

  it('keeps every row 26 pixels wide: 13 cells across and 4 down', () => {
    for (const row of MARK_ROWS) expect(row).toHaveLength(26)
    expect(markColumns(MARK_ROWS)).toBe(13)
    expect(MARK_ROWS).toHaveLength(8)
    // Only the body, antennae and tails, wings, and empty cells.
    expect(new Set(MARK_ROWS.join(''))).toEqual(new Set(['.', 'B', 'T', 'W']))
  })

  it('lifts the wings for the beat frame and keeps the mark the same size', () => {
    expect(MARK_BEAT).toHaveLength(MARK_ROWS.length)
    expect(MARK_BEAT).not.toEqual(MARK_ROWS)
    for (const row of MARK_BEAT) expect(row).toHaveLength(26)
  })
})
