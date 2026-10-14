/**
 * `indexContent` (core/content-segments.ts): the one-pass measure index under the windowed painters. The segment
 * plan must partition the text exactly — every line and every unit belongs to one segment — keep its bounds, and
 * price segments cheaply enough that a document's row map exists before a row is painted.
 *
 * @module @ephemeral-ai/mayfly/core/tests/content-segments
 */

import { describe, expect, it } from 'vitest'
import { CONTENT_CUT_UNITS, CONTENT_SEGMENT_LINES, CONTENT_SEGMENT_UNITS, extendMergedLines, indexContent, indexMergedLines, scanContentLines, type ContentIndex } from '../../src/core/content-segments.ts'
import { wrapTextWithAnsi } from '../../src/core/width.ts'

/** The segment plan as readable tuples: kind, first line, lines, first unit, units, estimated columns. */
function plan(text: string): { kind: number, line0: number, line1: number, text0: number, text1: number }[] {
  const index = indexContent(text)
  return Array.from({ length: index.segments }, (_, segment) => {
    const [line0, line1] = index.segmentLines(segment)
    const [text0, text1] = index.segmentText(segment)
    return { kind: index.isCut(segment) ? 1 : 0, line0, line1, text0, text1 }
  })
}

/**
 * Every line of the text belongs to exactly one segment: whole-line runs tile the line sequence contiguously, and a
 * cut line's cuts cover it contiguously and completely before the next line starts.
 */
function expectPartition(text: string): void {
  const index = indexContent(text)
  let expectLine = 0
  let expectUnit = 0
  for (let segment = 0; segment < index.segments; segment += 1) {
    const [line0, line1] = index.segmentLines(segment)
    const [text0, text1] = index.segmentText(segment)
    if (index.isCut(segment)) {
      const [lineStart, lineEnd] = index.lineText(line0)
      expect(line0, `cut ${String(segment)} line`).toBe(expectLine)
      expect(text0, `cut ${String(segment)} start`).toBe(expectUnit === 0 ? lineStart : expectUnit)
      expectUnit = text1
      if (text1 === lineEnd) { expectLine = line0 + 1; expectUnit = 0 }
    } else {
      expect(line0, `run ${String(segment)} line`).toBe(expectLine)
      expect(text0, `run ${String(segment)} start`).toBe(index.lineText(line0)[0])
      expect(text1, `run ${String(segment)} end`).toBe(index.lineText(line1 - 1)[1])
      expectLine = line1
      expectUnit = 0
    }
  }
  expect(expectLine).toBe(index.lines)
}

