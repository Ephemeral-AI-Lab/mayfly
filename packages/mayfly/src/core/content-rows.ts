/**
 * Windowed painters for the content leaf kinds (`text`, `fields`, `code`, `sections`, `rich-text` without motion,
 * `diff`). Instead of rendering every row, a leaf indexes its text once per node (`content-segments.ts`), answers
 * its height from per-segment row estimates at the asked width, and paints a segment only when a row inside it is
 * read — a scroll `prepare`d its window or the layout indexed the row. Painted segments live in the renderer's
 * content cache (`ui-content-cache.ts`), keyed by node, segment, and width, so a repaint is free and the estimate
 * under a painted window is always the truth. A `diff` aligns once per node into a hunk model
 * (`diff-align.ts`) whose kept lines paint in chunks the same way.
 *
 * A leaf the viewport cannot fully show reports at most the viewport's rows plus a `… N more rows` elision row
 * (`elidedSource`): that keeps every bounded-height consumer — pi-tui's clipped-leaf marker scan, a horizontal
 * stack's intrinsic-width measure — reading a bounded prefix. A scroll unwraps the bound through the source's
 * `unclamped` chain (`ui-rows.ts`), so inside a window the leaf reports its natural length. In the main screen every
 * leaf reports its natural length: the transcript prints all of it.
 *
 * @module @ephemeral-ai/mayfly/core/content-rows
 */

import type { MayflyContentField, MayflyContentNode, MayflyField, MayflyMarkdownNode, MayflyRichTextNode, MayflySection, MayflySectionContentNode, MayflyTextStyle, MayflyTone, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MarkdownTheme } from '@earendil-works/pi-tui'
import { fieldText } from './field-text.ts'
import { commonPrefix } from './text-match.ts'
import { CONTENT_SEGMENT_LINES, CONTENT_SEGMENT_UNITS, extendMergedLines, indexContent, indexMergedLines, scanContentLines, type ContentIndex, type ContentLineScan } from './content-segments.ts'
import { alignDiffLines, diffModel, paintDiffSegment, type DiffModel, type DiffSegment } from './diff-align.ts'
import { ownDataErrorMessage } from './error-message.ts'
import { highlightable, highlightCodeLines } from './highlight.ts'
import { markdownBlockRows, markdownMermaidRows, markdownTheme, scanMarkdown, type MarkdownUnit, type PreparedMarkdown } from './markdown-rows.ts'
import {
  CODE_HIGHLIGHT_MAX_BYTES,
  CODE_HIGHLIGHT_MAX_ROWS,
  PLUGIN_VIEW_MAX_DEPTH,
  paintPluginTone,
  requireText,
  sanitizePluginText,
  strong,
  styledText,
  truncatedRow,
} from './plugin-view.ts'
import { terminalSequenceAt } from './escape-sequences.ts'
import { concatSources, mapSource, rowsSource, type RowSource } from './ui-rows.ts'
import { paintedRowsBytes, type MayflyContentCache } from './ui-content-cache.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'
import { truncateMiddle } from './width.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'

/** The leaf kinds this module paints; `MayflySectionContentNode` covers `sections` bodies. */
export type WindowedContentNode = MayflySectionContentNode | Extract<MayflyContentNode, { readonly kind: 'rich-text' | 'markdown' }>

/** What a content leaf needs beyond its node: width helpers, palette, the content cache, and the frame contract. */
export interface ContentRowsEnv {
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly counters?: MayflyWorkCounters | undefined
  readonly cache: MayflyContentCache
  /** Whether the outside-window elision applies (the alternate screen); the main screen prints every row. */
  readonly bounded: boolean
  /** Rows the viewport gives a leaf outside any window, read when the leaf is built; it clamps to this plus its elision row. */
  readonly viewportRows: () => number
  /** The row shown for `hidden` rows the outside-window clamp removed. */
  readonly elide: (hidden: number) => string
  /** Contained error rows for a segment whose paint threw, one failure per segment. */
  readonly errorRows: (message: string, width: number) => string[]
  /** Report a contained paint failure to the host, once per segment. */
  readonly report?: ((message: string) => void) | undefined
}

/** Prefix sums over per-segment row counts; an estimate becomes the painted count wherever a segment is painted. */
class Fenwick {
  private readonly tree: Float64Array
  constructor(private readonly size: number) {
    this.tree = new Float64Array(size + 1)
  }

  add(index: number, delta: number): void {
    for (let at = index + 1; at <= this.size; at += at & -at) this.tree[at]! += delta
  }

  /** Rows in segments `[0, index]`; a negative index sums nothing. */
  sum(index: number): number {
    let total = 0
    for (let at = index + 1; at > 0; at -= at & -at) total += this.tree[at]!
    return total
  }

  /** The segment containing row `row`: the smallest index whose prefix sum exceeds it. */
  locate(row: number): number {
    let bit = 1
    while (bit * 2 <= this.size) bit <<= 1
    let segment = 0
    let covered = 0
    for (; bit > 0; bit >>= 1) {
      const next = segment + bit
      if (next <= this.size && covered + this.tree[next]! <= row) {
        segment = next
        covered += this.tree[next]!
      }
    }
    return Math.min(segment, this.size - 1)
  }
}

/**
 * The row source of one segmented text at one width: `length` is the current row map (estimates replaced by painted
 * counts as segments paint), `row` paints the segment under the row on first touch, and `prepare` paints the segments
 * under a window so the map is exact where the frame looks. Painted rows are marker-free: sanitizing stripped every
 * sequence the cursor marker could hide in.
 */
class SegmentedContent implements RowSource {
  readonly declaredWidth: number
  readonly markerFree = true
  private changes = 0
  /** Whether segments paint on demand; a document painted whole at construction is fixed and has no revision. */
  private readonly lazy: boolean
  private readonly counts: number[]
  private readonly tree: Fenwick
  private readonly failures = new Set<number>()

  constructor(
    private readonly index: ContentIndex,
    /** The text the index measured: anchors map their source positions through it. */
    private readonly text: () => string,
    /** The width rows wrap and estimate at: the leaf width minus whatever fixed chrome the painter adds. */
    private readonly wrapWidth: number,
    private readonly paint: (segment: number, width: number) => readonly string[],
    private readonly env: ContentRowsEnv,
    private readonly key: string,
    /** Columns the painter adds beside the wrap, for the leaf's declared width. */
    extraColumns = 0,
  ) {
    this.counts = new Array<number>(index.segments)
    this.tree = new Fenwick(index.segments)
    for (let segment = 0; segment < index.segments; segment += 1) {
      const estimate = index.estimateRows(segment, wrapWidth)
      this.counts[segment] = estimate
      this.tree.add(segment, estimate)
    }
    this.declaredWidth = Math.min(wrapWidth + extraColumns, extraColumns + index.maxColumns)
    // A document that fits a segment's paint budget is painted eagerly: its row map is exact at once, so a small
    // leaf never shows a one-frame tail while an estimate converges, and a pipe over it never checks a revision.
    this.lazy = index.units > CONTENT_SEGMENT_UNITS
    if (!this.lazy) this.prepare(0, Number.MAX_SAFE_INTEGER)
  }

