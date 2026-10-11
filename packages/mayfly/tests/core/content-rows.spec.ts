/**
 * Windowed content painters (`core/content-rows.ts`): the lazy `RowSource`s behind the content leaf kinds. A source
 * reports a live length that converges as estimates become painted counts, paints only the segments a window reads,
 * and bounds itself to the viewport plus an elision row outside a scroll while keeping the full document on the
 * `unclamped` chain.
 *
 * @module @ephemeral-ai/mayfly/core/tests/content-rows
 */

import { describe, expect, it } from 'vitest'
import { CONTENT_SEGMENT_LINES } from '../../src/core/content-segments.ts'
import { contentNodeRows, contentNodeSource, type ContentRowsEnv, type WindowedContentNode } from '../../src/core/content-rows.ts'
import { alignDiffLines, diffModel, paintDiffRows } from '../../src/core/diff-align.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { MAYFLY_CONTENT_CACHE_BYTES, MayflyContentCache } from '../../src/core/ui-content-cache.ts'
import { isVirtualRows, materializedRows, prepareRows, rowSourceOf, unclampedRows } from '../../src/core/ui-rows.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'

const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/gu
const strip = (row: string): string => row.replace(ANSI, '')

const components = {
  visibleWidth,
  wrapText: wrapTextWithAnsi,
  truncateToWidth,
} as MayflyComponents

interface Env {
  readonly env: ContentRowsEnv
  readonly counters: MayflyWorkCounters
  readonly cache: MayflyContentCache
  readonly reports: string[]
}

function makeEnv(bound?: number, colors: MayflySemanticColors = DARK_COLORS): Env {
  const counters = createWorkCounters()
  const cache = new MayflyContentCache()
  const reports: string[] = []
  return {
    counters,
    cache,
    reports,
    env: {
      components,
      colors,
      counters,
      cache,
      bounded: bound !== undefined,
      viewportRows: () => bound ?? 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
      report: message => { reports.push(message) },
    },
  }
}

function source(node: WindowedContentNode, width: number, bound?: number): { rows: string[], env: Env } {
  const env = makeEnv(bound)
  return { rows: contentNodeRows(node, width, env.env), env }
}

