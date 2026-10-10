/**
 * `indexContent` (core/content-segments.ts): the one-pass measure index under the windowed painters. The segment
 * plan must partition the text exactly — every line and every unit belongs to one segment — keep its bounds, and
 * price segments cheaply enough that a document's row map exists before a row is painted.
 *
 * @module @ephemeral-ai/mayfly/core/tests/content-segments
 */

import { describe, expect, it } from 'vitest'
import { CONTENT_CUT_UNITS, CONTENT_SEGMENT_LINES, CONTENT_SEGMENT_UNITS, indexContent } from '../../src/core/content-segments.ts'
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
})