describe('indexContent', () => {
  it('makes one segment of a small document and one row per empty line in the estimate', () => {
    const index = indexContent('a\n\nb')
    expect(index.lines).toBe(3)
    expect(index.segments).toBe(1)
    expect(index.isCut(0)).toBe(false)
    expect(index.estimateRows(0, 10)).toBe(3)
    expect(index.maxColumns).toBe(1)
    expect(index.lineText(1)).toEqual([2, 2])
  })

  it('bounds a line run by lines and by units', () => {
    const many = Array.from({ length: CONTENT_SEGMENT_LINES * 2 + 5 }, (_, index) => `l${String(index)}`).join('\n')
    const linesPlan = plan(many)
    expect(linesPlan.filter(part => part.kind === 0)).toHaveLength(3)
    expect(linesPlan[0]).toMatchObject({ line0: 0, line1: CONTENT_SEGMENT_LINES })
    const wide = Array.from({ length: 10 }, () => 'x'.repeat(CONTENT_SEGMENT_UNITS)).join('\n')
    for (const part of plan(wide)) expect(part.text1 - part.text0).toBeLessThanOrEqual(CONTENT_SEGMENT_UNITS)
  })

  it('cuts a line at the cut threshold into column samples and resumes line runs after it', () => {
    const long = 'x'.repeat(CONTENT_CUT_UNITS + 100)
    const text = `head\n${long}\ntail`
    const parts = plan(text)
    const cuts = parts.filter(part => part.kind === 1)
    expect(cuts.length).toBeGreaterThanOrEqual(2)
    for (const cut of cuts) expect(cut.line0).toBe(1)
    expect(parts.at(-1)).toMatchObject({ kind: 0, line0: 2 })
    expectPartition(text)
    // A short line just under the threshold stays a whole line in a run.
    const under = `a\n${'y'.repeat(CONTENT_CUT_UNITS - 1)}\nb`
    expect(plan(under).every(part => part.kind === 0)).toBe(true)
  })

  it('cuts a wide line of astral characters on code-point boundaries', () => {
    const wide = '🙂'.repeat(CONTENT_CUT_UNITS)
    const index = indexContent(wide)
    expect(index.segments).toBeGreaterThanOrEqual(2)
    for (let segment = 0; segment < index.segments - 1; segment += 1) {
      const [, end] = index.segmentText(segment)
      const [nextStart] = index.segmentText(segment + 1)
      expect(nextStart).toBe(end)
      // A boundary never splits a surrogate pair.
      const code = wide.charCodeAt(end)
      expect(code < 0xdc00 || code > 0xdfff).toBe(true)
    }
    expectPartition(wide)
  })

  it('estimates wrapped rows so the painted count can only drift a little', () => {
    const prose = 'the quick brown fox jumps over the lazy dog '.repeat(200).trim()
    const index = indexContent(prose)
    const estimated = index.estimateRows(0, 40)
    const painted = wrapTextWithAnsi(prose, 40).length
    expect(Math.abs(estimated - painted)).toBeLessThanOrEqual(Math.ceil(painted / 4) + 1)
    expect(estimated).toBeGreaterThan(0)
  })

  it('keeps the text ranges of every segment inside the document', () => {
    const text = `one\n${'二'.repeat(200)}\nthree\n\nfive`
    expectPartition(text)
    const index = indexContent(text)
    expect(index.units).toBe(text.length)
    expect(index.lineColumns(1)).toBe(400)
    expect(index.maxColumns).toBe(400)
  })

  it('maps offsets and rows inside both segment kinds', () => {
    const text = `aa\nbbbbb\ncc\n${'x'.repeat(CONTENT_CUT_UNITS + 40)}\nzz`
    const index = indexContent(text)
    const cut = 1
    expect(index.isCut(0)).toBe(false)
    expect(index.isCut(cut)).toBe(true)
    // Inside a line run an offset mid-line counts its wrapped share; an offset past a line counts it whole.
    expect(index.rowOfOffset(0, 4, 5, text)).toBe(1)
    expect(index.rowOfOffset(0, 9, 5, text)).toBe(2)
    // Inside a cut the map is column samples; a row past the end clamps to the segment's own end.
    const [, cutEnd] = index.segmentText(cut)
    expect(index.rowOfOffset(cut, cutEnd, 10, text)).toBeGreaterThan(0)
    expect(index.offsetOfRow(cut, 9_999, 10, text)).toBe(cutEnd)
    expect(index.offsetOfRow(0, 1, 5, text)).toBe(3)
    // An empty line counts one row in both directions of the map.
    const gapText = 'aa\n\nbbbbb'
    const gaps = indexContent(gapText)
    expect(gaps.rowOfOffset(0, 4, 5, gapText)).toBe(2)
    expect(gaps.offsetOfRow(0, 1, 5, gapText)).toBe(3)
    // The seek steps a surrogate pair as one position and single steps plain characters.
    const astralText = `🙂🙂🙂\ntail`
    const astral = indexContent(astralText)
    expect(astral.offsetOfRow(0, 1, 2, astralText)).toBe(2)
    expect(astral.offsetOfRow(0, 4, 2, astralText)).toBe(9)
    expect(astral.offsetOfRow(0, 5, 2, astralText)).toBe(astralText.length)
  })
})