  get length(): number {
    return this.tree.sum(this.index.segments - 1)
  }

  /** Grows each time a painted count replaces a segment's estimate, so a facade drops rows read under the old map. */
  get revision(): number | undefined {
    return this.lazy ? this.changes : undefined
  }

  private cacheKey(segment: number): string {
    return `${this.key}:${String(this.wrapWidth)}:${String(segment)}`
  }

  /** The painted rows of one segment: the cache answers repaints, otherwise the painter runs once. */
  private segmentRows(segment: number): readonly string[] {
    let rows = this.env.cache.get(this.cacheKey(segment))
    if (rows === undefined) {
      rows = this.paintSafely(segment)
      this.env.cache.put(this.cacheKey(segment), rows, paintedRowsBytes(rows))
      countWork(this.env.counters, 'segmentsPainted')
      countWork(this.env.counters, 'rowsPainted', rows.length)
    }
    if (this.counts[segment] !== rows.length) {
      this.tree.add(segment, rows.length - this.counts[segment]!)
      this.counts[segment] = rows.length
      this.changes += 1
    }
    return rows
  }

  private paintSafely(segment: number): readonly string[] {
    try {
      return this.paint(segment, this.wrapWidth)
    } catch (error) {
      const message = ownDataErrorMessage(error) ?? 'unknown render failure'
      if (!this.failures.has(segment)) {
        this.failures.add(segment)
        this.env.report?.(message)
      }
      return this.env.errorRows(message, this.wrapWidth)
    }
  }

  /**
   * The row at `index` of the current map. Painting the segment under the row can replace its estimate with a different
   * painted count, and the row then belongs to another segment, so the row is located again against the settled map.
   * Each pass settles one more segment's count, and a settled count never moves again, so the walk ends.
   */
  row(index: number): string {
    for (;;) {
      if (index < 0 || index >= this.length) return ''
      const settled = this.changes
      const segment = this.tree.locate(index)
      const rows = this.segmentRows(segment)
      if (this.changes !== settled) continue
      countWork(this.env.counters, 'rowsMaterialized')
      return rows[index - this.tree.sum(segment - 1)] ?? ''
    }
  }

  /**
   * Rows before `offset` units of the text, under the source's own row map: painted segments count their painted
   * rows before the offset's segment, and inside the segment the index estimates the share the offset's columns
   * cover — the same model `offsetOf` inverts, so an anchor round-trips to the row it was written from.
   */
  rowOf(offset: number): number {
    const segment = this.index.segmentAtOffset(offset)
    const local = Math.min(this.index.rowOfOffset(segment, offset, this.wrapWidth, this.text()), this.counts[segment]! - 1)
    return this.tree.sum(segment - 1) + Math.max(0, local)
  }

  /** The text offset `row` begins at: the segment under the row, then the estimated boundary inside it. */
  offsetOf(row: number): number {
    const segment = this.tree.locate(row)
    const local = Math.min(Math.max(0, row - this.tree.sum(segment - 1)), this.counts[segment]! - 1)
    return this.index.offsetOfRow(segment, local, this.wrapWidth, this.text())
  }

  prepare(from: number, to: number): void {
    if (from >= this.length) return
    let segment = this.tree.locate(Math.max(0, from))
    while (segment < this.index.segments && this.tree.sum(segment - 1) < to) {
      this.segmentRows(segment)
      segment += 1
    }
  }
}

/** Kept lines one paint call produces at most — the same budget a content segment has. */
const DIFF_CHUNK_ROWS = CONTENT_SEGMENT_LINES

/**
 * The diff layout of one node, shared by every width the leaf is asked: the alignment and the hunk model are
 * width-independent, so a width change repaints the same kept rows, never re-aligns.
 */
interface PreparedDiff {
  readonly model: DiffModel
  readonly numbered: boolean
}

const preparedDiffs = new WeakMap<object, PreparedDiff>()

function diffPrepared(node: Extract<MayflySectionContentNode, { readonly kind: 'diff' }>, env: ContentRowsEnv): PreparedDiff {
  let prepared = preparedDiffs.get(node)
  if (prepared === undefined) {
    const before = sanitizePluginText(requireText(node.before, 'diff before'))
    const after = sanitizePluginText(requireText(node.after, 'diff after'))
    const ops = alignDiffLines(before, after)
    countWork(env.counters, 'linesEstimated', ops.length)
    prepared = {
      numbered: node.numbered !== false,
      model: diffModel(ops, {
        ...node.start === undefined ? {} : { start: node.start },
        ...node.hunkHeader === undefined ? {} : { hunkHeader: node.hunkHeader },
        ...node.context === undefined ? {} : { context: node.context },
        ...node.maxRows === undefined ? {} : { maxRows: node.maxRows },
      }),
    }
    preparedDiffs.set(node, prepared)
  }
  return prepared
}

/**
 * The row source of one diff at one width: `length` is the model's exact row total (no estimates to converge), and
 * `row`/`prepare` paint the ≤{@link DIFF_CHUNK_ROWS}-line chunk under the asked rows through the content cache, so a
 * window over a megabyte diff costs its own rows. Painted rows are marker-free by the same sanitizing argument as
 * the segmented texts.
 */
class DiffRowsSource implements RowSource {
  readonly declaredWidth: number
  readonly markerFree = true
  private changes = 0
  /** Whether chunks paint on demand; a diff painted whole at construction is fixed and has no revision. */
  private readonly lazy: boolean
  private readonly chunks: readonly DiffSegment[]
  private readonly counts: number[]
  private readonly tree: Fenwick
  private readonly failures = new Set<number>()

