/**
 * The diff alignment core: fast paths, prefix/suffix trim, LCS interleaving,
 * the oversized-input guard, change counts, and the painted rows with their
 * numbered gutters, context and ⋯ runs, row budget, and code-only bands.
 */

import { describe, expect, it } from 'vitest'
import {
  alignDiffLines,
  diffChangeCounts,
  DIFF_ALIGN_MAX_ROWS,
  paintDiffRows,
} from '../../src/core/diff-align.ts'
import { truncateToWidth, visibleWidth } from '../../src/core/width.ts'

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
  const helpers = { truncateToWidth, visibleWidth }
  const palette = {
    text: (text: string): string => `<T>${text}</T>`,
    diffAdded: (text: string): string => `<A>${text}</A>`,
    diffRemoved: (text: string): string => `<R>${text}</R>`,
    diffAddedBg: (text: string): string => `[A${text}A]`,
    diffRemovedBg: (text: string): string => `[R${text}R]`,
    diffMeta: (text: string): string => `<M>${text}</M>`,
    diffGutter: (text: string): string => `<G>${text}</G>`,
  }
  const plain = (rows: readonly string[]): string[] => rows.map(row => row.replace(/<\/?[A-Z]>|\[[AR]|[AR]\]/gu, ''))

  it('numbers both sides, signs changes with −/+, and keeps the band behind the code only', () => {
    const aligned = alignDiffLines('a\nb', 'a\nc')
    expect(paintDiffRows(aligned, 20, helpers)).toEqual(['    1   1 │   a', '    2     │ − b', '        2 │ + c'])
    // The tag palette counts its tags as cells, so these rows are wide enough not to clip.
    expect(paintDiffRows(aligned, 40, helpers, palette)).toEqual([
      '  <G>  1   1 │</G>   <T>a</T>',
      '  <G>  2     │</G> [R<R>−</R> <R>b</R>    R]',
      '  <G>      2 │</G> [A<A>+</A> <A>c</A>    A]',
    ])
    expect(paintDiffRows(aligned, 30, helpers, palette, { numbered: false })).toEqual([
      '    <T>a</T>',
      '  [R<R>−</R> <R>b</R>           R]',
      '  [A<A>+</A> <A>c</A>           A]',
    ])
  })

  it('keeps the context around each change, marks skipped runs with ⋯, and starts at a line number', () => {
    const before = Array.from({ length: 12 }, (_, index) => `l${String(index)}`)
    const after = before.map((line, index) => index === 2 || index === 9 ? `${line}!` : line)
    const rows = plain(paintDiffRows(alignDiffLines(before.join('\n'), after.join('\n')), 80, helpers, palette, { start: 100 }))
    expect(rows[0]).toBe('@@ -100,12 +100,12 @@')
    expect(rows).toContain('  ⋯')
    expect(rows.filter(row => row === '  ⋯')).toHaveLength(3)
    expect(rows).toContain('  101 101 │   l1')
    expect(rows).not.toContain('  100 100 │   l0')
    expect(paintDiffRows(alignDiffLines(before.join('\n'), after.join('\n')), 40, helpers, undefined, { hunkHeader: false, context: 0 })).toHaveLength(7)
    // One hunk has no header unless asked.
    expect(paintDiffRows(alignDiffLines('a\nb', 'a\nc'), 40, helpers)[0]).not.toContain('@@')
    expect(plain(paintDiffRows(alignDiffLines('a\nb', 'a\nc'), 80, helpers, palette, { hunkHeader: true }))[0]).toBe('@@ -1,2 +1,2 @@')
  })

  it('stops after maxRows with the remaining count and the Ctrl+O key', () => {
    const rows = plain(paintDiffRows(alignDiffLines('', 'a\nb\nc\nd'), 80, helpers, palette, { maxRows: 2 }))
    expect(rows.map(row => row.trimEnd())).toEqual(['        1 │ + a', '        2 │ + b', '  … +2 rows · Ctrl+O'])
  })

  it('ends a long line in … and pads real SGR bands to exactly the width', () => {
    const red = (text: string): string => `\x1b[38;2;1;2;3m${text}\x1b[39m`
    const band = (text: string): string => `\x1b[48;2;4;5;6m${text}\x1b[49m`
    const real = { text: red, diffAdded: red, diffRemoved: red, diffAddedBg: band, diffRemovedBg: band, diffMeta: red, diffGutter: red }
    const rows = paintDiffRows(alignDiffLines('', 'x\n\ty\nlong line that does not fit\n'), 24, helpers, real)
    expect(rows.map(row => visibleWidth(row))).toEqual([24, 24, 24])
    expect(rows[1]).not.toContain('\t')
    expect(rows[1]).toContain('   y')
    expect(rows[2]!.replace(/\x1b\[[0-9;]*m/gu, '')).toBe('        3 │ + long line…')
    // The band stays open through the ellipsis and the fill.
    expect(rows[2]!.slice(rows[2]!.indexOf('\x1b[48;2;4;5;6m'), -'\x1b[49m'.length)).not.toContain('\x1b[0m')
    expect(paintDiffRows(alignDiffLines('a long context line', 'a long context line\nb'), 16, helpers)[0]).toBe('    1   1 │   a…')
  })

  it('never paints past a degenerate width', () => {
    const aligned = alignDiffLines('ab', 'cd')
    for (const width of [0, 1, 2, 3, 6, 12, 13]) {
      for (const row of paintDiffRows(aligned, width, helpers)) expect(visibleWidth(row)).toBeLessThanOrEqual(Math.max(1, width))
    }
    expect(paintDiffRows(aligned, 12, helpers)).toEqual(['    1     │ ', '        1 │ '])
  })
})