describe('indexMergedLines', () => {
  /** A merged index agrees with the one-pass index of the joined text on every line and column. */
  function expectMerged(chunks: readonly string[], expected: string = chunks.join('')): void {
    const merged = indexMergedLines(chunks.map(scanContentLines), expected)
    const direct = indexContent(expected)
    expect(merged.lines).toBe(direct.lines)
    expect(merged.units).toBe(direct.units)
    expect(merged.maxColumns).toBe(direct.maxColumns)
    for (let line = 0; line < merged.lines; line += 1) {
      expect(merged.lineText(line), `line ${String(line)}`).toEqual(direct.lineText(line))
      expect(merged.lineColumns(line), `line ${String(line)} columns`).toBe(direct.lineColumns(line))
      expect(expected.slice(...merged.lineText(line) as [number, number])).toBe(expected.slice(...direct.lineText(line) as [number, number]))
    }
  }

  it.each([
    [['a\nb', 'c\nd']],
    [['a', 'b']],
    [['a', 'b', 'c']],
    [['a\nb', 'c']],
    [['ab', 'c\nd']],
    [['a', 'b\n', 'c']],
    [['a', '\n', 'b']],
    [['a\n', 'b\n']],
    [['a\n', '\nb']],
    [['', 'a']],
    [['a', '']],
    [['', '']],
    [['a\n', '']],
    [['\n', 'a']],
    [['a\n\nb', 'c\n\nd\n']],
    [['x'.repeat(CONTENT_SEGMENT_UNITS + 5), 'y']],
    [['start', 'x'.repeat(CONTENT_CUT_UNITS + 5), 'end']],
    [['🚀', 'a\n', '中文', 'end\n']],
    [['🚀'.repeat(3), '\u{1F680}tail']],
    [['tail\u{1F680}', '\u{1F680}head']],
    [['one\r', '\ntwo']],
  ])('joins the same lines the one-pass index finds %#', expectMerged)

  it('leaves one empty line for an empty field or empty scans, like the string path', () => {
    expectMerged([])
    expectMerged([''])
    const merged = indexMergedLines([], '')
    expect(merged.lines).toBe(1)
    expect(merged.lineText(0)).toEqual([0, 0])
  })

  it('keeps merged segments a partition of the joined text', () => {
    const chunks = ['header\n', `${'line '.repeat(30)}\n`.repeat(70), 'open tail']
    const text = chunks.join('')
    const merged = indexMergedLines(chunks.map(scanContentLines), text)
    const direct = indexContent(text)
    expect(merged.segments).toBe(direct.segments)
    for (let segment = 0; segment < merged.segments; segment += 1)
      expect(merged.segmentText(segment), `segment ${String(segment)}`).toEqual(direct.segmentText(segment))
  })

  it('reports the merged line count through onLines once per index', () => {
    let lines = -1
    indexMergedLines(['a\n', 'b\n', 'c'].map(scanContentLines), 'a\nb\nc', count => { lines = count })
    expect(lines).toBe(3)
  })
})

