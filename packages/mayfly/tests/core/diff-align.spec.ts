/**
 * The diff alignment core: fast paths, prefix/suffix trim, Myers interleaving,
 * the anchored split past the edit bound and the block degrade, change counts,
 * and the painted rows with their numbered gutters, context and ⋯ runs, row
 * budget, and code-only bands.
 */

import { describe, expect, it } from 'vitest'
import {
  alignDiffLines,
  diffChangeCounts,
  DIFF_ALIGN_MAX_EDITS,
  paintDiffRows,
} from '../../src/core/diff-align.ts'
import { truncateToWidth, visibleWidth } from '../../src/core/width.ts'
import { plainText } from '../helpers.ts'

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

  it('splits a middle past the edit bound at unique lines and keeps aligning inside the halves', () => {
    // 312 changed + 312 kept lines per side of unique lines: over DIFF_ALIGN_MAX_EDITS together, under it halved.
    const half = DIFF_ALIGN_MAX_EDITS / 2 - 200
    const before = [...Array.from({ length: half }, (_, index) => `b${String(index)}`), ...Array.from({ length: half }, (_, index) => `same-${String(index)}`), 'anchor', ...Array.from({ length: half }, (_, index) => `c${String(index)}`), ...Array.from({ length: half }, (_, index) => `same-${String(half + index)}`)]
    const after = [...Array.from({ length: half }, (_, index) => `a${String(index)}`), ...Array.from({ length: half }, (_, index) => `same-${String(index)}`), 'anchor', ...Array.from({ length: half }, (_, index) => `d${String(index)}`), ...Array.from({ length: half }, (_, index) => `same-${String(half + index)}`)]
    const aligned = ops(before.join('\n'), after.join('\n'))
    // The anchor holds: real alignment inside both halves, never whole-block del+add over the whole input.
    expect(aligned).toContainEqual(['ctx', 'anchor'])
    expect(aligned).toContainEqual(['ctx', 'same-0'])
    expect(aligned).toContainEqual(['ctx', `same-${String(half * 2 - 1)}`])
    expect(diffChangeCounts(before.join('\n'), after.join('\n'))).toEqual({ added: half * 2, removed: half * 2 })
  })

  it('degrades an anchorless rewrite to whole blocks instead of an unbounded walk', () => {
    const before = Array.from({ length: DIFF_ALIGN_MAX_EDITS + 5 }, (_, index) => `b${String(index)}`).join('\n')
    const after = Array.from({ length: DIFF_ALIGN_MAX_EDITS + 5 }, (_, index) => `a${String(index)}`).join('\n')
    const aligned = alignDiffLines(before, after)
    expect(aligned).toHaveLength((DIFF_ALIGN_MAX_EDITS + 5) * 2)
    expect(aligned[0]).toEqual({ type: 'del', text: 'b0' })
    expect(aligned[DIFF_ALIGN_MAX_EDITS + 5]).toEqual({ type: 'add', text: 'a0' })
    expect(diffChangeCounts(before, after)).toEqual({ added: DIFF_ALIGN_MAX_EDITS + 5, removed: DIFF_ALIGN_MAX_EDITS + 5 })
  })

  it('aligns a middle of hundreds of thousands of lines without spreading it into one call', () => {
    // A one-sided middle is its own alignment; an argument-list spread of it overflowed the stack near 120,000 ops.
    const inserted = Array.from({ length: 200_000 }, (_, index) => `line ${String(index)}`)
    const aligned = alignDiffLines('head\ntail', ['head', ...inserted, 'tail'].join('\n'))
    expect(aligned).toHaveLength(200_002)
    expect(aligned[0]).toEqual({ type: 'ctx', text: 'head' })
    expect(aligned[1]).toEqual({ type: 'add', text: 'line 0' })
    expect(aligned.at(-1)).toEqual({ type: 'ctx', text: 'tail' })
    expect(diffChangeCounts('head\ntail', ['head', ...inserted, 'tail'].join('\n'))).toEqual({ added: 200_000, removed: 0 })
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

  it('numbers every row (a removed line before the change, any other after it), signs changes with −/+, and keeps the band behind the code only', () => {
    const aligned = alignDiffLines('a\nb', 'a\nc')
    expect(paintDiffRows(aligned, 20, helpers)).toEqual(['  1 │   a', '  2 │ − b', '  2 │ + c'])
    // The tag palette counts its tags as cells, so these rows are wide enough not to clip.
    expect(paintDiffRows(aligned, 40, helpers, palette)).toEqual([
      '  <G>1 │</G>   <T>a</T>',
      '  <G>2 │</G> [R<R>−</R> <R>b</R>      R]',
      '  <G>2 │</G> [A<A>+</A> <A>c</A>      A]',
    ])
    expect(paintDiffRows(aligned, 30, helpers, palette, { numbered: false })).toEqual([
      '    <T>a</T>',
      '  [R<R>−</R> <R>b</R>       R]',
      '  [A<A>+</A> <A>c</A>       A]',
    ])
  })

  it('keeps the context around each change, marks skipped runs with ⋯, and starts at a line number', () => {
    const before = Array.from({ length: 12 }, (_, index) => `l${String(index)}`)
    const after = before.map((line, index) => index === 2 || index === 9 ? `${line}!` : line)
    const rows = plain(paintDiffRows(alignDiffLines(before.join('\n'), after.join('\n')), 80, helpers, palette, { start: 100 }))
    expect(rows[0]).toBe('@@ -100,12 +100,12 @@')
    expect(rows).toContain('  ⋯')
    expect(rows.filter(row => row === '  ⋯')).toHaveLength(3)
    expect(rows).toContain('  101 │   l1')
    expect(rows).not.toContain('  100 │   l0')
    expect(paintDiffRows(alignDiffLines(before.join('\n'), after.join('\n')), 40, helpers, undefined, { hunkHeader: false, context: 0 })).toHaveLength(7)
    // One hunk has no header unless asked.
    expect(paintDiffRows(alignDiffLines('a\nb', 'a\nc'), 40, helpers)[0]).not.toContain('@@')
    expect(plain(paintDiffRows(alignDiffLines('a\nb', 'a\nc'), 80, helpers, palette, { hunkHeader: true }))[0]).toBe('@@ -1,2 +1,2 @@')
  })

  it('stops after maxRows with the remaining count and the Ctrl+O key', () => {
    const rows = plain(paintDiffRows(alignDiffLines('', 'a\nb\nc\nd'), 80, helpers, palette, { maxRows: 2 }))
    expect(rows.map(row => row.trimEnd())).toEqual(['  1 │ + a', '  2 │ + b', '  … +2 rows · Ctrl+O'])
  })

  it('ends a long line in … and pads real SGR bands to exactly the width', () => {
    const red = (text: string): string => `\x1b[38;2;1;2;3m${text}\x1b[39m`
    const band = (text: string): string => `\x1b[48;2;4;5;6m${text}\x1b[49m`
    const real = { text: red, diffAdded: red, diffRemoved: red, diffAddedBg: band, diffRemovedBg: band, diffMeta: red, diffGutter: red }
    const rows = paintDiffRows(alignDiffLines('', 'x\n\ty\nlong line that does not fit\n'), 24, helpers, real)
    // A tint stops DIFF_INSET_COLUMNS short of the edge, so a changed row is that much narrower than the width.
    expect(rows.map(row => visibleWidth(row))).toEqual([20, 20, 20])
    expect(rows[1]).not.toContain('\t')
    expect(rows[1]).toContain('   y')
    expect(plainText(rows[2]!)).toBe('  3 │ + long line t…')
    // The band stays open through the ellipsis and the fill.
    expect(rows[2]!.slice(rows[2]!.indexOf('\x1b[48;2;4;5;6m'), -'\x1b[49m'.length)).not.toContain('\x1b[0m')
    expect(paintDiffRows(alignDiffLines('a long context line', 'a long context line\nb'), 16, helpers)[0]).toBe('  1 │   a long …')
  })

  it('never paints past a degenerate width', () => {
    const aligned = alignDiffLines('ab', 'cd')
    for (const width of [0, 1, 2, 3, 6, 12, 13]) {
      for (const row of paintDiffRows(aligned, width, helpers)) expect(visibleWidth(row)).toBeLessThanOrEqual(Math.max(1, width))
    }
    expect(paintDiffRows(aligned, 12, helpers)).toEqual(['  1 │ − ab', '  1 │ + cd'])
  })

  it('counts removed lines in the file before the change and the others in the file after it, from each side\'s own start', () => {
    // Two lines out, one in: the lines after the change are one number lower than before it.
    const aligned = alignDiffLines('k\nx\ny\nz', 'k\nw\nz')
    expect(plain(paintDiffRows(aligned, 40, helpers, palette)).map(row => row.trimEnd())).toEqual(['  1 │   k', '  2 │ − x', '  3 │ − y', '  2 │ + w', '  3 │   z'])
    expect(plain(paintDiffRows(aligned, 40, helpers, palette, { start: 10, beforeStart: 20 })).map(row => row.trimEnd())).toEqual([
      '  10 │   k', '  21 │ − x', '  22 │ − y', '  11 │ + w', '  12 │   z',
    ])
    // The gutter follows the largest number on either side, and never narrows below `numberWidth`.
    expect(plain(paintDiffRows(alignDiffLines('a', 'b'), 40, helpers, palette, { start: 8, beforeStart: 98 })).map(row => row.trimEnd())).toEqual(['  98 │ − a', '   8 │ + b'])
    expect(plain(paintDiffRows(alignDiffLines('a', 'b'), 40, helpers, palette, { numberWidth: 3 })).map(row => row.trimEnd())).toEqual(['    1 │ − a', '    1 │ + b'])
  })
})