  constructor(
    private readonly prepared: PreparedDiff,
    private readonly width: number,
    private readonly env: ContentRowsEnv,
    private readonly key: string,
  ) {
    const chunks: DiffSegment[] = []
    const counts: number[] = []
    for (const segment of prepared.model.segments) {
      const pieces = segment.kind === 'rows' && segment.rows.length > DIFF_CHUNK_ROWS
        ? Array.from({ length: Math.ceil(segment.rows.length / DIFF_CHUNK_ROWS) }, (_, at): DiffSegment => ({ kind: 'rows', rows: segment.rows.slice(at * DIFF_CHUNK_ROWS, (at + 1) * DIFF_CHUNK_ROWS) }))
        : [segment]
      for (const piece of pieces) {
        chunks.push(piece)
        counts.push(piece.kind === 'rows' ? piece.rows.length : 1)
      }
    }
    this.chunks = chunks
    this.counts = counts
    this.tree = new Fenwick(chunks.length)
    counts.forEach((count, chunk) => this.tree.add(chunk, count))
    // Every row is clipped to the asked columns by the painter, so the leaf width is the width truth.
    this.declaredWidth = width
    this.lazy = prepared.model.length > DIFF_CHUNK_ROWS
    if (!this.lazy) this.prepare(0, Number.MAX_SAFE_INTEGER)
  }

  /** Grows when a chunk paints a different row count than the model said (a contained failure's error rows). */
  get revision(): number | undefined {
    return this.lazy ? this.changes : undefined
  }

  get length(): number {
    return this.tree.sum(this.chunks.length - 1)
  }

  private cacheKey(chunk: number): string {
    return `${this.key}:${String(this.width)}:${String(chunk)}`
  }

  private chunkRows(chunk: number): readonly string[] {
    let rows = this.env.cache.get(this.cacheKey(chunk))
    if (rows === undefined) {
      rows = this.paintSafely(chunk)
      this.env.cache.put(this.cacheKey(chunk), rows, paintedRowsBytes(rows))
      countWork(this.env.counters, 'segmentsPainted')
      countWork(this.env.counters, 'rowsPainted', rows.length)
    }
    if (this.counts[chunk] !== rows.length) {
      this.tree.add(chunk, rows.length - this.counts[chunk]!)
      this.counts[chunk] = rows.length
      this.changes += 1
    }
    return rows
  }

  private paintSafely(chunk: number): readonly string[] {
    try {
      return paintDiffSegment(this.chunks[chunk]!, this.prepared.model.digits, this.width, this.env.components, this.env.colors, this.prepared.numbered)
    } catch (error) {
      const message = ownDataErrorMessage(error) ?? 'unknown render failure'
      if (!this.failures.has(chunk)) {
        this.failures.add(chunk)
        this.env.report?.(message)
      }
      return this.env.errorRows(message, this.width)
    }
  }

  /** The row at `index`, located again when painting its chunk moved the map (a contained failure's error rows). */
  row(index: number): string {
    for (;;) {
      if (index < 0 || index >= this.length) return ''
      const settled = this.changes
      const chunk = this.tree.locate(index)
      const rows = this.chunkRows(chunk)
      if (this.changes !== settled) continue
      countWork(this.env.counters, 'rowsMaterialized')
      return rows[index - this.tree.sum(chunk - 1)] ?? ''
    }
  }

  prepare(from: number, to: number): void {
    if (from >= this.length) return
    let chunk = this.tree.locate(Math.max(0, from))
    while (chunk < this.chunks.length && this.tree.sum(chunk - 1) < to) {
      this.chunkRows(chunk)
      chunk += 1
    }
  }
}

function diffSource(node: Extract<MayflySectionContentNode, { readonly kind: 'diff' }>, width: number, env: ContentRowsEnv): RowSource {
  return new DiffRowsSource(diffPrepared(node, env), Math.max(1, width), env, keyOf(node, env))
}