describe('contentNodeSource', () => {
  it('indexes a large text once and paints only the segments a window reads', () => {
    // Past the one-segment paint budget the source stays lazy: rows read on demand, the rest stay estimates.
    // Each line is one row at this width, so row and line indices agree while the document stays past the budget.
    const lines = Array.from({ length: CONTENT_SEGMENT_LINES * 3 }, (_, index) => `line ${String(index)} ${'x'.repeat(30)}`)
    const { rows, env } = source({ kind: 'text', content: lines.join('\n') }, 40)
    expect(isVirtualRows(rows)).toBe(true)
    expect(env.counters.linesEstimated).toBe(lines.length)
    expect(env.counters.segmentsPainted).toBe(0)
    expect(materializedRows(rows)).toBe(0)
    // Reading one row paints its whole segment, nothing else.
    const at = CONTENT_SEGMENT_LINES + 5
    expect(strip(rows[at]!)).toContain(`line ${String(at)}`)
    expect(env.counters.segmentsPainted).toBe(1)
    expect(materializedRows(rows)).toBe(1)
    // The facade retains what it produced; a second read is free.
    expect(rows[at]).toBe(rows[at])
    expect(env.counters.segmentsPainted).toBe(1)
  })

  it('paints a small document eagerly so its row map is exact at once', () => {
    const { rows, env } = source({ kind: 'text', content: 'a\nb\nc' }, 10)
    expect(env.counters.segmentsPainted).toBeGreaterThan(0)
    expect(rows.length).toBe(3)
    expect(materializedRows(rows)).toBe(0)
  })

  it('converges its live length as estimates become painted counts', () => {
    // A document past the paint budget starts on estimates and converges under the window it paints.
    const prose = `${'word '.repeat(1000).trim()}\nshort`
    const { rows } = source({ kind: 'text', content: prose }, 10)
    const exact = wrapTextWithAnsi('word '.repeat(1000).trim(), 10).length + 1
    expect(rows.length).toBeGreaterThan(0)
    prepareRows(rows, 0, rows.length)
    expect(rows.length).toBe(exact)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(10)
  })

  it('serves a repainted segment from the shared cache instead of painting again', () => {
    const text = 'abcdefghij '.repeat(200).trim()
    const node: WindowedContentNode = { kind: 'text', content: text }
    const { rows, env } = source(node, 20)
    prepareRows(rows, 0, 5)
    const painted = env.counters.segmentsPainted
    expect(painted).toBeGreaterThan(0)
    expect(strip(rows[0]!)).not.toBe('')
    expect(env.counters.segmentsPainted).toBe(painted)
    // The same node at the same width answers from the renderer's cache, not a repaint.
    const again = contentNodeRows(node, 20, env.env)
    expect(again[0]).toBe(rows[0])
    expect(env.counters.segmentsPainted).toBe(painted)
  })

  it('bounds an outside-window leaf and unclamps inside a scroll', () => {
    const content = Array.from({ length: 50 }, (_, index) => `row ${String(index)}`).join('\n')
    const { rows } = source({ kind: 'text', content }, 20, 10)
    expect(rows.length).toBe(11)
    expect(strip(rows[10]!)).toBe('…40')
    const full = unclampedRows(rows)
    expect(full.length).toBe(50)
    expect(strip(full[49]!)).toBe('row 49')
  })

  it('contains a throwing paint into an error row for that segment and reports it once', () => {
    const held = makeEnv()
    const throwing: MayflyComponents = { ...components, wrapText: (text, width) => {
      if (text.includes('explodes')) throw new Error('paint blew up')
      return wrapTextWithAnsi(text, width)
    } }
    const env: ContentRowsEnv = { ...held.env, components: throwing }
    const content = Array.from({ length: CONTENT_SEGMENT_LINES * 4 }, (_, index) => index === 3 ? 'explodes' : `line ${String(index)} ${'x'.repeat(30)}`).join('\n')
    const rows = contentNodeRows({ kind: 'text', content }, 40, env)
    const materialized = [...rows].map(strip)
    // The segment holding 'explodes' collapses to one error row; the live source length shrinks under the facade's
    // fixed backing, so the next segment's first line follows the error row and the stale tail reads as blanks.
    expect(materialized[0]).toBe('<error>paint blew up</error>')
    expect(materialized[1]).toBe(`line ${String(CONTENT_SEGMENT_LINES)} ${'x'.repeat(30)}`)
    expect(materialized.at(-1)).toBe('')
    expect(held.reports).toEqual(['paint blew up'])
  })

  it('rejects malformed view data before a row is read', () => {
    expect(() => contentNodeSource({ kind: 'fields', rows: null } as never, 20, makeEnv().env)).toThrow('fields rows')
    expect(() => contentNodeSource({ kind: 'sections', sections: [null] } as never, 20, makeEnv().env)).toThrow('section is invalid')
  })

  it('clamps every produced row to the leaf width, however the painter drew it', () => {
    const { rows } = source({ kind: 'code', code: 'x'.repeat(500) }, 20)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(20)
  })

  it('keeps every column of a cut long line, bounded and in order', () => {
    // A line past the cut threshold paints through the character wrap: the cut loses and repeats no column, and the
    // only drift from a continuous wrap is a short seam row where a boundary lands inside one.
    const long = 'x'.repeat(40_000)
    const { rows } = source({ kind: 'code', code: long }, 100)
    const painted = [...rows].map(strip)
    expect(painted.join('')).toBe(long)
    expect(painted.every(row => row.length > 0)).toBe(true)
    expect(painted.length - Math.ceil(40_000 / 100)).toBeLessThanOrEqual(Math.ceil(40_000 / 16_384))
  })

  it('numbers only the first wrapped row of a code line and paints the language header', () => {
    const { rows } = source({ kind: 'code', code: `${'a'.repeat(90)}\nshort`, language: 'ts', numbered: true }, 60)
    const materialized = [...rows].map(strip)
    expect(materialized[0]).toBe('ts')
    // Two source lines → a one-digit gutter: ' 1 │ '.
    expect(materialized[1]).toMatch(/^ *1 │ a+$/u)
    // The wrapped continuation of line 1 is gutter-blank.
    expect(materialized[2]).toMatch(/^ {4}a+$/u)
    expect(materialized.at(-1)).toMatch(/^ *2 │ short$/u)
  })

  it('keeps fields labels aligned across a wrapping value and through a window', () => {
    const node: WindowedContentNode = {
      kind: 'fields',
      rows: [
        { label: 'short', value: [{ text: 'v1' }] },
        { label: 'a-much-longer-label', value: [{ text: 'x'.repeat(60), tone: 'accent' }] },
      ],
    }
    const { rows } = source(node, 40)
    const materialized = [...rows].map(strip)
    expect(materialized[0]).toBe('short:               v1')
    expect(materialized[1]).toMatch(/^a-much-longer-label:/u)
    expect(materialized.join('')).toContain('x'.repeat(60))
    for (const row of materialized) expect(row.length).toBeLessThanOrEqual(40)
  })

  it('wraps rich-text spans preserving content, and truncates under the truncate overflow', () => {
    const { rows } = source({ kind: 'rich-text', spans: [
      { text: 'plain ', styles: ['strong'] },
      { text: 'accented', tone: 'accent', styles: ['italic'] },
    ] }, 80)
    const materialized = [...rows].map(strip)
    expect(materialized).toEqual(['plain accented'])
    const truncated = source({ kind: 'rich-text', overflow: 'truncate', spans: [{ text: 'long '.repeat(30).trim() }] }, 10)
    expect(visibleWidth(truncated.rows[0]!)).toBeLessThanOrEqual(10)
  })

  it('is marker-free and declares a width without reading a row', () => {
    const { rows } = source({ kind: 'text', content: 'a\nb\nc' }, 10)
    expect(rowSourceOf(rows)?.declaredWidth).toBeLessThanOrEqual(10)
    expect(rowSourceOf(rows)?.markerFree).toBe(true)
    expect(materializedRows(rows)).toBe(0)
  })

  it('scrolls a 50 MB document end to end while the cache holds its byte budget', { timeout: 120_000 }, () => {
    // 27k lines of ~2 KB: one wrapped row each at this width, so ~53 MB churns through a 64 MB cache. The scroll
    // window sweeps top to bottom; every `put` must leave the cache inside its budget, and evicted rows repaint
    // on demand — a row read after the sweep still answers correctly.
    const line = (index: number) => `line ${String(index).padStart(6, '0')} ${'x'.repeat(1_980)}`
    const content = Array.from({ length: 27_000 }, (_, index) => line(index)).join('\n')
    expect(content.length).toBeGreaterThan(50 * 1024 * 1024)
    const held = makeEnv()
    const cache = held.cache as MayflyContentCache & { put: (key: string, rows: readonly string[], bytes: number) => void }
    const put = cache.put.bind(cache)
    cache.put = (key, rows, bytes) => {
      put(key, rows, bytes)
      expect(cache.bytes).toBeLessThanOrEqual(MAYFLY_CONTENT_CACHE_BYTES)
    }
    const rows = contentNodeRows({ kind: 'text', content }, 2_000, held.env)
    let painted = 0
    for (let at = 0; at < rows.length; at += 500) {
      prepareRows(rows, at, Math.min(at + 500, rows.length))
      painted += 1
    }
    expect(painted).toBeGreaterThan(10)
    expect(cache.bytes).toBeLessThanOrEqual(MAYFLY_CONTENT_CACHE_BYTES)
    // Evicted segments still answer: cold reads repaint rather than corrupt.
    expect(strip(rows[0]!)).toContain('line 000000')
    expect(strip(rows[12_345]!)).toContain('line 012345')
    expect(strip(rows[rows.length - 1]!)).toContain('line 026999')
  })

  it('paints a diff only in the chunks a window reads, its length exact from the hunk model', () => {
    // ~400 changed lines far past the chunk budget: the source stays lazy, and its length is the model's exact total.
    const before = Array.from({ length: 400 }, (_, index) => `old ${String(index)}`).join('\n')
    const after = Array.from({ length: 400 }, (_, index) => `new ${String(index)}`).join('\n')
    const node: WindowedContentNode = { kind: 'diff', before, after }
    const { rows, env } = source(node, 40)
    const exact = diffModel(alignDiffLines(before, after), {}).length
    expect(rows.length).toBe(exact)
    expect(env.counters.segmentsPainted).toBe(0)
    // One row read paints its ≤64-line chunk only.
    const at = CONTENT_SEGMENT_LINES + 5
    expect(strip(rows[at]!)).toContain(`old ${String(at)}`)
    expect(env.counters.segmentsPainted).toBe(1)
    // The whole materialized facade is row-for-row the eager painter's output.
    const eager = paintDiffRows(alignDiffLines(before, after), 40, components, DARK_COLORS)
    for (const [index, row] of [...rows].entries()) expect(row).toBe(eager[index])
  })

  it('paints a small diff eagerly and aligns a node once across widths', () => {
    const node: WindowedContentNode = { kind: 'diff', before: 'a\nb\nc', after: 'a\nx\nc' }
    const { rows, env } = source(node, 40)
    expect(env.counters.segmentsPainted).toBeGreaterThan(0)
    expect([...rows].map(row => strip(row).trimEnd())).toEqual(['    1   1 │   a', '    2     │ − b', '        2 │ + x', '    3   3 │   c'])
    // The alignment lives on the node: a second width repaints the same kept rows without re-aligning.
    const aligned = env.counters.linesEstimated
    contentNodeRows(node, 60, env.env)
    expect(env.counters.linesEstimated).toBe(aligned)
  })

  it('bounds a diff outside a scroll and unclamps it inside one', () => {
    const before = Array.from({ length: 30 }, (_, index) => `v${String(index)}`).join('\n')
    const after = Array.from({ length: 30 }, (_, index) => `w${String(index)}`).join('\n')
    const { rows } = source({ kind: 'diff', before, after }, 40, 10)
    expect(rows.length).toBe(11)
    expect(strip(rows[10]!)).toBe('…50')
    const full = unclampedRows(rows)
    expect(full.length).toBe(60)
    expect(strip(full[59]!).trimEnd()).toBe('       30 │ + w29')
  })
})

