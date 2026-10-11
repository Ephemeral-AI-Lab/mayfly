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
import { charWrap, contentNodeSource, documentRowsSource, type ContentRowsEnv, type WindowedContentNode } from '../../src/core/content-rows.ts'
import { virtualRows } from '../../src/core/ui-rows.ts'
import { alignDiffLines, diffModel, paintDiffRows } from '../../src/core/diff-align.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { LIGHT_COLORS } from '../../src/core/theme-light.ts'
import { MAYFLY_CONTENT_CACHE_BYTES, MayflyContentCache } from '../../src/core/ui-content-cache.ts'
import { declaredWidthOf, findMarkerRow, isVirtualRows, materializedRows, prepareRows, rowSourceOf, unclampedRows } from '../../src/core/ui-rows.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { plainText } from '../helpers.ts'

/** The leaf's rows materialized through its production row source. */
const contentNodeRows = (node: WindowedContentNode, width: number, env: ContentRowsEnv): string[] =>
  virtualRows(contentNodeSource(node, width, env))


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
    expect(plainText(rows[at]!)).toContain(`line ${String(at)}`)
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

  it('indexes a chunked field by joining per-chunk scans, merging open lines across pieces', () => {
    // 'a\nb' + 'c\nd' is 'a\nbc\nd': the second chunk continues the first chunk's open line.
    const chunks = [{ text: 'a\nb' }, { text: 'c\nd' }, { text: 'e' }]
    const node: WindowedContentNode = { kind: 'text', content: chunks }
    const { rows, env } = source(node, 40)
    expect(env.counters.linesEstimated).toBe(3)
    expect(rows.length).toBe(3)
    expect(plainText(rows[0]!)).toBe('a')
    expect(plainText(rows[1]!)).toBe('bc')
    expect(plainText(rows[2]!)).toBe('de')
    // The same node identity re-answers from its own index — the merged scan is not rebuilt.
    const more = contentNodeRows(node, 40, env.env)
    expect(env.counters.linesEstimated).toBe(3)
    expect(more.length).toBe(3)
  })

  it('scans each chunk once per identity, so an appended tail costs only its new pieces', () => {
    let reads = 0
    const settled = { get text() { reads += 1; return 'a\nb\n' } }
    const tail = { get text() { reads += 1; return 'c' } }
    const first: WindowedContentNode = { kind: 'text', content: [settled] }
    source(first, 40)
    // The field's join reads each chunk once; its line scan reads it once more and keeps the table.
    expect(reads).toBe(2)
    // The republished node is a new object sharing the settled piece: the join reads both texts, but only the
    // new chunk scans — the settled piece's line table comes from the identity memo.
    const appended: WindowedContentNode = { kind: 'text', content: [settled, tail] }
    const { rows } = source(appended, 40)
    expect(reads).toBe(5)
    expect(rows.length).toBe(3)
    expect(plainText(rows[2]!)).toBe('c')
    // A node identity also memoizes its whole field index — neither the join nor a scan runs again.
    contentNodeRows(appended, 40, makeEnv().env)
    expect(reads).toBe(5)
  })

  it('extends the index of a stream it already built, however older pieces were joined or the head was lost', () => {
    // A job feed joins the smallest neighbours in its older half as it grows, so the chunks before the tail change
    // identity on an append; the text and the chunk the last publish ended on are what the next publish shares.
    const piece = (start: number): { text: string } => ({ text: Array.from({ length: 50 }, (_, line) => `step ${String(start + line)} wrote some output`).join('\n') + '\n' })
    const feed = Array.from({ length: 200 }, (_, index) => piece(index * 50))
    const made = makeEnv()
    const allRows = (chunks: readonly { text: string }[], width: number, at: ContentRowsEnv): string[] => {
      const rows = contentNodeRows({ kind: 'code', code: chunks } as WindowedContentNode, width, at)
      prepareRows(rows, 0, rows.length)
      return Array.from({ length: rows.length }, (_, row) => plainText(rows[row]!))
    }
    allRows(feed, 60, made.env)
    const built = made.counters.linesEstimated
    expect(built).toBe(200 * 50 + 1)

    // Append one piece after joining two neighbours in the middle: only the appended lines are estimated again.
    const joined = { text: feed[99]!.text + feed[100]!.text }
    const grown = [...feed.slice(0, 99), joined, ...feed.slice(101), piece(10_000)]
    const grownRows = allRows(grown, 60, made.env)
    expect(made.counters.linesEstimated - built).toBeLessThanOrEqual(CONTENT_SEGMENT_LINES + 51)
    expect(grownRows).toEqual(allRows(grown, 60, makeEnv().env))

    // The index was handed over: a field that no longer extends it (the head was lost) is indexed from scratch.
    const before = made.counters.linesEstimated
    const trimmed = grown.slice(10)
    const trimmedRows = allRows(trimmed, 60, made.env)
    expect(made.counters.linesEstimated - before).toBe(trimmed.map(chunk => chunk.text).join('').split('\n').length)
    expect(trimmedRows).toEqual(allRows(trimmed, 60, makeEnv().env))
  })

  it('answers a first read of an over-estimated segment from the row the painted map puts there', () => {
    // The index prices the escape sequences of a line as ordinary characters and the painter strips them, so a document of
    // colored text estimates far more rows than it paints. A reader that jumps without preparing reads a row the map
    // still places in a segment whose painted count then shrinks: the row has moved on, and an empty string must not
    // stand in for it.
    const colored = Array.from({ length: 400 }, (_, line) => Array.from({ length: 30 }, (_, at) => `\x1b[38;2;${String(line % 256)};20;30m${String.fromCharCode(97 + at % 26)}`).join('')).join('\n')
    const kinds: readonly WindowedContentNode[] = [
      { kind: 'text', content: colored },
      { kind: 'code', code: colored },
      { kind: 'markdown', source: colored.replaceAll('\n', '\n\n') },
    ]
    for (const node of kinds) {
      for (const width of [20, 40]) {
        const reference = documentRowsSource(node as never, width, makeEnv().env)!
        reference.prepare?.(0, Number.MAX_SAFE_INTEGER)
        const settled = reference.length
        const jumped = documentRowsSource(node as never, width, makeEnv().env)!
        expect(jumped.length, `${node.kind} at ${String(width)}: the estimate is past the painted rows`).toBeGreaterThan(settled)
        // Every row below the painted total exists, and the map is never shorter than that until it has converged.
        const reads: string[] = []
        for (let row = 0; row < settled; row += 37) reads.push(jumped.row(row))
        expect(reads.filter(row => row === ''), `${node.kind} at ${String(width)}`).toEqual([])
        // A sequential read paints each segment before the next is asked for, so it never meets a moved row.
        const walked = documentRowsSource(node as never, width, makeEnv().env)!
        const ordered = Array.from({ length: Math.min(settled, 600) }, (_, row) => walked.row(row))
        expect(ordered.filter(row => row === '')).toEqual([])
      }
    }
  })

  it('serves a repainted segment from the shared cache instead of painting again', () => {
    const text = 'abcdefghij '.repeat(200).trim()
    const node: WindowedContentNode = { kind: 'text', content: text }
    const { rows, env } = source(node, 20)
    prepareRows(rows, 0, 5)
    const painted = env.counters.segmentsPainted
    expect(painted).toBeGreaterThan(0)
    expect(plainText(rows[0]!)).not.toBe('')
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
    expect(plainText(rows[10]!)).toBe('…40')
    const full = unclampedRows(rows)
    expect(full.length).toBe(50)
    expect(plainText(full[49]!)).toBe('row 49')
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
    const materialized = [...rows].map(plainText)
    // The segment holding 'explodes' collapses to one error row; the facade follows the shrunken row map, so the next
    // segment's first line follows the error row and the walk ends on the document's last line, not on blanks.
    expect(materialized[0]).toBe('<error>paint blew up</error>')
    expect(materialized[1]).toBe(`line ${String(CONTENT_SEGMENT_LINES)} ${'x'.repeat(30)}`)
    expect(materialized.at(-1)).toBe(`line ${String(CONTENT_SEGMENT_LINES * 4 - 1)} ${'x'.repeat(30)}`)
    expect(materialized).toHaveLength(1 + CONTENT_SEGMENT_LINES * 3)
    expect(rows.length).toBe(materialized.length)
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
    const painted = [...rows].map(plainText)
    expect(painted.join('')).toBe(long)
    expect(painted.every(row => row.length > 0)).toBe(true)
    expect(painted.length - Math.ceil(40_000 / 100)).toBeLessThanOrEqual(Math.ceil(40_000 / 16_384))
  })

  it('numbers only the first wrapped row of a code line and paints the language header', () => {
    const { rows } = source({ kind: 'code', code: `${'a'.repeat(90)}\nshort`, language: 'ts', numbered: true }, 60)
    const materialized = [...rows].map(plainText)
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
    const materialized = [...rows].map(plainText)
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
    const materialized = [...rows].map(plainText)
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
    expect(plainText(rows[0]!)).toContain('line 000000')
    expect(plainText(rows[12_345]!)).toContain('line 012345')
    expect(plainText(rows[rows.length - 1]!)).toContain('line 026999')
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
    expect(plainText(rows[at]!)).toContain(`old ${String(at)}`)
    expect(env.counters.segmentsPainted).toBe(1)
    // The whole materialized facade is row-for-row the eager painter's output.
    const eager = paintDiffRows(alignDiffLines(before, after), 40, components, DARK_COLORS)
    for (const [index, row] of [...rows].entries()) expect(row).toBe(eager[index])
  })

  it('paints a small diff eagerly and aligns a node once across widths', () => {
    const node: WindowedContentNode = { kind: 'diff', before: 'a\nb\nc', after: 'a\nx\nc' }
    const { rows, env } = source(node, 40)
    expect(env.counters.segmentsPainted).toBeGreaterThan(0)
    expect([...rows].map(row => plainText(row).trimEnd())).toEqual(['    1   1 │   a', '    2     │ − b', '        2 │ + x', '    3   3 │   c'])
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
    expect(plainText(rows[10]!)).toBe('…50')
    const full = unclampedRows(rows)
    expect(full.length).toBe(60)
    expect(plainText(full[59]!).trimEnd()).toBe('       30 │ + w29')
  })

  it('maps document offsets to rows through segmented and lifted sources', () => {
    // The segmented map answers rowOf/offsetOf per segment; the lifted code source shifts body offsets past its
    // language label row, which maps every offset inside the label text to row 0.
    const lines = Array.from({ length: CONTENT_SEGMENT_LINES * 2 + 10 }, (_, index) => `L${String(index)}`)
    const text = lines.join('\n')
    const { rows } = source({ kind: 'text', content: text }, 40)
    const seg = rowSourceOf(rows)!
    const offset = text.indexOf('L90\n')
    const row = seg.rowOf!(offset)
    expect(plainText(rows[row]!)).toContain('L90')
    expect(seg.offsetOf!(row)).toBeLessThanOrEqual(offset)
    expect(seg.offsetOf!(0)).toBe(0)
    const lifted = rowSourceOf(source({ kind: 'code', language: 'ts', code: 'a\nb' }, 10).rows)!
    expect(lifted.rowOf!(0)).toBe(0)
    expect(lifted.rowOf!(2)).toBe(0)
    expect(lifted.rowOf!(3)).toBe(1)
    expect(lifted.offsetOf!(0)).toBe(0)
    expect(lifted.offsetOf!(1)).toBe(3)
    expect(lifted.offsetOf!(2)).toBe(5)
  })

  it('answers out-of-range reads with empty rows across the lazy sources', () => {
    const { rows } = source({ kind: 'text', content: 'a\nb' }, 10)
    const text = rowSourceOf(rows)!
    expect(text.row(-1)).toBe('')
    expect(text.row(99)).toBe('')
    const diff = rowSourceOf(source({ kind: 'diff', before: 'a\nb', after: 'a\nx' }, 40).rows)!
    expect(diff.row(-1)).toBe('')
    expect(diff.row(diff.length + 5)).toBe('')
    const markdown = rowSourceOf(source({ kind: 'markdown', source: '# h\n\npara' }, 40).rows)!
    expect(markdown.row(-1)).toBe('')
    expect(markdown.row(markdown.length + 5)).toBe('')
    // A prepare window past the end returns instead of walking off the index.
    expect(() => diff.prepare!(99, 120)).not.toThrow()
    expect(() => markdown.prepare!(99, 120)).not.toThrow()
  })

  it('char-wraps a cut line keeping every column through escapes and wide edges', () => {
    // Painted input carries the palette's escapes into the character wrap: every SGR channel opens and closes,
    // a non-SGR escape and a lone trailing escape ride through, and wide glyphs pack rows to the width.
    const open = (code: string, close: string) => (text: string): string => `${code}${text}${close}`
    const env = makeEnv(undefined, {
      ...DARK_COLORS,
      muted: open('\x1b[4m', '\x1b[24m'),
      primary: open('\x1b[5m', '\x1b[25m'),
      accent: open('\x1b[7m', '\x1b[27m'),
      roleUser: open('\x1b[8m', '\x1b[28m'),
      success: open('\x1b[31m', '\x1b[39m'),
      warning: open('\x1b[91m\x1b[51m', '\x1b[54m\x1b[39m'),
      error: open('\x1b[41m\x1b[101m\x1b[53m', '\x1b[55m\x1b[49m'),
      text: open('\x1b[0m\x1b[10m', '\x1b[2K\x1b'),
    })
    const tones = ['muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger'] as const
    const spans = [
      ...tones.map(tone => ({ text: `${'p'.repeat(2_000)}${tone}`, tone })),
      { text: 'x'.repeat(2_000), styles: ['strong', 'italic', 'strike'] as const },
      { text: `${'中'.repeat(3_000)}${'é'.repeat(1_000)}👨‍👩‍👧${'y'.repeat(200)}` },
    ]
    const rows = contentNodeRows({ kind: 'rich-text', spans }, 40, env.env)
    const materialized = [...rows]
    for (const row of materialized) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
    const joined = materialized.map(plainText).join('')
    for (const probe of [...tones, '中'.repeat(60), 'é'.repeat(60), '👨‍👩‍👧', 'x'.repeat(100), 'y'.repeat(100)]) expect(joined).toContain(probe)
  })

  it('carries every SGR channel, unmatched escapes, and a lone trailing escape through the wrap', () => {
    // sgrChannel keys one channel per code family: every listed code opens or closes its channel, an escape the
    // SGR grammar does not know passes through unattributed, and a dangling escape is its own atom.
    const codes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 22, 23, 24, 25, 27, 28, 29,
      30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
      50, 51, 52, 53, 54, 55, 90, 91, 92, 93, 94, 95, 96, 97, 100, 101, 102, 103, 104, 105, 106, 107]
    const run = `${codes.map(code => `\x1b[${String(code)}m`).join('')}text\x1b[Kmore\x1b`
    const rows = charWrap(run, 10, components)
    expect(rows.map(plainText).join('')).toBe('textmore\x1b')
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(10)
    // Reopened attributes keep later rows self-contained: an open channel re-emits at each row start.
    const carried = charWrap(`\x1b[31m${'a'.repeat(25)}\x1b[39mdone`, 10, components)
    expect(carried).toHaveLength(3)
    expect(carried[1]!.startsWith('\x1b[31m')).toBe(true)
    expect(carried[2]!).toContain('\x1b[39mdone')
    // Zero-width and over-wide graphemes land without pushing empty rows past the first.
    expect(charWrap('\u200b\u200d', 5, components)).toEqual(['\u200b\u200d'])
    expect(charWrap('中中', 1, components)).toEqual(['中', '中'])
    // A tail that packs only zero-width graphemes after a forced cut leaves no trailing row behind.
    expect(charWrap('中\u200b', 1, components)).toEqual(['中'])
    expect(charWrap('', 5, components)).toEqual([''])
  })

  it('char-wraps zero-width-only content and a grapheme wider than the wrap', () => {
    const { rows } = source({ kind: 'text', content: `${'x'.repeat(20_000)}${'\u200b'.repeat(500)}` }, 40)
    expect(plainText(rows[rows.length - 1]!)).toContain('\u200b')
    const wide = source({ kind: 'text', content: `${'中'.repeat(17_000)}` }, 1)
    for (const row of [...wide.rows].slice(0, 5)) expect(row.length).toBeGreaterThan(0)
  })

  it('char-wraps oversized values in fields, rich-text, and lifted code', () => {
    const fields = source({ kind: 'fields', rows: [{ label: 'v', value: [{ text: 'x'.repeat(20_000) }] }] }, 40)
    expect([...fields.rows].map(plainText).join('')).toContain('x'.repeat(100))
    const rich = source({ kind: 'rich-text', spans: [{ text: 'y'.repeat(20_000), tone: 'accent' }] }, 40)
    expect([...rich.rows].map(plainText).join('')).toBe('y'.repeat(20_000))
    // A cut crossing a numbered code line: the first cut of a line carries the number, later cuts stay blank.
    const code = source({ kind: 'code', code: `head\n${'z'.repeat(20_000)}\ntail`, language: 'py', numbered: true }, 40)
    const painted = [...code.rows].map(plainText)
    expect(painted[0]).toBe('py')
    expect(painted[1]).toMatch(/^ *1 │ head$/u)
    expect(painted[2]).toMatch(/^ *2 │ z+$/u)
    expect(painted.some(row => /^ {4}z+$/u.test(row))).toBe(true)
    expect(painted.at(-1)).toMatch(/^ *3 │ tail$/u)
  })

  it('paints middle-truncated text and rejects malformed rich-text spans', () => {
    const { rows } = source({ kind: 'text', content: `${'a'.repeat(100)} middle ${'b'.repeat(100)}`, overflow: 'middle' }, 30)
    expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(30)
    expect(plainText(rows[0]!)).toContain('…')
    expect(() => contentNodeSource({ kind: 'rich-text', spans: 'x' } as never, 20, makeEnv().env)).toThrow('rich-text spans')
    expect(() => contentNodeSource({ kind: 'rich-text', spans: [42] } as never, 20, makeEnv().env)).toThrow('rich-text span')
    expect(() => contentNodeSource({ kind: 'sections', sections: 'x' } as never, 20, makeEnv().env)).toThrow('sections must be')
    expect(() => contentNodeSource({ kind: 'code', code: 'x', language: 4 } as never, 20, makeEnv().env)).toThrow('code language')
    expect(() => contentNodeSource(null as never, 20, makeEnv().env)).toThrow('view must be')
    expect(() => contentNodeSource({ kind: 'unknown' } as never, 20, makeEnv().env)).toThrow('unknown basic content kind')
  })

  it('keeps a real row array behind a sections node that paints only static rows', () => {
    // Every part a plain array: the concat flattens to a real array and `sourceOf` wraps it in rowsSource.
    const { rows } = source({ kind: 'sections', sections: [
      { title: 'one', collapsed: true, body: { kind: 'text', content: 'hidden' } },
      { title: 'two', collapsed: true, body: { kind: 'text', content: 'hidden' } },
      { collapsed: true, body: { kind: 'text', content: 'hidden' } },
    ] }, 40)
    const materialized = [...rows].map(plainText)
    expect(materialized).toContain('one')
    expect(materialized).toContain('two')
    expect(materialized.at(-1)).toBe('...')
  })

  it('indents a titled section body and leaves an untitled one at the margin', () => {
    const { rows } = source({ kind: 'sections', sections: [
      { title: 'head', body: { kind: 'text', content: 'inner' } },
      { body: { kind: 'text', content: 'plain' } },
    ] }, 40)
    const materialized = [...rows].map(plainText)
    expect(materialized[0]).toBe('head')
    expect(materialized[1]).toBe('  inner')
    expect(materialized[2]).toBe('plain')
  })

  it('converges the diff row map when a failed paint returns fewer rows than the model', () => {
    // A failed chunk paints one error row where the hunk model counted many: the tree folds the count back so
    // the source's live length stays true.
    const env: ContentRowsEnv = {
      components,
      colors: { ...DARK_COLORS, diffAdded: () => { throw new Error('no') } },
      counters: createWorkCounters(),
      cache: new MayflyContentCache(),
      bounded: false,
      viewportRows: () => 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
    }
    const before = Array.from({ length: 10 }, (_, index) => `o${String(index)}`).join('\n')
    const after = Array.from({ length: 10 }, (_, index) => `n${String(index)}`).join('\n')
    const rows = contentNodeRows({ kind: 'diff', before, after }, 40, env)
    expect(plainText(rows[0]!)).toBe('<error>no</error>')
    expect(rows.length).toBe(1)
  })

  it('reports a paint failure once, then repaints it after the entry evicts', () => {
    // An hr-expanding palette throws inside every block paint; the error rows land in the cache like any other
    // fragment, so a forced eviction repaints through the deduplicated failure path.
    const counters = createWorkCounters()
    const cache = new MayflyContentCache(1)
    const reports: string[] = []
    const env: ContentRowsEnv = {
      components,
      colors: { ...DARK_COLORS, mdHr: () => { throw new Error('hr blew') } },
      counters,
      cache,
      bounded: false,
      viewportRows: () => 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
      report: message => { reports.push(message) },
    }
    const node: WindowedContentNode = { kind: 'markdown', source: '# head\n\nbody' }
    const rows = contentNodeRows(node, 100, env)
    expect(plainText(rows[0]!)).toBe('<error>hr blew</error>')
    expect(reports).toEqual(['hr blew'])
    for (let index = 0; index < 140; index += 1) cache.put(`pad${String(index)}`, ['x'.repeat(200)], 500)
    // The first facade holds its produced row; a fresh facade over the memoized source repaints the evicted
    // fragment and the deduplicated failure stays silent.
    const again = contentNodeRows(node, 100, env)
    expect(plainText(again[0]!)).toBe('<error>hr blew</error>')
    expect(reports).toEqual(['hr blew'])
  })

  it('paints the fallback message for a failure without an own message', () => {
    const counters = createWorkCounters()
    const env: ContentRowsEnv = {
      components,
      colors: { ...DARK_COLORS, diffAdded: () => { throw new Error('') } },
      counters,
      cache: new MayflyContentCache(),
      bounded: false,
      viewportRows: () => 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
    }
    const rows = contentNodeRows({ kind: 'diff', before: 'a', after: 'b'.repeat(100) }, 40, env)
    expect(plainText(rows[rows.length - 1]!)).toBe('<error>unknown render failure</error>')
  })

  it('measures and clips a static row that still exceeds the leaf', () => {
    // A real-array source declares no width, so the clamp measures every row: a static title wider than the leaf
    // is truncated to fit while shorter rows pass through unchanged.
    const { rows } = source({ kind: 'sections', sections: [
      { title: `wide ${'t'.repeat(100)}`, collapsed: true, body: { kind: 'text', content: 'hidden' } },
      { title: 'narrow', collapsed: true, body: { kind: 'text', content: 'hidden' } },
    ] }, 20)
    const materialized = [...rows]
    expect(visibleWidth(materialized[0]!)).toBeLessThanOrEqual(20)
    expect(plainText(materialized[2]!)).toBe('narrow')
  })

  it('paints markdown units of every kind and maps offsets through them', () => {
    // One document with a block, a valid mermaid fence, an oversized code token (its 17K line cuts inside the
    // segmented child while its fence lines stay ordinary segments), and an oversized mermaid fallback: every
    // unit kind paints, and rowOf/offsetOf translate source offsets through the unit map.
    const code = `\`\`\`text\n${'u'.repeat(17_000)}\n\`\`\``
    const mermaid = `\`\`\`mermaid\n${'q'.repeat(5_000)}\n\`\`\``
    const document = `# Title\n\nsome paragraph text\n\n${code}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n${mermaid}\n`
    const { rows } = source({ kind: 'markdown', source: document }, 60)
    const markdown = rowSourceOf(rows)!
    const materialized = [...rows].map(plainText)
    expect(materialized.some(row => row.includes('Title'))).toBe(true)
    expect(materialized.some(row => row.includes('u'.repeat(60)))).toBe(true)
    expect(materialized.some(row => row.includes('q'.repeat(60)))).toBe(true)
    // rowOf lands inside the right units; offsets past a unit clamp to its end row.
    expect(markdown.rowOf!(0)).toBe(0)
    expect(markdown.offsetOf!(0)).toBe(0)
    const tokenOffset = document.indexOf(code)
    const tokenRow = markdown.rowOf!(tokenOffset)
    expect(markdown.rowOf!(document.length)).toBeLessThanOrEqual(rows.length)
    const back = markdown.offsetOf!(tokenRow)
    expect(back).toBeLessThanOrEqual(tokenOffset)
    // The oversized token's segmented child answers its own fine-grained map once painted.
    expect(markdown.rowOf!(tokenOffset + 4_000)).toBeGreaterThan(tokenRow)
    expect(markdown.offsetOf!(tokenRow + 2)).toBeGreaterThan(back)
  })

  it('reports a markdown paint failure once per unit', () => {
    const counters = createWorkCounters()
    const reports: string[] = []
    const env: ContentRowsEnv = {
      components,
      colors: { ...DARK_COLORS, mdHr: () => { throw new Error('') } },
      counters,
      cache: new MayflyContentCache(),
      bounded: false,
      viewportRows: () => 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
      report: message => { reports.push(message) },
    }
    const prose = Array.from({ length: 6 }, () => `${'w '.repeat(450)}`).join('\n\n')
    const node: WindowedContentNode = { kind: 'markdown', source: `# head\n\n${prose}\n\nbody` }
    const rows = contentNodeRows(node, 100, env)
    // A read located under the estimate falls through the failed unit's one error row and answers ''.
    expect(rows[40]!).toBe('')
    expect(plainText(rows[0]!)).toBe('<error>unknown render failure</error>')
    expect(reports.length).toBeGreaterThan(0)
    // A prepare over the same failed unit does not re-report.
    rowSourceOf(rows)!.prepare!(0, rows.length)
    const painted = reports.length
    prepareRows(rows, 0, rows.length)
    expect(reports.length).toBe(painted)
  })

  it('prepares a markdown window including the segmented children of oversized units', () => {
    const token = 'u'.repeat(5_000)
    const { rows } = source({ kind: 'markdown', source: `# t\n\n${token}\n\ntail` }, 40)
    prepareRows(rows, 0, rows.length)
    const materialized = [...rows].map(plainText)
    expect(materialized.at(-1)).toContain('tail')
  })

  it('keeps an empty markdown document at zero rows', () => {
    const { rows } = source({ kind: 'markdown', source: '' }, 40)
    expect(rows.length).toBe(0)
  })

  it('seeks markers inside a composed leaf only within the elision bound', () => {
    // The bounded leaf delegates seekMarker to the concat over [title, body]: a hit inside the bound returns,
    // a miss answers -1, and a zero bound clamps even a row-0 hit out.
    const node: WindowedContentNode = { kind: 'sections', sections: [{ title: 'ts', body: { kind: 'text', content: 'a\nb' } }] }
    const within = rowSourceOf(source(node, 10, 5).rows)!
    expect(within.seekMarker!('ts', 0)).toBe(0)
    expect(within.seekMarker!('nomarker', 0)).toBe(-1)
    const zero = rowSourceOf(source(node, 10, 0).rows)!
    expect(zero.length).toBe(1)
    expect(plainText(zero.row(0))).toBe('…3')
    expect(zero.seekMarker!('ts', 0)).toBe(-1)
  })

  it('declares a code block with a language marker-free and as wide as its widest row', () => {
    const { rows } = source({ kind: 'code', language: 'typescript', code: 'ab\ncd' }, 80)
    expect(declaredWidthOf(rows)).toBe('typescript'.length)
    expect(findMarkerRow(rows, 'typescript')).toBe(-1)
    expect([...rows].map(plainText)).toEqual(['typescript', 'ab', 'cd'])
  })

  it('answers the rows an estimate correction moved, not the rows it read before', () => {
    // Each line is 20 columns of words: estimated two rows at width 10, painted three once word wrap applies.
    const lines = Array.from({ length: CONTENT_SEGMENT_LINES * 4 }, (_, index) => `${String(index).padStart(6, '0')} bbbbbb cccccc`)
    const env = makeEnv()
    const node: WindowedContentNode = { kind: 'text', content: lines.join('\n') }
    const rows = contentNodeRows(node, 10, env.env)
    void rows[400]
    // Painting the first segment grows it past its estimate, which moves every row after it.
    void rows[0]
    const fresh = contentNodeRows(node, 10, env.env)
    expect(rows[400]).toBe(fresh[400])
    expect(rows.length).toBe(fresh.length)
  })

  it('paints a shared node again under a new palette instead of answering the old rows', () => {
    const node: WindowedContentNode = { kind: 'text', content: 'hello', tone: 'primary' }
    const cache = new MayflyContentCache()
    const dark = contentNodeRows(node, 20, { ...makeEnv().env, cache })[0]
    const light = contentNodeRows(node, 20, { ...makeEnv(undefined, LIGHT_COLORS).env, cache })[0]
    expect(dark).toBe(DARK_COLORS.primary('hello'))
    expect(light).toBe(LIGHT_COLORS.primary('hello'))
  })

  it('clamps a bounded prepare to the elision bound and delegates the unclamped chain', () => {
    const { rows } = source({ kind: 'text', content: Array.from({ length: 100 }, (_, index) => `r${String(index)}`).join('\n') }, 40, 10)
    const bounded = rowSourceOf(rows)!
    expect(rows.length).toBe(11)
    expect(() => bounded.prepare!(0, 9_999)).not.toThrow()
    // The unclamped chain answers the full document; the outer leaf's own unclamped resolves through it.
    const full = rowSourceOf(unclampedRows(rows))!
    expect(full.length).toBe(100)
    const unbounded = rowSourceOf(source({ kind: 'text', content: 'a\nb' }, 40).rows)!
    expect(unbounded.unclamped).toBeUndefined()
  })

  it('bounds the shared per-node sources to four widths', () => {
    const node: WindowedContentNode = { kind: 'text', content: 'a\nb' }
    const env = makeEnv()
    const first = contentNodeRows(node, 10, env.env)
    for (const width of [20, 30, 40, 50]) contentNodeRows(node, width, env.env)
    // The width-10 source evicted out of the width map still paints correctly on its own rows.
    expect(plainText(first[0]!)).toBe('a')
    expect(plainText(first[1]!)).toBe('b')
  })

  it('rejects malformed fields rows and sections inside nested bodies', () => {
    expect(() => contentNodeSource({ kind: 'fields', rows: [null] } as never, 20, makeEnv().env)).toThrow('field row')
    expect(() => contentNodeSource({ kind: 'fields', rows: [{ label: 'a', value: 'x' }] } as never, 20, makeEnv().env)).toThrow('field row')
    expect(() => contentNodeSource({ kind: 'fields', rows: [{ label: 'a', value: [null] }] } as never, 20, makeEnv().env)).toThrow('field span')
    expect(() => contentNodeSource({ kind: 'fields', rows: [{ label: 4, value: [{ text: 'x' }] }] } as never, 20, makeEnv().env)).toThrow('field label')
    expect(() => contentNodeSource({ kind: 'fields', rows: [{ label: 'a', value: [{ text: 9 }] }] } as never, 20, makeEnv().env)).toThrow('field span text')
    expect(() => contentNodeSource({ kind: 'fields', rows: 'x' } as never, 20, makeEnv().env)).toThrow('fields rows')
  })

  it('walks into nested sections bodies at bounded depth', () => {
    const nested: WindowedContentNode = { kind: 'sections', sections: [
      { title: 'outer', body: { kind: 'sections', sections: [
        { title: 'inner', body: { kind: 'text', content: 'deep' } },
      ] } },
    ] }
    const materialized = [...source(nested, 40).rows].map(plainText)
    expect(materialized).toContain('  inner')
    expect(materialized.some(row => row.endsWith('deep'))).toBe(true)
  })

  it('rejects a sections tree nested past the view depth cap', () => {
    let body: WindowedContentNode = { kind: 'text', content: 'deep' }
    for (let index = 0; index < 9; index += 1) body = { kind: 'sections', sections: [{ body }] }
    expect(() => contentNodeSource({ kind: 'sections', sections: [{ body }] } as never, 40, makeEnv().env)).toThrow('view nesting')
  })

  it('honors the diff layout options and emits non-row segments between hunks', () => {
    // `start`, `context`, `maxRows`, and the `hunkHeader` switch feed the model; two distant changes leave a gap
    // segment between hunks so the chunked source sees a segment that is not a rows run.
    const before = Array.from({ length: 100 }, (_, index) => `b${String(index)}`).join('\n')
    const after = Array.from({ length: 100 }, (_, index) => index === 5 ? 'new5' : index === 99 ? 'new99' : `b${String(index)}`).join('\n')
    const node: WindowedContentNode = { kind: 'diff', before, after, start: 40, hunkHeader: true, context: 1, maxRows: 6 }
    const { rows } = source(node, 40)
    const materialized = [...rows].map(plainText)
    expect(materialized.some(row => row.includes('@@'))).toBe(true)
    expect(materialized.some(row => row.includes('⋯'))).toBe(true)
    expect(materialized.at(-1)!.trimEnd()).toContain('… +')
    expect(materialized.join('')).toContain('new5')
  })

  it('truncates a text leaf and answers inside an estimate window that painted narrower', () => {
    const { rows } = source({ kind: 'text', content: `${'a'.repeat(40)} tail`, overflow: 'truncate' }, 20)
    expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(20)
    // A segment whose painter fails returns one error row where the estimate promised many: a read located under
    // the estimate falls through the painted rows and answers ''.
    const reports: string[] = []
    const cache = new MayflyContentCache(1)
    const env: ContentRowsEnv = {
      components: { ...components, wrapText: () => { throw new Error('') } },
      colors: DARK_COLORS,
      counters: createWorkCounters(),
      cache,
      bounded: false,
      viewportRows: () => 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
      report: message => { reports.push(message) },
    }
    const node: WindowedContentNode = { kind: 'text', content: 'x'.repeat(5_000) }
    const failed = contentNodeRows(node, 40, env)
    expect(failed[60]!).toBe('')
    expect(plainText(failed[0]!)).toBe('<error>unknown render failure</error>')
    const reported = reports.length
    expect(reported).toBeGreaterThan(0)
    // A prepare window past the end returns instead of walking off the segment map.
    expect(() => rowSourceOf(failed)!.prepare!(99_999, 100_000)).not.toThrow()
    // After the error fragment evicts, a fresh facade repaints it through the deduplicated failure path.
    for (let index = 0; index < 140; index += 1) cache.put(`pad${String(index)}`, ['x'.repeat(200)], 500)
    const again = contentNodeRows(node, 40, env)
    expect(plainText(again[0]!)).toBe('<error>unknown render failure</error>')
    expect(reports.length).toBe(reported)
  })

  it('reuses a prepared markdown scan and a prepared fields shape across widths', () => {
    const env = makeEnv()
    const markdown: WindowedContentNode = { kind: 'markdown', source: '# h\n\nbody' }
    const fields: WindowedContentNode = { kind: 'fields', rows: [{ label: '', value: [{ text: 'v' }] }] }
    contentNodeRows(markdown, 40, env.env)
    contentNodeRows(markdown, 60, env.env)
    contentNodeRows(fields, 40, env.env)
    const second = contentNodeRows(fields, 60, env.env)
    // The empty label keeps an empty column name, and the second width reuses the prepared shape.
    expect(plainText(second[0]!)).toBe('  v')
  })

  it('bounds a sections leaf without offset maps and reads inside its bound', () => {
    const { rows } = source({ kind: 'sections', sections: [
      { title: 'one', collapsed: true, body: { kind: 'text', content: 'hidden' } },
      { title: 'two', collapsed: true, body: { kind: 'text', content: 'hidden' } },
      { title: 'three', collapsed: true, body: { kind: 'text', content: 'hidden' } },
    ] }, 40, 3)
    const bounded = rowSourceOf(rows)!
    expect(rows.length).toBe(4)
    expect(plainText(rows[0]!)).toBe('one')
    expect(plainText(rows[3]!)).toBe('…3')
    // A real-array source carries no offset map or marker seek — the elision spreads stay empty.
    expect(bounded.rowOf).toBeUndefined()
    expect(bounded.offsetOf).toBeUndefined()
  })

  it('answers a shared source for content kinds and nothing else', () => {
    const env = makeEnv()
    expect(documentRowsSource({ kind: 'text', content: 'a' }, 40, env.env)).toBeDefined()
    expect(documentRowsSource({ kind: 'stack' } as never, 40, env.env)).toBeUndefined()
    expect(documentRowsSource(null as never, 40, env.env)).toBeUndefined()
    expect(documentRowsSource('text' as never, 40, env.env)).toBeUndefined()
    expect(documentRowsSource(undefined as never, 40, env.env)).toBeUndefined()
  })

  it('reports a diff paint failure once per chunk, then repaints it after the entry evicts', () => {
    const counters = createWorkCounters()
    const cache = new MayflyContentCache(1)
    const reports: string[] = []
    const env: ContentRowsEnv = {
      components,
      colors: {
        ...DARK_COLORS,
        diffAdded: () => { throw new Error('no') },
        diffRemoved: () => { throw new Error('no') },
      },
      counters,
      cache,
      bounded: false,
      viewportRows: () => 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
      report: message => { reports.push(message) },
    }
    const before = Array.from({ length: 70 }, (_, index) => `o${String(index)}`).join('\n')
    const after = Array.from({ length: 70 }, (_, index) => `n${String(index)}`).join('\n')
    const node: WindowedContentNode = { kind: 'diff', before, after }
    const rows = contentNodeRows(node, 40, env)
    // Row 10 lies past the one error row of the first chunk, so the read settles the map through each chunk it passes
    // (each reports its own failure once) and finds no row left to answer.
    expect(rows[10]!).toBe('')
    expect(plainText(rows[0]!)).toBe('<error>no</error>')
    expect(reports).toEqual(['no', 'no', 'no'])
    for (let index = 0; index < 140; index += 1) cache.put(`pad${String(index)}`, ['x'.repeat(200)], 500)
    // A fresh facade over the memoized source repaints the evicted chunk; the failure stays deduplicated.
    const again = contentNodeRows(node, 40, env)
    expect(plainText(again[0]!)).toBe('<error>no</error>')
    expect(reports).toEqual(['no', 'no', 'no'])
  })
})