/** A 53-bit hash of `text` (cyrb53) with its length: the content part of a painted unit's cache key. */
function contentHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${String(text.length)}.${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

/**
 * The row source of one `markdown` node at one width: `length` is the unit row map (estimates replaced by painted
 * counts as units materialize), `row`/`prepare` paint the block or diagram under the asked rows through the content
 * cache, and oversized tokens delegate to a segmented child over their raw lines (`markdown-rows.ts` owns the scan
 * and the fragment paints). pi-tui pads every Markdown row to the render width, so `declaredWidth` is the width.
 */
class MarkdownRowSource implements RowSource {
  readonly declaredWidth: number
  readonly markerFree = true
  private changes = 0
  /** Whether units paint on demand; a document painted whole at construction is fixed and has no revision. */
  private readonly lazy: boolean
  private readonly counts: number[]
  private readonly tree: Fenwick
  private readonly failures = new Set<number>()
  private readonly children = new Map<number, RowSource>()
  private readonly theme: MarkdownTheme
  private readonly defsKey: string

  constructor(
    private readonly prepared: PreparedMarkdown,
    private readonly width: number,
    private readonly env: ContentRowsEnv,
    private readonly key: string,
  ) {
    this.counts = new Array<number>(prepared.units.length)
    this.tree = new Fenwick(prepared.units.length)
    prepared.units.forEach((unit, index) => {
      // The scan's per-token estimate is width-free; floor it by the unit's paintable characters at this width.
      const estimate = unit.kind === 'mermaid' ? unit.estimate : Math.max(unit.estimate, Math.ceil(unit.flow / Math.max(1, width)))
      this.counts[index] = estimate
      this.tree.add(index, estimate)
    })
    this.declaredWidth = width
    this.theme = markdownTheme(env.colors)
    this.defsKey = prepared.defs.length === 0 ? '' : contentHash(prepared.defs.map(def => def.raw).join(''))
    // A document that fits a paint budget is painted eagerly: its row map is exact at once, like the texts.
    this.lazy = prepared.normalized.length > CONTENT_SEGMENT_UNITS
    if (!this.lazy) this.prepare(0, Number.MAX_SAFE_INTEGER)
  }

  get length(): number {
    this.syncChildren()
    return this.prepared.units.length === 0 ? 0 : this.tree.sum(this.prepared.units.length - 1)
  }

  /** Grows whenever a unit's count moves, its segmented children's included; a fixed document has none. */
  get revision(): number | undefined {
    if (!this.lazy) return undefined
    this.syncChildren()
    return this.changes
  }

  /** A segmented child converges on its own schedule; fold its live length back into the unit map. */
  private syncChildren(): void {
    for (const [unit, child] of this.children) this.syncCount(unit, child.length)
  }

  private syncCount(unit: number, rows: number): void {
    if (this.counts[unit] !== rows) {
      this.tree.add(unit, rows - this.counts[unit]!)
      this.counts[unit] = rows
      this.changes += 1
    }
  }

  /**
   * A unit is cached by what it paints, not by the node it came from: a streamed answer is a new node on every append,
   * and only the unit the append reached has new text. The link definitions the paint restores are part of the key.
   */
  private cacheKey(index: number): string {
    const unit = this.prepared.units[index]!
    const text = unit.kind === 'mermaid' ? `${unit.source}\0${unit.fallback}` : this.prepared.normalized.slice(unit.start, unit.end)
    const closed = unit.kind === 'block' && unit.closed === true ? 1 : 0
    return `m${paintKey(this.env)}:${String(this.width)}:${String(closed)}:${this.defsKey}:${contentHash(text)}`
  }

  /** The segmented child painting one oversized token's raw lines, built on first demand and shared across reads. */
  private linesChild(unit: number, text: string): RowSource {
    let child = this.children.get(unit)
    if (child === undefined) {
      const index = indexContent(text, lines => countWork(this.env.counters, 'linesEstimated', lines))
      child = new SegmentedContent(index, () => text, this.width, (segment, at) => {
        const rows: string[] = []
        const paint = (start: number, end: number, cut: boolean): void => {
          const slice = sanitizePluginText(text.slice(start, end))
          for (const row of cut ? charWrap(slice, at, this.env.components) : this.env.components.wrapText(slice, at)) rows.push(row)
        }
        if (index.isCut(segment)) {
          const [start, end] = index.segmentText(segment)
          paint(start, end, true)
          return rows
        }
        const [first, past] = index.segmentLines(segment)
        for (let line = first; line < past; line += 1) {
          const [start, end] = index.lineText(line)
          paint(start, end, false)
        }
        return rows
      }, this.env, `${this.key}:md:u${String(unit)}`)
      this.children.set(unit, child)
    }
    return child
  }

  /** One fragment paint under the error contract: a failure reports once per unit and paints the error rows. */
  private paintSafely(unit: number, paint: () => readonly string[] | undefined): readonly string[] | undefined {
    try {
      return paint()
    } catch (error) {
      const message = ownDataErrorMessage(error) ?? 'unknown render failure'
      if (!this.failures.has(unit)) {
        this.failures.add(unit)
        this.env.report?.(message)
      }
      return this.env.errorRows(message, this.width)
    }
  }

  /**
   * A block or Mermaid unit's painted rows through the cache, or undefined when the unit paints through a segmented
   * child: an oversized token, or a Mermaid fence whose fallback is too large for one fragment.
   */
  private unitRows(at: number): readonly string[] | undefined {
    const unit = this.prepared.units[at]!
    if (unit.kind === 'lines') {
      this.syncCount(at, this.linesChild(at, this.prepared.normalized.slice(unit.start, unit.end)).length)
      return undefined
    }
    if (this.children.has(at)) return undefined
    let rows = this.env.cache.get(this.cacheKey(at))
    if (rows === undefined) {
      const painted = unit.kind === 'mermaid'
        ? this.paintSafely(at, () => markdownMermaidRows(unit.source, unit.fallback, this.width, this.theme, this.env.colors.mdHr))
        : this.paintSafely(at, () => markdownBlockRows(this.prepared.normalized.slice(unit.start, unit.end), this.prepared.defs, this.width, this.theme, this.env.colors.mdHr, unit.closed === true))
      // Only an oversized mermaid declines a fragment paint; its raw fence becomes the segmented child.
      if (painted === undefined) {
        this.syncCount(at, this.linesChild(at, (unit as Extract<MarkdownUnit, { readonly kind: 'mermaid' }>).fallback).length)
        return undefined
      }
      rows = painted
      this.env.cache.put(this.cacheKey(at), rows, paintedRowsBytes(rows))
      countWork(this.env.counters, 'segmentsPainted')
      countWork(this.env.counters, 'rowsPainted', rows.length)
    }
    this.syncCount(at, rows.length)
    return rows
  }

  /** The row at `index`, located again when painting its unit or its child moved the map under it. */
  row(index: number): string {
    for (;;) {
      if (index < 0 || index >= this.length) return ''
      const settled = this.changes
      const at = this.tree.locate(index)
      const local = index - this.tree.sum(at - 1)
      const rows = this.unitRows(at)
      let row: string
      if (rows !== undefined) row = rows[local] ?? ''
      else {
        // A segmented child answers its own row; no facade stands between, so nothing is kept twice.
        const child = this.children.get(at)!
        row = child.row(local)
        this.syncCount(at, child.length)
      }
      if (this.changes !== settled) continue
      countWork(this.env.counters, 'rowsMaterialized')
      return row
    }
  }

  prepare(from: number, to: number): void {
    if (from >= this.length) return
    let at = this.tree.locate(Math.max(0, from))
    while (at < this.prepared.units.length && this.tree.sum(at - 1) < to) {
      if (this.unitRows(at) === undefined) {
        const child = this.children.get(at)!
        const start = this.tree.sum(at - 1)
        child.prepare?.(Math.max(0, from - start), to - start)
        this.syncCount(at, child.length)
      }
      at += 1
    }
  }

  /** The unit holding a normalized-text offset: unit starts are sorted, so a binary walk of the map finds it. */
  private unitAt(offset: number): number {
    let lo = 0
    let hi = this.prepared.units.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.prepared.units[mid]!.start <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /**
   * The row holding a source-text offset — unit-granular, proportional inside the unit, the segmented child's own
   * map when one painted it. Offsets land in `normalized` space; tabs and CRs the scan normalized away drift the
   * map by a few characters at most, which anchor tolerance absorbs.
   */
  rowOf(offset: number): number {
    const at = this.unitAt(offset)
    const unit = this.prepared.units[at]!
    const startRow = this.tree.sum(at - 1)
    const child = this.children.get(at)
    if (child?.rowOf !== undefined && unit.kind === 'lines') return startRow + child.rowOf(offset - unit.start)
    if (unit.kind === 'mermaid') return startRow
    const span = Math.max(1, unit.end - unit.start)
    const within = Math.min(this.counts[at]!, Math.max(0, Math.floor(((offset - unit.start) / span) * this.counts[at]!)))
    return startRow + within
  }

  /** The source offset a row starts from, inverse of `rowOf` at unit granularity. */
  offsetOf(row: number): number {
    const at = this.tree.locate(row)
    const unit = this.prepared.units[at]!
    const child = this.children.get(at)
    if (child?.offsetOf !== undefined && unit.kind === 'lines') return unit.start + child.offsetOf(row - this.tree.sum(at - 1))
    return unit.start
  }
}

const preparedMarkdowns = new WeakMap<object, PreparedMarkdown>()

function markdownSource(node: MayflyMarkdownNode, width: number, env: ContentRowsEnv): RowSource {
  let prepared = preparedMarkdowns.get(node)
  if (prepared === undefined) {
    prepared = scanMarkdown(fieldText(node.source))
    countWork(env.counters, 'linesEstimated', prepared.lines)
    preparedMarkdowns.set(node, prepared)
  }
  return new MarkdownRowSource(prepared, Math.max(1, width), env, keyOf(node, env))
}

const indexedFields = new WeakMap<object, IndexedField>()
const chunkScans = new WeakMap<object, ContentLineScan>()
/**
 * The newest chunked field indexed from each last chunk, until a field that extends it takes it over: a stream's next
 * publish holds that chunk again, however older chunks were joined or the pieces were regrouped since.
 */
const indexedTails = new WeakMap<object, IndexedField>()
const objectIds = new WeakMap<object, number>()
let nextObjectId = 0

/** The joined text and measure index of one node's content, built once and shared by every width and repaint. */
interface IndexedField {
  readonly text: string
  readonly index: ContentIndex
}

/** The line scan of one admitted content chunk, kept on its identity so an appended tail scans only its new pieces. */
function chunkScan(chunk: { readonly text: string }): ContentLineScan {
  let scan = chunkScans.get(chunk)
  if (scan === undefined) {
    scan = scanContentLines(chunk.text)
    chunkScans.set(chunk, scan)
  }
  return scan
}

/** How many chunks back from the end of a field to look for the last chunk of the field it extends. */
const TAIL_LOOKBACK = 8

/**
 * The field indexed before that `field` extends, with the chunks that follow its last piece: the chunk it ended on is
 * in `field` again, the text before and including that chunk is the same text, and what follows is new. The text is
 * compared, not the chunks before the tail, because a feed joins neighbours as it grows and drops pieces on a lossy read.
 * The predecessor is handed over once; a field that does not extend it leaves it for the one that does.
 */
function extendedField(field: readonly { readonly text: string }[], text: string): { readonly known: IndexedField, readonly appended: readonly ContentLineScan[] } | undefined {
  for (let at = field.length - 1; at >= Math.max(0, field.length - TAIL_LOOKBACK); at -= 1) {
    const known = indexedTails.get(field[at]!)
    if (known === undefined) continue
    const appended = field.slice(at + 1).map(chunkScan)
    const settled = text.length - appended.reduce((units, scan) => units + scan.units, 0)
    if (settled !== known.text.length || commonPrefix(known.text, text, settled) !== settled) return undefined
    indexedTails.delete(field[at]!)
    return { known, appended }
  }
  return undefined
}

/**
 * The text and measure index of one node's content field. A string field indexes in one pass. A chunked field joins its
 * per-chunk scans, each computed once per chunk identity; one that extends a field indexed before (a growing stream)
 * adds only the scans of its new chunks to that index, so an append costs the appended lines, not the stream.
 */
function indexedField(node: object, field: MayflyContentField | (() => string), env: ContentRowsEnv): IndexedField {
  let held = indexedFields.get(node)
  if (held === undefined) {
    const onLines = (lines: number): void => { countWork(env.counters, 'linesEstimated', lines) }
    if (typeof field === 'function') {
      const text = field()
      held = { text, index: indexContent(text, onLines) }
    } else if (typeof field === 'string') {
      held = { text: field, index: indexContent(field, onLines) }
    } else {
      const text = fieldText(field)
      const extended = extendedField(field, text)
      held = { text, index: extended === undefined ? indexMergedLines(field.map(chunkScan), text, onLines) : extendMergedLines(extended.known.index, extended.appended, text, onLines) }
      if (field.length > 0) indexedTails.set(field[field.length - 1]!, held)
    }
    indexedFields.set(node, held)
  }
  return held
}

/** One id per object identity — admitted nodes, palettes, component sets, caches — stable while the object lives. */
function idOf(value: object): number {
  let id = objectIds.get(value)
  if (id === undefined) {
    id = nextObjectId += 1
    objectIds.set(value, id)
  }
  return id
}

/**
 * The paint a source's rows depend on beyond its node and width: the palette and the component set. A theme or
 * presentation change brings new objects, so rows painted under the old ones never answer for the new.
 */
function paintKey(env: ContentRowsEnv): string {
  return `${String(idOf(env.colors))}.${String(idOf(env.components))}`
}

/** The cache-key prefix of one node under one paint, stable for the node's life. */
function keyOf(node: object, env: ContentRowsEnv): string {
  return `n${String(idOf(node))}p${paintKey(env)}`
}

/** Already-painted rows as a source, counting what the old per-width memo would have counted. */
function eager(rows: string[], env: ContentRowsEnv): RowSource {
  countWork(env.counters, 'rowsPainted', rows.length)
  return rowsSource(rows)
}

interface SanitizedSpan {
  readonly tone?: MayflyTone | undefined
  readonly styles?: readonly MayflyTextStyle[] | undefined
  /** Text painted raw, outside any tone (the field column's separator space is one). */
  readonly raw?: true | undefined
  readonly text: string
}

/** Spans clipped to the `[start, end)` range of their joined text; each piece keeps its paint. */
function clipSpans(spans: readonly SanitizedSpan[], start: number, end: number): SanitizedSpan[] {
  const clipped: SanitizedSpan[] = []
  let at = 0
  for (const span of spans) {
    const next = at + span.text.length
    const from = Math.max(start, at)
    const to = Math.min(end, next)
    if (from < to) clipped.push({ tone: span.tone, styles: span.styles, raw: span.raw, text: span.text.slice(from - at, to - at) })
    at = next
    if (at >= end) break
  }
  return clipped
}

const paintSpan = (span: SanitizedSpan, colors: MayflySemanticColors): string =>
  styledText(span.raw === true ? span.text : paintPluginTone(colors, span.tone)(span.text), span.styles)

const SGR_AT = /^\x1b\[([0-9;]*)m/u
const grapheme = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * The SGR attribute one code controls: opening codes key their channel, closing codes key it with `-` so a close
 * deletes the matching open. Foreground/background truecolor and palette codes share one channel each.
 */
function sgrChannel(code: string): string | undefined {
  const params = SGR_AT.exec(code)?.[1]
  if (params === undefined) return undefined
  // The grammar only admits digits and separators, so the first field is always numeric (or empty — also 0).
  const first = Number(params.split(';', 1)[0]!)
  if (first === 0) return ''
  switch (first) {
    case 1: case 2: case 22: return first === 22 ? '-w' : 'w'
    case 3: case 23: return first === 23 ? '-i' : 'i'
    case 4: case 24: return first === 24 ? '-u' : 'u'
    case 5: case 6: case 25: return first === 25 ? '-b' : 'b'
    case 7: case 27: return first === 27 ? '-v' : 'v'
    case 8: case 28: return first === 28 ? '-h' : 'h'
    case 9: case 29: return first === 29 ? '-s' : 's'
    case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37: case 38: case 39:
    case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
      return first === 39 ? '-fg' : 'fg'
    case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47: case 48: case 49:
    case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
      return first === 49 ? '-bg' : 'bg'
    case 51: case 54: return first === 54 ? '-f' : 'f'
    case 53: case 55: return first === 55 ? '-o' : 'o'
    default: return `x${String(first)}`
  }
}

/**
 * A column-exact wrap for a cut of a long line (D31): graphemes pack each row to the wrap width so a window lands
 * identically wherever the cut started. Painted input is legal: escape sequences travel with the text, open SGR
 * attributes reopen at each following row (a terminal row's styling must be self-contained), and the cut stays
 * deterministic because no word boundary is consulted.
 */
export function charWrap(text: string, width: number, components: Pick<MayflyComponents, 'visibleWidth'>): string[] {
  const active = new Map<string, string>()
  const rows: string[] = []
  let row = ''
  let columns = 0
  const push = (): void => {
    rows.push(row)
    row = [...active.values()].join('')
    columns = 0
  }
  const segments = grapheme.segment(text)
  let cursor = 0
  while (cursor < text.length) {
    if (text.charCodeAt(cursor) === 0x1b) {
      const code = terminalSequenceAt(text, cursor) ?? '\x1b'
      row += code
      cursor += code.length
      const channel = sgrChannel(code)
      if (channel !== undefined) {
        if (channel === '') active.clear()
        else if (channel.startsWith('-')) active.delete(channel.slice(1))
        else active.set(channel, code)
      }
      continue
    }
    const cluster = segments.containing(cursor)!.segment
    const wide = components.visibleWidth(cluster)
    if (columns + wide > width && columns > 0) { push(); continue }
    row += cluster
    columns += wide
    cursor += cluster.length
  }
  if (columns > 0 || rows.length === 0) push()
  return rows
}

function textSource(node: Extract<MayflySectionContentNode, { readonly kind: 'text' }>, width: number, env: ContentRowsEnv): RowSource {
  const tone = paintPluginTone(env.colors, node.tone)
  const painted = (row: string): string => styledText(tone(row), node.styles)
  if (node.overflow !== undefined && node.overflow !== 'wrap') {
    const content = fieldText(node.content)
    if (node.overflow === 'truncate') return eager([painted(truncatedRow(sanitizePluginText(content), width, env.components))], env)
    return eager([painted(truncateMiddle(sanitizePluginText(content).replace(/[\r\n\t]+/gu, ' '), width, node.overflow))], env)
  }
  const { text: content, index } = indexedField(node, node.content, env)
  return new SegmentedContent(index, () => content, width, (segment, at) => {
    const rows: string[] = []
    const paint = (start: number, end: number, cut: boolean): void => {
      const slice = sanitizePluginText(content.slice(start, end))
      const wrapped = cut ? charWrap(slice, at, env.components) : env.components.wrapText(slice, at)
      for (const row of wrapped) rows.push(painted(row))
    }
    if (index.isCut(segment)) {
      const [start, end] = index.segmentText(segment)
      paint(start, end, true)
      return rows
    }
    const [first, past] = index.segmentLines(segment)
    for (let line = first; line < past; line += 1) {
      const [start, end] = index.lineText(line)
      paint(start, end, false)
    }
    return rows
  }, env, keyOf(node, env))
}

function codeSource(node: Extract<MayflySectionContentNode, { readonly kind: 'code' }>, width: number, env: ContentRowsEnv): RowSource {
  const { text: code, index } = indexedField(node, node.code, env)
  const language = node.language === undefined ? '' : sanitizePluginText(requireText(node.language, 'code language'))
  const digits = node.numbered === true ? String(index.lines).length : 0
  const gutter = digits === 0 ? 0 : digits + 3
  const inner = Math.max(1, width - gutter)
  // Highlighting keeps its old cap (roadmap §2.2 row 14): the first rows of a block up to 32 KB, computed once.
  let highlighted: readonly string[] | undefined
  const highlights = (): readonly string[] => {
    if (highlighted === undefined) {
      if (Buffer.byteLength(code, 'utf8') > CODE_HIGHLIGHT_MAX_BYTES || !highlightable(language)) highlighted = []
      else {
        const head: string[] = []
        for (let line = 0; line < Math.min(index.lines, CODE_HIGHLIGHT_MAX_ROWS); line += 1) {
          const [start, end] = index.lineText(line)
          head.push(sanitizePluginText(code.slice(start, end)))
        }
        highlighted = highlightCodeLines(head.join('\n'), language, { base: env.colors.text, keyword: env.colors.primary, string: env.colors.success, comment: env.colors.muted })
      }
    }
    return highlighted
  }
  const body = new SegmentedContent(index, () => code, inner, (segment, at) => {
    const rows: string[] = []
    const wrap = (line: number, painted: string, numbered: boolean, cut: boolean): void => {
      const wrapped = cut ? charWrap(painted, at, env.components) : env.components.wrapText(painted, at)
      wrapped.forEach((row, offset) => {
        if (gutter === 0) { rows.push(row); return }
        const mark = numbered && offset === 0 ? `${String(line + 1).padStart(digits)} │ ` : ' '.repeat(gutter)
        rows.push(`${env.colors.muted(mark)}${row}`)
      })
    }
    if (index.isCut(segment)) {
      const [start, end] = index.segmentText(segment)
      const [line] = index.segmentLines(segment)
      // A cut inside a line is a continuation unless the cut begins the line, whose first row carries the number.
      wrap(line, sanitizePluginText(code.slice(start, end)), start === index.lineText(line)[0], true)
      return rows
    }
    const [first, past] = index.segmentLines(segment)
    const lit = highlights()
    for (let line = first; line < past; line += 1) {
      const [start, end] = index.lineText(line)
      wrap(line, lit[line] ?? env.colors.text(sanitizePluginText(code.slice(start, end))), true, false)
    }
    return rows
  }, env, keyOf(node, env), gutter)
  if (language.length === 0) return body
  countWork(env.counters, 'rowsPainted', 1)
  const label = env.colors.muted(language)
  // The label row heads the body; both are sanitized, so the whole block stays marker-free and declares its width.
  // The anchor's text space is `language\ncode`: the label row covers the prefix, the body maps the rest.
  return {
    get length() { return body.length + 1 },
    get revision() { return body.revision },
    declaredWidth: Math.max(env.components.visibleWidth(language), body.declaredWidth),
    markerFree: true,
    row: index => index === 0 ? label : body.row(index - 1),
    prepare(from, to) { body.prepare(Math.max(0, from - 1), Math.max(0, to - 1)) },
    rowOf(offset) { return offset <= language.length ? 0 : 1 + body.rowOf(offset - language.length - 1) },
    offsetOf(row) { return row <= 0 ? 0 : language.length + 1 + body.offsetOf(row - 1) },
  }
}

/** The prepared pieces of one fields node, shared by every width: labels, padding, sanitized spans, and the raw text. */
interface PreparedFields {
  readonly labels: readonly string[]
  readonly pads: readonly string[]
  readonly values: readonly SanitizedSpan[][]
  readonly raw: string
}

const preparedFields = new WeakMap<object, PreparedFields>()

function fieldsSource(node: Extract<MayflySectionContentNode, { readonly kind: 'fields' }>, width: number, env: ContentRowsEnv): RowSource {
  if (!Array.isArray(node.rows)) throw new TypeError('fields rows must be an array')
  let prepared = preparedFields.get(node)
  if (prepared === undefined) {
    const fields = node.rows as readonly MayflyField[]
    const names = fields.map(row => {
      if (typeof row !== 'object' || row === null || !Array.isArray(row.value)) throw new TypeError('field row is invalid')
      row.value.forEach(span => {
        if (typeof span !== 'object' || span === null) throw new TypeError('field span must be an object')
        requireText(span.text, 'field span text')
      })
      return sanitizePluginText(requireText(row.label, 'field label'))
    })
    // The labels share one column: each is padded to the longest label and its colon, then one space, as the kit draws.
    const labels = names.map(name => name === '' ? '' : `${name}:`)
    const column = Math.max(0, ...names.map(name => env.components.visibleWidth(name))) + 1
    const pads = labels.map(label => ' '.repeat(Math.max(0, column - env.components.visibleWidth(label))))
    const values = fields.map(row => row.value.map(span => ({ tone: span.tone, styles: span.styles, text: sanitizePluginText(requireText(span.text, 'field span text')) })))
    const raw = values.map((value, line) => `${labels[line]!}${pads[line]!} ${value.map(span => span.text).join('')}`).join('\n')
    prepared = { labels, pads, values, raw }
    preparedFields.set(node, prepared)
  }
  const { labels, pads, values, raw } = prepared
  // The estimate indexes one synthetic document whose lines have the painted column shape.
  const index = indexedField(node, () => raw, env).index
  const spansOf = (line: number): SanitizedSpan[] => [
    { tone: 'muted', text: `${labels[line]!}${pads[line]!}` },
    { raw: true, text: ' ' },
    ...values[line]!,
  ]
  return new SegmentedContent(index, () => raw, width, (segment, at) => {
    const wrap = (line: number, start: number, end: number, cut: boolean): string[] => {
      const joined = clipSpans(spansOf(line), start, end).map(span => paintSpan(span, env.colors)).join('')
      return cut ? charWrap(joined, at, env.components) : env.components.wrapText(joined, at)
    }
    if (index.isCut(segment)) {
      const [start, end] = index.segmentText(segment)
      const [line] = index.segmentLines(segment)
      return wrap(line, start - index.lineText(line)[0], end - index.lineText(line)[0], true)
    }
    const rows: string[] = []
    const [first, past] = index.segmentLines(segment)
    for (let line = first; line < past; line += 1) {
      const [lineStart, lineEnd] = index.lineText(line)
      rows.push(...wrap(line, 0, lineEnd - lineStart, false))
    }
    return rows
  }, env, keyOf(node, env))
}

function sectionsSource(node: Extract<MayflySectionContentNode, { readonly kind: 'sections' }>, width: number, env: ContentRowsEnv, depth: number): RowSource {
  if (!Array.isArray(node.sections)) throw new TypeError('sections must be an array')
  const sections = node.sections as readonly MayflySection[]
  const parts: RowSource[] = []
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) throw new TypeError('section is invalid')
    const title = section.title === undefined ? undefined : sanitizePluginText(requireText(section.title, 'section title'))
    if (title !== undefined) parts.push(rowsSource([strong(env.colors.primary(title))]))
    if (section.collapsed === true) {
      parts.push(rowsSource(title === undefined ? [env.colors.muted('...')] : [env.colors.muted('  …')]))
      continue
    }
    const body = nodeSource(section.body, title === undefined ? width : Math.max(1, width - 2), env, depth + 1)
    // A titled body sits two columns in under its heading.
    parts.push(title === undefined ? body : mapSource(body, row => `  ${row}`, body.declaredWidth === undefined ? {} : { declaredWidth: body.declaredWidth + 2 }))
  }
  return concatSources(parts)
}

function richTextSource(node: MayflyRichTextNode, width: number, env: ContentRowsEnv): RowSource {
  if (!Array.isArray(node.spans)) throw new TypeError('rich-text spans must be an array')
  const spans: SanitizedSpan[] = node.spans.map(span => {
    if (typeof span !== 'object' || span === null) throw new TypeError('rich-text span must be an object')
    return { tone: span.tone, styles: span.styles, text: sanitizePluginText(requireText(span.text, 'rich-text span text')) }
  })
  if (node.overflow === 'truncate') return eager([truncatedRow(spans.map(span => paintSpan(span, env.colors)).join(''), width, env.components)], env)
  const raw = spans.map(span => span.text).join('')
  const index = indexedField(node, () => raw, env).index
  return new SegmentedContent(index, () => raw, width, (segment, at) => {
    const [start, end] = index.segmentText(segment)
    const joined = clipSpans(spans, start, end).map(span => paintSpan(span, env.colors)).join('')
    return index.isCut(segment) ? charWrap(joined, at, env.components) : env.components.wrapText(joined, at)
  }, env, keyOf(node, env))
}

function buildNodeSource(node: WindowedContentNode, width: number, env: ContentRowsEnv, depth: number): RowSource {
  if (depth > PLUGIN_VIEW_MAX_DEPTH) throw new RangeError(`view nesting exceeds ${String(PLUGIN_VIEW_MAX_DEPTH)}`)
  switch (node.kind) {
    case 'text': return textSource(node, width, env)
    case 'fields': return fieldsSource(node, width, env)
    case 'code': return codeSource(node, width, env)
    case 'sections': return sectionsSource(node, width, env, depth)
    case 'rich-text': return richTextSource(node, width, env)
    case 'diff': return diffSource(node, width, env)
    case 'markdown': return markdownSource(node, width, env)
    default: throw new TypeError(`unknown basic content kind "${String((node as { readonly kind?: unknown }).kind)}"`)
  }
}

/** The leaf kinds this module answers a shared source for. */
const CONTENT_NODE_KINDS = new Set<string>(['text', 'fields', 'code', 'sections', 'rich-text', 'diff', 'markdown'])

/**
 * One source per admitted node, width, paint, and cache, shared by the leaf that paints it and the document resolver
 * that maps its anchors: a scroll's anchor and its viewport read the same row map instead of re-wrapping the document
 * on their own. Keyed by node identity — the same object arriving again is the same text — plus the palette and
 * components it paints with and the cache its segments live in, so a theme change or another renderer never reads
 * rows painted for someone else; bounded to the variants the leaf memo keeps.
 */
const SHARED_SOURCE_VARIANTS = 4

const sharedSources = new WeakMap<object, Map<string, RowSource>>()

function nodeSource(node: WindowedContentNode, width: number, env: ContentRowsEnv, depth: number): RowSource {
  const key = `${String(width)}|${paintKey(env)}|${String(idOf(env.cache))}`
  let variants = sharedSources.get(node)
  const shared = variants?.get(key)
  if (shared !== undefined) return shared
  const built = buildNodeSource(node, width, env, depth)
  if (variants === undefined) {
    variants = new Map()
    sharedSources.set(node, variants)
  }
  if (variants.size >= SHARED_SOURCE_VARIANTS) variants.delete(variants.keys().next().value!)
  variants.set(key, built)
  return built
}

/** A source that clips every produced row to the leaf's width: the canonical renderer's `clampRowsToWidth` backstop. */
function clampedSource(source: RowSource, width: number, env: ContentRowsEnv): RowSource {
  const seek = source.seekMarker?.bind(source)
  const prepare = source.prepare?.bind(source)
  return {
    get length() { return source.length },
    // A getter, never a spread: a spread would copy today's revision and freeze it.
    get revision() { return source.revision },
    declaredWidth: Math.min(width, source.declaredWidth ?? width),
    ...(source.markerFree === true ? { markerFree: true } : {}),
    get unclamped() {
      const inner = source.unclamped
      return inner === undefined ? undefined : clampedSource(inner, width, env)
    },
    ...(seek === undefined ? {} : { seekMarker: seek }),
    ...(prepare === undefined ? {} : { prepare }),
    ...(source.rowOf === undefined ? {} : { rowOf: source.rowOf.bind(source) }),
    ...(source.offsetOf === undefined ? {} : { offsetOf: source.offsetOf.bind(source) }),
    row(index) {
      const row = source.row(index)
      // A source that declares its width inside the leaf's guarantees every row fits; the measure is the backstop
      // for painters that cannot say so (eager rows, or a declared width past the leaf's).
      if (source.declaredWidth !== undefined && source.declaredWidth <= width) return row
      countWork(env.counters, 'stringsMeasured')
      return env.components.visibleWidth(row) > width ? env.components.truncateToWidth(row, width) : row
    },
  }
}

/**
 * A source that answers at most `cap` content rows plus one elision row: the outside-window clamp. The bound is the
 * viewport at the time the leaf was built — the leaf memo keeps one facade per viewport height — so a bounded consumer
 * reads a bounded prefix and the elision row never moves under rows already read. A leaf whose estimate grows still
 * reports a bounded height. The `unclamped` chain lets a scroll reach the full content.
 */
function elidedSource(inner: RowSource, cap: number, env: ContentRowsEnv): RowSource {
  const seek = inner.seekMarker?.bind(inner)
  const prepare = inner.prepare?.bind(inner)
  const bound = Math.max(0, Math.floor(cap))
  return {
    get length() {
      const total = inner.length
      return total <= bound ? total : bound + 1
    },
    // A getter, never a spread: a spread would copy today's revision and freeze it.
    get revision() { return inner.revision },
    ...(inner.declaredWidth === undefined ? {} : { declaredWidth: inner.declaredWidth }),
    ...(inner.markerFree === true ? { markerFree: true } : {}),
    get unclamped() { return inner.unclamped ?? inner },
    ...(seek === undefined ? {} : {
      seekMarker(marker: string, from: number): number {
        const hit = seek(marker, Math.max(0, Math.min(from, bound)))
        return hit < 0 || hit >= bound ? -1 : hit
      },
    }),
    ...(prepare === undefined ? {} : {
      prepare(from: number, to: number): void {
        prepare(from, Math.min(to, bound))
      },
    }),
    // The document map always speaks for the whole source: an anchor keeps meaning while the leaf only reports a
    // bounded prefix.
    ...(inner.rowOf === undefined ? {} : { rowOf: inner.rowOf.bind(inner) }),
    ...(inner.offsetOf === undefined ? {} : { offsetOf: inner.offsetOf.bind(inner) }),
    row(index) {
      return index < bound ? inner.row(index) : env.elide(Math.max(0, inner.length - bound))
    },
  }
}

/**
 * The row source of one content leaf at one width: the node's own source (segmented or already painted), bounded to
 * the viewport plus its elision row while `env.bounded` holds, with every produced row clipped to the width. A scroll
 * reaches past the bound through the source's `unclamped` chain.
 */
export function contentNodeSource(node: WindowedContentNode, width: number, env: ContentRowsEnv): RowSource {
  if (typeof node !== 'object' || node === null) throw new TypeError('view must be an object')
  const inner = nodeSource(node, Math.max(1, Math.floor(width)), env, 0)
  return clampedSource(env.bounded ? elidedSource(inner, env.viewportRows(), env) : inner, width, env)
}

/**
 * The shared row source of a document block at `width`, or undefined when its node is not a content leaf. This is the
 * instance the leaf render uses, so a document anchor and the painted viewport agree on the row map: `text`, `code`,
 * and `rich-text` sources translate source-text offsets through `rowOf`/`offsetOf`, while `fields`, `sections`, and
 * `diff` report their real `length` for the document's proportional map.
 */
export function documentRowsSource(node: MayflyUiNode, width: number, env: ContentRowsEnv): RowSource | undefined {
  if (typeof node !== 'object' || node === null || !CONTENT_NODE_KINDS.has(node.kind)) return undefined
  return nodeSource(node as WindowedContentNode, Math.max(1, Math.floor(width)), env, 0)
}