describe('extendMergedLines', () => {
  /** Everything an index answers, at two widths, so an extended index is held to the scratch one on every query. */
  function describeIndex(index: ContentIndex): unknown {
    return {
      lines: index.lines, units: index.units, segments: index.segments, maxColumns: index.maxColumns,
      lineRows: Array.from({ length: index.lines }, (_, line) => [index.lineText(line), index.lineColumns(line)]),
      segmentRows: Array.from({ length: index.segments }, (_, segment) => [index.segmentLines(segment), index.segmentText(segment), index.isCut(segment), index.estimateRows(segment, 7), index.estimateRows(segment, 80)]),
    }
  }

  /** Index `chunks`, append `more` one chunk at a time, and hold every step to the scratch index of the same chunks. */
  function expectAppends(chunks: readonly string[], more: readonly string[]): void {
    let held = [...chunks]
    let index = indexMergedLines(held.map(scanContentLines), held.join(''))
    for (const next of more) {
      held = [...held, next]
      const text = held.join('')
      index = extendMergedLines(index, [scanContentLines(next)], text)
      expect(describeIndex(index), `after appending ${String(next.length)} units to ${String(held.length - 1)} chunks`).toEqual(describeIndex(indexMergedLines(held.map(scanContentLines), text)))
    }
  }

  const longLine = 'word '.repeat(CONTENT_CUT_UNITS / 4)
  // Letters up to the cut threshold, then wide characters across it: the cut lands before the wide run, at the last plain boundary.
  const straddling = `${'a'.repeat(4_090)}${'中'.repeat(30)}`.repeat(4)

  it.each([
    [[], ['a', 'b\n', '\n', 'c\nd', '']],
    [['a\n'], ['b\n', 'c']],
    [['open'], [' still open', ' and closed\n', 'next']],
    [[''], ['x']],
    [[`${'line\n'.repeat(70)}tail`], ['\n', 'more\n']],
    [['x'.repeat(CONTENT_SEGMENT_UNITS - 3)], ['yyyy', '\nz', 'z']],
    [['🚀'], ['\u{1F680}', 'a\n', '中文', 'end\n']],
    [['tail\u{1F680}'], ['\u{1F680}head']],
    [['head\n', longLine.slice(0, 3_000)], [longLine.slice(3_000, 9_000), longLine.slice(9_000), ' end of the long line', '\nafter\n']],
    [['first\n', longLine], [longLine, 'x\n', 'short\n', longLine, 'tail']],
    [[`${longLine}\n${'short\n'.repeat(100)}`], ['more short\n', longLine, longLine]],
    [['head\n', straddling], [straddling, '中'.repeat(100), 'tail\n', straddling]],
    // The last cut of the index starts where the first one stopped short of three wide characters; the appended letters cross the next threshold from there.
    [[`${'a'.repeat(4_090)}中中中${'\u0301'.repeat(13_000)}`], ['a'.repeat(5_000), 'b'.repeat(5_000)]],
    [[straddling.slice(0, 9_000)], [straddling.slice(9_000, 13_000), straddling.slice(13_000)]],
  ])('equals the scratch index after each append %#', expectAppends)

  it('equals the scratch index over random chunkings of text with long lines and wide characters', () => {
    let seed = 11
    const random = (limit: number): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % limit }
    const pieces = ['plain words here ', '\n', '\n\n', '中文宽字符', '🚀', '\u{1F468}‍\u{1F469}‍\u{1F467}', 'tab\tstop', 'x'.repeat(2_000), longLine, 'é']
    for (let round = 0; round < 24; round += 1) {
      const pool = [...pieces, ...Array.from({ length: 3 }, () => `${'a'.repeat(4_070 + random(40))}${'中'.repeat(1 + random(40))}`)]
      const chunks = Array.from({ length: 1 + random(6) }, () => Array.from({ length: random(8) }, () => pool[random(pool.length)]!).join(''))
      const more = Array.from({ length: 1 + random(8) }, () => Array.from({ length: random(6) }, () => pool[random(pool.length)]!).join(''))
      expectAppends(chunks, more)
    }
  })

  it('walks the lines an append touches, not the lines of the text', () => {
    const settled = 'a settled line of job output\n'.repeat(50_000)
    const text = `${settled}open`
    const index = indexMergedLines([settled, 'open'].map(scanContentLines), text)
    const walked: number[] = []
    extendMergedLines(index, [scanContentLines(' and more\nnext\n')], `${text} and more\nnext\n`, lines => walked.push(lines))
    expect(index.lines).toBe(50_001)
    expect(walked).toHaveLength(1)
    expect(walked[0]).toBeLessThanOrEqual(CONTENT_SEGMENT_LINES + 3)
  })
})

describe('segment plan resumes and clamps', () => {
  it('resumes a plan at the last segment that starts at or before the changed line, and the last segment past the end', () => {
    const text = `aa\nbbbbb\ncc\n${'x'.repeat(CONTENT_CUT_UNITS + 40)}\nzz`
    const index = indexContent(text)
    const segments = plan(text)
    expect(index.resumeFrom(0)).toMatchObject({ segment: 0 })
    for (const line of [1, 3, 4, 99]) {
      expect(index.resumeFrom(line)).toMatchObject({ segment: segments.findLastIndex(each => each.line0 <= line) })
    }
  })

  it('maps an offset at the end of a line run past its last line to the rows the run holds', () => {
    const text = 'aa\nbbbbb\ncc\n'
    const index = indexContent(text)
    const [, end] = index.segmentText(0)
    expect(index.rowOfOffset(0, end, 5, text)).toBeGreaterThanOrEqual(2)
    expect(index.rowOfOffset(0, end + 50, 5, text)).toBe(index.rowOfOffset(0, end, 5, text))
  })
})

