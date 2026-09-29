/**
 * The diff alignment core: fast paths, prefix/suffix trim, LCS interleaving,
 * the oversized-input guard, change counts, and the painted rows with their
 * context-run elision, gutter wrapping, and full-width change bands.
 */

import { describe, expect, it } from 'vitest'
import {
  alignDiffLines,
  CTX_EDGE_ROWS,
  diffChangeCounts,
  DIFF_ALIGN_MAX_ROWS,
  paintDiffRows,
} from '../../src/core/diff-align.ts'
import { visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'

const ops = (before: string, after: string): Array<[string, string]> =>
  alignDiffLines(before, after).map(op => [op.type, op.text])

describe('alignDiffLines', () => {
  it('takes the whole-side fast paths', () => {
    expect(ops('', 'a\nb')).toEqual([['add', 'a'], ['add', 'b']])
    expect(ops('a\nb', '')).toEqual([['del', 'a'], ['del', 'b']])
    expect(ops('', '')).toEqual([])
    expect(ops('same\nlines', 'same\nlines')).toEqual([['ctx', 'same'], ['ctx', 'lines']])
  })

  it('treats a trailing terminator as a line ending, not an extra line', () => {
    expect(ops('a\nb\n', 'a\nb')).toEqual([['ctx', 'a'], ['ctx', 'b']])
  })

  it('interleaves a substitution with removals leading additions', () => {
    expect(ops('a\nb\nc', 'a\nx\nc')).toEqual([['ctx', 'a'], ['del', 'b'], ['add', 'x'], ['ctx', 'c']])
    expect(ops('head\n1\n2\ntail', 'head\n1\ntail')).toEqual([['ctx', 'head'], ['ctx', '1'], ['del', '2'], ['ctx', 'tail']])
    expect(ops('head\ntail', 'head\nmid\ntail')).toEqual([['ctx', 'head'], ['add', 'mid'], ['ctx', 'tail']])
  })

  it('aligns interleaved edits through the LCS middle', () => {
    const before = 'keep\none\ntwo\nkeep\nthree\nfour\nkeep'
    const after = 'keep\nuno\nkeep\ntres\nkeep'
    const aligned = ops(before, after)
    expect(aligned.filter(([type]) => type === 'ctx').map(([, text]) => text)).toEqual(['keep', 'keep', 'keep'])
    expect(diffChangeCounts(before, after)).toEqual({ added: 2, removed: 4 })
    // A swap costs one removal and one addition, never a full rewrite.
    expect(diffChangeCounts('a\nb', 'b\na')).toEqual({ added: 1, removed: 1 })
  })

  it('degrades oversized middles to whole blocks instead of an unbounded table', () => {
    const before = Array.from({ length: DIFF_ALIGN_MAX_ROWS + 5 }, (_, index) => `b${String(index)}`).join('\n')
    const after = Array.from({ length: DIFF_ALIGN_MAX_ROWS + 5 }, (_, index) => `a${String(index)}`).join('\n')
    const aligned = alignDiffLines(before, after)
    expect(aligned).toHaveLength((DIFF_ALIGN_MAX_ROWS + 5) * 2)
    expect(aligned[0]).toEqual({ type: 'del', text: 'b0' })
    expect(aligned[DIFF_ALIGN_MAX_ROWS + 5]).toEqual({ type: 'add', text: 'a0' })
    expect(diffChangeCounts(before, after)).toEqual({ added: DIFF_ALIGN_MAX_ROWS + 5, removed: DIFF_ALIGN_MAX_ROWS + 5 })
  })

  it('keeps equal counts for identical and empty-change inputs', () => {
    expect(diffChangeCounts('x', 'x')).toEqual({ added: 0, removed: 0 })
    expect(diffChangeCounts('', '')).toEqual({ added: 0, removed: 0 })
  })
})

describe('paintDiffRows', () => {
  const helpers = { wrapText: wrapTextWithAnsi, visibleWidth }
  const palette = {
    text: (text: string): string => `<T>${text}</T>`,
    diffAdded: (text: string): string => `<A>${text}</A>`,
    diffRemoved: (text: string): string => `<R>${text}</R>`,
    diffAddedBg: (text: string): string => `[A${text}A]`,
    diffRemovedBg: (text: string): string => `[R${text}R]`,
    diffMeta: (text: string): string => `<M>${text}</M>`,
  }
  const ctxOps = (texts: readonly string[]): Array<{ type: 'ctx'; text: string }> => texts.map(text => ({ type: 'ctx', text }))

  it('paints context once and bands removals and additions to the full width', () => {
    const aligned = alignDiffLines('a\nb', 'a\nc')
    expect(paintDiffRows(aligned, 8, helpers)).toEqual(['  a', '- b', '+ c'])
    expect(paintDiffRows(aligned, 8, helpers, palette)).toEqual([
      '  a',
      '[R<R>- </R><T>b</T>     R]',
      '[A<A>+ </A><T>c</T>     A]',
    ])
  })

  it('wraps long lines under the gutter and keeps the band on every visual row', () => {
    const aligned = alignDiffLines('same words here\nold', 'same words here\nnew wrapped line')
    expect(paintDiffRows(aligned, 10, helpers)).toEqual(['  same', '  words', '  here', '- old', '+ new', '  wrapped', '  line'])
    expect(paintDiffRows(aligned, 10, helpers, palette).slice(4)).toEqual([
      '[A<A>+ </A><T>new</T>     A]',
      '[A  <T>wrapped</T> A]',
      '[A  <T>line</T>    A]',
    ])
  })

  it('pads real SGR bands to exactly the width with the band closing last', () => {
    const red = (text: string): string => `\x1b[38;2;1;2;3m${text}\x1b[39m`
    const band = (text: string): string => `\x1b[48;2;4;5;6m${text}\x1b[49m`
    const real = { text: red, diffAdded: red, diffRemoved: red, diffAddedBg: band, diffRemovedBg: band, diffMeta: red }
    const rows = paintDiffRows(alignDiffLines('', 'x\n\ty\n'), 12, helpers, real)
    expect(rows.map(row => visibleWidth(row))).toEqual([12, 12])
    for (const row of rows) {
      expect(row.startsWith('\x1b[48;2;4;5;6m')).toBe(true)
      expect(row.endsWith('\x1b[49m')).toBe(true)
      expect(row.slice(0, -'\x1b[49m'.length)).not.toContain('\x1b[49m')
    }
    // A tab expands to the width truth's three columns instead of a tab stop.
    expect(rows[1]).not.toContain('\t')
    expect(rows[1]).toContain('   y')
  })

  it('drops the gutter when it would leave less than one wide glyph', () => {
    const aligned = alignDiffLines('ab', 'cd')
    expect(paintDiffRows(aligned, 3, helpers, palette)).toEqual(['[R<T>ab</T> R]', '[A<T>cd</T> A]'])
    expect(paintDiffRows(aligned, 1, helpers, palette)).toEqual(['[R<T>a</T>R]', '[R<T>b</T>R]', '[A<T>c</T>A]', '[A<T>d</T>A]'])
    expect(paintDiffRows(aligned, 3, helpers)).toEqual(['ab', 'cd'])
    expect(paintDiffRows(aligned, 0, helpers)).toEqual(['a', 'b', 'c', 'd'])
    // Four columns keep the gutter with a two-column text lane that fits a wide glyph.
    expect(paintDiffRows(aligned, 4, helpers)).toEqual(['- ab', '+ cd'])
    expect(paintDiffRows(alignDiffLines('', '你好'), 4, helpers)).toEqual(['+ 你', '  好'])
  })

  it('elides only genuinely long unchanged runs', () => {
    const ctx = Array.from({ length: CTX_EDGE_ROWS * 2 }, (_, index) => `c${String(index)}`)
    expect(paintDiffRows(ctxOps(ctx), 40, helpers)).toHaveLength(CTX_EDGE_ROWS * 2)
    const long = Array.from({ length: CTX_EDGE_ROWS * 2 + 7 }, (_, index) => `l${String(index)}`)
    expect(paintDiffRows(ctxOps(long), 40, helpers, palette)).toEqual([
      ...long.slice(0, CTX_EDGE_ROWS).map(text => `  ${text}`),
      `<M>⋯ ${String(7)} unchanged lines</M>`,
      ...long.slice(-CTX_EDGE_ROWS).map(text => `  ${text}`),
    ])
    // The marker wraps with the width, unbanded, and stays uncolored without a palette.
    expect(paintDiffRows(ctxOps(long), 12, helpers).slice(CTX_EDGE_ROWS, CTX_EDGE_ROWS + 3)).toEqual(['⋯ 7', 'unchanged', 'lines'])
    // Elision resets between separate runs around a change.
    const mixed = alignDiffLines('1\n2\n3\nx\n7\n8\n9\n10\n11\n12\n13\n14\n15', '1\n2\n3\ny\n7\n8\n9\n10\n11\n12\n13\n14\n15')
    const painted = paintDiffRows(mixed, 40, helpers)
    expect(painted).toContain('- x')
    expect(painted).toContain('+ y')
  })
})


it('numbers separated hunks correctly through insertions, removals, and omitted context', () => {
  const before = Array.from({ length: 35 }, (_, index) => `line ${index + 1}`)
  const after = [...before]
  after.splice(8, 1, 'replacement', 'inserted')
  after.splice(26, 1)
  const ops = alignDiffLines(before.join('\n'), after.join('\n'))
  const helpers = { wrapText: wrapTextWithAnsi, visibleWidth }
  const rows = paintDiffRows(ops, 80, helpers)
  expect(rows.filter(row => row.startsWith('@@'))).toEqual(['@@ -6,7 +6,8 @@', '@@ -23,7 +24,6 @@'])
  expect(rows).toContain('+ inserted')
  expect(rows).toContain('- line 26')
  const paint = (value: string) => value
  const colors = { text: paint, diffAdded: paint, diffRemoved: paint, diffAddedBg: paint, diffRemovedBg: paint, diffMeta: paint }
  for (const width of [1, 4, 20, 80]) for (const row of paintDiffRows(ops, width, helpers, colors)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
  const start = [...before]
  start[0] = 'new first line'
  start[30] = 'new last hunk'
  expect(paintDiffRows(alignDiffLines(before.join('\n'), start.join('\n')), 80, helpers)[0]).toBe('@@ -1,4 +1,4 @@')
})
